const app = document.querySelector('#app');
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const team = (v) =>
  v
    ? `<span class="team">${v.logo_url ? `<img class="logo" src="${esc(v.logo_url)}" alt="">` : ''}${esc(v.team_name)}</span>`
    : '<span class="team team-pending">TBD</span>';
// The live strip at the top reuses the same side card as futsal — crest plus
// name — and falls back to the site crest when a team has not uploaded a logo,
// so the panel reads the same whether the demo seeds crests or a real team does.
// Bat and ball mark who is in to bat and who is bowling. The assignment only
// exists once the organizer starts the match, so the tags show on live lines.
const batIcon =
  '<svg class="role-icon role-bat" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><g transform="rotate(45 12 12)"><rect x="10.7" y="1.5" width="2.6" height="7.2" rx="1.3"/><rect x="9" y="8.2" width="6" height="14.3" rx="2.6"/></g></svg>';
const ballIcon =
  '<svg class="role-icon role-ball" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M7.2 6.6c2.6 1.6 2.6 9.2 0 10.8"/></svg>';
const roleTag = (m, side) => {
  if (m.status !== 'live' || !m.batting_side) return '';
  const batting = m.batting_side === side;
  return `<span class="innings-role ${batting ? 'is-batting' : 'is-bowling'}" title="${batting ? 'Batting' : 'Bowling'}" aria-label="${batting ? 'Batting' : 'Bowling'}">${batting ? batIcon : ballIcon}</span>`;
};
const ongoingSide = (value, role = '') =>
  `<div class="ongoing-side"><img src="${esc(value?.logo_url || '/assets/images/logo.webp')}" alt="${esc(value?.team_name || 'Team')} logo"><strong>${role}${esc(value?.team_name || 'Team')}</strong></div>`;
// A fixture line reads both innings the cricket way: 145/6 (9.4) – 139/8 (10.0).
const scoreLine = (m) =>
  `${m.home_score}/${m.home_wickets} (${Number(m.home_overs).toFixed(1)}) – ${m.away_score}/${m.away_wickets} (${Number(m.away_overs).toFixed(1)})`;
// Bracket boxes sit shoulder to shoulder, so they keep the compact runs and
// wickets and leave the overs to the fixtures, the report and the big screen.
const bracketScore = (m) => `${m.home_score}/${m.home_wickets} – ${m.away_score}/${m.away_wickets}`;
const fixture = (m, by) =>
  `<div class="fixture"><span>${roleTag(m, 'home')}${team(by.get(m.home_team_id))}</span><b>${m.status === 'scheduled' ? '—' : scoreLine(m)}</b><span>${roleTag(m, 'away')}${team(by.get(m.away_team_id))}</span></div>`;
