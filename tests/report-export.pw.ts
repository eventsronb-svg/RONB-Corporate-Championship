import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// The report PDF is built in the browser, so this suite serves public/ from
// disk and stubs the API instead of driving the real backend, the same way
// export.pw.ts covers the roster export.
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

const teamName = (index: number) => `Surkhund Events ${String(index).padStart(2, '0')}`;

const teams = Array.from({ length: 8 }, (_, index) => ({
  id: `team-${index + 1}`,
  team_name: teamName(index + 1),
  logo_url: null,
  group_code: 'ABCDEFGH'[index],
  players: [],
}));

function match(
  id: string,
  stage: string,
  group: string | null,
  home: number,
  away: number,
  status: string,
  score: [number, number] = [0, 0],
) {
  return {
    id,
    stage,
    group_code: group,
    bracket_position: null,
    group_position: null,
    home_team_id: `team-${home}`,
    away_team_id: `team-${away}`,
    home_score: score[0],
    away_score: score[1],
    status,
    version: 1,
  };
}

// A finished futsal tournament: every group fixture and the whole bracket done,
// so both report buttons unlock.
function finishedFutsal() {
  return {
    teams,
    groups: Array.from({ length: 8 }, (_, group) => ({
      code: 'ABCDEFGH'[group],
      table: [],
      matches: [
        match(
          `g-${group}-1`,
          'group',
          'ABCDEFGH'[group],
          (group % 8) + 1,
          ((group + 1) % 8) + 1,
          'completed',
          [3, 1],
        ),
        match(
          `g-${group}-2`,
          'group',
          'ABCDEFGH'[group],
          ((group + 2) % 8) + 1,
          ((group + 3) % 8) + 1,
          'completed',
          [2, 2],
        ),
      ],
    })),
    bracket: [
      match('k-1', 'prequarter', null, 1, 2, 'completed', [3, 3]),
      match('k-2', 'prequarter', null, 3, 4, 'completed', [1, 0]),
      match('k-3', 'quarter', null, 1, 3, 'completed', [2, 1]),
      match('k-4', 'quarter', null, 2, 4, 'completed', [4, 0]),
      match('k-5', 'semi', null, 1, 3, 'completed', [2, 2]),
      match('k-6', 'final', null, 1, 2, 'completed', [1, 0]),
    ],
  };
}

// One group fixture still to play and no bracket drawn yet.
function unfinishedFutsal() {
  const view = finishedFutsal();
  const pending = view.groups[0].matches[1];
  pending.status = 'scheduled';
  pending.home_score = 0;
  pending.away_score = 0;
  view.bracket = [];
  return view;
}

const groupReport = {
  sport: 'futsal',
  stage: 'group',
  title: 'RONB Corporate Championship 2026',
  sections: [
    {
      label: 'Group A',
      matches: [
        {
          home_team: teamName(1),
          away_team: teamName(2),
          home_score: 3,
          away_score: 1,
          status: 'completed',
          home_scorers: [
            { player_name: 'Ramesh Magar', goals: 2 },
            { player_name: 'Bishal Thapa', goals: 1 },
          ],
          away_scorers: [{ player_name: 'Nabin Gurung', goals: 1 }],
          penalty_winner: null,
        },
        {
          home_team: teamName(3),
          away_team: teamName(4),
          home_score: 2,
          away_score: 2,
          status: 'completed',
          home_scorers: [],
          away_scorers: [],
          penalty_winner: null,
        },
      ],
    },
    {
      label: 'Group B',
      matches: [
        {
          home_team: teamName(5),
          away_team: teamName(6),
          home_score: 0,
          away_score: 1,
          status: 'completed',
          home_scorers: [],
          away_scorers: [{ player_name: 'Aayush Tamang', goals: 1 }],
          penalty_winner: null,
        },
      ],
    },
  ],
};

