const root = document.querySelector('#match');
const state = document.querySelector('#state');
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const idle =
  '<section class="no-match-brand"><img class="xtreme-logo" src="/assets/images/XTREME.png" alt="Xtreme"><span>Presents</span><img class="ronb-logo" src="/assets/images/logo.png" alt="RONB Events"></section>';
function show(html, label = '', hidden = false) {
  root.innerHTML = html;
  state.hidden = hidden;
  state.textContent = label;
}
async function load() {
  try {
    const r = await fetch('/basketball/live');
    if (!r.ok) throw Error('Could not load match.');
    const m = await r.json();
    if (!m) return show(idle, '', true);
    const card = (t) =>
      `<div class="live-team"><img src="${esc(t?.logo_url || '/assets/images/logo.webp')}" alt="">${esc(t?.team_name || 'Team to be confirmed')}</div>`;
    show(
      `<section class="live-card"><div class="group">${m.stage === 'group' ? `Group ${esc(m.group_code)}` : esc(m.stage)}</div><div class="live-teams">${card(m.home_team)}<div class="score">${m.status === 'scheduled' ? '—' : `${m.home_score} – ${m.away_score}`}</div>${card(m.away_team)}</div></section>`,
      m.status === 'live' ? 'Live' : 'Upcoming match',
    );
  } catch (e) {
    root.textContent = e.message;
  }
}
load();
setInterval(load, 4000);
