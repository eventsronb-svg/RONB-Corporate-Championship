import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from './auth.js';
import type { Config } from './config.js';
import type { Database, Queryable, Row } from './db.js';
import { one } from './db.js';
import { assert } from './errors.js';
import { audit, uuid } from './orders.js';

const groups = ['A', 'B', 'C', 'D'] as const;
// Six group fixtures in placement order: a1–a2 with a3–a4,
// then a1–a3 with a2–a4, then a1–a4 with a2–a3.
const groupRoundRobin = [
  [0, 1],
  [2, 3],
  [0, 2],
  [1, 3],
  [0, 3],
  [1, 2],
] as const;
// Overs are written the cricket way: 9.4 is nine overs and four balls, so the
// fraction never passes five. Cricksal is a ten-over game, so an innings can
// never read past 10.0.
const overs = z
  .number()
  .min(0)
  .max(10)
  .refine((value) => Math.round((value % 1) * 10) <= 5, {
    message: 'Overs cannot pass .5 — six balls roll into the next over',
  });
const battingSide = z.enum(['home', 'away']);
const scoreBody = z
  .object({
    home_score: z.number().int().min(0).max(999),
    away_score: z.number().int().min(0).max(999),
    home_wickets: z.number().int().min(0).max(7).optional(),
    away_wickets: z.number().int().min(0).max(7).optional(),
    home_overs: overs.optional(),
    away_overs: overs.optional(),
    version: z.number().int().positive(),
  })
  .strict();
const groupBody = z.object({ group_code: z.enum(groups).nullable() }).strict();
const params = z.object({ id: uuid });

type Standing = Row & {
  played: number;
  wins: number;
  losses: number;
  runs_for: number;
  runs_against: number;
  run_difference: number;
  points: number;
};

async function standings(tx: Queryable, group: string): Promise<Standing[]> {
  const teams = (
    await tx.query<Row>(
      `SELECT t.id,t.order_item_id,i.team_name,i.logo_url,t.group_code,t.group_assigned_at,t.created_at
       FROM cricket_teams t JOIN order_items i ON i.id=t.order_item_id
       WHERE t.group_code=$1 ORDER BY i.team_name,t.id`,
      [group],
    )
  ).rows;
  const matches = (
    await tx.query<Row>(
      `SELECT * FROM cricket_matches WHERE stage='group' AND group_code=$1 AND status='completed'`,
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
        runs_for: 0,
        runs_against: 0,
        run_difference: 0,
        points: 0,
      },
    ]),
  );
  for (const m of matches) {
    const home = table.get(m.home_team_id);
    const away = table.get(m.away_team_id);
    if (!home || !away) continue;
    home.played++;
    away.played++;
    home.runs_for += m.home_score;
    home.runs_against += m.away_score;
    away.runs_for += m.away_score;
    away.runs_against += m.home_score;
    // A super over still names a winner; rows completed in bulk fall back to the
    // runs on the board.
    const winner = m.winner_team_id
      ? m.winner_team_id
      : m.home_score > m.away_score
        ? m.home_team_id
        : m.away_score > m.home_score
          ? m.away_team_id
          : null;
    if (winner === home.id) {
      home.wins++;
      home.points += 2;
      away.losses++;
    } else if (winner === away.id) {
      away.wins++;
      away.points += 2;
      home.losses++;
    }
  }
  const values = [...table.values()];
  for (const row of values) row.run_difference = row.runs_for - row.runs_against;
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
        const winner = headToHead.winner_team_id
          ? headToHead.winner_team_id
          : headToHead.home_score !== headToHead.away_score
            ? headToHead.home_score > headToHead.away_score
              ? headToHead.home_team_id
              : headToHead.away_team_id
            : null;
        if (winner) {
          if (a.id === winner) return -1;
          if (b.id === winner) return 1;
        }
      }
      return (
        b.run_difference - a.run_difference ||
        b.runs_for - a.runs_for ||
        a.team_name.localeCompare(b.team_name)
      );
    });
    values.splice(start, tied.length, ...tied);
    start = end;
  }
  values.forEach((row, index) => (row.position = index + 1));
  return values;
}

