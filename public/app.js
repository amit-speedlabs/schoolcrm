/* GLF AI Olympiad 2026 CRM - single-page front end (no build step). */
'use strict';

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('en-IN');
const num = (v) => nf.format(Number(v || 0));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const fdate = (d) => { if (!d) return ''; const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${Number(dd)} ${MONTHS[Number(m) - 1]} ${y}`; };
const fdt = (t) => { if (!t) return 'Never'; const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`; };
const yesno = (b) => `<span class="pill ${b ? 'yes' : 'no'}">${b ? 'YES' : 'NO'}</span>`;
const NONE = '__none__';

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'glf-crm' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/auth')) { showLogin(); throw new Error('Session expired'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.data = data; throw e; }
  return data;
}
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.className = `toast${isErr ? ' err' : ''}`;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 4500);
}
function modal(html, onMount) {
  $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden');
  if (onMount) onMount($('#modalBody'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; }
document.addEventListener('click', (e) => { if (e.target.matches('[data-close]') || e.target.id === 'modal') closeModal(); });

// ------------------------------------------------------------------ state
const S = { user: null, lookups: null };
const isAdmin = () => S.user?.access_role === 'ADMIN';

function parseHash() {
  const h = location.hash.slice(1) || '/dashboard';
  const [path, qs] = h.split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), q: Object.fromEntries(new URLSearchParams(qs || '')) };
}
function go(path, q = {}) {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v !== undefined && v !== null)).toString();
  location.hash = `#${path}${qs ? `?${qs}` : ''}`;
}
const FILTER_KEYS = ['state', 'district', 'city', 'channel', 'partner', 'spoc', 'kit', 'registered', 'board', 'date_field', 'date_from', 'date_to', 'q'];
const pickFilters = (q) => Object.fromEntries(FILTER_KEYS.filter((k) => q[k]).map((k) => [k, q[k]]));
const qstr = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null)).toString();

// ------------------------------------------------------------------ boot / auth
async function boot() {
  try { S.user = (await api('/auth/me')).user; } catch { S.user = null; }
  if (!S.user) return showLogin();
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#userBox').textContent = `${S.user.name} · ${S.user.access_role}`;
  await refreshLookups();
  refreshStatus();
  setInterval(refreshStatus, 60000);
  render();
}
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/auth/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
    $('#loginError').textContent = ''; boot();
  } catch (err) { $('#loginError').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); location.hash = ''; showLogin(); });

async function refreshLookups() {
  S.lookups = await api('/lookups');
  $('#demoBanner').classList.toggle('hidden', !S.lookups.demo.demo);
  $('#demoBanner').textContent = S.lookups.demo.real ? 'CONTAINS DEMO DATA' : 'DEMO DATA';
}
async function refreshStatus() {
  try {
    const s = await api('/integration/status');
    const b = $('#syncBadge');
    const label = { CONNECTED: 'CONNECTED', SYNC_ERROR: 'SYNC ERROR', NOT_SYNCED: 'NOT SYNCED', NOT_CONFIGURED: 'NO SOURCES' }[s.overall];
    b.className = `sync-badge pill ${s.overall === 'CONNECTED' ? 'ok' : s.overall === 'SYNC_ERROR' ? 'err' : 'warn'}`;
    b.textContent = `Google Sheets: ${label} · Last sync ${s.last_successful_sync ? fdt(s.last_successful_sync) : 'never'}${s.open_reviews ? ` · ${s.open_reviews} to review` : ''}`;
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ nav / router
const NAV = [
  ['dashboard', 'Dashboard'], ['schools', 'Schools'], ['teachers', 'Teachers'], ['kits', 'Kit Distribution'],
  ['registrations', 'Registrations'], ['enrolment', 'Student Enrolment'], ['reports', 'Reports'], ['sep'],
  ['integrations', 'Integrations'], ['users', 'Users'], ['settings', 'Settings'],
];
function renderNav(active) {
  $('#nav').innerHTML = NAV.map(([k, l]) => (k === 'sep' ? '<div class="sep"></div>' : `<a href="#/${k}" class="${k === active ? 'active' : ''}">${l}</a>`)).join('');
}
const VIEWS = {};
async function render() {
  if (!S.user) return;
  const { parts, q } = parseHash();
  const name = parts[0] || 'dashboard';
  renderNav(name === 'school' ? 'schools' : name);
  const view = $('#view');
  const fn = VIEWS[name] || VIEWS.dashboard;
  try { await fn(view, parts.slice(1), q); } catch (e) { view.innerHTML = `<div class="panel error">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', render);

// ------------------------------------------------------------------ filter bar
function options(list, sel, { all = 'All', none = false } = {}) {
  return `<option value="">${all}</option>${none ? `<option value="${NONE}" ${sel === NONE ? 'selected' : ''}>Not set</option>` : ''}` +
    list.map(([v, l]) => `<option value="${esc(v)}" ${String(sel) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');
}
const uniq = (a) => [...new Set(a.filter(Boolean))].sort((x, y) => x.localeCompare(y));
function filterBar(q, { search = false } = {}) {
  const L = S.lookups; const geo = L.geo;
  const states = uniq(geo.map((g) => g.state));
  const districts = uniq(geo.filter((g) => !q.state || g.state === q.state).map((g) => g.district));
  const cities = uniq(geo.filter((g) => (!q.state || g.state === q.state) && (!q.district || g.district === q.district)).map((g) => g.city));
  const partners = L.partners.filter((p) => !q.channel || String(p.channel_id) === q.channel);
  const spocs = L.users.filter((u) => u.access_role === 'NONE' || /spoc|sales/i.test(`${u.role} ${u.team}`));
  return `<form class="filters" id="filters">
    ${search ? `<label style="grid-column: span 2">Search<input name="q" value="${esc(q.q || '')}" placeholder="School, ID, city, principal, coordinator, phone, email"></label>` : ''}
    <label>State<select name="state">${options(states.map((s) => [s, s]), q.state, { none: true })}</select></label>
    <label>District<select name="district">${options(districts.map((s) => [s, s]), q.district, { none: true })}</select></label>
    <label>City<select name="city">${options(cities.map((s) => [s, s]), q.city, { none: true })}</select></label>
    <label>Channel<select name="channel">${options(L.channels.map((c) => [c.channel_id, c.name + (c.is_active ? '' : ' (inactive)')]), q.channel, { none: true })}</select></label>
    <label>Partner<select name="partner">${options(partners.map((p) => [p.partner_id, p.name]), q.partner, { none: true })}</select></label>
    <label>Sales SPOC<select name="spoc">${options(spocs.map((u) => [u.user_id, u.name]), q.spoc, { none: true })}</select></label>
    <label>Kit Status<select name="kit">${options([['yes', 'Kit given'], ['no', 'No kit']], q.kit)}</select></label>
    <label>School Registration<select name="registered">${options([['yes', 'Registered'], ['no', 'Not registered']], q.registered)}</select></label>
    <label>Board<select name="board">${options(L.boards.map((b) => [b, b]), q.board, { none: true })}</select></label>
    <label>Date applies to<select name="date_field">${options([['kit', 'Kit drop date'], ['registration', 'Registration date'], ['student', 'Student registration date']], q.date_field || 'kit', { all: 'Kit drop date' }).replace('<option value="">Kit drop date</option>', '')}</select></label>
    <label>From<input type="date" name="date_from" value="${esc(q.date_from || '')}"></label>
    <label>To<input type="date" name="date_to" value="${esc(q.date_to || '')}"></label>
    <div class="actions"><button type="button" class="btn small" id="clearFilters">Clear</button></div>
  </form>`;
}
function bindFilters(path, q, keep = {}) {
  const form = $('#filters'); if (!form) return;
  const apply = () => {
    const fd = Object.fromEntries(new FormData(form));
    // cascade: changing a parent clears children
    if (fd.state !== (q.state || '')) { fd.district = ''; fd.city = ''; }
    if (fd.district !== (q.district || '')) fd.city = '';
    if (fd.channel !== (q.channel || '')) fd.partner = '';
    if (fd.date_field === 'kit') delete fd.date_field;
    go(path, { ...keep, ...fd });
  };
  form.addEventListener('change', (e) => { if (e.target.name !== 'q') apply(); });
  const qi = form.querySelector('[name=q]');
  if (qi) { let t; qi.addEventListener('input', () => { clearTimeout(t); t = setTimeout(apply, 400); }); qi.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }); }
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  $('#clearFilters').addEventListener('click', () => go(path, keep));
  if (qi && q.q) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
}
function activeFilterText(q) {
  const L = S.lookups; const f = pickFilters(q); const out = [];
  const nameOf = (list, id, key, label) => (id === NONE ? 'Not set' : (list.find((x) => String(x[key]) === String(id)) || {})[label] || id);
  for (const [k, v] of Object.entries(f)) {
    if (k === 'date_field') continue;
    let val = v === NONE ? 'Not set' : v;
    if (k === 'channel') val = nameOf(L.channels, v, 'channel_id', 'name');
    if (k === 'partner') val = nameOf(L.partners, v, 'partner_id', 'name');
    if (k === 'spoc') val = nameOf(L.users, v, 'user_id', 'name');
    if (k === 'kit') val = v === 'yes' ? 'Kit given' : 'No kit';
    if (k === 'registered') val = v === 'yes' ? 'Registered' : 'Not registered';
    out.push(`${k.replace('_', ' ')}: ${val}`);
  }
  return out.join(' · ');
}

// ------------------------------------------------------------------ charts (plain HTML bars)
function hbars(rows, { label, value, fmt = num, max } = {}) {
  const m = max || Math.max(1, ...rows.map((r) => r[value]));
  if (!rows.length) return '<div class="muted">No data for the selected filters.</div>';
  return `<div class="bars">${rows.map((r) => `<div class="bar-row"><div title="${esc(r[label])}" style="overflow:hidden;text-overflow:ellipsis">${esc(r[label])}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${(r[value] / m) * 100}%"></div></div><div class="num">${fmt(r[value])}</div></div>`).join('')}</div>`;
}
function gradeColumns(m) {
  const g = [3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ n, v: m[`grade_${n}`] || 0 }));
  const max = Math.max(1, ...g.map((x) => x.v));
  return `<div class="cols">${g.map((x) => `<div class="col"><div class="c-val">${num(x.v)}</div><div class="c-bar" style="height:${(x.v / max) * 100}%"></div><div class="c-lab">Grade ${x.n}</div></div>`).join('')}</div>`;
}

