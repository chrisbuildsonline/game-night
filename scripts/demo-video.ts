// Records the demo video (under 3 min) with a voice track and a quiet synthesized pad: architecture, the live MCP protocol, voice gameplay in
// the simulated Alexa+ web app, the Bedrock integration code and the real test results.
// Needs ffmpeg and uvx (edge-tts voices). Runs its own server on :8703 with a throwaway DB and Bedrock off.
// bun run demo:video -> out/game-night-demo.mp4
import { chromium, type Frame, type Page } from '@playwright/test';
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

// ---- 3. slides (white, clean: Inter, soft shadows, window chrome, animated data flow) ----
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const CSS = `
:root{--ink:#0f172a;--dim:#64748b;--line:#e2e8f0;--soft:#f8fafc;--a1:#0284c7;--a2:#2563eb;--ok:#059669;--hot:#e11d48}
*{box-sizing:border-box}
body{margin:0;height:100vh;background:#fff;color:var(--ink);font:18px/1.45 Inter,system-ui,sans-serif;overflow:hidden;-webkit-font-smoothing:antialiased}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 60% 50% at 85% 0%,#eef6ff 0%,transparent 70%),radial-gradient(ellipse 50% 40% at 0% 100%,#f0fdfa 0%,transparent 70%);z-index:-1}
.stage{position:absolute;inset:0;padding:40px 56px 56px;display:flex;flex-direction:column;animation:enter .7s cubic-bezier(.2,.7,.2,1) both}
body.leaving .stage{opacity:0;transform:translateY(-8px);transition:all .45s ease}
@keyframes enter{from{opacity:0;transform:translateY(14px)}}
.eyebrow{font:600 13px Inter;letter-spacing:.16em;text-transform:uppercase;color:var(--a1);margin-bottom:6px}
h1{font:700 34px/1.15 Inter;letter-spacing:-.02em;margin:0 0 6px}
.lead{color:var(--dim);margin:0 0 22px;font-size:17px}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px 20px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 12px 32px rgba(15,23,42,.07)}
.card b{font-weight:600}
.chip{display:inline-block;font:500 12.5px 'JetBrains Mono',ui-monospace,monospace;background:#eff6ff;color:#1d4ed8;border:1px solid #dbeafe;border-radius:8px;padding:2px 8px;margin:4px 4px 0 0}
.pill{display:inline-block;border:1px solid var(--line);background:#fff;border-radius:999px;padding:5px 14px;margin:4px 6px 0 0;font-size:14px;color:#334155;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.win{background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:0 1px 2px rgba(15,23,42,.05),0 18px 44px rgba(15,23,42,.10);overflow:hidden;display:flex;flex-direction:column}
.bar{height:38px;display:flex;align-items:center;gap:7px;padding:0 14px;background:var(--soft);border-bottom:1px solid var(--line);flex:none}
.bar i{width:11px;height:11px;border-radius:50%;background:#e2e8f0}.bar i:nth-child(1){background:#fca5a5}.bar i:nth-child(2){background:#fcd34d}.bar i:nth-child(3){background:#86efac}
.bar span{margin-left:12px;font:500 12.5px 'JetBrains Mono',ui-monospace,monospace;color:var(--dim)}
.mono{font:13.5px/1.55 'JetBrains Mono',ui-monospace,monospace}
.k{color:#7c3aed}.s{color:#059669}.c{color:#94a3b8}.key{color:#2563eb}
mark{background:#ffe4e6;color:var(--hot);border-radius:4px;padding:0 4px;font-weight:600}
.in{animation:enter .6s cubic-bezier(.2,.7,.2,1) both}
.chap{position:fixed;left:56px;bottom:18px;font:600 12px Inter;letter-spacing:.14em;text-transform:uppercase;color:#94a3b8}
.chap b{color:var(--a1);margin-right:10px}
.prog{position:fixed;left:0;right:0;bottom:0;height:3px;background:#f1f5f9}
.prog i{display:block;height:100%;background:linear-gradient(90deg,var(--a1),var(--a2));animation:grow 1.2s ease both}
@keyframes grow{from{width:var(--from)}to{width:var(--to)}}
.flow{stroke:url(#g);stroke-width:2.5;fill:none;stroke-dasharray:7 9;animation:dash 1.4s linear infinite}
@keyframes dash{to{stroke-dashoffset:-32}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(225,29,72,.0)}50%{box-shadow:0 0 0 8px rgba(225,29,72,.10)}}
`;
const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">';
const CHAPTERS = ['Architecture', 'The MCP server, live', 'Voice gameplay', 'Amazon Bedrock', 'Tested'];
function slide(body: string, chapter = 0) {
  const chrome = chapter
    ? `<div class="chap"><b>0${chapter}</b>${CHAPTERS[chapter - 1]}</div><div class="prog"><i style="--from:${((chapter - 1) / CHAPTERS.length) * 100}%;--to:${(chapter / CHAPTERS.length) * 100}%"></i></div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${CSS}</style></head><body><div class="stage">${body}</div>${chrome}</body></html>`;
}
const win = (title: string, inner: string, style = '') => `<div class="win" style="${style}"><div class="bar"><i></i><i></i><i></i><span>${title}</span></div>${inner}</div>`;

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
// JSON with keys and strings coloured.
const hlJson = (s: string) => esc(s).replace(/("(?:[^"\\]|\\.)*")(\s*:)?/g, (_, str, colon) => (colon ? `<span class="key">${str}</span>${colon}` : `<span class="s">${str}</span>`));

