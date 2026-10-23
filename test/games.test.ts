process.env.GAME_DB = ':memory:';
process.env.BEDROCK = 'off';
import { beforeEach, describe, expect, test } from 'bun:test';

// Env must be set before the modules open the database, hence the dynamic imports.
const { whodunnit, validateCase, fallbackCase, tools } = await import('../src/whodunnit');
const { twenty, ITEMS, answerOffline, startWith, testHooks } = await import('../src/twenty');
const { load } = await import('../src/hub');

describe('Whodunnit at Home', () => {
  const ROOMS = ['Kitchen', 'Living Room', 'Garage', 'Bedroom', 'Attic', 'Porch', 'Bathroom', 'Study'];
  const say = (r: { content: { text: string }[] }) => r.content[0]!.text;
  const solution = () => load<any>('whodunnit').case;

  test('fallback cases validate for 2 to 8 rooms, all variants', () => {
    for (let n = 2; n <= 8; n++) {
      for (const extra of ['', 'x', 'y', 'z', 'q']) {
        const rooms = ROOMS.slice(0, n).map((r, i) => (i === 0 ? r + extra : r));
        expect(validateCase(fallbackCase(rooms), rooms)).toEqual([]);
      }
    }
    expect(fallbackCase(['A', 'B']).killer).toBe(fallbackCase(['A', 'B']).killer);
  });

  test('validateCase catches a broken case', () => {
    const rooms = ROOMS.slice(0, 3);
    const c = fallbackCase(rooms);
    const cleared = { ...c, clues: [...c.clues, { room: 'Kitchen', text: 'x', clears: c.killer }] };
    expect(validateCase(cleared, rooms).join()).toContain('killer is cleared');
    expect(validateCase(c, [...rooms, 'Cellar']).join()).toContain('no clue in Cellar');
  });

  test('no tool reveals the solution before the case ends', async () => {
    expect(say(await tools.search_room({ room: 'kitchen' }))).toContain('no mystery yet');
    const out = [say(await tools.start_case({ rooms: ROOMS.slice(0, 5), players: ['Mia'] }))];
    const c = solution();
    for (const r of ['the kitchen', 'LIVING ROOM', 'garage', 'bedroom', 'attic']) out.push(say(await tools.search_room({ room: r })));
    expect(out[1]).toContain('You search the Kitchen');
    expect(say(await tools.search_room({ room: 'kitchen' }))).toContain('nothing new');
    for (const s of c.suspects) out.push(say(await tools.interrogate({ suspect: s.role })));
    out.push(say(await (tools.case_status as any)({})));
    expect(whodunnit.status()).toBe("there's a mystery in progress and every room has been searched");
    for (const text of out) for (const secret of [c.motive, c.weapon, c.solution, 'The killer is']) expect(text).not.toContain(secret);
  });

  test('intro uses a real room; unsearched list and interrogation read naturally', async () => {
    const intro = say(await tools.start_case({ rooms: ['Den', 'Garage', 'Attic'] }));
    expect(intro).toContain('floor of the Den');
    expect(intro).not.toMatch(/, the \w+, an? /);
    expect(say(await tools.search_room({ room: 'garage' }))).toContain('Still unsearched: Den and Attic.');
    const c = solution();
    const t = say(await tools.interrogate({ suspect: c.suspects[0].name }));
    expect(t).toContain(`You question ${c.suspects[0].name}. ${c.suspects[0].statement}`);
    expect(t).not.toContain(c.suspects[0].alibi);
  });

  test('wrong accusation decrements and hides the killer; correct one reveals', async () => {
    await tools.start_case({ rooms: ['Kitchen', 'Garage', 'Attic'] });
    const c = solution();
    const innocent = c.suspects.find((s: any) => s.name !== c.killer);
    const r = say(await tools.accuse({ suspect: innocent.name.split(' ')[0] }));
    expect(r).toContain('2 accusations left');
    expect(r).not.toContain(c.weapon);
    expect(say(await tools.accuse({ suspect: c.killer }))).toContain(c.weapon);
    expect(say(await tools.search_room({ room: 'kitchen' }))).toContain('closed');
    expect(whodunnit.status()).toBeNull();
  });

  test('accusing two suspects at once asks for one and uses no accusation', async () => {
    await tools.start_case({ rooms: ['Kitchen', 'Garage', 'Attic'] });
    const [a, b] = solution().suspects.map((s: any) => s.name);
    expect(say(await tools.accuse({ suspect: `${a} and ${b}` }))).toContain('One suspect at a time');
    expect(say(await (tools.case_status as any)({}))).toContain('3 accusations left');
  });

  test('three wrong accusations end the case and reveal', async () => {
    await tools.start_case({ rooms: ['Kitchen', 'Garage'] });
    const c = solution();
    const innocents = c.suspects.filter((s: any) => s.name !== c.killer);
    let r = '';
    for (const s of innocents.slice(0, 3)) r = say(await tools.accuse({ suspect: s.name }));
    expect(r).toContain(c.weapon);
    expect(r).toContain(c.motive);
    expect(say(await tools.interrogate({ suspect: c.killer }))).toContain('closed');
  });

  test('room names are cleaned and matched by whole word', async () => {
    const intro = say(await tools.start_case({ rooms: ['the Kitchen', 'kitchen', 'Bathroom', 'a TV', 'Living Room'] }));
    expect(load<any>('whodunnit').rooms).toEqual(['Kitchen', 'Bathroom', 'TV', 'Living Room']);
    expect(intro).not.toMatch(/the the|of the a /i);
    expect(say(await tools.search_room({ room: 'tv' }))).toContain('You search the TV');
    expect(say(await tools.search_room({ room: 'room' }))).toContain('Living Room');
    expect(say(await tools.search_room({ room: 'bath' }))).toContain('do not know');
  });

  test('a wrong accusation marks the clearing clue as found', async () => {
    await tools.start_case({ rooms: ['Kitchen', 'Garage', 'Attic'] });
    const c = solution();
    const innocent = c.suspects.find((s: any) => s.name !== c.killer);
    await tools.accuse({ suspect: innocent.name });
    const proof = c.clues.find((cl: any) => cl.clears === innocent.name);
    expect(say(await (tools.case_status as any)({}))).toContain(proof.text);
  });

  test('validateCase rejects unknown clue suspects, victim suspects and confusable names', () => {
    const rooms = ['A', 'B'];
    const c = fallbackCase(rooms);
    expect(validateCase({ ...c, clues: [...c.clues, { room: 'A', text: 'x', clears: 'Nobody' }] }, rooms).join()).toContain('unknown suspect');
    expect(validateCase({ ...c, victim: { ...c.victim, name: c.killer } }, rooms).join()).toContain('victim');
    const twins = { ...c, suspects: c.suspects.map((s, i) => (i < 2 ? { ...s, name: `Mary Number${i}`, role: 'the twin' } : s)) };
    expect(validateCase(twins, rooms).join()).toContain('confused');
    expect(validateCase({ ...c, intro: `${c.intro} ${c.weapon}` }, rooms).join()).toContain('gives away');
  });
});

