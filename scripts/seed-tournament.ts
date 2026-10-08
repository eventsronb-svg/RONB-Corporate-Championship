// Seeds the local demo with a real-looking championship for every tournament sport:
// confirmed registrations for the full field, the teams imported into the draw, all
// groups assigned, fixtures generated, and every group match completed except the
// last one per sport — so ending that final fixture on the admin desk draws the
// knockout bracket on the spot. A couple of pending payments per sport keep the
// payment review queue alive too.
//
// Every row is inserted straight into the embedded PGlite database and every file is
// just bytes in the in-memory bucket; nothing here can reach a remote database.
import { randomUUID } from 'node:crypto';
import { one, type Database } from '../src/db.js';

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const companies = [
  'Annapurna Traders',
  'Himalayan Group',
  'Everest Motors',
  'Bagmati Suppliers',
  'Kathmandu Builders',
  'Pokhara Ventures',
  'Lumbini Agro',
  'Gorkha Exports',
  'Machhapuchhre IT',
  'Bouddha Foods',
  'Chitwan Resorts',
  'Janakpur Textiles',
  'Biratnagar Logistics',
  'Nepalgunj Shipping',
  'Butwal Brewery',
  'Dhangadhi Constructions',
  'Ilam Tea Estate',
  'Patan Handicrafts',
  'Solu Energy',
  'Rara Travels',
  'Tilicho Adventure',
  'Phewa Productions',
  'Mustang Airlines',
  'Tansen Furniture',
  'Palpa Paper',
  'Tulsipur Hardware',
  'Ghodaghodi Hotels',
  'Koshi Cement',
  'Trishuli Hydro',
  'Bagnaskoti Farms',
  'Sankhu Paper',
  'Manang Treks',
];

const pendingCompanies = [
  'Green Valley Traders',
  'Surya Biscuits',
  'Kathmandu Lakes',
  'Bouddha Bistro',
  'Lalitpur Paper Mills',
  'Hetauda Concretes',
];

const playerNames = [
  'Aarav Shah',
  'Ramesh Magar',
  'Nabin Gurung',
  'Suman Thapa',
  'Bishal Rai',
  'Pratik Karki',
  'Dipendra Tamang',
  'Kiran Shrestha',
  'Sajan Lama',
  'Umesh Basnet',
  'Prakash Adhikari',
  'Binod Yadav',
  'Rohit Devkota',
  'Amit Sharma',
  'Sagar Kc',
  'Bijay Maharjan',
  'Niraj Poudel',
  'Deepak Thakuri',
  'Sanjay Bhandari',
  'Krish Shahi',
];

const jerseySizes = ['S', 'M', 'L', 'XL', '2XL'];

interface Tournament {
  sportName: 'Futsal' | 'Cricksal' | 'Basketball';
  uri: string; // slug used in emails, codes and filenames
  code: string; // short tag for payment codes
  table: 'futsal_teams' | 'basketball_teams' | 'cricket_teams';
  matches: 'futsal_matches' | 'basketball_matches' | 'cricket_matches';
  teams: number;
  groups: string[];
  perGroup: number;
  roster: number;
  // Round robin for the group in placement order, identical to the draw in src.
  roundRobin: readonly (readonly [number, number])[];
  cricket: boolean;
}

const tournaments: Tournament[] = [
  {
    sportName: 'Futsal',
    uri: 'futsal',
    code: 'FUT',
    table: 'futsal_teams',
    matches: 'futsal_matches',
    teams: 32,
    groups: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    perGroup: 4,
    roster: 12,
    roundRobin: [
      [0, 1],
      [2, 3],
      [0, 2],
      [1, 3],
      [0, 3],
      [1, 2],
    ],
    cricket: false,
  },
  {
    sportName: 'Cricksal',
    uri: 'crick',
    code: 'CRK',
    table: 'cricket_teams',
    matches: 'cricket_matches',
    teams: 20,
    groups: ['A', 'B', 'C', 'D'],
    perGroup: 5,
    roster: 11,
    roundRobin: [
      [0, 1],
      [2, 3],
      [0, 2],
      [1, 4],
      [0, 4],
      [1, 3],
      [0, 3],
      [2, 4],
      [1, 2],
      [3, 4],
    ],
    cricket: true,
  },
  {
    sportName: 'Basketball',
    uri: 'basket',
    code: 'BAS',
    table: 'basketball_teams',
    matches: 'basketball_matches',
    teams: 16,
    groups: ['A', 'B', 'C', 'D'],
    perGroup: 4,
    roster: 12,
    roundRobin: [
      [0, 1],
      [2, 3],
      [0, 2],
      [1, 3],
      [0, 3],
      [1, 2],
    ],
    cricket: false,
  },
];

