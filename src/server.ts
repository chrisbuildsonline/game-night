import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { reply, type Game } from './hub';
import { whodunnit } from './whodunnit';
import { twenty } from './twenty';
import { chat } from './agent';
import { bedrockOn, MODEL } from './llm';

export const games: Game[] = [whodunnit, twenty];

const INSTRUCTIONS = `Game Night is a voice game hub for a family playing together, screen-free.
You are the host. Keep every spoken turn short (one to three sentences), warm and playful, and end with what the players can do next.
The server holds every secret (the culprit, the secret word). You never know them until a tool reveals them, so never guess, invent or hint at a solution.
Speak tool results in your own words; never read out text after "HOST NOTE:", it is guidance for you only.
Start with list_games when the family wants to play and does not name a game.`;

export function createServer() {
  const server = new McpServer({ name: 'game-night', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  server.registerTool(
    'list_games',
    {
      title: 'List games',
      description:
        'List the games in the Game Night hub and any round already in progress. Call this when the family says they want to play a game, asks what games there are, or opens Game Night. Read the options aloud briefly and ask which one they want.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const lines = games.map((g) => `${g.title}: ${g.pitch}${g.status() ? ` (${g.status()})` : ''}`);
      return reply(
        `Tonight's games. ${lines.join(' ')} Which one would you like?`,
        `To start a game call its start tool: ${games.map((g) => `${g.title} -> ${g.startTool}`).join(', ')}.`,
      );
    },
  );
  for (const g of games) g.register(server);
  return server;
}

const mcp = createMcpHandler(createServer, { onerror: (e) => console.error('[mcp]', e.message) });
const port = Number(process.env.PORT ?? 8686);

// DNS-rebinding guard (MCP transport spec): browsers send Origin; server-to-server clients like Alexa+ don't.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
function originOk(req: Request) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const host = URL.canParse(origin) ? new URL(origin).hostname : '';
  return host === 'localhost' || host === '127.0.0.1' || allowedOrigins.includes(origin);
}
const forbidden = () => new Response('Forbidden origin', { status: 403 });

if (import.meta.main) {
  Bun.serve({
    port,
    idleTimeout: 120,
    routes: {
      '/mcp': (req) => (originOk(req) ? mcp.fetch(req) : forbidden()),
      '/': () => new Response(Bun.file(new URL('../public/index.html', import.meta.url).pathname)),
      '/api/chat': {
        POST: async (req) => {
          if (!originOk(req)) return forbidden();
          if (!req.headers.get('content-type')?.includes('application/json')) return new Response('Expected JSON', { status: 415 });
          const body = (await req.json().catch(() => null)) as { conversation?: unknown; text?: unknown } | null;
          if (typeof body?.conversation !== 'string' || typeof body.text !== 'string' || !body.text.trim()) {
            return new Response('Expected { conversation, text }', { status: 400 });
          }
          return Response.json(await chat(body.conversation, body.text.slice(0, 500)));
        },
      },
    },
    fetch: () => new Response('Not found', { status: 404 }),
  });
  console.log(`Game Night on http://localhost:${port} (MCP: /mcp, Bedrock: ${bedrockOn ? MODEL : 'off, using offline fallbacks'})`);
}
