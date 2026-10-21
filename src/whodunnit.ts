import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { load, save, reply, type Game } from './hub';
import { askJson } from './llm';

const ID = 'whodunnit';

const Clue = z.object({ room: z.string(), text: z.string(), implicates: z.string().optional(), clears: z.string().optional() });
export const CaseSchema = z.object({
  victim: z.object({ name: z.string(), description: z.string() }),
  suspects: z.array(z.object({ name: z.string(), role: z.string(), description: z.string(), alibi: z.string(), statement: z.string() })),
  killer: z.string(),
  motive: z.string(),
  weapon: z.string(),
  clues: z.array(Clue),
  intro: z.string(),
  solution: z.string(),
});
export type Case = z.infer<typeof CaseSchema>;

interface State {
  rooms: string[];
  players: string[];
  case: Case;
  found: number[]; // indexes of clues already found
  wrong: string[]; // wrongly accused suspects
  over: boolean;
}
const MAX_WRONG = 3;

// ---- validation ----

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function validateCase(c: Case, rooms: string[]): string[] {
  const problems: string[] = [];
  const names = c.suspects.map((s) => s.name);
  if (c.suspects.length < 3 || c.suspects.length > 5) problems.push('need 3 to 5 suspects');
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) problems.push('suspect names must be unique');
  const killer = names.find((n) => same(n, c.killer));
  if (!killer) problems.push('killer is not a suspect');
  if (names.some((n) => same(n, c.victim.name))) problems.push('the victim is a suspect');
  for (const cl of c.clues) {
    for (const who of [cl.implicates, cl.clears]) if (who && !names.some((n) => same(n, who))) problems.push(`clue names unknown suspect ${who}`);
    if (!rooms.some((r) => same(r, cl.room))) problems.push(`clue in unknown room ${cl.room}`);
    if (cl.implicates && cl.clears) problems.push('a clue both implicates and clears');
  }
  for (const r of rooms) if (!c.clues.some((cl) => same(cl.room, r))) problems.push(`no clue in ${r}`);
  if (killer) {
    if (c.clues.filter((cl) => cl.implicates && same(cl.implicates, killer)).length < 2) problems.push('killer needs 2 implicating clues');
    if (c.clues.some((cl) => cl.clears && same(cl.clears, killer))) problems.push('killer is cleared');
  }
  for (const p of c.suspects) {
    const others = c.suspects.filter((o) => o !== p).flatMap((o) => suspectKeys(o).map(norm));
    if (suspectKeys(p).map(norm).some((k) => others.includes(k))) problems.push(`${p.name} is confused with another suspect`);
    for (const secret of [c.weapon, c.motive]) {
      const t = norm(secret);
      if (t.length >= 4 && [c.intro, p.statement, p.alibi].some((x) => norm(x).includes(t))) problems.push(`${p.name} or the intro gives away the weapon or motive`);
    }
  }
  for (const n of names) {
    if (killer && same(n, killer)) continue;
    if (!c.clues.some((cl) => cl.clears && same(cl.clears, n))) problems.push(`${n} is never cleared`);
  }
  return problems;
}

// ---- built-in fallback cases (used when Bedrock is off, fails, or returns an invalid case) ----

type Template = Omit<Case, 'clues'> & { clues: Omit<z.infer<typeof Clue>, 'room'>[] };

