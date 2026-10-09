import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

let h: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h?.close();
});

// One confirmed order per team: the draw needs a full field of twenty before
// four groups of four can be placed.
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

// Groups are placed by hand in assignment order: the first team into a group
// becomes its A1 slot, the fourth its A4, and a fifth is refused.
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

async function addPlayer(table: 'cricket_teams', teamId: string, name: string) {
  const row = (
    await h.db.query(
      `INSERT INTO team_players(order_item_id,player_name) SELECT order_item_id,$2 FROM ${table} WHERE id=$1 RETURNING id`,
      [teamId, name],
    )
  ).rows[0];
  expect(row.id).toBeTruthy();
  return row;
}

describe('cricket championship', () => {
  it('supports five teams in Group A and creates the bracket after all 28 matches', async () => {
    await seedTeams(17, h.sports[0].id, 'Cricket Team');
    await h.call('POST', '/admin/cricket/import', {}, 'admin');
    const teams = (await h.call('GET', '/admin/cricket', undefined, 'admin')).json().teams;
    for (const [index, team] of teams.entries()) {
      const group = index < 5 ? 'A' : 'BCD'[Math.floor((index - 5) / 4)];
      expect(
        (
          await h.call(
            'PATCH',
            `/admin/cricket/teams/${team.id}/group`,
            { group_code: group },
            'admin',
          )
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (
        await h.call(
          'PATCH',
          `/admin/cricket/teams/${teams[5].id}/group`,
          { group_code: 'A' },
          'admin',
        )
      ).json().error,
    ).toBe('group_full');
    expect(
      (await h.call('POST', '/admin/cricket/generate-fixtures', {}, 'admin')).json().matches,
    ).toBe(28);
    const view = (await h.call('GET', '/admin/cricket', undefined, 'admin')).json();
    expect(view.groups.map((group: any) => group.matches.length)).toEqual([10, 6, 6, 6]);
    for (const group of view.groups) {
      // Read group membership from the updated public data, not the imported snapshot.
      const members = view.teams.filter((team: any) => team.group_code === group.code);
      expect(
        new Set(
          group.matches.map((match: any) =>
            [match.home_team_id, match.away_team_id].sort().join(':'),
          ),
        ).size,
      ).toBe(group.matches.length);
      for (const team of members)
        expect(
          group.matches.filter(
            (match: any) => match.home_team_id === team.id || match.away_team_id === team.id,
          ),
        ).toHaveLength(members.length - 1);
    }
    const last = view.groups[3].matches.at(-1);
    await h.db.query(
      "UPDATE cricket_matches SET status='completed',home_score=100,away_score=90,winner_team_id=home_team_id,completed_at=now() WHERE id<>$1",
      [last.id],
    );
    expect((await h.call('GET', '/admin/cricket', undefined, 'admin')).json().bracket).toHaveLength(
      0,
    );
    const started = await h.call('POST', `/admin/cricket/matches/${last.id}/start`, {}, 'admin');
    expect(started.statusCode).toBe(200);
    const saved = await h.call(
      'PATCH',
      `/admin/cricket/matches/${last.id}`,
      { home_score: 100, away_score: 90, version: started.json().version },
      'admin',
    );
    expect(saved.statusCode).toBe(200);
    expect(
      (
        await h.call(
          'POST',
          `/admin/cricket/matches/${last.id}/end`,
          { version: saved.json().version },
          'admin',
        )
      ).statusCode,
    ).toBe(200);
    const final = (await h.call('GET', '/admin/cricket', undefined, 'admin')).json();
    expect(final.bracket).toHaveLength(7);
    expect(final.teams.filter((team: any) => team.selected)).toHaveLength(8);
    expect(
      final.groups.every(
        (group: any) =>
          final.teams.filter((team: any) => team.group_code === group.code && team.selected)
            .length === 2,
      ),
    ).toBe(true);
  });
  it('rejects the former 20-team field before creating any fixtures', async () => {
    await seedTeams(20, h.sports[0].id, 'Cricket Team');
    await h.call('POST', '/admin/cricket/import', {}, 'admin');
    const result = await h.call('POST', '/admin/cricket/generate-fixtures', {}, 'admin');
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toBe('team_count');
    expect((await h.db.query('SELECT id FROM cricket_matches')).rows).toHaveLength(0);
  });

  it('draws four groups of four in placement order and refuses a fifth team', async () => {
    // sports[0] arrives as Cricksal, the sport the cricksal entries register for.
    await seedTeams(16, h.sports[0].id, 'Cricket Team');
    expect((await h.call('POST', '/admin/cricket/import', {}, 'admin')).json().total).toBe(16);
    // A second import never duplicates a team that is already in the draw.
    expect((await h.call('POST', '/admin/cricket/import', {}, 'admin')).json()).toEqual({
      imported: 0,
      total: 16,
    });
    const teams = (await h.call('GET', '/admin/cricket', undefined, 'admin')).json().teams;
    expect(teams).toHaveLength(16);

    expect(
      (await h.call('POST', '/admin/cricket/generate-fixtures', {}, 'admin')).json().error,
    ).toBe('groups_incomplete');
    expect((await h.db.query('SELECT id FROM cricket_matches')).rows).toHaveLength(0);
    await assignGroups('/admin/cricket', 'ABCD', teams);
    // A fifth team cannot join a group that already holds four.
    const overflow = await h.call(
      'PATCH',
      `/admin/cricket/teams/${teams[4].id}/group`,
      { group_code: 'A' },
      'admin',
    );
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().error).toBe('group_full');
    // Every placement carries the stamp the fixture draw sorts by.
    expect(
      (
        await h.db.query(
          'SELECT count(*)::int AS count FROM cricket_teams WHERE group_assigned_at IS NULL',
        )
      ).rows[0].count,
    ).toBe(0);

    expect(
      (await h.call('POST', '/admin/cricket/generate-fixtures', {}, 'admin')).json().matches,
    ).toBe(24);
    const view = (await h.call('GET', '/admin/cricket', undefined, 'admin')).json();
    expect(view.groups.map((group: any) => group.code)).toEqual(['A', 'B', 'C', 'D']);
    const groupA = view.groups[0].matches;
    expect(groupA).toHaveLength(6);
    expect(groupA.map((match: any) => match.group_position)).toEqual([1, 2, 3, 4, 5, 6]);
    // The opening round pairs the first two placements with the next two.
    expect([groupA[0].home_team_id, groupA[0].away_team_id]).toEqual([teams[0].id, teams[1].id]);
    expect([groupA[1].home_team_id, groupA[1].away_team_id]).toEqual([teams[2].id, teams[3].id]);
    // Every team in the group plays the other three exactly once.
    for (const team of teams.slice(0, 4))
      expect(
        groupA.filter(
          (match: any) => match.home_team_id === team.id || match.away_team_id === team.id,
        ),
      ).toHaveLength(3);

    // Fixtures lock the groups and there is no manual knockout endpoint: the
    // bracket only ever appears when the last group match ends.
    const locked = await h.call(
      'PATCH',
      `/admin/cricket/teams/${teams[0].id}/group`,
      { group_code: 'B' },
      'admin',
    );
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toBe('fixtures_exist');
    expect((await h.call('POST', '/admin/cricket/generate-knockout', {}, 'admin')).statusCode).toBe(
      404,
    );
  });

  it('scores runs, wickets and overs and draws the bracket when the last group match ends', async () => {
    await seedTeams(16, h.sports[0].id, 'Cricket Team');
    await h.call('POST', '/admin/cricket/import', {}, 'admin');
    const teams = (await h.call('GET', '/admin/cricket', undefined, 'admin')).json().teams;
    await assignGroups('/admin/cricket', 'ABCD', teams);
    await h.call('POST', '/admin/cricket/generate-fixtures', {}, 'admin');
    const view = (await h.call('GET', '/admin/cricket', undefined, 'admin')).json();
    const names = new Map<string, string>(view.teams.map((team: any) => [team.id, team.team_name]));
    const first = view.groups[0].matches[0];

    // Two home batters split the runs; the away opener is credited separately.
    const homeA = await addPlayer('cricket_teams', first.home_team_id, 'Ramesh Magar');
    const homeB = await addPlayer('cricket_teams', first.home_team_id, 'Bishal Thapa');
    const awayA = await addPlayer('cricket_teams', first.away_team_id, 'Nabin Gurung');

    const started = await h.call('POST', `/admin/cricket/matches/${first.id}/start`, {}, 'staff');
    expect(started.statusCode).toBe(200);
    const saved = await h.call(
      'PATCH',
      `/admin/cricket/matches/${first.id}`,
      {
        home_score: 145,
        away_score: 139,
        home_wickets: 4,
        away_wickets: 6,
        home_overs: 9.4,
        away_overs: 10,
        version: started.json().version,
      },
      'staff',
    );
    expect(saved.statusCode).toBe(200);
    expect(saved.json().home_wickets).toBe(4);
    expect(Number(saved.json().home_overs)).toBe(9.4);

    // Six balls roll into the next over, and nobody loses more than ten.
    const badOvers = await h.call(
      'PATCH',
      `/admin/cricket/matches/${first.id}`,
      { home_score: 145, away_score: 139, home_overs: 9.6, version: saved.json().version },
      'staff',
    );
    expect(badOvers.statusCode).toBe(400);
    expect(badOvers.json().error).toBe('validation_error');
    expect(
      (
        await h.call(
          'PATCH',
          `/admin/cricket/matches/${first.id}`,
          { home_score: 145, away_score: 139, home_wickets: 8, version: saved.json().version },
          'staff',
        )
      ).statusCode,
    ).toBe(400);

    // The runs are credited to the batters, up to the runs on the board.
    for (const credit of [
      { team_id: first.home_team_id, player_id: homeA.id, runs: 60 },
      { team_id: first.home_team_id, player_id: homeB.id, runs: 85 },
      { team_id: first.away_team_id, player_id: awayA.id, runs: 100 },
    ]) {
      expect(
        (await h.call('POST', `/admin/cricket/matches/${first.id}/scorers`, credit, 'admin'))
          .statusCode,
      ).toBe(200);
    }
    const overCredit = await h.call(
      'POST',
      `/admin/cricket/matches/${first.id}/scorers`,
      { team_id: first.home_team_id, player_id: homeA.id, runs: 1 },
      'admin',
    );
    expect(overCredit.statusCode).toBe(409);
    expect(overCredit.json().error).toBe('scorers_exceed_score');

    // Correcting the score downwards trims the newest credit first: the 85 is
    // dropped whole and the 60 beneath it shrinks to the 50 left on the board.
    const trimmed = await h.call(
      'PATCH',
      `/admin/cricket/matches/${first.id}`,
      { home_score: 50, away_score: 139, version: saved.json().version },
      'staff',
    );
    expect(trimmed.statusCode).toBe(200);
    const credited = (
      await h.db.query(
        'SELECT coalesce(sum(runs),0)::int AS total FROM cricket_scorers WHERE match_id=$1 AND team_id=$2',
        [first.id, first.home_team_id],
      )
    ).rows[0].total;
    expect(credited).toBe(50);

    // The score goes back up and the sides finish level: the overs and wickets
    // from the first save were kept by the patch.
    const level = await h.call(
      'PATCH',
      `/admin/cricket/matches/${first.id}`,
      { home_score: 145, away_score: 145, version: trimmed.json().version },
      'staff',
    );
    expect(level.statusCode).toBe(200);
    expect(level.json().home_wickets).toBe(4);
    expect(Number(level.json().home_overs)).toBe(9.4);

    // A level score cannot end without a super over winner, in the group stage
    // as much as in the knockout rounds.
    const undecided = await h.call(
      'POST',
      `/admin/cricket/matches/${first.id}/end`,
      { version: level.json().version },
      'staff',
    );
    expect(undecided.statusCode).toBe(400);
    expect(undecided.json().error).toBe('winner_required');

    // The other 23 fixtures finish in bulk, then ending the last one through the
    // API draws the bracket the way the live flow does.
    await h.db.query(
      `UPDATE cricket_matches SET status='completed',home_score=120,away_score=115,
         home_wickets=4,away_wickets=6,home_overs=10.0,away_overs=10.0,completed_at=now()
       WHERE stage='group' AND id <> $1`,
      [first.id],
    );
    expect(
      (
        await h.call(
          'POST',
          `/admin/cricket/matches/${first.id}/end`,
          { version: level.json().version, penalty_winner_id: first.home_team_id },
          'staff',
        )
      ).statusCode,
    ).toBe(200);

    const final = (await h.call('GET', '/admin/cricket', undefined, 'admin')).json();
    expect(final.bracket).toHaveLength(7);
    const byId = new Map<string, any>(final.teams.map((team: any) => [team.id, team]));
    const quarters = final.bracket.filter((match: any) => match.stage === 'quarter');
    expect(quarters).toHaveLength(4);
    // Cross-group quarters preserve the existing winner and runner-up pairings.
    expect([quarters[0].home_team_id, quarters[0].away_team_id]).toEqual([
      teams[0].id,
      teams[4].id,
    ]);
    expect([quarters[2].home_team_id, quarters[2].away_team_id]).toEqual([
      teams[1].id,
      teams[5].id,
    ]);
    expect(
      quarters.every(
        (match: any) =>
          byId.get(match.home_team_id).group_code !== byId.get(match.away_team_id).group_code,
      ),
    ).toBe(true);
    expect(final.teams.filter((team: any) => team.selected)).toHaveLength(8);

    // The group table reads two points per win, settled by the super over.
    expect(final.groups[0].table.map((row: any) => row.team_name)).toEqual(
      teams.slice(0, 4).map((team: any) => team.team_name),
    );
    expect(final.groups[0].table[0]).toMatchObject({ points: 6, run_difference: 10 });

    const group = await h.call('GET', '/admin/cricket/report?stage=group', undefined, 'admin');
    expect(group.statusCode).toBe(200);
    const report = group.json();
    expect(report.title).toBe('Ronb Sports Meet');
    expect(report.sport).toBe('cricket');
    expect(report.stage).toBe('group');
    expect(report.sections.map((section: any) => section.label)).toEqual([
      'Group A',
      'Group B',
      'Group C',
      'Group D',
    ]);
    expect(report.sections.map((section: any) => section.matches.length)).toEqual([6, 6, 6, 6]);
    const opening = report.sections[0].matches[0];
    expect(opening.home_team).toBe(names.get(first.home_team_id));
    expect(opening.home_score).toBe(145);
    expect(opening.away_score).toBe(145);
    expect(opening.home_wickets).toBe(4);
    expect(opening.away_wickets).toBe(6);
    expect(opening.home_overs).toBe(9.4);
    expect(opening.away_overs).toBe(10);
    expect(opening.status).toBe('completed');
    expect(opening.penalty_winner).toBe(names.get(first.home_team_id));
    // The trim dropped the 85 entirely and shrunk the 60 to the 50 left on the board.
    expect(opening.home_scorers).toEqual([{ player_name: 'Ramesh Magar', runs: 50 }]);
    expect(opening.away_scorers).toEqual([{ player_name: 'Nabin Gurung', runs: 100 }]);

    // The stage defaults to the group stage and anything else is rejected.
    expect((await h.call('GET', '/admin/cricket/report', undefined, 'staff')).json().stage).toBe(
      'group',
    );
    expect(
      (await h.call('GET', '/admin/cricket/report?stage=playoffs', undefined, 'admin')).statusCode,
    ).toBe(400);

    const knockout = await h.call(
      'GET',
      '/admin/cricket/report?stage=knockout',
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

    const audits = (
      await h.db.query("SELECT metadata FROM audit_logs WHERE action='cricket.bracket.generate'")
    ).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toEqual({ teams: 8, automatic: true });
  });

  it('credits wickets to bowlers, trims the newest on a corrected tally and publishes them live', async () => {
    await seedTeams(16, h.sports[0].id, 'Cricket Team');
    await h.call('POST', '/admin/cricket/import', {}, 'admin');
    const teams = (await h.call('GET', '/admin/cricket', undefined, 'admin')).json().teams;
    await assignGroups('/admin/cricket', 'ABCD', teams);
    await h.call('POST', '/admin/cricket/generate-fixtures', {}, 'admin');
    const view = (await h.call('GET', '/admin/cricket', undefined, 'admin')).json();
    const first = view.groups[0].matches[0];

    // Each bowler keeps the wickets they were credited with, up to the tally on
    // the board. Batters and bowlers share the same roster.
    const homeC = await addPlayer('cricket_teams', first.home_team_id, 'Kiran Kumal');
    const homeD = await addPlayer('cricket_teams', first.home_team_id, 'Prabin Shrestha');
    const awayE = await addPlayer('cricket_teams', first.away_team_id, 'Sujata Thakuri');

    const started = await h.call('POST', `/admin/cricket/matches/${first.id}/start`, {}, 'staff');
    const saved = await h.call(
      'PATCH',
      `/admin/cricket/matches/${first.id}`,
      {
        home_score: 120,
        away_score: 110,
        home_wickets: 6,
        away_wickets: 7,
        home_overs: 10,
        away_overs: 9.3,
        version: started.json().version,
      },
      'staff',
    );
    expect(saved.statusCode).toBe(200);
    expect(saved.json().home_wickets).toBe(6);

    for (const credit of [
      { team_id: first.home_team_id, player_id: homeC.id, wickets: 3 },
      { team_id: first.home_team_id, player_id: homeD.id, wickets: 2 },
      { team_id: first.away_team_id, player_id: awayE.id, wickets: 4 },
    ]) {
      expect(
        (await h.call('POST', `/admin/cricket/matches/${first.id}/wickets`, credit, 'admin'))
          .statusCode,
      ).toBe(200);
    }
    // Two more wickets would take the home side past the six on the board.
    const spilt = await h.call(
      'POST',
      `/admin/cricket/matches/${first.id}/wickets`,
      { team_id: first.home_team_id, player_id: homeC.id, wickets: 2 },
      'admin',
    );
    expect(spilt.statusCode).toBe(409);
    expect(spilt.json().error).toBe('wickets_exceed_total');
    // A bowler from the other roster cannot be credited against a team.
    const outsider = await h.call(
      'POST',
      `/admin/cricket/matches/${first.id}/wickets`,
      { team_id: first.away_team_id, player_id: homeC.id, wickets: 1 },
      'admin',
    );
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json().error).toBe('player_not_found');

    // The live feed names the bowlers under each team, exactly like the batters.
    const bowlers = (rows: any[]) =>
      rows.map(({ player_name, wickets }: any) => ({ player_name, wickets }));
    const live = (await h.call('GET', '/cricket/live')).json();
    expect(bowlers(live.home_bowlers)).toEqual([
      { player_name: 'Kiran Kumal', wickets: 3 },
      { player_name: 'Prabin Shrestha', wickets: 2 },
    ]);
    expect(bowlers(live.away_bowlers)).toEqual([{ player_name: 'Sujata Thakuri', wickets: 4 }]);
    expect(live.home_scorers).toEqual([]);

    // Correcting the wicket count down trims the newest credit first: the 2
    // shrinks to the 1 left on the board and the 3 beneath it stands.
    const trimmed = await h.call(
      'PATCH',
      `/admin/cricket/matches/${first.id}`,
      { home_score: 120, away_score: 110, home_wickets: 5, version: saved.json().version },
      'staff',
    );
    expect(trimmed.statusCode).toBe(200);
    const credited = (
      await h.db.query(
        'SELECT coalesce(sum(wickets),0)::int AS total FROM cricket_wickets WHERE match_id=$1 AND team_id=$2',
        [first.id, first.home_team_id],
      )
    ).rows[0].total;
    expect(credited).toBe(5);
    const afterTrim = (await h.call('GET', '/cricket/live')).json();
    expect(bowlers(afterTrim.home_bowlers)).toEqual([
      { player_name: 'Kiran Kumal', wickets: 3 },
      { player_name: 'Prabin Shrestha', wickets: 2 },
    ]);

    // Every wicket credit leaves its trace in the audit log.
    const wicketAudits = (
      await h.db.query("SELECT metadata FROM audit_logs WHERE action='cricket.match.wicket'")
    ).rows;
    expect(wicketAudits).toHaveLength(3);
    expect(wicketAudits.map((row: any) => row.metadata)).toContainEqual({
      team_id: first.home_team_id,
      player_id: homeC.id,
      wickets: 3,
    });
  });
});
