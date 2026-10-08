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
        .map((s) => `${s.player_id}:${s.runs}`)
        .join('/')
    : '';
  const wicketCredit = m
    ? [...(m.home_bowlers ?? []), ...(m.away_bowlers ?? [])]
        .map((w) => `${w.player_id}:${w.wickets}`)
        .join('/')
    : '';
  const viewKey = m
    ? `${m.id}:${m.version}:${m.home_score}:${m.away_score}:${m.home_wickets}:${m.away_wickets}:${m.home_overs}:${m.away_overs}:${m.batting_side}:${credit}:${wicketCredit}`
    : 'sponsor';
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
  // Each scorer keeps the runs they were credited with, so the big screen reads
  // name and contribution together under the team. The bowler line does the same
  // for the wickets, marked broadcast style — a bold W with the count, as the
  // TV score graphic prints a wicket — to keep the two numbers apart.
  // Each side also carries its own innings — runs, wickets and overs — beneath
  // its crest: one combined line is ~10.6em of display type, far too wide to sit
  // between the crests without pushing one of them off the frame.
  // The role line names the side in to bat and the side in the field, tagged with
  // the bat and the ball; the innings break flips it.
  const batIcon =
    '<svg class="role-icon role-bat" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><g transform="rotate(45 12 12)"><rect x="10.7" y="1.5" width="2.6" height="7.2" rx="1.3"/><rect x="9" y="8.2" width="6" height="14.3" rx="2.6"/></g></svg>';
  const ballIcon =
    '<svg class="role-icon role-ball" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M7.2 6.6c2.6 1.6 2.6 9.2 0 10.8"/></svg>';
  const roleLine = (side) => {
    const batting = m.batting_side === side;
    return `<div class="live-role ${batting ? 'is-batting' : 'is-bowling'}">${batting ? batIcon : ballIcon}<span>${batting ? 'Batting' : 'Bowling'}</span></div>`;
  };
  const team = (t, scorers, bowlers, innings, role) =>
    `<div class="live-team"><img src="${esc(t?.logo_url || '/assets/images/logo.webp')}" alt="">${esc(t?.team_name || 'Team to be confirmed')}${role}<div class="live-innings">${innings}</div>${scorers?.length ? `<div class="live-scorers">${scorers.map((s) => `<span class="live-scorer">${esc(s.player_name)}<b>${s.runs}</b></span>`).join('')}</div>` : ''}${bowlers?.length ? `<div class="live-bowlers">${bowlers.map((w) => `<span class="live-bowler">${esc(w.player_name)}<b>W${w.wickets}</b></span>`).join('')}</div>` : ''}</div>`;
  const stage = m.stage === 'group' ? `Group ${esc(m.group_code)}` : esc(m.stage);
  // The full line reads both innings — runs, wickets and the overs faced — so
  // the projected card and the printed report never disagree; here each half
  // lives with the team it belongs to.
  const innings = (runs, wickets, overs) =>
    `${runs}/${wickets} (${Number(overs).toFixed(1)})`;
  show(
    `<section class="live-card"><div class="sport">Cricksal</div><div class="group">${stage}</div><div class="live-teams">${team(m.home_team, m.home_scorers, m.home_bowlers, innings(m.home_score, m.home_wickets, m.home_overs), m.batting_side ? roleLine('home') : '')}${team(m.away_team, m.away_scorers, m.away_bowlers, innings(m.away_score, m.away_wickets, m.away_overs), m.batting_side ? roleLine('away') : '')}</div></section>`,
    'Live',
  );
}
async function load() {
  try {
    const r = await fetch('/cricket/live');
    if (!r.ok) throw Error('Could not load match.');
    currentMatch = await r.json();
    renderCurrent();
  } catch (e) {
    root.textContent = e.message;
  }
}
load();
setInterval(load, 4000);
