import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type * as z from 'zod';

// Short timeout, no retries: a voice turn can't wait long, and every caller has an offline fallback.
// Bedrock is used when AWS credentials are configured (or BEDROCK=on); BEDROCK=off forces the offline fallbacks.
const env = process.env;
const hasCreds = Boolean(env.AWS_BEARER_TOKEN_BEDROCK || env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE);
export const bedrockOn = env.BEDROCK === 'on' || (env.BEDROCK !== 'off' && hasCreds);
export const MODEL = env.BEDROCK_MODEL ?? 'anthropic.claude-sonnet-5-5';
export const bedrock = bedrockOn
  ? new AnthropicBedrockMantle({ awsRegion: env.AWS_REGION ?? 'us-east-1', timeout: 20_000, maxRetries: 0 })
  : null;

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
    console.error('[bedrock] askJson failed:', (err as Error).message);
    return null;
  }
}
