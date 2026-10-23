// Records the demo video: a scripted playthrough in the simulated Alexa+ web app, with a voice track.
// Needs ffmpeg and uvx (edge-tts voices). Runs its own server on :8703 with a throwaway DB and Bedrock off.
// bun run demo:video -> out/game-night-demo.mp4
import { chromium, type Page } from '@playwright/test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8703;
const TMP = mkdtempSync(join(tmpdir(), 'gn-demo-'));
const OUT = join(import.meta.dir, '..', 'out');
const DB = join(TMP, 'demo.sqlite');
const VOICES = { host: 'en-US-AvaNeural', user: 'en-US-AndrewNeural', narrator: 'en-US-BrianNeural' };
type Voice = keyof typeof VOICES;

let n = 0;
async function tts(voice: Voice, text: string) {
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

if (await fetch(`http://localhost:${PORT}/`).then(() => true, () => false)) throw new Error(`port ${PORT} is busy: stop the old server first`);
const server = Bun.spawn(['bun', 'src/server.ts'], {
  cwd: join(import.meta.dir, '..'),
  env: { ...process.env, PORT: String(PORT), GAME_DB: DB, BEDROCK: 'off', GAME_NIGHT_TOKEN: '' },
  stdout: 'ignore', stderr: 'inherit',
});
for (let i = 0; ; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
  if (i > 50) throw new Error('server did not start');
  await Bun.sleep(200);
}

// Fixed lines are synthesized up front, in parallel, so the recording never waits on edge-tts.
const N = {
  intro: tts('narrator', 'This is Game Night. One MCP server holds the secrets and rules of voice games for Alexa plus, while the host improvises the story. Here it runs in our simulated Alexa plus web app.'),
  second: tts('narrator', 'Same server, second game. In Twenty Questions the secret is locked on the server, so the host can never change it.'),
  outro: tts('narrator', 'Every answer comes from an MCP tool call, and all game state lives on the server. Cases come from Amazon Bedrock when available, with validated hand-written cases as the fallback, as in this recording. Game Night: tonight, your house is the board.'),
};
const U = {
  start: tts('user', 'Alexa, start a mystery in the kitchen, the garage and the attic.'),
  attic: tts('user', 'Search the attic.'),
  butler: tts('user', 'Interrogate the butler.'),
  accuse: tts('user', 'I accuse Fitz, the butler!'),
  twenty: tts('user', "Let's play twenty questions with animals."),
  alive: tts('user', 'Is it alive?'),
  legs: tts('user', 'Does it have four legs?'),
};
await Promise.all([...Object.values(N), ...Object.values(U)]);

const clips: { file: string; at: number }[] = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: TMP, size: { width: 1280, height: 720 } } });
// The voice track replaces the browser's own speech; the ring is driven from here instead.
await ctx.addInitScript(() => { if ('speechSynthesis' in window) speechSynthesis.speak = () => {}; });
const page: Page = await ctx.newPage();
const t0 = Date.now();
const now = () => Date.now() - t0;
const ring = (s: string) => page.evaluate((st) => (window as any).setState(st), s);
await page.goto(`http://localhost:${PORT}/`);
await page.waitForLoadState('networkidle');

async function narrate(clip: ReturnType<typeof tts>) {
  const c = await clip;
  clips.push({ file: c.file, at: now() });
  await Bun.sleep(c.ms + 300);
}

// The player speaks while the words appear, as speech-to-text would show them; then the host answers aloud.
async function say(spoken: ReturnType<typeof tts>, typed: string) {
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
  const h = await tts('host', reply);
  clips.push({ file: h.file, at });
  await Bun.sleep(Math.max(0, h.ms - (now() - at)) + 400);
  await ring('idle');
}

await Bun.sleep(600);
await narrate(N.intro);
await say(U.start, 'start a mystery in the kitchen, the garage and the attic');
await say(U.attic, 'search the attic');
await say(U.butler, 'interrogate the butler');
await say(U.accuse, 'I accuse Fitz');
await narrate(N.second);
await say(U.twenty, "let's play twenty questions with animals");
const secret: string = JSON.parse((new Database(DB, { readonly: true }).query("SELECT data FROM state WHERE game = 'twenty'").get() as { data: string }).data).secret;
const guess = tts('user', `Is it a ${secret}?`);
await say(U.alive, 'is it alive?');
await say(U.legs, 'does it have four legs?');
await say(guess, `my guess is ${secret}`);
await page.locator('.msg.bot summary').last().click();
await narrate(N.outro);
await Bun.sleep(1000);

await ctx.close();
await browser.close();
server.kill();

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