export async function seedChampionships(
  db: Database,
  files: Map<string, { body: Buffer; mime: string }>,
) {
  await db.transaction(async (tx) => {
    for (const [sportIndex, tournament] of tournaments.entries()) {
      const sport = await one(tx, 'SELECT id,price FROM sports WHERE name=$1', [
        tournament.sportName,
      ]);
      if (!sport) throw new Error(`Sport ${tournament.sportName} is not seeded`);
      const sportId: string = sport.id;
      const price = Number(sport.price);
      const priceLocked = Math.round(price * 1.13 * 100) / 100;
      const style = tournament.cricket ? 'full_sleeve' : null;

      // The full field of confirmed registrations, one captain and order apiece.
      const teamIds: string[] = [];
      for (let index = 0; index < tournament.teams; index++) {
        const teamName = companies[index % companies.length];
        const hoursAgo = (tournament.teams - index) * 11;
        const userId = (
          await tx.query(
            'INSERT INTO users(google_id,email,name,phone) VALUES($1,$2,$3,$4) RETURNING id',
            [
              `company-${randomUUID()}`,
              `${tournament.uri}-team${String(index + 1).padStart(2, '0')}@championship.local`,
              teamName,
              `+977 98${String(10000000 + index * 97).slice(0, 8)}`,
            ],
          )
        ).rows[0].id;
        const orderId = (
          await tx.query(
            "INSERT INTO orders(user_id,status,created_at) VALUES($1,'confirmed',$2) RETURNING id",
            [userId, new Date(Date.now() - hoursAgo * 3600_000)],
          )
        ).rows[0].id;
        const itemId = (
          await tx.query(
            `INSERT INTO order_items(order_id,sport_id,price_at_purchase,team_name,
               profile_completed_at,captain_position,jersey_style)
             VALUES($1,$2,$3,$4,now(),1,$5) RETURNING id`,
            [orderId, sportId, price, teamName, style],
          )
        ).rows[0].id;
        // A full roster the scorer screens can credit, in one statement per team.
        const nameStart = (index * 7) % playerNames.length;
        const playerParams: unknown[] = [];
        for (let playerIndex = 0; playerIndex < tournament.roster; playerIndex++) {
          playerParams.push(
            itemId,
            playerNames[(nameStart + playerIndex) % playerNames.length],
            playerIndex + 1,
            jerseySizes[(index + playerIndex) % jerseySizes.length],
            style,
          );
        }
        const columnsPerRow = 5;
        const rowPlaceholders = Array.from(
          { length: tournament.roster },
          (_, row) =>
            `(${Array.from(
              { length: columnsPerRow },
              (_, column) => `$${row * columnsPerRow + column + 1}`,
            ).join(',')})`,
        ).join(',');
        await tx.query(
          `INSERT INTO team_players(order_item_id,player_name,position,jersey_size,jersey_style)
           VALUES ${rowPlaceholders}`,
          playerParams,
        );
        const teamId = (
          await tx.query(
            `INSERT INTO ${tournament.table}(order_item_id,team_name) VALUES($1,$2) RETURNING id`,
            [itemId, teamName],
          )
        ).rows[0].id;
        teamIds.push(teamId);
        // The timeline the admin order page renders.
        for (const [from, to] of [
          ['draft', 'receipt_submitted'],
          ['receipt_submitted', 'under_review'],
          ['under_review', 'confirmed'],
        ] as const)
          await tx.query(
            'INSERT INTO order_status_history(order_id,from_status,to_status) VALUES($1,$2,$3)',
            [orderId, from, to],
          );
        await tx.query(
          'UPDATE orders SET total_amount=$2,invoiced_at=now(),confirmed_at=now() WHERE id=$1',
          [orderId, priceLocked],
        );
      }

      // Group assignment in the order the teams were created; the stamp is what the
      // fixture draw sorts by, exactly as the draw endpoint records it.
      const stampBase = Date.now();
      for (const [index, teamId] of teamIds.entries()) {
        await tx.query(
          `UPDATE ${tournament.table} SET group_code=$1,group_assigned_at=$2 WHERE id=$3`,
          [
            tournament.groups[Math.floor(index / tournament.perGroup)],
            new Date(stampBase + index * 1000),
            teamId,
          ],
        );
      }

      // Generate every group round robin in the same draw order the API produces.
      for (const group of tournament.groups) {
        const teams = (
          await tx.query(
            `SELECT id FROM ${tournament.table} WHERE group_code=$1 ORDER BY group_assigned_at,id`,
            [group],
          )
        ).rows;
        if (teams.length !== tournament.perGroup)
          throw new Error(
            `${tournament.sportName} group ${group} needs ${tournament.perGroup} teams, got ${teams.length}`,
          );
        for (const [position, [home, away]] of tournament.roundRobin.entries())
          await tx.query(
            `INSERT INTO ${tournament.matches}(stage,group_code,group_position,home_team_id,away_team_id)
             VALUES('group',$1,$2,$3,$4)`,
            [group, position + 1, teams[home].id, teams[away].id],
          );
      }

      // Play the whole group stage except the very last fixture: completing that one
      // through the desk draws the bracket, which is the moment the demo is staged for.
      const last = (
        await tx.query(
          `SELECT id FROM ${tournament.matches} WHERE stage='group'
           ORDER BY group_code DESC,group_position DESC,id DESC LIMIT 1`,
        )
      ).rows[0].id;
      const fixtures = (
        await tx.query(
          `SELECT id,home_team_id,away_team_id FROM ${tournament.matches}
           WHERE stage='group' AND id <> $1 ORDER BY group_code,group_position,id`,
          [last],
        )
      ).rows;
      for (const [index, fixture] of fixtures.entries()) {
        let home = 1 + (index % 5);
        let away = (index * 2) % 4;
        if (home === away) away += 1;
        if (tournament.cricket) {
          home = 100 + ((index * 7) % 60);
          away = 80 + ((index * 11) % 55);
          if (home === away) away += 6;
          await tx.query(
            `UPDATE ${tournament.matches}
             SET status='completed',home_score=$2,away_score=$3,
                 home_wickets=$4,away_wickets=$5,home_overs=$6,away_overs=$7,
                 winner_team_id=$8,completed_at=now()
             WHERE id=$1`,
            [
              fixture.id,
              home,
              away,
              4 + (index % 6),
              5 + (index % 5),
              20 - (index % 6),
              20 - ((index + 2) % 6),
              home > away ? fixture.home_team_id : fixture.away_team_id,
            ],
          );
        } else {
          await tx.query(
            `UPDATE ${tournament.matches} SET status='completed',home_score=$2,away_score=$3,
             winner_team_id=$4,completed_at=now() WHERE id=$1`,
            [fixture.id, home, away, home > away ? fixture.home_team_id : fixture.away_team_id],
          );
        }
      }

      // The Cricksal demo keeps its deciding group fixture *in play*: the away side
      // is done at 110/8 from their 20 overs and the home side is chasing at 87/3
      // off 12.4, so the desk and the projector open on the innings that ends the
      // group stage. Batters on both sides and each team's bowlers are credited
      // within their own tallies, and finishing the match through the desk draws
      // the knockout bracket.
      if (tournament.cricket) {
        const playing = (
          await one(
            tx,
            `SELECT id,home_team_id,away_team_id FROM ${tournament.matches} WHERE id=$1`,
            [last],
          )
        )!;
        await tx.query(
          `UPDATE ${tournament.matches}
           SET status='live',version=1,home_score=87,away_score=110,
               home_wickets=3,away_wickets=8,home_overs=12.4,away_overs=20.0
           WHERE id=$1`,
          [playing.id],
        );
        const roster = async (teamId: string, count: number) =>
          (
            await tx.query(
              `SELECT tp.id FROM team_players tp
               JOIN ${tournament.table} t ON t.order_item_id=tp.order_item_id
               WHERE t.id=$1 ORDER BY tp.position LIMIT $2`,
              [teamId, count],
            )
          ).rows.map((r) => r.id);
        const homePlayers = await roster(playing.home_team_id, 5);
        const awayPlayers = await roster(playing.away_team_id, 5);
        const scorers = [
          [playing.home_team_id, homePlayers, [40, 23, 19]],
          [playing.away_team_id, awayPlayers, [45, 30, 22]],
        ] as const;
        for (const [teamId, players, runs] of scorers)
          for (const [index, playerId] of players.slice(0, 3).entries())
            await tx.query(
              'INSERT INTO cricket_scorers(match_id,team_id,player_id,runs) VALUES($1,$2,$3,$4)',
              [playing.id, teamId, playerId, runs[index]],
            );
        const bowlers = [
          [playing.home_team_id, homePlayers, [2, 1]],
          [playing.away_team_id, awayPlayers, [2, 1]],
        ] as const;
        for (const [teamId, players, wickets] of bowlers)
          for (const [index, playerId] of players.slice(3, 5).entries())
            await tx.query(
              'INSERT INTO cricket_wickets(match_id,team_id,player_id,wickets) VALUES($1,$2,$3,$4)',
              [playing.id, teamId, playerId, wickets[index]],
            );
      }

      // Two pending payments per sport keep the review queue worth clicking through.
      for (const [queueIndex, status] of ['receipt_submitted', 'under_review'].entries()) {
        const name = pendingCompanies[sportIndex * 2 + queueIndex];
        const userId = (
          await tx.query(
            'INSERT INTO users(google_id,email,name,phone) VALUES($1,$2,$3,$4) RETURNING id',
            [
              `pending-${randomUUID()}`,
              `${tournament.uri}-${status}-${queueIndex + 1}@championship.local`,
              name,
              `+977 98${String(14000000 + sportIndex * 31 + queueIndex * 77).slice(0, 8)}`,
            ],
          )
        ).rows[0].id;
        const orderId = (
          await tx.query(
            'INSERT INTO orders(user_id,status,created_at) VALUES($1,$2,$3) RETURNING id',
            [
              userId,
              status,
              new Date(Date.now() - (queueIndex ? 90 : 40) * 60_000 - sportIndex * 60_000),
            ],
          )
        ).rows[0].id;
        await tx.query(
          `INSERT INTO order_items(order_id,sport_id,price_at_purchase,team_name)
           VALUES($1,$2,$3,$4)`,
          [orderId, sportId, price, name],
        );
        await tx.query(
          `INSERT INTO payment_requests(order_id,unique_code,qr_payload,expires_at)
           VALUES($1,$2,$3,now()+interval '14 days')`,
          [
            orderId,
            `SEED-${tournament.code}-${status === 'receipt_submitted' ? 'PAY' : 'REV'}${queueIndex + 1}`,
            `upi://pay?pa=championship@bank&pn=${encodeURIComponent(name)}&am=${priceLocked.toFixed(2)}`,
          ],
        );
        const receiptKey = `receipts/seed-${randomUUID()}.webp`;
        await tx.query('INSERT INTO receipts(order_id,file_url,uploaded_at) VALUES($1,$2,now())', [
          orderId,
          receiptKey,
        ]);
        files.set(receiptKey, { body: tinyPng, mime: 'image/png' });
        await tx.query('UPDATE orders SET total_amount=$2,invoiced_at=now() WHERE id=$1', [
          orderId,
          priceLocked,
        ]);
      }
    }
  });
}
