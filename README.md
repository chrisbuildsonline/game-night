# Game Night

A voice game hub for Alexa+, built for screen-free family game nights. It is one self-hosted MCP server (Streamable HTTP, MCP spec 2025-11-25) that holds each game's secrets and rules. The voice assistant does the storytelling.

- **Whodunnit at Home** (flagship). The family names the rooms of their house, and the server writes a cozy murder mystery set in those rooms. It picks a victim, suspects, a culprit, a motive and a weapon, then hides clues in the real kitchen, garage and attic. The family searches rooms, questions suspects and makes an accusation.
- **Twenty Questions.** The server picks a secret and locks it. The family asks yes/no questions until they guess it or run out of questions.

Built for [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/) (Alexa+ track and the AWS Builder mini-challenge).

## Why an MCP server

A language model running a mystery on its own can forget who did it, or change the answer when it is challenged. Game Night keeps every secret on the server:

- The culprit, motive, weapon, which clue clears whom, and the Twenty Questions answer are in the server's SQLite database, never in the conversation.
- The assistant sees only what a tool returns. The solution is returned only by `accuse` once the case ends, or when the round is over.
- The server keeps the rules: question counting, the 20-question limit, three accusations.

The assistant improvises the voices and the drama. The server keeps it honest.

## Architecture

```
 Alexa+  ──or──  simulated Alexa+ web app (public/index.html + src/agent.ts)
                        │  MCP client over Streamable HTTP
                        ▼
              POST /mcp  ── src/server.ts (createMcpHandler, @modelcontextprotocol/server v2)
                        │   list_games + each game's tools
          ┌─────────────┴──────────────┐
   src/whodunnit.ts             src/twenty.ts         (shared Game interface: src/hub.ts)
          │                            │
          └──── src/hub.ts: bun:sqlite state (one current round per game)
          └──── src/llm.ts: Claude on Amazon Bedrock (case generation, yes/no judge)
                             with deterministic offline fallbacks
```

- Each game implements a small `Game` interface (`id`, `title`, `pitch`, `startTool`, `status()`, `register(server)`). Adding a game is one file plus one line in `server.ts`.
- 2025-11-25 clients are served statelessly: the SDK builds a fresh `McpServer` per HTTP request. All state is therefore in SQLite (`game-night.sqlite`, or `GAME_DB`). One server equals one household.
- Tool results are short sentences meant to be spoken. Anything after `HOST NOTE:` is guidance for the assistant, and the server instructions tell it never to read that part aloud.

### MCP tools

| Tool | What it does |
|---|---|
| `list_games` | Lists the games and any round in progress |
| `start_case({rooms, players?})` | Generates a new mystery set in the given rooms (2 to 8) |
| `search_room({room})` | Reveals the clues hidden in a room |
| `interrogate({suspect})` | A suspect's in-character statement and alibi |
| `case_status()` | Rooms searched, clues found, accusations left |
| `accuse({suspect})` | Right: case solved and solution revealed. Wrong: one of 3 accusations used |
| `start_twenty_questions({category?})` | Locks a new secret (animal, food or object) |
| `ask_question({question})` | Yes / no / sometimes, counted against the 20 |
| `make_guess({guess})` | Guess the secret (a wrong guess counts as a question) |
| `twenty_status()` | Questions used and asked so far |
| `give_up()` | Ends the round and reveals the secret |

The tool descriptions are written for a voice host. They give example family phrases, say when to call each tool and how to narrate the result, and say that the host never knows or guesses a secret.

## Amazon Bedrock (AWS Builder mini-challenge)

`src/llm.ts` calls Claude on Amazon Bedrock through Anthropic's Bedrock client (`AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk`). The default model id is `anthropic.claude-sonnet-5-5`. Bedrock is used in three places:

1. **Case generation** (`start_case`). Claude writes a case as structured JSON (`output_config.format` with a Zod schema). The server re-validates it with Zod and with `validateCase()`, which checks that the case is solvable and consistent:
   - the culprit is implicated by at least 2 clues and never cleared;
   - every innocent suspect is cleared by a clue;
   - every room has a clue and every clue is in a real room;
   - no suspect name is ambiguous;
   - the motive and weapon aren't given away in the intro or the statements.

   An invalid case gets one retry with the problems listed, then falls back to a built-in case.
2. **Yes/no judge** (`ask_question`). Claude gets the secret and the family's question, and answers only with `{answer: yes|no|sometimes|unclear, isCorrectGuess}`. Because the output is constrained to that shape, a prompt-injected question can't make it leak the secret as text.
3. **The simulated Alexa+ agent** (`src/agent.ts`). A Claude tool-use loop whose tools are the MCP server's tools, called through a real MCP client.

Every Bedrock call has an offline fallback, so the demo never breaks:
- hand-written mystery cases that place their clues across whatever rooms the family names;
- a fact-table yes/no answerer;
- a rule-based intent router for the web app.

