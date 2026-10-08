import { afterEach, beforeEach, expect, it } from 'vitest';
import { setup } from './helpers.js';

let h: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h?.close();
});
const sports = ['futsal', 'basketball', 'cricket'] as const;
type Sport = (typeof sports)[number];

async function fixtures(sport: Sport) {
  const teams: string[] = [];
  for (let index = 0; index < 4; index++) {
    const order = (
      await h.db.query("INSERT INTO orders(user_id,status) VALUES($1,'confirmed') RETURNING id", [
        h.user.id,
      ])
    ).rows[0];
    const item = (
      await h.db.query(
        'INSERT INTO order_items(order_id,sport_id,price_at_purchase,team_name) VALUES($1,$2,0,$3) RETURNING id',
        [order.id, h.sports[0].id, `${sport} Team ${index}`],
      )
    ).rows[0];
    teams.push(
      (
        await h.db.query(
          `INSERT INTO ${sport}_teams(order_item_id,team_name) VALUES($1,$2) RETURNING id`,
          [item.id, `${sport} Team ${index}`],
        )
      ).rows[0].id,
    );
  }
  const ids: string[] = [];
  for (let index = 0; index < 2; index++)
    ids.push(
      (
        await h.db.query(
          `INSERT INTO ${sport}_matches(stage,group_code,group_position,home_team_id,away_team_id) VALUES('group','A',$1,$2,$3) RETURNING id`,
          [index + 1, teams[index * 2], teams[index * 2 + 1]],
        )
      ).rows[0].id,
    );
  ids.push(
    (
      await h.db.query(
        `INSERT INTO ${sport}_matches(stage,bracket_position,home_team_id,away_team_id) VALUES('quarter',1,$1,$2) RETURNING id`,
        [teams[0], teams[2]],
      )
    ).rows[0].id,
  );
  return ids;
}
async function start(sport: Sport, id: string) {
  return h.call('POST', `/admin/${sport}/matches/${id}/start`, {}, 'admin');
}

it.each(sports)(
  '%s rejects another group or knockout start until the live match ends',
  async (sport) => {
    const [first, second, knockout] = await fixtures(sport);
    const live = await start(sport, first);
    expect(live.statusCode).toBe(200);
    for (const id of [second, knockout]) {
      const blocked = await start(sport, id);
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toBe('match_already_live');
    }
    const saved = await h.call(
      'PATCH',
      `/admin/${sport}/matches/${first}`,
      {
        home_score: 1,
        away_score: 0,
        version: live.json().version,
        ...(sport === 'cricket'
          ? { home_wickets: 0, away_wickets: 0, home_overs: 1, away_overs: 1 }
          : {}),
      },
      'admin',
    );
    expect(saved.statusCode).toBe(200);
    expect(
      (
        await h.call(
          'POST',
          `/admin/${sport}/matches/${first}/end`,
          {
            version: saved.json().version,
            ...(sport === 'basketball' ? { home_score: 1, away_score: 0 } : {}),
          },
          'admin',
        )
      ).statusCode,
    ).toBe(200);
    expect((await start(sport, second)).statusCode).toBe(200);
    const rows = (await h.db.query(`SELECT id,status,version FROM ${sport}_matches ORDER BY id`))
      .rows;
    expect(rows.filter((row) => row.status === 'live').map((row) => row.id)).toEqual([second]);
    expect(rows.find((row) => row.id === knockout)?.status).toBe('scheduled');
    expect(rows.find((row) => row.id === knockout)?.version).toBe(1);
  },
);

it.each(sports)(
  '%s allows exactly one winner when different matches start concurrently',
  async (sport) => {
    const ids = await fixtures(sport);
    const results = await Promise.all(ids.map((id) => start(sport, id)));
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409, 409]);
    expect(
      results.filter((result) => result.statusCode === 409).map((result) => result.json().error),
    ).toEqual(['match_already_live', 'match_already_live']);
    expect(
      (await h.db.query(`SELECT count(*)::int AS total FROM ${sport}_matches WHERE status='live'`))
        .rows[0].total,
    ).toBe(1);
  },
);

it('allows one match in each sport to run at the same time', async () => {
  for (const sport of sports) {
    const [first] = await fixtures(sport);
    expect((await start(sport, first)).statusCode).toBe(200);
  }
});
