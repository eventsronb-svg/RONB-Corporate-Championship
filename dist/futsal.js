import { z } from 'zod';
import { auth } from './auth.js';
import { one } from './db.js';
import { assert } from './errors.js';
import { audit, uuid } from './orders.js';
const groupCodes = ['A', 'B', 'C', 'D', 'E', 'F'];
// Group fixtures for four teams in placement order, so the first pairing round is
// a1–a2 with a3–a4, the second a1–a3 with a2–a4, and the third a1–a4 with a2–a3.
const groupRoundRobin = [
    [0, 1],
    [2, 3],
    [0, 2],
    [1, 3],
    [0, 3],
    [1, 2],
];
const scoreBody = z
    .object({
    home_score: z.number().int().min(0).max(999),
    away_score: z.number().int().min(0).max(999),
    version: z.number().int().positive(),
})
    .strict();
const groupBody = z.object({ group_code: z.enum(groupCodes).nullable() }).strict();
const params = z.object({ id: uuid });
async function standings(tx, group) {
    const teams = (await tx.query(`SELECT t.id,t.order_item_id,i.team_name,i.logo_url,t.group_code,t.group_assigned_at,t.created_at
       FROM futsal_teams t JOIN order_items i ON i.id=t.order_item_id
       WHERE t.group_code=$1 ORDER BY i.team_name,t.id`, [group])).rows;
    const matches = (await tx.query(`SELECT * FROM futsal_matches WHERE stage='group' AND group_code=$1 AND status='completed'`, [group])).rows;
    const table = new Map(teams.map((t) => [
        t.id,
        {
            ...t,
            played: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            goals_for: 0,
            goals_against: 0,
            goal_difference: 0,
            points: 0,
        },
    ]));
    for (const m of matches) {
        const home = table.get(m.home_team_id);
        const away = table.get(m.away_team_id);
        if (!home || !away)
            continue;
        home.played++;
        away.played++;
        home.goals_for += m.home_score;
        home.goals_against += m.away_score;
        away.goals_for += m.away_score;
        away.goals_against += m.home_score;
        if (m.home_score > m.away_score) {
            home.wins++;
            home.points += 3;
            away.losses++;
        }
        else if (m.away_score > m.home_score) {
            away.wins++;
            away.points += 3;
            home.losses++;
        }
        else {
            home.draws++;
            away.draws++;
            home.points++;
            away.points++;
        }
    }
    const values = [...table.values()];
    for (const row of values)
        row.goal_difference = row.goals_for - row.goals_against;
    values.sort((a, b) => b.points - a.points);
    for (let start = 0; start < values.length;) {
        let end = start + 1;
        while (end < values.length && values[end].points === values[start].points)
            end++;
        const tied = values.slice(start, end);
        const headToHead = tied.length === 2
            ? matches.find((m) => (m.home_team_id === tied[0].id && m.away_team_id === tied[1].id) ||
                (m.home_team_id === tied[1].id && m.away_team_id === tied[0].id))
            : undefined;
        tied.sort((a, b) => {
            if (headToHead) {
                if (headToHead.home_score !== headToHead.away_score) {
                    const winner = headToHead.home_score > headToHead.away_score
                        ? headToHead.home_team_id
                        : headToHead.away_team_id;
                    if (a.id === winner)
                        return -1;
                    if (b.id === winner)
                        return 1;
                }
            }
            return (b.goal_difference - a.goal_difference ||
                b.goals_for - a.goals_for ||
                a.team_name.localeCompare(b.team_name));
        });
        values.splice(start, tied.length, ...tied);
        start = end;
    }
    values.forEach((row, index) => (row.position = index + 1));
    return values;
}
async function publicMatch(tx, match) {
    if (!match)
        return null;
    const teams = (await tx.query(`SELECT t.id,i.team_name,i.logo_url FROM futsal_teams t
       JOIN order_items i ON i.id=t.order_item_id WHERE t.id=ANY($1::uuid[])`, [[match.home_team_id, match.away_team_id].filter(Boolean)])).rows;
    const byId = new Map(teams.map((t) => [t.id, t]));
    const scorersFor = async (teamId) => teamId
        ? (await tx.query(`SELECT s.player_id,p.player_name,sum(s.goals)::int AS goals
             FROM futsal_scorers s JOIN team_players p ON p.id=s.player_id
             WHERE s.match_id=$1 AND s.team_id=$2
             GROUP BY s.player_id,p.player_name
             ORDER BY min(s.created_at),p.player_name`, [match.id, teamId])).rows
        : [];
    return {
        ...match,
        home_team: byId.get(match.home_team_id) ?? null,
        away_team: byId.get(match.away_team_id) ?? null,
        home_scorers: await scorersFor(match.home_team_id),
        away_scorers: await scorersFor(match.away_team_id),
    };
}
function nextSlot(stage, position) {
    const next = stage === 'prequarter'
        ? 'quarter'
        : stage === 'quarter'
            ? 'semi'
            : stage === 'semi'
                ? 'final'
                : null;
    return next
        ? {
            stage: next,
            position: Math.ceil(position / 2),
            slot: position % 2 ? 'home_team_id' : 'away_team_id',
        }
        : null;
}
// Cross-group comparisons deliberately do not use head-to-head or team names.
function compareThirdPlace(a, b) {
    return b.points - a.points || b.goal_difference - a.goal_difference || b.goals_for - a.goals_for;
}
async function thirdPlaceRanking(tx, tables, complete) {
    const table = tables
        .flatMap((rows) => (rows[2] ? [rows[2]] : []))
        .sort((a, b) => compareThirdPlace(a, b) || a.group_code.localeCompare(b.group_code));
    // Bind a recorded draw to these exact teams and statistics, so stale decisions
    // cannot settle a different qualification tie.
    const signature = JSON.stringify(table
        .map((row) => [row.id, row.points, row.goal_difference, row.goals_for])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const draw = await one(tx, 'SELECT * FROM futsal_third_place_draw WHERE singleton=true');
    const drawApplied = complete && draw?.signature === signature;
    if (drawApplied) {
        const order = new Map(draw.team_ids.map((id, index) => [id, index]));
        table.sort((a, b) => compareThirdPlace(a, b) || order.get(a.id) - order.get(b.id));
    }
    const cutoffTie = table.length === 6 && compareThirdPlace(table[3], table[4]) === 0;
    const drawRequired = complete && cutoffTie && !drawApplied;
    const cutoffTeams = drawRequired
        ? table.filter((row) => compareThirdPlace(row, table[3]) === 0).map((row) => row.id)
        : [];
    return {
        table: table.map((row, index) => ({
            ...row,
            id: row.id,
            position: index + 1,
            qualified: complete && (drawRequired ? compareThirdPlace(row, table[3]) < 0 : index < 4),
            draw_pending: cutoffTeams.includes(row.id),
        })),
        complete,
        draw_required: drawRequired,
        draw_applied: drawApplied,
        signature,
    };
}
async function qualification(tx) {
    const tables = [];
    for (const code of groupCodes)
        tables.push(await standings(tx, code));
    const counts = await one(tx, "SELECT count(*)::int AS total,count(*) FILTER (WHERE status='completed')::int AS completed FROM futsal_matches WHERE stage='group'");
    const complete = counts?.total === 36 &&
        counts.completed === 36 &&
        tables.every((rows) => rows.length === 4 && rows.every((row) => row.played === 3));
    return { tables, thirdPlace: await thirdPlaceRanking(tx, tables, complete) };
}
async function createKnockout(tx) {
    const { tables, thirdPlace } = await qualification(tx);
    assert(thirdPlace.complete, 409, 'groups_incomplete', 'Complete all 36 group matches in six groups of four before generating the bracket');
    assert(!(await one(tx, "SELECT id FROM futsal_matches WHERE stage='prequarter' LIMIT 1")), 409, 'bracket_exists', 'The knockout bracket already exists');
    assert(!thirdPlace.draw_required, 409, 'third_place_draw_required', 'Record a manual draw for the tied third-place teams before generating the bracket');
    // Six group winners plus runners-up A and B form one side of the draw.
    // Match the four best third-place teams and remaining runners-up to them,
    // backtracking when needed to avoid every same-group Round of 16 matchup.
    const seeds = [...tables.map((rows) => rows[0]), tables[0][1], tables[1][1]];
    const opponents = [...thirdPlace.table.slice(0, 4), ...tables.slice(2).map((rows) => rows[1])];
    function pair(index, remaining) {
        if (index === seeds.length)
            return [];
        for (const opponent of remaining) {
            if (opponent.group_code === seeds[index].group_code)
                continue;
            const rest = pair(index + 1, remaining.filter((row) => row.id !== opponent.id));
            if (rest)
                return [opponent, ...rest];
        }
        return null;
    }
    const paired = pair(0, opponents);
    assert(paired, 409, 'draw_unavailable', 'Could not create a draw without same-group matchups');
    for (let i = 0; i < seeds.length; i++) {
        await tx.query(`INSERT INTO futsal_matches(stage,bracket_position,home_team_id,away_team_id) VALUES('prequarter',$1,$2,$3)`, [i + 1, seeds[i].id, paired[i].id]);
    }
    for (let i = 1; i <= 4; i++)
        await tx.query("INSERT INTO futsal_matches(stage,bracket_position) VALUES('quarter',$1)", [i]);
    for (let i = 1; i <= 2; i++)
        await tx.query("INSERT INTO futsal_matches(stage,bracket_position) VALUES('semi',$1)", [i]);
    await tx.query("INSERT INTO futsal_matches(stage,bracket_position) VALUES('final',1)");
}
// A score corrected downwards must not leave more goals credited to players than
// the team has on the board, so the newest assignments are trimmed first. One
// assignment can cover several goals, so a partial trim shrinks it instead of
// dropping it.
async function trimScorers(tx, match, side, score) {
    const teamId = side === 'home' ? match.home_team_id : match.away_team_id;
    if (!teamId)
        return;
    let assigned = (await one(tx, 'SELECT coalesce(sum(goals),0)::int AS total FROM futsal_scorers WHERE match_id=$1 AND team_id=$2', [match.id, teamId])).total;
    while (assigned > score) {
        const latest = await one(tx, 'SELECT id,goals FROM futsal_scorers WHERE match_id=$1 AND team_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', [match.id, teamId]);
        if (!latest)
            return;
        const excess = assigned - score;
        if (latest.goals > excess) {
            await tx.query('UPDATE futsal_scorers SET goals=goals-$2 WHERE id=$1', [latest.id, excess]);
            assigned = score;
        }
        else {
            await tx.query('DELETE FROM futsal_scorers WHERE id=$1', [latest.id]);
            assigned -= latest.goals;
        }
    }
}
// Round labels for the knockout report, in the order the bracket plays out.
const knockoutStageLabels = {
    prequarter: 'Round of 16',
    quarter: 'Quarterfinals',
    semi: 'Semifinals',
    final: 'Final',
};
export async function registerFutsal(app, db, c) {
    const guard = auth(db, c);
    app.get('/futsal/data', async () => {
        const groups = [];
        for (const code of groupCodes)
            groups.push({
                code,
                table: await standings(db, code),
                matches: (await db.query("SELECT * FROM futsal_matches WHERE stage='group' AND group_code=$1 ORDER BY group_position,created_at,id", [code])).rows,
            });
        const bracket = (await db.query("SELECT * FROM futsal_matches WHERE stage <> 'group' ORDER BY CASE stage WHEN 'prequarter' THEN 1 WHEN 'quarter' THEN 2 WHEN 'semi' THEN 3 ELSE 4 END,bracket_position")).rows;
        const teams = (await db.query(`SELECT t.id,i.team_name,i.logo_url,t.group_code,t.group_assigned_at,
   coalesce((SELECT json_agg(json_build_object('id',p.id,'player_name',p.player_name) ORDER BY p.position,p.created_at,p.id)
     FROM team_players p WHERE p.order_item_id=t.order_item_id),'[]') AS players
          FROM futsal_teams t JOIN order_items i ON i.id=t.order_item_id
          ORDER BY i.team_name,t.id`)).rows;
        const complete = groups.length === 6 &&
            groups.every((group) => group.table.length === 4 &&
                group.matches.length === 6 &&
                group.matches.every((match) => match.status === 'completed'));
        const thirdPlace = await thirdPlaceRanking(db, groups.map((group) => group.table), complete);
        return { groups, bracket, teams, third_place: thirdPlace };
    });
    // Only a running match is published, so the big-screen page shows the sponsor
    // rotation until an organizer starts one and switches back when it ends.
    app.get('/futsal/live', async () => publicMatch(db, await one(db, "SELECT * FROM futsal_matches WHERE status='live' ORDER BY created_at LIMIT 1")));
    app.get('/admin/futsal', { preHandler: guard.admin }, async () => {
        const data = await app.inject({ method: 'GET', url: '/futsal/data' });
        return data.json();
    });
    // The organizer exports a stage once it finishes: every fixture with its final
    // score and the players credited with the goals, grouped by round for the PDF.
    app.get('/admin/futsal/report', { preHandler: guard.admin }, async (req) => {
        const query = z
            .object({ stage: z.enum(['group', 'knockout']).default('group') })
            .parse(req.query);
        const data = (await app.inject({ method: 'GET', url: '/futsal/data' })).json();
        const names = new Map(data.teams.map((team) => [team.id, team.team_name]));
        const credits = new Map();
        const creditRows = await db.query(`SELECT s.match_id,s.team_id,p.player_name,sum(s.goals)::int AS goals
       FROM futsal_scorers s JOIN team_players p ON p.id=s.player_id
       GROUP BY s.match_id,s.team_id,p.player_name
       ORDER BY min(s.created_at),p.player_name`);
        for (const row of creditRows.rows) {
            const key = `${row.match_id}:${row.team_id}`;
            credits.set(key, [
                ...(credits.get(key) ?? []),
                { player_name: row.player_name, goals: row.goals },
            ]);
        }
        const matchView = (match) => ({
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
            penalty_winner: match.stage !== 'group' && match.home_score === match.away_score && match.winner_team_id
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
        }
        else {
            const byStage = new Map();
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
            sport: 'futsal',
            stage: query.stage,
            title: event?.title ?? 'RONB Corporate Championship',
            sections,
        };
    });
    app.post('/admin/futsal/import', { preHandler: guard.superAdmin }, async (req) => db.transaction(async (tx) => {
        const sport = await one(tx, "SELECT id FROM sports WHERE lower(name)='futsal'");
        assert(sport, 404, 'futsal_missing', 'Create the Futsal sport first');
        const result = await tx.query(`INSERT INTO futsal_teams(order_item_id,team_name,logo_url)
      SELECT i.id,i.team_name,i.logo_url FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE i.sport_id=$1 AND o.status IN ('confirmed','contacted','completed')
      ON CONFLICT(order_item_id) DO NOTHING RETURNING id`, [sport.id]);
        await audit(tx, req.actor.id, 'futsal.import', 'futsal', sport.id, {
            imported: result.rows.length,
        });
        return {
            imported: result.rows.length,
            total: (await one(tx, 'SELECT count(*)::int AS count FROM futsal_teams')).count,
        };
    }));
    app.patch('/admin/futsal/teams/:id/group', { preHandler: guard.superAdmin }, async (req) => db.transaction(async (tx) => {
        assert(!(await one(tx, 'SELECT id FROM futsal_matches LIMIT 1')), 409, 'fixtures_exist', 'Groups cannot change after fixtures are created');
        const team = await one(tx, 'SELECT * FROM futsal_teams WHERE id=$1 FOR UPDATE', [
            params.parse(req.params).id,
        ]);
        assert(team, 404, 'not_found', 'Team not found');
        const body = groupBody.parse(req.body);
        if (body.group_code) {
            const count = await one(tx, 'SELECT count(*)::int AS count FROM futsal_teams WHERE group_code=$1 AND id<>$2', [body.group_code, team.id]);
            assert((count?.count ?? 0) < 4, 409, 'group_full', `Group ${body.group_code} already has four teams`);
        }
        // Re-saving the same group keeps this team's place in the draw; clearing the
        // group drops the stamp so a later assignment draws a fresh order.
        const stamped = body.group_code === team.group_code
            ? team.group_assigned_at
            : body.group_code
                ? new Date()
                : null;
        await tx.query('UPDATE futsal_teams SET group_code=$1,group_assigned_at=$2 WHERE id=$3', [
            body.group_code,
            stamped,
            team.id,
        ]);
        await audit(tx, req.actor.id, 'futsal.team.group_assign', 'futsal', team.id, {
            group_code: body.group_code,
        });
        return one(tx, 'SELECT * FROM futsal_teams WHERE id=$1', [team.id]);
    }));
    app.post('/admin/futsal/generate-groups', { preHandler: guard.superAdmin }, async (req) => db.transaction(async (tx) => {
        assert(!(await one(tx, 'SELECT id FROM futsal_matches LIMIT 1')), 409, 'fixtures_exist', 'Groups cannot change after fixtures are created');
        const teams = (await tx.query('SELECT * FROM futsal_teams ORDER BY team_name,id FOR UPDATE')).rows;
        assert(teams.length === 24, 409, 'team_count', 'Futsal requires exactly 24 imported confirmed teams');
        return { groups: 6, assigned: teams.filter((team) => team.group_code).length };
    }));
    app.post('/admin/futsal/generate-fixtures', { preHandler: guard.superAdmin }, async (req) => db.transaction(async (tx) => {
        assert(!(await one(tx, 'SELECT id FROM futsal_matches LIMIT 1')), 409, 'fixtures_exist', 'Fixtures already exist');
        const count = await one(tx, 'SELECT count(*)::int AS total FROM futsal_teams');
        assert(count?.total === 24, 409, 'team_count', 'Futsal requires exactly 24 imported confirmed teams');
        for (const group of groupCodes) {
            // a1 is the first team placed in the group, a4 the last, so the round
            // robin pairs a1–a2 with a3–a4, then a1–a3 with a2–a4, then a1–a4 with a2–a3.
            const teams = (await tx.query('SELECT id FROM futsal_teams WHERE group_code=$1 ORDER BY group_assigned_at,id', [group])).rows;
            assert(teams.length === 4, 409, 'groups_incomplete', `Group ${group} needs four teams`);
            for (const [position, [home, away]] of groupRoundRobin.entries())
                await tx.query("INSERT INTO futsal_matches(stage,group_code,group_position,home_team_id,away_team_id) VALUES('group',$1,$2,$3,$4)", [group, position + 1, teams[home].id, teams[away].id]);
        }
        await audit(tx, req.actor.id, 'futsal.fixtures.generate', 'futsal', (await one(tx, 'SELECT id FROM futsal_teams LIMIT 1')).id, { matches: 36 });
        return { matches: 36 };
    }));
    app.post('/admin/futsal/third-place-draw', { preHandler: guard.superAdmin }, async (req) => db.transaction(async (tx) => {
        const body = z
            .object({
            team_ids: z.array(uuid).length(6),
            signature: z.string(),
        })
            .strict()
            .parse(req.body);
        assert(!(await one(tx, "SELECT id FROM futsal_matches WHERE stage <> 'group' LIMIT 1")), 409, 'bracket_exists', 'The knockout bracket already exists');
        const { thirdPlace } = await qualification(tx);
        assert(thirdPlace.complete, 409, 'groups_incomplete', 'Complete all 36 group matches before recording the draw');
        assert(body.signature === thirdPlace.signature, 409, 'stale_draw', 'The standings changed. Refresh before recording the draw');
        assert(thirdPlace.draw_required, 409, 'draw_not_required', 'No qualification tie needs a manual draw');
        const byId = new Map(thirdPlace.table.map((row) => [row.id, row]));
        assert(new Set(body.team_ids).size === 6 && body.team_ids.every((id) => byId.has(id)), 400, 'invalid_draw', 'Include each third-place team exactly once');
        const ordered = body.team_ids.map((id) => byId.get(id));
        assert(ordered.every((row, index) => index === 0 || compareThirdPlace(ordered[index - 1], row) <= 0), 400, 'invalid_draw', 'The draw may only reorder teams tied on points, goal difference and goals scored');
        await tx.query(`INSERT INTO futsal_third_place_draw(singleton,signature,team_ids,admin_id)
         VALUES(true,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE
         SET signature=excluded.signature,team_ids=excluded.team_ids,admin_id=excluded.admin_id,created_at=now()`, [thirdPlace.signature, body.team_ids, req.actor.id]);
        await audit(tx, req.actor.id, 'futsal.third_place.draw', 'futsal', body.team_ids[0], {
            team_ids: body.team_ids,
        });
        await createKnockout(tx);
        await audit(tx, req.actor.id, 'futsal.bracket.generate', 'futsal', body.team_ids[0], {
            teams: 16,
            automatic: false,
        });
        return { created: true };
    }));
    app.post('/admin/futsal/generate-knockout', { preHandler: guard.superAdmin }, async (req) => db.transaction(async (tx) => {
        await createKnockout(tx);
        await audit(tx, req.actor.id, 'futsal.bracket.generate', 'futsal', (await one(tx, 'SELECT id FROM futsal_teams LIMIT 1')).id, {});
        return { created: true };
    }));
    app.post('/admin/futsal/matches/:id/start', { preHandler: guard.admin }, async (req) => db.transaction(async (tx) => {
        // Serialize starts for this sport, including requests from other organizer tabs.
        await tx.query('SELECT pg_advisory_xact_lock(427201)');
        const m = await one(tx, 'SELECT * FROM futsal_matches WHERE id=$1 FOR UPDATE', [
            params.parse(req.params).id,
        ]);
        assert(m, 404, 'not_found', 'Match not found');
        assert(m.status === 'scheduled', 409, 'invalid_state', 'Only scheduled matches can start');
        assert(m.home_team_id && m.away_team_id, 409, 'teams_pending', 'Both teams must be known');
        assert(!(await one(tx, "SELECT id FROM futsal_matches WHERE status='live' LIMIT 1")), 409, 'match_already_live', 'Finish the live futsal match before starting another');
        return one(tx, "UPDATE futsal_matches SET status='live',version=version+1 WHERE id=$1 RETURNING *", [m.id]);
    }));
    app.patch('/admin/futsal/matches/:id', { preHandler: guard.admin }, async (req) => db.transaction(async (tx) => {
        const b = scoreBody.parse(req.body);
        const m = await one(tx, 'SELECT * FROM futsal_matches WHERE id=$1 FOR UPDATE', [
            params.parse(req.params).id,
        ]);
        assert(m, 404, 'not_found', 'Match not found');
        assert(m.status === 'live', 409, 'invalid_state', 'Only live match scores can be saved');
        assert(m.version === b.version, 409, 'stale_match', 'This score changed elsewhere. Refresh and try again.');
        const updated = (await one(tx, 'UPDATE futsal_matches SET home_score=$2,away_score=$3,version=version+1 WHERE id=$1 RETURNING *', [m.id, b.home_score, b.away_score]));
        await trimScorers(tx, updated, 'home', updated.home_score);
        await trimScorers(tx, updated, 'away', updated.away_score);
        return updated;
    }));
    // The organizer saves a raised score and then credits it to a player from the
    // team's roster, which is what /futsal/match prints under the team name.
    app.post('/admin/futsal/matches/:id/scorers', { preHandler: guard.admin }, async (req) => db.transaction(async (tx) => {
        const b = z
            .object({ team_id: uuid, player_id: uuid, goals: z.number().int().min(1).max(999) })
            .strict()
            .parse(req.body);
        const m = await one(tx, 'SELECT * FROM futsal_matches WHERE id=$1 FOR UPDATE', [
            params.parse(req.params).id,
        ]);
        assert(m, 404, 'not_found', 'Match not found');
        assert(b.team_id === m.home_team_id || b.team_id === m.away_team_id, 400, 'team_mismatch', 'That team is not playing in this match');
        const player = await one(tx, `SELECT p.id FROM team_players p JOIN futsal_teams t ON t.order_item_id=p.order_item_id
         WHERE t.id=$1 AND p.id=$2`, [b.team_id, b.player_id]);
        assert(player, 404, 'player_not_found', 'That player is not on the team roster');
        const score = b.team_id === m.home_team_id ? m.home_score : m.away_score;
        const assigned = (await one(tx, 'SELECT coalesce(sum(goals),0)::int AS total FROM futsal_scorers WHERE match_id=$1 AND team_id=$2', [m.id, b.team_id])).total;
        assert(assigned + b.goals <= score, 409, 'scorers_exceed_score', `Only ${score - assigned} of the team's ${score} goals are still unassigned`);
        const row = await one(tx, 'INSERT INTO futsal_scorers(match_id,team_id,player_id,goals) VALUES($1,$2,$3,$4) RETURNING *', [m.id, b.team_id, b.player_id, b.goals]);
        await audit(tx, req.actor.id, 'futsal.match.scorer', 'futsal', m.id, {
            team_id: b.team_id,
            player_id: b.player_id,
            goals: b.goals,
        });
        return row;
    }));
    app.post('/admin/futsal/matches/:id/end', { preHandler: guard.admin }, async (req) => db.transaction(async (tx) => {
        const b = z
            .object({ version: z.number().int().positive(), penalty_winner_id: uuid.optional() })
            .strict()
            .parse(req.body);
        const m = await one(tx, 'SELECT * FROM futsal_matches WHERE id=$1 FOR UPDATE', [
            params.parse(req.params).id,
        ]);
        assert(m, 404, 'not_found', 'Match not found');
        assert(m.status === 'live', 409, 'invalid_state', 'Only live matches can end');
        assert(m.version === b.version, 409, 'stale_match', 'This score changed elsewhere. Refresh and try again.');
        let winner = null;
        if (m.stage !== 'group') {
            if (m.home_score === m.away_score) {
                assert(b.penalty_winner_id === m.home_team_id || b.penalty_winner_id === m.away_team_id, 400, 'penalty_required', 'Choose the penalty winner for a tied knockout match');
                winner = b.penalty_winner_id;
            }
            else
                winner = m.home_score > m.away_score ? m.home_team_id : m.away_team_id;
        }
        const done = await one(tx, "UPDATE futsal_matches SET status='completed',winner_team_id=$2,completed_at=now(),version=version+1 WHERE id=$1 RETURNING *", [m.id, winner]);
        if (m.stage === 'group') {
            const complete = await one(tx, "SELECT count(*)::int AS total,count(*) FILTER (WHERE status='completed')::int AS completed FROM futsal_matches WHERE stage='group'");
            if (complete?.total === 36 && complete.completed === 36) {
                const { thirdPlace } = await qualification(tx);
                if (!thirdPlace.draw_required) {
                    await createKnockout(tx);
                    await audit(tx, req.actor.id, 'futsal.bracket.generate', 'futsal', m.id, {
                        teams: 16,
                        automatic: true,
                    });
                }
            }
        }
        if (winner) {
            const next = nextSlot(m.stage, m.bracket_position);
            if (next)
                await tx.query(`UPDATE futsal_matches SET ${next.slot}=$1 WHERE stage=$2 AND bracket_position=$3`, [winner, next.stage, next.position]);
        }
        await audit(tx, req.actor.id, 'futsal.match.end', 'futsal', m.id, { winner });
        return done;
    }));
}
//# sourceMappingURL=futsal.js.map