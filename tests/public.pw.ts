import { expect, test } from '@playwright/test';

test('renders the championship landing page with its event facts and public interactions', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Corporate Championship' })).toBeVisible();
  await expect(page.getByText('Oct 01—04', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Royal Sports Park' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Open directions/ })).toHaveAttribute(
    'href',
    'https://maps.app.goo.gl/5LA3r9CQJskT8jwW6',
  );
  await expect(page.getByRole('tab', { name: 'Futsal' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Basketball' }).click();
  await expect(page.getByRole('tab', { name: 'Basketball' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page
    .getByRole('link', { name: /Futsal/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/register\?focus=futsal/);
  await expect(page.getByRole('link', { name: /Sign in with Google/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('reflows the event poster on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Corporate Championship' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
