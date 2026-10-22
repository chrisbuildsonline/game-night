import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type * as z from 'zod';

// Short timeout, no retries: a voice turn can't wait long, and every caller has an offline fallback.
// Bedrock is used when AWS credentials are configured (or BEDROCK=on); BEDROCK=off forces the offline fallbacks.
const env = process.env;
const hasCreds = Boolean(env.AWS_BEARER_TOKEN_BEDROCK || env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE);
export const bedrockOn = env.BEDROCK === 'on' || (env.BEDROCK !== 'off' && hasCreds);
export const MODEL = env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6';
export const bedrock = bedrockOn
  ? new AnthropicBedrock({ awsRegion: env.AWS_REGION ?? 'us-east-1', timeout: 20_000, maxRetries: 0 })
  : null;

// True for HTTP 429 and for throttling / daily-token-quota messages from Bedrock.
export function isQuotaError(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | null;
  return e?.status === 429 || /too many tokens|throttl|rate exceeded|quota/i.test(e?.message ?? '');
}

// Logged (in addition to the generic fallback line) so the live test can tell a quota block from a code failure.
export const QUOTA_MARKER = '[bedrock] AWS daily token quota exhausted';

// Structured JSON from Claude on Bedrock, validated by `schema`. Returns null when Bedrock is off or the call fails.
export async function askJson<T>(system: string, prompt: string, schema: z.ZodType<T>, maxTokens = 8000): Promise<T | null> {
  if (!bedrock) return null;
  try {
    const res = await bedrock.messages.parse({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort: 'low', format: zodOutputFormat(schema as any) },
    });
    return res.parsed_output ? schema.parse(res.parsed_output) : null;
  } catch (err) {
    if (isQuotaError(err)) console.error(`${QUOTA_MARKER}: ${(err as Error).message}`);
    console.error('[bedrock] askJson failed:', (err as Error).message);
    return null;
  }
}
