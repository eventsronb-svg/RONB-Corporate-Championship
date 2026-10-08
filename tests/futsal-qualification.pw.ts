import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'public');
function tournament() {
  const teams = Array.from({ length: 24 }, (_, index) => ({
    id: `team-${index + 1}`,
    team_name: `Company ${index + 1}`,
    logo_url: null,
    group_code: 'ABCDEF'[Math.floor(index / 4)],
    players: [],
  }));
  const groups = [...'ABCDEF'].map((code) => ({
    code,
    table: teams
      .filter((team) => team.group_code === code)
      .map((team, index) => ({
        ...team,
        position: index + 1,
        played: 3,
        wins: 3 - index,
        draws: 0,
        losses: index,
        goals_for: 3 - index,
        goals_against: index,
        goal_difference: 3 - 2 * index,
        points: 9 - 3 * index,
      })),
    matches: Array.from({ length: 6 }, (_, index) => ({
      id: `${code}-${index}`,
      stage: 'group',
      group_code: code,
      status: 'completed',
      home_team_id: teams.find((team) => team.group_code === code)!.id,
      away_team_id: teams.filter((team) => team.group_code === code)[1].id,
      home_score: 1,
      away_score: 0,
    })),
  }));
  return {
    teams,
    groups,
    bracket: [],
    third_place: {
      table: groups.map((group, index) => ({
        ...group.table[2],
        position: index + 1,
        qualified: false,
        draw_pending: true,
      })),
      complete: true,
      draw_required: true,
      draw_applied: false,
      signature: 'current-standings',
    },
  };
}
async function serve(page: Page, data: ReturnType<typeof tournament>, saved: unknown[]) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/admin/me')
      return route.fulfill({ json: { name: 'Organizer', role: 'super_admin' } });
    if (url.pathname === '/admin/futsal' || url.pathname === '/futsal/data')
      return route.fulfill({ json: data });
    if (url.pathname === '/futsal/live') return route.fulfill({ json: null });
    if (url.pathname === '/admin/futsal/third-place-draw') {
      saved.push(route.request().postDataJSON());
      data.third_place.draw_required = false;
      return route.fulfill({ json: { created: true } });
    }
    const file =
      url.pathname === '/admin'
        ? 'admin.html'
        : url.pathname === '/futsal'
          ? 'futsal.html'
          : url.pathname.replace(/^\/assets\//, '');
    const body = await readFile(path.join(root, file)).catch(() => null);
    if (!body) return route.fulfill({ status: 404, body: 'missing' });
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.webp': 'image/webp',
      '.png': 'image/png',
    };
    return route.fulfill({
      body,
      contentType: types[path.extname(file)] ?? 'application/octet-stream',
    });
  });
}

test('organizer records the tied teams in draw order and rejects duplicates', async ({ page }) => {
  const data = tournament();
  const saved: unknown[] = [];
  await serve(page, data, saved);
  await page.goto('/admin#futsal');
  const form = page.locator('[data-third-place-draw]');
  await expect(form).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Third-place qualification' })).toBeVisible();
  const choices = form.locator('select');
  await expect(choices).toHaveCount(6);
  const ids = data.third_place.table.map((row) => row.id);
  await choices.nth(0).selectOption(ids[1]);
  await form.getByRole('button').click();
  await expect(page.getByRole('status')).toHaveText('Select each tied team exactly once.');
  expect(saved).toHaveLength(0);
  for (let index = 0; index < 6; index++) await choices.nth(index).selectOption(ids[5 - index]);
  await form.getByRole('button').click();
  await expect(page.getByRole('status')).toHaveText(
    'Manual draw recorded. The 16-team bracket is ready.',
  );
  expect(saved).toEqual([{ team_ids: [...ids].reverse(), signature: data.third_place.signature }]);
  await expect(page.locator('[data-third-place-draw]')).toHaveCount(0);
});

test('public page shows pending draw status without declaring tied teams qualified', async ({
  page,
}) => {
  await serve(page, tournament(), []);
  await page.goto('/futsal');
  const ranking = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Third-place qualification' }) });
  await expect(ranking.getByRole('cell', { name: 'Draw pending', exact: true })).toHaveCount(6);
  await expect(ranking.locator('.qualified-team')).toHaveCount(0);
  await expect(ranking).toContainText('A manual draw will decide the remaining qualifying spots.');
});

test('public page highlights four third-place qualifiers on mobile and in their groups', async ({
  page,
}) => {
  const data = tournament();
  data.third_place.draw_required = false;
  data.third_place.draw_applied = true;
  data.third_place.table.forEach((row, index) => {
    row.qualified = index < 4;
    row.draw_pending = false;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await serve(page, data, []);
  await page.goto('/futsal');
  const ranking = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Third-place qualification' }) });
  await expect(ranking.locator('.qualified-team')).toHaveCount(4);
  await expect(ranking.getByRole('cell', { name: 'Eliminated', exact: true })).toHaveCount(2);
  await page.locator('.group-stage summary').click();
  await expect(page.locator('.groups .qualified-team')).toHaveCount(16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