const knockoutReport = {
  sport: 'futsal',
  stage: 'knockout',
  title: 'RONB Corporate Championship 2026',
  sections: [
    {
      label: 'Round of 16',
      matches: [
        {
          home_team: teamName(1),
          away_team: teamName(2),
          home_score: 3,
          away_score: 3,
          status: 'completed',
          home_scorers: [{ player_name: 'Ramesh Magar', goals: 3 }],
          away_scorers: [{ player_name: 'Nabin Gurung', goals: 2 }],
          penalty_winner: teamName(1),
        },
      ],
    },
    {
      label: 'Final',
      matches: [
        {
          home_team: teamName(7),
          away_team: teamName(8),
          home_score: 2,
          away_score: 0,
          status: 'completed',
          home_scorers: [{ player_name: 'Suman Thapa', goals: 2 }],
          away_scorers: [],
          penalty_winner: null,
        },
      ],
    },
  ],
};

async function openFutsal(page: any, view: unknown, reports: Record<string, unknown>) {
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
    if (file === 'admin/futsal') return route.fulfill({ json: view });
    if (file === 'admin/futsal/report') {
      const stage = url.searchParams.get('stage') ?? 'group';
      const payload = reports[stage];
      if (!payload)
        return route.fulfill({ status: 400, json: { error: { message: 'Unknown stage' } } });
      return route.fulfill({ json: payload });
    }
    if (!file.includes('.')) return route.fulfill({ status: 404, body: 'missing' });
    const body = await readFile(path.join(root, 'public', file)).catch(() => null);
    if (!body) return route.fulfill({ status: 404, body: 'missing' });
    return route.fulfill({
      body,
      contentType: contentTypes[path.extname(file)] ?? 'application/octet-stream',
    });
  });
  await page.goto('/admin#futsal');
  await page.locator('[data-report="group"]').waitFor();
}

async function exportReport(page: any, stage: 'group' | 'knockout') {
  const download = page.waitForEvent('download');
  await page.locator(`[data-report="${stage}"]`).click();
  const file = await download;
  const buffer = await readFile(await file.path());
  return { name: file.suggestedFilename(), pdf: buffer.toString('latin1') };
}

test('downloads the group stage report from the futsal view', async ({ page }) => {
  await openFutsal(page, finishedFutsal(), { group: groupReport, knockout: knockoutReport });

  const { name, pdf } = await exportReport(page, 'group');

  expect(name).toBe('Futsal group stage report.pdf');
  await expect(page.getByRole('status')).toHaveText('Group stage report PDF downloaded.');
  expect(pdf).toContain('(RONB Corporate Championship 2026) Tj');
  expect(pdf).toContain('(Futsal · Group stage report) Tj');
  expect(pdf).toContain('(Group A) Tj');
  expect(pdf).toContain('(Group B) Tj');
  expect(pdf).toContain(`(${teamName(1)} vs ${teamName(2)}) Tj`);
  expect(pdf).toContain('(3 - 1) Tj');
  // Credits print per team: the roster player who did not score stays off.
  expect(pdf).toContain('Ramesh Magar \\(2\\), Bishal Thapa \\(1\\)');
  expect(pdf).toContain(`${teamName(2)}: Nabin Gurung \\(1\\)`);
  expect(pdf).toContain('(Page 1 of 1) Tj');
});

test('downloads the knockout report with the penalty winner', async ({ page }) => {
  await openFutsal(page, finishedFutsal(), { group: groupReport, knockout: knockoutReport });

  const { name, pdf } = await exportReport(page, 'knockout');

  expect(name).toBe('Futsal knockout report.pdf');
  await expect(page.getByRole('status')).toHaveText('Knockout report PDF downloaded.');
  expect(pdf).toContain('(Futsal · Knockout report) Tj');
  expect(pdf).toContain('(Round of 16) Tj');
  expect(pdf).toContain('(Final) Tj');
  expect(pdf).toContain(`(${teamName(1)} vs ${teamName(2)}) Tj`);
  expect(pdf).toContain('(3 - 3) Tj');
  expect(pdf).toContain(`Penalty winner: ${teamName(1)}`);
  expect(pdf).toContain('(Page 1 of 1) Tj');
});

test('holds both report buttons until their stage is finished', async ({ page }) => {
  await openFutsal(page, unfinishedFutsal(), { group: groupReport, knockout: knockoutReport });

  const group = page.locator('[data-report="group"]');
  const knockout = page.locator('[data-report="knockout"]');
  await expect(group).toBeDisabled();
  await expect(group).toHaveAttribute('title', 'Complete every group match first');
  await expect(knockout).toBeDisabled();
  await expect(knockout).toHaveAttribute('title', 'Finish the knockout bracket first');
});
