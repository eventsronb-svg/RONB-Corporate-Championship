import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from './auth.js';
import type { Config } from './config.js';
import type { Database, Queryable, Row } from './db.js';
import { one } from './db.js';
import { assert } from './errors.js';
import { audit, uuid } from './orders.js';

const groupCodes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
const scoreBody = z.object({ home_score: z.number().int().min(0).max(999), away_score: z.number().int().min(0).max(999), version: z.number().int().positive() }).strict();
const params = z.object({ id: uuid });

type Standing = Row & { played: number; wins: number; draws: number; losses: number; goals_for: number; goals_against: number; goal_difference: number; points: number };

async function standings(tx: Queryable, group: string): Promise<Standing[]> {
  const teams = (await tx.query<Row>('SELECT * FROM futsal_teams WHERE group_code=$1 ORDER BY team_name,id', [group])).rows;
  const matches = (await tx.query<Row>(`SELECT * FROM futsal_matches WHERE stage='group' AND group_code=$1 AND status='completed'`, [group])).rows;
  const table = new Map<string, Standing>(teams.map((t) => [t.id, { ...t, played: 0, wins: 0, draws: 0, losses: 0, goals_for: 0, goals_against: 0, goal_difference: 0, points: 0 }]));
  for (const m of matches) {
    const home = table.get(m.home_team_id); const away = table.get(m.away_team_id);
    if (!home || !away) continue;
    home.played++; away.played++; home.goals_for += m.home_score; home.goals_against += m.away_score; away.goals_for += m.away_score; away.goals_against += m.home_score;
    if (m.home_score > m.away_score) { home.wins++; home.points += 3; away.losses++; }
    else if (m.away_score > m.home_score) { away.wins++; away.points += 3; home.losses++; }
    else { home.draws++; away.draws++; home.points++; away.points++; }
  }
  const values = [...table.values()];
  for (const row of values) row.goal_difference = row.goals_for - row.goals_against;
  // FIFA-style automated order. A final unresolved tie is intentionally left for the organizer.
  values.sort((a, b) => b.points-a.points || b.goal_difference-a.goal_difference || b.goals_for-a.goals_for || a.team_name.localeCompare(b.team_name));
  values.forEach((row, index) => (row.position = index + 1));
  return values;
}

async function publicMatch(tx: Queryable, match: Row | undefined) {
  if (!match) return null;
  const teams = (await tx.query<Row>('SELECT id,team_name,logo_url FROM futsal_teams WHERE id=ANY($1::uuid[])', [[match.home_team_id, match.away_team_id].filter(Boolean)])).rows;
  const byId = new Map(teams.map((t) => [t.id, t]));
  return { ...match, home_team: byId.get(match.home_team_id) ?? null, away_team: byId.get(match.away_team_id) ?? null };
}

function nextSlot(stage: string, position: number) {
  const next = stage === 'prequarter' ? 'quarter' : stage === 'quarter' ? 'semi' : stage === 'semi' ? 'final' : null;
  return next ? { stage: next, position: Math.ceil(position / 2), slot: position % 2 ? 'home_team_id' : 'away_team_id' } : null;
}

async function createKnockout(tx: Queryable) {
  const groupMatches = await one(tx, "SELECT count(*)::int AS total,count(*) FILTER (WHERE status='completed')::int AS completed FROM futsal_matches WHERE stage='group'");
  assert(groupMatches?.total === 48 && groupMatches.completed === 48, 409, 'groups_incomplete', 'Complete all 48 group matches before generating the bracket');
  assert(!(await one(tx, "SELECT id FROM futsal_matches WHERE stage='prequarter' LIMIT 1")), 409, 'bracket_exists', 'The knockout bracket already exists');
  const qualifiers: Record<string, Standing[]> = {};
  for (const group of groupCodes) qualifiers[group] = (await standings(tx, group)).slice(0, 2);
  const pairings = [['A','B'],['C','D'],['E','F'],['G','H'],['B','A'],['D','C'],['F','E'],['H','G']] as const;
  for (let i=0;i<pairings.length;i++) {
    const [first, second] = pairings[i];
    await tx.query(`INSERT INTO futsal_matches(stage,bracket_position,home_team_id,away_team_id) VALUES('prequarter',$1,$2,$3)`, [i+1, qualifiers[first][0].id, qualifiers[second][1].id]);
  }
  for (let i=1;i<=4;i++) await tx.query("INSERT INTO futsal_matches(stage,bracket_position) VALUES('quarter',$1)", [i]);
  for (let i=1;i<=2;i++) await tx.query("INSERT INTO futsal_matches(stage,bracket_position) VALUES('semi',$1)", [i]);
  await tx.query("INSERT INTO futsal_matches(stage,bracket_position) VALUES('final',1)");
}

