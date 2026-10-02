import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// The roster export runs entirely in the browser, so this suite serves public/
// from disk and stubs the API instead of driving the real backend.
const root = path.resolve(import.meta.dirname, '..');
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

type Order = Record<string, unknown>;

function order(players: string[], sizes: (string | null)[], photos: (string | null)[]) {
  return {
    id: 'order-1',
    status: 'paid',
    company_name: 'Valley Strikers Pvt Ltd',
    company_locked: false,
    resume_step: 'team_profile',
    payment_request: null,
    rejection: null,
    items: [
      {
        id: 'item-1',
        team_name: 'Valley Strikers',
        sport_name: 'Basketball',
        logo_url: 'team-logos/logo.webp',
        players,
        jersey_sizes: sizes,
        photo_urls: photos,
        captain_position: 0,
      },
    ],
  } satisfies Order;
}

async function openProfile(page: any, status: Order, photos: Record<string, Buffer>) {
  // Reaching the editor through the hash also fires popstate, and the app's
  // popstate handler re-runs register(), which replaces the editor again.
  await page.addInitScript(() => {
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: any[]) =>
      type === 'popstate' ? undefined : (add as any)(type, ...rest)) as typeof add;
  });
  await page.route('**/*', async (route: any) => {
    const url = new URL(route.request().url());
    const file =
      url.pathname === '/' || url.pathname === '/register'
        ? 'index.html'
        : url.pathname.startsWith('/assets/')
          ? url.pathname.slice('/assets/'.length)
          : url.pathname.slice(1);
    if (file === 'sports')
      return route.fulfill({ json: [{ id: 's1', name: 'Basketball', price: 1 }] });
    if (file === 'site-settings') return route.fulfill({ json: {} });
    if (file === 'orders/current') return route.fulfill({ json: status });
    const photo = /player-photos\/(\d+)$/.exec(file);
    if (photo) {
      const body = photos[photo[1]];
      if (!body) return route.fulfill({ status: 404, body: 'no photo' });
      return route.fulfill({ body, contentType: 'image/png' });
    }
    if (!file.includes('.')) return route.fulfill({ status: 404, body: 'missing' });
    const body = await readFile(path.join(root, 'public', file)).catch(() => null);
    if (!body) return route.fulfill({ status: 404, body: 'missing' });
    return route.fulfill({
      body,
      contentType: contentTypes[path.extname(file)] ?? 'application/octet-stream',
    });
  });
  await page.goto('/register');
  await page.locator('a[href="#profile/item-1"]').waitFor();
  await page.evaluate(() => {
    location.hash = '#profile/item-1';
  });
  await page.waitForSelector('#player-fields .player-row');
}

const portrait = (background: string, width = 600, height = 800) =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();

