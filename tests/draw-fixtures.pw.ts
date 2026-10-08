import { test, expect } from '@playwright/test';

// The draw finishes itself: the save that places the last team draws every group
// fixture in the same click, so the screen lands on the fixture list with no
// generate button left to press.
test('saving the last group assignment draws the fixtures automatically', async ({
  page,
  context,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await context.addCookies([
    { name: 'admin_session', value: 'admin', domain: 'localhost', path: '/' },
  ]);
  // Sixteen confirmed basketball registrations — the field four groups of four need.
  const seeded = await context.request.post('/__test/championship/basketball/16', {
    headers: { origin: baseURL! },
  });
  expect(seeded.ok()).toBe(true);
  expect((await seeded.json()).teams).toBe(16);
  await page.goto('/admin#basketball');
  await page.locator('[data-basketball="import"]').click();
  await expect(page.getByRole('status')).toHaveText('Basketball championship updated.');
  const teams = (await (await context.request.get('/admin/basketball')).json()).teams;
  expect(teams).toHaveLength(16);
  await expect(page.locator('[data-basket-group-select]')).toHaveCount(16);
  const groups = ['A', 'B', 'C', 'D'];
  for (const [index, team] of teams.entries()) {
    const remaining = 16 - index - 1;
    await page
      .locator(`[data-basket-group-select="${team.id}"]`)
      .selectOption(groups[Math.floor(index / 4)]);
    await page.locator(`[data-basket-group-save="${team.id}"]`).click();
    if (remaining) {
      // Every save re-renders the draw and moves its team out of the unassigned
      // panel, so the shrinking panel is how the next row waits for the last one.
      await expect(
        page.locator('[data-basket-group-panel=""] [data-basket-group-select]'),
      ).toHaveCount(remaining);
      await expect(page.getByRole('status')).toHaveText('Group assignment saved.');
    } else {
      await expect(page.getByRole('status')).toHaveText(
        'All groups assigned — 24 group fixtures drawn.',
      );
    }
  }
  // The finished draw lists all four groups' fixtures and offers no redraw button.
  await expect(page.locator('.draw-matches')).toHaveCount(4);
  await expect(page.locator('tr[data-match]')).toHaveCount(24);
  await expect(page.locator('[data-basketball="fixtures"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
