const root = document.querySelector('#match'),
  state = document.querySelector('#state');
let currentMatch = null;
let showingSponsor = false;
let rotationTimer = null;
let renderedView = '';
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const card = (t) =>
  `<div class="live-team">${t?.logo_url ? `<img src="${esc(t.logo_url)}" alt="${esc(t.team_name)} logo">` : '<img alt="" src="/assets/images/logo.webp">'}${esc(t?.team_name || 'Team to be confirmed')}</div>`;
const idle =
  '<section class="no-match-brand"><img class="xtreme-logo" src="/assets/images/XTREME.png" alt="Xtreme"><span>Presents</span><img class="ronb-logo" src="/assets/images/logo.png" alt="RONB Events"></section>';
function show(content, label = '', hidden = false) {
  root.classList.remove('match-transition');
  void root.offsetWidth;
  root.innerHTML = content;
  root.classList.add('match-transition');
  state.hidden = hidden;
  state.textContent = label;
}
function scheduleRotation() {
  if (rotationTimer || !currentMatch || currentMatch.status !== 'scheduled') return;
  rotationTimer = setTimeout(
    () => {
      rotationTimer = null;
      showingSponsor = !showingSponsor;
      renderCurrent();
      scheduleRotation();
    },
    showingSponsor ? 5000 : 8000,
  );
}
function renderCurrent() {
  const m = currentMatch;
  const matchKey = m ? `${m.id}:${m.status}:${m.version}:${m.home_score}:${m.away_score}` : 'none';
  const viewKey = `${matchKey}:${showingSponsor}`;
  if (viewKey === renderedView) return;
  renderedView = viewKey;
  if (!m || showingSponsor) {
    show(idle, '', true);
    return;
  }
  show(
    `<section class="live-card"><div class="sport">Futsal</div><div class="group">${m.stage === 'group' ? `Group ${m.group_code}` : m.stage}</div><div class="live-teams">${card(m.home_team)}<div class="score">${m.status === 'scheduled' ? '—' : `${m.home_score} – ${m.away_score}`}</div>${card(m.away_team)}</div></section>`,
    m.status === 'live' ? 'Live' : 'Upcoming match',
  );
}
async function load() {
  try {
    const r = await fetch('/futsal/live');
    if (!r.ok) throw Error('Could not load match.');
    const m = await r.json();
    currentMatch = m;
    if (!m || m.status !== 'scheduled') {
      showingSponsor = false;
      if (rotationTimer) clearTimeout(rotationTimer);
      rotationTimer = null;
    }
    renderCurrent();
    if (!rotationTimer) scheduleRotation();
  } catch (e) {
    root.textContent = e.message;
  }
}
load();
setInterval(load, 4000);
