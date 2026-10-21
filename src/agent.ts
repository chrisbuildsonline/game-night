import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type Anthropic from '@anthropic-ai/sdk';
import { bedrock, MODEL } from './llm';

type ToolLog = { name: string; args: unknown; result: string };
type McpTool = { name: string; description?: string; inputSchema: unknown };

// ---- MCP client (lazy, once per process) ----
let clientP: Promise<Client> | null = null;
let toolsCache: McpTool[] | null = null;

function connect(): Promise<Client> {
  clientP ??= (async () => {
    const client = new Client({ name: 'simulated-alexa', version: '1.0.0' });
    const url = new URL(`http://127.0.0.1:${process.env.PORT ?? 8686}/mcp`);
    const token = process.env.GAME_NIGHT_TOKEN;
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    return client;
  })();
  clientP.catch(() => (clientP = null));
  return clientP;
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  try {
    return await fn(await connect());
  } catch (err) {
    // connection dropped: reconnect once and retry
    clientP = null;
    toolsCache = null;
    try {
      return await fn(await connect());
    } catch (err2) {
      clientP = null;
      throw err2 ?? err;
    }
  }
}

async function mcpTools(): Promise<McpTool[]> {
  toolsCache ??= (await withClient((c) => c.listTools())).tools as McpTool[];
  return toolsCache;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const res: any = await withClient((c) => c.callTool({ name, arguments: args }));
  const text = ((res.content ?? []) as any[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { text, isError: Boolean(res.isError) };
}

const strip = (s: string) => s.split(/\n*HOST NOTE:/)[0].trim();

// ---- per-conversation state ----
type Conv = { history: Anthropic.MessageParam[]; game: 'whodunnit' | 'twenty' | null; expectRooms: boolean };
const convs = new Map<string, Conv>();
const MAX_CONVS = 50;
const MAX_MESSAGES = 20;
const conv = (id: string) => {
  const c = convs.get(id) ?? { history: [], game: null, expectRooms: false };
  convs.delete(id);
  convs.set(id, c); // re-insert so Map order is least recently used first
  while (convs.size > MAX_CONVS) convs.delete(convs.keys().next().value!);
  return c;
};

// Keep about the last MAX_MESSAGES messages, cut at a plain user turn so no tool_use loses its tool_result.
// The kept history no longer has its original prefix, so its thinking blocks would fail the API's
// conversation-binding check: drop them, which is the documented recovery.
export function trimHistory(h: Anthropic.MessageParam[]) {
  if (h.length <= MAX_MESSAGES) return;
  let i = h.length - MAX_MESSAGES;
  while (i < h.length && !(h[i]!.role === 'user' && typeof h[i]!.content === 'string')) i++;
  h.splice(0, i);
  for (const m of h) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      m.content = m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
      if (!m.content.length) m.content = [{ type: 'text', text: '...' }]; // the API rejects empty assistant turns
    }
  }
}

export async function chat(conversation: string, text: string): Promise<{ reply: string; tools: ToolLog[] }> {
  const c = conv(conversation);
  const tools: ToolLog[] = [];
  if (bedrock) {
    trimHistory(c.history); // before histLen, which the error path restores to
    const histLen = c.history.length;
    try {
      const reply = await bedrockTurn(c, text, tools);
      return { reply, tools };
    } catch (err) {
      console.error('[agent] Bedrock failed, using offline router:', (err as Error).message);
      c.history.length = histLen; // drop the half-finished turn
      if (tools.length > 0) {
        // tools already ran this turn: re-running them offline would repeat side effects
        return { reply: "Sorry, I lost my train of thought for a moment. Say that again and we'll pick up where we left off.", tools };
      }
    }
  }
  return offlineTurn(c, text, tools);
}

// ---- Bedrock tool-use loop ----
async function bedrockTurn(c: Conv, text: string, log: ToolLog[]): Promise<string> {
  const client = await connect();
  const instructions = client.getInstructions() ?? '';
  const system = `${instructions}\n\nYou are a simulated Alexa+ running Game Night. Your replies are spoken aloud, so use plain sentences only: no markdown, no lists, no emoji. Reply in 1-3 sentences. Never read HOST NOTE text aloud.`;
  const tools = (await mcpTools()).map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  const start = c.history.length;
  c.history.push({ role: 'user', content: text });
  for (let i = 0; i < 8; i++) {
    const res = await bedrock!.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      tools,
      messages: c.history,
      output_config: { effort: 'low' },
    });
    c.history.push({ role: 'assistant', content: res.content });
    // A cut-off turn may end in a tool_use with no result, which the next request would reject: drop the turn.
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
      c.history.length = start;
      return res.stop_reason === 'refusal'
        ? "Sorry, I can't help with that one. Want to play something else?"
        : 'Sorry, I got carried away there. Could you say that again?';
    }
    if (res.stop_reason !== 'tool_use') {
      return res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join(' ').trim() || 'Okay.';
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of res.content) {
      if (b.type !== 'tool_use') continue;
      const args = (b.input ?? {}) as Record<string, unknown>;
      try {
        const r = await callTool(b.name, args);
        log.push({ name: b.name, args, result: r.text });
        results.push({ type: 'tool_result', tool_use_id: b.id, content: r.text, ...(r.isError ? { is_error: true } : {}) });
      } catch (err) {
        const msg = (err as Error).message;
        log.push({ name: b.name, args, result: `error: ${msg}` });
        results.push({ type: 'tool_result', tool_use_id: b.id, content: msg, is_error: true });
      }
    }
    c.history.push({ role: 'user', content: results });
  }
  throw new Error('tool loop exceeded 8 iterations');
}

