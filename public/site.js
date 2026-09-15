const main = document.querySelector('#main');
const toast = document.querySelector('#toast');
let data;

const esc = (value = '') =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const api = async (path, options = {}) => {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || 'The request could not be completed.');
  return payload;
};
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });
const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
const say = (message) => {
  toast.textContent = message;
  toast.hidden = false;
  window.setTimeout(() => {
    toast.hidden = true;
  }, 4200);
};
const displayDate = () => 'OCT 01—04 / 2026';
const e = (title, body) =>
  `<div class="error-view"><p class="eyebrow">System notice</p><h1>${esc(title)}</h1><p>${esc(body)}</p><a class="button primary" href="/">Return home</a></div>`;

async function load() {
  const response = await fetch('/assets/championship.json');
  if (!response.ok) throw new Error('Event information is unavailable.');
  data = await response.json();
}
function sectionHeader(eyebrow, title, copy) {
  return `<div class="section-header"><div><p class="eyebrow">${esc(eyebrow)}</p><h2 class="section-title">${esc(title)}</h2></div><p class="section-intro">${esc(copy)}</p></div>`;
}
function home() {
  document.title = `${data.title} ${data.edition}`;
  main.innerHTML = `
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="kicker hero-kicker"><span class="pulse" aria-hidden="true"></span> Registration bulletin / ${esc(data.edition)}</p>
        <h1 class="hero-title" id="hero-title">Corporate<span>Championship</span></h1>
        <p class="hero-sub">Four days. One workplace rivalry. Three formats built for the teams you already trust.</p>
        <div class="hero-meta"><div><span>Dates</span><strong>Oct 01—04</strong></div><div><span>Host ground</span><strong>Royal Sports Park</strong></div><div><span>Location</span><strong>Chunikhel</strong></div></div>
      </div>
      <div class="hero-image"><img src="/assets/images/futsal-hero.png" alt="Futsal players contesting a ball on an outdoor court" /><span class="image-stamp">Field report / Futsal</span></div>
    </section>
    <section class="section" id="sports">${sectionHeader('01 / Sport formats', 'Choose your court', 'Register one company team per format. Details that affect your registration, including fees, are shown once your organizer has configured them.')}<div class="sport-grid">${data.sports.map((sport, index) => `<a class="sport" href="/register?focus=${encodeURIComponent(sport.slug)}"><span class="sport-index">0${index + 1} / ${esc(sport.format)}</span><h3>${esc(sport.name)}</h3><span class="sport-format">${esc(sport.format)}</span><p>${esc(sport.description)}</p><span class="sport-arrow" aria-hidden="true">↘</span></a>`).join('')}</div></section>
    <section class="section" id="teams">${sectionHeader('02 / Team register', 'Who is in', 'Payment-confirmed teams appear here after their captain has completed the team profile.')}<div class="teams-shell"><div class="team-tabs" role="tablist" aria-label="Team sports">${data.sports.map((sport, index) => `<button role="tab" id="tab-${sport.slug}" aria-controls="teams-panel" aria-selected="${index === 0}" data-sport="${esc(sport.name)}">${esc(sport.name)}</button>`).join('')}</div><div class="team-list" id="teams-panel" role="tabpanel" aria-live="polite"><p class="teams-state">Loading confirmed teams…</p></div></div></section>
    <section class="section" id="venue">${sectionHeader('03 / Site coordinates', 'Play here', 'Royal Sports Park is the championship ground. Open the map for directions from wherever your team starts.')}<div class="venue"><div class="venue-copy"><p class="eyebrow">Venue / ${esc(data.locality)}</p><h2>${esc(data.venue)}</h2><p>${esc(data.locality)}, Kathmandu. Bring your team, arrive ready, and follow the organizer’s match instructions on the day.</p><a class="button primary" href="${esc(data.maps_url)}" target="_blank" rel="noreferrer">Open directions <span aria-hidden="true">↗</span></a></div><div class="venue-map"><p class="coordinates">Royal Sports Park<br>27.7541549 N / 85.363512 E<br>Championship ground</p><div class="map-mark" aria-hidden="true">+</div></div></div></section>
    <section class="section" id="faq">${sectionHeader('04 / Field notes', 'Before you register', 'The information below covers the registration process. Sport-specific rules and fees are controlled by the organizer.')}<div class="faq"><details><summary>Can a company enter more than one sport?</summary><p>Yes. A captain can select every available sport in one registration, then supplies a separate team name and profile for each sport.</p></details><details><summary>When does a team show publicly?</summary><p>After payment is confirmed by the organizer and the captain completes the logo and roster for that sport.</p></details><details><summary>How does payment work?</summary><p>The registration flow issues the exact amount, a payment code, and instructions. Upload the receipt after transfer. An organizer verifies it before team profiles unlock.</p></details><details><summary>Where can I get directions?</summary><p>Use the Royal Sports Park directions link above. It opens the organizer-provided Google Maps location.</p></details></div></section>`;
  bindTeamTabs();
}
async function teamList(name) {
  const panel = document.querySelector('#teams-panel');
  panel.innerHTML = '<p class="teams-state">Loading confirmed teams…</p>';
  try {
    const sports = await api('/sports');
    const selected = sports.find((sport) => sport.name.toLowerCase() === name.toLowerCase());
    if (!selected) {
      panel.innerHTML = `<p class="teams-state">${esc(name)} registrations will appear here once the sport is opened by the organizer.</p>`;
      return;
    }
    const teams = await api(`/teams?sport_id=${encodeURIComponent(selected.id)}`);
    panel.innerHTML = teams.length
      ? teams
          .map(
            (team) =>
              `<article class="team">${team.logo_url ? `<img class="team-logo" src="${esc(team.logo_url)}" alt="${esc(team.team_name)} logo" />` : ''}<h3 class="team-name">${esc(team.team_name)}</h3><p class="team-meta">${esc(team.players.length ? `${team.players.length} listed player${team.players.length === 1 ? '' : 's'}` : 'Team profile complete')}</p></article>`,
          )
          .join('')
      : `<p class="teams-state">No confirmed ${esc(name)} teams are listed yet.</p>`;
  } catch {
    panel.innerHTML =
      '<p class="teams-state">Team listings are temporarily unavailable. Please try again later.</p>';
  }
}
function bindTeamTabs() {
  document.querySelectorAll('[role=tab]').forEach((tab) =>
    tab.addEventListener('click', () => {
      document
        .querySelectorAll('[role=tab]')
        .forEach((item) => item.setAttribute('aria-selected', String(item === tab)));
      teamList(tab.dataset.sport);
    }),
  );
  teamList(data.sports[0].name);
}
function steps(active) {
  const values = ['Sports', 'Contact', 'Payment', 'Receipt', 'Team profile'];
  return `<ol class="steps">${values.map((value) => `<li class="${value === active ? 'active' : ''}">${esc(value)}</li>`).join('')}</ol>`;
}
async function register() {
  document.title = `Register · ${data.title}`;
  main.innerHTML = `<div class="page-register"><header class="registration-header"><p class="eyebrow">Registration terminal / ${displayDate()}</p><h1>Build your<br>team</h1></header><div class="registration-layout"><aside class="registration-aside"><a href="/">← Back to championship</a>${steps('Sports')}</aside><section class="registration-content" id="registration-content"><p class="loading">Checking registration status…</p></section></div></div>`;
  try {
    const order = await api('/orders/current');
    if (order) return resume(order);
  } catch (error) {
    if (!String(error.message).includes('Sign in')) throw error;
  }
  renderLogin();
}
function renderLogin() {
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<p class="eyebrow">Captain access</p><h2>Start with your Google account</h2><p>Sign in to create a registration. Your order is saved to your account so you can return at any point.</p><div class="form-actions"><a class="button primary" href="/auth/google">Sign in with Google <span aria-hidden="true">↗</span></a></div>`;
}
async function resume(order) {
  const target = document.querySelector('#registration-content');
  const status = order.resume_step;
  if (status === 'sports') return sportsStep(order);
  if (status === 'invoice') return phoneStep(order);
  if (status === 'payment') return paymentStep(order);
  if (status === 'receipt') return receiptStep(order);
  if (status === 'awaiting_review') return waitingStep(order);
  if (status === 'team_profile') return profileStep(order);
  if (status === 'registered') return doneStep(order);
  target.innerHTML = `<p class="eyebrow">Order status</p><h2>${esc(status)}</h2><p>This registration cannot continue in its current state. Return to the event page or contact the organizer.</p><a class="button" href="/">Return home</a>`;
}
async function sportsStep(order) {
  const target = document.querySelector('#registration-content');
  const sports = await api('/sports');
  const selected = new Map(order.items.map((item) => [item.sport_id, item.team_name]));
  target.innerHTML = `<p class="eyebrow">Step 01 / Formats</p><h2>Select your teams</h2><p>Each sport requires a distinct team name. You can change this selection before the invoice is issued.</p><form id="sports-form"><div class="choice-list">${sports.length ? sports.map((sport) => `<div class="sport-choice"><input type="checkbox" id="sport-${sport.id}" name="sport" value="${sport.id}" ${selected.has(sport.id) ? 'checked' : ''}><label for="sport-${sport.id}"><strong>${esc(sport.name)}</strong><span>${sport.price} registration amount</span><input data-team="${sport.id}" aria-label="${esc(sport.name)} team name" value="${esc(selected.get(sport.id) || '')}" placeholder="Team name" maxlength="120"></label></div>`).join('') : '<p class="teams-state">No sports are open yet. Ask the organizer to add the championship formats.</p>'}</div><p class="error" id="form-error" hidden></p><div class="form-actions"><button class="button primary" ${sports.length ? '' : 'disabled'}>Continue to contact <span aria-hidden="true">↘</span></button></div></form>`;
  document.querySelector('#sports-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const picks = [...document.querySelectorAll('input[name=sport]:checked')].map((input) => ({
      sport_id: input.value,
      team_name: document.querySelector(`[data-team="${input.value}"]`).value.trim(),
    }));
    const error = document.querySelector('#form-error');
    if (!picks.length || picks.some((pick) => !pick.team_name)) {
      error.textContent = 'Select at least one format and give every selected team a name.';
      error.hidden = false;
      return;
    }
    try {
      const next = await patch(`/orders/${order.id}/sports`, { sports: picks });
      resume(next);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });
}
function phoneStep(order) {
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<p class="eyebrow">Step 02 / Contact</p><h2>Where can we reach the captain?</h2><p>Use the phone number the organizer should use for registration questions.</p><form id="phone-form" class="form-stack"><label class="input-group">Phone number<input name="phone" required inputmode="tel" value="${esc(order.phone_number || '')}" placeholder="+977 9800000000"></label><p class="error" hidden></p><div class="form-actions"><button class="button primary">Issue invoice <span aria-hidden="true">↘</span></button></div></form>`;
  document.querySelector('#phone-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('.error');
    try {
      const phone = await post(`/orders/${order.id}/phone`, {
        phone_number: new FormData(form).get('phone'),
      });
      const invoice = await post(`/orders/${order.id}/invoice`);
      resume(invoice || phone);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });
}
async function paymentStep(order) {
  const target = document.querySelector('#registration-content');
  const payment = await post(`/orders/${order.id}/payment-request`);
  target.innerHTML = `<p class="eyebrow">Step 03 / Payment</p><h2>Transfer ${esc(order.total_amount)}</h2><p>Use the payment details below. Put the unique code in the transfer remarks exactly as shown.</p><div class="info-box"><strong>Amount: ${esc(order.total_amount)}</strong><br>Remarks code: <code>${esc(payment.unique_code)}</code><br>Expires: ${new Date(payment.expires_at).toLocaleString()}</div><img class="qr" src="${esc(payment.qr_data_url)}" alt="Payment QR code"><p>${esc(payment.instructions)}</p><div class="form-actions"><button class="button primary" id="receipt-next">I have paid, upload receipt <span aria-hidden="true">↘</span></button></div>`;
  document
    .querySelector('#receipt-next')
    .addEventListener('click', () => receiptStep({ ...order, status: 'payment_pending' }));
}
function receiptStep(order) {
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<p class="eyebrow">Step 04 / Receipt</p><h2>Upload proof of payment</h2><p>Send a clear PNG, JPEG, WebP, or PDF receipt, up to 5 MB. The organizer will review it alongside your exact amount and code.</p><form id="receipt-form" class="form-stack"><label class="input-group">Receipt file<input name="receipt" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" required></label><p class="error" hidden></p><div class="form-actions"><button class="button primary">Submit receipt <span aria-hidden="true">↗</span></button></div></form>`;
  document.querySelector('#receipt-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('.error');
    const payload = new FormData(form);
    try {
      const response = await fetch(`/orders/${order.id}/receipt`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Origin: location.origin },
        body: payload,
      });
      const next = await response.json();
      if (!response.ok) throw new Error(next.message);
      resume(next);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });
}
function waitingStep(order) {
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<p class="eyebrow">Payment review / ${esc(order.status)}</p><h2>Receipt received</h2><p>Your receipt is with the organizer. This page checks for an update every 20 seconds.</p>${order.rejection ? `<p class="error">Latest note: ${esc(order.rejection.notes)}</p><div class="form-actions"><button class="button primary" id="resubmit">Upload another receipt</button></div>` : '<div class="info-box">You can leave now. The order is saved and will resume here after sign in.</div>'}`;
  document.querySelector('#resubmit')?.addEventListener('click', () => receiptStep(order));
  const interval = setInterval(async () => {
    if (!location.pathname.startsWith('/register')) return clearInterval(interval);
    try {
      const next = await api(`/orders/${order.id}/status`);
      if (next.status !== order.status) {
        clearInterval(interval);
        resume(next);
        say('Your registration status changed.');
      }
    } catch {}
  }, 20000);
}
function profileStep(order) {
  const target = document.querySelector('#registration-content');
  const pending = order.items.filter((item) => !item.profile_completed_at);
  target.innerHTML = `<p class="eyebrow">Step 05 / Team profile</p><h2>Finish your team</h2><p>Payment is confirmed. Add a logo and roster for each team. A confirmed team appears on the public listing after you mark its profile done.</p><div class="choice-list">${pending.map((item) => `<div class="sport-choice"><div><strong>${esc(item.team_name)}</strong><span>${esc(item.sport_name)}</span></div><a class="button primary" href="#profile/${item.id}">Complete profile ↘</a></div>`).join('')}</div>`;
  window.addEventListener(
    'hashchange',
    () => {
      const itemId = location.hash.split('/')[1];
      if (itemId) profileEditor(order, itemId);
    },
    { once: true },
  );
  const itemId = location.hash.split('/')[1];
  if (itemId) profileEditor(order, itemId);
}
function profileEditor(order, itemId) {
  const item = order.items.find((candidate) => candidate.id === itemId);
  if (!item) return;
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<p class="eyebrow">${esc(item.sport_name)} / Team profile</p><h2>${esc(item.team_name)}</h2><form id="profile-form" class="form-stack"><label class="input-group">Team logo<input name="logo" type="file" accept="image/png,image/jpeg,image/webp"></label><label class="input-group">Players, one name per line<input name="players" required value="${esc(item.players.join('\n'))}" placeholder="Player one&#10;Player two"></label><p class="error" hidden></p><div class="form-actions"><button class="button" name="save" value="save">Save draft</button><button class="button primary" name="complete" value="complete">Save and mark done</button></div></form>`;
  document.querySelector('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const action = event.submitter.value;
    const error = form.querySelector('.error');
    const fd = new FormData(form);
    const players = String(fd.get('players'))
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);
    const update = new FormData();
    if (fd.get('logo').size) update.append('logo', fd.get('logo'));
    update.append('players', JSON.stringify(players));
    try {
      const response = await fetch(`/orders/${order.id}/items/${item.id}/profile`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { Origin: location.origin },
        body: update,
      });
      const saved = await response.json();
      if (!response.ok) throw new Error(saved.message);
      if (action === 'complete') {
        const complete = await post(`/orders/${order.id}/items/${item.id}/profile/complete`);
        const current = await api(`/orders/${order.id}/status`);
        resume(current || complete);
        say('Team profile completed.');
      } else {
        say('Profile saved.');
      }
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });
}
function doneStep(order) {
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<p class="eyebrow">Registration complete</p><h2>See you at the park.</h2><p>Every team on your order has a completed profile. The confirmation email is sent after the final profile is completed.</p><div class="form-actions"><a class="button primary" href="/">Return to championship</a><a class="button" href="#teams">See team listing</a></div>`;
}
async function render() {
  try {
    if (!data) await load();
    if (location.pathname === '/register') await register();
    else home();
  } catch (error) {
    main.innerHTML = e('Connection lost', error.message);
  }
}
window.addEventListener('popstate', render);
window.addEventListener('hashchange', () => {
  if (location.hash === '#register') {
    history.pushState({}, '', '/register');
    render();
  }
});
render();
