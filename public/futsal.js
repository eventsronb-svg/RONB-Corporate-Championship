const app = document.querySelector('#app');
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );

function team(value) {
  return value
    ? `<span class="team">${value.logo_url ? `<img class="logo" src="${esc(value.logo_url)}" alt="">` : ''}${esc(value.team_name)}</span>`
    : '<span class="team team-pending">TBD</span>';
}

function fixture(match, by) {
  return `<div class="fixture"><span>${team(by.get(match.home_team_id))}</span><b>${match.status === 'scheduled' ? '—' : `${match.home_score} – ${match.away_score}`}</b><span>${team(by.get(match.away_team_id))}</span></div>`;
}

function bracketTeam(value) {
  return `<span class="bracket-logo"><img class="logo" src="${esc(value?.logo_url || '/assets/images/logo.webp')}" alt="${esc(value?.team_name || 'Team to be confirmed')} logo"></span>`;
}

function bracketMatch(match, by) {
  const score = (value) => (match.status === 'scheduled' ? '—' : value);
  const resultClass = (teamId) =>
    match.status !== 'completed' || !match.winner_team_id
      ? ''
      : teamId === match.winner_team_id
        ? ' bracket-winner'
        : ' bracket-loser';
  return `<article class="bracket-match"><div class="bracket-pair"><span class="${resultClass(match.home_team_id)}">${bracketTeam(by.get(match.home_team_id))}</span><b>${score(match.home_score)} – ${score(match.away_score)}</b><span class="${resultClass(match.away_team_id)}">${bracketTeam(by.get(match.away_team_id))}</span></div></article>`;
}

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
      for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
        const first = sources[targetIndex * 2];
        const second = sources[targetIndex * 2 + 1];
        const target = targets[targetIndex];
        if (!first || !second || !target) continue;
        const a = point(first);
        const b = point(second);
        const destination = point(target);
        const midpoint = (a.right + destination.left) / 2;
        line(a.right, a.y, midpoint, a.y);
        line(b.right, b.y, midpoint, b.y);
        line(midpoint, a.y, midpoint, b.y);
        line(midpoint, destination.y, destination.left, destination.y);
      }
    } else {
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const source = sources[sourceIndex];
        const first = targets[sourceIndex * 2];
        const second = targets[sourceIndex * 2 + 1];
        if (!source || !first || !second) continue;
        const origin = point(source);
        const a = point(first);
        const b = point(second);
        const midpoint = (origin.left + a.right) / 2;
        line(origin.left, origin.y, midpoint, origin.y);
        line(midpoint, a.y, midpoint, b.y);
        line(midpoint, a.y, a.right, a.y);
        line(midpoint, b.y, b.right, b.y);
      }
    }
  }
}

function ongoing(match) {
  if (!match || !['live', 'scheduled'].includes(match.status)) return '';
  const side = (value) =>
    `<div class="ongoing-side"><img src="${esc(value?.logo_url || '/assets/images/logo.webp')}" alt="${esc(value?.team_name || 'Team')} logo"><strong>${esc(value?.team_name || 'Team')}</strong></div>`;
  const label = match.status === 'live' ? 'Live now' : 'Upcoming match';
  const stage = match.stage === 'group' ? `Group ${esc(match.group_code)}` : esc(match.stage);
  const score = match.status === 'live' ? `${match.home_score} – ${match.away_score}` : '—';
  return `<section class="ongoing-match"><p>${label} · ${stage}</p><div class="ongoing-scoreboard">${side(match.home_team)}<b>${score}</b>${side(match.away_team)}</div></section>`;
}

function render(data, live) {
  const by = new Map(data.teams.map((value) => [value.id, value]));
  const groupMatches = data.groups.flatMap((group) => group.matches);
  const groupsDone =
    groupMatches.length > 0 && groupMatches.every((match) => match.status === 'completed');
  const bracketGenerated = data.bracket.length > 0;
  const groups = data.groups
    .map((group) => {
      const groupDone =
        group.matches.length > 0 && group.matches.every((match) => match.status === 'completed');
      return `<section class="panel"><h2>Group ${esc(group.code)}</h2><div class="scroll"><table><thead><tr><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th></tr></thead><tbody>${group.table.map((value) => `<tr class="${groupDone && value.position <= 2 ? 'qualified-team' : ''}"><td><span class="standing-team"><b>${value.position}.</b>${team(value)}</span></td><td>${value.played}</td><td>${value.wins}</td><td>${value.draws}</td><td>${value.losses}</td><td>${value.goals_for}</td><td>${value.goals_against}</td><td>${value.goal_difference}</td><td><b>${value.points}</b></td></tr>`).join('')}</tbody></table></div><h3>Fixtures</h3>${group.matches.map((match) => fixture(match, by)).join('') || '<p>No fixtures yet.</p>'}</section>`;
    })
    .join('');
  const rounds = (stage, label, predicate, reverse = false) => {
    const matches = data.bracket.filter((match) => match.stage === stage && predicate(match));
    if (reverse) matches.reverse();
    return `<div class="bracket-round"><h3>${label}</h3><div class="bracket-matches">${
      matches.map((match) => bracketMatch(match, by)).join('') ||
      '<p class="bracket-pending">Pending</p>'
    }</div></div>`;
  };
  const bracket = [
    rounds('prequarter', 'Pre-quarterfinals', (match) => match.bracket_position <= 4),
    rounds('quarter', 'Quarterfinals', (match) => match.bracket_position <= 2),
    rounds('semi', 'Semifinals', (match) => match.bracket_position === 1),
    rounds('final', 'Final', () => true),
    rounds('semi', 'Semifinals', (match) => match.bracket_position === 2),
    rounds('quarter', 'Quarterfinals', (match) => match.bracket_position > 2, true),
    rounds('prequarter', 'Pre-quarterfinals', (match) => match.bracket_position > 4, true),
  ].join('');
  const groupsView = groupsDone
    ? `<details class="group-stage"><summary><span>Group stage complete</span><span>${data.groups.length} tables · ${groupMatches.length} matches</span></summary><div class="groups">${groups}</div></details>`
    : `<div class="groups">${groups}</div>`;
  const bracketView =
    groupsDone && bracketGenerated
      ? `<section class="stage bracket-stage"><h2>Match bracket</h2><div class="bracket"><svg class="bracket-connections" aria-hidden="true"></svg>${bracket}</div></section>`
      : '';
  app.innerHTML = `${ongoing(live)}${bracketView}${groupsView}`;
  drawBracketConnections();
}

async function load() {
  try {
    const [dataResponse, liveResponse] = await Promise.all([
      fetch('/futsal/data'),
      fetch('/futsal/live'),
    ]);
    if (!dataResponse.ok || !liveResponse.ok) throw Error('Could not load the championship.');
    render(await dataResponse.json(), await liveResponse.json());
  } catch (error) {
    app.textContent = error.message;
  }
}

load();
setInterval(load, 4000);
window.addEventListener('resize', drawBracketConnections);
