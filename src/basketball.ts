import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from './auth.js';
import type { Config } from './config.js';
import type { Database, Queryable, Row } from './db.js';
import { one } from './db.js';
import { assert } from './errors.js';
import { audit, uuid } from './orders.js';

const groups = ['A', 'B', 'C', 'D'] as const;
// Group fixtures for four teams in placement order, so the first pairing round is
// a1–a2 with a3–a4, the second a1–a3 with a2–a4, and the third a1–a4 with a2–a3.
const groupRoundRobin = [
  [0, 1],
  [2, 3],
  [0, 2],
  [1, 3],
  [0, 3],
  [1, 2],
] as const;
const scoreBody = z
  .object({
    home_score: z.number().int().min(0).max(999),
    away_score: z.number().int().min(0).max(999),
    version: z.number().int().positive(),
  })
  .strict();
const groupBody = z.object({ group_code: z.enum(groups).nullable() }).strict();
const params = z.object({ id: uuid });
type Standing = Row & {
  played: number;
  wins: number;
  losses: number;
  points: number;
  points_for: number;
  points_against: number;
  point_difference: number;
};

async function standings(tx: Queryable, group: string): Promise<Standing[]> {
  const teams = (
    await tx.query<Row>(
      `SELECT t.id,t.order_item_id,i.team_name,i.logo_url,t.group_code,t.selected,t.group_assigned_at,t.created_at
       FROM basketball_teams t JOIN order_items i ON i.id=t.order_item_id
       WHERE t.group_code=$1 ORDER BY i.team_name,t.id`,
      [group],
    )
  ).rows;
  const matches = (
    await tx.query<Row>(
      "SELECT * FROM basketball_matches WHERE stage='group' AND group_code=$1 AND status='completed'",
      [group],
    )
  ).rows;
  const table = new Map<string, Standing>(
    teams.map((t) => [
      t.id,
      {
        ...t,
        played: 0,
        wins: 0,
        losses: 0,
        points: 0,
        points_for: 0,
        points_against: 0,
        point_difference: 0,
      },
    ]),
  );
  for (const m of matches) {
    const home = table.get(m.home_team_id);
    const away = table.get(m.away_team_id);
    if (!home || !away) continue;
    home.played++;
    away.played++;
    home.points_for += m.home_score;
    home.points_against += m.away_score;
    away.points_for += m.away_score;
    away.points_against += m.home_score;
    if (m.home_score > m.away_score) {
      home.wins++;
      home.points += 2;
      away.losses++;
    } else {
      away.wins++;
      away.points += 2;
      home.losses++;
    }
  }
  const values = [...table.values()];
  values.forEach((row) => {
    row.point_difference = row.points_for - row.points_against;
  });
  values.sort((a, b) => b.points - a.points);
  for (let start = 0; start < values.length;) {
    let end = start + 1;
    while (end < values.length && values[end].points === values[start].points) end++;
    const tied = values.slice(start, end);
    const headToHead =
      tied.length === 2
        ? matches.find(
            (m) =>
              (m.home_team_id === tied[0].id && m.away_team_id === tied[1].id) ||
              (m.home_team_id === tied[1].id && m.away_team_id === tied[0].id),
          )
        : undefined;
    tied.sort((a, b) => {
      if (headToHead) {
        const winner =
          headToHead.home_score > headToHead.away_score
            ? headToHead.home_team_id
            : headToHead.away_team_id;
        if (a.id === winner) return -1;
        if (b.id === winner) return 1;
      }
      return (
        b.point_difference - a.point_difference ||
        b.points_for - a.points_for ||
        a.team_name.localeCompare(b.team_name)
      );
    });
    values.splice(start, tied.length, ...tied);
    start = end;
  }
  values.forEach((row, i) => {
    row.position = i + 1;
  });
  return values;
}
async function publicMatch(tx: Queryable, match: Row | undefined) {
  if (!match) return null;
  const teams = (
    await tx.query<Row>(
      `SELECT t.id,i.team_name,i.logo_url FROM basketball_teams t
       JOIN order_items i ON i.id=t.order_item_id WHERE t.id=ANY($1::uuid[])`,
      [[match.home_team_id, match.away_team_id].filter(Boolean)],
    )
  ).rows;
  const byId = new Map(teams.map((t) => [t.id, t]));
  const scorersFor = async (teamId: string | null) =>
    teamId
      ? (
          await tx.query<Row>(
            `SELECT s.player_id,p.player_name,sum(s.points)::int AS points
             FROM basketball_scorers s JOIN team_players p ON p.id=s.player_id
             WHERE s.match_id=$1 AND s.team_id=$2
             GROUP BY s.player_id,p.player_name
             ORDER BY min(s.created_at),p.player_name`,
            [match.id, teamId],
          )
        ).rows
      : [];
  return {
    ...match,
    home_team: byId.get(match.home_team_id) ?? null,
    away_team: byId.get(match.away_team_id) ?? null,
    home_scorers: await scorersFor(match.home_team_id),
    away_scorers: await scorersFor(match.away_team_id),
  };
}
function nextSlot(stage: string, position: number) {
  const next = stage === 'quarter' ? 'semi' : stage === 'semi' ? 'final' : null;
  return next
    ? {
        stage: next,
        position: Math.ceil(position / 2),
        slot: position % 2 ? 'home_team_id' : 'away_team_id',
      }
    : null;
}
async function createBracket(tx: Queryable) {
  const complete = await one(
    tx,
    "SELECT count(*)::int AS total,count(*) FILTER (WHERE status='completed')::int AS completed FROM basketball_matches WHERE stage='group'",
  );
  assert(
    complete?.total === 24 && complete.completed === 24,
    409,
    'groups_incomplete',
    'Complete all 24 group matches before creating the bracket',
  );
  assert(
    !(await one(tx, "SELECT id FROM basketball_matches WHERE stage='quarter' LIMIT 1")),
    409,
    'bracket_exists',
    'The basketball bracket already exists',
  );
  const qualified = (await Promise.all(groups.map((group) => standings(tx, group)))).flatMap(
    (table) => table.slice(0, 2),
  );
  assert(
    qualified.length === 8,
    409,
    'qualifiers_incomplete',
    'Each group must have two qualified teams',
  );
  const selected = qualified.map((team) => team.id);
  await tx.query('UPDATE basketball_teams SET selected=false');
  await tx.query('UPDATE basketball_teams SET selected=true WHERE id=ANY($1::uuid[])', [selected]);
  for (let i = 0; i < 8; i += 2)
    await tx.query(
      "INSERT INTO basketball_matches(stage,bracket_position,home_team_id,away_team_id) VALUES('quarter',$1,$2,$3)",
      [i / 2 + 1, selected[i], selected[i + 1]],
    );
  for (let i = 1; i <= 2; i++)
    await tx.query("INSERT INTO basketball_matches(stage,bracket_position) VALUES('semi',$1)", [i]);
  await tx.query("INSERT INTO basketball_matches(stage,bracket_position) VALUES('final',1)");
}
// A score corrected downwards must not leave more points credited to players than
// the team has on the board, so the newest assignments are trimmed first. One
// assignment can cover several points, so a partial trim shrinks it instead of
// dropping it.
async function trimScorers(tx: Queryable, match: Row, side: 'home' | 'away', score: number) {
  const teamId = side === 'home' ? match.home_team_id : match.away_team_id;
  if (!teamId) return;
  let assigned = (
    await one(
      tx,
      'SELECT coalesce(sum(points),0)::int AS total FROM basketball_scorers WHERE match_id=$1 AND team_id=$2',
      [match.id, teamId],
    )
  )!.total;
  while (assigned > score) {
    const latest = await one(
      tx,
      'SELECT id,points FROM basketball_scorers WHERE match_id=$1 AND team_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
      [match.id, teamId],
    );
    if (!latest) return;
    const excess = assigned - score;
    if (latest.points > excess) {
      await tx.query('UPDATE basketball_scorers SET points=points-$2 WHERE id=$1', [
        latest.id,
        excess,
      ]);
      assigned = score;
    } else {
      await tx.query('DELETE FROM basketball_scorers WHERE id=$1', [latest.id]);
      assigned -= latest.points;
    }
  }
}

