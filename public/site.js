const main = document.querySelector('#main');
const toast = document.querySelector('#toast');
let data;
let reviewTimer;
let profileOrder;

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
      ...(options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...options.headers,
    },
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : undefined;
  if (!response.ok) {
    const error = new Error(
      payload?.details?.map((issue) => issue.message).join('; ') ||
        payload?.message ||
        (response.status >= 500
          ? 'Registration is temporarily unavailable. Please try again shortly.'
          : 'The request could not be completed.'),
    );
    error.status = response.status;
    error.code = payload?.error;
    throw error;
  }
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
const displayDate = () => 'October 1-4, 2026';
const money = (value) =>
  `${Number(value).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : 2, maximumFractionDigits: 2 })} NPR`;
const slugify = (value) =>
  String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
const e = (title, body) =>
  `<div class="error-view"><p class="eyebrow">System notice</p><h1>${esc(title)}</h1><p>${esc(body)}</p><a class="button primary" href="/">Return home</a></div>`;

async function load() {
  const response = await fetch('/assets/championship.json');
  if (!response.ok) throw new Error('Event information is unavailable.');
  const event = await response.json();
  const sports = (await api('/sports')).map((sport) => ({ ...sport, slug: slugify(sport.name) }));
  data = { ...event, sports };
}
function sectionHeader(eyebrow, title, copy) {
  return `<div class="section-header"><div>${eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : ''}<h2 class="section-title">${esc(title)}</h2></div><p class="section-intro">${esc(copy)}</p></div>`;
}
function sportIcon(sport, className = 'sport-symbol') {
  const slug = sport.slug || slugify(sport.name);
  if (slug === 'crickshal')
    return `<img class="${className}" src="/assets/images/crick.png" alt="" aria-hidden="true" />`;
  const symbols = { futsal: '⚽', basketball: '🏀' };
  return `<span class="${className}" aria-hidden="true">${symbols[slug] || '🏆'}</span>`;
}
function home() {
  document.title = `${data.title} ${data.edition}`;
  main.innerHTML = `
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow">RONB presents · October 2026</p>
        <h1 class="hero-title" id="hero-title">Corporate<br><span>Championship</span></h1>
        <p class="hero-sub">Your colleagues. Your dream team. Four days of sport, connection, and a little friendly competition.</p>
        <div class="hero-actions"><a class="button primary" href="/register">Bring your team</a><a class="button" href="#sports">Find your sport</a></div>
        <p class="hero-note">Out of office. Into the game.</p>
      </div>
    </section>
    <div class="event-strip"><div><span>Save the dates</span><strong>October 1-4, 2026</strong></div><div><span>Meet us at</span><strong>Royal Sports Park, Chunikhel</strong></div><div><span>TEAM UP & TURN UP</span><strong>Ready to Bring the Heat?</strong></div></div>
    <section class="section" id="sports">${sectionHeader('A game for your team', 'Good colleagues. Great teammates.', 'Pick your sport, rally your people, and give the office something new to talk about.')}<div class="sport-grid">${data.sports.map((sport) => `<a class="sport sport-${sport.slug}" href="/register?focus=${encodeURIComponent(sport.slug)}"><div class="sport-top"><span class="sport-format">Open for registration</span></div><h3>${esc(sport.name)}</h3>${sport.description ? `<p>${esc(sport.description)}</p>` : ''}<span class="sport-link">Let's play</span>${sportIcon(sport)}</a>`).join('')}</div><p class="section-note">Registration fees and available places are shown when you sign in.</p></section>
    <section class="team-story section"><p class="eyebrow">Better together</p><h2>A different kind<br>of team meeting.</h2><p>Swap the meeting room for the court. Cheer for your colleagues, meet other company teams, and make memories beyond the workday.</p><a class="button" href="/register">Make your company part of it</a></section>
    <section class="section" id="teams">${sectionHeader('', 'Meet the teams', 'Your next friendly rivals. Confirmed teams appear here once their captain completes the team profile.')}<div class="teams-shell"><div class="team-tabs" role="tablist" aria-label="Team sports">${data.sports.map((sport, index) => `<button role="tab" id="tab-${sport.slug}" aria-label="${esc(sport.name)}" aria-controls="teams-panel" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" data-sport="${esc(sport.name)}" data-slug="${sport.slug}" ${sport.max_teams ? `data-max="${sport.max_teams}"` : ''}>${esc(sport.name)}</button>`).join('')}</div><div class="team-list" id="teams-panel" role="tabpanel" aria-labelledby="tab-${data.sports[0]?.slug || ''}" aria-live="polite"><p class="teams-state">Loading confirmed teams…</p></div></div></section>
    <section class="section venue-section" id="venue"><img class="venue-date" src="/assets/images/calendar.png" alt="See you in October 01 to 04 2026 · Chunikhel, Kathmandu" width="1536" height="1024" /><div class="venue-copy"><p class="eyebrow">Room to play. Reasons to stay.</p><h2>${esc(data.venue)}</h2><p>Four days of team spirit at ${esc(data.locality)}. Get your colleagues together and meet us on the court.</p><a class="button primary" href="${esc(data.maps_url)}" target="_blank" rel="noreferrer">Open directions</a></div><div class="venue-map"><iframe title="Royal Sports Park location on Google Maps" src="${esc(data.maps_embed_url)}" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe><p>Royal Sports Park, Chunikhel · <a href="${esc(data.maps_url)}" target="_blank" rel="noreferrer">View larger map and directions ↗</a></p></div></section>
    <section class="section faq-section" id="faq">${sectionHeader('A little pre-game prep', 'Good questions', 'Everything you need to get your team started.')}<div class="faq"><details><summary>Can a company enter more than one sport?</summary><p>Yes. A captain can select every available sport in one registration, use one company name across all selected sports, then complete a roster and profile for each sport.</p></details><details><summary>When does a team show publicly?</summary><p>After payment is confirmed by the organizer and the captain completes the logo and roster for that sport.</p></details><details><summary>How does payment work?</summary><p>Your registration includes the exact amount, a payment code, and instructions. Upload your receipt after transfer. An organizer verifies it before team profiles unlock.</p></details><details><summary>Where can I get directions?</summary><p>Use the Royal Sports Park directions link above. It opens the organizer-provided Google Maps location.</p></details></div></section>
    <section class="closing section"><p class="eyebrow">The best teams play together</p><h2>Bring your people.<br>We'll bring the occasion.</h2><a class="button primary" href="/register">Register your team</a></section>`;
  bindTeamTabs();
  const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (motion && 'IntersectionObserver' in window) {
    const motionTargets = document.querySelectorAll(
      '.section-header, .sport, .section-note, .team-story > *, .teams-shell, .venue-date, .venue-copy, .faq details, .closing > *',
    );
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: '0px 0px -8% 0px' },
    );
    motionTargets.forEach((element, index) => {
      element.classList.add('reveal');
      element.style.setProperty('--reveal-delay', `${(index % 4) * 80}ms`);
      observer.observe(element);
    });
  }
}
let teamRequest = 0;
async function teamList(name) {
  const panel = document.querySelector('#teams-panel');
  const requestId = ++teamRequest;
  panel.classList.add('switching');
  const swap = async (html) => {
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (requestId !== teamRequest) return;
    panel.innerHTML = html;
    panel.classList.remove('switching');
  };
  try {
    const sports = await api('/sports');
    const selected = sports.find((sport) => sport.name.toLowerCase() === name.toLowerCase());
    if (!selected) {
      await swap(
        `<p class="teams-state">${esc(name)} registrations will appear here once the sport is opened by the organizer.</p>`,
      );
      return;
    }
    const teams = await api(`/teams?sport_id=${encodeURIComponent(selected.id)}`);
    if (requestId !== teamRequest) return;
    const tab = [...document.querySelectorAll('[role=tab]')].find(
      (candidate) => candidate.dataset.sport.toLowerCase() === name.toLowerCase(),
    );
    if (tab?.dataset.max) {
      const count = tab.querySelector('.team-count') || document.createElement('span');
      count.className = 'team-count';
      count.id = `count-${selected.id}`;
      count.textContent = `${selected.filled_slots}/${tab.dataset.max}`;
      tab.setAttribute('aria-describedby', count.id);
      if (!count.parentElement) tab.append(count);
    }
    await swap(
      teams.length
        ? teams
            .map(
              (team) =>
                `<article class="team">${team.logo_url ? `<img class="team-logo" src="${esc(team.logo_url)}" alt="${esc(team.team_name)} logo" />` : ''}<h3 class="team-name">${esc(team.team_name)}</h3><p class="team-meta">${esc(team.players.length ? `${team.players.length} listed player${team.players.length === 1 ? '' : 's'}` : 'Team profile complete')}</p></article>`,
            )
            .join('')
        : `<p class="teams-state">No confirmed ${esc(name)} teams are listed yet.</p>`,
    );
  } catch {
    await swap(
      '<p class="teams-state">Team listings are temporarily unavailable. Please try again later.</p>',
    );
  }
}
function setSportColor(tab) {
  const shell = document.querySelector('.teams-shell');
  const sport = data.sports.find((candidate) => candidate.slug === tab?.dataset.slug);
  shell.style.setProperty('--tab-color', sport?.color || 'var(--accent)');
  shell.style.setProperty('--tab-dark', sport?.colorDark || 'var(--accent-hover)');
}
function bindTeamTabs() {
  if (!data.sports.length) {
    document.querySelector('.team-tabs').hidden = true;
    const panel = document.querySelector('#teams-panel');
    panel.removeAttribute('aria-labelledby');
    panel.setAttribute('aria-label', 'Teams');
    panel.innerHTML = '<p class="teams-state">No sports are open for registration yet.</p>';
    document.querySelector('.sport-grid').innerHTML =
      '<p>No sports are open for registration yet.</p>';
    return;
  }
  document.querySelectorAll('[role=tab]').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('[role=tab]').forEach((item) => {
        item.setAttribute('aria-selected', String(item === tab));
        item.tabIndex = item === tab ? 0 : -1;
        if (item !== tab) {
          item.querySelector('.team-count')?.remove();
          item.removeAttribute('aria-describedby');
        }
      });
      document.querySelector('#teams-panel').setAttribute('aria-labelledby', tab.id);
      setSportColor(tab);
      teamList(tab.dataset.sport);
    }),
  );
  document.querySelector('.team-tabs').addEventListener('keydown', (event) => {
    const tabs = [...document.querySelectorAll('[role=tab]')];
    const index = tabs.indexOf(document.activeElement);
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  });
  setSportColor(document.querySelector('[role=tab]'));
  teamList(data.sports[0].name);
}
function steps(active) {
  const values = ['Sports', 'Contact', 'Payment', 'Receipt', 'Team profile'];
  return `<ol class="steps">${values.map((value) => `<li class="${value === active ? 'active' : ''}">${esc(value)}</li>`).join('')}</ol>`;
}
async function register() {
  document.title = `Register · ${data.title}`;
  main.innerHTML = `<div class="page-register"><header class="registration-header"><p class="eyebrow">Team registration · ${displayDate()}</p><h1>Register your<br>company</h1></header><div class="registration-layout"><aside class="registration-aside"><a href="/">← Back to championship</a>${steps('Sports')}</aside><section class="registration-content" id="registration-content"><p class="loading">Checking registration status…</p></section></div></div>`;
  try {
    const savedId = new URLSearchParams(location.search).get('order');
    const order = await api(
      savedId ? `/orders/${encodeURIComponent(savedId)}/status` : '/orders/current',
    );
    return await resume(order || (await post('/orders/draft')));
  } catch (error) {
    if (error.status !== 401) throw error;
  }
  renderLogin();
}
function renderLogin() {
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<p class="eyebrow">Captain access</p><h2>Start with your Google account</h2><p>Sign in to create a registration. Your order is saved to your account so you can return at any point.</p><div class="form-actions"><a class="button primary" href="/auth/google">Sign in with Google</a></div>`;
}
async function resume(order) {
  clearTimeout(reviewTimer);
  profileOrder = undefined;
  const url = new URL(location.href);
  url.searchParams.set('order', order.id);
  history.replaceState({}, '', url);
  const target = document.querySelector('#registration-content');
  const status = order.resume_step;
  const activeStep = {
    sports: 'Sports',
    contact: 'Contact',
    invoice: 'Contact',
    payment: 'Payment',
    receipt: 'Receipt',
    awaiting_review: 'Receipt',
    team_profile: 'Team profile',
    registered: 'Team profile',
  }[status];
  document.querySelector('.steps').outerHTML = steps(activeStep);
  if (status === 'sports') return sportsStep(order);
  if (status === 'contact') return phoneStep(order);
  if (status === 'invoice') return phoneStep(order);
  if (status === 'payment') return paymentStep(order);
  if (status === 'receipt') {
    if (order.status === 'rejected') return receiptStep(order);
    if (new Date(order.payment_request?.expires_at).getTime() <= Date.now())
      return expiredStep(order);
    return paymentStep(order);
  }
  if (status === 'awaiting_review') return waitingStep(order);
  if (status === 'team_profile') return profileStep(order);
  if (status === 'registered') return doneStep(order);
  if (status === 'expired') return expiredStep(order);
  target.innerHTML = `<p class="eyebrow">Order status</p><h2>${esc(status)}</h2><p>This registration cannot continue in its current state. Return to the event page or contact the organizer.</p><a class="button" href="/">Return home</a>`;
}
function expiredStep(order) {
  const target = document.querySelector('#registration-content');
  target.innerHTML =
    '<h2>Payment code expired</h2><p>Start a revised registration to get a new payment code. If you already transferred the payment, contact the organizer before continuing.</p><form id="revise-form"><button class="button primary">Revise registration</button><p class="error" hidden></p></form>';
  bindSubmission('#revise-form', async () =>
    resume(await post(`/orders/${order.id}/cancel-and-revise`)),
  );
}
function bindSubmission(selector, handler) {
  const form = document.querySelector(selector);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (form.dataset.submitting) return;
    form.dataset.submitting = 'true';
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach((button) => {
      button.disabled = true;
    });
    const error = form.querySelector('.error');
    error.hidden = true;
    try {
      await handler(event);
    } catch (err) {
      if (err.status === 401) renderLogin();
      else {
        error.textContent = err.message;
        error.hidden = false;
      }
    } finally {
      delete form.dataset.submitting;
      buttons.forEach((button) => {
        button.disabled = false;
      });
    }
  });
}
async function sportsStep(order) {
  const target = document.querySelector('#registration-content');
  const sports = await api('/sports');
  const selected = new Set(order.items.map((item) => item.sport_id));
  const isFull = (sport) =>
    sport.max_teams !== null && Number(sport.filled_slots ?? 0) >= Number(sport.max_teams);
  target.innerHTML = `<p class="eyebrow">Step 01 / Company & sports</p><h2>Register your company</h2><p>Enter your company name, then choose the sports you want to enter. The same company name will appear for every selected sport.</p><form id="sports-form" class="form-stack"><label class="input-group">Company name<input name="company_name" aria-required="true" autocomplete="organization" value="${esc(order.company_name || '')}" placeholder="Your company name" maxlength="120"></label><h3>Select sports</h3><div class="choice-list">${
    sports.length
      ? sports
          .map((sport) => {
            const full = isFull(sport);
            return `<div class="sport-choice${full ? ' is-full' : ''}"><input type="checkbox" id="sport-${sport.id}" name="sport" value="${sport.id}" ${selected.has(sport.id) && !full ? 'checked' : ''} ${full ? 'disabled aria-disabled="true" title="No registration slots remaining"' : ''}><label class="sport-choice-label" for="sport-${sport.id}"><span class="sport-choice-copy"><strong>${esc(sport.name)}</strong><span class="${full ? 'slots-filled' : ''}">${full ? 'Slots filled' : money(sport.price)}</span></span>${sportIcon(sport, 'sport-choice-icon')}</label></div>`;
          })
          .join('')
      : '<p class="teams-state">No sports are open yet. Ask the organizer to add the championship formats.</p>'
  }</div><p class="error" id="form-error" hidden></p><div class="form-actions"><button class="button primary" ${sports.length ? '' : 'disabled'}>Continue to contact</button></div></form>`;
  const focus = new URLSearchParams(location.search).get('focus');
  if (!order.items.length && focus) {
    const sport = sports.find((item) => slugify(item.name) === focus);
    if (sport && !isFull(sport)) document.querySelector(`#sport-${sport.id}`).checked = true;
  }
  bindSubmission('#sports-form', async (event) => {
    event.preventDefault();
    const companyName = event.currentTarget.elements.company_name.value.trim();
    const picks = [...document.querySelectorAll('input[name=sport]:checked')].map((input) => ({
      sport_id: input.value,
    }));
    const error = document.querySelector('#form-error');
    if (!companyName || !picks.length) {
      error.textContent = 'Enter your company name and select at least one sport.';
      error.hidden = false;
      return;
    }
    const next = await patch(`/orders/${order.id}/sports`, {
      company_name: companyName,
      sports: picks,
    });
    await resume(next);
  });
}
function phoneStep(order) {
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<p class="eyebrow">Step 02 / Contact</p><h2>Where can we reach the captain?</h2><p>Use the phone number the organizer should use for registration questions.</p><form id="phone-form" class="form-stack"><label class="input-group">Phone number<input name="phone" required inputmode="tel" value="${esc(order.phone_number || '')}" placeholder="+977 9800000000"></label><p class="error" hidden></p><div class="form-actions"><button type="button" class="button" id="edit-sports">Edit company & sports</button><button class="button primary">Issue invoice</button></div></form>`;
  document.querySelector('#edit-sports').addEventListener('click', () =>
    sportsStep(order).catch((error) => {
      if (error.status === 401) renderLogin();
      else say(error.message);
    }),
  );
  bindSubmission('#phone-form', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (order.invoiced_at) return resume(order);
    order = await post(`/orders/${order.id}/phone`, {
      phone_number: new FormData(form).get('phone'),
    });
    order = await post(`/orders/${order.id}/invoice`);
    await resume(order);
  });
}
async function paymentStep(order) {
  const target = document.querySelector('#registration-content');
  const payment = await post(`/orders/${order.id}/payment-request`);
  target.innerHTML = `<p class="eyebrow">Step 03 / Payment</p><h2>Transfer ${money(order.total_amount)}</h2><p>Use the bank details below. <span class="remarks-copy">Put the unique Remarks code in the transfer remarks exactly as shown.</span></p><div class="info-box"><strong>Amount: ${money(order.total_amount)}</strong><br><span class="remarks-label">Remarks code:</span> <code>${esc(payment.unique_code)}</code><br>Expires: ${new Date(payment.expires_at).toLocaleString()}</div><div class="bank-details">${esc(payment.bank_details)}</div><p>${esc(payment.instructions)}</p><div class="form-actions"><button class="button primary" id="receipt-next">I have paid, upload receipt</button></div>`;
  document
    .querySelector('#receipt-next')
    .addEventListener('click', () => receiptStep({ ...order, status: 'payment_pending' }));
}
function receiptStep(order) {
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<p class="eyebrow">Step 04 / Receipt</p><h2>Upload proof of payment</h2><p>Send a clear PNG, JPEG, WebP, or PDF receipt, up to 5 MB. The organizer will review it alongside your exact amount and code.</p><form id="receipt-form" class="form-stack"><label class="input-group">Receipt file<input name="receipt" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" required></label><p class="error" hidden></p><div class="form-actions"><button class="button primary">Submit receipt</button></div></form>`;
  if (order.rejection) {
    const note = document.createElement('p');
    note.className = 'error';
    note.textContent = `Payment rejected: ${order.rejection.notes}`;
    target.prepend(note);
  }
  bindSubmission('#receipt-form', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = new FormData(form);
    try {
      const next = await api(`/orders/${order.id}/receipt`, { method: 'POST', body: payload });
      await resume(next);
    } catch (error) {
      if (error.code === 'payment_expired') return expiredStep(order);
      throw error;
    }
  });
}
function waitingStep(order) {
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<p class="eyebrow">Payment review / ${esc(order.status)}</p><h2>Receipt received</h2><p>Your receipt is with the organizer. This page checks for an update every 20 seconds.</p>${order.rejection ? `<p class="error">Latest note: ${esc(order.rejection.notes)}</p><div class="form-actions"><button class="button primary" id="resubmit">Upload another receipt</button></div>` : '<div class="info-box">You can leave now. The order is saved and will resume here after sign in.</div>'}`;
  document.querySelector('#resubmit')?.addEventListener('click', () => receiptStep(order));
  const poll = async () => {
    if (location.pathname !== '/register' || !target.querySelector('#review-status')) return;
    try {
      const next = await api(`/orders/${order.id}/status`);
      if (next.status !== order.status) {
        await resume(next);
        say('Your registration status changed.');
        return;
      }
    } catch (error) {
      if (error.status === 401) return renderLogin();
      const status = target.querySelector('#review-status');
      if (!status) return;
      status.textContent = 'Could not refresh the status. Retrying shortly.';
    }
    reviewTimer = setTimeout(poll, 20000);
  };
  const status = document.createElement('p');
  status.id = 'review-status';
  status.setAttribute('role', 'status');
  target.append(status);
  reviewTimer = setTimeout(poll, 20000);
}
function profileStep(order) {
  profileOrder = order;
  const target = document.querySelector('#registration-content');
  const pending = order.items.filter((item) => !item.profile_completed_at);
  target.innerHTML = `<p class="eyebrow">Step 05 / Team profile</p><h2>Finish your team</h2><p>Payment is confirmed. Add a logo and roster for each team. A confirmed team appears on the public listing after you mark its profile done.</p><div class="choice-list">${pending.map((item) => `<div class="sport-choice"><div><strong>${esc(item.team_name)}</strong><span>${esc(item.sport_name)}</span></div><a class="button primary" href="#profile/${item.id}">Complete profile</a></div>`).join('')}</div>`;
  const itemId = location.hash.split('/')[1];
  if (itemId) profileEditor(order, itemId);
}
function profileEditor(order, itemId) {
  const item = order.items.find((candidate) => candidate.id === itemId);
  if (!item) return;
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<p class="eyebrow">${esc(item.sport_name)} / Team profile</p><h2>${esc(item.team_name)}</h2><form id="profile-form" class="form-stack"><label class="input-group">Team logo<input name="logo" type="file" accept="image/png,image/jpeg,image/webp"></label><label class="input-group">Players, one name per line<textarea name="players" required rows="6" placeholder="Player one&#10;Player two">${esc(item.players.join('\n'))}</textarea></label><p class="error" hidden></p><div class="form-actions"><button class="button" name="save" value="save">Save draft</button><button class="button primary" name="complete" value="complete">Save and mark done</button></div></form>`;
  bindSubmission('#profile-form', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const action = event.submitter?.value || 'save';
    const fd = new FormData(form);
    const players = String(fd.get('players'))
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);
    const update = new FormData();
    if (fd.get('logo').size) update.append('logo', fd.get('logo'));
    update.append('players', JSON.stringify(players));
    await api(`/orders/${order.id}/items/${item.id}/profile`, { method: 'PATCH', body: update });
    if (action === 'complete') {
      const complete = await post(`/orders/${order.id}/items/${item.id}/profile/complete`);
      const current = await api(`/orders/${order.id}/status`);
      history.replaceState({}, '', location.pathname + location.search);
      await resume(current || complete);
      say('Team profile completed.');
    } else {
      say('Profile saved.');
    }
  });
}
function doneStep(order) {
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<p class="eyebrow">Registration complete</p><h2>See you at the park.</h2><p>Every team on your order has a completed profile. Your confirmation email has been queued for delivery.</p><div class="form-actions"><a class="button primary" href="/">Return to championship</a><a class="button" href="/#teams">See team listing</a></div>`;
}
async function render() {
  try {
    if (!data) await load();
    if (location.pathname === '/register') await register();
    else home();
  } catch (error) {
    main.innerHTML = e('Registration unavailable', error.message);
  }
}
window.addEventListener('popstate', render);
window.addEventListener('hashchange', () => {
  if (profileOrder && location.pathname === '/register') {
    const itemId = location.hash.startsWith('#profile/') ? location.hash.slice(9) : '';
    if (itemId) profileEditor(profileOrder, itemId);
    else profileStep(profileOrder);
  }
  if (location.hash === '#register') {
    history.pushState({}, '', '/register');
    render();
  }
});
render();