async function exportPdf(page: any) {
  await expect(page.locator('#export-pdf')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.locator('#export-pdf').click();
  const file = await download;
  const buffer = await readFile(await file.path());
  return { name: file.suggestedFilename(), pdf: buffer.toString('latin1') };
}

test('exports a PDF named after the company with names, photos and jersey sizes', async ({
  page,
}) => {
  await openProfile(
    page,
    order(['Suman Karki', 'Pratik Gurung', 'Aarav Shah'], ['S', 'M', 'XL'], ['a', 'b', 'c']),
    {
      '0': await portrait('#c0392b'),
      '1': await portrait('#27ae60'),
      '2': await portrait('#2980b9'),
    },
  );

  const { name, pdf } = await exportPdf(page);

  expect(name).toBe('Valley Strikers Pvt Ltd.pdf');
  await expect(page.getByRole('status')).toHaveText('Team PDF downloaded.');
  expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  expect(pdf).toContain('/Count 1');
  for (const player of ['Suman Karki', 'Pratik Gurung', 'Aarav Shah'])
    expect(pdf).toContain(`(${player}) Tj`);
  for (const size of ['(S) Tj', '(M) Tj', '(XL) Tj']) expect(pdf).toContain(size);
  expect(pdf).toContain('(Valley Strikers Pvt Ltd) Tj');
  expect(pdf).toContain('(Valley Strikers · Basketball) Tj');
  expect(pdf).toContain('(Captain) Tj');
  // One photo per player, each embedded as a JPEG the PDF can draw directly.
  expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(3);
  expect(pdf.match(/\/Filter \/DCTDecode/g)).toHaveLength(3);
  expect(pdf).toContain('(Page 1 of 1) Tj');
});

test('still exports the roster when a photo cannot be read', async ({ page }) => {
  // Player 1's stored photo cannot be read; player 2's can.
  await openProfile(page, order(['Renée Ångström', 'Pratik (Gurung)'], ['M', null], ['a', 'b']), {
    '1': await portrait('#27ae60'),
  });

  const { pdf } = await exportPdf(page);

  await expect(page.getByRole('status')).toHaveText(
    'Team PDF downloaded. 1 photo could not be included.',
  );
  expect(pdf).toContain('(Renée Ångström) Tj');
  // Parentheses are escaped and a missing size is shown as a dash.
  expect(pdf).toContain('(Pratik \\(Gurung\\)) Tj');
  expect(pdf).toContain('(-) Tj');
  expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(1);
});

test('splits a long roster across pages', async ({ page }) => {
  const players = Array.from({ length: 21 }, (_, index) => `Player Name ${index + 1}`);
  const photos = Object.fromEntries(
    await Promise.all(
      players.map((_, index) =>
        portrait(index % 2 ? '#27ae60' : '#c0392b', 300, 300).then((body) => [String(index), body]),
      ),
    ),
  );
  await openProfile(
    page,
    order(
      players,
      players.map(() => 'XL'),
      players.map(() => 'a'),
    ),
    photos,
  );

  const { pdf } = await exportPdf(page);

  expect(pdf).toContain('/Count 3');
  expect(pdf).toContain('(Player Name 1) Tj');
  expect(pdf).toContain('(Player Name 21) Tj');
  expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(21);
  for (const page of ['(Page 1 of 3) Tj', '(Page 2 of 3) Tj', '(Page 3 of 3) Tj'])
    expect(pdf).toContain(page);
});

test('explains an empty roster instead of downloading', async ({ page }) => {
  await openProfile(page, order(['', '', ''], [null, null, null], [null, null, null]), {});

  await page.locator('#export-pdf').click();

  await expect(page.locator('#profile-form .error')).toHaveText(
    'Add a player before exporting the team profile.',
  );
});

test('includes a photo the captain picked but has not saved', async ({ page }) => {
  await openProfile(
    page,
    order(['Suman Karki', 'Pratik Gurung'], ['S', 'M'], ['a', 'b']),
    // Neither saved photo is readable, so only the local pick can be embedded.
    {},
  );
  await page
    .locator('.player-row')
    .first()
    .locator('input[type="file"]')
    .setInputFiles({
      name: 'me.png',
      mimeType: 'image/png',
      buffer: await portrait('#8e44ad', 900, 1200),
    });

  const { pdf } = await exportPdf(page);

  expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(1);
  expect(pdf).toContain('(Suman Karki) Tj');
});

// The organizer team page runs the same export against the saved roster.
function adminTeam(players: string[], sizes: (string | null)[], photos: (string | null)[]) {
  return {
    id: 'order-1',
    team_name: 'Valley Strikers Pvt Ltd',
    status: 'completed',
    created_at: '2026-01-02T03:04:05.000Z',
    phone: '+977 9800000000',
    contact: { name: 'Anish Shrestha', email: 'captain@example.com', phone: null },
    items: [
      {
        id: 'item-1',
        team_name: 'Valley Strikers',
        sport_name: 'Basketball',
        logo_url: 'team-logos/logo.webp',
        players,
        jersey_sizes: sizes,
        photo_urls: photos,
        captain_position: 1,
        profile_completed_at: '2026-01-03T00:00:00.000Z',
      },
    ],
  };
}

async function openTeam(page: any, team: unknown, photos: Record<string, Buffer>) {
  await page.route('**/*', async (route: any) => {
    const url = new URL(route.request().url());
    const file =
      url.pathname === '/admin'
        ? 'admin.html'
        : url.pathname.startsWith('/assets/')
          ? url.pathname.slice('/assets/'.length)
          : url.pathname.slice(1);
    if (file === 'admin/me')
      return route.fulfill({ json: { name: 'Anish Shrestha', role: 'super_admin' } });
    if (file === 'admin/teams/order-1') return route.fulfill({ json: team });
    const photo = /player-photos\/(\d+)$/.exec(file);
    if (photo) {
      const body = photos[photo[1]];
      if (!body) return route.fulfill({ status: 404, body: 'no photo' });
      return route.fulfill({ body, contentType: 'image/png' });
    }
    if (!file.includes('.')) return route.fulfill({ status: 404, body: 'missing' });
    const body = await readFile(path.join(root, 'public', file)).catch(() => null);
    if (!body) return route.fulfill({ status: 404, body: 'missing' });
    return route.fulfill({
      body,
      contentType: contentTypes[path.extname(file)] ?? 'application/octet-stream',
    });
  });
  await page.goto('/admin#team/order-1');
  await page.locator('[data-export-roster]').waitFor();
}

async function exportTeamPdf(page: any) {
  const download = page.waitForEvent('download');
  await page.locator('[data-export-roster]').click();
  const file = await download;
  const buffer = await readFile(await file.path());
  return { name: file.suggestedFilename(), pdf: buffer.toString('latin1') };
}

test('exports the saved roster from the organizer team page', async ({ page }) => {
  await openTeam(
    page,
    adminTeam(['Suman Karki', 'Pratik Gurung', 'Aarav Shah'], ['S', 'M', 'XL'], ['a', 'b', 'c']),
    {
      '0': await portrait('#c0392b'),
      '1': await portrait('#27ae60'),
      '2': await portrait('#2980b9'),
    },
  );

  const { name, pdf } = await exportTeamPdf(page);

  expect(name).toBe('Valley Strikers Pvt Ltd.pdf');
  await expect(page.getByRole('status')).toHaveText('Team PDF downloaded.');
  expect(pdf).toContain('(Valley Strikers Pvt Ltd) Tj');
  expect(pdf).toContain('(Valley Strikers · Basketball) Tj');
  for (const player of ['Suman Karki', 'Pratik Gurung', 'Aarav Shah'])
    expect(pdf).toContain(`(${player}) Tj`);
  for (const size of ['(S) Tj', '(M) Tj', '(XL) Tj']) expect(pdf).toContain(size);
  expect(pdf).toContain('(Captain) Tj');
  expect(pdf.match(/\/Filter \/DCTDecode/g)).toHaveLength(3);
});

test('marks the captain from the saved roster on the organizer team page', async ({ page }) => {
  // captain_position is 1, so the Captain label must sit beside Pratik, not Suman.
  await openTeam(page, adminTeam(['Suman Karki', 'Pratik Gurung'], ['S', 'M'], [null, null]), {});

  const { pdf } = await exportTeamPdf(page);

  // A row prints its name and then its role, so the label follows its captain.
  expect(pdf.match(/\(Captain\) Tj/g) ?? []).toHaveLength(1);
  expect(pdf.indexOf('(Captain) Tj')).toBeGreaterThan(pdf.indexOf('(Pratik Gurung) Tj'));
  expect(pdf.match(/\/Subtype \/Image/g) ?? []).toHaveLength(0);
  expect(pdf).toContain('(Page 1 of 1) Tj');
});

test('exports organizer roster edits that are not saved yet', async ({ page }) => {
  await openTeam(page, adminTeam(['Suman Karki', 'Pratik Gurung'], ['S', 'M'], [null, null]), {});
  await page.getByRole('button', { name: 'Edit roster' }).click();
  const name = page.locator('.roster-editor input[name="player"]').first();
  await name.fill('Suman Karki edited');
  await page
    .locator('.roster-editor .player-row')
    .first()
    .locator('input[type="file"]')
    .setInputFiles({
      name: 'me.png',
      mimeType: 'image/png',
      buffer: await portrait('#8e44ad'),
    });

  const { pdf } = await exportTeamPdf(page);

  expect(pdf).toContain('(Suman Karki edited) Tj');
  expect(pdf.match(/\/Filter \/DCTDecode/g)).toHaveLength(1);
});

test('does not offer an export for a team with no players yet', async ({ page }) => {
  await openTeam(page, adminTeam([], [], []), {});

  await expect(page.locator('.roster-view')).toContainText('No team members added yet');
  await expect(page.locator('[data-export-roster]')).toBeDisabled();
});