const RING = (size: number) => `<svg width="${size}" height="${size}" viewBox="0 0 100 100" style="display:block;margin:0 auto">
  <defs><linearGradient id="rg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#06b6d4"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs>
  <circle cx="50" cy="50" r="40" fill="none" stroke="#e0f2fe" stroke-width="7"/>
  <circle cx="50" cy="50" r="40" fill="none" stroke="url(#rg)" stroke-width="7" stroke-linecap="round" stroke-dasharray="252" stroke-dashoffset="252" transform="rotate(-90 50 50)" style="animation:draw 1.6s .2s cubic-bezier(.6,.1,.2,1) forwards"/></svg>`;

const TITLE = slide(`<div style="margin:auto;text-align:center">
  ${RING(116)}
  <h1 class="in" style="font-size:64px;margin-top:26px;animation-delay:.5s">Game Night</h1>
  <p class="lead in" style="font-size:21px;animation-delay:.8s">A voice game hub for Alexa+, built as a self-hosted MCP server</p>
  <div class="in" style="animation-delay:1.2s"><span class="pill">MCP spec 2025-11-25</span><span class="pill">Streamable HTTP</span><span class="pill">TypeScript MCP SDK</span><span class="pill">Amazon Bedrock</span><span class="pill">SQLite</span></div>
</div>`);

// Boxes sit on a fixed 1168 x 440 canvas; the SVG draws the animated links between them.
const box = (x: number, y: number, w: number, delay: number, inner: string) =>
  `<div class="card in" style="position:absolute;left:${x}px;top:${y}px;width:${w}px;animation-delay:${delay}s">${inner}</div>`;
const link = (d: string, delay: number) =>
  `<path d="${d}" stroke="#e2e8f0" stroke-width="2.5" fill="none"/><path class="flow" d="${d}" style="opacity:0;animation:dash 1.4s linear infinite, enter .6s ${delay}s both"/>` +
  `<circle r="4.5" fill="#2563eb" opacity="0"><animate attributeName="opacity" to="1" begin="${delay}s" dur=".3s" fill="freeze"/><animateMotion dur="2.2s" repeatCount="indefinite" begin="${delay}s" path="${d}"/></circle>`;
