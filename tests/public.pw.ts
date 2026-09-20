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
    'https://www.google.com/maps/place/royal+sports+park/data=!4m2!3m1!1s0x39eb1d0035469f7b:0x9a106e0556f62210?sa=X&ved=1t:242&ictx=111',
  );
  await expect(page.getByTitle('Royal Sports Park location on Google Maps')).toHaveAttribute(
    'src',
    'https://www.google.com/maps?cid=11101494050681135632&output=embed',
  );
  await expect(page.getByRole('tab', { name: 'Basketball' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Football' }).click();
  await expect(page.getByRole('tab', { name: 'Football' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page
    .getByRole('link', { name: /Football/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/register\?focus=football/);
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

test('reveals sections as the visitor scrolls', async ({ page }) => {
  await page.goto('/');
  const sport = page.getByRole('link', { name: /Football/ }).first();
  await expect(sport).toHaveClass(/reveal/);
  await sport.scrollIntoViewIfNeeded();
  await expect(sport).toHaveClass(/revealed/);
  await expect(page.locator('.venue-map')).toHaveClass(/venue-map/);
});

test('supports keyboard tabs and reduced motion with a dark system preference', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('/');
  const first = page.getByRole('tab', { name: 'Basketball' });
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Cricket' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Cricket' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-cricket');
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Football' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Meet the teams' })).toBeVisible();
  expect(
    await page.locator('.hero-copy').evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  expect(
    await page
      .getByRole('link', { name: /Football/ })
      .first()
      .evaluate((el) => el.classList.contains('reveal')),
  ).toBe(false);
  await page.getByText('Can a company enter more than one sport?', { exact: true }).click();
  await expect(
    page.getByText('Each registration covers one sport, so register again', { exact: false }),
  ).toBeVisible();
});