Configuration is read only from environment variables. Bun loads a `.env` file in the project root automatically; `.env` is gitignored, so keep secrets there and never commit them.

| Variable | Default | Meaning |
|---|---|---|
| `AWS_REGION` | `us-east-1` | Bedrock region |
| AWS credentials | none | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE`, or a Bedrock API key in `AWS_BEARER_TOKEN_BEDROCK`. Any of them switches Bedrock on |
| `BEDROCK` | auto | `on` forces Bedrock (default AWS credential chain), `off` forces the offline fallbacks |
| `BEDROCK_MODEL_ID` | `anthropic.claude-sonnet-5-5` | Bedrock model id |
| `HOST` | `127.0.0.1` | Interface to bind. Keep the default behind a tunnel |
| `PORT` | `8686` | HTTP port |
| `ALLOWED_HOSTS` | none | Comma-separated public hostnames (e.g. your tunnel host) allowed in `Host`/`Origin` on `/mcp`. Localhost is always allowed |
| `GAME_NIGHT_TOKEN` | none | When set, `/mcp` and `/api/chat` require `Authorization: Bearer <token>` (open the page with `#token=<token>`) |
| `GAME_DB` | `game-night.sqlite` | SQLite file |

> **Status: the Bedrock path has not been run against the live service.** There were no AWS credentials on the build machine, and the hackathon's AWS credits ran out on Oct 7. The code is type-checked and follows the SDK's documented API, but treat it as untested until someone runs it. To enable it:
> 1. In the AWS console, open Amazon Bedrock in your region and enable access to Claude Sonnet 5.5.
> 2. Export credentials, e.g. `export AWS_BEARER_TOKEN_BEDROCK=...` (a Bedrock API key) or `export AWS_PROFILE=...`, plus `export AWS_REGION=us-east-1`.
> 3. Run `bun start`. The startup line says `Bedrock: anthropic.claude-sonnet-5-5` instead of `Bedrock: off`.

## Run it

Requires [Bun](https://bun.sh) 1.4+.

```sh
bun install
bun start                  # Game Night on http://localhost:8686 (MCP endpoint: /mcp)
```

- **Simulated Alexa+:** open http://localhost:8686 in Chrome or Edge. Press the mic and talk, or type. Replies are spoken aloud. Each reply lists the MCP tool calls it made, so you can see the MCP traffic.
- **Tests:** `bun test` covers the game logic:
  - no secret is leaked before the reveal;
  - a correct accusation reveals the solution, a wrong one doesn't, and three wrong ones end the case;
  - case validation;
  - the 20-question limit;
  - guesses, give-up, and the race between a slow answer and a new round.
- **End-to-end smoke check** (with the server running): `bun run smoke` (set `MCP_URL=http://localhost:<port>/mcp` if you changed `PORT`). It connects as an MCP client over Streamable HTTP, checks that it negotiates protocol `2025-11-25`, lists all 11 tools, plays both games, and calls the web app's API.
- **Any MCP client:** point it at `http://localhost:8686/mcp`, for example `npx @modelcontextprotocol/inspector`. You can also use plain curl:

  ```sh
  curl -s 127.0.0.1:8686/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
  ```

## Connecting to Alexa+

**Verified from Amazon's docs** (the [MCP Toolkit quickstart](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart) and [overview](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview), read Oct 21 2026):
- "Alexa+ for Builders supports the 2025-11-25 version of the MCP specification." and "Your MCP server must support Streamable HTTP." Game Night does both.
- "Your MCP server must be accessible via a remote URL. During local development, you can use a tunneling service (such as cloudflared) to expose your server." See "Exposing the server" below.
- Registration goes through the `alexa-ai` CLI:
  - `alexa-ai configure`
  - `alexa-ai new mcp --name "Game Night" --locale en-US --mcp-server-url "https://<your-host>/mcp"`
  - `alexa-ai deploy`
  - The add-on manifest has an `integrations` entry of type `MCP` with an `HTTPS` endpoint. Testing is in the developer console's web simulator, or routed to a device.
- The docs' requirements also list:
  - an authentication checklist: OAuth 2.1 authorization code flow with PKCE (S256), and a Protected Resource Metadata document per RFC 9728;
  - "Your MCP server must meet a round-trip query response latency of less than 500 ms."

**Not verified, or not done:**
- We did not have access to the `alexa-ai` CLI or the Alexa+ web simulator, so Game Night has **not** been connected to a real Alexa+ device. The demo uses the simulated Alexa+ web app, which the hackathon rules allow ("entrants may submit a simulated Alexa+ experience instead").
- **Auth:** the only auth the Alexa+ docs describe is OAuth 2.1 (authorization code with PKCE S256, Bearer token on every request, RFC 9728 Protected Resource Metadata, `401` without `WWW-Authenticate` for unauthenticated requests). Game Night does **not** implement OAuth. Its optional `GAME_NIGHT_TOKEN` is a static shared bearer token: it protects a public endpoint for MCP clients you configure yourself (Inspector, the smoke check, your own agent), but nothing in Amazon's docs says Alexa+ can send a static token, so assume it can't (unverified). The docs also don't make clear whether OAuth is required for every add-on or only for account linking. A real Alexa+ deployment probably needs an OAuth 2.1 / RFC 9728 layer in front of `/mcp`.
- **Latency:**
  - The offline paths answer well under 500 ms.
  - Bedrock calls cannot: an LLM-generated mystery takes seconds. Each Bedrock call times out after 20 s (a rejected case is retried once), then falls back to a built-in case.
  - We don't know how Alexa+ treats a slow tool call. A deployment that needs to stay under 500 ms can set `BEDROCK=off` for the tools, which keeps the built-in cases.
- The docs don't state tool-call timeouts, response-size limits or a maximum number of tools.

### Exposing the server

The server binds to `127.0.0.1` and rejects any `Host` or `Origin` that isn't localhost (DNS-rebinding protection, using the MCP SDK's `hostHeaderValidationResponse` / `originValidationResponse`). To reach it from outside through a tunnel:

