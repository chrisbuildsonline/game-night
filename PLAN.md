# Plan: game-night

Started from the Devpost Win Board on 2026-10-21.

## Hackathon

[Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/) · Aug 31 - Oct 23, 2026 · $138,000 cash

- **who can enter:** Above legal age of majority in country of residence All countries/territories, excluding standard exceptions
- **what they want:** Build or significantly update a functional application across Fire TV (Fire OS/Vega OS), Alexa+ (MCP server or Agent Skill), Bee wearable AI, or Ring APIs/simulators, submitting a video demo under 3 minutes, public or shared GitHub repo, and structured developer feedback.
- **must use:** At least one primary Amazon platform: Fire OS/Vega OS, Alexa+ MCP server (Streamable HTTP, 2025-11-25+ spec) or Agent Skill, Bee CLI/MCP/Agent Skill with live data, or Ring API/SDK/simulator. (Optional mini-challenges: AWS Bedrock/AgentCore/Kiro, or Open Source contribution).
- **prize tracks:** Fire TV Track ($25k/$15k/$4k), Alexa+ Track ($25k/$15k/$4k), Bee Track ($12k/$8k), Ring Track ($12k/$8k), AWS Builder Mini ($5k), Open Source Mini ($5k).
- **judging:** Tech Implementation (effective use of required APIs/devices), Design (complete UX for target platform), Potential Impact (solving real customer needs), Quality of the Idea (creative/non-obvious), plus up to a 10% bonus for developer friction logs.
- **verdict:** Worth entering for an intense 48-hour sprint targeting the Alexa+ MCP track ($25k) with an AWS Bedrock mini-challenge ($5k) and friction logs (10% bonus); open globally with no student/in-person limits, and despite 60k signups, very few will submit a spec-compliant MCP server.

## The idea

- **pitch:** A voice game hub for Alexa+: one Streamable HTTP MCP server that keeps each game's secrets and rules, while Alexa+ improvises the story. Flagship game: Whodunnit at Home, a murder mystery set in the rooms of your own house. Second game: Twenty Questions where the answer is locked on the server, so Alexa can't change it mid-game.
- **why it wins:** Old Alexa games are scripted skills, and I found no games built for Alexa+ or as MCP servers. Because the server holds the hidden state, the AI can't cheat or forget, which is a clear 'why MCP' story for Tech Implementation and Quality of the Idea in front of Alexa's Chief Evangelist and solutions architects. A hub with one shared game interface makes it read as a platform, not a one-off (Design). Pitched as screen-free family game night, a real audience Alexa already serves (Potential Impact). Bedrock for clue and story generation adds the AWS Builder mini-challenge, and a friction log adds up to a 10% bonus.
- **demo moment:** 'Alexa, open Game Night.' 'Two games tonight: a mystery, or twenty questions.' 'Mystery.' Alexa casts the family's actual kitchen, garage and attic as crime scenes. 'Search the kitchen.' 'Behind the toaster: a torn train ticket, dated last night.' 'Interrogate the butler.' 'I accuse Aunt Vera.' Dramatic reveal. Cut to a 15-second round of Twenty Questions to show the hub.
- **stack:** TypeScript MCP SDK (Streamable HTTP, spec 2025-11-25+), Bun, SQLite for game state, AWS Bedrock (current Claude model) for case and clue generation, Alexa+ MCP integration, with the simulated Alexa+ web app as a fallback
- **build days:** 2
- **win odds:** High
