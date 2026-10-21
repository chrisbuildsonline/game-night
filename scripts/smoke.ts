import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const MCP_URL = process.env.MCP_URL ?? 'http://127.0.0.1:8686/mcp';
const AUTH: Record<string, string> = process.env.GAME_NIGHT_TOKEN ? { authorization: `Bearer ${process.env.GAME_NIGHT_TOKEN}` } : {};
const BASE = new URL(MCP_URL).origin;
let failed = 0;
const step = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const short = (s: string) => s.replace(/\s+/g, ' ').slice(0, 90);

const client = new Client({ name: 'game-night-smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: AUTH } }));
console.log('protocol version:', client.getNegotiatedProtocolVersion());

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res: any = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  step(`${name} ${JSON.stringify(args)}`, !res.isError && text.length > 0, short(text));
  return text;
};

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
const want = ['list_games', 'start_case', 'search_room', 'interrogate', 'case_status', 'accuse', 'start_twenty_questions', 'ask_question', 'make_guess', 'twenty_status', 'give_up'];
const missing = want.filter((n) => !names.includes(n));
step('tools/list has all 11 tools', missing.length === 0, missing.length ? `missing ${missing}` : `${names.length} tools`);

await call('list_games');

// Whodunnit
const rooms = ['kitchen', 'garage', 'attic', 'living room'];
const intro = await call('start_case', { rooms });
for (const room of rooms) await call('search_room', { room });
const suspectsPart = intro.split('suspects are:')[1]?.split('You can search')[0] ?? '';
const suspects = [...suspectsPart.matchAll(/(?:^|\.\s+|:\s*)\s*([A-Z][\w']+(?: [A-Z][\w']+)+),/g)].map((m) => m[1]);
step('parsed suspects from intro', suspects.length > 0, suspects.join(', '));
for (const s of suspects) await call('interrogate', { suspect: s });
await call('case_status');
await call('accuse', { suspect: suspects[0] ?? 'nobody' });

// Twenty Questions
await call('start_twenty_questions', { category: 'animal' });
await call('ask_question', { question: 'Is it bigger than a cat?' });
await call('ask_question', { question: 'Does it live in water?' });
await call('twenty_status');
await call('make_guess', { guess: 'elephant' });
await call('give_up');

// Chat endpoint (uses the agent, which is its own MCP client)
const conversation = `smoke-${Date.now()}`;
for (const text of ['what games are there', 'search the kitchen']) {
  try {
    const res = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify({ conversation, text }) });
    const data: any = await res.json();
    step(`POST /api/chat "${text}"`, res.ok && typeof data.reply === 'string' && data.reply.length > 0, `${short(data.reply ?? '')} [tools: ${(data.tools ?? []).map((t: any) => t.name)}]`);
  } catch (e) {
    step(`POST /api/chat "${text}"`, false, (e as Error).message);
  }
}

// DNS-rebinding guard: a foreign Host or Origin must be rejected
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'evil', version: '1' } } };
for (const [what, headers] of [['Origin', { origin: 'http://evil.example' }], ['Host', { host: 'evil.example' }]] as const) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...AUTH, ...headers },
    body: JSON.stringify(init),
  });
  step(`foreign ${what} is rejected on /mcp`, res.status === 403, `HTTP ${res.status}`);
}
if (AUTH.authorization) {
  const spoofed = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'localhost' },
    body: JSON.stringify({ conversation: 'spoof', text: 'what games are there' }),
  });
  step('/api/chat with a spoofed localhost Host but no token is rejected', spoofed.status === 401, `HTTP ${spoofed.status}`);
  const res = await fetch(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(init) });
  step('missing bearer token is rejected on /mcp', res.status === 401, `HTTP ${res.status}`);
}

await client.close();
console.log(failed ? `\n${failed} step(s) FAILED` : '\nall steps PASSED');
process.exit(failed ? 1 : 0);
