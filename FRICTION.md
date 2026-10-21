# Friction log

Real problems hit while building Game Night (Oct 21, 2026). Nothing here is hypothetical.
Severity: High = blocked a feature, Medium = cost real time or forced a design change, Low = papercut.

## 1. No way to run the Bedrock path: no credentials, credits gone

- **Task:** Generate mystery cases and judge Twenty Questions answers with Claude on Amazon Bedrock (AWS Builder mini-challenge).
- **Steps:** Checked for credentials (`AWS_*` env vars, `~/.aws`). `~/.aws` existed but held no `credentials` or `config`. Looked at the hackathon rules for the AWS credit offer.
- **Expected:** Request the $150 hackathon AWS credits and test Bedrock end to end.
- **Actual:** The rules say credit requests closed Oct 21 12pm PT and that "October 7th Update: We are out of credit codes". With no credentials on the build machine we could not run a single Bedrock call.
- **Severity:** High
- **Workaround:** Every Bedrock call has a deterministic offline fallback (hand-written cases, a fact-table yes/no answerer, a rule-based intent router), and Bedrock switches on automatically when credentials are present. The Bedrock code is type-checked but has not run against the live service.
- **Suggestion:** Give hackathon entrants a small Bedrock sandbox, or a free-tier path that doesn't need credits, for the whole submission window.

## 2. Two TypeScript MCP SDK lines, and the README doesn't match the protocol version served

- **Task:** Pick the MCP TypeScript SDK that serves spec 2025-11-25 over Streamable HTTP.
- **Steps:** `npm view` shows `@modelcontextprotocol/sdk@1.32.1` (v1, one package) and `@modelcontextprotocol/server@2.3.1` / `client` / `core` (v2, split packages). Installed v2 and read its README and type definitions.
- **Expected:** One clear answer to "which version speaks 2025-11-25?".
- **Actual:** The v2 README says it implements "the 2026-07-28 MCP spec", but `LATEST_PROTOCOL_VERSION` in `@modelcontextprotocol/core` is `'2025-11-25'`. 2026-07-28 traffic is a separate "modern" envelope era. We had to run a raw `initialize` with `protocolVersion: "2025-11-25"` to confirm the server answers with that version, and the v2 client negotiated it too.
- **Severity:** Medium
- **Workaround:** Verified on the wire with curl and with the smoke script, which prints `protocol version: 2025-11-25`.
- **Suggestion:** The Alexa+ docs could name the exact SDK packages and versions that are known to work with Alexa+ for Builders.

## 3. 2025-era Streamable HTTP is stateless in the SDK's web-standard handler

- **Task:** Keep each game's secret on the server between tool calls.
- **Steps:** Used `createMcpHandler(factory)` from `@modelcontextprotocol/server`, which fits `Bun.serve`.
- **Expected:** Session-scoped server state, as with v1's `sessionIdGenerator`.
- **Actual:** For 2025-11-25 clients the handler builds a fresh `McpServer` per HTTP request ("stateless legacy fallback"), and GET/DELETE return 405. No session id reaches the tools, so any in-memory state is lost between calls.
- **Severity:** Medium (a design constraint, documented in the `.d.ts` but easy to miss)
- **Workaround:** All game state lives in SQLite (`bun:sqlite`), one current round per game per server: one household per self-hosted server.
- **Suggestion:** State this up front in the serving guide. Alexa+ docs could also say whether Alexa+ sends `Mcp-Session-Id` and how a server should identify the household or user.

## 4. The structured-output helper silently drops enum and minItems constraints

- **Task:** Get the Bedrock-generated mystery case back as validated JSON (`zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod`, Zod 4).
- **Steps:** Printed `zodOutputFormat(schema)` for a schema with `z.enum([...])` and `.min(2)` on an array.
- **Expected:** The JSON Schema sent to the model enforces those constraints.
- **Actual:** The enum became `{"type":"string","description":"{enum: [\"x\",\"y\"]}"}` and `minItems` moved into a description string. Both are hints, not constraints.
- **Severity:** Low
- **Workaround:** Re-validate every parsed result with the Zod schema, and run the game's own `validateCase` on top (killer implicated by at least 2 clues, every innocent suspect cleared, every room has a clue). On any failure we fall back to a built-in case.
- **Suggestion:** Document which JSON Schema keywords survive the conversion.

## 5. Alexa+ MCP requirements we could not meet or test

- **Task:** Connect the server to Alexa+.
- **Steps:** Read the MCP Toolkit quickstart and overview on developer.amazon.com.
- **Expected:** A path to register a self-hosted MCP server and test it on a device or simulator.
- **Actual:**
  - The documented flow uses the `alexa-ai` CLI (`alexa-ai configure`, `alexa-ai new mcp --mcp-server-url ...`, `alexa-ai deploy`) and the console web simulator. We had no access to either to try them.
  - The requirements list OAuth 2.1 with PKCE plus RFC 9728 Protected Resource Metadata. They also say "Your MCP server must meet a round-trip query response latency of less than 500 ms."
  - An LLM-generated mystery (`start_case` with Bedrock) cannot meet 500 ms. The offline paths can.
- **Severity:** High for the real Alexa+ demo
- **Workaround:** Built the simulated Alexa+ web app that the rules allow. It connects to the same MCP server as a real MCP client over Streamable HTTP.
- **Suggestion:** Give hackathon entrants a sandbox (or an allow-listed CLI and simulator) for the submission window. Say whether the 500 ms limit applies per tool call, and whether a long call can stream progress instead.

## 6. Devpost rules and FAQ pages refuse automated fetches

- **Task:** Quote the hackathon rules accurately in the README.
- **Steps:** Fetched `amazonappdev2026.devpost.com/rules` and `/details/faqs` with a plain web fetcher.
- **Expected:** Page text.
- **Actual:** HTTP 403 for both.
- **Severity:** Low
- **Workaround:** Read the rules through a logged-in tool.
- **Suggestion:** Publish the rules as a plain page or a PDF too.

## 7. `initialize` with bad params answers -32603 with a raw validation dump

- **Task:** Check how the server handles malformed JSON-RPC.
- **Steps:** POST `initialize` with `params: {}` (or a wrong `protocolVersion` type) to `/mcp`.
- **Expected:** `-32602` (invalid params) with a short message.
- **Actual:** `-32603` (internal error) whose message is the raw zod issue list. Our code has no `initialize` handler; the SDK registers it and validates inside the protocol layer.
- **Severity:** Low (no crash, no stack trace)
- **Workaround:** None in our code; we only test that the server stays up and the error is a JSON-RPC error.
- **Suggestion:** Map schema failures in built-in request handlers to `InvalidParams` and keep validator output out of the message.
