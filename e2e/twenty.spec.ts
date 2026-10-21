import { test, expect, type Page } from '@playwright/test';

// The secret is random, so the test plays like a person: it learns the category from the host's opening
// line, asks a few questions, makes a wrong guess, then wins by guessing through the category.
const CANDIDATES: Record<string, string[]> = {
  animal: ['dog', 'cat', 'elephant', 'penguin', 'giraffe', 'horse', 'cow', 'rabbit', 'shark', 'eagle', 'frog', 'lion', 'monkey', 'butterfly', 'duck'],
  food: ['apple', 'banana', 'pizza', 'cheese', 'ice cream', 'cookie', 'carrot', 'broccoli', 'egg', 'bread', 'strawberry', 'watermelon', 'popcorn', 'pancake', 'chocolate'],
  object: ['chair', 'book', 'ball', 'pencil', 'spoon', 'clock', 'phone', 'television', 'bicycle', 'umbrella', 'teddy bear', 'key', 'lamp', 'toothbrush', 'bed'],
};

const bots = (page: Page) => page.locator('.msg.bot');
async function say(page: Page, text: string) {
  const before = await bots(page).count();
  await page.getByLabel('Message').fill(text);
  await page.getByLabel('Message').press('Enter');
  await expect(bots(page)).toHaveCount(before + 1);
  return (await bots(page).last().evaluate((e) => e.firstChild?.textContent ?? '')) ?? '';
}
async function start(page: Page, category: string) {
  const intro = await say(page, `let's play twenty questions with ${category}s`);
  expect(intro).toContain(`I'm thinking of ${/^[aeiou]/.test(category) ? 'an' : 'a'} ${category}`);
  return intro;
}

test('full round: questions, wrong guess, then win by guessing', async ({ page }) => {
  await page.goto('/');
  await start(page, 'animal');
  await expect(bots(page).last().locator('summary')).toContainText('start_twenty_questions');

  const q1 = await say(page, 'Is it alive?');
  expect(q1).toMatch(/^Yes!/);
  expect(q1).toContain("question 1. You have 19 left");
  expect(await say(page, 'Is it a bird?')).toMatch(/^(Yes!|No\.)/);
  expect(await say(page, 'Is it wild?')).toMatch(/^(Yes!|No\.)/);

  const status = await say(page, 'status');
  expect(status).toContain('3 questions used, 17 left');

  // A clearly wrong guess: a chair is never an animal.
  const wrong = await say(page, 'my guess is chair');
  expect(wrong).toContain("No, it's not a chair");
  expect(wrong).toContain('question 4');
  await page.screenshot({ path: 'test-results/screens/06-twenty-midgame.png' });

  let won = '';
  for (const guess of CANDIDATES.animal!) {
    const out = await say(page, `my guess is ${guess}`);
    if (out.startsWith('Yes!')) { won = out; break; }
    expect(out).toMatch(/^No, it's not/);
  }
  expect(won).toMatch(/^Yes! It's an? .+! You got it in \d+ questions\./);
  await page.screenshot({ path: 'test-results/screens/07-twenty-won.png' });

  // the round is over: more questions are refused and the answer is repeated
  expect(await say(page, 'Is it a bird?')).toContain('That round is over');
});

test('giving up reveals the secret and ends the round', async ({ page }) => {
  await page.goto('/');
  await start(page, 'food');
  await say(page, 'Is it sweet?');
  const out = await say(page, 'we give up');
  expect(out).toMatch(/^OK! It was (an? )?[a-z ]+\. Want to play another round\?/);
  await expect(bots(page).last().locator('summary')).toContainText('give_up');
  await page.screenshot({ path: 'test-results/screens/08-twenty-gave-up.png' });
  expect(await say(page, 'Is it sweet?')).toContain('That round is over');
});

test('running out of twenty questions loses the round and reveals the answer', async ({ page }) => {
  await page.goto('/');
  await start(page, 'object');
  let last = '';
  for (let i = 1; i <= 20; i++) {
    last = await say(page, 'Is it electronic?');
    if (i < 20) expect(last).toContain(`question ${i}.`);
  }
  expect(last).toContain("you're out of questions");
  expect(last).toMatch(/The answer was (an? )?[a-z ]+\./);
});

test('a vague non-question is not counted against the twenty', async ({ page }) => {
  await page.goto('/');
  await start(page, 'animal');
  const out = await say(page, 'Is it zxqv?');
  expect(out).toContain("can't answer that one");
  expect(await say(page, 'status')).toContain('0 questions used, 20 left');
});

test('the secret never appears in the page while the round is in progress', async ({ page }) => {
  await page.goto('/');
  await start(page, 'animal');
  await say(page, 'Is it alive?');
  const html = (await page.locator('#log').innerText()).toLowerCase();
  const leaked = CANDIDATES.animal!.filter((a) => new RegExp(`\\b${a}\\b`).test(html));
  expect(leaked).toEqual([]);
});

test('reloading mid-round: questions keep working against the same server-side round', async ({ page }) => {
  await page.goto('/');
  await start(page, 'animal');
  await say(page, 'Is it alive?');
  await page.reload();
  const out = await say(page, 'Is it a bird?');
  expect(out, 'a yes/no question after reload should continue the round in progress').toMatch(/question 2\./);
});

test('after finishing, starting a new round works', async ({ page }) => {
  await page.goto('/');
  await start(page, 'food');
  await say(page, 'we give up');
  await start(page, 'animal');
  expect(await say(page, 'status')).toContain('0 questions used');
});

// The twenty_status tool description itself lists these phrasings, but the offline router sends anything
// starting with a question word to ask_question first, so the status check is never reached.
for (const phrase of ['how many questions are left', 'how are we doing', 'what have we asked so far']) {
  test(`status phrase "${phrase}" mid-round reports questions used instead of being judged as a question`, async ({ page }) => {
    await page.goto('/');
    await start(page, 'animal');
    await say(page, 'Is it alive?');
    expect(await say(page, phrase)).toContain('1 question used, 19 left');
  });
}
