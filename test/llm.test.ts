import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isQuotaError } from '../src/llm';

// llm.ts reads env at import, so load it in a subprocess with a clean env and a cwd outside the repo
// (Bun auto-loads .env from the cwd). No network calls: the client is only constructed.
const llmPath = new URL('../src/llm.ts', import.meta.url).pathname;
function loadLlm(extraEnv: Record<string, string> = {}): { MODEL: string; baseURL: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'game-night-llm-'));
  const code = `const m = await import(${JSON.stringify(llmPath)}); console.log(JSON.stringify({ MODEL: m.MODEL, baseURL: m.bedrock.baseURL }));`;
  const res = Bun.spawnSync([process.execPath, '-e', code], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', AWS_BEARER_TOKEN_BEDROCK: 'dummy', ...extraEnv },
  });
  expect(res.stderr.toString()).toBe('');
  return JSON.parse(res.stdout.toString());
}

test('defaults to the Sonnet 4.6 inference profile on the bedrock-runtime endpoint', () => {
  const { MODEL, baseURL } = loadLlm();
  expect(MODEL).toBe('us.anthropic.claude-sonnet-4-6');
  expect(baseURL).toContain('bedrock-runtime.');
  expect(baseURL).not.toContain('mantle');
});

test('BEDROCK_MODEL_ID overrides the default model', () => {
  expect(loadLlm({ BEDROCK_MODEL_ID: 'x' }).MODEL).toBe('x');
});

test('isQuotaError recognises throttling and daily-token quota errors', () => {
  expect(isQuotaError({ status: 429, message: 'whatever' })).toBe(true);
  expect(isQuotaError(new Error('Too many tokens per day, please wait before trying again.'))).toBe(true);
  expect(isQuotaError(new Error('ThrottlingException: Rate exceeded'))).toBe(true);
});

test('isQuotaError ignores other errors', () => {
  expect(isQuotaError({ status: 404, message: 'model not found' })).toBe(false);
  expect(isQuotaError(new Error('boom'))).toBe(false);
  expect(isQuotaError(null)).toBe(false);
});