const ARCH = slide(`<div class="eyebrow">How it works</div><h1>Architecture</h1><p class="lead">The server owns the rules and the secrets. The voice host only tells the story.</p>
<div style="position:relative;width:1168px;height:440px">
  <svg width="1168" height="440" style="position:absolute;inset:0"><defs><linearGradient id="g"><stop offset="0" stop-color="#06b6d4"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs>
    ${link('M 250 200 L 430 200', 1.6)}${link('M 760 160 C 830 160, 840 80, 920 80', 5.5)}${link('M 760 250 C 830 250, 840 320, 920 320', 9.5)}</svg>
  <div class="in" style="position:absolute;left:250px;top:128px;width:180px;text-align:center;font-size:12.5px;color:var(--dim);animation-delay:1.8s"><b style="color:var(--a1)">MCP 2025-11-25</b><br>JSON-RPC 2.0</div>
  <div class="in" style="position:absolute;left:250px;top:214px;width:180px;text-align:center;font-size:12.5px;color:var(--dim);animation-delay:1.8s">Streamable HTTP<br>POST /mcp</div>
  ${box(0, 120, 250, 0.3, '<div class="eyebrow">Voice host</div><b>Alexa+</b><div style="font-size:14px;color:var(--dim);margin-top:4px">or the simulated Alexa+ web app. Improvises the story, speaks tool results.</div>')}
  ${box(430, 40, 330, 3, `<div class="eyebrow">Self-hosted</div><b>Game Night MCP server</b><div style="font-size:13.5px;color:var(--dim);margin:2px 0 6px">Bun · TypeScript MCP SDK v2 · stateless per request</div>${toolNames.map((t) => `<span class="chip">${t}</span>`).join('')}`)}
  ${box(920, 20, 248, 6, '<div class="eyebrow">State</div><b>SQLite</b><div style="font-size:14px;color:var(--dim);margin-top:4px">Game state and secrets. Never sent to the model.</div>')}
  ${box(920, 250, 248, 10, '<div class="eyebrow">AWS</div><b>Amazon Bedrock</b><div style="font-size:14px;color:var(--dim);margin-top:4px">Claude Sonnet 4.6, structured output, validator, hand-written fallback.</div>')}
</div>
<div class="in" style="animation-delay:14s;margin-top:auto"><span class="pill">binds 127.0.0.1</span><span class="pill">Host / Origin allowlist</span><span class="pill">bearer token when exposed</span><span class="pill">secrets stay server-side</span></div>`, 1);

const PROTO = slide(`<div class="eyebrow">Live, unedited</div><h1>The MCP server, live</h1><p class="lead">Raw JSON-RPC to the running server, exactly as Alexa+ would send it</p>
<div style="display:grid;grid-template-columns:1.75fr 1fr;gap:22px;flex:1;min-height:0">
  ${win('POST http://localhost:8703/mcp', '<div class="mono" id="t" style="padding:14px 18px;overflow:hidden;flex:1"></div>', 'min-height:0')}
  <div style="display:flex;flex-direction:column;gap:14px">
    ${win('server-side SQLite', '<div class="mono" style="padding:12px 16px;color:var(--dim)">SELECT data FROM state<br>WHERE game = \'twenty\'</div><div class="mono" id="db" style="padding:0 16px 14px"></div>')}
    <div id="note" class="card" style="opacity:0;font-size:15px"><b style="color:var(--hot)">The model never sees the secret.</b><br><span style="color:var(--dim)">The tool result has no answer in it. The server answers every question.</span></div>
  </div>
</div>`, 2);

const APP = slide(`<div class="eyebrow">Same server, by voice</div><h1>Voice gameplay</h1><p class="lead">The simulated Alexa+ app: a real MCP client and agent, speaking every reply</p>
<div style="display:grid;grid-template-columns:620px 1fr;gap:26px;flex:1;min-height:0">
  ${win('Game Night · simulated Alexa+', `<iframe src="${BASE}/" style="border:0;width:100%;flex:1"></iframe>`, 'min-height:0')}
  <div style="display:flex;flex-direction:column;min-height:0"><div class="eyebrow" style="margin:4px 0 10px">Live MCP tool calls</div><div id="calls" style="display:flex;flex-direction:column;gap:12px"></div></div>
</div>`, 3);

