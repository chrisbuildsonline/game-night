// Records the demo video (under 3 min) with a voice track: architecture, the live MCP protocol, voice gameplay in
// the simulated Alexa+ web app, the Bedrock integration code and the real test results.
// Needs ffmpeg and uvx (edge-tts voices). Runs its own server on :8703 with a throwaway DB and Bedrock off.
// bun run demo:video -> out/game-night-demo.mp4
import { chromium, type Page } from '@playwright/test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const PORT = 8703;
const BASE = `http://localhost:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), 'gn-demo-'));
const OUT = join(ROOT, 'out');
const DB = join(TMP, 'demo.sqlite');
const VOICES = { host: 'en-US-AvaNeural', user: 'en-US-AndrewNeural', narrator: 'en-US-BrianNeural' };
type Voice = keyof typeof VOICES;
type Clip = { file: string; ms: number };

let n = 0;
async function tts(voice: Voice, text: string): Promise<Clip> {
  const file = join(TMP, `${String(n++).padStart(3, '0')}-${voice}.mp3`);
  // edge-tts sometimes stalls on the network: give each try 30 s, three tries.
  for (let tryNo = 1; ; tryNo++) {
    const p = Bun.spawn(['timeout', '30', 'uvx', 'edge-tts', '--voice', VOICES[voice], '--rate=+12%', '--text', text, '--write-media', file], { stderr: 'pipe' });
    if (!(await p.exited)) break;
    if (tryNo === 3) throw new Error(`edge-tts failed: ${await new Response(p.stderr).text()}`);
  }
  const d = Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return { file, ms: Math.round(Number(d.stdout.toString()) * 1000) };
}

function run(cmd: string[]) {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, env: { ...process.env, CI: '1' } });
  const out = p.stdout.toString() + p.stderr.toString();
  if (p.exitCode) throw new Error(`${cmd.join(' ')} failed:\n${out.slice(-2000)}`);
  return out;
}

// ---- 1. real gate results, shown on the tests slide (the video is not made from a red build) ----
console.log('running the gates...');
const unit = run(['bun', 'test']);
run(['bun', 'run', 'typecheck']);
const e2e = run(['bun', 'run', 'e2e']);
const units = { pass: unit.match(/(\d+) pass/)![1], fail: unit.match(/(\d+) fail/)![1], expects: unit.match(/(\d+) expect\(\) calls/)![1], files: unit.match(/across (\d+) files/)![1] };
const e2ePassed = e2e.match(/(\d+) passed/)![1];

// ---- 2. our own server ----
if (await fetch(`${BASE}/`).then(() => true, () => false)) throw new Error(`port ${PORT} is busy: stop the old server first`);
const server = Bun.spawn(['bun', 'src/server.ts'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), GAME_DB: DB, BEDROCK: 'off', GAME_NIGHT_TOKEN: '' },
  stdout: 'ignore', stderr: 'inherit',
});
for (let i = 0; ; i++) {
  try { if ((await fetch(`${BASE}/`)).ok) break; } catch {}
  if (i > 50) throw new Error('server did not start');
  await Bun.sleep(200);
}

// Plain JSON-RPC over Streamable HTTP, exactly what an MCP client sends; answers arrive as SSE.
let rpcId = 0;
async function rpc(method: string, params?: unknown) {
  const body = { jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) };
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data: '));
  return { body, status: res.status, type: res.headers.get('content-type') ?? '', result: JSON.parse(data ? data.slice(6) : text).result };
}
const toolNames: string[] = (await rpc('tools/list')).result.tools.map((t: { name: string }) => t.name);

// ---- 3. slides ----
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const CSS = `
:root{--bg:#05080f;--fg:#e8f1ff;--dim:#7d8aa5;--c1:#00d4ff;--c2:#2a6bff;--card:#0e1626;--line:#1c2a47}
*{box-sizing:border-box}
body{margin:0;height:100vh;background:radial-gradient(ellipse at 50% 15%,#0b1630 0%,var(--bg) 60%);color:var(--fg);
 font:19px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:34px 52px;display:flex;flex-direction:column;overflow:hidden}
h1{font-size:30px;margin:0 0 4px;color:var(--c1);letter-spacing:.02em} .sub{color:var(--dim);margin:0 0 20px;font-size:17px}
.box{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 18px}
.box b{color:var(--c1)} .dim{color:var(--dim)} .small{font-size:15px}
.chip{display:inline-block;font:13px ui-monospace,Menlo,monospace;background:#16376b;border-radius:10px;padding:2px 8px;margin:3px 3px 0 0}
.pill{display:inline-block;border:1px solid var(--line);border-radius:16px;padding:4px 12px;margin:4px 6px 0 0;font-size:15px;color:#c9d6ee}
.term{background:#070b14;border:1px solid var(--line);border-radius:12px;padding:14px 18px;font:14px/1.45 ui-monospace,Menlo,monospace;overflow:hidden}
.req{color:#5cf0ff;word-break:break-all}.res{color:#c9d6ee;white-space:pre-wrap;word-break:break-word;margin:2px 0 12px}
.ok{color:#5be49b}.hl{background:#ff3b6b33;color:#ff8fab;border-radius:3px;padding:0 3px}
.k{color:#7aa2ff}.s{color:#9be28f}.c{color:#6b7894}
.in{animation:in .6s ease both} @keyframes in{from{opacity:0;transform:translateY(8px)}}
.arrow{color:var(--c1);font-size:15px;text-align:center;align-self:center}
`;
const slide = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`;

// Real source, lightly coloured: comments, strings, keywords.
function code(file: string, start: string) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const i = lines.findIndex((l) => l.startsWith(start));
  const j = lines.findIndex((l, k) => k > i && l === '}');
  return lines.slice(i, j + 1).map((l) => {
    const m = l.match(/^(.*?)(\/\/.*)?$/)!;
    const body = esc(m[1]!).replace(/(`[^`]*`|'[^']*')/g, '<span class="s">$1</span>')
      .replace(/\b(export|async|function|const|let|for|if|return|await|try|catch|null|new|break)\b/g, '<span class="k">$1</span>');
    return body + (m[2] ? `<span class="c">${esc(m[2])}</span>` : '');
  }).join('\n');
}

const TITLE = slide(`<div style="margin:auto;text-align:center">
  <div style="width:120px;height:120px;margin:0 auto 26px;border-radius:50%;border:7px solid var(--c1);box-shadow:0 0 24px var(--c1),0 0 60px var(--c2),inset 0 0 24px var(--c2)"></div>
  <h1 style="font-size:54px">Game Night</h1>
  <p class="sub" style="font-size:22px">A voice game hub for Alexa+, built as a self-hosted MCP server</p>
  <span class="pill">MCP spec 2025-11-25</span><span class="pill">Streamable HTTP</span><span class="pill">TypeScript MCP SDK</span><span class="pill">Amazon Bedrock</span><span class="pill">SQLite</span>
</div>`);

const ARCH = slide(`<h1>Architecture</h1><p class="sub">The server owns the rules and the secrets. The voice host only tells the story.</p>
<div style="display:grid;grid-template-columns:1fr 150px 1.35fr 150px 1fr;gap:10px;flex:1;align-items:center">
  <div class="box in" style="animation-delay:.2s"><b>Alexa+</b><br><span class="small dim">or the simulated Alexa+ web app (real MCP client + agent)</span><br><span class="small">Voice host: improvises the story, speaks tool results</span></div>
  <div class="arrow in" style="animation-delay:1.5s">⇄<br>MCP 2025-11-25<br>Streamable HTTP<br>POST /mcp<br>JSON-RPC 2.0</div>
  <div class="box in" style="animation-delay:3s"><b>Game Night MCP server</b><br><span class="small dim">Bun · TypeScript MCP SDK v2 · stateless per request</span><br>
    ${toolNames.map((t) => `<span class="chip">${t}</span>`).join('')}</div>
  <div class="arrow in" style="animation-delay:5s">⇄</div>
  <div style="display:grid;gap:14px">
    <div class="box in" style="animation-delay:6s"><b>SQLite</b><br><span class="small">Game state and secrets. Never sent to the model.</span></div>
    <div class="box in" style="animation-delay:10s"><b>Amazon Bedrock</b><br><span class="small">Claude Sonnet 4.6, structured output → validator → hand-written fallback</span></div>
  </div>
</div>
<div class="in" style="animation-delay:14s"><span class="pill">binds 127.0.0.1</span><span class="pill">Host / Origin allowlist</span><span class="pill">bearer token required when exposed</span><span class="pill">all secrets server-side</span></div>`);

const PROTO = slide(`<h1>The MCP server, live</h1><p class="sub">Raw JSON-RPC to POST /mcp on the running server, as Alexa+ would send it</p>
<div style="display:grid;grid-template-columns:1.7fr 1fr;gap:16px;flex:1;min-height:0">
  <div class="term" id="t"></div>
  <div style="display:flex;flex-direction:column;gap:12px"><div class="box small"><b>Server-side SQLite</b><br><span class="dim">SELECT data FROM state WHERE game = 'twenty'</span></div>
  <div class="term" id="db" style="flex:1"></div></div>
</div>`);

const CODE = slide(`<h1>Amazon Bedrock integration</h1><p class="sub">src/llm.ts and src/whodunnit.ts: Claude on Bedrock with a Zod-checked structured output, a validator, one retry, then a fallback</p>
<div class="term in" style="font-size:12.5px;line-height:1.35;white-space:pre;margin-bottom:10px">${code('src/llm.ts', 'export async function askJson')}</div>
<div class="term in" style="font-size:12.5px;line-height:1.35;white-space:pre;animation-delay:8s">${code('src/whodunnit.ts', 'async function makeCase')}</div>`);

const TESTS = slide(`<h1>Tested end to end</h1><p class="sub">Run just now, before this recording</p>
<div class="term" style="font-size:17px;line-height:1.6">
<div class="in"><span class="req">$ bun test</span> <span class="dim">unit, integration (real MCP client), fuzz, acceptance</span></div>
<div class="in ok" style="animation-delay:1s">✓ ${units.pass} pass · ${units.fail} fail · ${units.expects} expect() calls · ${units.files} files</div>
<div class="in" style="animation-delay:3s"><span class="req">$ bun run typecheck</span></div>
<div class="in ok" style="animation-delay:3.6s">✓ tsc --noEmit: no errors</div>
<div class="in" style="animation-delay:5s"><span class="req">$ bun run e2e</span> <span class="dim">Playwright, Chromium, both games clicked through</span></div>
<div class="in ok" style="animation-delay:6s">✓ ${e2ePassed} passed</div>
</div>
<div class="in" style="animation-delay:8s;margin-top:18px"><span class="pill">validated LLM output, never a broken case</span><span class="pill">offline paths under 500 ms</span><span class="pill">fail-closed when exposed</span><span class="pill">MIT licensed</span></div>`);

const OUTRO = slide(`<div style="margin:auto;text-align:center">
  <h1 style="font-size:50px">Game Night</h1>
  <p class="sub" style="font-size:22px">One MCP server · any number of voice games · secrets the model can't break</p>
  <p style="font:18px ui-monospace,Menlo,monospace;color:#c9d6ee">bun install &amp;&amp; bun start</p>
</div>`);

// ---- 4. voice lines, synthesized up front so the recording never waits on edge-tts ----
const N = {
  title: tts('narrator', "Game Night is a self-hosted MCP server for Alexa plus. The server owns each game's rules and secrets, and the voice model only tells the story. Here is how it is built."),
  arch: tts('narrator', 'Alexa plus, or our simulated Alexa plus web app, talks to one MCP server over Streamable HTTP. Every game is a set of tools. State and secrets live in SQLite on the server, so the model can never change the answer or leak it. New mysteries come from Claude on Amazon Bedrock and pass a validator before anyone plays them.'),
  proto: tts('narrator', "This is the real protocol against the running server. Initialize negotiates spec version 2025-11-25. Tools list returns the hub's tools. Starting a round of Twenty Questions returns no secret. It exists only in the server's database, and the server answers every question."),
  play: tts('narrator', 'And here is the same server, played by voice in the simulated Alexa plus app.'),
  code: tts('narrator', 'The AWS side. Claude Sonnet 4.6 runs on Amazon Bedrock through the Anthropic Bedrock SDK, with a short timeout and structured output checked against a Zod schema. The validator rejects any case that is unsolvable or gives the answer away. After one retry, a hand-written case takes over, so a voice turn never breaks. This recording runs on that fallback, because our Bedrock daily token quota ran out.'),
  tests: tts('narrator', `${units.pass} unit, integration and fuzz tests, including a real MCP client, plus ${e2ePassed} Playwright end-to-end tests, all green. The server binds to localhost, checks Host and Origin, and refuses to go public without a bearer token.`),
  outro: tts('narrator', "Game Night. One MCP server, any number of voice games, and secrets the model can't break. Tonight, your house is the board."),
};
const U = {
  start: tts('user', 'Alexa, start a mystery in the kitchen, the garage and the attic.'),
  attic: tts('user', 'Search the attic.'),
  accuse: tts('user', 'I accuse Fitz, the butler!'),
};
await Promise.all([...Object.values(N), ...Object.values(U)]);

// ---- 5. recording ----
const clips: { file: string; at: number }[] = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: TMP, size: { width: 1280, height: 720 } } });
// The voice track replaces the browser's own speech; the ring is driven from here instead.
await ctx.addInitScript(() => { if ('speechSynthesis' in window) speechSynthesis.speak = () => {}; });
const page: Page = await ctx.newPage();
const t0 = Date.now();
const now = () => Date.now() - t0;
const ring = (s: string) => page.evaluate((st) => (window as any).setState(st), s);

// Plays a narration clip; the steps run spread across it (for reveals in sync with the voice).
async function narrate(clip: Promise<Clip>, steps: (() => Promise<unknown>)[] = []) {
  const c = await clip;
  const at = now();
  clips.push({ file: c.file, at });
  for (const step of steps) { await step(); await Bun.sleep(c.ms / (steps.length + 1)); }
  await Bun.sleep(Math.max(0, c.ms - (now() - at)) + 350);
}

// The player speaks while the words appear, as speech-to-text would show them; then the host answers aloud.
// The host's spoken reply is cut to its first `sentences` sentences to keep the video short; the screen shows it all.
async function say(spoken: Promise<Clip>, typed: string, sentences: number) {
  const u = await spoken;
  const bots = page.locator('.msg.bot');
  const before = await bots.count();
  await ring('listening');
  clips.push({ file: u.file, at: now() });
  const start = now();
  await page.getByLabel('Message').pressSequentially(typed, { delay: Math.min(70, u.ms / typed.length) });
  await Bun.sleep(Math.max(0, u.ms - (now() - start)) + 150);
  await page.getByLabel('Message').press('Enter');
  await page.waitForFunction((b) => document.querySelectorAll('.msg.bot').length > b, before);
  const at = now();
  await ring('speaking');
  const reply = await bots.last().evaluate((e) => e.firstChild?.textContent ?? '');
  const h = await tts('host', reply.split(/(?<=[.!?])\s+/).slice(0, sentences).join(' '));
  clips.push({ file: h.file, at });
  await Bun.sleep(Math.max(0, h.ms - (now() - at)) + 400);
  await ring('idle');
}

const show = (html: string) => page.setContent(html);
const term = (id: string, html: string) => page.evaluate(([i, h]) => { document.getElementById(i!)!.insertAdjacentHTML('beforeend', h!); }, [id, html]);
const shorten = (s: string, max: number) => (s.length > max ? s.slice(0, max) + ' …' : s);
async function exchange(method: string, params: unknown, view: (r: Awaited<ReturnType<typeof rpc>>) => string) {
  const r = await rpc(method, params);
  await term('t', `<div class="in"><div class="req">→ POST /mcp ${esc(shorten(JSON.stringify(r.body), 150))}</div><div class="res"><span class="ok">← ${r.status} ${esc(r.type)}</span>\n${view(r)}</div></div>`);
}

await show(TITLE);
await Bun.sleep(600);
await narrate(N.title);
await show(ARCH);
await narrate(N.arch);
await show(PROTO);
await narrate(N.proto, [
  () => exchange('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'alexa-plus-sim', version: '1.0' } },
    (r) => esc(JSON.stringify({ protocolVersion: r.result.protocolVersion, serverInfo: r.result.serverInfo, capabilities: r.result.capabilities })).replace('2025-11-25', '<span class="hl">2025-11-25</span>')),
  () => exchange('tools/list', undefined, (r) => `${r.result.tools.length} tools: ${esc(r.result.tools.map((t: { name: string }) => t.name).join(', '))}`),
  () => exchange('tools/call', { name: 'start_twenty_questions', arguments: { category: 'animal' } }, (r) => esc(shorten(r.result.content[0].text, 230))),
  async () => {
    await exchange('tools/call', { name: 'ask_question', arguments: { question: 'Is it alive?' } }, (r) => esc(shorten(r.result.content[0].text, 120)));
    const row = new Database(DB, { readonly: true }).query("SELECT data FROM state WHERE game = 'twenty'").get() as { data: string };
    const s = JSON.parse(row.data);
    await term('db', `<div class="in res">{\n  "secret": <span class="hl">"${esc(s.secret)}"</span>,\n  "phase": "${esc(s.phase)}",\n  "log": ${esc(JSON.stringify(s.log))}\n}</div>`);
  },
]);
await page.goto(`${BASE}/`);
await page.waitForLoadState('networkidle');
await narrate(N.play);
await say(U.start, 'start a mystery in the kitchen, the garage and the attic', 2);
await say(U.attic, 'search the attic', 3);
await say(U.accuse, 'I accuse Fitz', 3);
await page.locator('.msg.bot summary').last().click();
await Bun.sleep(1200);
await show(CODE);
await narrate(N.code);
await show(TESTS);
await narrate(N.tests);
await show(OUTRO);
await narrate(N.outro);
await Bun.sleep(800);

await ctx.close();
await browser.close();
server.kill();

// ---- 6. mix the voice track and encode ----
const webm = join(TMP, readdirSync(TMP).find((f) => f.endsWith('.webm'))!);
mkdirSync(OUT, { recursive: true });
const out = join(OUT, 'game-night-demo.mp4');
const inputs = clips.flatMap((c) => ['-i', c.file]);
const mix = clips.map((c, i) => `[${i + 1}:a]adelay=${c.at}|${c.at}[a${i}]`).join(';')
  + `;${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0[aud]`;
const ff = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-i', webm, ...inputs, '-filter_complex', `[0:v]scale=1920:1080:flags=lanczos,fps=30[v];${mix}`,
  '-map', '[v]', '-map', '[aud]', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', out], { stderr: 'inherit' });
if (ff.exitCode) throw new Error('ffmpeg failed');
console.log(`demo video: ${out}`);
