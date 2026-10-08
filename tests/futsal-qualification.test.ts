import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

let h: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h?.close();
});

async function field() {
  await h.db.query("UPDATE sports SET name='Futsal' WHERE id=$1", [h.sports[0].id]);
  for (let index = 0; index < 24; index++) {
    const order = (
      await h.db.query("INSERT INTO orders(user_id,status) VALUES($1,'confirmed') RETURNING id", [
        h.user.id,
      ])
    ).rows[0];
    await h.db.query(
      'INSERT INTO order_items(order_id,sport_id,price_at_purchase,team_name) VALUES($1,$2,0,$3)',
      [order.id, h.sports[0].id, `Team ${String(index + 1).padStart(2, '0')}`],
    );
  }
  await h.call('POST', '/admin/futsal/import', {}, 'admin');
  const data = (await h.call('GET', '/futsal/data')).json();
  for (const [index, team] of data.teams.entries()) {
    expect(
      (
        await h.call(
          'PATCH',
          `/admin/futsal/teams/${team.id}/group`,
          { group_code: 'ABCDEF'[Math.floor(index / 4)] },
          'admin',
        )
      ).statusCode,
    ).toBe(200);
    // Keep score scenarios in a fixed placement order even when two fast API
    // assignments receive the same millisecond timestamp on native PostgreSQL.
    await h.db.query('UPDATE futsal_teams SET group_assigned_at=$2 WHERE id=$1', [
      team.id,
      new Date(Date.UTC(2026, 0, 1) + index),
    ]);
  }
  return data;
}
async function fixtures() {
  await field();
  expect(
    (await h.call('POST', '/admin/futsal/generate-fixtures', {}, 'admin')).json().matches,
  ).toBe(36);
  return (await h.call('GET', '/futsal/data')).json();
}
async function results(code: string, margin = 1, base = 0) {
  await h.db.query(
    "UPDATE futsal_matches SET status='completed',home_score=$2,away_score=$3 WHERE group_code=$1",
    [code, margin + base, base],
  );
}
async function view() {
  return (await h.call('GET', '/futsal/data')).json();
}
function checkBracket(data: any) {
  expect(data.bracket).toHaveLength(15);
  const first = data.bracket.filter((match: any) => match.stage === 'prequarter');
  expect(first).toHaveLength(8);
  const ids = first.flatMap((match: any) => [match.home_team_id, match.away_team_id]);
  expect(new Set(ids).size).toBe(16);
  const expected = [
    ...data.groups.flatMap((group: any) => group.table.slice(0, 2).map((row: any) => row.id)),
    ...data.third_place.table.filter((row: any) => row.qualified).map((row: any) => row.id),
  ];
  expect([...ids].sort()).toEqual(expected.sort());
  for (const match of first) {
    const home = data.teams.find((team: any) => team.id === match.home_team_id);
    const away = data.teams.find((team: any) => team.id === match.away_team_id);
    expect(home.group_code).not.toBe(away.group_code);
  }
}

