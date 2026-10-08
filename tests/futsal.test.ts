import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

let h: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h?.close();
});

describe('futsal championship', () => {
  it('imports confirmed teams, generates group fixtures, and publishes a saved live score', async () => {
    await h.db.query("UPDATE sports SET name='Futsal' WHERE id=$1", [h.sports[0].id]);
    for (let index = 0; index < 24; index++) {
      const order = (
        await h.db.query("INSERT INTO orders(user_id,status) VALUES($1,'confirmed') RETURNING id", [
          h.user.id,
        ])
      ).rows[0];
      await h.db.query(
        'INSERT INTO order_items(order_id,sport_id,price_at_purchase,team_name,logo_url) VALUES($1,$2,0,$3,$4)',
        [
          order.id,
          h.sports[0].id,
          `Futsal Team ${String(index + 1).padStart(2, '0')}`,
          `https://logos.example/${index}.webp`,
        ],
      );
    }
    expect((await h.call('POST', '/admin/futsal/import', {}, 'admin')).json().total).toBe(24);
    // Groups are placed by hand, four teams at a time, and that placement order is
    // what the draw numbers a1 to a4.
    const placed = (await h.call('GET', '/admin/futsal', undefined, 'admin')).json().teams;
    expect(placed).toHaveLength(24);
    for (const [index, team] of placed.entries()) {
      const saved = await h.call(
        'PATCH',
        `/admin/futsal/teams/${team.id}/group`,
        { group_code: 'ABCDEF'[Math.floor(index / 4)] },
        'admin',
      );
      expect(saved.statusCode).toBe(200);
    }
    expect(
      (await h.call('POST', '/admin/futsal/generate-fixtures', {}, 'admin')).json().matches,
    ).toBe(36);
    const payload = (await h.call('GET', '/admin/futsal', undefined, 'staff')).json();
    const names = new Map<string, number>(
      payload.teams.slice(0, 4).map((team: any, index: number) => [team.id, index]),
    );
    // a1–a2 with a3–a4, then a1–a3 with a2–a4, then a1–a4 with a2–a3.
    expect(
      payload.groups[0].matches.map((match: any) => [
        names.get(match.home_team_id),
        names.get(match.away_team_id),
      ]),
    ).toEqual([
      [0, 1],
      [2, 3],
      [0, 2],
      [1, 3],
      [0, 3],
      [1, 2],
    ]);
    const first = payload.groups[0].matches[0];
    expect(
      (await h.call('POST', `/admin/futsal/matches/${first.id}/start`, {}, 'staff')).statusCode,
    ).toBe(200);
    const saved = await h.call(
      'PATCH',
      `/admin/futsal/matches/${first.id}`,
      { home_score: 2, away_score: 2, version: first.version + 1 },
      'staff',
    );
    expect(saved.statusCode).toBe(200);
    expect(
      (
        await h.call(
          'POST',
          `/admin/futsal/matches/${first.id}/end`,
          { version: saved.json().version },
          'staff',
        )
      ).statusCode,
    ).toBe(200);
    const live = await h.call('GET', '/futsal/data');
    expect(live.statusCode).toBe(200);
    expect(live.json().groups[0].table.reduce((sum: number, row: any) => sum + row.points, 0)).toBe(
      2,
    );

    // Fill the remaining group stage quickly, then ensure a pre-quarter winner
    // is placed into its quarterfinal automatically.
    await h.db.query(
      "UPDATE futsal_matches SET status='completed',home_score=ascii(group_code)-64,away_score=0,completed_at=now() WHERE stage='group' AND status <> 'completed'",
    );
    expect((await h.call('POST', '/admin/futsal/generate-knockout', {}, 'admin')).statusCode).toBe(
      200,
    );
    const bracket = (await h.call('GET', '/admin/futsal', undefined, 'staff')).json().bracket;
    const prequarter = bracket.find((match: any) => match.stage === 'prequarter');
    const quarter = bracket.find(
      (match: any) => match.stage === 'quarter' && match.bracket_position === 1,
    );
    const started = await h.call(
      'POST',
      `/admin/futsal/matches/${prequarter.id}/start`,
      {},
      'staff',
    );
    expect(started.statusCode).toBe(200);
    expect(
      (
        await h.call(
          'POST',
          `/admin/futsal/matches/${prequarter.id}/end`,
          { version: started.json().version, penalty_winner_id: prequarter.home_team_id },
          'staff',
        )
      ).statusCode,
    ).toBe(200);
    const refreshed = (await h.call('GET', '/admin/futsal', undefined, 'staff')).json().bracket;
    expect(refreshed.find((match: any) => match.id === quarter.id).home_team_id).toBe(
      prequarter.home_team_id,
    );
  });
});
