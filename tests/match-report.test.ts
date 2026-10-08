import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

let h: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h?.close();
});

// One confirmed order per team: both report tests need a full field before
// groups and fixtures can be drawn.
async function seedTeams(count: number, sportId: string, prefix: string) {
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
        `${prefix} ${String(index + 1).padStart(2, '0')}`,
        `https://logos.example/${index}.webp`,
      ],
    );
  }
}

// Groups are placed by hand, four teams at a time.
async function assignGroups(path: string, codes: string, teams: any[]) {
  for (const [index, team] of teams.entries()) {
    const saved = await h.call(
      'PATCH',
      `${path}/teams/${team.id}/group`,
      { group_code: codes[Math.floor(index / 4)] },
      'admin',
    );
    expect(saved.statusCode).toBe(200);
  }
}

async function addPlayer(table: 'futsal_teams' | 'basketball_teams', teamId: string, name: string) {
  const row = (
    await h.db.query(
      `INSERT INTO team_players(order_item_id,player_name) SELECT order_item_id,$2 FROM ${table} WHERE id=$1 RETURNING id`,
      [teamId, name],
    )
  ).rows[0];
  expect(row.id).toBeTruthy();
  return row;
}

describe('match reports', () => {
  it('exports the futsal group stage and knockout rounds with every scorer credit', async () => {
    await h.db.query("UPDATE sports SET name='Futsal' WHERE id=$1", [h.sports[0].id]);
    await seedTeams(24, h.sports[0].id, 'Futsal Team');
    expect((await h.call('POST', '/admin/futsal/import', {}, 'admin')).json().total).toBe(24);
    const teams = (await h.call('GET', '/admin/futsal', undefined, 'admin')).json().teams;
    await assignGroups('/admin/futsal', 'ABCDEF', teams);
    expect(
      (await h.call('POST', '/admin/futsal/generate-fixtures', {}, 'admin')).json().matches,
    ).toBe(36);
    const view = (await h.call('GET', '/admin/futsal', undefined, 'admin')).json();
    const names = new Map<string, string>(view.teams.map((team: any) => [team.id, team.team_name]));
    const first = view.groups[0].matches[0];

    // The opening fixture finishes 2-1; two of the home players are on the roster
    // but only one of them is credited with goals.
    const homeScorer = await addPlayer('futsal_teams', first.home_team_id, 'Ramesh Magar');
    await addPlayer('futsal_teams', first.home_team_id, 'Bishal Thapa');
    const awayScorer = await addPlayer('futsal_teams', first.away_team_id, 'Nabin Gurung');
    const started = await h.call('POST', `/admin/futsal/matches/${first.id}/start`, {}, 'staff');
    const saved = await h.call(
      'PATCH',
      `/admin/futsal/matches/${first.id}`,
      { home_score: 2, away_score: 1, version: started.json().version },
      'staff',
    );
    expect(saved.statusCode).toBe(200);
    for (const credit of [
      { team_id: first.home_team_id, player_id: homeScorer.id, goals: 2 },
      { team_id: first.away_team_id, player_id: awayScorer.id, goals: 1 },
    ]) {
      expect(
        (await h.call('POST', `/admin/futsal/matches/${first.id}/scorers`, credit, 'admin'))
          .statusCode,
      ).toBe(200);
    }
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

    // The rest of the group stage completes in bulk, the way the demo seeds it.
    await h.db.query(
      "UPDATE futsal_matches SET status='completed',home_score=ascii(group_code)-64,away_score=0,completed_at=now() WHERE stage='group' AND status <> 'completed'",
    );
    const group = await h.call('GET', '/admin/futsal/report?stage=group', undefined, 'admin');
    expect(group.statusCode).toBe(200);
    const report = group.json();
    expect(report.title).toBe('Ronb Sports Meet');
    expect(report.sport).toBe('futsal');
    expect(report.stage).toBe('group');
    expect(report.sections.map((section: any) => section.label)).toEqual([
      'Group A',
      'Group B',
      'Group C',
      'Group D',
      'Group E',
      'Group F',
    ]);
    expect(report.sections[0].matches).toHaveLength(6);
    const opening = report.sections[0].matches[0];
    expect(opening.home_team).toBe(names.get(first.home_team_id));
    expect(opening.away_team).toBe(names.get(first.away_team_id));
    expect(opening.home_score).toBe(2);
    expect(opening.away_score).toBe(1);
    expect(opening.status).toBe('completed');
    expect(opening.penalty_winner).toBeNull();
    // Only credited players appear: the unused roster player stays off the report.
    expect(opening.home_scorers).toEqual([{ player_name: 'Ramesh Magar', goals: 2 }]);
    expect(opening.away_scorers).toEqual([{ player_name: 'Nabin Gurung', goals: 1 }]);
    expect(report.sections[0].matches[1].home_scorers).toEqual([]);

    // The stage defaults to the group stage and anything else is rejected.
    expect((await h.call('GET', '/admin/futsal/report', undefined, 'staff')).json().stage).toBe(
      'group',
    );
    expect(
      (await h.call('GET', '/admin/futsal/report?stage=playoffs', undefined, 'admin')).statusCode,
    ).toBe(400);

    // Knockout rounds: a penalty-decided tie keeps its winner on the report.
    expect((await h.call('POST', '/admin/futsal/generate-knockout', {}, 'admin')).statusCode).toBe(
      200,
    );
    const bracket = (await h.call('GET', '/admin/futsal', undefined, 'admin')).json().bracket;
    const prequarter = bracket.find((match: any) => match.stage === 'prequarter');
    const winner = await addPlayer('futsal_teams', prequarter.home_team_id, 'Suman Thapa');
    const pqStarted = await h.call(
      'POST',
      `/admin/futsal/matches/${prequarter.id}/start`,
      {},
      'staff',
    );
    const pqSaved = await h.call(
      'PATCH',
      `/admin/futsal/matches/${prequarter.id}`,
      { home_score: 3, away_score: 3, version: pqStarted.json().version },
      'staff',
    );
    expect(pqSaved.statusCode).toBe(200);
    expect(
      (
        await h.call(
          'POST',
          `/admin/futsal/matches/${prequarter.id}/scorers`,
          { team_id: prequarter.home_team_id, player_id: winner.id, goals: 3 },
          'admin',
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.call(
          'POST',
          `/admin/futsal/matches/${prequarter.id}/end`,
          { version: pqSaved.json().version, penalty_winner_id: prequarter.home_team_id },
          'staff',
        )
      ).statusCode,
    ).toBe(200);
    await h.db.query(
      "UPDATE futsal_matches SET status='completed',home_score=1,away_score=0,completed_at=now() WHERE stage <> 'group' AND status <> 'completed'",
    );
    const knockout = await h.call('GET', '/admin/futsal/report?stage=knockout', undefined, 'staff');
    expect(knockout.statusCode).toBe(200);
    const rounds = knockout.json().sections;
    expect(rounds.map((section: any) => section.label)).toEqual([
      'Round of 16',
      'Quarterfinals',
      'Semifinals',
      'Final',
    ]);
    expect(rounds.map((section: any) => section.matches.length)).toEqual([8, 4, 2, 1]);
    const decided = rounds[0].matches.find((match: any) => match.penalty_winner);
    expect(decided.home_score).toBe(3);
    expect(decided.away_score).toBe(3);
    expect(decided.penalty_winner).toBe(names.get(prequarter.home_team_id));
    expect(decided.home_scorers).toEqual([{ player_name: 'Suman Thapa', goals: 3 }]);
    expect(decided.away_scorers).toEqual([]);
    expect(rounds[3].matches[0].home_scorers).toEqual([]);
  });

  it('exports the basketball group stage and bracket with points credited', async () => {
    // sports[2] arrives as Basketball: sixteen teams make four groups of four.
    await seedTeams(16, h.sports[2].id, 'Basketball Team');
    expect((await h.call('POST', '/admin/basketball/import', {}, 'admin')).json().total).toBe(16);
    const teams = (await h.call('GET', '/admin/basketball', undefined, 'admin')).json().teams;
    await assignGroups('/admin/basketball', 'ABCD', teams);
    expect(
      (await h.call('POST', '/admin/basketball/generate-fixtures', {}, 'admin')).json().matches,
    ).toBe(24);
    const view = (await h.call('GET', '/admin/basketball', undefined, 'admin')).json();
    const first = view.groups[0].matches[0];

    // Two home players split the eight points, an away player takes the three.
    const homeA = await addPlayer('basketball_teams', first.home_team_id, 'Aarav Shah');
    const homeB = await addPlayer('basketball_teams', first.home_team_id, 'Pratik Gurung');
    const awayA = await addPlayer('basketball_teams', first.away_team_id, 'Nabin Gurung');
    const started = await h.call(
      'POST',
      `/admin/basketball/matches/${first.id}/start`,
      {},
      'admin',
    );
    const saved = await h.call(
      'PATCH',
      `/admin/basketball/matches/${first.id}`,
      { home_score: 8, away_score: 3, version: started.json().version },
      'admin',
    );
    expect(saved.statusCode).toBe(200);
    for (const credit of [
      { team_id: first.home_team_id, player_id: homeA.id, points: 5 },
      { team_id: first.home_team_id, player_id: homeB.id, points: 3 },
      { team_id: first.away_team_id, player_id: awayA.id, points: 3 },
    ]) {
      expect(
        (await h.call('POST', `/admin/basketball/matches/${first.id}/scorers`, credit, 'admin'))
          .statusCode,
      ).toBe(200);
    }
    // The other 23 fixtures finish in bulk, then ending the last one draws the
    // bracket the way the live flow does.
    await h.db.query(
      "UPDATE basketball_matches SET status='completed',home_score=1,away_score=0,completed_at=now() WHERE stage='group' AND id <> $1",
      [first.id],
    );
    expect(
      (
        await h.call(
          'POST',
          `/admin/basketball/matches/${first.id}/end`,
          { version: saved.json().version, home_score: 8, away_score: 3 },
          'admin',
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await h.call('GET', '/admin/basketball', undefined, 'admin')).json().bracket,
    ).toHaveLength(7);

    const group = await h.call('GET', '/admin/basketball/report?stage=group', undefined, 'admin');
    expect(group.statusCode).toBe(200);
    const report = group.json();
    expect(report.title).toBe('Ronb Sports Meet');
    expect(report.sport).toBe('basketball');
    expect(report.sections.map((section: any) => section.label)).toEqual([
      'Group A',
      'Group B',
      'Group C',
      'Group D',
    ]);
    const opening = report.sections[0].matches[0];
    expect(opening.home_score).toBe(8);
    expect(opening.away_score).toBe(3);
    expect(opening.home_scorers).toHaveLength(2);
    expect(opening.home_scorers).toEqual(
      expect.arrayContaining([
        { player_name: 'Aarav Shah', points: 5 },
        { player_name: 'Pratik Gurung', points: 3 },
      ]),
    );
    expect(opening.away_scorers).toEqual([{ player_name: 'Nabin Gurung', points: 3 }]);

    const knockout = await h.call(
      'GET',
      '/admin/basketball/report?stage=knockout',
      undefined,
      'admin',
    );
    expect(knockout.statusCode).toBe(200);
    const rounds = knockout.json().sections;
    expect(rounds.map((section: any) => section.label)).toEqual([
      'Quarterfinals',
      'Semifinals',
      'Final',
    ]);
    expect(rounds.map((section: any) => section.matches.length)).toEqual([4, 2, 1]);
    // The quarterfinals are drawn; the later rounds still wait for their teams.
    expect(
      rounds[0].matches.every((match: any) => match.home_team !== 'Team to be confirmed'),
    ).toBe(true);
    expect(rounds[2].matches[0].home_team).toBe('Team to be confirmed');
    expect(rounds[0].matches[0].status).toBe('scheduled');
  });
});
