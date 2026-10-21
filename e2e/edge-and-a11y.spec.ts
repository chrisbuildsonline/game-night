import { test, expect, type Page } from '@playwright/test';

const bots = (page: Page) => page.locator('.msg.bot');
const users = (page: Page) => page.locator('.msg.user');
async function say(page: Page, text: string) {
  const before = await bots(page).count();
  await page.getByLabel('Message').fill(text);
  await page.getByLabel('Message').press('Enter');
  await expect(bots(page)).toHaveCount(before + 1);
  return (await bots(page).last().evaluate((e) => e.firstChild?.textContent ?? '')) ?? '';
}
const noHScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth && document.body.scrollWidth <= window.innerWidth);

test.describe('edge input', () => {
  test('sending an empty or whitespace-only message does nothing', async ({ page }) => {
    let chatCalls = 0;
    page.on('request', (r) => { if (r.url().endsWith('/api/chat')) chatCalls++; });
    await page.goto('/');
    await page.getByLabel('Message').press('Enter');
    await page.getByLabel('Message').fill('    ');
    await page.getByLabel('Message').press('Enter');
    await page.getByRole('button', { name: /send/i }).click({ timeout: 2000 }).catch(() => {});
    await expect(users(page)).toHaveCount(0);
    expect(chatCalls).toBe(0);
  });

  test('a 5000 character message is accepted, answered and does not break the layout', async ({ page }) => {
    await page.goto('/');
    await say(page, 'list games ' + 'x'.repeat(5000));
    await expect(users(page)).toHaveCount(1);
    expect(await noHScroll(page)).toBe(true);
    await expect(page.getByLabel('Message')).toBeEnabled();
  });

  test('unicode, emoji and markup are shown literally and never executed', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    await page.goto('/');
    const text = 'héllo 你好 🎲🕵️‍♀️ <img src=x onerror=alert(1)> <script>alert(2)</script>';
    await say(page, text);
    await expect(users(page).first()).toHaveText(text);
    await expect(page.locator('#log img, #log script')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });

  test('double-clicking send with text sends it exactly once', async ({ page }) => {
    let chatCalls = 0;
    page.on('request', (r) => { if (r.url().endsWith('/api/chat')) chatCalls++; });
    await page.goto('/');
    await page.getByLabel('Message').fill('what games are there');
    await page.locator('button[type=submit]').dblclick();
    await expect(bots(page)).toHaveCount(1);
    await expect(users(page)).toHaveCount(1);
    expect(chatCalls).toBe(1);
  });

  test('rapid back-to-back sends each get exactly one reply, in order', async ({ page }) => {
    await page.goto('/');
    const msgs = ['list games', 'what do we know', 'status', 'banana', 'list games'];
    for (const m of msgs) {
      await page.getByLabel('Message').fill(m);
      await page.getByLabel('Message').press('Enter');
    }
    await expect(bots(page)).toHaveCount(msgs.length);
    await expect(users(page)).toHaveText(msgs);
  });

  test('when the server is unreachable the user sees an apology and can try again', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/chat', (r) => r.abort());
    await page.getByLabel('Message').fill('list games');
    await page.getByLabel('Message').press('Enter');
    await expect(bots(page).last()).toHaveText("Sorry, I couldn't reach Game Night.");
    await expect(page.getByLabel('Message')).toBeEnabled();
    await page.unroute('**/api/chat');
    expect(await say(page, 'list games')).toContain('Whodunnit at Home');
  });

  test('a server error status is shown as an apology, not a crash', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/chat', (r) => r.fulfill({ status: 500, body: 'boom' }));
    await page.getByLabel('Message').fill('list games');
    await page.getByLabel('Message').press('Enter');
    await expect(bots(page).last()).toContainText("couldn't reach Game Night");
  });

  test('the API rejects malformed bodies with 400 and non-JSON with 415', async ({ request }) => {
    expect((await request.post('/api/chat', { data: { conversation: 'a' } })).status()).toBe(400);
    expect((await request.post('/api/chat', { data: { conversation: 'a', text: '   ' } })).status()).toBe(400);
    expect((await request.post('/api/chat', { data: 'plain', headers: { 'content-type': 'text/plain' } })).status()).toBe(415);
  });
});

