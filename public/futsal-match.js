const root = document.querySelector('#match'),
  state = document.querySelector('#state');
let currentMatch = null;
let renderedView = '';
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const card = (t) =>
  `<div class="live-team">${t?.logo_url ? `<img src="${esc(t.logo_url)}" alt="${esc(t.team_name)} logo">` : '<img alt="" src="/assets/images/logo.webp">'}${esc(t?.team_name || 'Team to be confirmed')}</div>`;
// Shown whenever no match is running: the sponsor rotation the organizers
// project between matches.
const idle =
  '<section class="no-match-brand"><img class="xtreme-logo" src="/assets/images/XTREME.png" alt="Xtreme"><span>Presents</span><img class="ronb-logo" src="/assets/images/logo.png" alt="RONB Events"></section>';
function show(content, label = '', hidden = false) {
  root.classList.remove('match-transition');
  void root.offsetWidth;
  root.innerHTML = content;
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
  const viewKey = m ? `${m.id}:${m.version}:${m.home_score}:${m.away_score}` : 'sponsor';
  if (viewKey === renderedView) return;
  renderedView = viewKey;
  if (!m) {
    show(idle, '', true);
    return;
  }
  const stage = m.stage === 'group' ? `Group ${esc(m.group_code)}` : esc(m.stage);
  show(
    `<section class="live-card"><div class="sport">Futsal</div><div class="group">${stage}</div><div class="live-teams">${card(m.home_team)}<div class="score">${m.home_score} – ${m.away_score}</div>${card(m.away_team)}</div></section>`,
    'Live',
  );
}
async function load() {
  try {
    const r = await fetch('/futsal/live');
    if (!r.ok) throw Error('Could not load match.');
    currentMatch = await r.json();
    renderCurrent();
  } catch (e) {
    root.textContent = e.message;
  }
}
load();
setInterval(load, 4000);