describe('six-group futsal qualification', () => {
  it.each([
    {
      name: 'two teams with a drawn head-to-head use goal difference',
      scores: [
        [5, 0],
        [2, 0],
        [1, 0],
        [1, 0],
        [1, 0],
        [0, 0],
      ],
      second: 2,
    },
    {
      name: 'two teams equal on points and GD use goals scored',
      scores: [
        [1, 0],
        [1, 0],
        [3, 2],
        [1, 0],
        [1, 0],
        [0, 0],
      ],
      second: 2,
    },
    {
      name: 'an exact group tie keeps the alphabetical fallback',
      scores: [
        [1, 0],
        [1, 0],
        [1, 0],
        [1, 0],
        [1, 0],
        [0, 0],
      ],
      second: 1,
    },
    {
      name: 'three teams tied on points skip head-to-head and use GD',
      scores: [
        [1, 0],
        [5, 0],
        [1, 0],
        [0, 1],
        [1, 0],
        [1, 0],
      ],
      second: 2,
    },
    {
      name: 'three teams equal on points and GD use goals scored',
      scores: [
        [1, 0],
        [1, 0],
        [4, 3],
        [0, 1],
        [1, 0],
        [1, 0],
      ],
      second: 2,
    },
  ])('$name through live score and match completion routes', async ({ scores, second }) => {
    const data = await fixtures();
    const original = data.groups[0].table;
    for (const [index, match] of data.groups[0].matches.entries()) {
      const started = (
        await h.call('POST', `/admin/futsal/matches/${match.id}/start`, {}, 'staff')
      ).json();
      const saved = await h.call(
        'PATCH',
        `/admin/futsal/matches/${match.id}`,
        { home_score: scores[index][0], away_score: scores[index][1], version: started.version },
        'staff',
      );
      expect(saved.statusCode).toBe(200);
      expect(
        (
          await h.call(
            'POST',
            `/admin/futsal/matches/${match.id}/end`,
            { version: saved.json().version },
            'staff',
          )
        ).statusCode,
      ).toBe(200);
    }
    const done = await view();
    expect(done.groups[0].table[1].id).toBe(original[second].id);
    expect(done.groups[0].table[1].points).toBe(done.groups[0].table[2].points);
    expect(done.bracket).toHaveLength(0);
    expect(done.third_place.complete).toBe(false);
  });

  it.each([
    {
      name: 'GD decides the last third-place slot',
      margins: [1, 2, 3, 4, 5, 6],
      bases: [0, 0, 0, 0, 0, 0],
      draw: false,
      qualified: ['A', 'B', 'C', 'D'],
    },
    {
      name: 'goals scored decide the last third-place slot',
      margins: [1, 2, 3, 4, 4, 5],
      bases: [0, 0, 0, 0, 1, 0],
      draw: false,
      qualified: ['A', 'B', 'C', 'E'],
    },
    {
      name: 'five equal teams need a manual draw for four slots',
      margins: [1, 1, 1, 1, 1, 2],
      bases: [0, 0, 0, 0, 0, 0],
      draw: true,
      qualified: ['E', 'D', 'C', 'B'],
    },
    {
      name: 'three equal teams need a manual draw for the final slot',
      margins: [1, 2, 3, 4, 4, 4],
      bases: [0, 0, 0, 0, 0, 0],
      draw: true,
      qualified: ['A', 'B', 'C', 'F'],
    },
    {
      name: 'six equal third-place teams need a manual draw',
      margins: [1, 1, 1, 1, 1, 1],
      bases: [0, 0, 0, 0, 0, 0],
      draw: true,
      qualified: ['F', 'E', 'D', 'C'],
    },
  ])('$name through all 36 match completions', async ({ margins, bases, draw, qualified }) => {
    const data = await fixtures();
    for (const [groupIndex, group] of data.groups.entries()) {
      for (const match of group.matches) {
        const started = (
          await h.call('POST', `/admin/futsal/matches/${match.id}/start`, {}, 'staff')
        ).json();
        const saved = await h.call(
          'PATCH',
          `/admin/futsal/matches/${match.id}`,
          {
            home_score: margins[groupIndex] + bases[groupIndex],
            away_score: bases[groupIndex],
            version: started.version,
          },
          'staff',
        );
        expect(saved.statusCode).toBe(200);
        expect(
          (
            await h.call(
              'POST',
              `/admin/futsal/matches/${match.id}/end`,
              { version: saved.json().version },
              'staff',
            )
          ).statusCode,
        ).toBe(200);
      }
    }
    const done = await view();
    expect(done.third_place.draw_required).toBe(draw);
    if (draw) {
      expect(done.bracket).toHaveLength(0);
      const ordered = [...done.third_place.table];
      const pending = ordered.filter((row: any) => row.draw_pending).reverse();
      let index = 0;
      const ids = ordered.map((row: any) => (row.draw_pending ? pending[index++].id : row.id));
      expect(
        (
          await h.call(
            'POST',
            '/admin/futsal/third-place-draw',
            { team_ids: ids, signature: done.third_place.signature },
            'admin',
          )
        ).statusCode,
      ).toBe(200);
    }
    const result = await view();
    expect(
      result.third_place.table
        .filter((row: any) => row.qualified)
        .map((row: any) => row.group_code),
    ).toEqual(qualified);
    checkBracket(result);
  });

  it('requires 24 teams, accepts only A–F, and keeps four teams per group', async () => {
    const data = await field();
    expect((await h.call('POST', '/admin/futsal/generate-groups', {}, 'admin')).json()).toEqual({
      groups: 6,
      assigned: 24,
    });
    expect(
      (
        await h.call(
          'PATCH',
          `/admin/futsal/teams/${data.teams[0].id}/group`,
          { group_code: 'G' },
          'admin',
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.call(
          'PATCH',
          `/admin/futsal/teams/${data.teams[4].id}/group`,
          { group_code: 'A' },
          'admin',
        )
      ).json().error,
    ).toBe('group_full');
    await h.db.query('UPDATE futsal_teams SET group_code=null WHERE id=$1', [data.teams[0].id]);
    expect(
      (await h.call('POST', '/admin/futsal/generate-fixtures', {}, 'admin')).json().error,
    ).toBe('groups_incomplete');
    expect((await h.db.query('SELECT * FROM futsal_matches')).rows).toHaveLength(0);
    await h.db.query('DELETE FROM futsal_teams WHERE id=$1', [data.teams[0].id]);
    expect(
      (await h.call('POST', '/admin/futsal/generate-fixtures', {}, 'admin')).json().error,
    ).toBe('team_count');
  });

  it('preserves head-to-head ahead of goal difference for second and third', async () => {
    const data = await fixtures();
    const scores = [
      [10, 0],
      [10, 0],
      [1, 1],
      [1, 1],
      [1, 0],
      [1, 0],
    ];
    for (const [index, match] of data.groups[0].matches.entries()) {
      await h.db.query(
        "UPDATE futsal_matches SET status='completed',home_score=$2,away_score=$3 WHERE id=$1",
        [match.id, ...scores[index]],
      );
    }
    const table = (await view()).groups[0].table;
    expect(table[1].points).toBe(4);
    expect(table[2].points).toBe(4);
    expect(table[1].goal_difference).toBeLessThan(table[2].goal_difference);
    expect(table[1].id).toBe(data.groups[0].matches[5].home_team_id);
  });

  it('ranks third-place teams by points, then GD, then goals scored', async () => {
    await fixtures();
    await results('A', 1);
    await results('B', 1, 1);
    await results('C', 2, 10);
    await results('D', 3);
    await results('E', 4);
    await results('F', 5);
    // E's two bottom teams draw each other: third place has one point.
    await h.db.query(
      "UPDATE futsal_matches SET home_score=0,away_score=0 WHERE group_code='E' AND group_position=2",
    );
    const data = await view();
    expect(data.third_place.table.map((row: any) => row.group_code)).toEqual([
      'B',
      'A',
      'C',
      'D',
      'F',
      'E',
    ]);
    expect(data.third_place.draw_required).toBe(false);
    expect(data.third_place.table.filter((row: any) => row.qualified)).toHaveLength(4);
    expect((await h.call('POST', '/admin/futsal/generate-knockout', {}, 'admin')).statusCode).toBe(
      200,
    );
    checkBracket(await view());
  });

  it('does not require a draw for ties entirely above or below the cutoff', async () => {
    await fixtures();
    for (const [index, code] of [...'ABCDEF'].entries()) {
      await results(code, [1, 1, 2, 3, 4, 4][index]);
    }
    const data = await view();
    expect(data.third_place.draw_required).toBe(false);
    expect(
      data.third_place.table.filter((row: any) => row.qualified).map((row: any) => row.group_code),
    ).toEqual(['A', 'B', 'C', 'D']);
    expect((await h.call('POST', '/admin/futsal/generate-knockout', {}, 'admin')).statusCode).toBe(
      200,
    );
    checkBracket(await view());
  });

  it('requires a draw only across the cutoff, rejects stale or invalid orders, and records the result', async () => {
    await fixtures();
    for (const [index, code] of [...'ABCDEF'].entries())
      await results(code, [1, 2, 3, 4, 4, 5][index]);
    const data = await view();
    expect(data.third_place.draw_required).toBe(true);
    expect(
      data.third_place.table
        .filter((row: any) => row.draw_pending)
        .map((row: any) => row.group_code),
    ).toEqual(['D', 'E']);
    expect(data.third_place.table.filter((row: any) => row.qualified)).toHaveLength(3);
    expect(
      (await h.call('POST', '/admin/futsal/generate-knockout', {}, 'admin')).json().error,
    ).toBe('third_place_draw_required');
    const ids = data.third_place.table.map((row: any) => row.id);
    const body = {
      team_ids: [ids[0], ids[1], ids[2], ids[4], ids[3], ids[5]],
      signature: data.third_place.signature,
    };
    expect((await h.call('POST', '/admin/futsal/third-place-draw', body, 'staff')).statusCode).toBe(
      403,
    );
    expect(
      (
        await h.call(
          'POST',
          '/admin/futsal/third-place-draw',
          { ...body, signature: 'outdated' },
          'admin',
        )
      ).json().error,
    ).toBe('stale_draw');
    expect(
      (
        await h.call(
          'POST',
          '/admin/futsal/third-place-draw',
          { ...body, team_ids: ids.map(() => ids[0]) },
          'admin',
        )
      ).json().error,
    ).toBe('invalid_draw');
    expect(
      (
        await h.call(
          'POST',
          '/admin/futsal/third-place-draw',
          { ...body, team_ids: [...ids].reverse() },
          'admin',
        )
      ).json().error,
    ).toBe('invalid_draw');
    expect((await h.call('POST', '/admin/futsal/third-place-draw', body, 'admin')).statusCode).toBe(
      200,
    );
    const drawn = await view();
    expect(drawn.third_place.draw_applied).toBe(true);
    expect(
      drawn.third_place.table.filter((row: any) => row.qualified).map((row: any) => row.group_code),
    ).toEqual(['A', 'B', 'C', 'E']);
    checkBracket(drawn);
    expect(
      (await h.db.query("SELECT * FROM audit_logs WHERE action='futsal.third_place.draw'")).rows,
    ).toHaveLength(1);
    expect(
      (await h.call('POST', '/admin/futsal/third-place-draw', body, 'admin')).json().error,
    ).toBe('bracket_exists');
  });

  it('saves the last group result when all six third-place teams are tied', async () => {
    const data = await fixtures();
    const last = data.groups[5].matches[5];
    await h.db.query(
      "UPDATE futsal_matches SET status='completed',home_score=1,away_score=0 WHERE stage='group' AND id<>$1",
      [last.id],
    );
    const started = await h.call('POST', `/admin/futsal/matches/${last.id}/start`, {}, 'staff');
    const saved = await h.call(
      'PATCH',
      `/admin/futsal/matches/${last.id}`,
      { home_score: 1, away_score: 0, version: started.json().version },
      'staff',
    );
    expect(
      (
        await h.call(
          'POST',
          `/admin/futsal/matches/${last.id}/end`,
          { version: saved.json().version },
          'staff',
        )
      ).statusCode,
    ).toBe(200);
    const done = await view();
    expect(done.groups[5].matches[5].status).toBe('completed');
    expect(done.third_place.draw_required).toBe(true);
    expect(done.third_place.table.every((row: any) => row.draw_pending && !row.qualified)).toBe(
      true,
    );
    expect(done.bracket).toHaveLength(0);
  });

  it('can pair every combination of four qualifying third-place groups without rematches', async () => {
    await fixtures();
    for (const code of 'ABCDEF') await results(code);
    const data = await view();
    const ids = data.third_place.table.map((row: any) => row.id);
    // There are 15 possible four-group combinations among six groups.
    for (let first = 0; first < 6; first++)
      for (let second = first + 1; second < 6; second++) {
        await h.db.query("DELETE FROM futsal_matches WHERE stage<>'group'");
        await h.db.query('DELETE FROM futsal_third_place_draw');
        const qualifying = ids.filter(
          (_: string, index: number) => index !== first && index !== second,
        );
        const result = await h.call(
          'POST',
          '/admin/futsal/third-place-draw',
          {
            team_ids: [...qualifying, ids[first], ids[second]],
            signature: data.third_place.signature,
          },
          'admin',
        );
        expect(result.statusCode).toBe(200);
        checkBracket(await view());
      }
  });
});