test.describe('keyboard only', () => {
  test('Tab reaches the input, Enter sends, and typing can continue without touching the mouse', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab'); // Voice on
    await page.keyboard.press('Tab'); // mic
    await page.keyboard.press('Tab'); // input
    await expect(page.getByLabel('Message')).toBeFocused();
    await page.keyboard.type('what games are there');
    await page.keyboard.press('Enter');
    await expect(bots(page)).toHaveCount(1);
    // Keyboard-only second message: focus should still be in the input after the reply arrives.
    await expect(page.getByLabel('Message'), 'input should keep focus after a reply so the next message can be typed').toBeFocused();
    await page.keyboard.type('what do we know');
    await page.keyboard.press('Enter');
    await expect(users(page)).toHaveCount(2);
  });

  test('Tab from the input reaches the Send button and Enter on it sends', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Message').fill('list games');
    await page.keyboard.press('Tab');
    await expect(page.locator('button[type=submit]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(bots(page)).toHaveCount(1);
  });
});

test.describe('mobile 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('no horizontal scroll, input and send stay on screen, even after long unbroken text', async ({ page }) => {
    await page.goto('/');
    expect(await noHScroll(page)).toBe(true);
    await say(page, 'list games');
    await say(page, 'A'.repeat(300));
    expect(await noHScroll(page)).toBe(true);
    for (const loc of [page.getByLabel('Message'), page.locator('button[type=submit]'), page.locator('#mic')]) {
      const box = (await loc.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
    }
    await page.screenshot({ path: 'test-results/screens/09-mobile-390.png' });
  });

  test('a long whodunnit intro fits at 390px without horizontal scroll', async ({ page }) => {
    await page.goto('/');
    await say(page, 'start a mystery in the kitchen, garage and bedroom');
    expect(await noHScroll(page)).toBe(true);
    await page.screenshot({ path: 'test-results/screens/10-mobile-intro.png' });
  });
});

test.describe('accessibility', () => {
  test('the message input has an accessible label', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  });

  test('every button has a meaningful accessible name (not just an icon glyph)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /send/i }), 'Send button should be named "Send"').toBeVisible();
    await expect(page.getByRole('button', { name: /talk|mic|speak/i }), 'mic button should be named Talk/Mic').toBeVisible();
    await expect(page.getByRole('button', { name: /voice/i })).toBeVisible();
  });

  test('every button has some non-empty accessible name', async ({ page }) => {
    await page.goto('/');
    const names = await page.locator('button').evaluateAll((bs) => bs.map((b) => (b.getAttribute('aria-label') || b.textContent || b.getAttribute('title') || '').trim()));
    expect(names.length).toBe(3);
    for (const n of names) expect(n).not.toBe('');
  });

  test('focused text input shows a visible focus indicator', async ({ page }) => {
    await page.goto('/');
    const input = page.getByLabel('Message');
    const before = await input.evaluate((e) => getComputedStyle(e).borderColor);
    await input.focus();
    const after = await input.evaluate((e) => { const s = getComputedStyle(e); return { border: s.borderColor, outline: s.outlineStyle, shadow: s.boxShadow }; });
    expect(after.border !== before || after.outline !== 'none' || after.shadow !== 'none').toBe(true);
  });

  test('keyboard-focused buttons show a focus ring', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const s = await page.locator(':focus').evaluate((e) => { const c = getComputedStyle(e); return { style: c.outlineStyle, width: c.outlineWidth }; });
    expect(s.style).not.toBe('none');
    expect(parseFloat(s.width)).toBeGreaterThan(0);
  });

  test('new chat replies are announced to screen readers via a live region', async ({ page }) => {
    await page.goto('/');
    const live = await page.locator('#log').evaluate((e) => e.closest('[aria-live], [role=log], [role=status]') !== null);
    expect(live, 'chat log (or a parent) should be aria-live / role=log').toBe(true);
  });

  test('page declares a language and a viewport', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('meta[name=viewport]')).toHaveCount(1);
  });
});

test.describe('speech APIs missing (headless cannot do real mic or voices)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as any).SpeechRecognition;
      delete (window as any).webkitSpeechRecognition;
    });
  });

  test('clicking the mic without SpeechRecognition explains to type instead and focuses the input', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.locator('#mic').click();
    await expect(page.locator('#state')).toHaveText('Speech input not supported here - type instead');
    await expect(page.getByLabel('Message')).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('typing still works end to end with no speechSynthesis either', async ({ page }) => {
    await page.addInitScript(() => { delete (window as any).speechSynthesis; });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    expect(await say(page, 'list games')).toContain('Whodunnit at Home');
    await expect(page.locator('#state')).toHaveText('Tap the mic or type');
    expect(errors).toEqual([]);
  });
});
