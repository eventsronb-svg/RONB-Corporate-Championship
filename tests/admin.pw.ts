import { test, expect } from '@playwright/test';
import { passwordAdminCredentials } from './credentials.js';
test('shows the organizer login on desktop and mobile', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'A good event starts here.' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Username' })).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await page.screenshot({
    path: 'test-results/admin-login-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('textbox', { name: 'Username' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('textbox', { name: 'Username' }).fill(passwordAdminCredentials.username);
  await page.getByLabel('Password').fill(passwordAdminCredentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Registrations', exact: true })).toBeVisible();
});
test('reviews an order, changes settings, and manages organizer access', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await context.addCookies([
    { name: 'admin_session', value: 'admin', domain: 'localhost', path: '/' },
  ]);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Registrations', exact: true })).toBeVisible();
  const reviewLink = page
    .getByRole('row')
    .filter({ hasText: 'Anish Shrestha' })
    .getByRole('link', { name: /^Review / });
  await expect(reviewLink).toBeVisible();
  await page.screenshot({
    path: 'test-results/admin-queue-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await reviewLink.click();
  await expect(page.getByRole('heading', { name: 'Payment proof' })).toBeVisible();
  await page.getByRole('button', { name: 'Start review' }).click();
  await expect(page.getByRole('button', { name: 'Start review' })).toHaveCount(0);
  await page
    .getByRole('textbox', { name: 'Review / contact notes' })
    .fill('Amount and payment code match the receipt.');
  await page.getByRole('button', { name: 'Confirm payment' }).click();
  await expect(page.getByRole('heading', { name: 'Verified on' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Next action' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm payment' })).toHaveCount(0);
  const verifiedTime = await page.locator('.verification-card time').getAttribute('datetime');
  expect(verifiedTime).toBeTruthy();
  await expect(page.locator('.verification-card')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await page.getByRole('link', { name: 'All registrations' }).click();
  const completedRow = page.getByRole('row').filter({ hasText: 'Anish Shrestha' });
  await expect(completedRow.locator('.status.completed')).toHaveText('Completed');
  await page.locator('select[name="status"]').selectOption('completed');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(completedRow.locator('.status.completed')).toBeVisible();
  await completedRow.getByRole('link', { name: /^Review / }).click();
  await page.reload();
  await expect(page.locator('.verification-card time')).toHaveAttribute('datetime', verifiedTime!);
  await page.getByText('Registration management', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark contacted' })).toBeVisible();
  await expect(page.getByText('Profile pending', { exact: true })).toHaveCount(2);
  await page
    .getByRole('textbox', { name: 'Review / contact notes' })
    .fill('Captain notified by phone.');
  await page.getByRole('button', { name: 'Mark contacted' }).click();
  await expect(page.getByRole('heading', { name: 'Verified on' })).toBeVisible();
  await page.getByText('Registration management', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark completed' })).toBeVisible();
  await page.screenshot({
    path: 'test-results/admin-order-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('link', { name: 'Sports & pricing' }).click();
  const cricket = page
    .locator('.sport-form')
    .filter({ has: page.locator('input[value="Cricket"]') });
  await cricket.getByRole('spinbutton', { name: 'Registration price' }).fill('1800.50');
  await cricket.getByRole('spinbutton', { name: 'Team capacity (blank for unlimited)' }).fill('20');
  await cricket.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Sport updated.');
  await expect(
    page
      .locator('.sport-form')
      .filter({ has: page.locator('input[value="Cricket"]') })
      .getByRole('spinbutton', { name: 'Team capacity (blank for unlimited)' }),
  ).toHaveValue('20');
  await expect(
    page
      .locator('.sport-form')
      .filter({ has: page.locator('input[value="Cricket"]') })
      .getByRole('spinbutton', { name: 'Registration price' }),
  ).toHaveValue('1800.50');
  await page.getByRole('link', { name: 'Event details' }).click();
  await page.getByRole('textbox', { name: 'Venue', exact: true }).fill('Kathmandu Sports Ground');
  await page.getByRole('button', { name: 'Save event details' }).click();
  await expect(page.getByRole('status')).toHaveText('Event details saved.');
  await page.getByRole('link', { name: 'Organizers', exact: true }).click();
  await page.getByRole('textbox', { name: 'Google account email' }).fill('operations@example.com');
  await page.getByRole('button', { name: 'Add to allowlist' }).click();
  await expect(page.getByRole('status')).toHaveText('Organizer added to the allowlist.');
  await expect(
    page.locator('.organizer-form').filter({ hasText: 'operations@example.com' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Captains', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search captains' }).fill('Anish');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Anish Shrestha', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.view-entry')).toHaveCSS('opacity', '1');
  await page.screenshot({
    path: 'test-results/admin-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});
test('staff see only their permitted navigation and empty queues remain usable', async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: 'admin_session', value: 'staff', domain: 'localhost', path: '/' },
  ]);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Registrations', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sports & pricing' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Find a registration' }).fill('No matching captain');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByRole('heading', { name: 'You’re all caught up.' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