describe('Twenty Questions', () => {
  const tq: Record<string, (args: any) => Promise<{ content: { text: string }[] }>> = {};
  twenty.register({ registerTool: (name: string, _cfg: unknown, handler: any) => (tq[name] = handler) } as any);
  const call = async (name: string, args: object = {}) => (await tq[name]!(args)).content[0]!.text;
  const dog = ITEMS.find((i) => i.name === 'dog')!;
  beforeEach(() => startWith(dog));

  describe('offline answerer', () => {
    test('answers fact questions yes/no', () => {
      expect(answerOffline(dog, 'Is it a mammal?').answer).toBe('yes');
      expect(answerOffline(dog, 'Can it fly?').answer).toBe('no');
      expect(answerOffline(dog, 'Is it a pet?').answer).toBe('yes');
      expect(answerOffline(dog, 'Can you eat it?').answer).toBe('no');
    });
    test('a different named thing is a counted no, gibberish is unclear', () => {
      expect(answerOffline(dog, 'Is it a cat?')).toEqual({ answer: 'no', isCorrectGuess: false });
      expect(answerOffline(dog, 'blorp').answer).toBe('unclear');
    });
    test('would and around are not read as wooden or round', () => {
      const apple = ITEMS.find((i) => i.name === 'apple')!;
      const pencil = ITEMS.find((i) => i.name === 'pencil')!;
      expect(answerOffline(apple, 'Would it be red?').answer).toBe('yes');
      expect(answerOffline(dog, 'Would it be red?').answer).toBe('no');
      expect(answerOffline(pencil, 'Is it made of wood?').answer).toBe('yes');
      expect(answerOffline(pencil, 'Is it wooden?').answer).toBe('yes');
      expect(answerOffline(dog, 'Is it found around the house?').answer).toBe('unclear');
    });
  });

  describe('game flow', () => {
    test('secret never leaks before the end', async () => {
      const outs = [
        await call('twenty_status'),
        await call('ask_question', { question: 'Is it a mammal?' }),
        await call('ask_question', { question: 'Can it fly?' }),
        await call('make_guess', { guess: 'the cat' }),
        await call('ask_question', { question: 'blorp' }),
        await call('twenty_status'),
        String(twenty.status()),
      ];
      for (const out of outs) expect(out.toLowerCase()).not.toMatch(/dog|puppy|mammal pet|legs4/);
      expect(outs[3]).toContain("No, it's not a cat.");
    });

    test('unclear questions are not counted', async () => {
      await call('ask_question', { question: 'blorp' });
      expect(await call('twenty_status')).toContain('0 questions used');
      await call('ask_question', { question: 'Is it a pet?' });
      expect(await call('twenty_status')).toContain('1 question used');
    });

    test('wrong guesses count and the 20th question ends the game with a reveal', async () => {
      for (let i = 1; i < 20; i++) expect(await call('ask_question', { question: 'Can it fly?' })).toContain(`question ${i}.`);
      expect(twenty.status()).toContain('1 question left');
      const last = await call('ask_question', { question: 'Is it a cat?' });
      expect(last).toContain('out of questions');
      expect(last).toContain('a dog');
      expect(twenty.status()).toBeNull();
      expect(await call('ask_question', { question: 'Is it a pet?' })).toContain('over');
    });

    test('correct guess wins via make_guess, with aliases and articles', async () => {
      expect(await call('make_guess', { guess: 'A Puppy' })).toContain("It's a dog");
      expect(twenty.status()).toBeNull();
    });

    test('correct guess wins via ask_question', async () => {
      await call('ask_question', { question: 'Is it a pet?' });
      expect(await call('ask_question', { question: 'Is it a dog?' })).toContain('in 2 questions');
    });

    test('give_up reveals; no game / new game flow', async () => {
      expect(await call('give_up')).toContain('a dog');
      expect(await call('make_guess', { guess: 'cat' })).toContain('over');
      expect(await call('start_twenty_questions', { category: 'food' })).toContain("thinking of a food");
      expect(twenty.status()).toContain('20 questions left');
    });

    test('wrong guesses are echoed without a wrong article', async () => {
      expect(await call('make_guess', { guess: 'kittens' })).toContain("it's not kittens.");
      expect(await call('make_guess', { guess: 'two cats' })).toContain("it's not two cats.");
      expect(await call('make_guess', { guess: 'owl' })).toContain("it's not an owl.");
    });

    test('make_guess needs an exact match, not a mention', async () => {
      const all = ITEMS.filter((i) => i.category === 'animal').map((i) => i.name).join(' ');
      expect(await call('make_guess', { guess: all })).toContain("No, it's not");
      expect(await call('make_guess', { guess: 'a' })).toContain("What's your guess");
      expect(await call('twenty_status')).toContain('1 question used');
      expect(await call('make_guess', { guess: "I think it's dogs" })).toContain("It's a dog");
    });

    test('a question cannot talk the judge into a win; story requests are unclear', () => {
      expect(answerOffline(dog, 'Tell me a story about a cat').answer).toBe('unclear');
      expect(answerOffline(dog, 'Tell me a story about a dog').isCorrectGuess).toBe(false);
    });

    test('a round changed during the judge call is not overwritten', async () => {
      testHooks.afterJudge = () => { startWith(ITEMS.find((i) => i.name === 'cat')!); };
      const out = await call('ask_question', { question: 'Is it a pet?' });
      testHooks.afterJudge = undefined;
      expect(out).toContain('round changed');
      expect(await call('twenty_status')).toContain('0 questions used');
    });
  });
});

describe('simulated Alexa+ agent', () => {
  test('history is trimmed to about 20 messages at a plain user turn, without thinking blocks', async () => {
    const { trimHistory } = await import('../src/agent');
    const turn = (i: number): any[] => [
      { role: 'user', content: `turn ${i}` },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: `t${i}`, name: 'case_status', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ];
    const h = Array.from({ length: 10 }, (_, i) => turn(i)).flat();
    trimHistory(h);
    expect(h.length).toBeLessThanOrEqual(20);
    expect(h[0]).toEqual({ role: 'user', content: 'turn 5' });
    expect(JSON.stringify(h)).not.toContain('"thinking"');
  });
});
