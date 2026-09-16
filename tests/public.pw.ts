import { expect, test } from '@playwright/test';

test('renders the championship landing page with its event facts and public interactions', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Corporate Championship' })).toBeVisible();
  await expect(page.getByText('October 1-4, 2026', { exact: true })).toBeVisible();
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

test('reflows the championship page on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Corporate Championship' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('supports keyboard tabs and reduced motion in dark mode', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('/');
  const first = page.getByRole('tab', { name: 'Futsal' });
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Cricksul' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Cricksul' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-cricksul');
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Basketball' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Meet the teams' })).toBeVisible();
  expect(
    await page.locator('.hero-copy').evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  await page.getByText('Can a company enter more than one sport?', { exact: true }).click();
  await expect(
    page.getByText('Yes. A captain can select every available sport', { exact: false }),
  ).toBeVisible();
});
