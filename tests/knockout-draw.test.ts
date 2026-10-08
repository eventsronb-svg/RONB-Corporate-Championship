import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

let h: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h?.close();
});

// One confirmed order per team, so the group draw has a full field.
async function seedTeams(count: number, sportId: string) {
  for (let index = 0; index < count; index++) {
    const order = (
      await h.db.query("INSERT INTO orders(user_id,status) VALUES($1,'confirmed') RETURNING id", [
        h.user.id,
      ])
    ).rows[0];
    await h.db.query(
      'INSERT INTO order_items(order_id,sport_id,price_at_purchase,team_name,logo_url) VALUES($1,$2,0,$3,$4)',
      [
        order.id,
        sportId,
        `Futsal Team ${String(index + 1).padStart(2, '0')}`,
        `https://logos.example/${index}.webp`,
      ],
    );
  }
}

describe('knockout draw', () => {
  it('creates the futsal 16-team bracket when the last group match ends', async () => {
    await h.db.query("UPDATE sports SET name='Futsal' WHERE id=$1", [h.sports[0].id]);
    await seedTeams(32, h.sports[0].id);
    expect((await h.call('POST', '/admin/futsal/import', {}, 'admin')).json().total).toBe(32);
    const teams = (await h.call('GET', '/admin/futsal', undefined, 'admin')).json().teams;
    for (const [index, team] of teams.entries())
      expect(
        (
          await h.call(
            'PATCH',
            `/admin/futsal/teams/${team.id}/group`,
            { group_code: 'ABCDEFGH'[Math.floor(index / 4)] },
            'admin',
          )
        ).statusCode,
      ).toBe(200);
    await h.call('POST', '/admin/futsal/generate-fixtures', {}, 'admin');
    const view = (await h.call('GET', '/admin/futsal', undefined, 'admin')).json();
    const last = view.groups[7].matches[5];

    // Forty-seven fixtures finish outside the API, the way seeds do, and no
    // bracket appears yet.
    await h.db.query(
      "UPDATE futsal_matches SET status='completed',home_score=1,away_score=0,completed_at=now() WHERE stage='group' AND id <> $1",
      [last.id],
    );
    expect((await h.call('GET', '/admin/futsal', undefined, 'admin')).json().bracket).toHaveLength(
      0,
    );

    // Ending the final group fixture draws the bracket in the same call, the
    // way basketball already does.
    const started = await h.call('POST', `/admin/futsal/matches/${last.id}/start`, {}, 'admin');
    expect(started.statusCode).toBe(200);
    const ended = await h.call(
      'POST',
      `/admin/futsal/matches/${last.id}/end`,
      { version: started.json().version },
      'admin',
    );
    expect(ended.statusCode).toBe(200);

    const bracket = (await h.call('GET', '/admin/futsal', undefined, 'admin')).json().bracket;
    expect(bracket).toHaveLength(15);
    expect(
      bracket.filter((match: any) => match.stage === 'prequarter').map((match: any) => match.stage),
    ).toHaveLength(8);
    expect(bracket.filter((match: any) => match.stage === 'quarter')).toHaveLength(4);
    expect(bracket.filter((match: any) => match.stage === 'semi')).toHaveLength(2);
    expect(bracket.filter((match: any) => match.stage === 'final')).toHaveLength(1);
    // The top two of every group fill the round of sixteen immediately.
    expect(
      bracket
        .filter((match: any) => match.stage === 'prequarter')
        .every((match: any) => match.home_team_id && match.away_team_id),
    ).toBe(true);

    // The bracket exists now, so a manual redraw reports the conflict instead
    // of doubling it.
    const manual = await h.call('POST', '/admin/futsal/generate-knockout', {}, 'admin');
    expect(manual.statusCode).toBe(409);
    expect(manual.json().error).toBe('bracket_exists');

    const audits = (
      await h.db.query("SELECT metadata FROM audit_logs WHERE action='futsal.bracket.generate'")
    ).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toEqual({ teams: 16, automatic: true });
  });
});
