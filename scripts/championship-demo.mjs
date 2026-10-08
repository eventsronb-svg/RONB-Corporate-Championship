// Disposable local demo server for the whole championship flow. It uses an in-memory
// PGlite database only, so nothing touches the configured database. Every registration
// is complete, and both championships are imported, drawn and played into the knockout.
// DEMO_PLAY=1 plays everything into the knockout; DEMO_PLAY=groups draws the groups
// and completes every group match except the last fixture of each sport.
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../dist/app.js';
import { config } from '../dist/config.js';
import { migrate } from '../dist/db.js';

const p = new PGlite();
const adapter = (client) => ({
  async query(sql, values) {
    if (!values?.length) {
      const result = await client.exec(sql);
      return { rows: result.at(-1)?.rows ?? [] };
    }
    return client.query(sql, values);
  },
});
const db = {
  ...adapter(p),
  transaction: (fn) => p.transaction((tx) => fn(adapter(tx))),
  close: () => p.close(),
};
await migrate(db);

const port = Number(process.env.PORT ?? 3000);
const appOrigin = `http://localhost:${port}`;
const c = config({
  NODE_ENV: 'test',
  APP_ORIGIN: appOrigin,
  DATABASE_URL: 'championship-demo',
  COOKIE_SECRET: 'c'.repeat(32),
  ADMIN_LOGIN_USERNAME: 'demo-organizer',
  ADMIN_LOGIN_PASSWORD: 'demo-organizer-password',
});
const image = (text, w = 160, h = 160) =>
  `https://placehold.co/${w}x${h}/111827/f9fafb?text=${encodeURIComponent(text)}`;
const storage = {
  async put() {
    return { key: 'team-logos/demo.webp', url: image('RONB') };
  },
  async remove() {},
  async signReceipt() {
    return image('Receipt', 600, 800);
  },
  async signPlayerPhoto() {
    return image('Player', 240, 240);
  },
};
const google = {
  authorizationUrl: () => `${appOrigin}/admin/auth/google`,
  async exchange() {
    return {
      googleId: 'demo-organizer',
      email: 'demo-organizer@demo.local',
      name: 'Demo Organizer',
    };
  },
};
const app = await buildApp({ db, config: c, storage, google });