// Round labels for the knockout report, in the order the bracket plays out.
const knockoutStageLabels: Record<string, string> = {
  quarter: 'Quarterfinals',
  semi: 'Semifinals',
  final: 'Final',
};

export async function registerBasketball(app: FastifyInstance, db: Database, c: Config) {
  const guard = auth(db, c);
  app.get('/basketball/data', async () => {
    const groupData = [];
    for (const code of groups)
      groupData.push({
        code,
        table: await standings(db, code),
        matches: (
          await db.query<Row>(
            "SELECT * FROM basketball_matches WHERE stage='group' AND group_code=$1 ORDER BY group_position,created_at,id",
            [code],
          )
        ).rows,
      });
    const bracket = (
      await db.query<Row>(
        "SELECT * FROM basketball_matches WHERE stage <> 'group' ORDER BY CASE stage WHEN 'quarter' THEN 1 WHEN 'semi' THEN 2 ELSE 3 END,bracket_position",
      )
    ).rows;
    const ids = [
      ...new Set(
        [...groupData.flatMap((g) => g.matches), ...bracket]
          .flatMap((m) => [m.home_team_id, m.away_team_id])
          .filter(Boolean),
      ),
    ];
    const teams = (
      await db.query<Row>(
        `SELECT t.id,i.team_name,i.logo_url,t.group_code,t.group_assigned_at,t.selected,
   coalesce((SELECT json_agg(json_build_object('id',p.id,'player_name',p.player_name) ORDER BY p.position,p.created_at,p.id)
     FROM team_players p WHERE p.order_item_id=t.order_item_id),'[]') AS players
         FROM basketball_teams t JOIN order_items i ON i.id=t.order_item_id
         ORDER BY i.team_name,t.id`,
      )
    ).rows;
    return { groups: groupData, bracket, teams };
  });
  // Only a running match is published, so the big-screen page shows the sponsor
  // rotation until an organizer starts one and switches back when it ends.
  app.get('/basketball/live', async () =>
    publicMatch(
      db,
      await one(
        db,
        "SELECT * FROM basketball_matches WHERE status='live' ORDER BY created_at LIMIT 1",
      ),
    ),
  );
  app.get('/admin/basketball', { preHandler: guard.admin }, async () =>
    (await app.inject({ method: 'GET', url: '/basketball/data' })).json(),
  );
  // The organizer exports a stage once it finishes: every fixture with its final
  // score and the players credited with the points, grouped by round for the PDF.
  app.get('/admin/basketball/report', { preHandler: guard.admin }, async (req) => {
    const query = z
      .object({ stage: z.enum(['group', 'knockout']).default('group') })
      .parse(req.query);
    const data = (await app.inject({ method: 'GET', url: '/basketball/data' })).json() as {
      groups: { code: string; matches: Row[] }[];
      bracket: Row[];
      teams: Row[];
    };
    const names = new Map<string, string>(data.teams.map((team) => [team.id, team.team_name]));
    const credits = new Map<string, { player_name: string; points: number }[]>();
    const creditRows = await db.query<Row>(
      `SELECT s.match_id,s.team_id,p.player_name,sum(s.points)::int AS points
       FROM basketball_scorers s JOIN team_players p ON p.id=s.player_id
       GROUP BY s.match_id,s.team_id,p.player_name
       ORDER BY min(s.created_at),p.player_name`,
    );
    for (const row of creditRows.rows) {
      const key = `${row.match_id}:${row.team_id}`;
      credits.set(key, [
        ...(credits.get(key) ?? []),
        { player_name: row.player_name, points: row.points },
      ]);
    }
    const matchView = (match: Row) => ({
      home_team: names.get(match.home_team_id) ?? 'Team to be confirmed',
      away_team: names.get(match.away_team_id) ?? 'Team to be confirmed',
      home_score: match.home_score,
      away_score: match.away_score,
      status: match.status,
      home_scorers: match.home_team_id
        ? (credits.get(`${match.id}:${match.home_team_id}`) ?? [])
        : [],
      away_scorers: match.away_team_id
        ? (credits.get(`${match.id}:${match.away_team_id}`) ?? [])
        : [],
      // A tied knockout score only hides who went through on penalties.
      penalty_winner:
        match.stage !== 'group' && match.home_score === match.away_score && match.winner_team_id
          ? (names.get(match.winner_team_id) ?? null)
          : null,
    });
    const sections = [];
    if (query.stage === 'group') {
      for (const group of data.groups) {
        if (group.matches.length)
          sections.push({
            label: `Group ${group.code}`,
            matches: group.matches.map(matchView),
          });
      }
    } else {
      const byStage = new Map<string, Row[]>();
      for (const match of data.bracket) {
        const list = byStage.get(match.stage) ?? [];
        list.push(match);
        byStage.set(match.stage, list);
      }
      for (const [stage, matches] of byStage)
        sections.push({
          label: knockoutStageLabels[stage] ?? stage,
          matches: matches.map(matchView),
        });
    }
    const event = await one(db, 'SELECT title FROM events WHERE active');
    return {
      sport: 'basketball',
      stage: query.stage,
      title: event?.title ?? 'RONB Corporate Championship',
      sections,
    };
  });
  app.post('/admin/basketball/import', { preHandler: guard.superAdmin }, async (req) =>
    db.transaction(async (tx) => {
      const sport = await one(tx, "SELECT id FROM sports WHERE lower(name)='basketball'");
      assert(sport, 404, 'basketball_missing', 'Create the Basketball sport first');
      const result = await tx.query<Row>(
        `INSERT INTO basketball_teams(order_item_id,team_name,logo_url) SELECT i.id,i.team_name,i.logo_url FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.sport_id=$1 AND o.status IN ('confirmed','contacted','completed') ON CONFLICT(order_item_id) DO NOTHING RETURNING id`,
        [sport.id],
      );
      await audit(tx, req.actor!.id, 'basketball.import', 'basketball', sport.id, {
        imported: result.rows.length,
      });
      return {
        imported: result.rows.length,
        total: (await one(tx, 'SELECT count(*)::int AS count FROM basketball_teams'))!.count,
      };
    }),
  );
  app.patch('/admin/basketball/teams/:id/group', { preHandler: guard.superAdmin }, async (req) =>
    db.transaction(async (tx) => {
      assert(
        !(await one(tx, 'SELECT id FROM basketball_matches LIMIT 1')),
        409,
        'fixtures_exist',
        'Groups cannot change after fixtures are created',
      );
      const team = await one(tx, 'SELECT * FROM basketball_teams WHERE id=$1 FOR UPDATE', [
        params.parse(req.params).id,
      ]);
      assert(team, 404, 'not_found', 'Team not found');
      const body = groupBody.parse(req.body);
      if (body.group_code) {
        const count = await one(
          tx,
          'SELECT count(*)::int AS count FROM basketball_teams WHERE group_code=$1 AND id<>$2',
          [body.group_code, team.id],
        );
        assert(
          (count?.count ?? 0) < 4,
          409,
          'group_full',
          `Group ${body.group_code} already has four teams`,
        );
      }
      // Re-saving the same group keeps this team's place in the draw; clearing the
      // group drops the stamp so a later assignment draws a fresh order.
      const stamped =
        body.group_code === team.group_code
          ? team.group_assigned_at
          : body.group_code
            ? new Date()
            : null;
      await tx.query('UPDATE basketball_teams SET group_code=$1,group_assigned_at=$2 WHERE id=$3', [
        body.group_code,
        stamped,
        team.id,
      ]);
      await audit(tx, req.actor!.id, 'basketball.team.group_assign', 'basketball', team.id, {
        group_code: body.group_code,
      });
      return one(tx, 'SELECT * FROM basketball_teams WHERE id=$1', [team.id]);
    }),
  );
  app.post('/admin/basketball/generate-groups', { preHandler: guard.superAdmin }, async (req) =>
    db.transaction(async (tx) => {
      assert(
        !(await one(tx, 'SELECT id FROM basketball_matches LIMIT 1')),
        409,
        'fixtures_exist',
        'Groups cannot change after fixtures are created',
      );
      const teams = (
        await tx.query<Row>('SELECT * FROM basketball_teams ORDER BY team_name,id FOR UPDATE')
      ).rows;
      assert(
        teams.length === 16,
        409,
        'team_count',
        'Basketball requires exactly 16 imported confirmed teams',
      );
      return { groups: 4, assigned: teams.filter((team) => team.group_code).length };
    }),
  );
  app.post('/admin/basketball/generate-fixtures', { preHandler: guard.superAdmin }, async (req) =>
    db.transaction(async (tx) => {
      assert(
        !(await one(tx, 'SELECT id FROM basketball_matches LIMIT 1')),
        409,
        'fixtures_exist',
        'Fixtures already exist',
      );
      for (const group of groups) {
        // a1 is the first team placed in the group, a4 the last, so the round
        // robin pairs a1–a2 with a3–a4, then a1–a3 with a2–a4, then a1–a4 with a2–a3.
        const teams = (
          await tx.query<Row>(
            'SELECT id FROM basketball_teams WHERE group_code=$1 ORDER BY group_assigned_at,id',
            [group],
          )
        ).rows;
        assert(teams.length === 4, 409, 'groups_incomplete', `Group ${group} needs four teams`);
        for (const [position, [home, away]] of groupRoundRobin.entries())
          await tx.query(
            "INSERT INTO basketball_matches(stage,group_code,group_position,home_team_id,away_team_id) VALUES('group',$1,$2,$3,$4)",
            [group, position + 1, teams[home].id, teams[away].id],
          );
      }
      await audit(
        tx,
        req.actor!.id,
        'basketball.fixtures.generate',
        'basketball',
        (await one(tx, 'SELECT id FROM basketball_teams LIMIT 1'))!.id,
        { matches: 24 },
      );
      return { matches: 24 };
    }),
  );
  app.post('/admin/basketball/matches/:id/start', { preHandler: guard.admin }, async (req) =>
    db.transaction(async (tx) => {
      // Serialize starts for this sport, including requests from other organizer tabs.
      await tx.query('SELECT pg_advisory_xact_lock(427202)');
      const m = await one(tx, 'SELECT * FROM basketball_matches WHERE id=$1 FOR UPDATE', [
        params.parse(req.params).id,
      ]);
      assert(m, 404, 'not_found', 'Match not found');
      assert(m.status === 'scheduled', 409, 'invalid_state', 'Only scheduled matches can start');
      assert(m.home_team_id && m.away_team_id, 409, 'teams_pending', 'Both teams must be known');
      assert(
        !(await one(tx, "SELECT id FROM basketball_matches WHERE status='live' LIMIT 1")),
        409,
        'match_already_live',
        'Finish the live basketball match before starting another',
      );
      return one(
        tx,
        "UPDATE basketball_matches SET status='live',version=version+1 WHERE id=$1 RETURNING *",
        [m.id],
      );
    }),
  );
  app.patch('/admin/basketball/matches/:id', { preHandler: guard.admin }, async (req) =>
    db.transaction(async (tx) => {
      const b = scoreBody.parse(req.body);
      const m = await one(tx, 'SELECT * FROM basketball_matches WHERE id=$1 FOR UPDATE', [
        params.parse(req.params).id,
      ]);
      assert(
        m && m.status === 'live',
        409,
        'invalid_state',
        'Only live basketball scores can be saved',
      );
      assert(
        m.version === b.version,
        409,
        'stale_match',
        'This score changed elsewhere. Refresh and try again.',
      );
      const updated = (await one(
        tx,
        'UPDATE basketball_matches SET home_score=$2,away_score=$3,version=version+1 WHERE id=$1 RETURNING *',
        [m.id, b.home_score, b.away_score],
      ))!;
      await trimScorers(tx, updated, 'home', updated.home_score);
      await trimScorers(tx, updated, 'away', updated.away_score);
      return updated;
    }),
  );
  // The organizer saves a raised score and then credits it to a player from the
  // team's roster, which is what /basketball/match prints under the team name.
  app.post('/admin/basketball/matches/:id/scorers', { preHandler: guard.admin }, async (req) =>
    db.transaction(async (tx) => {
      const b = z
        .object({ team_id: uuid, player_id: uuid, points: z.number().int().min(1).max(999) })
        .strict()
        .parse(req.body);
      const m = await one(tx, 'SELECT * FROM basketball_matches WHERE id=$1 FOR UPDATE', [
        params.parse(req.params).id,
      ]);
      assert(m, 404, 'not_found', 'Match not found');
      assert(
        b.team_id === m.home_team_id || b.team_id === m.away_team_id,
        400,
        'team_mismatch',
        'That team is not playing in this match',
      );
      const player = await one(
        tx,
        `SELECT p.id FROM team_players p JOIN basketball_teams t ON t.order_item_id=p.order_item_id
         WHERE t.id=$1 AND p.id=$2`,
        [b.team_id, b.player_id],
      );
      assert(player, 404, 'player_not_found', 'That player is not on the team roster');
      const score = b.team_id === m.home_team_id ? m.home_score : m.away_score;
      const assigned = (
        await one(
          tx,
          'SELECT coalesce(sum(points),0)::int AS total FROM basketball_scorers WHERE match_id=$1 AND team_id=$2',
          [m.id, b.team_id],
        )
      )!.total;
      assert(
        assigned + b.points <= score,
        409,
        'scorers_exceed_score',
        `Only ${score - assigned} of the team's ${score} points are still unassigned`,
      );
      const row = await one(
        tx,
        'INSERT INTO basketball_scorers(match_id,team_id,player_id,points) VALUES($1,$2,$3,$4) RETURNING *',
        [m.id, b.team_id, b.player_id, b.points],
      );
      await audit(tx, req.actor!.id, 'basketball.match.scorer', 'basketball', m.id, {
        team_id: b.team_id,
        player_id: b.player_id,
        points: b.points,
      });
      return row;
    }),
  );
  app.post('/admin/basketball/matches/:id/end', { preHandler: guard.admin }, async (req) =>
    db.transaction(async (tx) => {
      const b = scoreBody.extend({ penalty_winner_id: uuid.optional() }).parse(req.body);
      const m = await one(tx, 'SELECT * FROM basketball_matches WHERE id=$1 FOR UPDATE', [
        params.parse(req.params).id,
      ]);
      assert(
        m && m.status === 'live',
        409,
        'invalid_state',
        'Only live basketball matches can end',
      );
      assert(
        m.version === b.version,
        409,
        'stale_match',
        'This score changed elsewhere. Refresh and try again.',
      );
      assert(
        m.stage !== 'group' || b.home_score !== b.away_score,
        400,
        'draw_not_allowed',
        'Basketball group matches cannot end tied',
      );
      let winner: string | null = null;
      if (b.home_score === b.away_score) {
        assert(
          m.stage !== 'group' &&
            (b.penalty_winner_id === m.home_team_id || b.penalty_winner_id === m.away_team_id),
          400,
          'winner_required',
          'Choose the winner for a tied basketball knockout match',
        );
        winner = b.penalty_winner_id!;
      } else winner = b.home_score > b.away_score ? m.home_team_id : m.away_team_id;
      const done = await one(
        tx,
        "UPDATE basketball_matches SET home_score=$2,away_score=$3,status='completed',winner_team_id=$4,completed_at=now(),version=version+1 WHERE id=$1 RETURNING *",
        [m.id, b.home_score, b.away_score, winner],
      );
      await trimScorers(tx, done!, 'home', b.home_score);
      await trimScorers(tx, done!, 'away', b.away_score);
      if (m.stage === 'group') {
        const complete = await one(
          tx,
          "SELECT count(*)::int AS total,count(*) FILTER (WHERE status='completed')::int AS completed FROM basketball_matches WHERE stage='group'",
        );
        if (complete?.total === 24 && complete.completed === 24) {
          await createBracket(tx);
          await audit(tx, req.actor!.id, 'basketball.bracket.generate', 'basketball', m.id, {
            teams: 8,
            automatic: true,
          });
        }
      }
      const next = nextSlot(m.stage, m.bracket_position);
      if (next)
        await tx.query(
          `UPDATE basketball_matches SET ${next.slot}=$1 WHERE stage=$2 AND bracket_position=$3`,
          [winner, next.stage, next.position],
        );
      await audit(tx, req.actor!.id, 'basketball.match.end', 'basketball', m.id, { winner });
      return done;
    }),
  );
}
