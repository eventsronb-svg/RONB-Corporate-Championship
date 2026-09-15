const main = document.querySelector('#content');
const notice = document.querySelector('#notice');
const states = [
  'receipt_submitted',
  'under_review',
  'confirmed',
  'contacted',
  'completed',
  'rejected',
  'payment_pending',
  'invoiced',
  'phone_captured',
  'draft',
  'expired',
  'cancelled',
];
let me;
let viewVersion = 0;
const e = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const human = (s) => String(s).replaceAll('_', ' ');
const date = (s) =>
  s
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(s),
      )
    : '—';
const money = (value) =>
  Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const status = (s) => `<span class="status ${e(s)}">${e(human(s))}</span>`;
function message(text, error = false) {
  notice.textContent = text;
  notice.classList.toggle('error', error);
  notice.hidden = false;
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && me) {
      me = undefined;
      login();
    }
    throw new Error(
      body.details?.map((x) => `${x.path}: ${x.message}`).join('; ') ||
        body.message ||
        'Request failed',
    );
  }
  return body;
}
function post(path, body = {}) {
  return api(path, { method: 'POST', body: JSON.stringify(body) });
}
function header(title, desc, eyebrow = 'EVENT OPERATIONS', meta = '') {
  return `<div class="heading"><div><div class="eyebrow">${e(eyebrow)}</div><h1>${e(title)}</h1><p>${e(desc)}</p></div>${meta ? `<div class="heading-meta">${e(meta)}</div>` : ''}</div>`;
}
function empty(title, desc) {
  return `<div class="empty"><span class="empty-symbol" aria-hidden="true">—</span><h2>${e(title)}</h2><p>${e(desc)}</p></div>`;
}
function field(label, name, value = '', type = 'text', extra = '') {
  return `<label>${e(label)}<input name="${e(name)}" type="${type}" value="${e(value)}" ${extra}></label>`;
}
function formData(form) {
  return Object.fromEntries(new FormData(form));
}
function bindForm(selector, fn) {
  document.querySelectorAll(selector).forEach((form) =>
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const buttons = [...form.querySelectorAll('button')];
      buttons.forEach((b) => (b.disabled = true));
      notice.hidden = true;
      try {
        await fn(formData(form), form, event.submitter);
      } catch (err) {
        message(err.message, true);
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    }),
  );
}
function login() {
  document.querySelector('#nav').innerHTML = '';
  document.querySelector('#account').textContent = 'Organizer access';
  main.innerHTML = `<section class="login view-entry"><div class="intro-rule"></div>${header('A good event starts here.', 'Review registrations, confirm payments, and help teams get ready.', 'RONB / EVENT DESK')}<a class="button primary" href="/admin/auth/google">Continue with Google <span aria-hidden="true">↗</span></a><p class="login-note">Access is limited to invited event organizers.<br>Use the Google account your team added to the allowlist.</p></section>`;
}
function navigation() {
  const links = [
    ['orders', 'Registrations'],
    ['users', 'Captains'],
    ...(me.role === 'super_admin'
      ? [
          ['sports', 'Sports & pricing'],
          ['event', 'Event details'],
          ['admins', 'Organizers'],
        ]
      : []),
  ];
  document.querySelector('#nav').innerHTML = links
    .map(
      ([key, label], i) =>
        `<a href="#${key}" data-nav="${key}"><span class="nav-index" aria-hidden="true">0${i + 1}</span>${label}</a>`,
    )
    .join('');
  document.querySelector('#account').innerHTML =
    `<span>${e(me.name || me.email)} <span class="sub">${e(human(me.role))}</span></span><button id="logout" class="text-button">Sign out</button>`;
  document.querySelector('#logout').addEventListener('click', async () => {
    try {
      await post('/admin/auth/logout');
      me = undefined;
      login();
    } catch (err) {
      message(err.message, true);
    }
  });
}
async function queue(params) {
  const q = new URLSearchParams(params);
  if (!q.has('status')) q.set('status', 'receipt_submitted');
  q.set('limit', '25');
  const [data, sports] = await Promise.all([api(`/admin/orders?${q}`), api('/sports')]);
  const offset = Number(q.get('offset') || 0);
  return {
    html: `${header('Registrations', 'Review payment proof and follow each team through registration.', 'EVENT OPERATIONS', `${data.orders.length} ON THIS PAGE`)}<section class="surface"><form class="toolbar" id="queue-filter"><label class="search">Find a registration<input name="search" placeholder="Captain, team, email or payment code" value="${e(q.get('search'))}"></label><label>Status<select name="status">${['all', ...states].map((s) => `<option value="${s}" ${s === q.get('status') ? 'selected' : ''}>${e(human(s))}</option>`).join('')}</select></label><label>Sport<select name="sport_id"><option value="">All sports</option>${sports.map((s) => `<option value="${s.id}" ${s.id === q.get('sport_id') ? 'selected' : ''}>${e(s.name)}</option>`).join('')}</select></label><button class="primary" type="submit">Apply filters</button><details><summary>Date range</summary><div class="data">${field('From', 'date_from', q.get('date_from')?.slice(0, 10), 'date')}${field('Through', 'date_to', q.get('date_to')?.slice(0, 10), 'date')}</div></details></form>
  ${data.orders.length ? `<div class="table-scroll"><table><thead><tr><th>Captain / team</th><th>Amount</th><th>Payment code</th><th>Status</th><th>Submitted</th><th><span class="sub">Review</span></th></tr></thead><tbody>${data.orders.map((o) => `<tr><td><a class="strong" href="#order/${o.id}">${e(o.captain_name)}</a><span class="sub">${e(o.teams.map((t) => `${t.team_name} · ${t.sport_name}`).join(' / '))}</span></td><td>${o.total_amount === null ? '—' : money(o.total_amount)}</td><td class="mono">${e(o.unique_code || 'Not issued')}</td><td>${status(o.status)}</td><td>${e(date(o.receipt_submitted_at))}</td><td><a href="#order/${o.id}" aria-label="Review ${e(o.captain_name)}">Open ↗</a></td></tr>`).join('')}</tbody></table></div>` : empty('You’re all caught up.', 'No registrations match these filters. New receipt submissions will appear here.')}
  <div class="pagination"><span>Showing ${data.orders.length ? offset + 1 : 0}–${offset + data.orders.length}</span><div><button id="prev" ${offset === 0 ? 'disabled' : ''}>Previous</button> <button id="next" ${data.orders.length < 25 ? 'disabled' : ''}>Next</button></div></div></section>`,
    bind() {
      bindForm('#queue-filter', async (b) => {
        const next = new URLSearchParams();
        Object.entries(b).forEach(([k, v]) => {
          if (v)
            next.set(
              k,
              k === 'date_from' ? `${v}T00:00:00.000Z` : k === 'date_to' ? `${v}T23:59:59.999Z` : v,
            );
        });
        location.hash = `orders?${next}`;
      });
      document.querySelector('#prev').onclick = () => {
        q.set('offset', String(Math.max(0, offset - 25)));
        location.hash = `orders?${q}`;
      };
      document.querySelector('#next').onclick = () => {
        q.set('offset', String(offset + 25));
        location.hash = `orders?${q}`;
      };
    },
  };
}
async function orderDetail(id) {
  const o = await api(`/admin/orders/${id}`);
  const reviewable = ['receipt_submitted', 'under_review'].includes(o.status);
  const allDone =
    ['confirmed', 'contacted', 'completed'].includes(o.status) &&
    o.items.length &&
    o.items.every((i) => i.profile_completed_at);
  const info = (label, value) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`;
  return {
    html: `<a class="back" href="#orders">← All registrations</a>${header(o.user.name, `${o.user.email} · ${o.phone_number || 'Contact number not captured'}`, 'REGISTRATION DETAIL', o.id)}<div class="detail-grid">
 <div class="stack"><section class="surface panel"><div class="data"><div><div class="eyebrow">EXPECTED PAYMENT</div><div class="amount">${o.total_amount === null ? 'Not invoiced' : money(o.total_amount)}</div></div><div>${status(o.status)}<span class="sub">Invoiced ${e(date(o.invoiced_at))}</span></div></div><dl class="data">${info('Payment remarks code', o.payment_request?.unique_code || 'Not issued')}${info('Code expires', date(o.payment_request?.expires_at))}</dl><h2 class="section-gap">Payment proof</h2>${o.receipts.length ? o.receipts.map((r, i) => `<div><img class="receipt" src="${e(r.signed_url)}" alt="Payment receipt ${i + 1}" loading="lazy"><a class="receipt-link" href="${e(r.signed_url)}" target="_blank" rel="noopener noreferrer">Open original receipt ${i + 1} ↗ <span class="sub">Uploaded ${e(date(r.uploaded_at))} · link valid for 5 minutes</span></a></div>`).join('') : '<p class="form-note">The captain has not uploaded a receipt.</p>'}</section>
 <section class="surface panel"><h2>Registered teams</h2>${o.items.length ? o.items.map((i) => `<div class="team-row">${i.logo_url ? `<img class="team-logo" src="${e(i.logo_url)}" alt="${e(i.team_name)} logo">` : `<span class="team-initial" aria-hidden="true">${e(i.team_name[0])}</span>`}<div><div class="strong">${e(i.team_name)}</div><p>${e(i.sport_name)} · ${money(i.price_at_purchase)}</p><p>${i.players.length ? e(i.players.join(', ')) : 'Roster not added yet'}</p><span class="status ${i.profile_completed_at ? 'confirmed' : ''}">${i.profile_completed_at ? 'Profile complete' : 'Profile pending'}</span></div></div>`).join('') : '<p>No sports selected yet.</p>'}</section>
 <section class="surface panel"><h2>Email activity</h2>${o.email_jobs.length ? o.email_jobs.map((j) => `<p>${status(j.status)} ${e(human(j.kind))} <span class="sub">${e(date(j.created_at))} · ${j.attempts} attempt(s) ${j.last_error ? '· ' + e(j.last_error) : ''}</span></p>`).join('') : '<p class="form-note">Confirmation is queued when every team has completed its profile.</p>'}${o.email_log.map((l) => `<p>${status(l.status)} ${e(l.sent_to)}<span class="sub">${e(date(l.created_at))} ${l.provider_message_id ? '· ' + e(l.provider_message_id) : ''}</span></p>`).join('')}</section></div>
 <div class="stack"><section class="surface panel"><h2>Next action</h2><form id="order-action"><label>Review / contact notes<textarea name="notes" maxlength="2000" placeholder="Record payment discrepancies or contact details"></textarea></label><div class="actions">${o.status === 'receipt_submitted' ? '<button name="action" value="review">Start review</button>' : ''}${reviewable ? '<button class="primary" name="action" value="confirmed">Confirm payment</button><button class="danger" name="action" value="rejected">Reject payment</button>' : ''}${o.status === 'confirmed' ? '<button class="primary" name="action" value="contact">Mark contacted</button>' : ''}${o.status === 'contacted' ? '<button class="primary" name="action" value="complete">Mark completed</button>' : ''}${allDone ? '<button name="action" value="resend-email">Resend confirmation</button>' : ''}${me.role === 'super_admin' && o.status !== 'cancelled' ? '<button class="danger" name="action" value="cancel">Cancel order</button>' : ''}</div><p class="form-note section-gap">Rejection and cancellation require notes. Payment confirmation unlocks team profiles.</p></form></section>
 <section class="surface panel"><h2>Order timeline</h2><ol class="timeline">${o.timeline.map((t) => `<li>${e(human(t.to_status))}<span class="sub">${e(date(t.changed_at))}</span></li>`).join('')}</ol></section>
 ${o.verifications.length ? `<section class="surface panel"><h2>Verification notes</h2>${o.verifications.map((v) => `<p>${status(v.decision)}<span class="sub">${e(date(v.verified_at))}</span>${e(v.notes || 'No notes')}</p>`).join('')}</section>` : ''}
 ${o.audit_log.length ? `<section class="surface panel"><h2>Organizer activity</h2>${o.audit_log.map((a) => `<p>${e(human(a.action.replace('order.', '')))}<span class="sub">${e(date(a.created_at))}</span>${e(a.metadata.notes || a.metadata.reason || '')}</p>`).join('')}</section>` : ''}</div></div>`,
    bind() {
      document.querySelectorAll('.receipt').forEach((img) =>
        img.addEventListener('error', () => {
          img.hidden = true;
        }),
      );
      bindForm('#order-action', async (b, _form, button) => {
        const action = button?.value;
        if (!action) return;
        if (['rejected', 'cancel'].includes(action) && !b.notes.trim())
          throw new Error('Add notes explaining this decision.');
        if (
          action === 'cancel' &&
          !window.confirm(
            'Cancel this registration? Any published teams on this order will be removed from the public listing.',
          )
        )
          return;
        if (['confirmed', 'rejected'].includes(action))
          await post(`/admin/orders/${id}/verify`, { decision: action, notes: b.notes });
        else
          await post(
            `/admin/orders/${id}/${action}`,
            action === 'cancel'
              ? { reason: b.notes }
              : action === 'contact'
                ? { notes: b.notes }
                : {},
          );
        await render();
        message(action === 'resend-email' ? 'Confirmation email queued.' : 'Registration updated.');
      });
    },
  };
}
async function sportsView() {
  const sports = await api('/admin/sports');
  const sportForm = (s, isNew = false) =>
    `<form class="surface sport-form" data-id="${e(s.id || '')}"><div class="form-grid">${field('Sport name', 'name', s.name, 'text', 'required maxlength="120"')}${field('Registration price', 'price', s.price, 'number', 'required min="0" step="0.01" max="9999999999.99"')}<label class="full">Description<textarea name="description" maxlength="5000">${e(s.description)}</textarea></label><label class="check"><input name="active" type="checkbox" ${isNew || s.active ? 'checked' : ''}> Open for registration</label></div><div class="form-footer"><button class="primary">${isNew ? 'Add sport' : 'Save changes'}</button><p class="form-note">${isNew ? 'Set the price before opening registration.' : 'New prices apply to future invoices.'}</p></div></form>`;
  return {
    html: `${header('Sports & pricing', 'Set registration prices and control which sports are open.', 'EVENT SETTINGS')}<div class="edit-list">${sports.map((s) => sportForm(s)).join('')}</div><h2 class="section-title section-gap">Add a sport</h2><div class="edit-list">${sportForm({}, true)}</div>`,
    bind() {
      bindForm('.sport-form', async (b, form) => {
        const id = form.dataset.id;
        await api(id ? `/admin/sports/${id}` : '/admin/sports', {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify({ ...b, active: b.active === 'on' }),
        });
        await render();
        message(id ? 'Sport updated.' : 'Sport added.');
      });
    },
  };
}
async function eventView() {
  const v = (await api('/admin/event')) || {};
  const localDate = (s) =>
    s
      ? new Date(new Date(s).getTime() - new Date(s).getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      : '';
  return {
    html: `${header('Event details', 'Keep the public event information accurate and up to date.', 'EVENT SETTINGS')}<section class="surface panel"><form id="event-form"><div class="form-grid"><div class="full">${field('Event title', 'title', v.title, 'text', 'required maxlength="200"')}</div><label class="full">Description<textarea name="description" required maxlength="20000">${e(v.description)}</textarea></label>${field('Starts (your local time)', 'start_date', localDate(v.start_date), 'datetime-local', 'required')}${field('Ends (your local time)', 'end_date', localDate(v.end_date), 'datetime-local', 'required')}<div class="full">${field('Venue', 'venue', v.venue, 'text', 'required maxlength="500"')}</div></div><div class="form-footer"><button class="primary">Save event details</button><p class="form-note">Changes appear on the public event page immediately.</p></div></form></section>`,
    bind() {
      bindForm('#event-form', async (b) => {
        await api('/admin/event', {
          method: 'PATCH',
          body: JSON.stringify({
            ...b,
            start_date: new Date(b.start_date).toISOString(),
            end_date: new Date(b.end_date).toISOString(),
          }),
        });
        message('Event details saved.');
      });
    },
  };
}
async function usersView(params) {
  const q = new URLSearchParams(params);
  q.set('limit', '25');
  const data = await api(`/admin/users?${q}`);
  const offset = Number(q.get('offset') || 0);
  return {
    html: `${header('Captains', 'Find contact details and registration history.', 'PEOPLE')}<section class="surface"><form class="toolbar" id="user-search"><label>Search captains<input name="search" value="${e(q.get('search'))}" placeholder="Name, email or phone"></label><button class="primary">Search</button></form>${data.users.length ? `<div class="table-scroll"><table><thead><tr><th>Captain</th><th>Email</th><th>Phone</th><th>Joined</th></tr></thead><tbody>${data.users.map((u) => `<tr><td><a href="#user/${u.id}" class="strong">${e(u.name)}</a></td><td>${e(u.email)}</td><td>${e(u.phone || 'Not provided')}</td><td>${e(date(u.created_at))}</td></tr>`).join('')}</tbody></table></div>` : empty('No captains found.', 'Try a different name, email or phone number.')}<div class="pagination"><span>Showing ${data.users.length ? offset + 1 : 0}–${offset + data.users.length}</span><div><button id="prev" ${offset === 0 ? 'disabled' : ''}>Previous</button> <button id="next" ${data.users.length < 25 ? 'disabled' : ''}>Next</button></div></div></section>`,
    bind() {
      bindForm('#user-search', async (b) => {
        location.hash = `users?${new URLSearchParams(b)}`;
      });
      document.querySelector('#prev').onclick = () => {
        q.set('offset', String(Math.max(0, offset - 25)));
        location.hash = `users?${q}`;
      };
      document.querySelector('#next').onclick = () => {
        q.set('offset', String(offset + 25));
        location.hash = `users?${q}`;
      };
    },
  };
}
async function userDetail(id) {
  const u = await api(`/admin/users/${id}`);
  return {
    html: `<a class="back" href="#users">← All captains</a>${header(u.name, `${u.email} · ${u.phone || 'No phone provided'}`, 'CAPTAIN PROFILE')}<section class="surface"><div class="table-scroll"><table><thead><tr><th>Order</th><th>Amount</th><th>Status</th><th>Created</th></tr></thead><tbody>${u.orders.map((o) => `<tr><td><a class="mono" href="#order/${o.id}">${e(o.id)}</a></td><td>${o.total_amount === null ? '—' : money(o.total_amount)}</td><td>${status(o.status)}</td><td>${e(date(o.created_at))}</td></tr>`).join('')}</tbody></table></div>${!u.orders.length ? empty('No registrations yet.', 'This captain has signed in but has not started an order.') : ''}</section>`,
  };
}
async function adminsView() {
  const admins = await api('/admin/admins');
  return {
    html: `${header('Organizers', 'Manage who can review registrations and change event settings.', 'WORKSPACE ACCESS')}<div class="edit-list">${admins.map((a) => `<form class="surface organizer-form" data-id="${a.id}"><div class="form-grid"><div><span class="strong">${e(a.name || a.email)}</span><span class="sub">${e(a.email)}</span></div><label>Role<select name="role"><option value="staff" ${a.role === 'staff' ? 'selected' : ''}>Staff</option><option value="super_admin" ${a.role === 'super_admin' ? 'selected' : ''}>Super admin</option></select></label><label class="check"><input type="checkbox" name="active" ${a.active ? 'checked' : ''}> Active access</label></div><div class="form-footer"><button>Save access</button></div></form>`).join('')}</div><h2 class="section-title section-gap">Invite an organizer</h2><section class="surface panel"><form id="invite-form"><div class="form-grid">${field('Google account email', 'email', '', 'email', 'required')}<label>Role<select name="role"><option value="staff">Staff</option><option value="super_admin">Super admin</option></select></label></div><div class="form-footer"><button class="primary">Add to allowlist</button><p class="form-note">They can sign in with this Google account immediately. No invitation email is sent.</p></div></form></section>`,
    bind() {
      bindForm('.organizer-form', async (b, form) => {
        await api(`/admin/admins/${form.dataset.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ ...b, active: b.active === 'on' }),
        });
        me = await api('/admin/me');
        navigation();
        await render();
        message('Organizer access updated.');
      });
      bindForm('#invite-form', async (b) => {
        await post('/admin/admins', b);
        await render();
        message('Organizer added to the allowlist.');
      });
    },
  };
}
async function render() {
  if (!me) return login();
  const version = ++viewVersion;
  const [path, params = ''] = location.hash.slice(1).split('?');
  const [section = 'orders', id] = path ? path.split('/') : ['orders'];
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === (section === 'order' ? 'orders' : section === 'user' ? 'users' : section))
      a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  main.setAttribute('aria-busy', 'true');
  try {
    let view;
    if (section === 'orders') view = await queue(params);
    else if (section === 'order' && id) view = await orderDetail(id);
    else if (section === 'users') view = await usersView(params);
    else if (section === 'user' && id) view = await userDetail(id);
    else if (section === 'sports') view = await sportsView();
    else if (section === 'event') view = await eventView();
    else if (section === 'admins') view = await adminsView();
    else throw new Error('This page does not exist.');
    if (version !== viewVersion) return;
    main.innerHTML = `<div class="view-entry">${view.html}</div>`;
    view.bind?.();
    document.title = `${main.querySelector('h1')?.textContent || 'Event desk'} · Ronb Events`;
  } catch (err) {
    if (version === viewVersion && me)
      main.innerHTML = `<section class="error-page"><h2>Could not open this page</h2><p>${e(err.message)}</p><a href="#orders">Return to registrations</a></section>`;
  } finally {
    if (version === viewVersion) main.removeAttribute('aria-busy');
  }
}
window.addEventListener('hashchange', () => {
  notice.hidden = true;
  void render();
});
try {
  me = await api('/admin/me');
  navigation();
  await render();
} catch (err) {
  login();
  if (!err.message.includes('Sign in') && !err.message.includes('Session'))
    message(err.message, true);
}