// --------------------------------------------------------------------- helpers
let cookie = '';
async function call(method, url, payload) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    // Mutating routes reject requests without a same-origin Origin header.
    headers: { origin: appOrigin, ...(cookie ? { cookie: `admin_session=${cookie}` } : {}) },
  });
  const body = response.json();
  if (response.statusCode >= 400)
    throw new Error(`${method} ${url} -> ${response.statusCode} ${JSON.stringify(body)}`);
  return body;
}
const initials = (name) =>
  name
    .split(' ')
    .map((word) => word[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();
const logoFor = (name) => image(initials(name));
const hoursAgo = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();

const FIRST = [
  'Aarav',
  'Bishal',
  'Chandra',
  'Deepak',
  'Dipesh',
  'Gopal',
  'Himal',
  'Kiran',
  'Manoj',
  'Nabin',
  'Naresh',
  'Prakash',
  'Ramesh',
  'Sagar',
  'Sanjay',
  'Suraj',
  'Tek',
  'Umesh',
];
const LAST = [
  'Adhikari',
  'Bhattarai',
  'Chhetri',
  'Gurung',
  'Khadka',
  'Lamichhane',
  'Magar',
  'Nepal',
  'Poudel',
  'Rajbhandari',
  'Shrestha',
  'Thapa',
];
const JERSEY = ['S', 'M', 'L', 'XL', '2XL'];
const player = (index) => `${FIRST[index % FIRST.length]} ${LAST[(index * 7) % LAST.length]}`;

const COMPANIES = [
  'Everest Digital',
  'Himalayan Traders',
  'Annapurna Foods',
  'Kathmandu Ventures',
  'Sagarmatha Tours',
  'Pokhara Hotels',
  'Lumbini Media',
  'Chitwan Agri',
  'Solu Khumbu Sports',
  'Gandaki Ceramics',
  'Bheri Motors',
  'Kosi Construction',
  'Marsyangdi Textiles',
  'Bagmati Pharmacy',
  'Rapti Logistics',
  'Trishuli Chemicals',
  'Langtang Trekking',
  'Manang Hardware',
  'Barun Energy',
  'Kailash Publishing',
  'Rolpa Coffee',
  'Darchula Steel',
  'Surkhund Events',
  'Kapilvastu Cement',
  'Karnali Timber',
  'Koshi Shipping',
  'Mahakali Herbs',
  'Mustang Furniture',
  'Nuwakot Plastics',
  'Panchase Electronics',
  'Salyan Paper Mills',
  'Terai Agro',
  'Janaki Rice Mill',
  'Bheri Bottling',
  'Gorkha Breweries',
  'Ilam Tea Estate',
  'Dolpa Mineral',
  'Sunsari Salt',
  'Rasuwa Cider',
  'Jumla Wool',
];
const FUTSAL_TEAMS = 32;
const BASKETBALL_TEAMS = 16;
const CRICKSAL_TEAMS = 20;
// Cricksal fills its twenty slots with twelve companies that also entered a team sport
// and eight cricket-only registrations, so the queue shows single and multi-sport orders.
const CRICKSAL_SHARED = [0, 11];
const CRICKSAL_ONLY_FROM = 32;
const ROSTER = { futsal: 5, basketball: 5, cricksal: 11 };
const STATUS_PATH = [
  'phone_captured',
  'invoiced',
  'payment_pending',
  'receipt_submitted',
  'confirmed',
  'contacted',
  'completed',
];

// ----------------------------------------------------------------- event + sports
const event = (
  await db.query(
    `INSERT INTO events(title,description,start_date,end_date,venue,show_teams)
     VALUES($1,$2,now()+interval '14 days',now()+interval '15 days',$3,true) RETURNING title,venue`,
    [
      'RONB Corporate Championship 2026',
      'Three days of futsal, basketball and cricksal between some of the country’s leading companies. ' +
        'Every confirmed team is drawn into a group, plays it out, and the top teams meet in the knockout bracket.',
      'Bhrikutimandap Exhibition Hall, Kathmandu',
    ],
  )
).rows[0];
const sports = await db.query(
  `INSERT INTO sports(name,price,max_teams,description) VALUES
     ('Futsal',50000,32,'Five-a-side corporate futsal. Eight groups of four, top two into the knockout bracket.'),
     ('Basketball',30000,16,'Corporate five-on-five basketball. Four groups of four, top two into the bracket.'),
     ('Cricksal',70000,20,'Corporate box cricket in full-sleeve kits with a seven-player minimum squad.')
   RETURNING id,name,price`,
);
const sport = new Map(sports.rows.map((row) => [row.name.toLowerCase(), row]));
await db.query(
  `INSERT INTO admins(email,name,role,active) VALUES
     ('organizer@demo.local','Demo Organizer','super_admin',true),
     ('staff@demo.local','Demo Staff','staff',true),
     ('retired@demo.local','Retired Organizer','staff',false)`,
);
const organizer = (await db.query("SELECT id FROM admins WHERE email='organizer@demo.local'"))
  .rows[0].id;
console.log(
  `Event "${event.title}" at ${event.venue}, sports: ${sports.rows.map((s) => s.name).join(', ')}.`,
);

// --------------------------------------------------------------- registrations
// Every order is finished: invoice, verified payment, complete roster and a sent
// confirmation, so the queue, team profile, roster editor and PDF export all work.
let orders = 0;
let items = 0;
for (let index = 0; index < COMPANIES.length; index++) {
  const company = COMPANIES[index];
  // Every sport sells out: 32 futsal, 16 basketball and 20 cricksal entries.
  const picks = [];
  if (index < FUTSAL_TEAMS) picks.push('futsal');
  if (index < BASKETBALL_TEAMS) picks.push('basketball');
  if (index >= CRICKSAL_SHARED[0] && index <= CRICKSAL_SHARED[1]) picks.push('cricksal');
  if (index >= CRICKSAL_ONLY_FROM) picks.push('cricksal');
  const sleeve = index % 2 ? 'full_sleeve' : 'half_sleeve';
  const captain = `${FIRST[index % FIRST.length]} ${LAST[(index * 3) % LAST.length]}`;
  const user = (
    await db.query(
      'INSERT INTO users(google_id,email,name,phone) VALUES($1,$2,$3,$4) RETURNING id,email',
      [
        `demo-captain-${index}`,
        `captain${index + 1}@demo.local`,
        captain,
        `9801${String(100000 + index * 137).slice(0, 6)}`,
      ],
    )
  ).rows[0];
  const order = (
    await db.query(
      "INSERT INTO orders(user_id,status,phone_number,created_at,updated_at) VALUES($1,'draft',$2,$3,$3) RETURNING id",
      [
        user.id,
        `9801${String(200000 + index * 91).slice(0, 6)}`,
        hoursAgo(24 * (18 - (index % 16))),
      ],
    )
  ).rows[0];
  let total = 0;
  for (const name of picks) {
    const row = sport.get(name);
    const item = (
      await db.query(
        `INSERT INTO order_items(order_id,sport_id,price_at_purchase,team_name,logo_url,jersey_style)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          order.id,
          row.id,
          row.price,
          company,
          logoFor(company),
          name === 'cricksal' ? sleeve : null,
        ],
      )
    ).rows[0];
    total += Number(row.price);
    for (let position = 0; position < ROSTER[name]; position++)
      await db.query(
        `INSERT INTO team_players(order_item_id,player_name,position,jersey_size,jersey_style,photo_url)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          item.id,
          player(index * 3 + position),
          position,
          JERSEY[(index + position) % JERSEY.length],
          name === 'cricksal' ? sleeve : null,
          position < 2 ? `player-photos/${order.id}/${item.id}/${position}.webp` : null,
        ],
      );
    await db.query('UPDATE order_items SET profile_completed_at=now() WHERE id=$1', [item.id]);
    items++;
  }
  await db.query(
    "UPDATE orders SET total_amount=$2,invoiced_at=now(),confirmed_at=now(),status='completed' WHERE id=$1",
    [order.id, total],
  );
  await db.query(
    'INSERT INTO payment_requests(order_id,unique_code,qr_payload,expires_at) VALUES($1,$2,$3,NULL)',
    [order.id, `RONB-${1000 + index}`, `NPR ${total} | RONB-${1000 + index} | ${company}`],
  );
  await db.query(
    "INSERT INTO payment_verifications(order_id,admin_id,decision,notes) VALUES($1,$2,'confirmed',$3)",
    [order.id, organizer, 'Verified against the bank statement.'],
  );
  await db.query('INSERT INTO receipts(order_id,file_url) VALUES($1,$2)', [
    order.id,
    `receipts/${order.id}.png`,
  ]);
  for (const [step, status] of STATUS_PATH.entries())
    await db.query(
      'INSERT INTO order_status_history(order_id,from_status,to_status,changed_by,changed_at) VALUES($1,$2,$3,$4,$5)',
      [
        order.id,
        step ? STATUS_PATH[step - 1] : null,
        status,
        status === 'confirmed' || status === 'completed' ? organizer : null,
        hoursAgo((STATUS_PATH.length - step) * 24),
      ],
    );
  await db.query(
    `INSERT INTO email_jobs(order_id,kind,payload,status,attempts,first_attempt_at)
     VALUES($1,'confirmation',$2,'sent',1,now()-interval '2 days')`,
    [order.id, JSON.stringify({ company, sports: picks })],
  );
  await db.query(
    "INSERT INTO email_log(order_id,user_id,sent_to,status,provider_message_id) VALUES($1,$2,$3,'sent',$4)",
    [order.id, user.id, user.email, `demo-${order.id.slice(0, 8)}`],
  );
  orders++;
}
console.log(`Seeded ${orders} completed registrations covering ${items} team entries.`);

// ------------------------------------------------------------ organizer session
const login = await app.inject({
  method: 'POST',
  url: '/admin/auth/password',
  payload: { username: 'demo-organizer', password: 'demo-organizer-password' },
  headers: { origin: appOrigin },
});
if (login.statusCode >= 400) throw new Error(`Login failed: ${login.statusCode}`);
cookie = login.cookies.find((entry) => entry.name === 'admin_session')?.value ?? '';
console.log('Organizer session ready.');

// -------------------------------------------------------------------- cricksal
// Cricksal's registrations: twenty complete entries, twelve from companies that
// also field a team sport and eight that entered cricket only, every squad with
// a sleeve style and photos — the field the championship draw below draws from.
const cricksalId = sport.get('cricksal').id;
const cricksal = (
  await db.query(
    `SELECT count(*)::int AS entries,
            count(*) FILTER (WHERE players >= 7)::int AS complete_rosters,
            sum(players)::int AS squad,
            sum(photos)::int AS photos,
            count(*) FILTER (WHERE sleeve = 'full_sleeve')::int AS full_sleeve,
            count(*) FILTER (WHERE sleeve = 'half_sleeve')::int AS half_sleeve,
            count(*) FILTER (WHERE other_entries > 0)::int AS shared,
            count(*) FILTER (WHERE other_entries = 0)::int AS cricket_only
     FROM (
       SELECT i.id,
              i.jersey_style AS sleeve,
              (SELECT count(*) FROM team_players p WHERE p.order_item_id = i.id) AS players,
              (SELECT count(*) FROM team_players p
                WHERE p.order_item_id = i.id AND p.photo_url IS NOT NULL) AS photos,
              (SELECT count(*) FROM order_items o WHERE o.order_id = i.order_id AND o.id <> i.id)
                AS other_entries
       FROM order_items i
       WHERE i.sport_id = $1
     ) AS entry`,
    [cricksalId],
  )
).rows[0];
const queue = await call('GET', `/admin/orders?sport_id=${cricksalId}&status=all&limit=100`);
const wants = (ok, what, detail) => {
  if (!ok) throw new Error(`Cricksal demo is incomplete: ${what} (${detail})`);
};
wants(cricksal.entries === 20, 'twenty registered teams', cricksal.entries);
wants(
  cricksal.complete_rosters === 20,
  'every squad has at least the seven-player minimum',
  cricksal.complete_rosters,
);
wants(cricksal.shared === 12, 'twelve companies that also play a team sport', cricksal.shared);
wants(cricksal.cricket_only === 8, 'eight cricket-only companies', cricksal.cricket_only);
wants(
  cricksal.full_sleeve + cricksal.half_sleeve === 20,
  'a sleeve style on every kit',
  `${cricksal.full_sleeve} full / ${cricksal.half_sleeve} half`,
);
wants(
  queue.orders.length === 20,
  'twenty registrations in the organizer queue',
  queue.orders.length,
);
console.log(
  `Cricksal: ${cricksal.entries} registered teams (${cricksal.shared} also in a team sport, ` +
    `${cricksal.cricket_only} cricket only), ${cricksal.squad} players and ${cricksal.photos} photos, ` +
    `${cricksal.full_sleeve} full-sleeve and ${cricksal.half_sleeve} half-sleeve kits, ` +
    `${queue.orders.length} orders in the queue.`,
);

// -------------------------------------------------------------- championships
// Teams are imported but no group is assigned, which is the state the organizer
// group-assigning screen is designed for. Set DEMO_PLAY=1 to also draw and play
// everything, so the later stages stay reachable without editing the seed.
// DEMO_PLAY=groups instead draws the futsal and basketball groups and plays every
// group match but one, leaving a single scheduled fixture per sport with no
// knockout bracket yet, while cricket stays imported and unassigned so its draw
// can be done by hand from the admin screen.
const PLAY = process.env.DEMO_PLAY === '1';
const GROUPS_ONLY = process.env.DEMO_PLAY === 'groups';
for (const sportName of ['futsal', 'cricket', 'basketball']) {
  const imported = await call('POST', `/admin/${sportName}/import`);
  const { teams } = await call('GET', `/admin/${sportName}`);
  console.log(
    `${sportName}: imported ${imported.imported} teams, 0 of ${teams.length} assigned to a group.`,
  );
}

// Groups lock once fixtures exist, so assign groups first and draw fixtures second.
async function drawGroupsAndFixtures(sportName, groupCodes, size = 4) {
  const imported = await call('POST', `/admin/${sportName}/import`);
  const { teams } = await call('GET', `/admin/${sportName}`);
  for (const [index, team] of teams.entries())
    await call('PATCH', `/admin/${sportName}/teams/${team.id}/group`, {
      group_code: groupCodes[Math.floor(index / size)],
    });
  const fixtures = await call('POST', `/admin/${sportName}/generate-fixtures`);
  console.log(
    `${sportName}: imported ${imported.imported} teams, ${groupCodes.length} groups of ${size}, ${fixtures.matches} group matches drawn.`,
  );
}
async function play(sportName, match, home, away, penaltyWinner) {
  await call('POST', `/admin/${sportName}/matches/${match.id}/start`);
  const patch = {
    home_score: home,
    away_score: away,
    version: match.version + 1,
  };
  if (sportName === 'cricket') {
    // A cricket line needs all three numbers: the wickets follow the runs, and
    // the side with fewer runs is the one that used its full twenty overs.
    patch.home_wickets = Math.min(7, Math.floor(home / 25));
    patch.away_wickets = Math.min(7, Math.floor(away / 25));
    patch.home_overs = home >= away ? 9.4 : 10.0;
    patch.away_overs = away >= home ? 9.4 : 10.0;
  }
  const saved = await call('PATCH', `/admin/${sportName}/matches/${match.id}`, patch);
  const body = { version: saved.version };
  if (sportName === 'basketball') {
    body.home_score = home;
    body.away_score = away;
  }
  if (penaltyWinner) body.penalty_winner_id = penaltyWinner;
  await call('POST', `/admin/${sportName}/matches/${match.id}/end`, body);
}
const groupFixtures = (data) =>
  data.groups.flatMap((group) => group.matches).filter((m) => m.home_team_id && m.away_team_id);
// Bracket teams only appear once the previous round is decided, so each round refetches.
const bracketRound = (data, stage) =>
  data.bracket.filter(
    (m) => m.stage === stage && m.status === 'scheduled' && m.home_team_id && m.away_team_id,
  );
async function playRound(sportName, stage, score) {
  const played = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const data = await call('GET', `/admin/${sportName}`);
    const round = bracketRound(data, stage);
    if (!round.length) break;
    for (const [index, match] of round.entries()) {
      const [home, away] = score(played.length + index);
      await play(sportName, match, home, away, home === away ? match.home_team_id : undefined);
      played.push(match);
    }
  }
  return played;
}

if (PLAY || GROUPS_ONLY) {
  await drawGroupsAndFixtures('futsal', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
}
let futsal = await call('GET', '/admin/futsal');
const futsalGroups = PLAY || GROUPS_ONLY ? groupFixtures(futsal) : [];
// Group-stage-only mode stops one fixture short of a complete group stage.
const futsalToPlay = GROUPS_ONLY && !PLAY ? futsalGroups.slice(0, -1) : futsalGroups;
if (PLAY || GROUPS_ONLY)
  for (const [index, match] of futsalToPlay.entries()) {
    const home = 1 + ((index * 3) % 5);
    await play('futsal', match, home, index % 7 === 0 ? home : 1 + ((index * 3 + 2) % 4));
  }
// The futsal bracket is created automatically once the last group match ends.
// A few knockout ties are settled on penalties so that path is exercised too.
const futsalKnockout = (index) => {
  const home = 2 + (index % 4);
  return [home, index % 5 === 3 ? home : home + 1 + (index % 2)];
};
if (PLAY) {
  const futsalPrequarters = await playRound('futsal', 'prequarter', futsalKnockout);
  const futsalQuarters = await playRound('futsal', 'quarter', futsalKnockout);
  const futsalSemis = await playRound('futsal', 'semi', () => [5, 3]);
  futsal = await call('GET', '/admin/futsal');
  const futsalFinal = bracketRound(futsal, 'final');
  await call('POST', `/admin/futsal/matches/${futsalFinal[0].id}/start`);
  await call('PATCH', `/admin/futsal/matches/${futsalFinal[0].id}`, {
    home_score: 2,
    away_score: 1,
    version: futsalFinal[0].version + 1,
  });
  console.log(
    `Futsal: all ${futsalGroups.length} group matches played, ${futsalPrequarters.length} pre-quarter-finals, ${futsalQuarters.length} quarter-finals and ${futsalSemis.length} semi-finals played, final live.`,
  );

  await drawGroupsAndFixtures('basketball', ['A', 'B', 'C', 'D']);
  let basketball = await call('GET', '/admin/basketball');
  const basketballGroups = groupFixtures(basketball);
  for (const [index, match] of basketballGroups.entries()) {
    const home = 40 + ((index * 7) % 30);
    const away = 35 + ((index * 11) % 32);
    await play('basketball', match, home, home === away ? home + 3 : away);
  }
  // The basketball bracket is created automatically once all group matches are complete.
  const basketballQuarters = await playRound('basketball', 'quarter', (index) => [
    62 + (index % 5) * 3,
    58 + (index % 4) * 2 + (index % 3),
  ]);
  basketball = await call('GET', '/admin/basketball');
  const basketballSemis = bracketRound(basketball, 'semi');
  await play('basketball', basketballSemis[0], 71, 66);
  await call('POST', `/admin/basketball/matches/${basketballSemis[1].id}/start`);
  await call('PATCH', `/admin/basketball/matches/${basketballSemis[1].id}`, {
    home_score: 18,
    away_score: 15,
    version: basketballSemis[1].version + 1,
  });
  console.log(
    `Basketball: all ${basketballGroups.length} group matches played, bracket created automatically, ${basketballQuarters.length} quarter-finals and one semi-final played, one semi-final live.`,
  );

  await drawGroupsAndFixtures('cricket', ['A', 'B', 'C', 'D'], 5);
  let cricket = await call('GET', '/admin/cricket');
  const cricketGroups = groupFixtures(cricket);
  // Every sixth fixture ends level, so the super-over winner path is exercised
  // inside the group stage as well as in the knockout rounds.
  for (const [index, match] of cricketGroups.entries()) {
    const home = 120 + ((index * 7) % 45);
    const away = index % 6 === 0 ? home : 110 + ((index * 11) % 50);
    await play('cricket', match, home, away, home === away ? match.home_team_id : undefined);
  }
  // The cricket bracket is created automatically once all 40 group matches end.
  const cricketQuarters = await playRound('cricket', 'quarter', (index) => [
    145 + (index % 4) * 5,
    138 + (index % 5) * 4,
  ]);
  cricket = await call('GET', '/admin/cricket');
  const cricketSemis = bracketRound(cricket, 'semi');
  await play('cricket', cricketSemis[0], 162, 155);
  await call('POST', `/admin/cricket/matches/${cricketSemis[1].id}/start`);
  await call('PATCH', `/admin/cricket/matches/${cricketSemis[1].id}`, {
    home_score: 98,
    away_score: 97,
    home_wickets: 4,
    away_wickets: 6,
    home_overs: 9.2,
    away_overs: 9.5,
    version: cricketSemis[1].version + 1,
  });
  console.log(
    `Cricket: all ${cricketGroups.length} group matches played, bracket created automatically, ${cricketQuarters.length} quarter-finals and one semi-final played, one semi-final live.`,
  );
} else if (GROUPS_ONLY) {
  await drawGroupsAndFixtures('basketball', ['A', 'B', 'C', 'D']);
  const basketball = await call('GET', '/admin/basketball');
  const basketballGroups = groupFixtures(basketball);
  for (const [index, match] of basketballGroups.slice(0, -1).entries()) {
    const home = 40 + ((index * 7) % 30);
    const away = 35 + ((index * 11) % 32);
    await play('basketball', match, home, home === away ? home + 3 : away);
  }
  // Cricket stays imported but unassigned so the organizer can run the whole
  // draw — groups, placements and fixtures — by hand from admin#cricket.
  const cricketTeams = (await call('GET', '/admin/cricket')).teams;
  console.log(
    `Group stages: futsal ${futsalGroups.length - 1}/${futsalGroups.length} matches completed, ` +
      `basketball ${basketballGroups.length - 1}/${basketballGroups.length} matches completed — ` +
      `one scheduled fixture left in each, no bracket yet. Cricket: ` +
      `${cricketTeams.length} teams imported, none assigned to a group.`,
  );
} else {
  console.log('');
  console.log('No groups assigned and no fixtures drawn. Assign the groups by hand and');
  console.log('the fixtures draw themselves; walk the rest of the flow from there.');
}

await app.listen({ host: '127.0.0.1', port });
console.log('');
console.log(`Landing page:  ${appOrigin}/`);
console.log(`Registration:  ${appOrigin}/register`);
console.log(`Cricksal:      ${appOrigin}/register?focus=cricksal`);
console.log(`Futsal:        ${appOrigin}/futsal`);
console.log(`Futsal live:    ${appOrigin}/futsal/match`);
console.log(`Basketball:    ${appOrigin}/basketball`);
console.log(`Basketball live:${appOrigin}/basketball/match`);
console.log(`Futsal groups: ${appOrigin}/admin#futsal`);
console.log(`Basketball groups: ${appOrigin}/admin#basketball`);
console.log(`Cricksal:      ${appOrigin}/cricket`);
console.log(`Cricksal live: ${appOrigin}/cricket/match`);
console.log(`Cricksal groups:${appOrigin}/admin#cricket`);
console.log(`Organizer:     ${appOrigin}/admin#orders`);
console.log(`Cricksal queue:${appOrigin}/admin#orders?sport_id=${cricksalId}&status=all`);
console.log('Login:         demo-organizer / demo-organizer-password');
console.log('Database:      in-memory PGlite, nothing is persisted');

async function stop() {
  await app.close();
  await db.close();
  process.exit(0);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