const FALLBACKS: Template[] = [
  {
    victim: { name: 'Pemberton Crumb', description: 'a famous cheese collector who loved a good party' },
    suspects: [
      { name: 'Vera Lindqvist', role: 'the neighbour', description: 'a neighbour who borrows everything and returns nothing', alibi: 'I was on the bus across town.', statement: 'Me? I was riding the bus all evening. Ask the driver, he knows my face.' },
      { name: 'Otis Marlowe', role: 'the gardener', description: 'a gardener who talks to his tomatoes', alibi: 'I was out in the garden.', statement: 'I was in the garden with my tomatoes, as always. They never gossip.' },
      { name: 'Delphine Oak', role: 'the cousin', description: 'a cousin with a lavender scarf and a sweet smile', alibi: 'I was reading in an armchair.', statement: 'Oh, I was reading in an armchair all evening. Such a shame about poor Pemberton.' },
      { name: 'Gus Fennimore', role: 'the chef', description: 'a chef who guards his whisk like a sword', alibi: 'I was cooking for the party.', statement: 'I was in the kitchen whisking cream. A chef never leaves his cream.' },
    ],
    killer: 'Delphine Oak',
    motive: 'she wanted the secret family cheese recipe for herself',
    weapon: 'a heavy marble rolling pin',
    intro: 'Tonight the grand house was full of laughter, until Pemberton Crumb was found on the floor of the {room}, never to taste cheese again. A heavy object did the deed, and the culprit is still in the house.',
    solution: 'Delphine Oak did it. Her lavender scarf and her heart slippers put her at the scene, and the torn recipe note shows why. She wanted the secret cheese recipe, and she used the marble rolling pin.',
    clues: [
      { text: 'A torn scrap of lavender scarf is caught on a door hinge.', implicates: 'Delphine Oak' },
      { text: 'The gardening log is signed by Otis at the exact time of the crime. He was far away.', clears: 'Otis Marlowe' },
      { text: 'A dusty footprint with a tiny heart on the heel. Someone wears heart slippers.', implicates: 'Delphine Oak' },
      { text: 'Twelve guests saw Gus whisking cream at the very moment of the crime.', clears: 'Gus Fennimore' },
      { text: 'An answering machine message proves Vera was calling from a bus stop across town.', clears: 'Vera Lindqvist' },
      { text: 'A half written note about the secret family recipe, in Delphine\'s curly handwriting.', implicates: 'Delphine Oak' },
      { text: 'A trail of crumbs leads nowhere. Someone has been sneaking cookies.' },
      { text: 'A single striped sock. Nobody will admit it is theirs.' },
    ],
  },
  {
    victim: { name: 'Captain Alfie Bramble', description: 'a retired balloon pilot with a magnificent moustache' },
    suspects: [
      { name: 'Nora Quill', role: 'the librarian', description: 'a librarian who shushes everyone, even the cat', alibi: 'I was returning books in town.', statement: 'Shh. I was at the library in town, returning books. I always return my books.' },
      { name: 'Fitz Hargrove', role: 'the butler', description: 'a butler who polishes everything, twice', alibi: 'I was dusting the hallway.', statement: 'I was dusting the hallway, sir. Nothing else, I assure you.' },
      { name: 'Juniper Vale', role: 'the niece', description: 'a niece who dances through every room', alibi: 'I was at my dance class.', statement: 'I was at dance class, spinning like a top. Twenty people can tell you.' },
      { name: 'Wilf Tuck', role: 'the postman', description: 'a postman with a very squeaky bicycle', alibi: 'I was delivering parcels.', statement: 'I was out on my round with the parcels. Rain or shine, that is me.' },
    ],
    killer: 'Fitz Hargrove',
    motive: 'he was jealous that the Captain won the balloon race with a map Fitz had drawn',
    weapon: 'a heavy brass telescope',
    intro: 'The Captain once flew a balloon over seven villages. Tonight Captain Alfie Bramble was found on the floor of the {room}, and his flying days are over. A heavy object did the deed, and the culprit is still in the house.',
    solution: 'Fitz Hargrove did it. The polished white glove, the torn map corner in his coat and the dusted shelf give him away. He was jealous about the balloon race map, and he used the brass telescope.',
    clues: [
      { text: 'A white glove smudged with brass polish lies behind a cushion.', implicates: 'Fitz Hargrove' },
      { text: 'A library stamp proves Nora returned her books in town at the time of the crime.', clears: 'Nora Quill' },
      { text: 'The Captain\'s map has a torn corner. The missing piece sits in a coat pocket marked F. H.', implicates: 'Fitz Hargrove' },
      { text: 'A phone photo timestamp shows Juniper at dance class, with twenty witnesses.', clears: 'Juniper Vale' },
      { text: 'The postal van tracker shows Wilf stuck behind a tractor on the far side of the village.', clears: 'Wilf Tuck' },
      { text: 'A shelf has been wiped spotless, leaving a clean ring where something heavy stood. A feather duster nearby is tagged F. H.', implicates: 'Fitz Hargrove' },
      { text: 'A squeaky bicycle bell lies in the flowerbed, but nobody heard it ring last night.' },
      { text: 'A pie is missing one slice. The fork is still warm.' },
    ],
  },
];

const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

// Clue i goes to room i mod rooms. All templates have 8 clues, so every room (2 to 8) gets one.
export function fallbackCase(rooms: string[]): Case {
  const t = FALLBACKS[hash(rooms.map((r) => r.toLowerCase()).join('|')) % FALLBACKS.length]!;
  return { ...t, intro: t.intro.replace('{room}', rooms[0]!), clues: t.clues.map((cl, i) => ({ ...cl, room: rooms[i % rooms.length]! })) };
}

