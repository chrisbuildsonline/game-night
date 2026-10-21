import { Database } from 'bun:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';

// The shared game interface. Each game keeps its secrets server-side and exposes tools.
export interface Game {
  id: string;        // state key and tool prefix context, e.g. 'whodunnit'
  title: string;     // spoken name, e.g. 'Whodunnit at Home'
  pitch: string;     // one speakable sentence
  startTool: string; // tool that starts a new round
  status(): string | null; // one speakable line if a round is in progress, else null
  register(server: McpServer): void;
}

// One household per server: each game has one current round, stored as JSON.
const db = new Database(process.env.GAME_DB ?? 'game-night.sqlite');
db.run('CREATE TABLE IF NOT EXISTS state (game TEXT PRIMARY KEY, data TEXT NOT NULL)');

export function load<T>(game: string): T | null {
  const row = db.query('SELECT data FROM state WHERE game = ?').get(game) as { data: string } | null;
  return row ? (JSON.parse(row.data) as T) : null;
}

export function save(game: string, data: unknown) {
  db.query('INSERT INTO state (game, data) VALUES (?, ?) ON CONFLICT(game) DO UPDATE SET data = excluded.data').run(game, JSON.stringify(data));
}

// Tool result: `say` is meant to be spoken; `note` is guidance for the voice host only.
export function reply(say: string, note?: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text: note ? `${say}\n\nHOST NOTE: ${note}` : say }],
    ...(isError ? { isError: true } : {}),
  };
}