```sh
# 1. Start a tunnel and note its hostname, e.g. game-night-abc.trycloudflare.com
cloudflared tunnel --url http://127.0.0.1:8686
# 2. In .env (gitignored):
#    ALLOWED_HOSTS=game-night-abc.trycloudflare.com
#    GAME_NIGHT_TOKEN=<a long random string, e.g. from: openssl rand -hex 32>
# 3. Start the server
bun start
# 4. Check it from outside
curl -s https://game-night-abc.trycloudflare.com/mcp -H "authorization: Bearer $GAME_NIGHT_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

The MCP endpoint is then `https://<tunnel-host>/mcp`. The demo page's `/api/chat` stays localhost-only even when `ALLOWED_HOSTS` is set, because it can spend Bedrock credits: it requires a localhost `Host`/`Origin` **and** a loopback socket peer, and the bearer token too when `GAME_NIGHT_TOKEN` is set. With a token, open the page as `http://localhost:8686/#token=<GAME_NIGHT_TOKEN>`; the page keeps the token in memory, removes it from the address bar and sends it as an `Authorization` header.

Do not use a tunnel that rewrites the `Host` header to localhost (e.g. `ngrok --host-header=rewrite`), and don't bind `HOST=0.0.0.0` without `GAME_NIGHT_TOKEN`: a tunnel's traffic arrives from a loopback peer, so a rewritten Host would make remote requests look local. Leave `GAME_NIGHT_TOKEN` unset if your client cannot send a bearer token, but then anyone with the URL can play on your server.

## Demo video script (under 3 minutes)

Recorded on the simulated Alexa+ web app with speech on. Lead with the mystery reveal.

| Time | Shot | Words |
|---|---|---|
| 0:00 to 0:15 | Cold open, the family at the table. The ring glows. | "I accuse... the butler!" Alexa: "Correct! Fitz Hargrove did it, with the brass telescope..." Freeze-frame. Title: *Game Night: a murder mystery in your own house.* |
| 0:15 to 0:30 | Rewind. "Open Game Night." | Alexa lists the two games. "A mystery!" "Which rooms are in your house?" "Kitchen, garage, attic and living room." |
| 0:30 to 1:20 | The case is told in their rooms. Show the MCP tool calls under each reply. | Intro narration. "Search the kitchen." Glove with brass polish. "Talk to the butler." His in-character alibi. "Search the attic." Torn map in a coat marked F. H. "Where are we?" Status. |
| 1:20 to 1:45 | A wrong guess, then the right one | "I accuse Wilf." "Wilf is innocent: his van was stuck behind a tractor. Two accusations left." "It was Fitz!" Full reveal. |
| 1:45 to 2:05 | Why MCP. Split screen: chat on the left, server log or tool calls on the right. | VO: "The answer lives on the server, not in the AI. Alexa can't forget it, change it, or be talked into revealing it. Only `accuse` reveals it." |
| 2:05 to 2:30 | Twenty Questions, fast cut | "Twenty questions with food." "Is it sweet?" "Yes. 19 left." "Is it cold?" "Yes." "Is it ice cream?" "Yes! You got it in 3 questions." |
| 2:30 to 2:50 | Architecture card | One MCP server over Streamable HTTP, spec 2025-11-25. Games behind one shared interface. State in SQLite. Claude on Amazon Bedrock writes the cases, with offline fallbacks. |
| 2:50 to 2:58 | End card | "Game Night. Screen-free family fun for Alexa+." Repo URL. |

## Limitations

- One household per server: each game has one current round.
- No OAuth, so it is not ready to register with Alexa+ as is (see above). The optional static bearer token is for clients you control.
- The offline Twenty Questions answerer only knows the facts in its table. Unusual questions get "try asking another way" and are not counted.
- Bedrock paths are untested against the live service.

See [FRICTION.md](FRICTION.md) for the friction log.

## License

MIT, see LICENSE.
