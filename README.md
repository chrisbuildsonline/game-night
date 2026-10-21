# game-night

A voice game hub for Alexa+: one Streamable HTTP MCP server that keeps each game's secrets and rules, while Alexa+ improvises the story. Flagship game: Whodunnit at Home, a murder mystery set in the rooms of your own house. Second game: Twenty Questions where the answer is locked on the server, so Alexa can't change it mid-game.

Built for [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/). Submissions close 2026-10-23.

## What it does

A voice game hub for Alexa+: one Streamable HTTP MCP server that keeps each game's secrets and rules, while Alexa+ improvises the story. Flagship game: Whodunnit at Home, a murder mystery set in the rooms of your own house. Second game: Twenty Questions where the answer is locked on the server, so Alexa can't change it mid-game.

## Stack

TypeScript MCP SDK (Streamable HTTP, spec 2025-11-25+), Bun, SQLite for game state, AWS Bedrock (current Claude model) for case and clue generation, Alexa+ MCP integration, with the simulated Alexa+ web app as a fallback

## License

MIT, see LICENSE.
