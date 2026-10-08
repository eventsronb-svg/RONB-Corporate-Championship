import {
  test,
  expect,
  request as requests,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';
import sharp from 'sharp';

type Sport = {
  id: string;
  name: string;
  price: string;
  max_teams: number;
  filled_slots: number;
  listed_slots: number;
};
const formats = [
  {
    name: 'Futsal',
    slug: 'futsal',
    prefix: 'futsal',
    count: 24,
    players: 5,
    codes: 'ABCDEF',
    fixtures: 36,
  },
  {
    name: 'Cricksal',
    slug: 'cricket',
    prefix: 'cricket',
    count: 16,
    players: 7,
    codes: 'ABCD',
    fixtures: 24,
  },
  {
    name: 'Basketball',
    slug: 'basketball',
    prefix: 'basket',
    count: 16,
    players: 3,
    codes: 'ABCD',
    fixtures: 24,
  },
];
async function json(response: APIResponse, status = 200): Promise<any> {
  expect(response.status(), `${response.url()}: ${await response.text()}`).toBe(status);
  return response.json();
}
async function prepare(client: APIRequestContext, sportId: string, name: string) {
  const order = await json(await client.post('/orders/draft'));
  await json(
    await client.patch(`/orders/${order.id}/sports`, {
      data: { company_name: name, sports: [{ sport_id: sportId }] },
    }),
  );
  await json(
    await client.post(`/orders/${order.id}/phone`, { data: { phone_number: '9800000000' } }),
  );
  return order.id as string;
}

test('registration, full sports, group ties, third-place draw, and all knockout rounds', async ({
  browser,
  baseURL,
}, testInfo) => {
  const admin = await browser.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL! } });
  await admin.addCookies([{ name: 'admin_session', value: 'admin', url: baseURL }]);
  const page = await admin.newPage();
  const publicPage = await admin.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  publicPage.on('pageerror', (error) => errors.push(error.message));
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#be1830' } })
    .png()
    .toBuffer();
  const upload = { name: 'player.png', mimeType: 'image/png', buffer: png };
  await admin.route('https://*.example/**', (route) =>
    route.fulfill({ body: png, contentType: 'image/png' }),
  );
  const clients: APIRequestContext[] = [];
  async function captain() {
    const { token } = await json(await admin.request.post('/__test/captain'));
    const client = await requests.newContext({
      baseURL,
      extraHTTPHeaders: { origin: baseURL!, cookie: `session=${token}` },
    });
    clients.push(client);
    return { token, client };
  }
  try {
    const sports: Sport[] = await json(await admin.request.get('/sports'));
    for (const format of formats) {
      const sport = sports.find((value) => value.name === format.name)!;
      await json(
        await admin.request.patch(`/admin/sports/${sport.id}`, {
          data: {
            name: sport.name,
            price: Number(sport.price),
            max_teams: format.count,
            active: true,
          },
        }),
      );
    }
    await test.step('Register and complete 56 real teams, including all 280 player profiles', async () => {
      for (const format of formats) {
        const sport = sports.find((value) => value.name === format.name)!;
        // A captain with an already prepared draft competes for the last slot.
        const contender = await captain();
        const staleOrderId = await prepare(contender.client, sport.id, `${format.name} Overflow`);
        for (let index = 0; index < format.count; index++) {
          const { client } = await captain();
          const name = `${format.name} Company ${String(index + 1).padStart(2, '0')}`;
          const orderId = await prepare(client, sport.id, name);
          const invoice = await json(await client.post(`/orders/${orderId}/invoice`));
          expect(invoice.items).toHaveLength(1);
          await json(await client.post(`/orders/${orderId}/payment-request`));
          await json(
            await client.post(`/orders/${orderId}/receipt`, {
              multipart: { receipt: { name: upload.name, mimeType: upload.mimeType, buffer: png } },
            }),
          );
          const paid = await json(
            await admin.request.post(`/admin/orders/${orderId}/verify`, {
              data: { decision: 'confirmed' },
            }),
          );
          const item = paid.items[0];
          const path = `/orders/${orderId}/items/${item.id}/profile`;
          expect((await client.post(`${path}/complete`)).status()).toBe(409);
          const players = Array.from(
            { length: format.players },
            (_, position) => `${name} Player ${position + 1}`,
          );
          await json(
            await client.patch(path, {
              multipart: {
                logo: { name: upload.name, mimeType: upload.mimeType, buffer: png },
                players: JSON.stringify(players),
                jersey_sizes: JSON.stringify(players.map(() => 'M')),
                ...(format.slug === 'cricket'
                  ? { jersey_style: JSON.stringify('full_sleeve') }
                  : {}),
              },
            }),
          );
          expect((await client.post(`${path}/complete`)).status()).toBe(409);
          const photos: string[] = [];
          for (let position = 0; position < format.players; position++) {
            const photo = await json(
              await client.post(`/orders/${orderId}/items/${item.id}/player-photos/${position}`, {
                multipart: { photo: { name: upload.name, mimeType: upload.mimeType, buffer: png } },
              }),
            );
            photos.push(photo.photo_url);
          }
          await json(
            await client.patch(path, {
              data: {
                players,
                jersey_sizes: players.map(() => 'M'),
                player_photos: photos,
                captain_position: 0,
              },
            }),
          );
          await json(await client.post(`${path}/complete`));
          const persisted = await json(await client.get(`/orders/${orderId}/status`));
          expect(persisted.items[0].profile_completed_at).toBeTruthy();
          expect(persisted.items[0].players).toHaveLength(format.players);
          const capacity = (await json(await admin.request.get('/sports'))).find(
            (value: Sport) => value.id === sport.id,
          );
          expect(capacity.filled_slots).toBe(index + 1);
          expect(capacity.listed_slots).toBe(index + 1);
        }
        const blocked = await json(
          await contender.client.post(`/orders/${staleOrderId}/invoice`),
          409,
        );
        expect(blocked.error).toBe('sport_full');
        const observer = await captain();
        const context = await browser.newContext({ baseURL });
        await context.addCookies([{ name: 'session', value: observer.token, url: baseURL }]);
        const registration = await context.newPage();
        registration.on('pageerror', (error) => errors.push(error.message));
        await registration.goto('/register');
        const fullChoice = registration.locator('.sport-choice').filter({
          has: registration.locator('strong', { hasText: new RegExp(`^${format.name}$`) }),
        });
        await expect(fullChoice.locator('[name="sport"]')).toBeDisabled();
        await expect(fullChoice).toContainText('Slots Full!');
        for (const other of formats.slice(formats.indexOf(format) + 1)) {
          await expect(
            registration.getByRole('radio', { name: new RegExp(`^${other.name} `) }),
          ).toBeEnabled();
        }
        await registration.screenshot({
          path: testInfo.outputPath(`${format.slug}-registration-full.png`),
          fullPage: true,
        });
        await context.close();
        console.info(
          `[tournament] ${format.name}: ${format.count} completed registrations; overflow blocked in API and browser`,
        );
      }
      const evidence = await json(await admin.request.get('/__test/evidence'));
      expect(
        evidence.registrations.map((row: any) => [
          row.name,
          row.teams,
          row.confirmed,
          row.completed_profiles,
        ]),
      ).toEqual([
        ['Basketball', 16, 16, 16],
        ['Cricksal', 16, 16, 16],
        ['Futsal', 24, 24, 24],
      ]);
      expect(evidence.players).toEqual({ total: 280, complete: 280 });
    });

    await test.step('Import paid teams and assign every group through the organizer UI', async () => {
      for (const format of formats) {
        await page.goto(`/admin#${format.slug}`);
        await page.locator(`[data-${format.slug}="import"]`).click();
        await expect(page.getByRole('status')).toContainText('championship updated.');
        const data = await json(await admin.request.get(`/admin/${format.slug}`));
        expect(data.teams).toHaveLength(format.count);
        for (const [index, team] of data.teams.entries()) {
          await page
            .locator(`[data-${format.prefix}-group-select="${team.id}"]`)
            .selectOption(format.codes[Math.floor(index / 4)]);
          await page.locator(`[data-${format.prefix}-group-save="${team.id}"]`).click();
          if (index + 1 < format.count) {
            await expect(
              page.locator(
                `[data-${format.prefix}-group-panel=""] [data-${format.prefix}-group-select]`,
              ),
            ).toHaveCount(format.count - index - 1);
          }
          await expect(page.getByRole('status')).toContainText(
            index + 1 === format.count
              ? `${format.fixtures} group fixtures drawn.`
              : 'Group assignment saved.',
          );
        }
        const grouped = await json(await admin.request.get(`/admin/${format.slug}`));
        expect(grouped.groups).toHaveLength(format.codes.length);
        for (const group of grouped.groups) {
          expect(group.table).toHaveLength(4);
          expect(group.matches).toHaveLength(6);
          expect(
            new Set(group.matches.flatMap((match: any) => [match.home_team_id, match.away_team_id]))
              .size,
          ).toBe(4);
        }
        expect(grouped.bracket).toHaveLength(0);
        console.info(
          `[tournament] ${format.name}: ${format.codes.length} groups assigned; ${format.fixtures} fixtures generated`,
        );
        expect(
          (
            await admin.request.patch(`/admin/${format.slug}/teams/${data.teams[0].id}/group`, {
              data: { group_code: null },
            })
          ).status(),
        ).toBe(409);
      }
    });

    const scoredInBrowser = new Set<string>();
    async function playInBrowser(slug: string, match: any, home: number, away: number) {
      await page.goto(`/admin#${slug}`);
      const row = page.locator(`tr[data-match="${match.id}"]`);
      const data = await json(await admin.request.get(`/admin/${slug}`));
      const homeTeam = data.teams.find((team: any) => team.id === match.home_team_id);
      if (slug === 'cricket') await row.locator('[data-cricket-batting]').selectOption('away');
      await row.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(row.locator('[name="home_score"]')).toBeEnabled();
      if (slug === 'cricket') {
        await row.getByRole('button', { name: 'Swap batting' }).click();
        await expect(row.getByRole('button', { name: 'Swap batting' })).toHaveAttribute(
          'title',
          `Currently batting: ${homeTeam.team_name}`,
        );
        await row.locator('[name="home_wickets"]').fill('4');
        await row.locator('[name="away_wickets"]').fill('6');
        await row.locator('[name="home_overs"]').fill('9.4');
        await row.locator('[name="away_overs"]').fill('10');
      }
      await row.locator('[name="home_score"]').fill(String(home));
      await row.locator('[name="away_score"]').fill(String(away));
      await row.getByRole('button', { name: 'Save', exact: true }).click();
      const prompts = Number(home > 0) + Number(away > 0) + (slug === 'cricket' ? 10 : 0);
      for (let index = 0; index < prompts; index++) {
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        const response = page.waitForResponse(
          (value) =>
            value.request().method() === 'POST' &&
            /\/(scorers|wickets)$/.test(new URL(value.url()).pathname),
        );
        await dialog.locator('[data-scorer-player], [data-wicket-player]').first().click();
        expect((await response).status()).toBe(200);
      }
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const live = await json(await admin.request.get(`/${slug}/live`));
      expect(live.home_score).toBe(home);
      expect(live.away_score).toBe(away);
      const credit = slug === 'cricket' ? 'runs' : slug === 'basketball' ? 'points' : 'goals';
      expect(live.home_scorers.reduce((sum: number, value: any) => sum + value[credit], 0)).toBe(
        home,
      );
      if (slug === 'cricket') {
        expect(live.batting_side).toBe('home');
        expect(live.home_bowlers.reduce((sum: number, value: any) => sum + value.wickets, 0)).toBe(
          4,
        );
        expect(live.away_bowlers.reduce((sum: number, value: any) => sum + value.wickets, 0)).toBe(
          6,
        );
      }
      await publicPage.goto(`/${slug}/match`);
      await expect(publicPage.locator('.live-card')).toBeVisible();
      await expect(publicPage.locator('.live-scorers').first()).toContainText(
        homeTeam.players[0].player_name,
      );
      await publicPage.screenshot({
        path: testInfo.outputPath(`${slug}-live-player-credits.png`),
        fullPage: true,
      });
      if (home === away && slug === 'cricket')
        page.once('dialog', (dialog) => dialog.accept(homeTeam.team_name));
      await row.getByRole('button', { name: 'End match' }).click();
      await expect(page.getByRole('status')).toHaveText('Match completed and standings updated.');
      const done = await json(await admin.request.get(`/admin/${slug}`));
      const completed = done.groups
        .flatMap((group: any) => group.matches)
        .find((value: any) => value.id === match.id);
      expect(completed.status).toBe('completed');
      console.info(
        `[tournament] ${slug}: browser start/save/player credits/live scoreboard/end verified`,
      );
      return completed;
    }

    async function play(slug: string, match: any, home: number, away: number) {
      if (!scoredInBrowser.has(slug) && match.stage === 'group') {
        scoredInBrowser.add(slug);
        return playInBrowser(slug, match, home, away);
      }
      const started = await json(
        await admin.request.post(`/admin/${slug}/matches/${match.id}/start`, {
          data: slug === 'cricket' ? { batting_side: 'away' } : {},
        }),
      );
      if (slug === 'cricket') {
        expect(started.batting_side).toBe('away');
        const swapped = await json(
          await admin.request.post(`/admin/${slug}/matches/${match.id}/batting`, {
            data: { batting_side: 'home', version: started.version },
          }),
        );
        expect(swapped.batting_side).toBe('home');
        started.version = swapped.version;
      }
      const saved = await json(
        await admin.request.patch(`/admin/${slug}/matches/${match.id}`, {
          data: {
            home_score: home,
            away_score: away,
            version: started.version,
            ...(slug === 'cricket'
              ? { home_wickets: 4, away_wickets: 6, home_overs: 9.4, away_overs: 10 }
              : {}),
          },
        }),
      );
      const endBody = {
        version: saved.version,
        ...(slug === 'basketball' ? { home_score: home, away_score: away } : {}),
        ...(home === away && (slug === 'cricket' || match.stage !== 'group')
          ? { penalty_winner_id: match.home_team_id }
          : {}),
      };
      if (home === away && (slug === 'cricket' || match.stage !== 'group')) {
        expect(
          (
            await admin.request.post(`/admin/${slug}/matches/${match.id}/end`, {
              data: { ...endBody, penalty_winner_id: undefined },
            })
          ).status(),
        ).toBe(400);
      }
      return json(
        await admin.request.post(`/admin/${slug}/matches/${match.id}/end`, { data: endBody }),
      );
    }

    await test.step('Resolve a second/third points tie using head-to-head, then the third-place cutoff by manual draw', async () => {
      const data = await json(await admin.request.get('/admin/futsal'));
      const groupA = [
        [10, 0],
        [10, 0],
        [1, 1],
        [1, 1],
        [1, 0],
        [1, 0],
      ];
      for (const [groupIndex, group] of data.groups.entries()) {
        const margin = [1, 1, 1, 2, 2, 3][groupIndex];
        const base = groupIndex === 1 ? 1 : 0;
        for (const [index, match] of group.matches.entries()) {
          const [home, away] = groupIndex === 0 ? groupA[index] : [margin + base, base];
          await play('futsal', match, home, away);
          const current = await json(await admin.request.get('/admin/futsal'));
          if (!(groupIndex === 5 && index === 5)) expect(current.bracket).toHaveLength(0);
        }
      }
      const done = await json(await admin.request.get('/admin/futsal'));
      const table = done.groups[0].table;
      expect(table[1].points).toBe(table[2].points);
      expect(table[1].goal_difference).toBeLessThan(table[2].goal_difference);
      expect(table[1].id).toBe(data.groups[0].matches[5].home_team_id);
      expect(done.third_place.table.map((row: any) => row.group_code)).toEqual([
        'A',
        'B',
        'C',
        'D',
        'E',
        'F',
      ]);
      expect(done.third_place.draw_required).toBe(true);
      expect(done.third_place.table.filter((row: any) => row.qualified)).toHaveLength(3);
      expect(done.bracket).toHaveLength(0);
      await publicPage.goto('/futsal');
      await expect(publicPage.getByRole('cell', { name: 'Draw pending', exact: true })).toHaveCount(
        2,
      );
      await page.goto('/admin#futsal');
      // API-driven results were entered while this admin tab remained open.
      await page.reload();
      const form = page.locator('[data-third-place-draw]');
      await expect(form).toBeVisible();
      const pending = done.third_place.table.filter((row: any) => row.draw_pending);
      const picks = form.locator('select');
      await picks.nth(0).selectOption(pending[1].id);
      await form.getByRole('button').click();
      await expect(page.getByRole('status')).toHaveText('Select each tied team exactly once.');
      await picks.nth(1).selectOption(pending[0].id);
      await form.getByRole('button').click();
      await expect(page.getByRole('status')).toHaveText(
        'Manual draw recorded. The 16-team bracket is ready.',
      );
      const drawn = await json(await admin.request.get('/admin/futsal'));
      expect(
        drawn.third_place.table
          .filter((row: any) => row.qualified)
          .map((row: any) => row.group_code),
      ).toEqual(['A', 'B', 'C', 'E']);
      expect(drawn.bracket).toHaveLength(15);
      const r16 = drawn.bracket.filter((match: any) => match.stage === 'prequarter');
      const ids = r16.flatMap((match: any) => [match.home_team_id, match.away_team_id]);
      expect(new Set(ids).size).toBe(16);
      const expected = [
        ...drawn.groups.flatMap((group: any) => group.table.slice(0, 2).map((row: any) => row.id)),
        ...drawn.third_place.table.filter((row: any) => row.qualified).map((row: any) => row.id),
      ];
      expect(ids.sort()).toEqual(expected.sort());
      for (const match of r16)
        expect(drawn.teams.find((team: any) => team.id === match.home_team_id).group_code).not.toBe(
          drawn.teams.find((team: any) => team.id === match.away_team_id).group_code,
        );
      await publicPage.reload();
      await expect(publicPage.getByRole('cell', { name: 'Qualified', exact: true })).toHaveCount(4);
      await page.screenshot({
        path: testInfo.outputPath('futsal-manual-draw-resolved.png'),
        fullPage: true,
      });
    });

    await test.step('Complete cricket and basketball groups and verify eight qualifiers each', async () => {
      for (const slug of ['cricket', 'basketball']) {
        const data = await json(await admin.request.get(`/admin/${slug}`));
        for (const [groupIndex, group] of data.groups.entries())
          for (const [index, match] of group.matches.entries()) {
            await play(
              slug,
              match,
              slug === 'cricket' ? 100 : 2,
              slug === 'cricket' ? (index === 0 ? 100 : 90) : 1,
            );
            const current = await json(await admin.request.get(`/admin/${slug}`));
            if (!(groupIndex === 3 && index === 5)) expect(current.bracket).toHaveLength(0);
          }
        const done = await json(await admin.request.get(`/admin/${slug}`));
        expect(done.bracket).toHaveLength(7);
        const quarter = done.bracket.filter((match: any) => match.stage === 'quarter');
        expect(
          new Set(quarter.flatMap((match: any) => [match.home_team_id, match.away_team_id])).size,
        ).toBe(8);
        await publicPage.goto(`/${slug}`);
        await expect(publicPage.getByRole('heading', { name: 'Match bracket' })).toBeVisible();
      }
    });

    await test.step('Play all knockout rounds, reject undecided ties, and export final reports', async () => {
      for (const format of formats) {
        for (const stage of ['prequarter', 'quarter', 'semi', 'final']) {
          const data = await json(await admin.request.get(`/admin/${format.slug}`));
          for (const [index, match] of data.bracket
            .filter((value: any) => value.stage === stage)
            .entries()) {
            expect(match.home_team_id).toBeTruthy();
            expect(match.away_team_id).toBeTruthy();
            const ended = await play(format.slug, match, 2, index === 0 ? 2 : 1);
            expect(ended.winner_team_id).toBe(match.home_team_id);
          }
        }
        const done = await json(await admin.request.get(`/admin/${format.slug}`));
        expect(done.bracket.every((match: any) => match.status === 'completed')).toBe(true);
        expect(
          done.bracket.find((match: any) => match.stage === 'final').winner_team_id,
        ).toBeTruthy();
        const report = await json(
          await admin.request.get(`/admin/${format.slug}/report?stage=knockout`),
        );
        expect(report.sections.flatMap((section: any) => section.matches)).toHaveLength(
          format.slug === 'futsal' ? 15 : 7,
        );
      }
      expect((await json(await admin.request.get('/__test/evidence'))).draws).toHaveLength(1);
      expect(errors).toEqual([]);
    });
  } finally {
    for (const client of clients) await client.dispose();
    await admin.close();
  }
});