async function publicMatch(tx: Queryable, match: Row | undefined) {
  if (!match) return null;
  const teams = (
    await tx.query<Row>(
      `SELECT t.id,i.team_name,i.logo_url FROM cricket_teams t
       JOIN order_items i ON i.id=t.order_item_id WHERE t.id=ANY($1::uuid[])`,
      [[match.home_team_id, match.away_team_id].filter(Boolean)],
    )
  ).rows;
  const byId = new Map(teams.map((t) => [t.id, t]));
  const scorersFor = async (teamId: string | null) =>
    teamId
      ? (
          await tx.query<Row>(
            `SELECT s.player_id,p.player_name,sum(s.runs)::int AS runs
             FROM cricket_scorers s JOIN team_players p ON p.id=s.player_id
             WHERE s.match_id=$1 AND s.team_id=$2
             GROUP BY s.player_id,p.player_name
             ORDER BY min(s.created_at),p.player_name`,
            [match.id, teamId],
          )
        ).rows
      : [];
  // The bowler credits mirror the run credits: player name and the wickets they
  // took, one row per bowler, shown under the team name on the big screen.
  const bowlersFor = async (teamId: string | null) =>
    teamId
      ? (
          await tx.query<Row>(
            `SELECT w.player_id,p.player_name,sum(w.wickets)::int AS wickets
             FROM cricket_wickets w JOIN team_players p ON p.id=w.player_id
             WHERE w.match_id=$1 AND w.team_id=$2
             GROUP BY w.player_id,p.player_name
             ORDER BY min(w.created_at),p.player_name`,
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
    home_bowlers: await bowlersFor(match.home_team_id),
    away_bowlers: await bowlersFor(match.away_team_id),
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
  const groupMatches = await one(
    tx,
    "SELECT count(*)::int AS total,count(*) FILTER (WHERE status='completed')::int AS completed FROM cricket_matches WHERE stage='group'",
  );
  assert(
    groupMatches?.total === 24 && groupMatches.completed === 24,
    409,
    'groups_incomplete',
    'Complete all 24 group matches before creating the bracket',
  );
  assert(
    !(await one(tx, "SELECT id FROM cricket_matches WHERE stage='quarter' LIMIT 1")),
    409,
    'bracket_exists',
    'The cricket bracket already exists',
  );
  const qualified: Standing[][] = [];
  for (const group of groups) qualified.push((await standings(tx, group)).slice(0, 2));
  assert(
    qualified.every((table) => table.length === 2),
    409,
    'qualifiers_incomplete',
    'Each group must have two qualified teams',
  );
  const selected = qualified.flat().map((row) => row.id);
  await tx.query('UPDATE cricket_teams SET selected=false');
  await tx.query('UPDATE cricket_teams SET selected=true WHERE id=ANY($1::uuid[])', [selected]);
  // Cross-group quarters in the futsal style: each group winner meets the other
  // group's runner-up, so a rematch can only happen from the final onwards.
  const pairings = [
    [qualified[0][0], qualified[1][0]],
    [qualified[2][0], qualified[3][0]],
    [qualified[0][1], qualified[1][1]],
    [qualified[2][1], qualified[3][1]],
  ] as const;
  for (const [index, [home, away]] of pairings.entries())
    await tx.query(
      `INSERT INTO cricket_matches(stage,bracket_position,home_team_id,away_team_id) VALUES('quarter',$1,$2,$3)`,
      [index + 1, home.id, away.id],
    );
  for (let i = 1; i <= 2; i++)
    await tx.query("INSERT INTO cricket_matches(stage,bracket_position) VALUES('semi',$1)", [i]);
  await tx.query("INSERT INTO cricket_matches(stage,bracket_position) VALUES('final',1)");
}

// A score corrected downwards must not leave more runs credited to players than
// the team has on the board, so the newest assignments are trimmed first. One
// assignment can cover several runs, so a partial trim shrinks it instead of
// dropping it.
async function trimScorers(tx: Queryable, match: Row, side: 'home' | 'away', score: number) {
  const teamId = side === 'home' ? match.home_team_id : match.away_team_id;
  if (!teamId) return;
  let assigned = (await one(
    tx,
    'SELECT coalesce(sum(runs),0)::int AS total FROM cricket_scorers WHERE match_id=$1 AND team_id=$2',
    [match.id, teamId],
  ))!.total;
  while (assigned > score) {
    const latest = await one(
      tx,
      'SELECT id,runs FROM cricket_scorers WHERE match_id=$1 AND team_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
      [match.id, teamId],
    );
    if (!latest) return;
    const excess = assigned - score;
    if (latest.runs > excess) {
      await tx.query('UPDATE cricket_scorers SET runs=runs-$2 WHERE id=$1', [latest.id, excess]);
      assigned = score;
    } else {
      await tx.query('DELETE FROM cricket_scorers WHERE id=$1', [latest.id]);
      assigned -= latest.runs;
    }
  }
}

// Wickets trim the same way as runs: a wicket count corrected downward never
// leaves more fall credits than the tally shows, newest first.
async function trimBowlers(tx: Queryable, match: Row, side: 'home' | 'away', wickets: number) {
  const teamId = side === 'home' ? match.home_team_id : match.away_team_id;
  if (!teamId) return;
  let assigned = (await one(
    tx,
    'SELECT coalesce(sum(wickets),0)::int AS total FROM cricket_wickets WHERE match_id=$1 AND team_id=$2',
    [match.id, teamId],
  ))!.total;
  while (assigned > wickets) {
    const latest = await one(
      tx,
      'SELECT id,wickets FROM cricket_wickets WHERE match_id=$1 AND team_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
      [match.id, teamId],
    );
    if (!latest) return;
    const excess = assigned - wickets;
    if (latest.wickets > excess) {
      await tx.query('UPDATE cricket_wickets SET wickets=wickets-$2 WHERE id=$1', [
        latest.id,
        excess,
      ]);
      assigned = wickets;
    } else {
      await tx.query('DELETE FROM cricket_wickets WHERE id=$1', [latest.id]);
      assigned -= latest.wickets;
    }
  }
}

// Round labels for the knockout report, in the order the bracket plays out.
const knockoutStageLabels: Record<string, string> = {
  quarter: 'Quarterfinals',
  semi: 'Semifinals',
  final: 'Final',
};

export async function registerCricket(app: FastifyInstance, db: Database, c: Config) {
  const guard = auth(db, c);
  app.get('/cricket/data', async () => {
    const groupData = [];
    for (const code of groups)
      groupData.push({
        code,
        table: await standings(db, code),
        matches: (
          await db.query<Row>(
            "SELECT * FROM cricket_matches WHERE stage='group' AND group_code=$1 ORDER BY group_position,created_at,id",
            [code],
          )
        ).rows,
      });
    const bracket = (
      await db.query<Row>(
        "SELECT * FROM cricket_matches WHERE stage <> 'group' ORDER BY CASE stage WHEN 'quarter' THEN 1 WHEN 'semi' THEN 2 ELSE 3 END,bracket_position",
      )
    ).rows;
    const teams = (
      await db.query<Row>(
        `SELECT t.id,i.team_name,i.logo_url,t.group_code,t.group_assigned_at,t.selected,
   coalesce((SELECT json_agg(json_build_object('id',p.id,'player_name',p.player_name) ORDER BY p.position,p.created_at,p.id)
     FROM team_players p WHERE p.order_item_id=t.order_item_id),'[]') AS players
         FROM cricket_teams t JOIN order_items i ON i.id=t.order_item_id
         ORDER BY i.team_name,t.id`,
      )
    ).rows;
    return { groups: groupData, bracket, teams };
  });
  // Only a running match is published, so the big-screen page shows the sponsor
  // rotation until an organizer starts one and switches back when it ends.
  app.get('/cricket/live', async () =>
    publicMatch(
      db,
      await one(
        db,
        "SELECT * FROM cricket_matches WHERE status='live' ORDER BY created_at LIMIT 1",
      ),
    ),
  );

  app.get('/admin/cricket', { preHandler: guard.admin }, async () => {
    const data = await app.inject({ method: 'GET', url: '/cricket/data' });
    return data.json();
  });
  // The organizer exports a stage once it finishes: every fixture with its final
  // scoreline and the players credited with the runs, grouped by group or round.
  app.get('/admin/cricket/report', { preHandler: guard.admin }, async (req) => {
    const query = z
      .object({ stage: z.enum(['group', 'knockout']).default('group') })
      .parse(req.query);
    const data = (await app.inject({ method: 'GET', url: '/cricket/data' })).json() as {
      groups: { code: string; matches: Row[] }[];
      bracket: Row[];
      teams: Row[];
    };
    const names = new Map<string, string>(data.teams.map((team) => [team.id, team.team_name]));
    const credits = new Map<string, { player_name: string; runs: number }[]>();
    const creditRows = await db.query<Row>(
      `SELECT s.match_id,s.team_id,p.player_name,sum(s.runs)::int AS runs
       FROM cricket_scorers s JOIN team_players p ON p.id=s.player_id
       GROUP BY s.match_id,s.team_id,p.player_name
       ORDER BY min(s.created_at),p.player_name`,
    );
    for (const row of creditRows.rows) {
      const key = `${row.match_id}:${row.team_id}`;
      credits.set(key, [
        ...(credits.get(key) ?? []),
        { player_name: row.player_name, runs: row.runs },
      ]);
    }
    // Wicket credits ride along with the run credits in the same export, so the
    // finished report names the bowlers too.
    const wicketCredits = new Map<string, { player_name: string; wickets: number }[]>();
    const wicketRows = await db.query<Row>(
      `SELECT w.match_id,w.team_id,p.player_name,sum(w.wickets)::int AS wickets
       FROM cricket_wickets w JOIN team_players p ON p.id=w.player_id
       GROUP BY w.match_id,w.team_id,p.player_name
       ORDER BY min(w.created_at),p.player_name`,
    );
    for (const row of wicketRows.rows) {
      const key = `${row.match_id}:${row.team_id}`;
      wicketCredits.set(key, [
        ...(wicketCredits.get(key) ?? []),
        { player_name: row.player_name, wickets: row.wickets },
      ]);
    }
    const matchView = (match: Row) => ({
      home_team: names.get(match.home_team_id) ?? 'Team to be confirmed',
      away_team: names.get(match.away_team_id) ?? 'Team to be confirmed',
      home_score: match.home_score,
      away_score: match.away_score,
      home_wickets: match.home_wickets,
      away_wickets: match.away_wickets,
      home_overs: Number(match.home_overs),
      away_overs: Number(match.away_overs),
      status: match.status,
      home_scorers: match.home_team_id
        ? (credits.get(`${match.id}:${match.home_team_id}`) ?? [])
        : [],
      away_scorers: match.away_team_id
        ? (credits.get(`${match.id}:${match.away_team_id}`) ?? [])
        : [],
      home_bowlers: match.home_team_id
        ? (wicketCredits.get(`${match.id}:${match.home_team_id}`) ?? [])
        : [],
      away_bowlers: match.away_team_id
        ? (wicketCredits.get(`${match.id}:${match.away_team_id}`) ?? [])
        : [],
      // A level score only hides who won the super over, in group or knockout alike.
      penalty_winner:
        match.home_score === match.away_score && match.winner_team_id
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
      sport: 'cricket',
      stage: query.stage,
      title: event?.title ?? 'RONB Corporate Championship',
      sections,
    };
  });
  app.post('/admin/cricket/import', { preHandler: guard.superAdmin }, async (req) =>
    db.transaction(async (tx) => {
      const sport = await one(tx, "SELECT id FROM sports WHERE lower(name) LIKE 'crick%'");
      assert(sport, 404, 'cricket_missing', 'Create the Cricket sport first');
      const result = await tx.query<Row>(
        `INSERT INTO cricket_teams(order_item_id,team_name,logo_url)
      SELECT i.id,i.team_name,i.logo_url FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE i.sport_id=$1 AND o.status IN ('confirmed','contacted','completed')
      ON CONFLICT(order_item_id) DO NOTHING RETURNING id`,
        [sport.id],
      );
      await audit(tx, req.actor!.id, 'cricket.import', 'cricket', sport.id, {
        imported: result.rows.length,
      });
      return {
        imported: result.rows.length,
        total: (await one(tx, 'SELECT count(*)::int AS count FROM cricket_teams'))!.count,
      };
    }),
  );
  app.patch('/admin/cricket/teams/:id/group', { preHandler: guard.superAdmin }, async (req) =>
    db.transaction(async (tx) => {
      assert(
        !(await one(tx, 'SELECT id FROM cricket_matches LIMIT 1')),
        409,
        'fixtures_exist',
        'Groups cannot change after fixtures are created',
      );
      const team = await one(tx, 'SELECT * FROM cricket_teams WHERE id=$1 FOR UPDATE', [
        params.parse(req.params).id,
      ]);
      assert(team, 404, 'not_found', 'Team not found');
      const body = groupBody.parse(req.body);
      if (body.group_code) {
        const count = await one(
          tx,
          'SELECT count(*)::int AS count FROM cricket_teams WHERE group_code=$1 AND id<>$2',
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
      await tx.query('UPDATE cricket_teams SET group_code=$1,group_assigned_at=$2 WHERE id=$3', [
        body.group_code,
        stamped,
        team.id,
      ]);
      await audit(tx, req.actor!.id, 'cricket.team.group_assign', 'cricket', team.id, {
        group_code: body.group_code,
      });
      return one(tx, 'SELECT * FROM cricket_teams WHERE id=$1', [team.id]);
    }),
  );
  app.post('/admin/cricket/generate-fixtures', { preHandler: guard.superAdmin }, async (req) =>
    db.transaction(async (tx) => {
      assert(
        !(await one(tx, 'SELECT id FROM cricket_matches LIMIT 1')),
        409,
        'fixtures_exist',
        'Fixtures already exist',
      );
      const count = await one(tx, 'SELECT count(*)::int AS total FROM cricket_teams');
      assert(
        count?.total === 16,
        409,
        'team_count',
        'Cricksal requires exactly 16 imported confirmed teams',
      );
      for (const group of groups) {
        // Placement order fixes the six pairings for each group of four.
        const teams = (
          await tx.query<Row>(
            'SELECT id FROM cricket_teams WHERE group_code=$1 ORDER BY group_assigned_at,id',
            [group],
          )
        ).rows;
        assert(teams.length === 4, 409, 'groups_incomplete', `Group ${group} needs four teams`);
        for (const [position, [home, away]] of groupRoundRobin.entries())
          await tx.query(
            "INSERT INTO cricket_matches(stage,group_code,group_position,home_team_id,away_team_id) VALUES('group',$1,$2,$3,$4)",
            [group, position + 1, teams[home].id, teams[away].id],
          );
      }
      await audit(
        tx,
        req.actor!.id,
        'cricket.fixtures.generate',
        'cricket',
        (await one(tx, 'SELECT id FROM cricket_teams LIMIT 1'))!.id,
        { matches: 24 },
      );
      return { matches: 24 };
    }),
  );
  app.post('/admin/cricket/matches/:id/start', { preHandler: guard.admin }, async (req) =>
    db.transaction(async (tx) => {
      const b = z
        .object({ batting_side: battingSide.default('home') })
        .strict()
        .parse(req.body ?? {});
      const m = await one(tx, 'SELECT * FROM cricket_matches WHERE id=$1 FOR UPDATE', [
        params.parse(req.params).id,
      ]);
      assert(m, 404, 'not_found', 'Match not found');
      assert(m.status === 'scheduled', 409, 'invalid_state', 'Only scheduled matches can start');
      assert(m.home_team_id && m.away_team_id, 409, 'teams_pending', 'Both teams must be known');
      return one(
        tx,
        "UPDATE cricket_matches SET status='live',batting_side=$2,version=version+1 WHERE id=$1 RETURNING *",
        [m.id, b.batting_side],
      );
    }),
  );
  // The innings break swaps the two roles: the side that bowled first comes in to
  // bat. Bumping the version redraws the projector, which keys on it.
  app.post('/admin/cricket/matches/:id/batting', { preHandler: guard.admin }, async (req) =>
    db.transaction(async (tx) => {
      const b = z
        .object({ version: z.number().int().positive(), batting_side: battingSide })
        .strict()
        .parse(req.body);
      const m = await one(tx, 'SELECT * FROM cricket_matches WHERE id=$1 FOR UPDATE', [
        params.parse(req.params).id,
      ]);
      assert(m, 404, 'not_found', 'Match not found');
      assert(
        m.status === 'live',
        409,
        'invalid_state',
        'Batting can only change while the match is live',
      );
      assert(
        m.version === b.version,
        409,
        'stale_match',
        'This score changed elsewhere. Refresh and try again.',
      );
      const updated = await one(
        tx,
        'UPDATE cricket_matches SET batting_side=$2,version=version+1 WHERE id=$1 RETURNING *',
        [m.id, b.batting_side],
      );
      await audit(tx, req.actor!.id, 'cricket.match.batting', 'cricket', m.id, {
        batting_side: b.batting_side,
      });
      return updated;
    }),
  );
  app.patch('/admin/cricket/matches/:id', { preHandler: guard.admin }, async (req) =>
    db.transaction(async (tx) => {
      const b = scoreBody.parse(req.body);
      const m = await one(tx, 'SELECT * FROM cricket_matches WHERE id=$1 FOR UPDATE', [
        params.parse(req.params).id,
      ]);
      assert(m, 404, 'not_found', 'Match not found');
      assert(m.status === 'live', 409, 'invalid_state', 'Only live match scores can be saved');
      assert(
        m.version === b.version,
        409,
        'stale_match',
        'This score changed elsewhere. Refresh and try again.',
      );
      const updated = (await one(
        tx,
        `UPDATE cricket_matches SET home_score=$2,away_score=$3,
           home_wickets=coalesce($4,home_wickets),away_wickets=coalesce($5,away_wickets),
           home_overs=coalesce($6,home_overs),away_overs=coalesce($7,away_overs),
           version=version+1 WHERE id=$1 RETURNING *`,
        [
          m.id,
          b.home_score,
          b.away_score,
          b.home_wickets ?? null,
          b.away_wickets ?? null,
          b.home_overs ?? null,
          b.away_overs ?? null,
        ],
      ))!;
      await trimScorers(tx, updated, 'home', updated.home_score);
      await trimScorers(tx, updated, 'away', updated.away_score);
      await trimBowlers(tx, updated, 'home', updated.home_wickets);
      await trimBowlers(tx, updated, 'away', updated.away_wickets);
      return updated;
    }),
  );
  // The organizer saves a raised score and then credits it to a batsman from the
  // team's roster, which is what /cricket/match prints under the team name.
  app.post('/admin/cricket/matches/:id/scorers', { preHandler: guard.admin }, async (req) =>
    db.transaction(async (tx) => {
      const b = z
        .object({ team_id: uuid, player_id: uuid, runs: z.number().int().min(1).max(999) })
        .strict()
        .parse(req.body);
      const m = await one(tx, 'SELECT * FROM cricket_matches WHERE id=$1 FOR UPDATE', [
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
        `SELECT p.id FROM team_players p JOIN cricket_teams t ON t.order_item_id=p.order_item_id
         WHERE t.id=$1 AND p.id=$2`,
        [b.team_id, b.player_id],
      );
      assert(player, 404, 'player_not_found', 'That player is not on the team roster');
      const score = b.team_id === m.home_team_id ? m.home_score : m.away_score;
      const assigned = (await one(
        tx,
        'SELECT coalesce(sum(runs),0)::int AS total FROM cricket_scorers WHERE match_id=$1 AND team_id=$2',
        [m.id, b.team_id],
      ))!.total;
      assert(
        assigned + b.runs <= score,
        409,
        'scorers_exceed_score',
        `Only ${score - assigned} of the team's ${score} runs are still unassigned`,
      );
      const row = await one(
        tx,
        'INSERT INTO cricket_scorers(match_id,team_id,player_id,runs) VALUES($1,$2,$3,$4) RETURNING *',
        [m.id, b.team_id, b.player_id, b.runs],
      );
      await audit(tx, req.actor!.id, 'cricket.match.scorer', 'cricket', m.id, {
        team_id: b.team_id,
        player_id: b.player_id,
        runs: b.runs,
      });
      return row;
    }),
  );
  // A raised wicket count asks who took each wicket, in the same prompt-and-credit
  // flow as the runs. The total credited to a team's bowlers never passes the
  // team's wicket tally; correcting the score down trims the newest first.
  app.post('/admin/cricket/matches/:id/wickets', { preHandler: guard.admin }, async (req) =>
    db.transaction(async (tx) => {
      const b = z
        .object({ team_id: uuid, player_id: uuid, wickets: z.number().int().min(1).max(7) })
        .strict()
        .parse(req.body);
      const m = await one(tx, 'SELECT * FROM cricket_matches WHERE id=$1 FOR UPDATE', [
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
        `SELECT p.id FROM team_players p JOIN cricket_teams t ON t.order_item_id=p.order_item_id
         WHERE t.id=$1 AND p.id=$2`,
        [b.team_id, b.player_id],
      );
      assert(player, 404, 'player_not_found', 'That player is not on the team roster');
      const wickets = b.team_id === m.home_team_id ? m.home_wickets : m.away_wickets;
      const credited = (await one(
        tx,
        'SELECT coalesce(sum(wickets),0)::int AS total FROM cricket_wickets WHERE match_id=$1 AND team_id=$2',
        [m.id, b.team_id],
      ))!.total;
      assert(
        credited + b.wickets <= wickets,
        409,
        'wickets_exceed_total',
        `Only ${wickets - credited} of the team's ${wickets} wickets are still unassigned`,
      );
      const row = await one(
        tx,
        'INSERT INTO cricket_wickets(match_id,team_id,player_id,wickets) VALUES($1,$2,$3,$4) RETURNING *',
        [m.id, b.team_id, b.player_id, b.wickets],
      );
      await audit(tx, req.actor!.id, 'cricket.match.wicket', 'cricket', m.id, {
        team_id: b.team_id,
        player_id: b.player_id,
        wickets: b.wickets,
      });
      return row;
    }),
  );
  // Cricket matches never finish level: a tie on the board is settled by a super
  // over, whose winner must be named when the match is ended — group or knockout.
  app.post('/admin/cricket/matches/:id/end', { preHandler: guard.admin }, async (req) =>
    db.transaction(async (tx) => {
      const b = z
        .object({ version: z.number().int().positive(), penalty_winner_id: uuid.optional() })
        .strict()
        .parse(req.body);
      const m = await one(tx, 'SELECT * FROM cricket_matches WHERE id=$1 FOR UPDATE', [
        params.parse(req.params).id,
      ]);
      assert(m, 404, 'not_found', 'Match not found');
      assert(m.status === 'live', 409, 'invalid_state', 'Only live matches can end');
      assert(
        m.version === b.version,
        409,
        'stale_match',
        'This score changed elsewhere. Refresh and try again.',
      );
      let winner: string;
      if (m.home_score === m.away_score) {
        assert(
          b.penalty_winner_id === m.home_team_id || b.penalty_winner_id === m.away_team_id,
          400,
          'winner_required',
          'Choose the super over winner for a tied cricket match',
        );
        winner = b.penalty_winner_id!;
      } else winner = m.home_score > m.away_score ? m.home_team_id : m.away_team_id;
      const done = await one(
        tx,
        "UPDATE cricket_matches SET status='completed',winner_team_id=$2,completed_at=now(),version=version+1 WHERE id=$1 RETURNING *",
        [m.id, winner],
      );
      if (m.stage === 'group') {
        const complete = await one(
          tx,
          "SELECT count(*)::int AS total,count(*) FILTER (WHERE status='completed')::int AS completed FROM cricket_matches WHERE stage='group'",
        );
        if (complete?.total === 24 && complete.completed === 24) {
          await createBracket(tx);
          await audit(tx, req.actor!.id, 'cricket.bracket.generate', 'cricket', m.id, {
            teams: 8,
            automatic: true,
          });
        }
      }
      const next = nextSlot(m.stage, m.bracket_position);
      if (next)
        await tx.query(
          `UPDATE cricket_matches SET ${next.slot}=$1 WHERE stage=$2 AND bracket_position=$3`,
          [winner, next.stage, next.position],
        );
      await audit(tx, req.actor!.id, 'cricket.match.end', 'cricket', m.id, { winner });
      return done;
    }),
  );
}