// ---- generation ----

const SYSTEM = `You write a cozy, family-friendly murder mystery for a voice game played by a family with kids aged 8 and up.
No gore, no scary detail, board-game tone, a light touch of humour. The victim is found "gone" or "on the floor"; keep it gentle.
Rules, all mandatory:
- 3 to 5 suspects with unique names and a short role like "the gardener". The description is one short phrase that reads naturally after the name, such as "a librarian who shushes everyone", and is spoken as "name, description". The killer is exactly one of them (use the exact same name in "killer").
- Use the exact room names given. Every room must contain at least one clue. Use several clues per room if needed. Red herrings (clues with no implicates and no clears) are allowed.
- The killer is implicated (field "implicates" = the killer's name) by at least 2 clues and is never cleared.
- Every innocent suspect is cleared (field "clears" = their name) by at least 1 clue. A clue never both implicates and clears.
- Clue texts are physical evidence, one or two short sentences. They may point to the killer through evidence but never name the killer, motive or weapon outright.
- Each suspect has an "alibi" and a "statement" (1 to 2 sentences, in character; the statement already states the alibi, so do not repeat it). The killer's statement must be a lie that the clues contradict, but must not confess or hint at guilt. Innocent suspects sound equally suspicious.
- "intro" is the spoken opening narration (3 sentences max) and must not reveal the killer. "solution" is the spoken reveal (3 to 4 sentences) explaining how the clues fit, with motive and weapon.
- Everything is spoken aloud: short plain sentences, no markdown, no lists, no emoji.`;

