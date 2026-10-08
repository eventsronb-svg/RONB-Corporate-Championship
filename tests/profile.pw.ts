import { expect, test } from '@playwright/test';
import sharp from 'sharp';

// The roster editor is the only screen the test drives; the order behind it is built
// through the API so this stays fast and only pins the editor's own behaviour.
test('a draft save with photos does not lock the roster out of "Save and mark done"', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(60000);
  const origin = baseURL!;
  const captain = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
  const organizer = await browser.newContext({ baseURL });
  try {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#be1830' } })
      .png()
      .toBuffer();
    const upload = { name: 'player.png', mimeType: 'image/png', buffer: png };
    const expectOk = async (
      label: string,
      response: { status(): number; text(): Promise<string> },
    ) => {
      if (response.status() !== 200)
        throw new Error(`${label} failed: ${response.status()} ${await response.text()}`);
    };
    const post = (url: string, data?: unknown) =>
      captain.request.post(url, { data, headers: { origin } });
    const patch = (url: string, data?: unknown) =>
      captain.request.patch(url, { data, headers: { origin } });

    // A captain of our own, so the order below is not the open one the fixture starts with.
    const login = await post('/__test/captain');
    await expectOk('__test/captain', login);
    await captain.addCookies([{ name: 'session', value: (await login.json()).token, url: origin }]);

    const draft = await post('/orders/draft');
    await expectOk('orders/draft', draft);
    const orderId = (await draft.json()).id;
    const sports = await (await captain.request.get('/sports')).json();
    const basketball = sports.find((sport: { name: string }) => sport.name === 'Basketball');
    expect(basketball).toBeTruthy();
    await expectOk(
      'orders/sports',
      await patch(`/orders/${orderId}/sports`, {
        company_name: 'Roster Lock Co',
        sports: [{ sport_id: basketball.id }],
      }),
    );
    await expectOk(
      'orders/phone',
      await post(`/orders/${orderId}/phone`, { phone_number: '+977 9800000000' }),
    );
    await expectOk('orders/invoice', await post(`/orders/${orderId}/invoice`));
    await expectOk('orders/payment-request', await post(`/orders/${orderId}/payment-request`));
    await expectOk(
      'orders/receipt',
      await captain.request.post(`/orders/${orderId}/receipt`, {
        multipart: { receipt: upload },
        headers: { origin },
      }),
    );

    await organizer.addCookies([{ name: 'admin_session', value: 'staff', url: origin }]);
    await expectOk(
      'admin/verify',
      await organizer.request.post(`/admin/orders/${orderId}/verify`, {
        data: { decision: 'confirmed' },
        headers: { origin },
      }),
    );

    const before = await (await captain.request.get('/orders/current')).json();
    const item = before.items[0];
    expect(before.resume_step).toBe('team_profile');
    // The roster editor only opens once the company logo exists.
    await expectOk(
      'profile/logo',
      await captain.request.patch(`/orders/${orderId}/items/${item.id}/profile`, {
        multipart: { logo: upload },
        headers: { origin },
      }),
    );

    const page = await captain.newPage();
    await page.goto('/register');
    await expect(page.getByRole('heading', { name: 'Finish your team' })).toBeVisible();
    await page
      .locator('.sport-choice')
      .filter({ hasText: 'Basketball' })
      .getByRole('link', { name: 'Complete profile' })
      .click();
    await expect(page.locator('#profile-form')).toBeVisible();

    for (let index = 1; index <= 3; index++) {
      await page
        .getByRole('textbox', { name: `Player ${index}`, exact: true })
        .fill(`Player ${index}`);
      await page
        .getByRole('group', { name: `Jersey size for player ${index}`, exact: true })
        .getByRole('radio', { name: ['S', 'M', 'XL'][index - 1], exact: true })
        .check();
      await page.getByLabel(`Photo for player ${index}`, { exact: true }).setInputFiles(upload);
    }
    await page.getByRole('combobox', { name: 'Team captain', exact: true }).selectOption('0');

    // The picker has to cover the whole circle: its top edge used to be a dead strip where
    // a click did nothing, and the remove button used to sit under the invisible file input
    // so pressing it opened the picker instead of dropping the photo.
    const firstRow = page.locator('.player-row').first();
    const circle = (await firstRow.locator('.player-photo').boundingBox())!;
    const picked = page.waitForEvent('filechooser');
    await page.mouse.click(circle.x + circle.width / 2, circle.y + 3);
    await (await picked).setFiles(upload);
    await expect(firstRow.locator('.player-photo-preview')).toBeVisible();
    await firstRow.locator('.player-photo-clear').click();
    await expect(firstRow.locator('.player-photo-placeholder')).toBeVisible();
    await page.getByLabel('Photo for player 1', { exact: true }).setInputFiles(upload);
    await expect(firstRow.locator('.player-photo-preview')).toBeVisible();

    // Saving uploads the photos first, and that must not leave the roster fields disabled:
    // a disabled field is not part of FormData, so the draft would be stored with an empty
    // roster and the next attempt would come back with "Add at least 3 players".
    const drafted = page.waitForResponse(
      (response) =>
        response.url().endsWith('/profile') &&
        response.request().method() === 'PATCH' &&
        response.status() === 200,
    );
    await page.getByRole('button', { name: 'Back to overview' }).click();
    await drafted;
    await expect(page.getByRole('heading', { name: 'Finish your team' })).toBeVisible();

    // Straight back in, with a reload in between: the overview has to survive one and the
    // draft still has to hold the roster.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Finish your team' })).toBeVisible();
    await page
      .locator('.sport-choice')
      .filter({ hasText: 'Basketball' })
      .getByRole('link', { name: 'Complete profile' })
      .click();
    await expect(page.locator('#profile-form')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Player 1', exact: true })).toHaveValue(
      'Player 1',
    );

    await page.getByRole('button', { name: 'Save and mark done', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Team profile completed.');

    const after = await (await captain.request.get('/orders/current')).json();
    expect(after.items[0].profile_completed_at).toBeTruthy();
    expect(after.items[0].players).toEqual(['Player 1', 'Player 2', 'Player 3']);
    expect(after.items[0].jersey_sizes).toEqual(['S', 'M', 'XL']);
  } finally {
    await captain.close();
    await organizer.close();
  }
});

// Completing a profile on a paid order queues the confirmation email the app is supposed to
// send. The mail log counts deliveries across the whole run, so hand the next file a clean
// log instead of leaving this test's email to show up in someone else's delivery count.
test.afterAll(async ({ request, baseURL }) => {
  const response = await request.post('/__test/mail-clear', {
    data: {},
    headers: { origin: baseURL! },
  });
  expect(response.ok()).toBeTruthy();
});
