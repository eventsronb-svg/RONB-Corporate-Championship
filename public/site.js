import { prepareUploadForm } from './uploads.js';

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
  if (options.body instanceof FormData) await prepareUploadForm(options.body);
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
        (response.status === 413
          ? 'This file is too large to upload. Choose a file under 4 MB.'
          : response.status >= 500
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
      <img class="hero-visual" src="/assets/images/logo.png" alt="Corporate Championship" width="1600" height="1600" />
    </section>
    <div class="event-strip"><div><span>Save the dates</span><strong>October 1-4, 2026</strong></div><div><span>Meet us at</span><strong>Royal Sports Park, Chunikhel</strong></div><div><span>TEAM UP & TURN UP</span><strong>Ready to Bring the Heat?</strong></div></div>
    <section class="section" id="sports">${sectionHeader('A game for your team', 'Good colleagues. Great teammates.', 'Pick your sport, rally your people, and give the office something new to talk about.')}<div class="sport-grid">${data.sports.map((sport) => `<a class="sport sport-${sport.slug}" href="/register?focus=${encodeURIComponent(sport.slug)}"><div class="sport-top"><span class="sport-format">Open for registration</span></div><h3>${esc(sport.name)}</h3>${sport.description ? `<p>${esc(sport.description)}</p>` : ''}<span class="sport-link">Let's play</span>${sportIcon(sport)}</a>`).join('')}</div><p class="section-note">Registration fees and available places are shown when you sign in.</p></section>
    <section class="team-story section"><p class="eyebrow">Better together</p><h2>A different kind<br>of team meeting.</h2><p>Swap the meeting room for the court. Cheer for your colleagues, meet other company teams, and make memories beyond the workday.</p><a class="button" href="/register">Make your company part of it</a></section>
    <section class="section" id="teams">${sectionHeader('', 'Meet the teams', 'Your next friendly rivals. Confirmed teams appear here once their captain completes the team profile.')}<div class="teams-shell"><div class="team-tabs" role="tablist" aria-label="Team sports">${data.sports.map((sport, index) => `<button role="tab" id="tab-${sport.slug}" aria-label="${esc(sport.name)}" aria-controls="teams-panel" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" data-sport="${esc(sport.name)}" data-slug="${sport.slug}" ${sport.max_teams ? `data-max="${sport.max_teams}"` : ''}>${esc(sport.name)}</button>`).join('')}</div><div class="team-list" id="teams-panel" role="tabpanel" aria-labelledby="tab-${data.sports[0]?.slug || ''}" aria-live="polite"><p class="teams-state">Loading confirmed teams…</p></div></div></section>
    <section class="section venue-section" id="venue"><img class="venue-date" src="/assets/images/calendar.png" alt="See you in October 01 to 04 2026 · Chunikhel, Kathmandu" width="1536" height="1024" /><div class="venue-copy"><p class="eyebrow">Room to play. Reasons to stay.</p><h2>${esc(data.venue)}</h2><p>Four days of team spirit at ${esc(data.locality)}. Get your colleagues together and meet us on the court.</p><a class="button primary" href="${esc(data.maps_url)}" target="_blank" rel="noreferrer">Open directions</a></div><div class="venue-map"><iframe title="Royal Sports Park location on Google Maps" src="${esc(data.maps_embed_url)}" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe><p>Royal Sports Park, Chunikhel · <a href="${esc(data.maps_url)}" target="_blank" rel="noreferrer">View larger map and directions ↗</a></p></div></section>
    <section class="section faq-section" id="faq">${sectionHeader('A little pre-game prep', 'Good questions', 'Everything you need to get your team started.')}<div class="faq"><details><summary>Can a company enter more than one sport?</summary><p>Yes. Each registration covers one sport, so register again for each additional sport you want to enter.</p></details><details><summary>When does a team show publicly?</summary><p>After payment is confirmed by the organizer and the captain adds the company logo and completes the roster for that sport.</p></details><details><summary>How does payment work?</summary><p>Your registration includes the exact amount, a payment code, and instructions. The same payment code is reused every time you register, so use the same code in every transfer. Upload your receipt after each transfer. An organizer verifies it before team profiles unlock.</p></details><details><summary>Where can I get directions?</summary><p>Use the Royal Sports Park directions link above. It opens the organizer-provided Google Maps location.</p></details></div></section>
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
      count.textContent = `${selected.listed_slots ?? selected.filled_slots}/${tab.dataset.max}`;
      tab.setAttribute('aria-describedby', count.id);
      if (!count.parentElement) tab.append(count);
    }
    await swap(
      teams.length
        ? teams
            .map(
              (team) =>
                `<article class="team">${team.logo_url ? `<img class="team-logo" src="${esc(team.logo_url)}" alt="${esc(team.team_name)} logo" />` : ''}<h3 class="team-name">${esc(team.team_name)}</h3></article>`,
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
    '<h2>Payment code expired</h2><p>Start a revised registration to request payment instructions again. Your account keeps the same payment code. If you already transferred the payment, contact the organizer before continuing.</p><form id="revise-form"><button class="button primary">Revise registration</button><p class="error" hidden></p></form>';
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
  const registrations = await api('/orders');
  const registered = new Map();
  for (const other of registrations) {
    if (other.id === order.id) continue;
    if (['cancelled', 'expired'].includes(other.status)) continue;
    for (const item of other.items)
      registered.set(item.sport_id, other.resume_step === 'registered' ? 'verified' : 'pending');
  }
  const companyLocked = order.company_locked;
  const lockedCompany =
    registrations.find((other) => other.company_name)?.company_name || order.company_name || '';
  const companyField = companyLocked
    ? `<p class="info-box" id="company-locked-note"><strong>${esc(lockedCompany)}</strong><br>Your company profile and contact number are already saved.</p>`
    : `<label class="input-group">Company name<input name="company_name" aria-required="true" autocomplete="organization" value="${esc(order.company_name || '')}" placeholder="Your company name" maxlength="120"></label>`;
  target.innerHTML = `<p class="eyebrow">Step 01 / Company & sport</p><h2>${companyLocked ? 'Register another sport' : 'Register your company'}</h2><p>${companyLocked ? 'Choose a sport. We will reuse your company name, logo and contact number.' : 'Enter your company name, then choose the sport you want to enter. To enter a second sport, register again for that sport.'}</p><form id="sports-form" class="form-stack">${companyField}<h3>Select a sport</h3><div class="choice-list">${
    sports.length
      ? sports
          .map((sport) => {
            const full = isFull(sport);
            const state = registered.get(sport.id);
            const disabled = full || !!state;
            const cls = [
              full && 'is-full',
              state && `is-registered ${state === 'verified' ? 'is-verified' : 'is-pending'}`,
            ]
              .filter(Boolean)
              .join(' ');
            const label = state
              ? state === 'verified'
                ? 'Registered · Verified'
                : 'Registered · Pending'
              : full
                ? 'Slots filled'
                : money(sport.price);
            const title = state
              ? 'This company is already registered for this sport'
              : full
                ? 'No registration slots remaining'
                : '';
            return `<div class="sport-choice${cls ? ` ${cls}` : ''}"><input type="radio" name="sport" id="sport-${sport.id}" value="${sport.id}" ${selected.has(sport.id) && !disabled ? 'checked' : ''} ${state || full ? 'disabled aria-disabled="true"' : ''}${title ? ` title="${title}"` : ''}><label class="sport-choice-label" for="sport-${sport.id}"><span class="sport-choice-copy"><strong>${esc(sport.name)}</strong><span class="${state ? 'registered-state' : full ? 'slots-filled' : ''}">${label}</span></span>${sportIcon(sport, 'sport-choice-icon')}</label></div>`;
          })
          .join('')
      : '<p class="teams-state">No sports are open yet. Ask the organizer to add the championship formats.</p>'
  }</div><p class="error" id="form-error" hidden></p><div class="form-actions"><button class="button primary" ${sports.length ? '' : 'disabled'}>${companyLocked ? 'Continue to invoice' : 'Continue to contact'}</button></div></form>`;
  const focus = new URLSearchParams(location.search).get('focus');
  if (!order.items.length && focus) {
    const sport = sports.find((item) => slugify(item.name) === focus);
    if (sport && !isFull(sport) && !registered.get(sport.id))
      document.querySelector(`#sport-${sport.id}`).checked = true;
  }
  bindSubmission('#sports-form', async (event) => {
    event.preventDefault();
    const companyName = companyLocked
      ? lockedCompany
      : event.currentTarget.elements.company_name.value.trim();
    const picks = [...document.querySelectorAll('input[name=sport]:checked')]
      .filter((input) => !input.disabled)
      .map((input) => ({
        sport_id: input.value,
      }));
    const error = document.querySelector('#form-error');
    if (!companyName || !picks.length) {
      error.textContent = 'Enter your company name and select a sport.';
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
  if (order.company_locked && order.status === 'phone_captured') {
    target.innerHTML = `<p class="eyebrow">Step 02 / Invoice</p><h2>Issue your invoice</h2><p>Your saved company profile and contact number will be used for this ${esc(order.items[0]?.sport_name || 'sport')} registration.</p><form id="invoice-form" class="form-stack"><p class="error" hidden></p><div class="form-actions"><button type="button" class="button" id="edit-sports">Edit sport</button><button class="button primary">Issue invoice</button></div></form>`;
    document.querySelector('#edit-sports').addEventListener('click', () =>
      sportsStep(order).catch((error) => {
        if (error.status === 401) renderLogin();
        else say(error.message);
      }),
    );
    bindSubmission('#invoice-form', async () => resume(await post(`/orders/${order.id}/invoice`)));
    return;
  }
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
  target.innerHTML = `<p class="eyebrow">Step 04 / Receipt</p><h2>Upload proof of payment</h2><p>Send a clear PNG, JPEG, or WebP receipt up to 5 MB, or a PDF under 4 MB. Large images are compressed automatically before upload. The organizer will review it alongside your exact amount and code.</p><form id="receipt-form" class="form-stack"><label class="input-group">Receipt file<input name="receipt" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" required></label><p class="error" hidden></p><div class="form-actions"><button class="button primary">Submit receipt</button></div></form>`;
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
  target.innerHTML = `<p class="eyebrow">Payment review / ${esc(order.status)}</p><h2>Receipt received</h2><p>Your receipt is with the organizer.</p>${order.rejection ? `<p class="error">Latest note: ${esc(order.rejection.notes)}</p><div class="form-actions"><button class="button primary" id="resubmit">Upload another receipt</button></div>` : '<div class="info-box">You can leave now. The order is saved and will resume here after sign in.</div>'}`;
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
  const companyLocked = order.company_locked;
  target.innerHTML = `<p class="eyebrow">Step 05 / Team profile</p><h2>Finish your team</h2><p>${companyLocked ? 'Payment is confirmed. Complete the roster for your team with your saved company logo. A confirmed team appears on the public listing after you mark its profile done.' : 'Payment is confirmed. Upload your company logo, then complete the roster for your team. A confirmed team appears on the public listing after you mark its profile done.'}</p><div class="choice-list">${pending.map((item) => `<div class="sport-choice"><div><strong>${esc(item.team_name)}</strong><span>${esc(item.sport_name)}</span></div><a class="button primary" href="#profile/${item.id}">Complete profile</a></div>`).join('')}</div>`;
  const companyItem = order.items.find((item) => item.logo_url) || order.items[0];
  if (companyItem) {
    if (companyLocked && companyItem.logo_url) {
      target
        .querySelector('.choice-list')
        .insertAdjacentHTML(
          'beforebegin',
          `<div class="form-stack" id="company-logo-fixed"><img class="company-logo-preview" src="${esc(companyItem.logo_url)}" alt="${esc(companyItem.team_name)} company logo" /><p id="company-logo-note">Your company logo is already saved and is used for every registration. It cannot be changed here.</p></div>`,
        );
    } else {
      target
        .querySelector('.choice-list')
        .insertAdjacentHTML(
          'beforebegin',
          `<form id="company-logo-form" class="form-stack">${companyItem.logo_url ? `<img class="company-logo-preview" src="${esc(companyItem.logo_url)}" alt="${esc(companyItem.team_name)} company logo" />` : ''}<label class="input-group">Company logo<input name="logo" type="file" accept="image/png,image/jpeg,image/webp" required aria-describedby="company-logo-note"></label><p id="company-logo-note">${companyItem.logo_url ? 'Your company logo is saved for this team. You can replace it here.' : 'Upload your company logo. It will appear on the team listing.'}</p><p class="error" hidden></p><div><button class="button" type="submit">${companyItem.logo_url ? 'Replace company logo' : 'Save company logo'}</button></div></form>`,
        );
      bindSubmission('#company-logo-form', async (event) => {
        event.preventDefault();
        await api(`/orders/${order.id}/items/${companyItem.id}/profile`, {
          method: 'PATCH',
          body: new FormData(event.currentTarget),
        });
        const current = await api(`/orders/${order.id}/status`);
        profileStep(current);
        say('Company logo saved.');
      });
    }
  }
  const itemId = location.hash.split('/')[1];
  if (itemId) profileEditor(order, itemId);
}
const MIN_ROSTER = { futsal: 5, basketball: 3, crickshal: 7 };
function profileEditor(order, itemId) {
  const item = order.items.find((candidate) => candidate.id === itemId);
  if (!item) return;
  const required = MIN_ROSTER[item.sport_name.toLowerCase()] ?? 1;
  const target = document.querySelector('#registration-content');
  target.innerHTML = `<button class="button" type="submit" form="profile-form" name="save" value="back">← Back to overview</button><p class="eyebrow">${esc(item.sport_name)} / Team profile</p><h2>${esc(item.team_name)}</h2><p>Your roster is saved as a draft when you return to the overview.</p>${!item.logo_url ? '<p class="info-box">Add your company logo on the overview before marking this profile done.</p>' : ''}<form id="profile-form" class="form-stack"><fieldset class="roster-fields"><legend>Players</legend><p class="form-note">Add at least ${required} player${required > 1 ? 's' : ''}, including your team captain. Choose a jersey size and add a photo (JPG, PNG or WebP, under 4 MB) for every player.</p><div id="player-fields" class="player-fields"></div><button class="button" id="add-player" type="button">Add player</button></fieldset><label class="input-group">Team captain<select name="captain_position" aria-describedby="captain-note"><option value="">Choose a player</option></select></label><p id="captain-note" class="form-note">Choose one of the players above. The captain counts as part of your roster.</p><p class="error" hidden></p><div class="form-actions"><button class="button" name="save" value="save">Save draft</button><button class="button primary" name="complete" value="complete">Save and mark done</button></div></form>`;
  const fields = target.querySelector('#player-fields');
  const captain = target.querySelector('[name="captain_position"]');
  const addButton = target.querySelector('#add-player');
  const photoSelections = new Map();
  const syncCaptain = () => {
    const selected = captain.value;
    captain.innerHTML =
      '<option value="">Choose a player</option>' +
      [...fields.querySelectorAll('input[name="player"]')]
        .map((input, index) =>
          input.value.trim()
            ? `<option value="${index}">${esc(input.value.trim())} (Player ${index + 1})</option>`
            : '',
        )
        .join('');
    captain.value = selected;
  };
  const addPlayer = (name = '', size = null, photoKey = null) => {
    const index = fields.children.length;
    const preview = photoKey
      ? `<img class="player-photo-preview" src="/orders/${order.id}/items/${item.id}/player-photos/${index}" alt="" aria-hidden="true">`
      : '<span class="player-photo-placeholder" aria-hidden="true"></span>';
    fields.insertAdjacentHTML(
      'beforeend',
      `<div class="player-row"><div class="player-photo">${preview}<button type="button" class="player-photo-clear" data-photo="${index}" aria-label="Remove photo for player ${index + 1}" ${photoKey ? '' : 'hidden'}>×</button><label class="player-photo-pick"><input name="photo-${index}" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Photo for player ${index + 1}"><span>Photo</span></label></div><label class="input-group">Player ${index + 1}<input name="player" type="text" value="${esc(name)}" maxlength="120" autocomplete="off" placeholder="Full name"></label><fieldset class="jersey-selector"><legend>Jersey size <span class="sr-only">for player ${index + 1}</span></legend><div class="jersey-options">${['S', 'M', 'L', 'XL'].map((option) => `<label><input type="radio" name="jersey-${index}" value="${option}" ${size === option ? 'checked' : ''}><span>${option}</span></label>`).join('')}</div></fieldset></div>`,
    );
    addButton.disabled = fields.children.length >= 100;
  };
  for (let index = 0; index < Math.max(required, item.players.length); index++)
    addPlayer(item.players[index] || '', item.jersey_sizes?.[index], item.photo_urls?.[index]);
  fields.addEventListener('input', () => {
    syncCaptain();
    target.querySelector('#profile-form .error').hidden = true;
  });
  fields.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const match = input.name && /^photo-(\d+)$/.exec(input.name);
    if (!match || !input.files?.[0]) return;
    const index = Number(match[1]);
    const row = input.closest('.player-row');
    let preview = row.querySelector('.player-photo-preview');
    if (!preview) {
      row.querySelector('.player-photo-placeholder')?.remove();
      row
        .querySelector('.player-photo-pick')
        .insertAdjacentHTML(
          'beforebegin',
          '<img class="player-photo-preview" alt="" aria-hidden="true">',
        );
      preview = row.querySelector('.player-photo-preview');
    }
    preview.src = URL.createObjectURL(input.files[0]);
    const clear = row.querySelector('.player-photo-clear');
    if (clear) clear.hidden = false;
    photoSelections.set(index, input.files[0]);
  });
  fields.addEventListener('click', (event) => {
    const button = event.target.closest('.player-photo-clear');
    if (!button) return;
    const index = Number(button.dataset.photo);
    const row = button.closest('.player-row');
    row.querySelector('.player-photo-preview')?.remove();
    row
      .querySelector('.player-photo-pick')
      .insertAdjacentHTML(
        'beforebegin',
        '<span class="player-photo-placeholder" aria-hidden="true"></span>',
      );
    button.hidden = true;
    row.querySelector(`[name="photo-${index}"]`).value = '';
    photoSelections.set(index, null);
  });
  addButton.addEventListener('click', () => {
    addPlayer();
    fields.lastElementChild.querySelector('input').focus();
  });
  syncCaptain();
  captain.value =
    item.captain_position === null || item.captain_position === undefined
      ? ''
      : String(item.captain_position);
  bindSubmission('#profile-form', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const action = event.submitter?.value || 'save';
    const fd = new FormData(form);
    const names = fd.getAll('player').map((name) => String(name).trim());
    const players = names.filter(Boolean);
    const jerseySizes = names.flatMap((name, index) =>
      name ? [fd.get(`jersey-${index}`) || null] : [],
    );
    const selectedPosition = captain.value === '' ? null : Number(captain.value);
    const captainPosition =
      selectedPosition === null ? null : names.slice(0, selectedPosition).filter(Boolean).length;
    const error = form.querySelector('.error');
    if (action === 'complete' && players.length < required) {
      error.textContent = `Add at least ${required} player${required > 1 ? 's' : ''} before completing the ${item.sport_name} profile.`;
      error.hidden = false;
      return;
    }
    if (action === 'complete' && captainPosition === null) {
      error.textContent = 'Choose a team captain from your players.';
      error.hidden = false;
      captain.focus();
      return;
    }
    if (action === 'complete' && jerseySizes.some((size) => size === null)) {
      error.textContent = 'Choose a jersey size for every player.';
      error.hidden = false;
      const missingIndex = names.findIndex((name, index) => name && !fd.get(`jersey-${index}`));
      fields.querySelector(`[name="jersey-${missingIndex}"]`).focus();
      return;
    }
    if (
      action === 'complete' &&
      names.some(
        (name, index) =>
          name &&
          !(photoSelections.has(index) ? photoSelections.get(index) : item.photo_urls?.[index]),
      )
    ) {
      error.textContent = 'Add a photo for every player.';
      error.hidden = false;
      const missingIndex = names.findIndex(
        (name, index) =>
          name &&
          !(photoSelections.has(index) ? photoSelections.get(index) : item.photo_urls?.[index]),
      );
      fields.querySelector(`[name="photo-${missingIndex}"]`).focus();
      return;
    }
    const playerPhotos = new Array(fields.children.length);
    for (let index = 0; index < fields.children.length; index++)
      playerPhotos[index] = item.photo_urls?.[index] ?? null;
    const buttons = form.querySelectorAll('button[type="submit"]');
    const busy = (next) => {
      form.querySelectorAll('input, button').forEach((el) => {
        el.disabled = next;
      });
    };
    if (photoSelections.size) {
      busy(true);
      try {
        for (const [index, file] of photoSelections) {
          if (file === null) {
            playerPhotos[index] = null;
            continue;
          }
          const fd = new FormData();
          fd.append('photo', file);
          const uploaded = await api(
            `/orders/${order.id}/items/${item.id}/player-photos/${index}`,
            { method: 'POST', body: fd },
          );
          playerPhotos[index] = uploaded.photo_url;
        }
      } catch (uploadError) {
        busy(false);
        error.textContent = `One of your player photos could not be uploaded. ${uploadError.message}`;
        error.hidden = false;
        return;
      }
    }
    const update = new FormData();
    update.append('jersey_sizes', JSON.stringify(jerseySizes));
    update.append('captain_position', JSON.stringify(captainPosition));
    update.append('players', JSON.stringify(players));
    update.append('player_photos', JSON.stringify(playerPhotos));
    buttons.forEach((button) => (button.disabled = false));
    await api(`/orders/${order.id}/items/${item.id}/profile`, { method: 'PATCH', body: update });
    if (action === 'complete') {
      const complete = await post(`/orders/${order.id}/items/${item.id}/profile/complete`);
      const current = await api(`/orders/${order.id}/status`);
      history.replaceState({}, '', location.pathname + location.search);
      await resume(current || complete);
      say('Team profile completed.');
    } else {
      profileOrder = await api(`/orders/${order.id}/status`);
      if (action === 'back') {
        history.replaceState({}, '', location.pathname + location.search);
        profileStep(profileOrder);
      }
      say('Profile saved.');
    }
  });
}
async function doneStep(order) {
  const target = document.querySelector('#registration-content');
  const teamName = order.items[0]?.team_name;
  const farewell = teamName ? `See you there ${esc(teamName)}.` : 'See you at the park.';
  target.innerHTML = `<p class="eyebrow">Registration complete</p><h2>${farewell}</h2><p>Your team profile is complete. Your confirmation email has been queued for delivery.</p>`;
  let registrations = [];
  let sports = [];
  try {
    [registrations, sports] = await Promise.all([api('/orders'), api('/sports')]);
    registrations = registrations.filter(
      (other) => other.items.length && !['cancelled', 'expired'].includes(other.status),
    );
  } catch (error) {
    if (error.status === 401) return renderLogin();
    throw error;
  }
  const summaryFor = (other) => {
    const item = other.items[0];
    const players = item.players || [];
    const photo = (index) =>
      item.photo_urls?.[index]
        ? `<img class="roster-photo" src="/orders/${other.id}/items/${item.id}/player-photos/${index}" alt="" aria-hidden="true">`
        : '<span class="roster-photo roster-photo-none" aria-hidden="true"></span>';
    return `${item.team_name ? `<p class="team-name">${esc(item.team_name)}</p>` : ''}<div class="roster-list">${players.map((name, index) => `<div class="roster-row">${photo(index)}<span class="roster-name">${esc(name)}${index === item.captain_position ? ' <span class="captain-tag">Captain</span>' : ''}</span><span class="jersey-badge">${esc(item.jersey_sizes?.[index] || '—')}</span></div>`).join('')}</div>`;
  };
  const registeredFor = (sport) =>
    registrations.find((other) => other.items.some((item) => item.sport_id === sport.id));
  const isFull = (sport) =>
    sport.max_teams !== null && Number(sport.filled_slots ?? 0) >= Number(sport.max_teams);
  const currentSport = order.items[0]?.sport_id;
  target.innerHTML = `<p class="eyebrow">Registration complete</p><h2>${farewell}</h2><p>Choose a sport to review your team or register another one.</p><div class="registration-panel"><h3>Your championship sports</h3><div class="sport-accordion">${sports
    .map((sport) => {
      const registration = registeredFor(sport);
      const registered = Boolean(registration);
      const verified = registration?.resume_step === 'registered';
      const full = isFull(sport);
      const state = registered
        ? verified
          ? 'Registered · Verified'
          : 'Registration in progress'
        : full
          ? 'Slots filled'
          : `Register for ${sport.name}`;
      const content = registered
        ? `<div class="info-box registration-summary">${summaryFor(registration)}</div>`
        : `<p>Bring another team to the championship. Registration, payment and roster details are saved separately for ${esc(sport.name)}.</p><button class="button primary" type="button" data-register-sport="${esc(sport.id)}">Register for ${esc(sport.name)}</button>`;
      return `<details class="registration-sport${registered ? ' is-registered' : ''}" ${sport.id === currentSport ? 'open' : ''}><summary><span class="registration-sport-icon">${sportIcon(sport, 'sport-choice-icon')}</span><span class="registration-sport-copy"><strong>${esc(sport.name)}</strong><span class="${registered ? `registered-state ${verified ? 'is-verified' : 'is-pending'}` : full ? 'slots-filled' : ''}">${esc(state)}</span></span><span class="registration-sport-chevron" aria-hidden="true">⌄</span></summary><div class="registration-sport-content">${content}</div></details>`;
    })
    .join(
      '',
    )}</div><div class="form-actions"><a class="button primary" href="/">Return to championship</a><a class="button" href="/#teams">See team listing</a></div></div>`;
  target.querySelectorAll('[data-register-sport]').forEach((button) =>
    button.addEventListener('click', async () => {
      const sport = sports.find((candidate) => candidate.id === button.dataset.registerSport);
      if (!sport) return;
      try {
        const url = new URL(location.href);
        url.searchParams.set('focus', slugify(sport.name));
        history.replaceState({}, '', url);
        await resume(await post('/orders/start'));
      } catch (error) {
        if (error.status === 401) renderLogin();
        else say(error.message);
      }
    }),
  );
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
