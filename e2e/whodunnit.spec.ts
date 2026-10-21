import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Full Whodunnit playthrough. Offline fallback cases live in src/whodunnit.ts; the culprit is looked up
// from that data by matching which fallback case the opening narration belongs to (the case chosen
// depends on a hash of the room names, so nothing here is hardcoded to one case).
const SRC = readFileSync('src/whodunnit.ts', 'utf8');
const KILLERS = [...SRC.matchAll(/killer: '([^']+)'/g)].map((m) => m[1]!);
const SUSPECT_NAMES = [...SRC.matchAll(/\{ name: '([^']+)', role:/g)].map((m) => m[1]!);

const bots = (page: Page) => page.locator('.msg.bot');
async function say(page: Page, text: string) {
  const before = await bots(page).count();
  await page.getByLabel('Message').fill(text);
  await page.getByLabel('Message').press('Enter');
  await expect(bots(page)).toHaveCount(before + 1);
  return (await bots(page).last().evaluate((e) => e.firstChild?.textContent ?? '')) ?? '';
}

const ROOM_SETS = [
  ['kitchen', 'garage', 'bedroom'],
  ['attic', 'cellar', 'study', 'hallway'],
];

for (const rooms of ROOM_SETS) {
  test(`full playthrough with rooms ${rooms.join(', ')}: search all, interrogate, wrong accusation, right accusation`, async ({ page }) => {
    await page.goto('/');

    // 1. list games, then start the mystery by naming rooms
    expect(await say(page, 'what games are there')).toContain('Whodunnit at Home');
    const intro = await say(page, `start a mystery in the ${rooms.slice(0, -1).join(', the ')} and the ${rooms.at(-1)}`);
    await expect(bots(page).last().locator('summary')).toContainText('MCP: start_case');
    for (const r of rooms) expect(intro.toLowerCase()).toContain(r);

    const killer = KILLERS.find((k) => intro.includes(k));
    expect(killer, 'opening narration should name one of the fallback suspects').toBeTruthy();
    const suspects = SUSPECT_NAMES.filter((n) => intro.includes(n));
    expect(suspects.length).toBeGreaterThanOrEqual(3);
    const innocent = suspects.find((n) => n !== killer)!;
    await page.screenshot({ path: 'test-results/screens/03-whodunnit-intro.png' });

    // 2. search every room; each one yields a clue and the final one says everything is searched
    let last = '';
    for (const r of rooms) {
      last = await say(page, `search the ${r}`);
      expect(last).toContain(`You search the ${r}`);
      expect(last).toContain('find:');
    }
    expect(last).toContain('Every room has been searched');
    // searching again finds nothing new but repeats the earlier clue
    expect(await say(page, `search the ${rooms[0]}`)).toContain('nothing new');
    await page.screenshot({ path: 'test-results/screens/04-whodunnit-searched.png' });

    // 3. interrogate every suspect by first name; each gives a statement and none confesses
    for (const s of suspects) {
      const out = await say(page, `interrogate ${s.split(' ')[0]}`);
      expect(out).toContain(`You question ${s}`);
      expect(out.toLowerCase()).not.toMatch(/i did it|i confess|i killed/);
    }

    // 4. status recap
    const status = await say(page, 'what do we know so far');
    expect(status).toContain('Rooms searched');
    expect(status).toContain('3 accusations left');

    // 5. wrong accusation: told innocent, game continues, accusations drop
    const wrong = await say(page, `I accuse ${innocent}`);
    expect(wrong).toContain(`${innocent} is innocent`);
    expect(wrong).toContain('2 accusations left');
    expect(wrong).not.toContain(`The killer is ${killer}`);

    // 6. right accusation: reveal and case closed
    const right = await say(page, `I accuse ${killer}`);
    expect(right).toContain('Correct!');
    expect(right).toContain(`The killer is ${killer}`);
    expect(right).toContain('Case solved');
    await page.screenshot({ path: 'test-results/screens/05-whodunnit-solved.png' });

    // 7. after the end, more play is refused politely
    expect(await say(page, `search the ${rooms[0]}`)).toContain('This case is closed');
  });
}

test('three wrong accusations lose the game and reveal the culprit', async ({ page }) => {
  await page.goto('/');
  const intro = await say(page, 'start a mystery in the kitchen, garage and bedroom');
  const killer = KILLERS.find((k) => intro.includes(k))!;
  const innocents = SUSPECT_NAMES.filter((n) => intro.includes(n) && n !== killer);
  expect(innocents.length).toBeGreaterThanOrEqual(3);
  await say(page, `I accuse ${innocents[0]}`);
  await say(page, `I accuse ${innocents[1]}`);
  const last = await say(page, `I accuse ${innocents[2]}`);
  expect(last).toContain('last accusation');
  expect(last).toContain(`The killer is ${killer}`);
  expect(await say(page, 'what do we know')).toContain('case is closed');
});

test('accusing an unknown name or naming two suspects costs no accusation', async ({ page }) => {
  await page.goto('/');
  const intro = await say(page, 'start a mystery in the kitchen, garage and bedroom');
  const names = SUSPECT_NAMES.filter((n) => intro.includes(n));
  expect(await say(page, 'I accuse Zorblax the Unknowable')).toContain('I do not know a suspect');
  const two = await say(page, `I accuse ${names[0]!.split(' ')[0]} and ${names[1]!.split(' ')[0]}`);
  expect(two).toContain('One suspect at a time');
  expect(await say(page, 'what do we know')).toContain('3 accusations left');
});

test('searching a room that does not exist lists the real rooms', async ({ page }) => {
  await page.goto('/');
  await say(page, 'start a mystery in the kitchen, garage and bedroom');
  const out = await say(page, 'search the swimming pool');
  expect(out).toContain('I do not know a room called');
  expect(out).toContain('kitchen');
});

test('a mystery request with only one room asks for a second room', async ({ page }) => {
  await page.goto('/');
  expect(await say(page, 'play a mystery')).toContain('Which rooms');
  expect(await say(page, 'kitchen')).toContain('at least two rooms');
  const intro = await say(page, 'kitchen and garage');
  expect(intro).toContain('The victim is');
});

test('reloading mid-case keeps the case on the server so searching and recap still work', async ({ page }) => {
  await page.goto('/');
  await say(page, 'start a mystery in the kitchen, garage and bedroom');
  await say(page, 'search the kitchen');
  await page.reload();
  await expect(bots(page)).toHaveCount(0); // chat log is client-side only
  const status = await say(page, 'what do we know so far');
  expect(status).toContain('Clues so far');
  expect(await say(page, 'search the garage')).toContain('You search the garage');
});
