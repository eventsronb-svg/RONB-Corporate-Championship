import { expect, test } from '@playwright/test';
import sharp from 'sharp';

test('new captain signs in, submits one team, corrects rejected payment, and finishes its profile', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(60000);
  const captain = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
  const organizer = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
  const page = await captain.newPage();
  const admin = await organizer.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  admin.on('pageerror', (error) => errors.push(error.message));
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#be1830' } })
    .png()
    .toBuffer();
  const upload = { name: 'proof.png', mimeType: 'image/png', buffer: png };
  // The test storage returns stable example URLs; fulfill their image loads instead of relying on DNS.
  for (const context of [captain, organizer]) {
    await context.route('https://*.example/**', (route) =>
      route.fulfill({ body: png, contentType: 'image/png' }),
    );
  }
  // Only the external Google exchange is a test provider; state, cookies, routes and DB are real.
  await page.route('**/auth/google', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const url = new URL(response.headers().location);
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', 'test-code');
    await route.fulfill({
      response,
      headers: { ...response.headers(), location: callback.toString() },
    });
  });
  try {
    await page.goto('/register');
    await page.getByRole('link', { name: 'Sign in with Google' }).click();
    await expect(
      page.getByRole('heading', { name: 'Register your company', level: 2 }),
    ).toBeVisible();
    const orderId = new URL(page.url()).searchParams.get('order')!;
    expect(orderId).toBeTruthy();
    await page.getByRole('button', { name: 'Continue to contact' }).click();
    await expect(page.getByText('Enter your company name and select a sport.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Company name' }).fill('E2E Company');
    await page.getByRole('radio', { name: /^Basketball / }).check();
    await page.getByRole('button', { name: 'Continue to contact' }).click();
    await expect(
      page.getByRole('heading', { name: 'Where can we reach the captain?' }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Where can we reach the captain?' }),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Phone number' }).fill('abc');
    await page.getByRole('button', { name: 'Issue invoice' }).click();
    await expect(page.locator('#phone-form .error')).toBeVisible();
    await page.getByRole('textbox', { name: 'Phone number' }).fill('9800000000');
    await page.getByRole('button', { name: 'Issue invoice' }).click();
    await expect(page.getByRole('heading', { name: 'Transfer 1,000 NPR' })).toBeVisible();
    const paymentCode = await page.locator('code').textContent();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Transfer 1,000 NPR' })).toBeVisible();
    await expect(page.locator('code')).toHaveText(paymentCode!);
    await page.getByRole('button', { name: 'I have paid, upload receipt' }).click();
    await page.getByLabel('Receipt file').setInputFiles({
      name: 'bad.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not an image'),
    });
    await page.getByRole('button', { name: 'Submit receipt' }).click();
    await expect(page.locator('#receipt-form .error')).toBeVisible();
    // A valid image above Vercel's request limit must shrink before it leaves the browser.
    const largePng = await sharp({
      create: { width: 1400, height: 1200, channels: 3, background: '#759585' },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(largePng.length).toBeGreaterThan(4_500_000);
    await page.getByLabel('Receipt file').setInputFiles({
      name: 'large-receipt.png',
      mimeType: 'image/png',
      buffer: largePng,
    });
    const submitted = page.waitForRequest(
      (request) => request.url().endsWith('/receipt') && request.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Submit receipt' }).click();
    const requestBody = (await submitted).postDataBuffer()!;
    expect(requestBody.length).toBeLessThan(4_100_000);
    expect(requestBody.toString('latin1')).toContain('image/webp');
    await expect(page.getByRole('heading', { name: 'Receipt received' })).toBeVisible();

    await organizer.addCookies([{ name: 'admin_session', value: 'staff', url: baseURL }]);
    await admin.goto(`/admin#order/${orderId}`);
    await admin.getByRole('button', { name: 'Reject payment' }).click();
    await expect(admin.getByRole('status')).toHaveText('Add notes explaining this decision.');
    await admin
      .getByRole('textbox', { name: 'Review / contact notes' })
      .fill('Please upload a clearer receipt.');
    await admin.getByRole('button', { name: 'Reject payment' }).click();
    await expect(admin.getByRole('status')).toHaveText('Registration updated.');
    await page.reload();
    await expect(
      page.getByText('Payment rejected: Please upload a clearer receipt.'),
    ).toBeVisible();
    await page.getByLabel('Receipt file').setInputFiles(upload);
    await page.getByRole('button', { name: 'Submit receipt' }).click();
    await expect(page.getByRole('heading', { name: 'Receipt received' })).toBeVisible();
    await admin.reload();
    await admin.getByRole('button', { name: 'Start review' }).click();
    await expect(admin.getByRole('button', { name: 'Start review' })).toHaveCount(0);
    await admin.getByRole('button', { name: 'Confirm payment' }).click();
    await expect(admin.getByRole('heading', { name: 'Verified on' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Finish your team' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByLabel('Company logo').setInputFiles(upload);
    await page.getByRole('button', { name: 'Save company logo', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Company logo saved.');
    await page
      .locator('.sport-choice')
      .filter({ hasText: 'Basketball' })
      .getByRole('link', { name: 'Complete profile' })
      .click();
    await page.getByRole('textbox', { name: 'Player 1', exact: true }).fill('Draft player');
    await page.getByRole('button', { name: 'Back to overview' }).click();
    await expect(page.getByRole('heading', { name: 'Finish your team' })).toBeVisible();
    await page
      .locator('.sport-choice')
      .filter({ hasText: 'Basketball' })
      .getByRole('link', { name: 'Complete profile' })
      .click();
    await expect(page.getByRole('textbox', { name: 'Player 1', exact: true })).toHaveValue(
      'Draft player',
    );
    await expect(page.getByLabel('Company logo')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'E2E Company' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (let i = 0; i < 3; i++) {
      if (
        (await page.getByRole('textbox', { name: `Player ${i + 1}`, exact: true }).count()) === 0
      ) {
        await page.getByRole('button', { name: 'Add player', exact: true }).click();
      }
      await page
        .getByRole('textbox', { name: `Player ${i + 1}`, exact: true })
        .fill(`Player ${i + 1}`);
      if (i > 0)
        await page
          .getByRole('group', { name: `Jersey size for player ${i + 1}`, exact: true })
          .getByRole('radio', { name: ['S', 'M', 'XL'][i], exact: true })
          .check();
    }
    await page.getByRole('combobox', { name: 'Team captain', exact: true }).selectOption('1');
    await page.getByRole('button', { name: 'Save and mark done' }).click();
    await expect(
      page.getByText('Choose a jersey size for every player.', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('group', { name: 'Jersey size for player 1', exact: true })
      .getByRole('radio', { name: 'S', exact: true })
      .check();
    await page.getByLabel('Photo for player 1', { exact: true }).setInputFiles(upload);
    await expect(
      page.locator('.player-row').first().locator('.player-photo-preview'),
    ).toBeVisible();
    await page.screenshot({ path: 'test-results/jersey-onboarding-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    const nameBox = await page
      .getByRole('textbox', { name: 'Player 1', exact: true })
      .boundingBox();
    const sizeBox = await page
      .getByRole('group', { name: 'Jersey size for player 1', exact: true })
      .boundingBox();
    expect(sizeBox!.x).toBeGreaterThan(nameBox!.x + nameBox!.width);
    await page.screenshot({ path: 'test-results/jersey-onboarding-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Add player', exact: true }).click();
    await page.getByRole('textbox', { name: 'Player 4', exact: true }).fill('Player 4');
    await page
      .getByRole('group', { name: 'Jersey size for player 4', exact: true })
      .getByRole('radio', { name: 'L', exact: true })
      .check();
    const profileSaved = page.waitForResponse(
      (response) =>
        response.url().includes(`/orders/${orderId}/items/`) &&
        response.url().endsWith('/profile') &&
        response.request().method() === 'PATCH' &&
        response.status() === 200,
    );
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await profileSaved;
    await expect(page.getByRole('status')).toHaveText('Profile saved.');
    await page.reload();
    for (let i = 0; i < 4; i++) {
      await expect(page.getByRole('textbox', { name: `Player ${i + 1}`, exact: true })).toHaveValue(
        `Player ${i + 1}`,
      );
      await expect(
        page
          .getByRole('group', { name: `Jersey size for player ${i + 1}`, exact: true })
          .getByRole('radio', { name: ['S', 'M', 'XL', 'L'][i], exact: true }),
      ).toBeChecked();
    }
    await expect(page.getByRole('combobox', { name: 'Team captain', exact: true })).toHaveValue(
      '1',
    );
    await page.getByRole('button', { name: 'Save and mark done' }).click();
    await expect(page.getByRole('status')).toHaveText('Team profile completed.');
    await expect(page.getByRole('heading', { name: 'See you there E2E Company.' })).toBeVisible();
    const status = await (await captain.request.get(`/orders/${orderId}/status`)).json();
    expect(status.company_name).toBe('E2E Company');
    expect(status.items).toHaveLength(1);
    expect(status.items[0].logo_url).toBeTruthy();
    expect(status.items[0].players).toHaveLength(4);
    expect(status.items[0].jersey_sizes).toEqual(['S', 'M', 'XL', 'L']);
    expect(status.items[0].captain_position).toBe(1);
    expect(status.items[0].profile_completed_at).toBeTruthy();
    await expect(page.locator('.roster-row').first().locator('.roster-photo')).toBeVisible();
    const uploadedPhotoUrl = status.items[0].photo_urls[0];
    expect(uploadedPhotoUrl).toBeTruthy();
    const headers = { origin: baseURL! };
    const firstDelivery = await captain.request.post('/__test/deliver', { headers });
    expect((await firstDelivery.json()).sent).toBe(1);
    expect((await (await captain.request.post('/__test/deliver', { headers })).json()).sent).toBe(
      1,
    );
    await admin.reload();
    await expect(admin.getByText('Profile complete', { exact: true })).toHaveCount(1);
    await admin.getByRole('link', { name: 'Teams', exact: true }).click();
    await admin.getByRole('link', { name: 'E2E Company', exact: true }).click();
    await expect(admin.getByRole('heading', { name: 'E2E Company', exact: true })).toBeVisible();
    await expect(admin.locator('.sport-roster')).toHaveCount(1);
    await expect(admin.locator('.player-photo[src]')).toHaveCount(1);
    await expect(admin.locator('.player-photo[src]').first()).toHaveAttribute(
      'src',
      new RegExp(await uploadedPhotoUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    await expect(admin.locator('.jersey-badge')).toHaveText(['S', 'M', 'XL', 'L']);
    await expect(admin.getByRole('cell', { name: 'Captain', exact: true })).toHaveCount(1);
    await admin.setViewportSize({ width: 390, height: 844 });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await admin.screenshot({ path: 'test-results/team-detail-mobile.png', fullPage: true });
    await admin.getByRole('link', { name: 'View registration' }).click();
    await admin.getByText('Registration management', { exact: true }).click();
    await admin.getByRole('button', { name: 'Mark contacted' }).click();
    await expect(admin.getByRole('status')).toHaveText('Registration updated.');
    await admin.getByText('Registration management', { exact: true }).click();
    await admin.getByRole('button', { name: 'Mark completed' }).click();
    await expect(admin.getByRole('status')).toHaveText('Registration updated.');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'See you there E2E Company.' })).toBeVisible();
    // The done page lists every sport; the registered one opens with its roster details.
    const registration = page.locator('.registration-sport').filter({ hasText: 'Basketball' });
    await expect(registration).toHaveAttribute('open', '');
    await expect(
      registration.locator('.registration-summary').getByText('E2E Company'),
    ).toBeVisible();
    await expect(registration.locator('.roster-list .jersey-badge')).toHaveText([
      'S',
      'M',
      'XL',
      'L',
    ]);
    const football = page.locator('.registration-sport').filter({ hasText: 'Football' });
    await football.locator('summary').click();
    await expect(football.getByRole('button', { name: 'Register for Football' })).toBeVisible();
    await football.getByRole('button', { name: 'Register for Football' }).click();
    await expect(
      page.getByRole('heading', { name: 'Register another sport', level: 2 }),
    ).toBeVisible();
    // The company profile is carried over; only the new sport needs to be chosen.
    await expect(
      page.getByText('Your company profile and contact number are already saved.'),
    ).toBeVisible();
    await expect(page.getByRole('radio', { name: /^Football / })).toBeChecked();
    // The existing Basketball registration remains unavailable in the new order.
    const registeredSport = page.locator('.sport-choice').filter({ hasText: 'Basketball' });
    await expect(registeredSport.locator('[name="sport"]')).toBeDisabled();
    await expect(registeredSport).toHaveClass(/is-registered/);
    await expect(registeredSport).toHaveClass(/is-verified/);
    await expect(registeredSport.getByText('Registered · Verified')).toBeVisible();
    await page.getByRole('button', { name: 'Continue to invoice' }).click();
    await expect(page.getByRole('heading', { name: 'Issue your invoice', level: 2 })).toBeVisible();
    await expect(page.getByLabel('Phone number')).toHaveCount(0);
    await page.goto(`/register?order=${orderId}`);
    await expect(page.getByRole('heading', { name: 'See you there E2E Company.' })).toBeVisible();
    await page.getByRole('link', { name: 'See team listing' }).click();
    await expect(page).toHaveURL(/\/#teams$/);
    await expect(page.getByRole('heading', { name: 'E2E Company' })).toBeVisible();
    await page.getByRole('tab', { name: 'Football' }).click();
    await expect(page.getByRole('heading', { name: 'E2E Company' })).not.toBeVisible();
    await admin.getByRole('button', { name: 'Sign out' }).click();
    await expect(admin.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect((await organizer.request.get('/admin/orders')).status()).toBe(401);
    expect(errors).toEqual([]);
  } finally {
    await captain.close();
    await organizer.close();
  }
});

test('mobile captain can revise an expired payment and recover from session expiry during submission', async ({
  page,
  context,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await context.addCookies([{ name: 'session', value: 'stranger', url: baseURL }]);
  await page.goto('/register');
  await expect(
    page.getByRole('heading', { name: 'Register your company', level: 2 }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Company name' }).fill('Mobile Company');
  await page.getByRole('radio', { name: /^Basketball / }).check();
  await page.getByRole('button', { name: 'Continue to contact' }).click();
  await page.getByRole('textbox', { name: 'Phone number' }).fill('9800000000');
  await page.route(
    '**/payment-request',
    async (route) => {
      await route.fulfill({ status: 503, json: { message: 'Temporary payment outage' } });
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Issue invoice' }).click();
  await expect(page.getByText('Temporary payment outage')).toBeVisible();
  await page.getByRole('button', { name: 'Issue invoice' }).click();
  await expect(page.getByRole('heading', { name: 'Transfer 1,000 NPR' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const oldId = new URL(page.url()).searchParams.get('order');
  await context.request.post(`/__test/expire/${oldId}`, { headers: { origin: baseURL! } });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Payment code expired' })).toBeVisible();
  await page.getByRole('button', { name: 'Revise registration' }).click();
  await expect(
    page.getByRole('heading', { name: 'Where can we reach the captain?' }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get('order')).not.toBe(oldId);
  await page.getByRole('button', { name: 'Edit company & sports' }).click();
  await expect(page.getByRole('textbox', { name: 'Company name' })).toHaveValue('Mobile Company');
  await page.getByRole('button', { name: 'Continue to contact' }).click();
  await context.clearCookies();
  await page.getByRole('button', { name: 'Issue invoice' }).click();
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
});

test('empty sports and expired captain sessions have usable screens', async ({ page, context }) => {
  await page.route('**/sports', (route) => route.fulfill({ json: [] }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Corporate Championship' })).toBeVisible();
  await expect(page.getByText('No sports are open for registration yet.').first()).toBeVisible();
  await context.addCookies([
    { name: 'session', value: 'expired-token', domain: 'localhost', path: '/' },
  ]);
  await page.goto('/register');
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
});
