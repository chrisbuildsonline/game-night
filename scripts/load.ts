// Load and performance test. Starts the server itself (offline mode, throwaway DB) unless MCP_URL is given.
// Usage: bun scripts/load.ts [--sessions 50] [--duration 30] [--think 150] [--port 8710]
// Exit 1 when: errors > 0, any tool p95 > 500ms (offline), or memory looks leaked / unbounded.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const SESSIONS = arg('sessions', 50);
const DURATION_S = arg('duration', 30);
const THINK_MS = arg('think', 150); // pause between tool calls: a voice turn is never back to back
const PORT = arg('port', 8710);
const P95_LIMIT_MS = 500;
const CALL_TIMEOUT_MS = 15_000;

const EXTERNAL = process.env.MCP_URL;
const MCP_URL = EXTERNAL ?? `http://127.0.0.1:${PORT}/mcp`;
const BASE = new URL(MCP_URL).origin;
const AUTH: Record<string, string> = process.env.GAME_NIGHT_TOKEN ? { authorization: `Bearer ${process.env.GAME_NIGHT_TOKEN}` } : {};

// ---- server lifecycle ----
const dbPath = join(tmpdir(), `game-night-load-${process.pid}.sqlite`);
let proc: ReturnType<typeof Bun.spawn> | null = null;
let pid: number | null = process.env.SERVER_PID ? Number(process.env.SERVER_PID) : null;
if (!EXTERNAL) {
  proc = Bun.spawn(['bun', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), BEDROCK: 'off', GAME_DB: dbPath, GAME_NIGHT_TOKEN: '' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  pid = proc.pid;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/`)).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
}
const cleanup = () => {
  proc?.kill();
  for (const ext of ['', '-wal', '-shm']) rmSync(dbPath + ext, { force: true });
};
process.on('SIGINT', () => (cleanup(), process.exit(130)));

const rssMb = (): number | null => {
  if (!pid) return null;
  try {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
    return m ? Number(m[1]) / 1024 : null;
  } catch {
    return null;
  }
};

const cpuSeconds = (): number | null => {
  if (!pid) return null;
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
    return (Number(f[11]) + Number(f[12])) / 100; // utime + stime in clock ticks
  } catch {
    return null;
  }
};

// ---- stats ----
const lat = new Map<string, number[]>();
const errors = new Map<string, number>();
const contention = new Map<string, number>(); // shared-household state answers, not failures
let requests = 0;
const record = (name: string, ms: number) => {
  requests++;
  (lat.get(name) ?? lat.set(name, []).get(name)!).push(ms);
};
const fail = (kind: string) => errors.set(kind, (errors.get(kind) ?? 0) + 1);
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const withTimeout = <T>(p: Promise<T>, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), CALL_TIMEOUT_MS))]);
const CONTENTION_RE = /no mystery yet|case is closed|round is over|no game yet|round changed|do not know a (room|suspect)/i;
const rnd = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const think = () => Bun.sleep(THINK_MS * (0.5 + Math.random()));

// ---- sessions ----
const ROOM_POOL = ['kitchen', 'garage', 'attic', 'living room', 'bedroom', 'bathroom', 'basement', 'office'];
const QUESTIONS = ['Is it bigger than a cat?', 'Does it live in water?', 'Can you eat it?', 'Is it alive?', 'Does it live on a farm?', 'Is it made of metal?'];
const GUESSES = ['elephant', 'pizza', 'bicycle', 'giraffe', 'banana'];
let stop = false;

async function session(id: number) {
  const client = new Client({ name: `load-${id}`, version: '1.0.0' });
  const t0 = performance.now();
  try {
    await withTimeout(client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: AUTH } })), 'connect');
    record('(connect)', performance.now() - t0);
  } catch (e) {
    fail(`connect: ${(e as Error).message.slice(0, 80)}`);
    return;
  }
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const t = performance.now();
    try {
      const res: any = await withTimeout(client.callTool({ name, arguments: args }), name);
      record(name, performance.now() - t);
      const text = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      if (res.isError) fail(`isError: ${name}`);
      else if (!text) fail(`empty result: ${name}`);
      else if (CONTENTION_RE.test(text)) contention.set(name, (contention.get(name) ?? 0) + 1);
      return text;
    } catch (e) {
      fail(`${(e as Error).message.startsWith('timeout') ? 'timeout' : 'exception'}: ${name}: ${(e as Error).message.slice(0, 60)}`);
      return '';
    }
  };
  await Bun.sleep(Math.random() * 1000); // stagger so sessions don't march in lockstep
  while (!stop) {
    if (Math.random() < 0.5) {
      const rooms = [...ROOM_POOL].sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 4));
      const intro = await call('start_case', { rooms });
      const suspects = [...(intro.split('suspects are:')[1]?.split('You can search')[0] ?? '').matchAll(/(?:^|\.\s+|:\s*)\s*([A-Z][\w']+(?: [A-Z][\w']+)+),/g)].map((m) => m[1]!);
      for (const room of rooms) { if (stop) break; await think(); await call('search_room', { room }); }
      for (const s of suspects.slice(0, 3)) { if (stop) break; await think(); await call('interrogate', { suspect: s }); }
      await think(); await call('case_status');
      await think(); await call('accuse', { suspect: rnd(suspects.length ? suspects : ['nobody']) });
    } else {
      await call('start_twenty_questions', { category: rnd(['animal', 'food', 'object']) });
      for (let i = 0; i < 3 && !stop; i++) { await think(); await call('ask_question', { question: rnd(QUESTIONS) }); }
      await think(); await call('twenty_status');
      await think(); await call('make_guess', { guess: rnd(GUESSES) });
    }
    if (Math.random() < 0.2) { await think(); await call('list_games'); }
    await think();
  }
  await client.close().catch(() => {});
}

async function wave(n: number, seconds: number) {
  stop = false;
  const timer = setTimeout(() => (stop = true), seconds * 1000);
  const peaks: number[] = [];
  const sampler = setInterval(() => { const r = rssMb(); if (r) peaks.push(r); }, 500);
  await Promise.all(Array.from({ length: n }, (_, i) => session(i)));
  clearTimeout(timer);
  clearInterval(sampler);
  return Math.max(0, ...peaks);
}

async function chatBurst(n: number) {
  const texts = ['what games are there', 'search the kitchen', 'start twenty questions', 'is it bigger than a cat', 'give up'];
  const start = performance.now();
  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const t = performance.now();
      try {
        const res = await withTimeout(
          fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify({ conversation: `load-${i % 20}`, text: texts[i % texts.length] }) }),
          'chat',
        );
        const data: any = await res.json().catch(() => null);
        record('POST /api/chat', performance.now() - t);
        if (!res.ok) fail(`http ${res.status}: /api/chat`);
        else if (typeof data?.reply !== 'string' || !data.reply) fail('empty reply: /api/chat');
      } catch (e) {
        fail(`${(e as Error).message.startsWith('timeout') ? 'timeout' : 'exception'}: /api/chat`);
      }
    }),
  );
  return performance.now() - start;
}

// ---- run ----
console.log(`Load test: ${SESSIONS} sessions, ${DURATION_S}s, think ${THINK_MS}ms, ${EXTERNAL ? `external ${MCP_URL}` : `spawned server pid ${pid} on :${PORT} (offline)`}`);
await wave(Math.min(SESSIONS, 10), 3); // warm-up: JIT and caches, not counted
lat.clear(); errors.clear(); contention.clear(); requests = 0;
const baseline = rssMb();
const t0 = performance.now();
const gen0 = process.cpuUsage();
const cpu0 = cpuSeconds();
const peak1 = await wave(SESSIONS, DURATION_S);
const elapsed = (performance.now() - t0) / 1000;
const reqWave1 = requests;
const cpu1 = cpuSeconds();
const gen = process.cpuUsage(gen0);
const burstN = Math.max(30, SESSIONS);
const burstMs = await chatBurst(burstN);
await Bun.sleep(4000);
const after1 = rssMb();
const peak2 = await wave(Math.min(SESSIONS, 25), Math.min(DURATION_S, 10)); // second wave: does memory keep climbing?
await Bun.sleep(4000);
const after2 = rssMb();

// ---- report ----
const f = (n: number | null) => (n == null ? 'n/a' : n.toFixed(1));
console.log(`\nrequests: ${requests}  elapsed(main wave): ${elapsed.toFixed(1)}s  main-wave throughput: ${(reqWave1 / elapsed).toFixed(0)} req/s; chat burst of ${burstN}: ${burstMs.toFixed(0)}ms`);
console.log('\ntool                       n      p50     p95     p99     max (ms)');
let slow = false;
for (const [name, xs] of [...lat].sort()) {
  const p95 = pct(xs, 95);
  const flag = p95 > P95_LIMIT_MS ? '  <-- SLOW' : '';
  if (p95 > P95_LIMIT_MS) slow = true;
  console.log(`${name.padEnd(24)} ${String(xs.length).padStart(6)} ${pct(xs, 50).toFixed(1).padStart(8)} ${p95.toFixed(1).padStart(7)} ${pct(xs, 99).toFixed(1).padStart(7)} ${Math.max(...xs).toFixed(1).padStart(8)}${flag}`);
}
const errTotal = [...errors.values()].reduce((a, b) => a + b, 0);
console.log(`\nerrors: ${errTotal}${errTotal ? '' : ' (none)'}`);
for (const [k, v] of errors) console.log(`  ${v} x ${k}`);
const cTotal = [...contention.values()].reduce((a, b) => a + b, 0);
console.log(`shared-state answers (not errors; one household state is shared by every session): ${cTotal}`);
console.log(`\nserver RSS MB: baseline ${f(baseline)}, peak wave1 ${f(peak1)}, after wave1 ${f(after1)}, peak wave2 ${f(peak2)}, after wave2 ${f(after2)}`);

const serverDied = proc ? proc.exitCode !== null : false;
if (serverDied) { fail(`server process exited (code ${proc!.exitCode}) during the run`); console.log(`\nSERVER DIED: exit code ${proc!.exitCode}, signal ${proc!.signalCode}`); }
if (cpu0 != null && cpu1 != null) console.log(`server CPU during main wave: ${(((cpu1 - cpu0) / elapsed) * 100).toFixed(0)}% of one core (100% = saturated, single-threaded)`);
console.log(`load generator CPU during main wave: ${(((gen.user + gen.system) / 1e6 / elapsed) * 100).toFixed(0)}% of one core (near 100% means the generator, not the server, limits latency)`);
let leak = false;
if (baseline != null && after1 != null && after2 != null) {
  const unbounded = after2 > after1 * 1.25 + 10;
  const notReturned = after1 > Math.max(baseline * 2.5, baseline + 100);
  leak = unbounded || notReturned;
  console.log(`memory: after-wave1 is ${(after1 / baseline).toFixed(2)}x baseline; wave2 changed it by ${(after2 - after1).toFixed(1)} MB -> ${leak ? (unbounded ? 'GROWING WITHOUT BOUND' : 'NOT RETURNING TO BASELINE') : 'ok (no leak signal)'}`);
}
cleanup();
const failed = errTotal > 0 || serverDied || slow || leak;
console.log(`\n${failed ? 'FAIL' : 'PASS'}${errTotal ? ' errors' : ''}${slow ? ' slow-p95' : ''}${leak ? ' memory' : ''}`);
process.exit(failed ? 1 : 0);
