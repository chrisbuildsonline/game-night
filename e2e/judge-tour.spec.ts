import { test, expect, type Page } from '@playwright/test';

// What a judge does in the first 5 minutes: open the page, look around, list games, start one.

function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  return problems;
}

const bots = (page: Page) => page.locator('.msg.bot');

async function say(page: Page, text: string) {
  const before = await bots(page).count();
  await page.getByLabel('Message').fill(text);
  await page.getByLabel('Message').press('Enter');
  await expect(bots(page)).toHaveCount(before + 1);
  return (await bots(page).last().evaluate((e) => e.firstChild?.textContent ?? '')) ?? '';
}

test.describe('judge first five minutes', () => {
  test('page loads with the title, input and no console errors or failed requests', async ({ page }) => {
    const problems = watch(page);
    await page.goto('/');
    await expect(page).toHaveTitle(/Game Night/);
    await expect(page.getByLabel('Message')).toBeVisible();
    await expect(page.locator('#state')).toHaveText('Tap the mic or type');
    await page.waitForLoadState('networkidle');
    expect(problems).toEqual([]);
    await page.screenshot({ path: 'test-results/screens/01-landing.png' });
  });

  test('asking what games there are lists both games and shows the MCP tool call', async ({ page }) => {
    const problems = watch(page);
    await page.goto('/');
    const reply = await say(page, 'what games are there');
    expect(reply).toContain('Whodunnit at Home');
    expect(reply).toContain('Twenty Questions');
    await expect(bots(page).last().locator('summary')).toContainText('MCP: list_games');
    expect(reply).not.toContain('HOST NOTE');
    await expect(page.locator('#state')).not.toHaveText('Thinking...');
    expect(problems).toEqual([]);
    await page.screenshot({ path: 'test-results/screens/02-list-games.png' });
  });

  test('user message appears in the log before the reply and the input is usable again after', async ({ page }) => {
    await page.goto('/');
    await say(page, 'list games');
    await expect(page.locator('.msg.user')).toHaveText('list games');
    await expect(page.getByLabel('Message')).toBeEnabled();
    await expect(page.getByLabel('Message')).toHaveValue('');
  });

  test('unknown input gets a helpful fallback rather than an error', async ({ page }) => {
    await page.goto('/');
    const reply = await say(page, 'banana phone telephone');
    expect(reply).toContain('what games are there');
  });

  test('voice toggle switches between Voice on and Voice off', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Voice on' }).click();
    await expect(page.getByRole('button', { name: 'Voice off' })).toBeVisible();
    await page.getByRole('button', { name: 'Voice off' }).click();
    await expect(page.getByRole('button', { name: 'Voice on' })).toBeVisible();
  });
});