async function makeCase(rooms: string[], players: string[]): Promise<Case> {
  let prompt = `Rooms of the family's house: ${rooms.join(', ')}.${players.length ? ` The detectives are: ${players.join(', ')}. They are not suspects.` : ''} Write the case.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const generated = await askJson(SYSTEM, prompt, CaseSchema);
    if (!generated) break;
    const problems = validateCase(generated, rooms);
    if (!problems.length) return generated;
    console.error('[whodunnit] generated case rejected:', problems.join('; '));
    prompt += ` Your previous attempt was rejected for these problems, fix them: ${problems.join('; ')}.`;
  }
  return fallbackCase(rooms);
}

// ---- tools ----

const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b(the|a|an|my|our|in|into|to)\b/g, ' ').replace(/\s+/g, ' ').trim();
const hasWords = (hay: string, needle: string) => ` ${hay} `.includes(` ${needle} `);
const suspectKeys = (x: Case['suspects'][number]) => [x.name, ...x.name.split(' '), x.role];

// Exact normalized match first, then whole-word match (so "room" never matches "bathroom").
function fuzzy<T>(items: T[], query: string, keys: (item: T) => string[]): T | undefined {
  const q = norm(query);
  if (!q) return undefined;
  const cands = items.map((item) => ({ item, keys: keys(item).map(norm).filter(Boolean) }));
  return (
    cands.find((c) => c.keys.includes(q))?.item ??
    cands.find((c) => c.keys.some((k) => hasWords(k, q) || hasWords(q, k)))?.item
  );
}

const NO_CASE = () =>
  reply('There is no mystery yet. Tell me the names of the rooms in your house, and I will set a case.', 'Ask the family for their room names (2 to 8), then call start_case.');
const CLOSED = () =>
  reply('This case is closed. Want a new mystery? Tell me the rooms of your house.', 'Offer a new case; call start_case with their room names.');

// Run a tool body only when a case is in progress.
function withCase<A>(f: (s: State, a: A) => ReturnType<typeof reply>) {
  return (a: A) => {
    const s = load<State>(ID);
    return !s ? NO_CASE() : s.over ? CLOSED() : f(s, a);
  };
}

const roomClues = (s: State, room: string) => s.case.clues.map((cl, i) => ({ cl, i })).filter((x) => same(x.cl.room, room));

export const tools = {
  async start_case({ rooms, players }: { rooms: string[]; players?: string[] }) {
    const stripped = rooms.map((r) => r.trim().replace(/^(the|a|an|my|our)\s+/i, '')).filter(Boolean);
    const clean = stripped.filter((r, i) => stripped.findIndex((o) => norm(o) === norm(r)) === i);
    if (clean.length < 2) return reply('I need at least two different rooms to hide clues in. Which rooms does your house have?');
    const c = await makeCase(clean, players ?? []);
    save(ID, { rooms: clean, players: players ?? [], case: c, found: [], wrong: [], over: false } satisfies State);
    const suspects = c.suspects.map((p) => `${p.name}, ${p.description}.`).join(' ');
    const detectives = players?.length ? `Tonight's detectives are ${list(players)}. ` : '';
    return reply(
      `${detectives}${c.intro} The victim is ${c.victim.name}, ${c.victim.description}. The suspects are: ${suspects} You can search ${list(clean)}. Where shall we look first, or who shall we question?`,
      'Narrate dramatically but briefly, in your own words. Name the suspects and rooms, then ask which room to search or who to interrogate. Never guess the culprit.',
    );
  },

  search_room: withCase<{ room: string }>((s, { room }) => {
    const r = fuzzy(s.rooms, room, (x) => [x]);
    if (!r) return reply(`I do not know a room called ${room}. You can search ${list(s.rooms)}. Which one?`);
    const here = roomClues(s, r);
    const fresh = here.filter((x) => !s.found.includes(x.i));
    if (!fresh.length) {
      return reply(`There is nothing new in the ${r}. Earlier you found: ${here.map((x) => x.cl.text).join(' ')} Where next?`, 'Keep it to one sentence, then offer another room or suspect.');
    }
    const found = [...s.found, ...fresh.map((x) => x.i)];
    save(ID, { ...s, found });
    const left = s.rooms.filter((x) => roomClues(s, x).some((y) => !found.includes(y.i)));
    return reply(
      `You search the ${r} and find: ${fresh.map((x) => x.cl.text).join(' ')}${left.length ? ` Still unsearched: ${list(left)}.` : ' Every room has been searched.'}`,
      'Retell the clue dramatically in a sentence or two, then ask what to do next: search another room, interrogate a suspect, or make an accusation. Do not interpret the clue for them.',
    );
  }),

  interrogate: withCase<{ suspect: string }>((s, { suspect }) => {
    const p = fuzzy(s.case.suspects, suspect, suspectKeys);
    if (!p) return reply(`I do not know a suspect called ${suspect}. The suspects are ${list(s.case.suspects.map((x) => x.name))}. Who shall we question?`);
    return reply(
      `You question ${p.name}. ${p.statement}`,
      'Voice the suspect in character, briefly. Do not hint at guilt. Then ask who to question next, which room to search, or whether they are ready to accuse.',
    );
  }),

  case_status: withCase<unknown>((s) => {
    const searched = s.rooms.filter((r) => roomClues(s, r).every((x) => s.found.includes(x.i)));
    const unsearched = s.rooms.filter((r) => !searched.includes(r));
    const clues = s.found.map((i) => s.case.clues[i]!.text).join(' ');
    return reply(
      `Rooms searched: ${searched.length ? list(searched) : 'none yet'}. Still to search: ${unsearched.length ? list(unsearched) : 'nothing'}. ${clues ? `Clues so far: ${clues}` : 'No clues yet.'} Suspects: ${list(s.case.suspects.map((x) => x.name))}. You have ${MAX_WRONG - s.wrong.length} accusations left.`,
      'Summarise the clues in a sentence or two rather than reading them all out, then ask what to do next.',
    );
  }),

  accuse: withCase<{ suspect: string }>((s, { suspect }) => {
    const p = fuzzy(s.case.suspects, suspect, suspectKeys);
    if (!p) return reply(`I do not know a suspect called ${suspect}. The suspects are ${list(s.case.suspects.map((x) => x.name))}. Who do you accuse?`);
    const c = s.case;
    const reveal = `The killer is ${c.killer}. The motive: ${c.motive}. The weapon: ${c.weapon}. ${c.solution}`;
    if (same(p.name, c.killer)) {
      save(ID, { ...s, over: true });
      return reply(`Correct! ${p.name} did it! ${reveal} Case solved. Want a new mystery?`, 'Celebrate with the family, then offer a new case.');
    }
    const wrong = [...s.wrong, p.name];
    if (wrong.length >= MAX_WRONG) {
      save(ID, { ...s, wrong, over: true });
      return reply(`${p.name} is innocent. That was your last accusation, and the culprit gets away. ${reveal} Want to try a new mystery?`, 'Be gracious and playful about the loss, then offer a new case.');
    }
    const proofAt = c.clues.findIndex((cl) => cl.clears && same(cl.clears, p.name));
    const proof = c.clues[proofAt];
    save(ID, { ...s, wrong, found: proofAt < 0 || s.found.includes(proofAt) ? s.found : [...s.found, proofAt] });
    return reply(
      `${p.name} is innocent!${proof ? ` Remember this: ${proof.text}` : ''} You have ${MAX_WRONG - wrong.length} accusations left. Keep investigating.`,
      'Be dramatic but encouraging. Do not say who the real killer is.',
    );
  }),
};