export async function registerFutsal(app: FastifyInstance, db: Database, c: Config) {
  const guard = auth(db, c);
  app.get('/futsal/data', async () => {
    const groups = [];
    for (const code of groupCodes) groups.push({ code, table: await standings(db, code), matches: (await db.query<Row>("SELECT * FROM futsal_matches WHERE stage='group' AND group_code=$1 ORDER BY created_at,id", [code])).rows });
    const bracket = (await db.query<Row>("SELECT * FROM futsal_matches WHERE stage <> 'group' ORDER BY CASE stage WHEN 'prequarter' THEN 1 WHEN 'quarter' THEN 2 WHEN 'semi' THEN 3 ELSE 4 END,bracket_position")).rows;
    const ids = [...new Set([...groups.flatMap(g=>g.matches), ...bracket].flatMap(m=>[m.home_team_id,m.away_team_id]).filter(Boolean))];
    const teams = ids.length ? (await db.query<Row>('SELECT id,team_name,logo_url FROM futsal_teams WHERE id=ANY($1::uuid[])',[ids])).rows : [];
    return { groups, bracket, teams };
  });
  app.get('/futsal/live', async () => publicMatch(db, await one(db, "SELECT * FROM futsal_matches WHERE status='live' ORDER BY created_at LIMIT 1") ?? await one(db, "SELECT * FROM futsal_matches WHERE status='scheduled' AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL ORDER BY CASE stage WHEN 'group' THEN 1 ELSE 2 END,group_code,bracket_position LIMIT 1")));

  app.get('/admin/futsal', { preHandler: guard.admin }, async () => {
    const data = await app.inject({ method: 'GET', url: '/futsal/data' });
    return data.json();
  });
  app.post('/admin/futsal/import', { preHandler: guard.superAdmin }, async (req) => db.transaction(async tx => {
    const sport = await one(tx, "SELECT id FROM sports WHERE lower(name)='futsal'"); assert(sport, 404, 'futsal_missing', 'Create the Futsal sport first');
    const result = await tx.query<Row>(`INSERT INTO futsal_teams(order_item_id,team_name,logo_url)
      SELECT i.id,i.team_name,i.logo_url FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE i.sport_id=$1 AND o.status IN ('confirmed','contacted','completed')
      ON CONFLICT(order_item_id) DO NOTHING RETURNING id`, [sport.id]);
    await audit(tx, req.actor!.id, 'futsal.import', 'futsal', sport.id, { imported: result.rows.length });
    return { imported: result.rows.length, total: (await one(tx, 'SELECT count(*)::int AS count FROM futsal_teams'))!.count };
  }));
  app.post('/admin/futsal/generate-groups', { preHandler: guard.superAdmin }, async req => db.transaction(async tx => {
    assert(!(await one(tx, 'SELECT id FROM futsal_matches LIMIT 1')), 409, 'fixtures_exist', 'Groups cannot change after fixtures are created');
    const teams=(await tx.query<Row>('SELECT * FROM futsal_teams ORDER BY team_name,id FOR UPDATE')).rows;
    assert(teams.length===32,409,'team_count','Futsal requires exactly 32 imported confirmed teams');
    assert(!teams.some(t=>t.group_code),409,'groups_exist','Groups have already been generated');
    for (let i=0;i<teams.length;i++) await tx.query('UPDATE futsal_teams SET group_code=$1 WHERE id=$2',[groupCodes[i%8],teams[i].id]);
    await audit(tx, req.actor!.id, 'futsal.groups.generate', 'futsal', teams[0].id, { teams: 32 }); return { groups: 8 };
  }));
  app.post('/admin/futsal/generate-fixtures', { preHandler: guard.superAdmin }, async req => db.transaction(async tx => {
    assert(!(await one(tx, 'SELECT id FROM futsal_matches LIMIT 1')),409,'fixtures_exist','Fixtures already exist');
    for (const group of groupCodes) { const teams=(await tx.query<Row>('SELECT id FROM futsal_teams WHERE group_code=$1 ORDER BY team_name,id',[group])).rows; assert(teams.length===4,409,'groups_incomplete',`Group ${group} needs four teams`); for(let a=0;a<4;a++) for(let b=a+1;b<4;b++) await tx.query("INSERT INTO futsal_matches(stage,group_code,home_team_id,away_team_id) VALUES('group',$1,$2,$3)",[group,teams[a].id,teams[b].id]); }
    await audit(tx, req.actor!.id, 'futsal.fixtures.generate', 'futsal', (await one(tx,'SELECT id FROM futsal_teams LIMIT 1'))!.id, { matches: 48 }); return { matches: 48 };
  }));
  app.post('/admin/futsal/generate-knockout', { preHandler: guard.superAdmin }, async req => db.transaction(async tx => { await createKnockout(tx); await audit(tx, req.actor!.id, 'futsal.bracket.generate','futsal',(await one(tx,'SELECT id FROM futsal_teams LIMIT 1'))!.id,{}); return { created: true }; }));
  app.post('/admin/futsal/matches/:id/start', { preHandler: guard.admin }, async req => db.transaction(async tx => { const m=await one(tx,'SELECT * FROM futsal_matches WHERE id=$1 FOR UPDATE',[params.parse(req.params).id]); assert(m,404,'not_found','Match not found'); assert(m.status==='scheduled',409,'invalid_state','Only scheduled matches can start'); assert(m.home_team_id&&m.away_team_id,409,'teams_pending','Both teams must be known'); return one(tx,"UPDATE futsal_matches SET status='live',version=version+1 WHERE id=$1 RETURNING *",[m.id]); }));
  app.patch('/admin/futsal/matches/:id', { preHandler: guard.admin }, async req => db.transaction(async tx => { const b=scoreBody.parse(req.body); const m=await one(tx,'SELECT * FROM futsal_matches WHERE id=$1 FOR UPDATE',[params.parse(req.params).id]); assert(m,404,'not_found','Match not found'); assert(m.status==='live',409,'invalid_state','Only live match scores can be saved'); assert(m.version===b.version,409,'stale_match','This score changed elsewhere. Refresh and try again.'); return one(tx,'UPDATE futsal_matches SET home_score=$2,away_score=$3,version=version+1 WHERE id=$1 RETURNING *',[m.id,b.home_score,b.away_score]); }));
  app.post('/admin/futsal/matches/:id/end', { preHandler: guard.admin }, async req => db.transaction(async tx => { const b=z.object({ version:z.number().int().positive(), penalty_winner_id:uuid.optional() }).strict().parse(req.body); const m=await one(tx,'SELECT * FROM futsal_matches WHERE id=$1 FOR UPDATE',[params.parse(req.params).id]); assert(m,404,'not_found','Match not found'); assert(m.status==='live',409,'invalid_state','Only live matches can end'); assert(m.version===b.version,409,'stale_match','This score changed elsewhere. Refresh and try again.'); let winner:string|null=null; if(m.stage!=='group'){ if(m.home_score===m.away_score){ assert(b.penalty_winner_id===m.home_team_id||b.penalty_winner_id===m.away_team_id,400,'penalty_required','Choose the penalty winner for a tied knockout match'); winner=b.penalty_winner_id!; } else winner=m.home_score>m.away_score?m.home_team_id:m.away_team_id; }
    const done=await one(tx,"UPDATE futsal_matches SET status='completed',winner_team_id=$2,completed_at=now(),version=version+1 WHERE id=$1 RETURNING *",[m.id,winner]); if(winner){const next=nextSlot(m.stage,m.bracket_position); if(next) await tx.query(`UPDATE futsal_matches SET ${next.slot}=$1 WHERE stage=$2 AND bracket_position=$3`,[winner,next.stage,next.position]);} await audit(tx,req.actor!.id,'futsal.match.end','futsal',m.id,{winner}); return done; }));
}
