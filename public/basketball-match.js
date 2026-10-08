const root = document.querySelector('#match'),
  state = document.querySelector('#state');
let currentMatch = null;
let renderedView = '';
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
// Shown whenever no match is running: the sponsor rotation the organizers
// project between matches.
const idle =
  '<section class="no-match-brand"><img class="xtreme-logo" src="/assets/images/XTREME.png" alt="Xtreme"><span>Presents</span><img class="ronb-logo" src="/assets/images/logo.png" alt="RONB Events"></section>';
function show(html, label = '', hidden = false) {
  root.classList.remove('match-transition');
  void root.offsetWidth;
  root.innerHTML = html;
  root.classList.add('match-transition');
  state.hidden = hidden;
  state.textContent = label;
  // The label is the only child of the eyebrow line, so hide the line too and
  // keep the sponsor screen centred without a gap above it.
  state.parentElement.hidden = hidden;
}
function renderCurrent() {
  // Only a live match reaches this page, so anything else means the sponsor screen.
  const m = currentMatch?.status === 'live' ? currentMatch : null;
  // The scorer credit is part of the key: a player assignment does not move the
  // score or the version, and the line below the team name still has to update.
  const credit = m
    ? [...(m.home_scorers ?? []), ...(m.away_scorers ?? [])]
        .map((s) => `${s.player_id}:${s.points}`)
        .join('/')
    : '';
  const viewKey = m ? `${m.id}:${m.version}:${m.home_score}:${m.away_score}:${credit}` : 'sponsor';
  if (viewKey === renderedView) return;
  renderedView = viewKey;
  if (!m) {
    // The sponsor rotation is projected between matches, so the motif frame is
    // dropped here and only returns while a match is actually running.
    document.body.classList.remove('match-is-live');
    show(idle, '', true);
    return;
  }
  document.body.classList.add('match-is-live');
  // Each scorer keeps the points they were credited with, so the big screen reads
  // name and contribution together under the team.
  const team = (t, scorers) =>
    `<div class="live-team"><img src="${esc(t?.logo_url || '/assets/images/logo.webp')}" alt="">${esc(t?.team_name || 'Team to be confirmed')}${scorers?.length ? `<div class="live-scorers">${scorers.map((s) => `<span class="live-scorer">${esc(s.player_name)}<b>${s.points}</b></span>`).join('')}</div>` : ''}</div>`;
  const stage = m.stage === 'group' ? `Group ${esc(m.group_code)}` : esc(m.stage);
  show(
    `<section class="live-card"><div class="sport">Basketball</div><div class="group">${stage}</div><div class="live-teams">${team(m.home_team, m.home_scorers)}<div class="score">${m.home_score} – ${m.away_score}</div>${team(m.away_team, m.away_scorers)}</div></section>`,
    'Live',
  );
}
let poll = 4000;
let lastKey = '';
async function load() {
  try {
    const r = await fetch('/basketball/live');
    if (!r.ok) throw Error('Could not load match.');
    currentMatch = await r.json();
    renderCurrent();
    const key = currentMatch?.status === 'live'
      ? `${currentMatch.id}:${currentMatch.version}:${currentMatch.home_score}:${currentMatch.away_score}`
      : 'sponsor';
    if (key !== lastKey) {
      lastKey = key;
      poll = 4000;
    } else {
      poll = Math.min(poll * 1.5, 15000);
    }
  } catch (e) {
    poll = Math.min(poll * 1.5, 15000);
    root.textContent = e.message;
  } finally {
    setTimeout(load, poll);
  }
}
load();