const bracketMatch = (m, by) => {
  const result = (id) =>
    m.status !== 'completed' || !m.winner_team_id
      ? ''
      : id === m.winner_team_id
        ? ' bracket-winner'
        : ' bracket-loser';
  const logo = (id) =>
    `<span class="${result(id)}"><span class="bracket-logo"><img class="logo" src="${esc(by.get(id)?.logo_url || '/assets/images/logo.webp')}" alt=""></span></span>`;
  return `<article class="bracket-match${m.status === 'live' ? ' bracket-match-live' : ''}"><div class="bracket-pair">${logo(m.home_team_id)}<b>${m.status === 'scheduled' ? '—' : bracketScore(m)}</b>${logo(m.away_team_id)}</div></article>`;
};
function drawBracketConnections() {
  const bracket = document.querySelector('.bracket');
  const svg = bracket?.querySelector('.bracket-connections');
  if (!bracket || !svg) return;
  const bounds = bracket.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
  svg.innerHTML = '';
  const line = (x1, y1, x2, y2) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    element.setAttribute('x1', String(x1));
    element.setAttribute('y1', String(y1));
    element.setAttribute('x2', String(x2));
    element.setAttribute('y2', String(y2));
    element.setAttribute('class', 'bracket-connection');
    svg.append(element);
  };
  const point = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left - bounds.left,
      right: rect.right - bounds.left,
      y: rect.top - bounds.top + rect.height / 2,
    };
  };
  const rounds = [...bracket.querySelectorAll('.bracket-round')];
  for (let index = 0; index < rounds.length - 1; index++) {
    const sources = [...rounds[index].querySelectorAll('.bracket-match')];
    const targets = [...rounds[index + 1].querySelectorAll('.bracket-match')];
    const rightSide = index >= 3;
    if (sources.length === 1 && targets.length === 1) {
      const source = point(sources[0]);
      const target = point(targets[0]);
      const sourceEdge = rightSide ? source.left : source.right;
      const targetEdge = rightSide ? target.right : target.left;
      const midpoint = (sourceEdge + targetEdge) / 2;
      line(sourceEdge, source.y, midpoint, source.y);
      line(midpoint, source.y, midpoint, target.y);
      line(midpoint, target.y, targetEdge, target.y);
    } else if (!rightSide) {
      targets.forEach((targetElement, targetIndex) => {
        const first = sources[targetIndex * 2];
        const second = sources[targetIndex * 2 + 1];
        if (!first || !second) return;
        const a = point(first);
        const b = point(second);
        const target = point(targetElement);
        const midpoint = (a.right + target.left) / 2;
        line(a.right, a.y, midpoint, a.y);
        line(b.right, b.y, midpoint, b.y);
        line(midpoint, a.y, midpoint, b.y);
        line(midpoint, target.y, target.left, target.y);
      });
    } else {
      sources.forEach((sourceElement, sourceIndex) => {
        const first = targets[sourceIndex * 2];
        const second = targets[sourceIndex * 2 + 1];
        if (!first || !second) return;
        const source = point(sourceElement);
        const a = point(first);
        const b = point(second);
        const midpoint = (source.left + a.right) / 2;
        line(source.left, source.y, midpoint, source.y);
        line(midpoint, a.y, midpoint, b.y);
        line(midpoint, a.y, a.right, a.y);
        line(midpoint, b.y, b.right, b.y);
      });
    }
  }
}
function render(data, live) {
  const groupStageOpen = app.querySelector('.group-stage')?.open ?? false;
  const by = new Map(data.teams.map((t) => [t.id, t]));
  const matches = data.groups.flatMap((g) => g.matches);
  const done = matches.length > 0 && matches.every((m) => m.status === 'completed');
  const generated = data.bracket.length > 0;
  const groups = data.groups
    .map((g) => {
      const groupDone = g.matches.length > 0 && g.matches.every((m) => m.status === 'completed');
      return `<section class="panel"><h2>Group ${g.code}</h2><div class="scroll"><table><thead><tr><th>Team</th><th>P</th><th>W</th><th>L</th><th>RF</th><th>RA</th><th>RD</th><th>Pts</th></tr></thead><tbody>${g.table.map((t) => `<tr class="${groupDone && t.position <= 2 ? 'qualified-team' : ''}"><td><span class="standing-team"><b>${t.position}.</b>${team(t)}</span></td><td>${t.played}</td><td>${t.wins}</td><td>${t.losses}</td><td>${t.runs_for}</td><td>${t.runs_against}</td><td>${t.run_difference}</td><td><b>${t.points}</b></td></tr>`).join('')}</tbody></table></div><h3>Fixtures</h3>${g.matches.map((m) => fixture(m, by)).join('') || '<p>No fixtures yet.</p>'}</section>`;
    })
    .join('');
  const round = (stage, label, predicate, reverse = false) =>
    `<div class="bracket-round"><h3>${label}</h3><div class="bracket-matches">${
      data.bracket
        .filter((m) => m.stage === stage && predicate(m))
        .slice()
        .sort((a, b) =>
          reverse
            ? b.bracket_position - a.bracket_position
            : a.bracket_position - b.bracket_position,
        )
        .map((m) => bracketMatch(m, by))
        .join('') || '<p class="bracket-pending">Pending</p>'
    }</div></div>`;
  // The eight-team cricket bracket draws from the same layout as the basketball
  // one: quarters on the outside, semis inside them, the final in the middle.
  const bracket =
    done && generated
      ? `<section class="stage bracket-stage"><h2>Match bracket</h2><div class="bracket basketball-bracket"><svg class="bracket-connections" aria-hidden="true"></svg>${round('quarter', 'Quarterfinals', (m) => m.bracket_position <= 2)}${round('semi', 'Semifinals', (m) => m.bracket_position === 1)}${round('final', 'Final', () => true)}${round('semi', 'Semifinals', (m) => m.bracket_position === 2)}${round('quarter', 'Quarterfinals', (m) => m.bracket_position > 2, true)}</div></section>`
      : '';
  app.innerHTML = `${live?.status === 'live' ? `<section class="ongoing-match"><p>Live now</p><div class="ongoing-scoreboard cricket-line">${ongoingSide(live.home_team, roleTag(live, 'home'))}<b>${scoreLine(live)}</b>${ongoingSide(live.away_team, roleTag(live, 'away'))}</div></section>` : ''}${bracket}${done ? `<details class="group-stage" ${groupStageOpen ? 'open' : ''}><summary>Group stage complete · 4 tables · ${matches.length} matches</summary><div class="groups">${groups}</div></details>` : `<div class="groups">${groups}</div>`}`;
  drawBracketConnections();
}
async function load() {
  try {
    const [d, l] = await Promise.all([fetch('/cricket/data'), fetch('/cricket/live')]);
    if (!d.ok || !l.ok) throw Error('Could not load cricket data.');
    render(await d.json(), await l.json());
  } catch (e) {
    app.textContent = e.message;
  }
}
load();
setInterval(load, 4000);
window.addEventListener('resize', drawBracketConnections);
