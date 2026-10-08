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
    ? `${m.id}:${m.version}:${m.home_score}:${m.away_score}:${m.home_wickets}:${m.away_wickets}:${m.home_overs}:${m.away_overs}:${credit}:${wicketCredit}`
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
  // for the wickets, marked with a crossed sticker to keep the two apart.
  // Each side also carries its own innings — runs, wickets and overs — beneath
  // its crest: one combined line is ~10.6em of display type, far too wide to sit
  // between the crests without pushing one of them off the frame.
  const team = (t, scorers, bowlers, innings) =>
    `<div class="live-team"><img src="${esc(t?.logo_url || '/assets/images/logo.webp')}" alt="">${esc(t?.team_name || 'Team to be confirmed')}<div class="live-innings">${innings}</div>${scorers?.length ? `<div class="live-scorers">${scorers.map((s) => `<span class="live-scorer">${esc(s.player_name)}<b>${s.runs}</b></span>`).join('')}</div>` : ''}${bowlers?.length ? `<div class="live-bowlers">${bowlers.map((w) => `<span class="live-bowler">${esc(w.player_name)}<b>✕${w.wickets}</b></span>`).join('')}</div>` : ''}</div>`;
  const stage = m.stage === 'group' ? `Group ${esc(m.group_code)}` : esc(m.stage);
  // The full line reads both innings — runs, wickets and the overs faced — so
  // the projected card and the printed report never disagree; here each half
  // lives with the team it belongs to.
  const innings = (runs, wickets, overs) =>
    `${runs}/${wickets} (${Number(overs).toFixed(1)})`;
  show(
    `<section class="live-card"><div class="sport">Cricksal</div><div class="group">${stage}</div><div class="live-teams">${team(m.home_team, m.home_scorers, m.home_bowlers, innings(m.home_score, m.home_wickets, m.home_overs))}${team(m.away_team, m.away_scorers, m.away_bowlers, innings(m.away_score, m.away_wickets, m.away_overs))}</div></section>`,
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