const CODE = slide(`<div class="eyebrow">AWS Builder</div><h1>Amazon Bedrock integration</h1><p class="lead">Claude on Bedrock with Zod-checked structured output, a validator, one retry, then a hand-written fallback</p>
<div style="display:flex;flex-direction:column;gap:14px;min-height:0">
  ${win('src/llm.ts', `<pre class="mono" style="margin:0;padding:12px 18px;font-size:12px;line-height:1.45">${code('src/llm.ts', 'export async function askJson')}</pre>`)}
  ${win('src/whodunnit.ts', `<pre class="mono" style="margin:0;padding:12px 18px;font-size:12px;line-height:1.45;white-space:pre-wrap">${code('src/whodunnit.ts', 'async function makeCase')}</pre>`, 'animation:enter .6s 8s both')}
</div>`, 4);

const stat = (n: string, label: string, delay: number) =>
  `<div class="card in" style="text-align:center;padding:26px 18px;animation-delay:${delay}s"><div class="count" data-to="${n}" style="font:700 56px/1 Inter;letter-spacing:-.03em;background:linear-gradient(90deg,#0284c7,#2563eb);-webkit-background-clip:text;color:transparent">0</div><div style="margin-top:10px;color:var(--dim);font-size:15px">${label}</div></div>`;
const TESTS = slide(`<div class="eyebrow">Run just now, before this recording</div><h1>Tested end to end</h1><p class="lead">Every number below comes from the run that preceded this video</p>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:22px">
  ${stat(units.pass, 'unit, integration and fuzz tests passing<br>including a real MCP client', 0.3)}
  ${stat(e2ePassed, 'Playwright end-to-end tests<br>both games clicked through', 1.6)}
  ${stat(units.fail, 'failures · tsc --noEmit clean', 2.9)}
</div>
${win('terminal', `<div class="mono" style="padding:12px 18px;font-size:13px"><span style="color:var(--a1)">$ bun test</span>  <span class="s">✓ ${units.pass} pass · ${units.fail} fail · ${units.expects} expect() calls</span><br><span style="color:var(--a1)">$ bun run typecheck</span>  <span class="s">✓ no errors</span><br><span style="color:var(--a1)">$ bun run e2e</span>  <span class="s">✓ ${e2ePassed} passed</span></div>`, 'margin-top:22px;animation:enter .6s 4.5s both')}
<div class="in" style="animation-delay:7s;margin-top:auto"><span class="pill">validated LLM output</span><span class="pill">offline paths under 500 ms</span><span class="pill">fail-closed when exposed</span><span class="pill">MIT licensed</span></div>
<script>for (const el of document.querySelectorAll('.count')) { const to = +el.dataset.to, d = parseFloat(el.parentElement.style.animationDelay) * 1000, t0 = performance.now() + d;
  (function tick(now) { const p = Math.min(1, Math.max(0, (now - t0) / 1400)); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(tick); })(t0); }</script>`, 5);