// ------------------------------------------------------------------ breakdown table
const METRIC_COLS = [
  ['schools', 'Schools'], ['kits_distributed', 'Kits Distributed'], ['registered_schools', 'Registered Schools'], ['students', 'Students'],
];
const EXTRA_COLS = [['total_kits', 'No of Kits'], ['kit_coverage_pct', 'Kit Coverage %'], ['registration_pct', 'Registration %'], ['kit_to_registration_pct', 'Kit→Reg %']];
function breakdownTable(rows, { firstCol, sort, dir, extra = true, onSortAttr = 'data-bsort', rowAttr }) {
  const cols = [...METRIC_COLS, ...(extra ? EXTRA_COLS : [])];
  const th = (k, l, cls = '') => `<th class="sortable ${cls} ${sort === k ? `sorted ${dir}` : ''}" ${onSortAttr}="${k}">${l}</th>`;
  const tot = rows.reduce((a, r) => { for (const [k] of cols) a[k] = (a[k] || 0) + (k.endsWith('_pct') ? 0 : r[k]); return a; }, {});
  const pctF = (v) => `${v}%`;
  return `<div class="table-wrap"><table><thead><tr>${th('label', firstCol)}${cols.map(([k, l]) => th(k, l, 'num')).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr class="${rowAttr ? 'clickable' : ''}" ${rowAttr ? rowAttr(r) : ''}><td>${esc(r.label)}${r.parent && firstCol !== 'State' ? ` <span class="muted small">${esc(r.parent)}</span>` : ''}</td>
      ${cols.map(([k]) => `<td class="num">${k.endsWith('_pct') ? pctF(r[k]) : num(r[k])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length + 1}" class="muted">No data for the selected filters.</td></tr>`}</tbody>
    ${rows.length > 1 ? `<tfoot><tr><td>Total</td>${cols.map(([k]) => `<td class="num">${k.endsWith('_pct') ? '' : num(tot[k])}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`;
}

// ------------------------------------------------------------------ DASHBOARD
VIEWS.dashboard = async (view, _p, q) => {
  const f = qstr(pickFilters(q));
  const [m, byState, byChannel] = await Promise.all([
    api(`/dashboard/metrics?${f}`), api(`/dashboard/breakdown/state?${f}&sort=schools&dir=desc`), api(`/dashboard/breakdown/channel?${f}&sort=schools&dir=desc`),
  ]);
  const ft = activeFilterText(q);
  view.innerHTML = `
    <div class="page-head"><div><h1>Management Dashboard</h1><div class="muted small">${ft ? `Filtered: ${esc(ft)}` : 'All schools'}</div></div></div>
    ${filterBar(q)}
    <div class="kpis">
      <div class="kpi"><div class="label">TOTAL SCHOOLS</div><div class="value">${num(m.schools)}</div><div class="sub">in CRM</div></div>
      <div class="kpi"><div class="label">KIT DISTRIBUTED</div><div class="value">${num(m.kits_distributed)}</div><div class="sub">${num(m.total_kits)} kits · ${m.kit_coverage_pct}% coverage</div></div>
      <div class="kpi"><div class="label">SCHOOLS REGISTERED</div><div class="value">${num(m.registered_schools)}</div><div class="sub">${m.registration_pct}% of schools</div></div>
      <div class="kpi"><div class="label">STUDENT REGISTRATIONS</div><div class="value">${num(m.students)}</div><div class="sub">from ${num(m.schools_with_students)} schools</div></div>
    </div>
    <div class="kpis secondary">
      <div class="kpi"><div class="label">KIT COVERAGE</div><div class="value">${m.kit_coverage_pct}%</div><div class="sub">schools with kit / total</div></div>
      <div class="kpi"><div class="label">SCHOOL REGISTRATION</div><div class="value">${m.registration_pct}%</div><div class="sub">registered / total</div></div>
      <div class="kpi"><div class="label">KIT → REGISTRATION</div><div class="value">${m.kit_to_registration_pct}%</div><div class="sub">registered with kit / with kit</div></div>
      <div class="kpi"><div class="label">AVG STUDENTS / REG. SCHOOL</div><div class="value">${m.avg_students_per_registered_school}</div><div class="sub">students / registered schools</div></div>
      <div class="kpi"><div class="label">TOTAL KITS</div><div class="value">${num(m.total_kits)}</div><div class="sub">sum of No of Kits</div></div>
    </div>
    <div class="grid2">
      <div class="panel"><h3>Funnel</h3>
        <div class="bars funnel">
          ${[['Total schools', m.schools, 's1', ''], ['Kit distributed', m.kits_distributed, 's2', `${m.kit_coverage_pct}%`], ['School registered', m.registered_schools, 's3', `${m.registration_pct}%`], ['Schools with students', m.schools_with_students, 's4', `${num(m.students)} students`]]
            .map(([l, v, c, s]) => `<div class="bar-row"><div>${l}</div><div class="bar-track"><div class="bar-fill ${c}" style="width:${m.schools ? (v / m.schools) * 100 : 0}%"></div></div><div class="num"><b>${num(v)}</b> <span class="muted small">${s}</span></div></div>`).join('')}
        </div></div>
      <div class="panel"><h3>Student registrations by grade</h3>${gradeColumns(m)}</div>
      <div class="panel"><h3>States <span class="muted small" style="text-transform:none">click to drill down</span></h3>
        ${breakdownTable(byState, { firstCol: 'State', extra: false, rowAttr: (r) => `data-go="${esc(r.key)}"` })}</div>
      <div class="panel"><h3>Channels <span class="muted small" style="text-transform:none">click for partners</span></h3>
        ${breakdownTable(byChannel, { firstCol: 'Channel', extra: false, rowAttr: (r) => `data-ch="${esc(r.key)}"` })}</div>
      <div class="panel"><h3>Kits distributed by channel</h3>${hbars(byChannel.filter((r) => r.kits_distributed), { label: 'label', value: 'kits_distributed' })}</div>
      <div class="panel"><h3>Student registrations by state</h3>${hbars(byState.filter((r) => r.students).sort((a, b) => b.students - a.students), { label: 'label', value: 'students' })}</div>
    </div>`;
  bindFilters('/dashboard', q);
  $$('[data-go]').forEach((tr) => tr.addEventListener('click', () => go('/reports/geo', { ...pickFilters(q), state: tr.dataset.go })));
  $$('[data-ch]').forEach((tr) => tr.addEventListener('click', () => go('/reports/channel', { ...pickFilters(q), channel: tr.dataset.ch })));
};

// ------------------------------------------------------------------ SCHOOL TABLES
const ALL_COLS = {
  school_id: ['School ID', (r) => `<a href="#/school/${esc(r.school_id)}">${esc(r.school_id)}</a>`],
  school_name: ['School Name', (r) => `<a href="#/school/${esc(r.school_id)}">${esc(r.school_name)}</a>${r.is_demo ? ' <span class="pill warn">DEMO</span>' : ''}`],
  state: ['State'], district: ['District'], city: ['City'], board: ['Board'],
  principal_name: ['Principal'], principal_contact: ['Principal Contact'], coordinator_name: ['Coordinator'], coordinator_phone: ['Coordinator Phone'],
  channel: ['Channel'], partner: ['Partner'], sales_spoc: ['Sales SPOC'],
  kit_given: ['Kit Given', (r) => yesno(r.kit_given)], kit_drop_date: ['Kit Drop Date', (r) => fdate(r.kit_drop_date)], number_of_kits: ['No of Kits', (r) => num(r.number_of_kits ?? ''), 'num'],
  school_registered: ['School Registered', (r) => yesno(r.school_registered)], registration_date: ['Registration Date', (r) => fdate(r.registration_date)],
  ...Object.fromEntries([3, 4, 5, 6, 7, 8, 9, 10].map((g) => [`grade_${g}`, [`Grade ${g}`, (r) => num(r[`grade_${g}`]), 'num']])),
  total_students: ['Total Students', (r) => `<b>${num(r.total_students)}</b>`, 'num'],
};
const PRESETS = {
  schools: { title: 'Schools', cols: ['school_id', 'school_name', 'state', 'district', 'city', 'board', 'principal_name', 'coordinator_name', 'channel', 'partner', 'sales_spoc', 'kit_given', 'kit_drop_date', 'number_of_kits', 'school_registered', 'grade_3', 'grade_4', 'grade_5', 'grade_6', 'grade_7', 'grade_8', 'grade_9', 'grade_10', 'total_students'] },
  kits: { title: 'Kit Distribution', cols: ['school_id', 'school_name', 'state', 'district', 'city', 'channel', 'partner', 'sales_spoc', 'kit_given', 'kit_drop_date', 'number_of_kits'], sub: 'Kit Given is calculated automatically from School Kit Drop Date.' },
  registrations: { title: 'School Registrations', cols: ['school_id', 'school_name', 'state', 'district', 'city', 'channel', 'partner', 'sales_spoc', 'kit_given', 'school_registered', 'registration_date', 'total_students'], sub: 'School registration is tracked separately from student registration: a registered school can have zero students.' },
  enrolment: { title: 'Student Enrolment', cols: ['school_id', 'school_name', 'state', 'city', 'channel', 'school_registered', 'grade_3', 'grade_4', 'grade_5', 'grade_6', 'grade_7', 'grade_8', 'grade_9', 'grade_10', 'total_students'], sub: 'Total Students = Grade 3 + … + Grade 10 (calculated).', defaultSort: 'total_students' },
};

async function schoolTable(view, q, presetKey) {
  const P = PRESETS[presetKey];
  const path = `/${presetKey}`;
  const sort = q.sort || P.defaultSort || 'school_id'; const dir = q.dir || (P.defaultSort ? 'desc' : 'asc');
  const page = Number(q.page || 1);
  const f = pickFilters(q);
  const [data, m] = await Promise.all([
    api(`/schools?${qstr({ ...f, sort, dir, page, pageSize: 50 })}`), api(`/dashboard/metrics?${qstr(f)}`),
  ]);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const strip = {
    schools: [['Schools', num(m.schools)], ['Kit given', num(m.kits_distributed)], ['Registered', num(m.registered_schools)], ['Students', num(m.students)]],
    kits: [['Schools with kit', num(m.kits_distributed)], ['Total kits', num(m.total_kits)], ['Kit coverage', `${m.kit_coverage_pct}%`], ['Schools without kit', num(m.schools - m.kits_distributed)]],
    registrations: [['Registered schools', num(m.registered_schools)], ['Registration %', `${m.registration_pct}%`], ['Kit → Registration', `${m.kit_to_registration_pct}%`], ['Not registered', num(m.schools - m.registered_schools)]],
    enrolment: [['Student registrations', num(m.students)], ['Schools with students', num(m.schools_with_students)], ['Avg / registered school', m.avg_students_per_registered_school], ['Grade 3–5', num(m.grade_3 + m.grade_4 + m.grade_5)]],
  }[presetKey];
  view.innerHTML = `
    <div class="page-head"><div><h1>${P.title}</h1><div class="muted small">${P.sub || 'Search, filter, sort and export. Click a school to open its profile.'}</div></div>
      <div class="spacer"></div>
      <div class="btn-row">
        <a class="btn" href="/api/schools/export?${qstr({ ...f, sort, dir, format: 'csv' })}">Export CSV</a>
        <a class="btn" href="/api/schools/export?${qstr({ ...f, sort, dir, format: 'xlsx' })}">Export Excel</a>
        ${isAdmin() && presetKey === 'schools' ? '<button class="btn primary" id="addSchool">Add school</button>' : ''}
      </div></div>
    ${filterBar(q, { search: true })}
    <div class="kpis">${strip.map(([l, v]) => `<div class="kpi"><div class="label">${l.toUpperCase()}</div><div class="value" style="font-size:22px">${v}</div></div>`).join('')}</div>
    ${presetKey === 'enrolment' ? `<div class="panel"><h3>Grade-wise student registrations</h3>${gradeColumns(m)}</div>` : ''}
    <div class="table-wrap"><table><thead><tr>${P.cols.map((c) => `<th class="sortable ${ALL_COLS[c][2] || ''} ${sort === c ? `sorted ${dir}` : ''}" data-sort="${c}">${ALL_COLS[c][0]}</th>`).join('')}</tr></thead>
      <tbody>${data.rows.map((r) => `<tr>${P.cols.map((c) => `<td class="${ALL_COLS[c][2] || ''}">${ALL_COLS[c][1] ? ALL_COLS[c][1](r) : esc(r[c] ?? '')}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${P.cols.length}" class="muted">No schools match these filters.</td></tr>`}</tbody></table></div>
    <div class="pager"><span class="muted">${num(data.total)} schools · page ${page} of ${pages}</span><div class="spacer"></div>
      <button class="btn small" id="prev" ${page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn small" id="next" ${page >= pages ? 'disabled' : ''}>Next</button></div>`;
  const keep = { sort: q.sort, dir: q.dir };
  bindFilters(path, q, keep);
  $$('[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const c = th.dataset.sort; go(path, { ...f, sort: c, dir: sort === c && dir === 'asc' ? 'desc' : 'asc' });
  }));
  $('#prev').onclick = () => go(path, { ...f, ...keep, page: page - 1 });
  $('#next').onclick = () => go(path, { ...f, ...keep, page: page + 1 });
  if ($('#addSchool')) $('#addSchool').onclick = () => schoolForm(null);
}
VIEWS.schools = (v, p, q) => schoolTable(v, q, 'schools');
VIEWS.kits = (v, p, q) => schoolTable(v, q, 'kits');
VIEWS.registrations = (v, p, q) => schoolTable(v, q, 'registrations');
VIEWS.enrolment = (v, p, q) => schoolTable(v, q, 'enrolment');

// ------------------------------------------------------------------ SCHOOL PROFILE
VIEWS.school = async (view, [id]) => {
  const s = await api(`/schools/${encodeURIComponent(id)}`);
  const kv = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v === '' || v === null || v === undefined ? '<span class="muted">—</span>' : v}</dd>`).join('')}</dl>`;
  const e = esc;
  const current = s.student_registrations.filter((r) => !r.is_superseded);
  view.innerHTML = `
    <div class="page-head"><div><div class="muted small"><a href="#/schools">Schools</a> / ${e(s.school_id)}</div>
      <h1>${e(s.school_name)} ${s.is_demo ? '<span class="pill warn">DEMO DATA</span>' : ''}</h1>
      <div class="muted">${e([s.city, s.district, s.state].filter(Boolean).join(', '))}</div></div><div class="spacer"></div>
      ${isAdmin() ? '<div class="btn-row"><button class="btn" id="editSchool">Edit</button><button class="btn" id="addStudents">Add student registration</button></div>' : ''}</div>
    <div class="profile-grid">
      <div class="panel"><h3>School information</h3>${kv([
        ['School ID', `<b>${e(s.school_id)}</b>`], ['School Name', e(s.school_name)], ['Board', e(s.board)], ['State', e(s.state)],
        ['District', `${e(s.district || '')}${s.district_origin ? ` <span class="muted small">(${s.district_origin === 'LOOKUP' ? 'derived from city' : s.district_origin.toLowerCase()})</span>` : ''}`],
        ['City', e(s.city)], ['Address', e(s.address)], ['PIN Code', e(s.pin_code)], ['Principal', e(s.principal_name)], ['Principal Contact', e(s.principal_contact)],
        ['School Email', s.school_email ? `<a href="mailto:${e(s.school_email)}">${e(s.school_email)}</a>` : ''], ['Coordinator', e(s.coordinator_name)], ['Coordinator Phone', e(s.coordinator_phone)]])}</div>
      <div>
        <div class="panel"><h3>Kit information</h3>${kv([
          ['Kit Given', yesno(s.kit_given)], ['Kit Drop Date', fdate(s.kit_drop_date)], ['No of Kits', s.number_of_kits ?? ''],
          ['Channel', e(s.channel || '')], ['Partner', e(s.partner || '')], ['Sales SPOC', e(s.sales_spoc || '')]])}</div>
        <div class="panel"><h3>Registration</h3>${kv([
          ['School Registered', yesno(s.school_registered)], ['Registration Date', fdate(s.registration_date)],
          ['Registration Source', e(s.registration_source || '')], ['Last Registration Sync', s.last_registration_sync ? fdt(s.last_registration_sync) : '']])}</div>
      </div>
      <div class="panel"><h3>Student registration</h3>
        <table><tbody>${[3, 4, 5, 6, 7, 8, 9, 10].map((g) => `<tr><td>Grade ${g}</td><td class="num">${num(s[`grade_${g}`])}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total Students</td><td class="num">${num(s.total_students)}</td></tr></tfoot></table>
        <div class="muted small" style="margin-top:8px">${current.length} current response(s)${s.student_registrations.length > current.length ? `, ${s.student_registrations.length - current.length} superseded by newer responses` : ''}.</div></div>
      <div class="panel"><h3>Source information</h3>${kv([
        ['Source', e(s.source)], ['Source Sheet', e(s.source_sheet || '')], ['Source Row', s.source_row ?? ''], ['Last Synced', s.last_synced_at ? fdt(s.last_synced_at) : ''],
        ['Created', `${fdt(s.created_at)} <span class="muted small">${e(s.created_by || '')}</span>`], ['Updated', `${fdt(s.updated_at)} <span class="muted small">${e(s.updated_by || '')}</span>`]])}
        ${s.source_links.length ? `<h3 style="margin-top:14px">Linked sheet rows</h3><table><tbody>${s.source_links.map((l) => `<tr><td>${e(l.source_name)}</td><td class="muted">${e(l.sheet_name)} row ${l.source_row}</td></tr>`).join('')}</tbody></table>` : ''}</div>
    </div>
    ${s.student_registrations.length ? `<div class="panel"><h3>Student registration responses</h3><div class="table-wrap"><table><thead><tr><th>Date</th><th>Source</th><th>Row</th>${[3, 4, 5, 6, 7, 8, 9, 10].map((g) => `<th class="num">G${g}</th>`).join('')}<th class="num">Total</th><th>Status</th></tr></thead><tbody>
      ${s.student_registrations.map((r) => `<tr><td>${fdate(r.registration_date)}</td><td>${e(r.source_name || r.source)}</td><td>${r.source_row ?? ''}</td>${[3, 4, 5, 6, 7, 8, 9, 10].map((g) => `<td class="num">${r[`grade_${g}_count`]}</td>`).join('')}<td class="num"><b>${r.total_students}</b></td><td>${r.is_superseded ? '<span class="pill no">superseded</span>' : '<span class="pill ok">counted</span>'}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="panel"><h3>Contacts</h3><table><thead><tr><th>Type</th><th>Name</th><th>Phone</th><th>Address</th></tr></thead><tbody>
      ${s.contacts.map((c) => `<tr><td>${e(c.contact_type)}</td><td>${e(c.name)}</td><td>${e(c.phone)}</td><td>${e(c.address)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No contacts</td></tr>'}</tbody></table></div>
    <div class="panel"><h3>Change history</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>Field</th><th>Old value</th><th>New value</th><th>Changed by</th></tr></thead><tbody>
      ${s.audit.map((a) => `<tr><td>${fdt(a.changed_at)}</td><td>${e(a.field || a.action)}</td><td class="muted">${e(a.old_value ?? '')}</td><td>${e(a.new_value ?? '')}</td><td class="muted small">${e(a.changed_by)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No changes recorded</td></tr>'}</tbody></table></div></div>`;
  if ($('#editSchool')) $('#editSchool').onclick = () => schoolForm(s);
  if ($('#addStudents')) $('#addStudents').onclick = () => studentForm(s);
};

function schoolForm(s) {
  const L = S.lookups; const e = (k) => esc(s?.[k] ?? '');
  const inp = (k, l, type = 'text') => `<label>${l}<input name="${k}" type="${type}" value="${type === 'date' ? esc((s?.[k] || '').slice(0, 10)) : e(k)}"></label>`;
  modal(`<h2>${s ? `Edit ${esc(s.school_id)}` : 'Add school'}</h2>
    ${s && s.source !== 'MANUAL' ? '<div class="notice">This school is synced from Google Sheets. Fields that come from the sheet (name, contacts, kit date, channel, SPOC…) will be overwritten by the next sync unless they are also changed in the sheet. District, Partner and Registration are CRM-managed when the sheet has no such column.</div>' : ''}
    <form id="sf"><div class="form-grid">
      ${inp('school_name', 'School Name *')}${inp('board', 'Board')}${inp('state', 'State')}${inp('district', 'District')}${inp('city', 'City')}${inp('pin_code', 'PIN Code')}
      <label style="grid-column:1/-1">Address<input name="address" value="${e('address')}"></label>
      ${inp('principal_name', 'Principal')}${inp('principal_contact', 'Principal Contact')}${inp('school_email', 'School Email', 'email')}
      ${inp('coordinator_name', 'Coordinator')}${inp('coordinator_phone', 'Coordinator Phone')}
      ${inp('kit_drop_date', 'Kit Drop Date', 'date')}${inp('number_of_kits', 'No of Kits', 'number')}
      <label>Channel<select name="channel_id">${options(L.channels.filter((c) => c.is_active || c.channel_id === s?.channel_id).map((c) => [c.channel_id, c.name]), s?.channel_id, { all: '—' })}</select></label>
      <label>Partner<select name="partner_id">${options(L.partners.filter((p) => p.is_active || p.partner_id === s?.partner_id).map((p) => [p.partner_id, `${p.name}${p.channel_name ? ` (${p.channel_name})` : ''}`]), s?.partner_id, { all: '—' })}</select></label>
      <label>Sales SPOC<select name="sales_spoc_id">${options(L.users.filter((u) => u.status === 'ACTIVE' || u.user_id === s?.sales_spoc_id).map((u) => [u.user_id, u.name]), s?.sales_spoc_id, { all: '—' })}</select></label>
      <label>School Registered<select name="school_registered">${options([['YES', 'YES'], ['NO', 'NO']], s ? (s.school_registered ? 'YES' : 'NO') : 'NO', { all: '—' })}</select></label>
      ${inp('registration_date', 'Registration Date', 'date')}
    </div><div id="sfErr" class="error"></div><div class="btn-row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (root) => {
    $('#sf', root).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = Object.fromEntries(new FormData(ev.target));
      for (const k of Object.keys(body)) if (body[k] === '' && !s) delete body[k];
      if (body.school_registered === '') delete body.school_registered;
      try {
        const out = s ? await api(`/schools/${s.school_id}`, { method: 'PATCH', body }) : await api('/schools', { method: 'POST', body });
        closeModal(); toast(s ? 'School updated' : `Created ${out.school_id}`); await refreshLookups(); s ? render() : go(`/school/${out.school_id}`);
      } catch (err) {
        if (err.data?.candidates) {
          $('#sfErr').innerHTML = `Possible duplicate of: ${err.data.candidates.map((c) => `<a href="#/school/${esc(c.school_id)}" data-close>${esc(c.school_id)} ${esc(c.school_name)} (${esc(c.city || '')})</a> – ${esc(c.reasons.join(', '))}`).join('; ')}
            <br><button type="button" class="btn small" id="forceCreate">Not a duplicate – create anyway</button>`;
          $('#forceCreate').onclick = async () => {
            try { const out = await api('/schools', { method: 'POST', body: { ...body, confirm_not_duplicate: true } }); closeModal(); toast(`Created ${out.school_id}`); await refreshLookups(); go(`/school/${out.school_id}`); } catch (e2) { $('#sfErr').textContent = e2.message; }
          };
        } else $('#sfErr').textContent = err.data?.errors ? err.data.errors.join('; ') : err.message;
      }
    });
  });
}
function studentForm(s) {
  modal(`<h2>Add student registration – ${esc(s.school_name)}</h2><p class="muted small">Normally these come from the Student Registration form/sheet. Use this for registrations received outside the form. Total is calculated automatically.</p>
    <form id="stf"><div class="form-grid"><label>Registration Date<input type="date" name="registration_date"></label>
    ${[3, 4, 5, 6, 7, 8, 9, 10].map((g) => `<label>Grade ${g}<input type="number" min="0" step="1" name="grade_${g}_count" value="0"></label>`).join('')}</div>
    <div>Total: <b id="stTotal">0</b></div><div id="stErr" class="error"></div><div class="btn-row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (root) => {
    const f = $('#stf', root);
    f.addEventListener('input', () => { $('#stTotal').textContent = num($$('input[type=number]', f).reduce((a, i) => a + (Number(i.value) || 0), 0)); });
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try { await api(`/schools/${s.school_id}/student-registrations`, { method: 'POST', body: Object.fromEntries(new FormData(f)) }); closeModal(); toast('Student registration added'); render(); } catch (err) { $('#stErr').textContent = err.data?.errors ? err.data.errors.join('; ') : err.message; }
    });
  });
}

// ------------------------------------------------------------------ TEACHERS
VIEWS.teachers = async (view, _p, q) => {
  const rows = await api(`/contacts?${qstr(pickFilters(q))}`);
  view.innerHTML = `<div class="page-head"><div><h1>Teachers &amp; Coordinators</h1><div class="muted small">V1 shows the principal and coordinator from the School Master. The database supports multiple teachers per school for later.</div></div></div>
    ${filterBar(q, { search: true })}
    <div class="table-wrap"><table><thead><tr><th>School ID</th><th>School</th><th>State</th><th>City</th><th>Role</th><th>Name</th><th>Phone</th><th>Address</th></tr></thead><tbody>
    ${rows.map((c) => `<tr><td><a href="#/school/${esc(c.school_id)}">${esc(c.school_id)}</a></td><td>${esc(c.school_name)}</td><td>${esc(c.state)}</td><td>${esc(c.city)}</td><td>${esc(c.contact_type)}</td><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${esc(c.address)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No contacts</td></tr>'}</tbody></table></div>`;
  bindFilters('/teachers', q);
};

// ------------------------------------------------------------------ REPORTS (drill-downs)
VIEWS.reports = async (view, [tab = 'geo'], q) => {
  const tabs = [['geo', 'Geography'], ['channel', 'Channel → Partner'], ['spoc', 'Sales SPOC'], ['board', 'Board']];
  const f = pickFilters(q);
  const sort = q.bsort || 'schools'; const dir = q.bdir || 'desc';
  let level; let crumbs = []; let title;
  const base = `/reports/${tab}`;
  if (tab === 'geo') {
    level = f.city ? 'school' : f.district ? 'city' : f.state ? 'district' : 'state';
    crumbs = [['All states', { ...f, state: '', district: '', city: '' }]];
    if (f.state) crumbs.push([f.state === NONE ? 'State not set' : f.state, { ...f, district: '', city: '' }]);
    if (f.district) crumbs.push([f.district === NONE ? 'District not set' : f.district, { ...f, city: '' }]);
    if (f.city) crumbs.push([f.city === NONE ? 'City not set' : f.city, f]);
    title = { state: 'State', district: 'District', city: 'City' }[level];
  } else if (tab === 'channel') {
    level = f.partner ? 'school' : f.channel ? 'partner' : 'channel';
    const ch = S.lookups.channels.find((c) => String(c.channel_id) === f.channel);
    const pa = S.lookups.partners.find((p) => String(p.partner_id) === f.partner);
    crumbs = [['All channels', { ...f, channel: '', partner: '' }]];
    if (f.channel) crumbs.push([f.channel === NONE ? 'Channel not set' : ch?.name || f.channel, { ...f, partner: '' }]);
    if (f.partner) crumbs.push([f.partner === NONE ? 'Partner not set' : pa?.name || f.partner, f]);
    title = { channel: 'Channel', partner: 'Partner' }[level];
  } else { level = tab; title = tab === 'spoc' ? 'Sales SPOC' : 'Board'; }

  const m = await api(`/dashboard/metrics?${qstr(f)}`);
  let body;
  if (level === 'school') {
    const data = await api(`/schools?${qstr({ ...f, pageSize: 500, sort: 'school_name' })}`);
    body = `<div class="table-wrap"><table><thead><tr><th>School ID</th><th>School</th><th>City</th><th>Channel</th><th>Partner</th><th>Kit Given</th><th class="num">No of Kits</th><th>Registered</th><th class="num">Students</th></tr></thead><tbody>
      ${data.rows.map((r) => `<tr class="clickable" data-school="${esc(r.school_id)}"><td>${esc(r.school_id)}</td><td>${esc(r.school_name)}</td><td>${esc(r.city)}</td><td>${esc(r.channel)}</td><td>${esc(r.partner)}</td><td>${yesno(r.kit_given)}</td><td class="num">${r.number_of_kits ?? ''}</td><td>${yesno(r.school_registered)}</td><td class="num">${num(r.total_students)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No schools</td></tr>'}</tbody></table></div>`;
  } else {
    const rows = await api(`/dashboard/breakdown/${level}?${qstr({ ...f, sort, dir })}`);
    body = breakdownTable(rows, { firstCol: title, sort, dir, rowAttr: tab === 'geo' || tab === 'channel' || tab === 'spoc' || tab === 'board' ? (r) => `data-key="${esc(r.key)}"` : null });
  }
  view.innerHTML = `<div class="page-head"><div><h1>Reports</h1><div class="muted small">Factual activity and conversion metrics only. Click a row to drill down.</div></div><div class="spacer"></div>
      <a class="btn" href="/api/schools/export?${qstr({ ...f, format: 'xlsx' })}">Export schools (Excel)</a></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/reports/${k}?${qstr(f)}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
    ${filterBar(q)}
    ${crumbs.length ? `<div class="crumbs">${crumbs.map(([l, fq], i) => (i === crumbs.length - 1 ? `<b>${esc(l)}</b>` : `<a href="#${base}?${qstr(fq)}">${esc(l)}</a><span class="sep">›</span>`)).join('')}</div>` : ''}
    <div class="kpis">${[['Schools', num(m.schools)], ['Kits distributed', `${num(m.kits_distributed)} <span class="muted small">(${m.kit_coverage_pct}%)</span>`], ['Registered schools', `${num(m.registered_schools)} <span class="muted small">(${m.registration_pct}%)</span>`], ['Students', num(m.students)]]
      .map(([l, v]) => `<div class="kpi"><div class="label">${l.toUpperCase()}</div><div class="value" style="font-size:22px">${v}</div></div>`).join('')}</div>
    ${body}`;
  bindFilters(base, q);
  $$('[data-bsort]').forEach((th) => th.addEventListener('click', () => { const c = th.dataset.bsort; go(base, { ...f, bsort: c, bdir: sort === c && dir === 'desc' ? 'asc' : 'desc' }); }));
  $$('[data-school]').forEach((tr) => tr.addEventListener('click', () => go(`/school/${tr.dataset.school}`)));
  $$('[data-key]').forEach((tr) => tr.addEventListener('click', () => {
    const k = tr.dataset.key;
    if (tab === 'geo') go(base, { ...f, [level]: k });
    else if (tab === 'channel') go(base, { ...f, [level]: k });
    else go('/schools', { ...f, [tab]: k });
  }));
};

// ------------------------------------------------------------------ INTEGRATIONS
const TYPE_LABEL = { SCHOOL_MASTER: 'School Master', SCHOOL_REGISTRATION: 'School Registration', STUDENT_REGISTRATION: 'Student Registration', KIT_DISTRIBUTION: 'Kit Distribution', COMBINED_REGISTRATION: 'School + Student Registration' };
const connPill = (s) => (s.status === 'DISABLED' ? '<span class="pill no">DISABLED</span>' : { CONNECTED: '<span class="pill ok">CONNECTED</span>', SYNC_ERROR: '<span class="pill err">SYNC ERROR</span>', NOT_SYNCED: '<span class="pill warn">NOT SYNCED</span>', SYNCING: '<span class="pill info">SYNCING</span>' }[s.connection_status]);
VIEWS.integrations = async (view) => {
  const [st, sources, reviews] = await Promise.all([api('/integration/status'), api('/sources'), api('/reviews')]);
  const overall = { CONNECTED: ['CONNECTED', 'ok'], SYNC_ERROR: ['SYNC ERROR', 'err'], NOT_SYNCED: ['NOT SYNCED', 'warn'], NOT_CONFIGURED: ['NO SOURCES', 'warn'] }[st.overall];
  view.innerHTML = `<div class="page-head"><div><h1>Google Sheets Integrations</h1><div class="muted small">Google Forms → Google Sheets → Sheets API → normalisation → central database → CRM. Dashboards never query Sheets directly.</div></div>
      <div class="spacer"></div>${isAdmin() ? '<div class="btn-row"><button class="btn" id="addSource">Add source</button><button class="btn primary" id="syncAll">SYNC NOW (all)</button></div>' : ''}</div>
    ${!st.google_credentials_configured ? '<div class="notice">Google service-account credentials are not configured on the server (GOOGLE_SERVICE_ACCOUNT_JSON). Google sources cannot sync until they are; demo/fixture sources still work.</div>' : ''}
    <div class="grid2" style="margin-bottom:16px"><div class="panel"><h3>Google Integration Status</h3><div class="status-big"><span class="pill ${overall[1]}" style="font-size:16px">${overall[0]}</span></div>
      <div style="margin-top:10px">Last Successful Sync: <b>${st.last_successful_sync ? fdt(st.last_successful_sync) : 'Never'}</b></div>
      <div class="muted small">${st.sources} enabled source(s)${st.errors ? ` · ${st.errors} with errors` : ''}</div></div>
      <div class="panel"><h3>Admin review queue</h3><div class="status-big">${reviews.length}</div><div class="muted small">rows that could be duplicates or did not match any school. They are not added until reviewed.</div></div></div>
    <div class="panel"><h3>Sources</h3><div class="table-wrap"><table><thead><tr><th>Source Name</th><th>Spreadsheet / Sheet</th><th>Source Type</th><th>Status</th><th>Last Sync</th><th>Last Result</th></tr></thead><tbody>
      ${sources.map((s) => `<tr><td><b>${esc(s.source_name)}</b>${s.is_demo ? ' <span class="pill warn">DEMO</span>' : ''}<div class="muted small">every ${s.sync_frequency_minutes} min${s.writeback_enabled ? ' · writes School ID back' : ''}</div><div class="btn-row" style="margin-top:6px">${isAdmin() ? `<button class="btn small" data-act="test" data-id="${s.source_id}">Test</button><button class="btn small" data-act="sync" data-id="${s.source_id}" ${s.status === 'DISABLED' ? 'disabled' : ''}>Sync now</button>
          <button class="btn small" data-act="toggle" data-id="${s.source_id}">${s.status === 'ENABLED' ? 'Disable' : 'Enable'}</button><button class="btn small" data-act="edit" data-id="${s.source_id}">Edit</button>` : ''}
          <button class="btn small" data-act="logs" data-id="${s.source_id}">Logs &amp; errors</button></div></td>
        <td>${s.adapter === 'google' ? `<a href="https://docs.google.com/spreadsheets/d/${esc(s.spreadsheet_id)}" target="_blank" rel="noopener">${esc(s.spreadsheet_id.slice(0, 14))}…</a>` : `<span class="muted">fixture: ${esc(s.spreadsheet_id)}</span>`}<div class="small">${esc(s.sheet_name)}</div></td><td>${TYPE_LABEL[s.source_type]}</td><td>${connPill(s)}</td>
        <td>${s.last_sync ? fdt(s.last_sync) : 'Never'}${s.connection_status === 'SYNC_ERROR' ? `<div class="small">Last successful: ${s.last_successful_sync ? fdt(s.last_successful_sync) : 'never'}</div>` : ''}</td>
        <td class="wrap small" style="min-width:220px">${s.last_error ? `<span style="color:var(--bad)">${esc(s.last_error)}</span>` : esc(s.last_log?.message || '')}${s.open_reviews ? ` <span class="pill warn">${s.open_reviews} to review</span>` : ''}</td>
</tr>`).join('') || '<tr><td colspan="6" class="muted">No sources yet. Add the School Master sheet first.</td></tr>'}</tbody></table></div></div>
    <div class="panel"><h3>Review: possible duplicates &amp; unmatched rows</h3>
      ${reviews.length ? `<div class="table-wrap"><table><thead><tr><th>Source</th><th>Row</th><th>Type</th><th>Incoming</th><th>Candidates</th>${isAdmin() ? '<th>Resolve</th>' : ''}</tr></thead><tbody>
      ${reviews.map((r) => `<tr><td>${esc(r.source_name)}</td><td>${r.source_row}</td><td>${r.kind === 'POSSIBLE_DUPLICATE' ? '<span class="pill warn">Possible duplicate</span>' : '<span class="pill info">No match</span>'}</td>
        <td class="wrap"><b>${esc(r.incoming.school_name || '')}</b><div class="muted small">${esc([r.incoming.city, r.incoming.state, r.incoming.school_email, r.incoming.principal_contact].filter(Boolean).join(' · '))}</div></td>
        <td class="wrap">${r.candidates.map((c) => `<div><a href="#/school/${esc(c.school_id)}">${esc(c.school_id)}</a> ${esc(c.school_name)} <span class="muted small">(${esc(c.city || '')}) score ${c.score}: ${esc(c.reasons.join(', '))}</span>
          ${isAdmin() ? ` <button class="btn small" data-link="${r.review_id}" data-school="${esc(c.school_id)}">Link</button>` : ''}</div>`).join('') || '<span class="muted">none</span>'}</td>
        ${isAdmin() ? `<td><div class="btn-row"><button class="btn small" data-linkother="${r.review_id}">Link to ID…</button><button class="btn small" data-create="${r.review_id}">Create new school</button><button class="btn small danger" data-dismiss="${r.review_id}">Dismiss</button></div></td>` : ''}</tr>`).join('')}</tbody></table></div>` : '<div class="muted">Nothing to review.</div>'}</div>`;

  const run = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); } catch (e) { toast(e.message, true); } await refreshLookups(); refreshStatus(); render(); };
  if ($('#syncAll')) $('#syncAll').onclick = (e) => { e.target.disabled = true; e.target.textContent = 'Syncing…'; run(() => api('/sync-all', { method: 'POST' }), (r) => `Synced ${r.length} source(s): ${r.map((x) => `${x.source_name} ${x.status}`).join(', ')}`); };
  if ($('#addSource')) $('#addSource').onclick = () => sourceForm(null);
  $$('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.id; const s = sources.find((x) => String(x.source_id) === id);
    if (b.dataset.act === 'sync') { b.disabled = true; b.textContent = 'Syncing…'; run(() => api(`/sources/${id}/sync`, { method: 'POST' }), (r) => `${s.source_name}: ${r.status}. ${r.message || ''}`); }
    if (b.dataset.act === 'toggle') run(() => api(`/sources/${id}`, { method: 'PATCH', body: { status: s.status === 'ENABLED' ? 'DISABLED' : 'ENABLED' } }));
    if (b.dataset.act === 'edit') sourceForm(s);
    if (b.dataset.act === 'logs') showLogs(s);
    if (b.dataset.act === 'test') {
      b.disabled = true; b.textContent = 'Testing…';
      const r = await api(`/sources/${id}/test`, { method: 'POST' }).catch((e) => ({ ok: false, error: e.message }));
      b.disabled = false; b.textContent = 'Test';
      modal(r.ok ? `<h2>Connection OK</h2><p>${esc(r.title)} · ${r.rows} data rows</p><h3>Column mapping</h3><table><tbody>${r.mapped.map((m) => `<tr><td>${esc(m.header)}</td><td>→ <code>${esc(m.field)}</code></td></tr>`).join('')}</tbody></table>
        ${r.unmapped.length ? `<h3 style="margin-top:12px">Ignored columns</h3><div class="muted">${r.unmapped.map(esc).join(', ')}</div><p class="small muted">Map them via the source's column mapping or Settings → Field mapping.</p>` : ''}`
        : `<h2>Connection failed</h2><div class="error">${esc(r.error)}</div>`);
    }
  }));
  const resolve = (id, action, schoolId) => run(() => api(`/reviews/${id}/resolve`, { method: 'POST', body: { action, school_id: schoolId } }), (r) => `Review ${r.review.status.toLowerCase().replace('_', ' ')}${r.review.resolved_school_id ? ` → ${r.review.resolved_school_id}` : ''}`);
  $$('[data-link]').forEach((b) => b.addEventListener('click', () => resolve(b.dataset.link, 'link', b.dataset.school)));
  $$('[data-linkother]').forEach((b) => b.addEventListener('click', () => { const id = prompt('Link this row to School ID (e.g. SCH000123):'); if (id) resolve(b.dataset.linkother, 'link', id.trim().toUpperCase()); }));
  $$('[data-create]').forEach((b) => b.addEventListener('click', () => { if (confirm('Create a new school (new School ID) from this row?')) resolve(b.dataset.create, 'create'); }));
  $$('[data-dismiss]').forEach((b) => b.addEventListener('click', () => { if (confirm('Dismiss this row? It will be ignored until it changes in the sheet.')) resolve(b.dataset.dismiss, 'dismiss'); }));
};
async function showLogs(s) {
  const logs = await api(`/sources/${s.source_id}/logs`);
  modal(`<h2>Sync history – ${esc(s.source_name)}</h2><div class="table-wrap"><table><thead><tr><th>Started</th><th>By</th><th>Status</th><th class="num">Read</th><th class="num">New</th><th class="num">Upd.</th><th class="num">Review</th><th class="num">Rejected</th><th>Message</th><th></th></tr></thead><tbody>
    ${logs.map((l) => `<tr><td>${fdt(l.started_at)}</td><td class="small">${esc(l.triggered_by)}</td><td><span class="pill ${l.status === 'SUCCESS' ? 'ok' : l.status === 'FAILED' ? 'err' : 'warn'}">${l.status}</span></td>
      <td class="num">${l.rows_read}</td><td class="num">${l.rows_created}</td><td class="num">${l.rows_updated}</td><td class="num">${l.rows_flagged}</td><td class="num">${l.rows_errored}</td><td class="wrap small">${esc(l.message || '')}${l.unmapped_headers?.length ? `<div class="muted">Ignored columns: ${esc(l.unmapped_headers.join(', '))}</div>` : ''}</td>
      <td><button class="btn small" data-issues="${l.sync_id}">Row issues</button></td></tr>`).join('') || '<tr><td colspan="10" class="muted">No syncs yet</td></tr>'}</tbody></table></div><div id="issues"></div>`, (root) => {
    $$('[data-issues]', root).forEach((b) => b.addEventListener('click', async () => {
      const is = await api(`/sync-logs/${b.dataset.issues}/issues`);
      $('#issues').innerHTML = `<h3 style="margin-top:14px">Row issues for sync #${b.dataset.issues}</h3><table><thead><tr><th>Row</th><th>Severity</th><th>Field</th><th>Message</th></tr></thead><tbody>
        ${is.map((i) => `<tr><td>${i.source_row ?? ''}</td><td><span class="pill ${i.severity === 'ERROR' ? 'err' : 'warn'}">${i.severity}</span></td><td>${esc(i.field || '')}</td><td class="wrap">${esc(i.message)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No issues</td></tr>'}</tbody></table>`;
    }));
  });
}
function sourceForm(s) {
  const v = (k, d = '') => esc(s?.[k] ?? d);
  modal(`<h2>${s ? 'Edit source' : 'Add Google Sheet source'}</h2>
    <p class="muted small">Share the spreadsheet with the service account email (Editor if School ID write-back is enabled, otherwise Viewer). Credentials stay on the server.</p>
    <form id="srcf"><div class="form-grid">
      <label>Source Name *<input name="source_name" value="${v('source_name')}" required></label>
      <label>Source Type *<select name="source_type">${Object.entries(TYPE_LABEL).map(([k, l]) => `<option value="${k}" ${s?.source_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label style="grid-column:1/-1">Spreadsheet URL or ID *<input name="spreadsheet_id" value="${v('spreadsheet_id')}" required placeholder="https://docs.google.com/spreadsheets/d/…"></label>
      <label>Sheet (tab) name *<input name="sheet_name" value="${v('sheet_name', 'Form Responses 1')}" required></label>
      <label>Header row<input name="header_row" type="number" min="1" value="${v('header_row', 1)}"></label>
      <label>Sync every (minutes)<input name="sync_frequency_minutes" type="number" min="1" value="${v('sync_frequency_minutes', 15)}"></label>
      <label>Date format in sheet<select name="date_format">${['DMY', 'MDY', 'YMD'].map((d) => `<option ${s?.date_format === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
      <label>Multiple student responses per school<select name="student_mode"><option value="LATEST" ${s?.student_mode !== 'SUM' ? 'selected' : ''}>Latest response replaces earlier</option><option value="SUM" ${s?.student_mode === 'SUM' ? 'selected' : ''}>Add all responses</option></select></label>
      <label>Write School ID back to sheet<select name="writeback_enabled"><option value="false">No</option><option value="true" ${s?.writeback_enabled ? 'selected' : ''}>Yes (School Master only)</option></select></label>
      <label style="grid-column:1/-1">Google Form URL (optional)<input name="form_url" value="${v('form_url')}" placeholder="https://forms.gle/…"></label>
      <label style="grid-column:1/-1">Column mapping overrides (JSON, optional)<textarea name="column_mapping" rows="3" placeholder='{"Name of Institution": "school_name", "Remarks": "__ignore__"}'>${s ? esc(JSON.stringify(s.column_mapping || {})) : ''}</textarea></label>
    </div><div id="srcErr" class="error"></div><div class="btn-row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (root) => {
    $('#srcf', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target));
      b.writeback_enabled = b.writeback_enabled === 'true'; b.header_row = Number(b.header_row); b.sync_frequency_minutes = Number(b.sync_frequency_minutes);
      b.column_mapping = b.column_mapping.trim() || '{}';
      if (!s) b.adapter = 'google';
      try { await (s ? api(`/sources/${s.source_id}`, { method: 'PATCH', body: b }) : api('/sources', { method: 'POST', body: b })); closeModal(); toast('Source saved. Use Test, then Sync now.'); render(); } catch (err) { $('#srcErr').textContent = err.message; }
    });
  });
}

// ------------------------------------------------------------------ USERS
VIEWS.users = async (view) => {
  const users = await api('/users');
  view.innerHTML = `<div class="page-head"><div><h1>Users</h1><div class="muted small">User Master. Sales SPOCs are selected from here. Only ADMIN and MANAGEMENT users can sign in.</div></div><div class="spacer"></div>${isAdmin() ? '<button class="btn primary" id="addUser">Add user</button>' : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Team</th><th>Role</th><th>CRM Access</th><th>State</th><th>City</th><th>Status</th><th>Source</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
    ${users.map((u) => `<tr><td>${u.user_id}</td><td>${esc(u.name)}${u.is_demo ? ' <span class="pill warn">DEMO</span>' : ''}</td><td>${esc(u.email || '')}</td><td>${esc(u.team || '')}</td><td>${esc(u.role || '')}</td>
      <td>${u.access_role === 'NONE' ? '<span class="muted">No login</span>' : `<span class="pill info">${u.access_role}</span>`}</td><td>${esc(u.state || '')}</td><td>${esc(u.city || '')}</td>
      <td><span class="pill ${u.status === 'ACTIVE' ? 'ok' : 'no'}">${u.status}</span></td><td class="small muted">${u.created_via === 'SYNC' ? 'from sheet' : u.created_via.toLowerCase()}</td>
      ${isAdmin() ? `<td><button class="btn small" data-edit="${u.user_id}">Edit</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  const form = (u) => modal(`<h2>${u ? 'Edit user' : 'Add user'}</h2><form id="uf"><div class="form-grid">
      ${[['name', 'Name *'], ['email', 'Email'], ['team', 'Team'], ['role', 'Role / title'], ['state', 'State'], ['city', 'City']].map(([k, l]) => `<label>${l}<input name="${k}" value="${esc(u?.[k] ?? '')}"></label>`).join('')}
      <label>CRM access<select name="access_role">${['NONE', 'MANAGEMENT', 'ADMIN'].map((r) => `<option ${(u?.access_role || 'NONE') === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label>Status<select name="status">${['ACTIVE', 'INACTIVE'].map((r) => `<option ${(u?.status || 'ACTIVE') === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label>${u?.has_password ? 'New password (leave blank to keep)' : 'Password (needed for login)'}<input name="password" type="password" autocomplete="new-password"></label>
      <label style="grid-column:1/-1">Other spellings in sheets (comma separated)<input name="aliases" value="${esc((u?.aliases || []).join(', '))}"></label>
    </div><div id="ufErr" class="error"></div><div class="btn-row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (root) => {
    $('#uf', root).addEventListener('submit', async (e) => {
      e.preventDefault(); const b = Object.fromEntries(new FormData(e.target));
      b.aliases = b.aliases.split(',').map((x) => x.trim()).filter(Boolean); if (!b.password) delete b.password;
      try { await (u ? api(`/users/${u.user_id}`, { method: 'PATCH', body: b }) : api('/users', { method: 'POST', body: b })); closeModal(); toast('User saved'); await refreshLookups(); render(); } catch (err) { $('#ufErr').textContent = err.data?.errors ? err.data.errors.join('; ') : err.message; }
    });
  });
  if ($('#addUser')) $('#addUser').onclick = () => form(null);
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => form(users.find((u) => String(u.user_id) === b.dataset.edit))));
};

// ------------------------------------------------------------------ SETTINGS
VIEWS.settings = async (view, [tab = 'channels']) => {
  const tabs = [['channels', 'Channels'], ['partners', 'Partners'], ['mapping', 'Field mapping'], ['geo', 'City → District'], ['audit', 'Audit log'], ['data', 'Demo data']];
  const head = `<div class="page-head"><div><h1>Settings</h1></div></div><div class="tabs">${tabs.map(([k, l]) => `<a href="#/settings/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>`;
  const A = isAdmin();
  const reload = async () => { await refreshLookups(); render(); };
  if (tab === 'channels' || tab === 'partners') {
    const isCh = tab === 'channels';
    const rows = isCh ? S.lookups.channels : S.lookups.partners;
    view.innerHTML = `${head}<div class="panel"><h2>${isCh ? 'Channel Master' : 'Partner Master'}</h2>
      <p class="muted small">${isCh ? 'Channels found in sheets are added automatically (marked "from sheet"). Add aliases so spelling variants map to one channel.' : 'Partner is separate from Channel (e.g. Channel CoE → Partner Shivaji University).'}</p>
      ${A ? `<form id="addM" class="btn-row" style="margin-bottom:12px"><input name="name" placeholder="New ${isCh ? 'channel' : 'partner'} name" required>
        ${isCh ? '<input name="aliases" placeholder="Aliases (comma separated)">' : `<select name="channel_id">${options(S.lookups.channels.map((c) => [c.channel_id, c.name]), '', { all: 'Channel…' })}</select>`}<button class="btn primary">Add</button></form>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Name</th>${isCh ? '<th>Aliases</th>' : '<th>Channel</th>'}<th>Status</th><th>Origin</th>${A ? '<th></th>' : ''}</tr></thead><tbody>
      ${rows.map((r) => { const id = isCh ? r.channel_id : r.partner_id; return `<tr><td>${esc(r.name)}${r.is_demo ? ' <span class="pill warn">DEMO</span>' : ''}</td><td>${isCh ? esc((r.aliases || []).join(', ')) : esc(r.channel_name || '')}</td>
        <td><span class="pill ${r.is_active ? 'ok' : 'no'}">${r.is_active ? 'ACTIVE' : 'INACTIVE'}</span></td><td class="small muted">${r.created_via === 'SYNC' ? 'from sheet' : 'manual'}</td>
        ${A ? `<td><div class="btn-row"><button class="btn small" data-ren="${id}">Edit</button><button class="btn small" data-tog="${id}" data-active="${r.is_active}">${r.is_active ? 'Deactivate' : 'Activate'}</button></div></td>` : ''}</tr>`; }).join('')}</tbody></table></div></div>`;
    if ($('#addM')) $('#addM').addEventListener('submit', async (e) => {
      e.preventDefault(); const b = Object.fromEntries(new FormData(e.target));
      if (isCh) b.aliases = (b.aliases || '').split(',').map((x) => x.trim()).filter(Boolean); else b.channel_id = b.channel_id ? Number(b.channel_id) : null;
      try { await api(`/${tab}`, { method: 'POST', body: b }); toast('Added'); reload(); } catch (err) { toast(err.message, true); }
    });
    $$('[data-tog]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/${tab}/${b.dataset.tog}`, { method: 'PATCH', body: { is_active: b.dataset.active !== 'true' } }); reload(); } catch (e) { toast(e.message, true); } }));
    $$('[data-ren]').forEach((b) => b.addEventListener('click', async () => {
      const r = rows.find((x) => String(isCh ? x.channel_id : x.partner_id) === b.dataset.ren);
      const name = prompt('Name', r.name); if (name === null) return;
      const body = { name };
      if (isCh) { const al = prompt('Aliases (comma separated)', (r.aliases || []).join(', ')); if (al !== null) body.aliases = al.split(',').map((x) => x.trim()).filter(Boolean); }
      try { await api(`/${tab}/${b.dataset.ren}`, { method: 'PATCH', body }); reload(); } catch (e) { toast(e.message, true); }
    }));
  } else if (tab === 'mapping') {
    const d = await api('/field-aliases');
    const grouped = d.fields.map((f) => [f, d.aliases.filter((a) => a.canonical_field === f).map((a) => a.alias_norm)]);
    view.innerHTML = `${head}<div class="panel"><h2>Header → field mapping</h2><p class="muted small">Sheet headers are lower-cased and punctuation is ignored before matching. Grade columns like "Grade 3", "Class III" or "No. of students in Std 3" are recognised automatically. Per-source overrides can be set on each integration.</p>
      ${A ? `<form id="addAlias" class="btn-row" style="margin-bottom:12px"><input name="alias" placeholder="Sheet header, e.g. Name of Institution" required style="min-width:280px"><select name="canonical_field">${d.fields.map((f) => `<option>${f}</option>`).join('')}</select><button class="btn primary">Add mapping</button></form>` : ''}
      <div class="table-wrap"><table><thead><tr><th>CRM field</th><th>Recognised sheet headers</th></tr></thead><tbody>
      ${grouped.map(([f, as]) => `<tr><td><code>${f}</code></td><td class="wrap">${as.map((a) => `<span class="pill no" style="margin:2px">${esc(a)}${A ? ` <a href="#" data-del="${esc(a)}" title="remove">×</a>` : ''}</span>`).join('') || (f.startsWith('grade_') ? '<span class="muted small">auto-detected</span>' : '')}</td></tr>`).join('')}</tbody></table></div></div>`;
    if ($('#addAlias')) $('#addAlias').addEventListener('submit', async (e) => { e.preventDefault(); try { await api('/field-aliases', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Mapping added; it applies on the next sync'); render(); } catch (err) { toast(err.message, true); } });
    $$('[data-del]').forEach((a) => a.addEventListener('click', async (e) => { e.preventDefault(); await api(`/field-aliases/${encodeURIComponent(a.dataset.del)}`, { method: 'DELETE' }); render(); }));
  } else if (tab === 'geo') {
    const rows = await api('/geo');
    view.innerHTML = `${head}<div class="panel"><h2>City → District lookup</h2><p class="muted small">The School Master has no District column, so District is derived from State + City using this table (a District column in the sheet, or a manual edit, always wins). Adding a row fills matching schools immediately.</p>
      ${A ? '<form id="addGeo" class="btn-row" style="margin-bottom:12px"><input name="state" placeholder="State" required><input name="city" placeholder="City" required><input name="district" placeholder="District" required><button class="btn primary">Save</button></form>' : ''}
      <div class="table-wrap" style="max-height:60vh"><table><thead><tr><th>State</th><th>City</th><th>District</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.state)}</td><td>${esc(r.city)}</td><td>${esc(r.district)}</td></tr>`).join('')}</tbody></table></div></div>`;
    if ($('#addGeo')) $('#addGeo').addEventListener('submit', async (e) => { e.preventDefault(); try { const r = await api('/geo', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast(`Saved; ${r.schools_updated} school(s) updated`); reload(); } catch (err) { toast(err.message, true); } });
  } else if (tab === 'audit') {
    const rows = A ? await api('/audit') : [];
    view.innerHTML = `${head}<div class="panel"><h2>Audit log</h2>${A ? `<div class="table-wrap" style="max-height:70vh"><table><thead><tr><th>When</th><th>Entity</th><th>Action</th><th>Field</th><th>Old</th><th>New</th><th>By</th></tr></thead><tbody>
      ${rows.map((a) => `<tr><td>${fdt(a.changed_at)}</td><td>${esc(a.entity_type)} ${a.entity_type === 'school' ? `<a href="#/school/${esc(a.entity_id)}">${esc(a.entity_id)}</a>` : esc(a.entity_id)}</td><td>${esc(a.action)}</td><td>${esc(a.field || '')}</td><td class="muted">${esc(a.old_value ?? '')}</td><td>${esc(a.new_value ?? '')}</td><td class="small muted">${esc(a.changed_by)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Admin only.</p>'}</div>`;
  } else if (tab === 'data') {
    const d = S.lookups.demo;
    view.innerHTML = `${head}<div class="panel"><h2>Demo data</h2><p>${num(d.demo)} demo schools · ${num(d.real)} production schools.</p>
      <p class="muted small">Demo rows are flagged and shown with a DEMO label. Remove them before connecting production sheets so demo and production data are never mixed.</p>
      ${A && d.demo ? '<button class="btn danger" id="purge">Delete all demo data</button>' : ''}</div>`;
    if ($('#purge')) $('#purge').onclick = async () => { if (!confirm('Delete all demo schools, demo sources and demo masters? This cannot be undone.')) return; const r = await api('/demo/purge', { method: 'POST' }); toast(`${r.schools_removed} demo schools removed`); reload(); };
  }
};

boot();