// ---- Offline rule-based router ----
function parseRooms(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\b(my|the|a|an|our|in|house|are|is|it'?s|there)\b/g, ' ')
    .split(/,|\band\b|&/)
    .map((r) => r.replace(/[^a-z' -]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

async function offlineTurn(c: Conv, raw: string, log: ToolLog[]): Promise<{ reply: string; tools: ToolLog[] }> {
  const t = raw.toLowerCase().replace(/[.!?]+$/g, '').trim();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    try {
      const r = await callTool(name, args);
      log.push({ name, args, result: r.text });
      return { reply: strip(r.text), tools: log };
    } catch (err) {
      const msg = (err as Error).message;
      log.push({ name, args, result: `error: ${msg}` });
      return { reply: "Sorry, I couldn't reach Game Night just now. Try again in a moment.", tools: log };
    }
  };
  const say = (reply: string) => ({ reply, tools: log });
  let m: RegExpMatchArray | null;

  // Awaiting the room list for the mystery.
  if (c.expectRooms) {
    const rooms = parseRooms(t);
    if (rooms.length >= 2 && !/\b(twenty|20)\b/.test(t)) {
      c.expectRooms = false;
      c.game = 'whodunnit';
      return call('start_case', { rooms });
    }
    if (rooms.length === 1 && t.split(/\s+/).length <= 3) return say(`I need at least two rooms. Which other rooms does your house have besides the ${rooms[0]}?`);
  }

  if (/\b(twenty|20) questions\b/.test(t)) {
    c.game = 'twenty';
    c.expectRooms = false;
    const cat = t.match(/\b(animal|food|object)s?\b/)?.[1];
    return call('start_twenty_questions', cat ? { category: cat } : {});
  }
  if (/\b(mystery|whodunn?it|murder|detective)\b/.test(t)) {
    m = t.match(/\b(?:in|at|with)\s+(?:the\s+|my\s+)?(.+)$/);
    const rooms = m ? parseRooms(m[1]) : [];
    if (rooms.length >= 2) {
      c.game = 'whodunnit';
      c.expectRooms = false;
      return call('start_case', { rooms });
    }
    c.expectRooms = true;
    return say('Great, a mystery. Which rooms are in your house?');
  }
  if (/\b(give up|gives up|tell me the answer|reveal)\b/.test(t)) {
    if (c.game === 'whodunnit') return say('I can only solve the mystery if you accuse someone. Who do you think did it?');
    return call('give_up');
  }
  if ((m = t.match(/\b(?:i accuse|accuse|it was|it'?s|the culprit is)\s+(?:the\s+)?(.+)$/)) && (c.game !== 'twenty' || /accuse/.test(t))) {
    return call('accuse', { suspect: m[1].trim() });
  }
  if ((m = t.match(/\b(?:interrogate|question|talk to|speak to|speak with|ask|grill)\s+(?:the\s+)?(.+)$/)) && c.game !== 'twenty') {
    return call('interrogate', { suspect: m[1].trim() });
  }
  if ((m = t.match(/\b(?:search|look(?:ing)? (?:in|at|around)|check|explore|investigate|go (?:in|into|to))\s+(?:the\s+|my\s+)?(.+)$/))) {
    return call('search_room', { room: m[1].trim() });
  }
  if ((m = t.match(/\b(?:my guess is|the answer is|i guess|i'?ll guess|final answer(?: is)?)\s+(?:it'?s\s+)?(?:an?\s+|the\s+)?(.+)$/))) {
    return call('make_guess', { guess: m[1].trim() });
  }
  if (c.game === 'twenty' && (/\?$/.test(raw.trim()) || /^(is|does|can|do|has|was|are|will|would|could|did|how|what|where|who|which|have)\b/.test(t))) {
    return call('ask_question', { question: raw.trim() });
  }
  if (/\b(status|where are we|what do we know|recap|how are we doing|clues|so far)\b/.test(t)) {
    return call(c.game === 'twenty' ? 'twenty_status' : 'case_status');
  }
  if (/\b(what games|which games|games (?:are there|do you have)|open game night|game night|let'?s play|lets play|play a game|list games|what can we play)\b/.test(t)) {
    return call('list_games');
  }
  return say('I can run a mystery or a round of twenty questions. Try saying "what games are there".');
}
