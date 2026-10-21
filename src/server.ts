import { timingSafeEqual } from 'node:crypto';
import {
  McpServer,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  originValidationResponse,
} from '@modelcontextprotocol/server';
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

// DNS-rebinding guard (MCP transport spec): Host and Origin must be localhost, or a public hostname you
// list in ALLOWED_HOSTS (e.g. your tunnel). The demo page's /api/chat is localhost-only.
const LOCAL = localhostAllowedHostnames();
const PUBLIC = [...LOCAL, ...(process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)];
const rejectForeign = (req: Request, hosts: string[]) =>
  hostHeaderValidationResponse(req, hosts) ?? originValidationResponse(req, hosts);

// Optional shared secret for a publicly exposed /mcp (Alexa+ itself expects OAuth 2.1; see README).
const TOKEN = process.env.GAME_NIGHT_TOKEN;
function tokenOk(req: Request) {
  if (!TOKEN) return true;
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

if (import.meta.main) {
  Bun.serve({
    port,
    hostname: process.env.HOST ?? '127.0.0.1',
    idleTimeout: 120,
    routes: {
      '/mcp': (req) =>
        rejectForeign(req, PUBLIC) ?? (tokenOk(req) ? mcp.fetch(req) : new Response('Unauthorized', { status: 401 })),
      '/': () => new Response(Bun.file(new URL('../public/index.html', import.meta.url).pathname)),
      '/api/chat': {
        POST: async (req) => {
          const rejected = rejectForeign(req, LOCAL);
          if (rejected) return rejected;
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
  console.log(`Game Night on http://localhost:${port} (MCP: /mcp${TOKEN ? ' with bearer token' : ''}, Bedrock: ${bedrockOn ? MODEL : 'off, using offline fallbacks'})`);
}