const OUTRO = slide(`<div style="margin:auto;text-align:center">
  ${RING(84)}
  <h1 class="in" style="font-size:56px;margin-top:22px;animation-delay:.4s">Game Night</h1>
  <p class="lead in" style="font-size:21px;animation-delay:.7s">One MCP server · any number of voice games · secrets the model can't break</p>
  <div class="in mono" style="animation-delay:1.1s;display:inline-block;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:8px 16px;color:#334155">bun install &amp;&amp; bun start</div>
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: 'light', recordVideo: { dir: TMP, size: { width: 1280, height: 720 } } });
// The voice track replaces the browser's own speech; the ring is driven from here instead (runs in the app's iframe too).
await ctx.addInitScript(() => { if ('speechSynthesis' in window) speechSynthesis.speak = () => {}; });
const page: Page = await ctx.newPage();
const t0 = Date.now();
const now = () => Date.now() - t0;

// Plays a narration clip; the steps run spread across it (for reveals in sync with the voice).
async function narrate(clip: Promise<Clip>, steps: (() => Promise<unknown>)[] = []) {
  const c = await clip;
  const at = now();
  clips.push({ file: c.file, at });
  for (const step of steps) { await step(); await Bun.sleep(c.ms / (steps.length + 1)); }
  await Bun.sleep(Math.max(0, c.ms - (now() - at)) + 350);
}

// Fade the current scene out, then load the next one (each scene fades itself in).
async function show(html: string) {
  await page.evaluate(() => document.body?.classList.add('leaving')).catch(() => {});
  await Bun.sleep(450);
  await page.setContent(html, { waitUntil: 'load' });
}
const add = (id: string, html: string) => page.evaluate(([i, h]) => { document.getElementById(i!)!.insertAdjacentHTML('beforeend', h!); }, [id, html]);
const shorten = (s: string, max: number) => (s.length > max ? s.slice(0, max) + ' …' : s);
async function exchange(method: string, params: unknown, view: (r: Awaited<ReturnType<typeof rpc>>) => string) {
  const r = await rpc(method, params);
  await add('t', `<div class="in" style="margin-bottom:12px"><div style="color:#0369a1;word-break:break-all"><span style="color:#94a3b8">→</span> ${hlJson(shorten(JSON.stringify(r.body), 150))}</div><div><span style="color:var(--ok)">← ${r.status} ${esc(r.type)}</span><br>${view(r)}</div></div>`);
}

let app: Frame;
const ring = (s: string) => app.evaluate((st) => (window as any).setState(st), s);

// The player speaks while the words appear, as speech-to-text would show them; then the host answers aloud and the
// tool call it made appears in the side panel. The spoken reply is cut to its first `sentences` sentences; the screen shows it all.
async function say(spoken: Promise<Clip>, typed: string, sentences: number) {
  const u = await spoken;
  const bots = app.locator('.msg.bot');
  const before = await bots.count();
  await ring('listening');
  clips.push({ file: u.file, at: now() });
  const start = now();
  await app.getByLabel('Message').pressSequentially(typed, { delay: Math.min(70, u.ms / typed.length) });
  await Bun.sleep(Math.max(0, u.ms - (now() - start)) + 150);
  await app.getByLabel('Message').press('Enter');
  await app.waitForFunction((b) => document.querySelectorAll('.msg.bot').length > b, before);
  const at = now();
  await ring('speaking');
  const msg = await bots.last().evaluate((e) => ({ reply: e.firstChild?.textContent ?? '', call: e.querySelector('summary')?.textContent ?? '', result: e.querySelector('details div')?.textContent ?? '' }));
  const [name, ...args] = msg.call.replace(/^MCP: /, '').split(' ');
  await add('calls', `<div class="card in" style="padding:12px 16px"><div class="mono" style="font-size:13px"><span style="color:#94a3b8">tools/call</span> <b style="color:var(--a2)">${esc(name!)}</b></div><div class="mono" style="font-size:12.5px;margin-top:2px">${hlJson(args.join(' '))}</div><div style="font-size:13px;color:var(--dim);margin-top:6px">${esc(shorten(msg.result.replace(/^\S+ -> /, ''), 110))}</div></div>`);
  const h = await tts('host', msg.reply.split(/(?<=[.!?])\s+/).slice(0, sentences).join(' '));
  clips.push({ file: h.file, at });
  await Bun.sleep(Math.max(0, h.ms - (now() - at)) + 400);
  await ring('idle');
}

await page.setContent(TITLE, { waitUntil: 'load' });
await Bun.sleep(900);
await narrate(N.title);
await show(ARCH);
await narrate(N.arch);
await show(PROTO);
await narrate(N.proto, [
  () => exchange('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'alexa-plus-sim', version: '1.0' } },
    (r) => hlJson(JSON.stringify({ protocolVersion: r.result.protocolVersion, serverInfo: r.result.serverInfo, capabilities: r.result.capabilities })).replace('2025-11-25', '<mark>2025-11-25</mark>')),
  () => exchange('tools/list', undefined, (r) => `<span style="color:var(--dim)">${r.result.tools.length} tools</span> ${r.result.tools.map((t: { name: string }) => `<span class="chip">${esc(t.name)}</span>`).join('')}`),
  () => exchange('tools/call', { name: 'start_twenty_questions', arguments: { category: 'animal' } }, (r) => esc(shorten(r.result.content[0].text.split('HOST NOTE')[0]!.trim(), 200))),
  async () => {
    await exchange('tools/call', { name: 'ask_question', arguments: { question: 'Is it alive?' } }, (r) => esc(shorten(r.result.content[0].text, 120)));
    const row = new Database(DB, { readonly: true }).query("SELECT data FROM state WHERE game = 'twenty'").get() as { data: string };
    const s = JSON.parse(row.data);
    await add('db', `<div class="in">{<br>&nbsp;&nbsp;<span class="key">"secret"</span>: <mark style="animation:pulse 1.6s ease-in-out infinite">"${esc(s.secret)}"</mark>,<br>&nbsp;&nbsp;<span class="key">"phase"</span>: <span class="s">"${esc(s.phase)}"</span>,<br>&nbsp;&nbsp;<span class="key">"questions"</span>: ${s.log.length}<br>}</div>`);
    await page.evaluate(() => { const n = document.getElementById('note')!; n.classList.add('in'); n.style.opacity = '1'; });
  },
]);
await show(APP);
app = (await (await page.waitForSelector('iframe')).contentFrame())!;
await app.waitForLoadState('networkidle');
await narrate(N.play);
await say(U.start, 'start a mystery in the kitchen, the garage and the attic', 2);
await say(U.attic, 'search the attic', 3);
await say(U.accuse, 'I accuse Fitz', 3);
await Bun.sleep(900);
await show(CODE);
await narrate(N.code);
await show(TESTS);
await narrate(N.tests);
await show(OUTRO);
await narrate(N.outro);
await Bun.sleep(1200);

await ctx.close();
await browser.close();
server.kill();

// ---- 6. mix: voices + a quiet synthesized pad (no licensed music) that ducks under speech; encode ----
const webm = join(TMP, readdirSync(TMP).find((f) => f.endsWith('.webm'))!);
mkdirSync(OUT, { recursive: true });
const out = join(OUT, 'game-night-demo.mp4');
const secs = (now() / 1000).toFixed(2);
// Two soft chords (A major add9, F#m7) crossfading every 8 s, low-passed, with a slow swell and a touch of echo.
const chord = (f: number[]) => f.map((hz, i) => `${(0.5 / (i + 1)).toFixed(2)}*sin(2*PI*${hz}*t+0.6*sin(2*PI*0.13*t))`).join('+');
const pad = `aevalsrc='(0.5+0.5*cos(2*PI*t/16))*(${chord([220, 277.18, 329.63, 493.88])})+(0.5-0.5*cos(2*PI*t/16))*(${chord([185, 220, 277.18, 329.63])})':s=48000:d=${secs},`
  + `lowpass=f=1100,aecho=0.8:0.6:180|360:0.25|0.15,volume=0.022,afade=t=in:d=2.5,afade=t=out:st=${(Number(secs) - 3).toFixed(2)}:d=3[pad]`;
const inputs = clips.flatMap((c) => ['-i', c.file]);
const voices = clips.map((c, i) => `[${i + 1}:a]adelay=${c.at}|${c.at}[a${i}]`).join(';')
  + `;${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,asplit[v1][v2]`;
const mix = `${voices};${pad};[pad][v2]sidechaincompress=threshold=0.015:ratio=6:attack=30:release=600[duck];[v1][duck]amix=inputs=2:normalize=0,alimiter=limit=0.9[aud]`;
const ff = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-i', webm, ...inputs, '-filter_complex', `[0:v]scale=1920:1080:flags=lanczos,fps=30[v];${mix}`,
  '-map', '[v]', '-map', '[aud]', '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', out], { stderr: 'inherit' });
if (ff.exitCode) throw new Error('ffmpeg failed');
console.log(`demo video: ${out}`);