const CONTEXT = 'Never guess, hint at, or reveal the culprit, motive or weapon yourself: only the accuse tool reveals the solution.';
const SPOKEN = 'Narrate the result briefly and dramatically in short spoken sentences, then end by asking the family what to do next.';

export const whodunnit: Game = {
  id: ID,
  title: 'Whodunnit at Home',
  pitch: 'A cozy murder mystery set in the real rooms of your own house, where the family plays detective.',
  startTool: 'start_case',
  status() {
    const s = load<State>(ID);
    if (!s || s.over) return null;
    const left = s.rooms.filter((r) => roomClues(s, r).some((x) => !s.found.includes(x.i))).length;
    return left ? `there's a mystery in progress with ${left} ${left === 1 ? 'room' : 'rooms'} left to search` : "there's a mystery in progress and every room has been searched";
  },
  register(server: McpServer) {
    server.registerTool(
      'start_case',
      {
        title: 'Start a mystery',
        description: `Start a new cozy murder mystery set in the family's own house (replaces any current case). If list_games or the hub says a mystery is already in progress, confirm with the family before starting a new one, since it replaces the current case. Call when the family wants to play Whodunnit or a murder mystery, e.g. "let's play whodunnit", "start a mystery", "another case". If they have not told you the names of the rooms in their house, ASK them first (for example "kitchen, living room, garage, bedroom"); do not invent rooms. Pass rooms (2 to 8 names, as the family says them) and optionally players (the detectives' names). The result is the opening story with the victim, the suspects and the rooms. ${SPOKEN} Ask which room to search or who to question. ${CONTEXT}`,
        inputSchema: z.object({
          rooms: z.array(z.string()).min(2).max(8).describe('Names of real rooms in the house, 2 to 8'),
          players: z.array(z.string()).optional().describe('Names of the people playing (the detectives)'),
        }),
      },
      tools.start_case,
    );
    server.registerTool(
      'search_room',
      {
        title: 'Search a room',
        description: `Search one room of the house for clues. Call when the family says things like "search the kitchen", "let's look in the garage", "check the bedroom". Pass the room as the family said it. The result contains the clue found there (or says nothing new). ${SPOKEN} Do not interpret the clue or say who did it. ${CONTEXT}`,
        inputSchema: z.object({ room: z.string().describe('The room to search, e.g. "kitchen"') }),
      },
      tools.search_room,
    );
    server.registerTool(
      'interrogate',
      {
        title: 'Question a suspect',
        description: `Question one suspect. Call when the family says "let's question Aunt Vera", "interrogate the gardener", "ask the butler where he was". Pass the suspect's first name, last name or role. The result is what the suspect says; voice them in character. They never confess. ${SPOKEN} ${CONTEXT}`,
        inputSchema: z.object({ suspect: z.string().describe('Suspect name or role, e.g. "Vera" or "the gardener"') }),
      },
      tools.interrogate,
    );
    server.registerTool(
      'case_status',
      {
        title: 'Case status',
        description: `Recap the case: rooms searched and still to search, clues found so far, the suspects and how many accusations are left. Call when the family asks "what do we know?", "where are we?", "what clues do we have?" or seems lost. ${SPOKEN} ${CONTEXT}`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      tools.case_status,
    );
    server.registerTool(
      'accuse',
      {
        title: 'Accuse a suspect',
        description: `Make a final accusation. Call only when the family clearly names who they think did it, e.g. "I think it was the gardener", "we accuse Delphine". Never call it to guess for them, and ask for confirmation if they only speculate. The family has 3 accusations. A wrong one tells them the suspect is innocent; the right one, or the third wrong one, ends the case and reveals the killer, motive and weapon. This is the only tool that reveals the solution; never reveal it yourself. ${SPOKEN}`,
        inputSchema: z.object({ suspect: z.string().describe('The accused suspect, by name or role') }),
      },
      tools.accuse,
    );
  },
};
