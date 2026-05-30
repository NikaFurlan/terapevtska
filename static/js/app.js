// ── State ─────────────────────────────────────────────────────────────────
const state = { groups: [], members: [], currentGroupId: null, currentDate: null, attendanceData: {}, currentMemberId: null };
const MONTHS_SL = ['januar','februar','marec','april','maj','junij','julij','avgust','september','oktober','november','december'];
const DAYS_SL = ['Ponedeljek','Torek','Sreda','Četrtek','Petek','Sobota','Nedelja'];

// ── Helpers ───────────────────────────────────────────────────────────────
async function api(path, method='GET', body=null) {
  const opts = { method, headers: {'Content-Type':'application/json'} };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
function fmtDate(iso) { if (!iso) return '—'; const [y,m,d]=iso.split('-'); return `${d}.${m}.${y}`; }
function todayISO() { return new Date().toISOString().split('T')[0]; }
function showToast(msg, type='ok') {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className='toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.style.borderLeftColor = type==='err' ? 'var(--red)' : 'var(--green-mid)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}
function openModal(id) { document.getElementById('modal-overlay').classList.add('open'); document.getElementById(id).classList.add('open'); }
function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); document.querySelectorAll('.modal').forEach(m=>m.classList.remove('open')); }

// ── Navigation ────────────────────────────────────────────────────────────
function navigateTo(view) {
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  const el = document.getElementById(`view-${view}`);
  if (el) el.classList.add('active');
  document.querySelectorAll('.nav-links a').forEach(a=>a.classList.toggle('active', a.dataset.view===view));
  if (view==='dashboard') loadDashboard();
  else if (view==='groups') loadGroups();
  else if (view==='members') loadMembers();
  else if (view==='attendance-nav') loadAttendanceNav();
  else if (view==='report') initReport();
  else if (view==='settings') loadSettings();
  else if (view==='audit') loadAudit();
}
document.querySelectorAll('.nav-links a').forEach(a => a.addEventListener('click', e => { e.preventDefault(); navigateTo(a.dataset.view); }));

// Set avatar initial
const uname = document.getElementById('sidebar-avatar');
if (uname) uname.textContent = (uname.closest('.sidebar').querySelector('.sidebar-username')?.textContent||'?')[0].toUpperCase();

// ── Dashboard ─────────────────────────────────────────────────────────────
async function loadDashboard() {
  const data = await api('/api/today');
  document.getElementById('today-dayname').textContent = data.day_name;
  document.getElementById('today-date').textContent = data.today;
  document.getElementById('dashboard-stats').innerHTML = `
    <div class="stat-card"><div class="stat-num">${data.active_members}</div><div class="stat-label">Aktivnih članov</div></div>
    <div class="stat-card"><div class="stat-num">${data.sessions_this_week}</div><div class="stat-label">Sej ta teden</div></div>
    <div class="stat-card ${data.unpaid>0?'warn':''}"><div class="stat-num">${data.unpaid}</div><div class="stat-label">Neplačnikov</div></div>`;
  const todayEl = document.getElementById('today-groups');
  todayEl.innerHTML = data.groups.length
    ? data.groups.map(g=>groupCard(g)).join('')
    : '<p class="empty-state"><span class="empty-icon">◎</span>Danes ni skupin.</p>';
  const allGroups = await api('/api/groups');
  state.groups = allGroups;
  document.getElementById('all-groups-dash').innerHTML = allGroups.map(g=>groupCard(g)).join('');
}

function groupCard(g) {
  return `<div class="group-card" onclick="openAttendance('${g.id}','${todayISO()}')">
    ${g.attendance_done?'<span class="done-badge">✓ Vpisano</span>':''}
    <div class="card-day">${g.day_name||DAYS_SL[g.day_of_week]}</div>
    <div class="card-name">${g.name}</div>
    <div class="card-meta"><span>🕐 ${g.time}</span><span>👥 ${g.member_count||0} / ${g.max_members||12}</span></div>
  </div>`;
}

// ── Groups ────────────────────────────────────────────────────────────────
async function loadGroups() {
  const groups = await api('/api/groups'); state.groups = groups;
  const el = document.getElementById('groups-list');
  if (!groups.length) { el.innerHTML='<p class="empty-state"><span class="empty-icon">◎</span>Ni skupin.</p>'; return; }
  el.innerHTML = groups.map(g=>`
    <div class="group-card">
      <div class="card-day">${DAYS_SL[g.day_of_week]}</div>
      <div class="card-name">${g.name}</div>
      <div class="card-meta"><span>🕐 ${g.time}</span><span>👥 ${g.member_count} / ${g.max_members||12}</span></div>
      <div style="display:flex;gap:.4rem;margin-top:.85rem;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" onclick="openAttendance('${g.id}','${todayISO()}');event.stopPropagation()">Prisotnost</button>
        <button class="btn btn-ghost btn-sm" onclick="showGroupModal('${g.id}');event.stopPropagation()">Uredi</button>
        <button class="btn btn-danger btn-sm" onclick="deleteGroup('${g.id}');event.stopPropagation()">Izbriši</button>
      </div>
    </div>`).join('');
}
function showGroupModal(id) {
  document.getElementById('group-id').value = id||'';
  document.getElementById('modal-group-title').textContent = id?'Uredi skupino':'Nova skupina';
  if (id) {
    const g = state.groups.find(x=>x.id===id);
    if (g) {
      document.getElementById('group-name').value=g.name;
      document.getElementById('group-day').value=g.day_of_week;
      document.getElementById('group-time').value=g.time;
      document.getElementById('group-max-members').value=g.max_members||12;
    }
  } else {
    document.getElementById('group-name').value='';
    document.getElementById('group-time').value='08:00';
    document.getElementById('group-max-members').value='12';
  }
  openModal('modal-group');
}
async function saveGroup() {
  const id = document.getElementById('group-id').value;
  const data = {
    name: document.getElementById('group-name').value,
    day_of_week: parseInt(document.getElementById('group-day').value),
    time: document.getElementById('group-time').value,
    max_members: parseInt(document.getElementById('group-max-members').value),
  };
  try {
    if (id) await api(`/api/groups/${id}`,'PUT',data); else await api('/api/groups','POST',data);
    closeModal();
    showToast('Skupina shranjena.');
    loadGroups();
    if (document.getElementById('view-dashboard').classList.contains('active')) loadDashboard();
  } catch(e) { showToast('Napaka pri shranjevanju.','err'); }
}
async function deleteGroup(id) {
  if (!confirm('Izbriši skupino in vse njene zapise?')) return;
  await api(`/api/groups/${id}`,'DELETE'); loadGroups(); showToast('Skupina izbrisana.');
}

// ── Members ───────────────────────────────────────────────────────────────
async function loadMembers() {
  const members = await api('/api/members'); state.members = members;
  renderMembersList(members);
}

function renderMembersList(members) {
  const el = document.getElementById('members-list');
  if (!members.length) { el.innerHTML='<p class="empty-state"><span class="empty-icon">◉</span>Ni članov.</p>'; return; }
  if (window.innerWidth <= 1024) {
    el.innerHTML = renderMembersMobile(members);
    return;
  }
  el.innerHTML = `<table>
    <thead><tr><th>Ime</th><th>Kontakt</th><th>Skupine</th><th>Ta mesec</th><th>Plačano</th><th>Status</th><th></th></tr></thead>
    <tbody>${members.map(m => {
      const age = m.date_of_birth ? Math.floor((new Date()-new Date(m.date_of_birth))/31557600000)+' let' : '';
      const last = m.last_attendance ? fmtDate(m.last_attendance.date) : '—';
      return `<tr>
        <td><strong style="cursor:pointer;color:var(--green)" onclick="showMemberDetail('${m.id}')">${m.name}</strong>${age?`<br><small style="color:var(--text-3)">${age}</small>`:''}${m.notes?`<br><small style="color:var(--text-3);font-style:italic">${m.notes.substring(0,35)}${m.notes.length>35?'…':''}</small>`:''}</td>
        <td>${m.phone?`<div>📞 ${m.phone}</div>`:''} ${m.email?`<div style="font-size:.78rem;color:var(--text-3)">✉ ${m.email}</div>`:''}</td>
        <td>${(m.groups||[]).map(g=>`<span class="badge badge-green">${g.name}</span>`).join(' ')}</td>
        <td><div style="display:flex;gap:.3rem;flex-wrap:wrap"><span class="badge badge-green">✓ ${m.month_attended}</span>${m.month_excused>0?`<span class="badge badge-amber">○ ${m.month_excused}</span>`:''} ${m.month_unexcused>0?`<span class="badge badge-red">✗ ${m.month_unexcused}</span>`:''}</div><div style="font-size:.72rem;color:var(--text-3);margin-top:.2rem">Zadnji: ${last}</div></td>
        <td><span style="font-weight:700;color:${m.paid_this_month>=m.expected_monthly&&m.expected_monthly>0?'var(--green)':m.paid_this_month>0?'var(--amber,#e6a817)':'var(--red)'};font-size:.9rem">€ ${m.paid_this_month.toFixed(2)}</span>${m.expected_monthly>0?`<br><small style="color:var(--text-3);font-size:.72rem">/ € ${m.expected_monthly.toFixed(2)}</small>`:''}</td>
        <td><span class="badge ${m.status==='active'?'badge-green':'badge-gray'}">${m.status==='active'?'Aktiven':'Neaktiven'}</span></td>
        <td style="white-space:nowrap">
          <button class="btn btn-ghost btn-sm" onclick="showMemberDetail('${m.id}')">Detail</button>
          <button class="btn btn-ghost btn-sm" onclick="showMemberModal('${m.id}')">Uredi</button>
          <button class="btn btn-danger btn-sm" onclick="deleteMember('${m.id}','${m.name.replace(/'/g,"\\'")}')">✕</button>
        </td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

// Silently refresh member state after any mutation and update all visible views
async function refreshMemberState(mid) {
  state.members = await api('/api/members');
  if (document.getElementById('view-members').classList.contains('active')) {
    renderMembersList(state.members);
  }
  if (mid && state.currentMemberId === mid &&
      document.getElementById('view-member-detail').classList.contains('active')) {
    const m = state.members.find(x => x.id === mid);
    if (m) {
      document.getElementById('member-detail-name').textContent = m.name;
      await loadMemberOverview(m);
    }
  }
  if (document.getElementById('view-dashboard').classList.contains('active')) {
    loadDashboard();
  }
}

function renderMembersMobile(members) {
  return members.map(m => {
    const groups = (m.groups||[]).map(g=>`<span class="badge badge-teal" style="font-size:.64rem">${g.name}</span>`).join('');
    const paidColor = m.paid_this_month > 0 ? 'var(--green)' : 'var(--text-3)';
    return `<div class="member-card-mobile" onclick="showMemberDetail('${m.id}')">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:.97rem;margin-bottom:.2rem">${m.name}</div>
          ${m.phone?`<div style="font-size:.82rem;color:var(--text-2)">📞 ${m.phone}</div>`:''}
          ${m.email?`<div style="font-size:.78rem;color:var(--text-3)">✉ ${m.email}</div>`:''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-weight:700;font-size:.95rem;color:${paidColor}">€ ${m.paid_this_month.toFixed(2)}</div>
          <div style="font-size:.68rem;color:var(--text-3);margin-bottom:.2rem">ta mesec</div>
          <span class="badge ${m.status==='active'?'badge-green':'badge-gray'}">${m.status==='active'?'Aktiven':'Neaktiven'}</span>
        </div>
      </div>
      ${groups?`<div style="display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.4rem">${groups}</div>`:''}
      <div style="display:flex;gap:.3rem;align-items:center;margin-top:.5rem">
        <div style="flex:1;display:flex;gap:.3rem;flex-wrap:wrap">
          <span class="badge badge-green">✓ ${m.month_attended}</span>
          ${m.month_excused>0?`<span class="badge badge-amber">○ ${m.month_excused}</span>`:''}
          ${m.month_unexcused>0?`<span class="badge badge-red">✗ ${m.month_unexcused}</span>`:''}
        </div>
        <button class="btn btn-ghost btn-sm" style="min-height:34px;font-size:.75rem" onclick="showMemberModal('${m.id}');event.stopPropagation()">Uredi</button>
      </div>
    </div>`;
  }).join('');
}
async function deleteMember(mid, name) {
  if (!confirm(`Odstrani člana "${name}"?\nIzbrisani bodo vsi zapisi prisotnosti, plačil in kontaktov.`)) return;
  await api(`/api/members/${mid}`,'DELETE'); showToast('Član odstranjen.'); loadMembers();
}
async function showMemberModal(id) {
  const [groups, settings] = await Promise.all([api('/api/groups'), api('/api/settings')]);
  state.groups = groups; state.priceTiers = settings;
  document.getElementById('member-id').value = id||'';
  document.getElementById('modal-member-title').textContent = id?'Uredi člana':'Nov član';
  const checkEl = document.getElementById('member-groups-check');
  checkEl.innerHTML = groups.map(g=>`<label class="checkbox-label"><input type="checkbox" name="mg" value="${g.id}" onchange="updateMemberPricePreview()"> ${g.name}</label>`).join('');
  const fields = ['name','email','phone','dob','address','notes'];
  fields.forEach(f => document.getElementById(`member-${f}`).value = '');
  document.getElementById('member-status').value = 'active';
  if (id) {
    const m = state.members.find(x=>x.id===id)||await api('/api/members').then(ms=>ms.find(x=>x.id===id));
    if (m) {
      document.getElementById('member-name').value = m.name||'';
      document.getElementById('member-email').value = m.email||'';
      document.getElementById('member-phone').value = m.phone||'';
      document.getElementById('member-dob').value = m.date_of_birth||'';
      document.getElementById('member-address').value = m.address||'';
      document.getElementById('member-notes').value = m.notes||'';
      document.getElementById('member-status').value = m.status;
      const gids = (m.groups||[]).map(g=>g.id);
      checkEl.querySelectorAll('input').forEach(cb => cb.checked = gids.includes(cb.value));
    }
  }
  updateMemberPricePreview();
  openModal('modal-member');
}
function updateMemberPricePreview() {
  const checked = [...document.querySelectorAll('#member-groups-check input:checked')].map(cb=>cb.value);
  const totalVisits = (state.groups||[]).filter(g=>checked.includes(g.id))
    .reduce((sum,g)=>sum+(g.sessions_per_week||1),0);
  const t = state.priceTiers||{};
  const prices = [parseFloat(t.tier_price_1||40),parseFloat(t.tier_price_2||70),
                  parseFloat(t.tier_price_3||90),parseFloat(t.tier_price_4plus||110)];
  const el = document.getElementById('member-price-preview');
  if (!el) return;
  if (totalVisits===0) { el.style.display='none'; return; }
  const price = prices[Math.min(totalVisits,4)-1];
  el.textContent = `${totalVisits}× na teden → € ${price.toFixed(2)} / mesec`;
  el.style.display='block';
}
async function saveMember() {
  const id = document.getElementById('member-id').value;
  const data = {
    name: document.getElementById('member-name').value,
    email: document.getElementById('member-email').value,
    phone: document.getElementById('member-phone').value,
    date_of_birth: document.getElementById('member-dob').value,
    address: document.getElementById('member-address').value,
    notes: document.getElementById('member-notes').value,
    status: document.getElementById('member-status').value,
    group_ids: [...document.querySelectorAll('#member-groups-check input:checked')].map(cb=>cb.value),
  };
  // Check capacity only for groups the member is not already in
  const currentGroupIds = id ? ((state.members.find(m=>m.id===id)||{}).groups||[]).map(g=>g.id) : [];
  const newGroupIds = data.group_ids.filter(gid => !currentGroupIds.includes(gid));
  const fullGroups = (state.groups||[]).filter(g => newGroupIds.includes(g.id) && g.member_count >= g.max_members);
  if (fullGroups.length > 0) {
    const names = fullGroups.map(g => `"${g.name}" (${g.member_count}/${g.max_members} članov)`).join('\n');
    if (!confirm(`Naslednje skupine so polne:\n${names}\n\nAli želite člana vseeno dodati?`)) return;
  }
  try {
    if (id) await api(`/api/members/${id}`,'PUT',data); else await api('/api/members','POST',data);
    closeModal();
    showToast('Član shranjen.');
    refreshMemberState(id);
  } catch(e) { showToast('Napaka pri shranjevanju.','err'); }
}

// ── Member Detail ─────────────────────────────────────────────────────────
async function showMemberDetail(mid) {
  state.currentMemberId = mid;
  const members = state.members.length ? state.members : await api('/api/members');
  const m = members.find(x=>x.id===mid); if (!m) return;
  document.getElementById('member-detail-name').textContent = m.name;
  document.getElementById('member-detail-groups').textContent = (m.groups||[]).map(g=>g.name).join(', ')||'Brez skupin';
  document.getElementById('member-detail-edit-btn').onclick = () => showMemberModal(mid);
  // Reset tabs
  document.querySelectorAll('.tab-btn').forEach((b,i)=>b.classList.toggle('active',i===0));
  document.querySelectorAll('.tab-panel').forEach((p,i)=>p.classList.toggle('active',i===0));
  navigateTo('member-detail');
  await loadMemberOverview(m);
}
async function loadMemberOverview(m) {
  const age = m.date_of_birth ? Math.floor((new Date()-new Date(m.date_of_birth))/31557600000) : null;
  const discs = await api(`/api/members/${m.id}/discount`);
  const today = todayISO();
  const activeDiscs = (discs||[]).filter(d => d.valid_from <= today && (!d.valid_to || d.valid_to >= today));
  const discBadge = activeDiscs.length
    ? `<div style="margin-top:.6rem;display:flex;flex-wrap:wrap;gap:.3rem">${activeDiscs.map(d=>`<span class="badge badge-amber">👤 ${d.discount_type==='percent'?d.discount_value+'%':'€ '+parseFloat(d.discount_value).toFixed(2)}${d.reason?' — '+d.reason:''}</span>`).join('')}</div>`
    : '';
  document.getElementById('member-tab-overview').innerHTML = `
    <div class="detail-grid">
      <div class="detail-card">
        <h3>Ta mesec</h3>
        <div style="font-size:2.2rem;font-family:'DM Serif Display',serif;color:var(--green);line-height:1">${m.month_attended}</div>
        <div style="font-size:.78rem;color:var(--text-3);margin-bottom:.75rem">prisotnosti ta mesec</div>
        <div style="display:flex;flex-direction:column;gap:.4rem;font-size:.85rem">
          <div>○ <strong>${m.month_excused}</strong> opravičenih</div>
          <div>✗ <strong>${m.month_unexcused}</strong> neopravičenih</div>
        </div>
        ${m.expected_monthly>0?`<div style="margin-top:.75rem;padding-top:.6rem;border-top:1px solid var(--border)">
          <div style="font-size:.75rem;color:var(--text-3);margin-bottom:.15rem">Mesečnina</div>
          <div style="font-weight:700;font-size:1.05rem;color:${m.paid_this_month>=m.expected_monthly?'var(--green)':'var(--red)'}">€ ${m.paid_this_month.toFixed(2)} <span style="font-weight:400;font-size:.8rem;color:var(--text-3)">/ € ${m.expected_monthly.toFixed(2)}</span></div>
        </div>`:''}
        ${discBadge}
      </div>
      <div class="detail-card">
        <h3>Osebni podatki</h3>
        <div style="display:flex;flex-direction:column;gap:.35rem;font-size:.85rem">
          ${age!==null?`<div>🎂 ${fmtDate(m.date_of_birth)} (${age} let)</div>`:''}
          ${m.address?`<div>📍 ${m.address}</div>`:''}
          <div>📧 ${m.email||'—'}</div>
          <div>📞 ${m.phone||'—'}</div>
          <div style="margin-top:.4rem;padding-top:.4rem;border-top:1px solid var(--border)">Vpisan: ${fmtDate(m.enrollment_date)}</div>
        </div>
      </div>
      <div class="detail-card">
        <h3>Opombe</h3>
        <div style="display:flex;flex-direction:column;gap:.35rem;font-size:.85rem">
          ${m.notes?`<div style="color:var(--text-2);font-style:italic">${m.notes}</div>`:'<div style="color:var(--text-3)">Ni opomb.</div>'}
          <div style="margin-top:auto;padding-top:.5rem;border-top:1px solid var(--border);font-size:.72rem;color:var(--text-3)">
            Dodal: <strong>${m.created_by||'—'}</strong>
            ${m.updated_by?`<br>Urejal: <strong>${m.updated_by}</strong>`:''}
          </div>
        </div>
      </div>
    </div>`;
}
async function switchMemberTab(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.getElementById(`member-tab-${tab}`).classList.add('active');
  const mid = state.currentMemberId;
  if (tab==='history') await loadMemberHistory(mid);
  else if (tab==='payments') await loadMemberPaymentsTab(mid);
  else if (tab==='pricing') await loadMemberPricingTab(mid);
  else if (tab==='discount') await loadMemberDiscountTab(mid);
  else if (tab==='comments') await loadMemberCommentsTab(mid);
}
async function loadMemberHistory(mid) {
  const history = await api(`/api/members/${mid}/history`);
  const statusLabel = {present:'✓ Prisoten',absent_excused:'○ Op. odsoten',absent_unexcused:'✗ Neop.',makeup:'↺ Nadomešč.'};
  const statusClass = {present:'badge-green',absent_excused:'badge-amber',absent_unexcused:'badge-red',makeup:'badge-blue'};
  document.getElementById('member-tab-history').innerHTML = history.length
    ? `<div class="table-wrap"><table><thead><tr><th>Datum</th><th>Skupina</th><th>Status</th><th>Opomba</th><th>Vpisal</th></tr></thead>
      <tbody>${history.map(r=>`<tr>
        <td>${fmtDate(r.date)}</td><td>${r.group_name}</td>
        <td><span class="badge ${statusClass[r.status]||''}">${statusLabel[r.status]||r.status}</span></td>
        <td style="color:var(--text-2);font-size:.82rem">${r.notes||''}</td>
        <td style="color:var(--text-3);font-size:.78rem">${r.recorded_by||'—'}</td>
      </tr>`).join('')}</tbody></table></div>`
    : '<p class="empty-state"><span class="empty-icon">◎</span>Ni zapisov prisotnosti.</p>';
}
async function loadMemberPaymentsTab(mid) {
  const payments = await api(`/api/members/${mid}/payments`);
  const methodLabel = {gotovina:'💵 Gotovina',nakazilo:'🏦 Nakazilo',kartica:'💳 Kartica'};
  document.getElementById('member-tab-payments').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:.85rem">
      <button class="btn btn-primary btn-sm" onclick="showPaymentModal('${mid}')">+ Vpiši plačilo</button>
    </div>
    ${payments.length ? `<div class="table-wrap"><table><thead><tr><th>Datum</th><th>Mesec</th><th>Znesek</th><th>Način</th><th>Opomba</th><th>Vpisal</th><th></th></tr></thead>
      <tbody>${payments.map(p=>`<tr>
        <td>${fmtDate(p.payment_date)}</td>
        <td>${MONTHS_SL[p.period_month-1]} ${p.period_year}</td>
        <td><strong style="color:var(--green)">€ ${p.amount.toFixed(2)}</strong></td>
        <td>${methodLabel[p.method]||p.method}</td>
        <td style="color:var(--text-2);font-size:.82rem">${p.notes||''}</td>
        <td style="color:var(--text-3);font-size:.78rem">${p.created_by||'—'}</td>
        <td><button class="btn btn-danger btn-sm" onclick="deletePayment('${p.id}','${mid}')">✕</button></td>
      </tr>`).join('')}</tbody></table></div>`
    : '<p class="empty-state"><span class="empty-icon">◈</span>Ni plačil.</p>'}`;
}
async function loadMemberContactsTab(mid) {
  const contacts = await api(`/api/members/${mid}/contacts`);
  const typeLabel = {klic:'📞 Klic',sestanek:'🤝 Sestanek',email:'✉ E-pošta',sms:'💬 SMS',drugo:'● Drugo'};
  document.getElementById('member-tab-contacts').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:.85rem">
      <button class="btn btn-primary btn-sm" onclick="showContactModal('${mid}')">+ Beleženje kontakta</button>
    </div>
    ${contacts.length ? `<div class="table-wrap"><table><thead><tr><th>Datum</th><th>Vrsta</th><th>Vsebina</th><th>Opomnik</th><th>Vpisal</th><th></th></tr></thead>
      <tbody>${contacts.map(c=>`<tr>
        <td>${fmtDate(c.contact_date)}</td>
        <td>${typeLabel[c.type]||c.type}</td>
        <td>${c.notes}</td>
        <td>${c.followup_date?`<span class="badge badge-amber">📅 ${fmtDate(c.followup_date)}</span>`:'—'}</td>
        <td style="color:var(--text-3);font-size:.78rem">${c.created_by||'—'}</td>
        <td><button class="btn btn-danger btn-sm" onclick="deleteContact('${c.id}','${mid}')">✕</button></td>
      </tr>`).join('')}</tbody></table></div>`
    : '<p class="empty-state"><span class="empty-icon">◉</span>Ni kontaktov.</p>'}`;
}

async function loadMemberPricingTab(mid) {
  const [pricing, groups] = await Promise.all([api(`/api/members/${mid}/pricing`), api('/api/groups')]);
  const VISITS = [1,2,3,4,5];
  document.getElementById('member-tab-pricing').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:.85rem">
      <button class="btn btn-primary btn-sm" onclick="showPricingForm('${mid}')">+ Nastavi ceno</button>
    </div>
    <div class="info-box" style="margin-bottom:1rem">
      💡 Mesečna cena je odvisna od tega, kolikokrat tedensko član obiskuje skupino. Nastavi jo za vsako skupino posebej. Če ni nastavljena, se računa cena × seje.
    </div>
    ${pricing.length ? `<div class="table-wrap"><table><thead><tr>
      <th>Skupina</th><th>Obiski/teden</th><th>Mesečna cena</th><th>Veljavno od</th><th>Veljavno do</th><th>Nastavil</th><th></th>
    </tr></thead>
    <tbody>${pricing.map(p=>`<tr>
      <td><strong>${p.group_name}</strong></td>
      <td>${p.visits_per_week}× / teden</td>
      <td><strong style="color:var(--green)">€ ${p.monthly_price.toFixed(2)}</strong></td>
      <td>${fmtDate(p.valid_from)}</td>
      <td>${p.valid_to?fmtDate(p.valid_to):'<span style="color:var(--green)">Trenutna</span>'}</td>
      <td style="color:var(--text-3);font-size:.78rem">${p.created_by||'—'}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deletePricing('${p.id}','${mid}')">✕</button></td>
    </tr>`).join('')}</tbody></table></div>`
    : '<p class="empty-state"><span class="empty-icon">€</span>Ni nastavljenih cen. Uporablja se cena po sejo.</p>'}
    <div id="pricing-form-${mid}" style="display:none;margin-top:1rem">
      <div class="detail-card">
        <h3>Nova cena</h3>
        <div class="form-row">
          <div class="form-group"><label>Skupina</label>
            <select id="pf-group-${mid}" class="form-input">
              ${groups.map(g=>`<option value="${g.id}">${g.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Obiski / teden</label>
            <select id="pf-visits-${mid}" class="form-input">
              ${VISITS.map(v=>`<option value="${v}">${v}× tedensko</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Mesečna cena (€)</label>
            <input type="number" id="pf-price-${mid}" class="form-input" placeholder="npr. 90.00" step="0.5">
          </div>
          <div class="form-group"><label>Veljavno od</label>
            <input type="date" id="pf-from-${mid}" class="form-input" value="${todayISO()}">
          </div>
        </div>
        <div class="form-group" style="display:flex;align-items:center;gap:.5rem">
          <input type="checkbox" id="pf-close-${mid}" checked>
          <label for="pf-close-${mid}" style="font-size:.85rem;color:var(--text-2);text-transform:none;letter-spacing:0">Zapri prejšnjo ceno za to skupino</label>
        </div>
        <div style="display:flex;gap:.5rem;margin-top:.5rem">
          <button class="btn btn-primary" onclick="savePricing('${mid}')">Shrani ceno</button>
          <button class="btn btn-ghost" onclick="document.getElementById('pricing-form-${mid}').style.display='none'">Prekliči</button>
        </div>
      </div>
    </div>`;
}
function showPricingForm(mid) {
  document.getElementById(`pricing-form-${mid}`).style.display='';
}
async function savePricing(mid) {
  const data = {
    group_id: document.getElementById(`pf-group-${mid}`).value,
    visits_per_week: parseInt(document.getElementById(`pf-visits-${mid}`).value),
    monthly_price: parseFloat(document.getElementById(`pf-price-${mid}`).value),
    valid_from: document.getElementById(`pf-from-${mid}`).value,
    close_previous: document.getElementById(`pf-close-${mid}`).checked,
  };
  if (!data.monthly_price||data.monthly_price<=0){showToast('Vnesi veljavno ceno.','err');return;}
  await api(`/api/members/${mid}/pricing`,'POST',data);
  showToast('Cena shranjena!');
  loadMemberPricingTab(mid);
  refreshMemberState(mid);
}
async function deletePricing(pid, mid) {
  if (!confirm('Izbriši to ceno?')) return;
  await api(`/api/pricing/${pid}`,'DELETE');
  showToast('Cena izbrisana.');
  loadMemberPricingTab(mid);
  refreshMemberState(mid);
}

// ── Member discount tab ───────────────────────────────────────────────────
async function loadMemberDiscountTab(mid) {
  const discs = await api(`/api/members/${mid}/discount`);
  const today = todayISO();
  const discList = (discs||[]).map(d => {
    const active = d.valid_from <= today && (!d.valid_to || d.valid_to >= today);
    return `<div style="display:flex;justify-content:space-between;align-items:center;
        padding:.75rem 1rem;border-radius:var(--radius-sm);margin-bottom:.5rem;
        background:${active?'var(--green-light)':'var(--bg)'};
        border:1px solid ${active?'var(--green)':'var(--border)'}">
      <div>
        <div style="font-weight:700;font-size:1.05rem;color:${active?'var(--green-dark)':'var(--text-2)'}">
          ${d.discount_type==='percent' ? d.discount_value+'%' : '€ '+parseFloat(d.discount_value).toFixed(2)}
          <span style="font-size:.75rem;font-weight:400;color:var(--text-3);margin-left:.35rem">${d.discount_type==='percent'?'odstotek':'fiksni znesek'}</span>
          ${active?'<span class="badge badge-green" style="margin-left:.5rem;font-size:.65rem">aktivno</span>':'<span class="badge badge-gray" style="margin-left:.5rem;font-size:.65rem">neaktivno</span>'}
        </div>
        ${d.reason?`<div style="font-size:.82rem;color:var(--text-2);margin-top:.15rem;font-style:italic">${d.reason}</div>`:''}
        <div style="font-size:.72rem;color:var(--text-3);margin-top:.25rem">
          Od: ${fmtDate(d.valid_from)} ${d.valid_to?' · do: '+fmtDate(d.valid_to):'· <span style="color:var(--green)">brez roka</span>'}
          · Nastavil: ${d.created_by||'—'}
        </div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteDiscount('${d.id}','${mid}')">✕</button>
    </div>`;
  }).join('');

  document.getElementById('member-tab-discount').innerHTML = `
    <div class="detail-card" style="max-width:560px">
      <h3>Individualni popusti za tega člana</h3>
      <p style="color:var(--text-2);font-size:.85rem;margin-bottom:1.25rem;line-height:1.6">
        Popusti se aplicirajo <strong>poleg</strong> globalnega popusta za odsotnosti.
        Dodaš lahko več popustov z različnimi obdobji veljavnosti.
      </p>
      ${discs&&discs.length ? discList : '<div class="info-box" style="margin-bottom:1rem">Ta član nima individualnih popustov.</div>'}
      <div style="border-top:1px solid var(--border);margin:1.25rem 0 1rem"></div>
      <h4 style="margin-bottom:.85rem;font-size:.95rem">Dodaj nov popust</h4>
      <div id="disc-form-${mid}">
        <div class="form-row">
          <div class="form-group"><label>Vrsta popusta</label>
            <select id="df-type-${mid}" class="form-input" onchange="updateDiscountPreview('${mid}')">
              <option value="percent">Odstotek (%)</option>
              <option value="fixed">Fiksni znesek (€)</option>
            </select>
          </div>
          <div class="form-group"><label id="df-val-label-${mid}">Vrednost (%)</label>
            <input type="number" id="df-value-${mid}" class="form-input" placeholder="npr. 10" step="0.5" min="0" oninput="updateDiscountPreview('${mid}')">
          </div>
        </div>
        <div class="form-group"><label>Razlog / opomba</label>
          <input type="text" id="df-reason-${mid}" class="form-input" placeholder="npr. socialni popust, dogovor...">
        </div>
        <div class="form-row">
          <div class="form-group"><label>Veljavno od</label>
            <input type="date" id="df-from-${mid}" class="form-input" value="${today}">
          </div>
          <div class="form-group"><label>Veljavno do (neobvezno)</label>
            <input type="date" id="df-to-${mid}" class="form-input">
          </div>
        </div>
        <div id="df-preview-${mid}" style="display:none;padding:.6rem .85rem;background:var(--amber-light);border-radius:var(--radius-sm);margin-bottom:.85rem;font-size:.85rem;color:var(--amber)"></div>
        <button class="btn btn-primary" onclick="saveDiscount('${mid}')">+ Dodaj popust</button>
      </div>
    </div>`;
  updateDiscountPreview(mid);
}

function updateDiscountPreview(mid) {
  const type = document.getElementById(`df-type-${mid}`)?.value;
  const val = parseFloat(document.getElementById(`df-value-${mid}`)?.value||0);
  const label = document.getElementById(`df-val-label-${mid}`);
  const preview = document.getElementById(`df-preview-${mid}`);
  if (label) label.textContent = type==='percent' ? 'Vrednost (%)' : 'Vrednost (€)';
  if (preview && val > 0) {
    preview.style.display = '';
    preview.textContent = type==='percent'
      ? `Primer: pri mesečni ceni € 90.00 → popust € ${(90*val/100).toFixed(2)} → plača € ${(90-90*val/100).toFixed(2)}`
      : `Fiksni odbitek € ${val.toFixed(2)} od skupne cene`;
  } else if (preview) preview.style.display = 'none';
}

async function saveDiscount(mid) {
  const val = parseFloat(document.getElementById(`df-value-${mid}`).value);
  if (!val || val <= 0) { showToast('Vnesi vrednost popusta.','err'); return; }
  const from = document.getElementById(`df-from-${mid}`).value;
  if (!from) { showToast('Vnesi datum veljavnosti.','err'); return; }
  await api(`/api/members/${mid}/discount`,'POST',{
    discount_type: document.getElementById(`df-type-${mid}`).value,
    discount_value: val,
    reason: document.getElementById(`df-reason-${mid}`).value,
    valid_from: from,
    valid_to: document.getElementById(`df-to-${mid}`).value||null,
  });
  showToast('Popust dodan!');
  loadMemberDiscountTab(mid);
  refreshMemberState(mid);
}

async function deleteDiscount(did, mid) {
  if (!confirm('Odstrani ta popust?')) return;
  await api(`/api/members/${mid}/discount/${did}`,'DELETE');
  showToast('Popust odstranjen.');
  loadMemberDiscountTab(mid);
  refreshMemberState(mid);
}

// ── Member comments tab ────────────────────────────────────────────────────
async function loadMemberCommentsTab(mid) {
  const comments = await api(`/api/members/${mid}/comments`);
  const el = document.getElementById('member-tab-comments');
  el.innerHTML = `
    <div style="max-width:640px">
      <div class="detail-card" style="margin-bottom:1rem">
        <h3>Nov komentar</h3>
        <div class="form-group">
          <textarea id="comment-input-${mid}" class="form-input" rows="3"
            placeholder="Vpiši komentar o članu..."
            style="resize:vertical;font-family:inherit;font-size:.9rem"></textarea>
        </div>
        <button class="btn btn-primary" onclick="saveMemberComment('${mid}')">Shrani komentar</button>
      </div>
      <div id="comments-list-${mid}">
        ${renderComments(comments, mid)}
      </div>
    </div>`;
}
function renderComments(comments, mid) {
  if (!comments.length) return '<p class="empty-state"><span class="empty-icon">◎</span>Ni komentarjev.</p>';
  return comments.map(c => `
    <div class="detail-card" style="margin-bottom:.65rem;padding:.85rem 1rem">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
        <div style="font-size:.85rem;color:var(--text);line-height:1.6;white-space:pre-wrap;flex:1">${c.comment.replace(/</g,'&lt;')}</div>
        <button class="btn btn-danger btn-sm" style="flex-shrink:0" onclick="deleteMemberComment('${c.id}','${mid}')">✕</button>
      </div>
      <div style="font-size:.72rem;color:var(--text-3);margin-top:.5rem">
        ${fmtDate(c.created_at.split('T')[0])} · ${c.created_at.split('T')[1]?.substring(0,5)||''} · <strong>${c.created_by||'—'}</strong>
      </div>
    </div>`).join('');
}
async function saveMemberComment(mid) {
  const ta = document.getElementById(`comment-input-${mid}`);
  const comment = ta.value.trim();
  if (!comment) { showToast('Komentar ne sme biti prazen.','err'); return; }
  await api(`/api/members/${mid}/comments`, 'POST', {comment});
  ta.value = '';
  showToast('Komentar shranjen.');
  loadMemberCommentsTab(mid);
}
async function deleteMemberComment(cid, mid) {
  if (!confirm('Izbriši ta komentar?')) return;
  await api(`/api/members/comments/${cid}`, 'DELETE');
  showToast('Komentar izbrisan.');
  loadMemberCommentsTab(mid);
}

async function loadAttendanceNav() {
  const groups = await api('/api/groups'); state.groups = groups;
  document.getElementById('att-nav-groups').innerHTML = groups.map(g=>`
    <div class="group-card">
      <div class="card-day">${DAYS_SL[g.day_of_week]}</div>
      <div class="card-name">${g.name}</div>
      <div class="card-meta"><span>🕐 ${g.time}</span><span>👥 ${g.member_count}</span></div>
      <div style="display:flex;gap:.4rem;margin-top:.85rem">
        <button class="btn btn-primary btn-sm" onclick="openAttendance('${g.id}','${todayISO()}');event.stopPropagation()">Danes</button>
        <button class="btn btn-secondary btn-sm" onclick="openSessionHistory('${g.id}');event.stopPropagation()">📋 Termini</button>
      </div>
    </div>`).join('');
}

async function openSessionHistory(gid) {
  const groups = state.groups.length ? state.groups : await api('/api/groups');
  state.groups = groups;
  const g = groups.find(x=>x.id===gid);
  const sessions = await api(`/api/groups/${gid}/sessions`);
  document.getElementById('attendance-title').textContent = g?g.name:'Termini';
  document.getElementById('attendance-subtitle').textContent = 'Izberi termin za urejanje';
  applyGroupDateConstraint(g, todayISO());
  state.currentGroupId = gid;
  navigateTo('attendance');
  const el = document.getElementById('attendance-list');
  const statusDot = s => s.cancelled ? '🚫' : s.has_attendance ? '✓' : s.is_future ? '○' : '–';
  const statusColor = s => s.cancelled ? 'var(--red)' : s.has_attendance ? 'var(--green)' : s.is_future ? 'var(--text-3)' : 'var(--amber)';
  el.innerHTML = `
    <div style="margin-bottom:1rem">
      <p style="color:var(--text-2);font-size:.85rem;margin-bottom:.75rem">Klikni termin za urejanje prisotnosti. Zeleni = vpisani, rumeni = brez vpisa, rdeči = odpovedan.</p>
    </div>
    <div style="display:flex;flex-direction:column;gap:.45rem">
    ${sessions.map(s=>`
      <div class="session-history-row" onclick="openAttendance('${gid}','${s.date}')">
        <div style="font-size:1.1rem;width:1.5rem;text-align:center;flex-shrink:0">${statusDot(s)}</div>
        <div style="min-width:100px;flex-shrink:0">
          <strong style="color:${s.is_today?'var(--green)':s.is_future?'var(--text-3)':'var(--text)'}">${s.date_fmt}</strong>
          ${s.is_today?'<span class="badge badge-green" style="margin-left:.4rem">danes</span>':''}
          ${s.is_future?'<span class="badge badge-gray" style="margin-left:.4rem">prihodnji</span>':''}
          ${s.cancelled?'<span class="badge badge-red" style="margin-left:.4rem">odpovedan</span>':''}
        </div>
        <div style="color:var(--text-3);font-size:.82rem;flex-shrink:0">${s.weekday}</div>
        <div style="flex:1;font-size:.82rem;color:var(--text-2)">
          ${s.has_attendance?`<span style="color:var(--green)">✓ ${s.attendance_present}/${s.attendance_total} vpisanih</span>`:'<span style="color:var(--amber)">Brez vpisa</span>'}
        </div>
        ${s.notes?`<div style="font-size:.78rem;color:var(--text-3);font-style:italic">${s.notes}</div>`:''}
        <div class="session-history-actions" style="display:flex;gap:.4rem;flex-shrink:0">
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openAttendance('${gid}','${s.date}')">Uredi</button>
          <button class="btn btn-${s.cancelled?'amber':'danger'} btn-sm" onclick="event.stopPropagation();toggleCancelSession('${gid}','${s.date}',${s.cancelled?0:1})">${s.cancelled?'Obnovi':'Odpovej'}</button>
        </div>
      </div>`).join('')}
    </div>`;
}

async function toggleCancelSession(gid, sessionDate, cancel) {
  const reason = cancel ? prompt('Razlog odpovedi (neobvezno):') : null;
  if (cancel && reason === null) return; // pressed Cancel
  await api('/api/sessions','POST',{group_id:gid, session_date:sessionDate, cancelled:cancel, cancel_reason:reason||''});
  showToast(cancel?'Termin odpovedan.':'Termin obnovljen.');
  openSessionHistory(gid);
}

// ── Attendance ────────────────────────────────────────────────────────────
function applyGroupDateConstraint(g, dateStr) {
  const picker = document.getElementById('attendance-date-picker');
  if (!g) { picker.removeAttribute('step'); picker.removeAttribute('min'); picker.value = dateStr; return dateStr; }
  const jsDay = (g.day_of_week + 1) % 7; // app: 0=Mon → JS: 1=Mon
  // Anchor: earliest date in the past on the correct weekday
  const anchor = new Date('2020-01-01T12:00:00');
  while (anchor.getDay() !== jsDay) anchor.setDate(anchor.getDate() + 1);
  picker.min = anchor.toISOString().split('T')[0];
  picker.step = '7';
  // Snap dateStr to the nearest previous correct weekday
  const d = new Date(dateStr + 'T12:00:00');
  if (d.getDay() !== jsDay) {
    while (d.getDay() !== jsDay) d.setDate(d.getDate() - 1);
    dateStr = d.toISOString().split('T')[0];
  }
  picker.value = dateStr;
  return dateStr;
}
async function openAttendance(groupId, dateStr) {
  state.currentGroupId = groupId; state.attendanceData = {};
  const groups = state.groups.length ? state.groups : await api('/api/groups');
  state.groups = groups;
  const g = groups.find(x=>x.id===groupId);
  dateStr = applyGroupDateConstraint(g, dateStr);
  state.currentDate = dateStr;
  document.getElementById('attendance-title').textContent = g?g.name:'Prisotnost';
  document.getElementById('attendance-subtitle').textContent = fmtDate(dateStr);
  navigateTo('attendance');
  await renderAttendance();
}
async function renderAttendance() {
  const data = await api(`/api/attendance/${state.currentGroupId}/${state.currentDate}`);
  const el = document.getElementById('attendance-list');
  const members = data.members || data; // backwards compat
  const sessInfo = data.session_info;
  if (sessInfo && sessInfo.cancelled) {
    el.innerHTML = `<div class="info-box" style="background:var(--red-light);color:var(--red)">🚫 Ta termin je bil odpovedan${sessInfo.cancel_reason?`: ${sessInfo.cancel_reason}`:''}.
      <button class="btn btn-amber btn-sm" style="margin-left:1rem" onclick="toggleCancelSession('${state.currentGroupId}','${state.currentDate}',0)">Obnovi termin</button></div>`;
    return;
  }
  if (!members.length) { el.innerHTML='<p class="empty-state"><span class="empty-icon">◉</span>Ni aktivnih članov.</p>'; return; }
  members.forEach(m => {
    const att = m.attendance;
    if (!state.attendanceData[m.id]) state.attendanceData[m.id] = {
      status: att?att.status:'present', absence_end_date: att?(att.absence_end_date||''):'',
      notes: att?(att.notes||''):'', makeup_for_date: att?(att.makeup_for_date||''):'',
      makeup_group_id: att?(att.makeup_group_id||''):''
    };
  });
  // Opozorilo za pretekle termine
  const isPast = new Date(state.currentDate) < new Date(new Date().toDateString());
  el.innerHTML = (isPast?`<div class="info-box" style="background:var(--amber-light);color:var(--amber);margin-bottom:.85rem">📅 Urejate pretekli termin: ${fmtDate(state.currentDate)}</div>`:'')+
    members.map(m=>renderAttRow(m)).join('');
}
function renderAttRow(m) {
  const d = state.attendanceData[m.id]||{status:'present'};
  const isAbsent = ['absent_excused','absent_unexcused'].includes(d.status);
  const isMakeup = d.status==='makeup';
  return `<div class="attendance-row" id="att-row-${m.id}">
    <div class="attendance-row-top">
      <div class="att-name">${m.name}</div>
      <div class="att-status-group">
        <button class="att-btn ${d.status==='present'?'selected-present':''}" onclick="setStatus('${m.id}','present')">✓ Prisoten</button>
        <button class="att-btn ${d.status==='absent_excused'?'selected-excused':''}" onclick="setStatus('${m.id}','absent_excused')">○ Op. odsoten</button>
        <button class="att-btn ${d.status==='absent_unexcused'?'selected-unexcused':''}" onclick="setStatus('${m.id}','absent_unexcused')">✗ Neop. odsoten</button>
        <button class="att-btn ${d.status==='makeup'?'selected-makeup':''}" onclick="setStatus('${m.id}','makeup')">↺ Nadomešča</button>
      </div>
    </div>
    ${isAbsent?`<div class="attendance-extra">
      <div class="form-group"><label>Odsoten do</label>
        <input type="date" class="form-input" value="${d.absence_end_date||''}" onchange="updateField('${m.id}','absence_end_date',this.value)" style="width:auto">
        <small style="color:var(--text-3);font-size:.72rem">Pusti prazno za enkratno odsotnost</small>
      </div>
      <div class="form-group"><label>Opomba</label>
        <input type="text" class="form-input" value="${d.notes||''}" placeholder="npr. bolezniški" onchange="updateField('${m.id}','notes',this.value)">
      </div>
    </div>`:''}
    ${isMakeup?`<div class="attendance-extra">
      <div class="form-group"><label>Nadomešča datum</label>
        <input type="date" class="form-input" value="${d.makeup_for_date||''}" onchange="updateField('${m.id}','makeup_for_date',this.value)" style="width:auto">
      </div>
      <div class="form-group"><label>Nadomešča skupino</label>
        <select class="form-input" onchange="updateField('${m.id}','makeup_group_id',this.value)">
          <option value="">— izberi —</option>
          ${state.groups.map(g=>`<option value="${g.id}" ${d.makeup_group_id===g.id?'selected':''}>${g.name}</option>`).join('')}
        </select>
      </div>
    </div>`:''}
  </div>`;
}
function setStatus(memberId, status) {
  if (!state.attendanceData[memberId]) state.attendanceData[memberId]={};
  state.attendanceData[memberId].status = status;
  if (status==='present') { state.attendanceData[memberId].absence_end_date=''; state.attendanceData[memberId].notes=''; }
  const rowEl = document.getElementById(`att-row-${memberId}`);
  if (rowEl) { const m={id:memberId,name:rowEl.querySelector('.att-name').textContent}; rowEl.outerHTML=renderAttRow(m); }
}
function updateField(memberId, field, value) {
  if (!state.attendanceData[memberId]) state.attendanceData[memberId]={};
  state.attendanceData[memberId][field] = value;
}
function changeAttendanceDate() {
  const g = state.groups.find(x=>x.id===state.currentGroupId);
  let date = document.getElementById('attendance-date-picker').value;
  if (g) {
    const jsDay = (g.day_of_week + 1) % 7;
    const d = new Date(date + 'T12:00:00');
    if (d.getDay() !== jsDay) {
      while (d.getDay() !== jsDay) d.setDate(d.getDate() - 1);
      date = d.toISOString().split('T')[0];
      document.getElementById('attendance-date-picker').value = date;
    }
  }
  state.currentDate = date;
  document.getElementById('attendance-subtitle').textContent = fmtDate(state.currentDate);
  state.attendanceData = {}; renderAttendance();
}
async function saveAttendance() {
  const records = Object.entries(state.attendanceData).map(([member_id,d])=>({member_id,...d}));
  await api('/api/attendance','POST',{group_id:state.currentGroupId,date:state.currentDate,records});
  showToast('Prisotnost shranjena!');
}

// ── Mesečno poročilo (vse v enem) ─────────────────────────────────────────
function initReport() {
  const now = new Date();
  const mSel=document.getElementById('report-month'), ySel=document.getElementById('report-year');
  if (!mSel.options.length) {
    MONTHS_SL.forEach((m,i)=>{ const o=document.createElement('option'); o.value=i+1; o.textContent=m; if(i===now.getMonth())o.selected=true; mSel.appendChild(o); });
    for(let y=now.getFullYear();y>=now.getFullYear()-2;y--){ const o=document.createElement('option'); o.value=y; o.textContent=y; o.selected=(y===now.getFullYear()); ySel.appendChild(o); }
  }
  loadReport();
}

async function loadReport() {
  const month = document.getElementById('report-month').value;
  const year  = document.getElementById('report-year').value;
  const monthName = MONTHS_SL[month-1];
  document.getElementById('report-subtitle').textContent = `${monthName} ${year}`;

  const data = await api(`/api/billing/${year}/${month}`);
  const sumEl = document.getElementById('report-summary');
  const el    = document.getElementById('report-content');

  if (!data.length) {
    sumEl.innerHTML = '';
    el.innerHTML = '<p class="empty-state"><span class="empty-icon">◈</span>Ni podatkov za ta mesec.</p>';
    return;
  }

  const tot = data.reduce((a,r)=>({
    scheduled: a.scheduled+r.scheduled,
    attended:  a.attended+r.attended,
    excused:   a.excused+r.excused,
    unexcused: a.unexcused+r.unexcused,
    due:       a.due+r.amount_due,
    paid:      a.paid+r.paid,
    bal:       a.bal+r.balance,
    disc:      a.disc+r.discount_amount+(r.member_discount_amount||0),
  }), {scheduled:0,attended:0,excused:0,unexcused:0,due:0,paid:0,bal:0,disc:0});

  const unpaid = data.filter(r=>r.balance>0);
  const allPaid = data.filter(r=>r.balance<=0 && r.amount_due>0);

  // Povzetek kartic
  sumEl.innerHTML = `
    <div class="stats-row" style="margin-bottom:1.25rem">
      <div class="stat-card"><div class="stat-num" style="color:var(--green)">€ ${tot.paid.toFixed(2)}</div><div class="stat-label">Plačano</div></div>
      <div class="stat-card ${tot.bal>0?'alert':''}"><div class="stat-num">€ ${tot.due.toFixed(2)}</div><div class="stat-label">Skupaj za plačilo</div></div>
      <div class="stat-card ${tot.bal>0?'warn':''}"><div class="stat-num">€ ${tot.bal.toFixed(2)}</div><div class="stat-label">Neporavnano</div></div>
    </div>
    ${unpaid.length?`<div class="info-box" style="background:var(--amber-light);color:var(--amber);margin-bottom:1rem">
      ⚠ <strong>${unpaid.length}</strong> član${unpaid.length===1?'':'ov'} ima neporavnane obveznosti:
      ${unpaid.map(r=>`<span style="cursor:pointer;text-decoration:underline" onclick="showMemberDetail('${r.member_id}')">${r.name}</span>`).join(', ')}
    </div>`:''}
    ${allPaid.length===data.filter(r=>r.amount_due>0).length&&allPaid.length>0?`<div class="info-box" style="background:var(--green-light);color:var(--green-dark);margin-bottom:1rem">✓ Vsi člani so poravnali obveznosti za ${monthName} ${year}.</div>`:''}`;

  // Next-month recommendations
  const recs = data.filter(r=>r.next_month_rec);
  const recsHtml = recs.length ? `<div class="info-box" style="background:#fffbf0;color:#b45309;margin-bottom:1rem">
    <strong>Priporočila za naslednji mesec:</strong><br>
    ${recs.map(r=>`<div style="margin-top:.3rem">👤 <strong>${r.name}</strong>: ${r.next_month_rec}
      ${r.next_month_rec.startsWith('-')?`<button class="btn btn-ghost btn-sm" style="margin-left:.5rem" onclick="showMemberDetail('${r.member_id}')">Nastavi popust</button>`:''}</div>`).join('')}
  </div>` : '';

  // Glavna tabela
  el.innerHTML = recsHtml + `<div class="table-wrap"><table class="report-table">
    <thead><tr>
      <th>Ime</th>
      <th>Prisotnost</th>
      <th>Op. ods. (dni)</th>
      <th>Neop. ods.</th>
      <th>Pop. ods.</th>
      <th>Pop. član</th>
      <th>Za plačilo</th>
      <th>Plačano</th>
      <th>Razlika</th>
      <th></th>
    </tr></thead>
    <tbody>${data.map(r=>`<tr style="${r.balance>0?'background:#fffbf0':''}">
      <td>
        <strong style="cursor:pointer;color:var(--green)" onclick="showMemberDetail('${r.member_id}')">${r.name}</strong>
        ${r.member_discount_label?`<br><span class="badge badge-amber" style="margin-top:.2rem">👤 ${r.member_discount_label}</span>`:''}
      </td>
      <td>${r.attended}/${r.scheduled}</td>
      <td>${r.excused>0?`${r.excused} (${r.excused_days}d)`:'—'}</td>
      <td>${r.unexcused||'—'}</td>
      <td class="discount-val">${r.discount_amount>0?`-€ ${r.discount_amount.toFixed(2)}`:'—'}</td>
      <td class="discount-val">${(r.member_discount_amount||0)>0?`-€ ${r.member_discount_amount.toFixed(2)}`:'—'}</td>
      <td class="amount">€ ${r.amount_due.toFixed(2)}</td>
      <td>
        <span style="color:${r.paid>0?'var(--green)':'var(--text-3)'}; font-weight:600">€ ${r.paid.toFixed(2)}</span>
      </td>
      <td><span class="${r.balance>0?'balance-due':'balance-ok'}" style="font-weight:700">
        ${r.balance>0?`€ ${r.balance.toFixed(2)}`:'✓'}
      </span></td>
      <td style="white-space:nowrap">
        <button class="btn btn-primary btn-sm" onclick="showPaymentModal('${r.member_id}','${r.name}')">+ Plačilo</button>
      </td>
    </tr>`).join('')}</tbody>
    <tfoot><tr>
      <td>Skupaj</td>
      <td>${tot.attended}/${tot.scheduled}</td>
      <td>${tot.excused}</td>
      <td>${tot.unexcused}</td>
      <td class="discount-val">-€ ${tot.disc.toFixed(2)}</td>
      <td></td>
      <td class="amount">€ ${tot.due.toFixed(2)}</td>
      <td style="font-weight:700;text-align:right">€ ${tot.paid.toFixed(2)}</td>
      <td class="${tot.bal>0?'balance-due':'balance-ok'}" style="font-weight:700">€ ${tot.bal.toFixed(2)}</td>
      <td></td>
    </tr></tfoot>
  </table></div>`;
}

function exportCSV() {
  const m=document.getElementById('report-month').value, y=document.getElementById('report-year').value;
  window.location.href=`/api/billing/${y}/${m}/csv`;
}

// ── Settings ──────────────────────────────────────────────────────────────
async function loadSettings() {
  const [settings, groups] = await Promise.all([api('/api/settings'), api('/api/groups')]);
  state.groups = groups;
  document.getElementById('settings-content').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;max-width:800px">
      <div class="detail-card">
        <h3>Pravila odsotnosti</h3>
        <div style="background:var(--teal-light);border-radius:8px;padding:.65rem .85rem;font-size:.8rem;line-height:1.7;margin-bottom:1rem;color:var(--text-2)">
          <div>≤ <strong id="rule-d1">${settings.discount_days||7}</strong> dni → polna vadnina, nadomeščanja možna</div>
          <div><strong id="rule-d1b">${settings.discount_days||7}</strong>–<strong id="rule-d2">${settings.discount_days_max||14}</strong> dni → <strong>${settings.discount_percent||20}%</strong> popust za naslednji mesec</div>
          <div>> <strong id="rule-d2b">${settings.discount_days_max||14}</strong> dni → individualni popust (nastavi ročno)</div>
        </div>
        <div class="form-group"><label>Kratka odsotnost – meja (dni)</label>
          <input type="number" id="s-discount-days" class="form-input" value="${settings.discount_days||7}" min="1" max="30">
        </div>
        <div class="form-group"><label>Daljša odsotnost – meja (dni)</label>
          <input type="number" id="s-discount-days-max" class="form-input" value="${settings.discount_days_max||14}" min="7" max="90">
        </div>
        <div class="form-group"><label>Popust za 1–2 tedna odsotnosti (%)</label>
          <input type="number" id="s-discount-pct" class="form-input" value="${settings.discount_percent||20}" min="0" max="100">
        </div>
        <button class="btn btn-primary" onclick="saveDiscountSettings()">Shrani pravila</button>
      </div>
      <div class="detail-card">
        <h3>Cenik – obiski na teden</h3>
        <div class="form-group"><label>1× na teden (€/mesec)</label>
          <input type="number" id="s-tier-1" class="form-input" value="${parseFloat(settings.tier_price_1||40).toFixed(2)}" min="0" step="0.5">
        </div>
        <div class="form-group"><label>2× na teden (€/mesec)</label>
          <input type="number" id="s-tier-2" class="form-input" value="${parseFloat(settings.tier_price_2||70).toFixed(2)}" min="0" step="0.5">
        </div>
        <div class="form-group"><label>3× na teden (€/mesec)</label>
          <input type="number" id="s-tier-3" class="form-input" value="${parseFloat(settings.tier_price_3||90).toFixed(2)}" min="0" step="0.5">
        </div>
        <div class="form-group"><label>4× ali več na teden (€/mesec)</label>
          <input type="number" id="s-tier-4" class="form-input" value="${parseFloat(settings.tier_price_4plus||110).toFixed(2)}" min="0" step="0.5">
        </div>
        <button class="btn btn-primary" onclick="saveTierSettings()">Shrani cenik</button>
      </div>
      <div class="detail-card">
        <h3>Navigacija skupin & članov</h3>
        <div style="display:flex;gap:.65rem;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="navigateTo('groups')">Upravljaj skupine</button>
          <button class="btn btn-secondary" onclick="navigateTo('members')">Upravljaj člane</button>
        </div>
      </div>
    </div>`;
}
async function saveDiscountSettings() {
  await api('/api/settings','POST',{
    discount_percent: document.getElementById('s-discount-pct').value,
    discount_days: document.getElementById('s-discount-days').value,
    discount_days_max: document.getElementById('s-discount-days-max').value,
  });
  showToast('Pravila odsotnosti shranjena!');
}
async function saveTierSettings() {
  await api('/api/settings','POST',{
    tier_price_1: document.getElementById('s-tier-1').value,
    tier_price_2: document.getElementById('s-tier-2').value,
    tier_price_3: document.getElementById('s-tier-3').value,
    tier_price_4plus: document.getElementById('s-tier-4').value,
  });
  showToast('Cenik shranjen!');
}

// ── Payments modal ────────────────────────────────────────────────────────
async function showPaymentModal(mid, name) {
  if (!state.members.length) state.members = await api('/api/members');
  const m = state.members.find(x=>x.id===mid);
  if (!name) name = m ? m.name : '—';
  // expected_monthly already has individual discount applied by the backend
  let amount = m ? (m.expected_monthly || 0) : 0;
  document.getElementById('pay-member-id').value = mid;
  document.getElementById('pay-member-name').value = name;
  document.getElementById('pay-date').value = todayISO();
  document.getElementById('pay-amount').value = amount ? amount.toFixed(2) : '';
  document.getElementById('pay-notes').value = '';
  const now = new Date();
  const mSel=document.getElementById('pay-month'), ySel=document.getElementById('pay-year');
  mSel.innerHTML=''; ySel.innerHTML='';
  MONTHS_SL.forEach((m,i)=>{ const o=document.createElement('option'); o.value=i+1; o.textContent=m; if(i===now.getMonth())o.selected=true; mSel.appendChild(o); });
  for(let y=now.getFullYear();y>=now.getFullYear()-2;y--){ const o=document.createElement('option'); o.value=y; o.textContent=y; o.selected=(y===now.getFullYear()); ySel.appendChild(o); }
  openModal('modal-payment');
}
async function savePayment() {
  const data = {
    member_id: document.getElementById('pay-member-id').value,
    amount: parseFloat(document.getElementById('pay-amount').value),
    payment_date: document.getElementById('pay-date').value,
    method: document.getElementById('pay-method').value,
    period_year: parseInt(document.getElementById('pay-year').value),
    period_month: parseInt(document.getElementById('pay-month').value),
    notes: document.getElementById('pay-notes').value,
  };
  if (!data.amount || data.amount<=0) { showToast('Vnesi veljaven znesek.','err'); return; }
  await api('/api/payments','POST',data);
  closeModal();
  showToast('Plačilo vpisano!');
  if (document.getElementById('view-report').classList.contains('active')) loadReport();
  loadMemberPaymentsTab(data.member_id);
  refreshMemberState(data.member_id);
}
async function deletePayment(pid, mid) {
  if (!confirm('Izbriši to plačilo?')) return;
  await api(`/api/payments/${pid}`,'DELETE');
  showToast('Plačilo izbrisano.');
  loadMemberPaymentsTab(mid);
  refreshMemberState(mid);
}

// ── Contacts modal ────────────────────────────────────────────────────────
function showContactModal(mid) {
  document.getElementById('contact-member-id').value = mid;
  document.getElementById('contact-date').value = todayISO();
  document.getElementById('contact-notes').value = '';
  document.getElementById('contact-followup').value = '';
  openModal('modal-contact');
}
async function saveContact() {
  const notes = document.getElementById('contact-notes').value.trim();
  if (!notes) { showToast('Vnesi vsebino kontakta.','err'); return; }
  const data = {
    member_id: document.getElementById('contact-member-id').value,
    contact_date: document.getElementById('contact-date').value,
    type: document.getElementById('contact-type').value,
    notes,
    followup_date: document.getElementById('contact-followup').value||null,
  };
  await api('/api/contacts','POST',data);
  closeModal(); showToast('Kontakt shranjen.');
  loadMemberContactsTab(data.member_id);
}
async function deleteContact(cid, mid) {
  if (!confirm('Izbriši ta kontakt?')) return;
  await api(`/api/contacts/${cid}`,'DELETE');
  showToast('Kontakt izbrisan.');
  loadMemberContactsTab(mid);
}

// ── Auth ──────────────────────────────────────────────────────────────────
async function doLogout() { await fetch('/api/auth/logout',{method:'POST'}); window.location.href='/login'; }
function showChangePassword() {
  ['pw-old','pw-new','pw-new2'].forEach(id=>document.getElementById(id).value='');
  const e=document.getElementById('pw-error'); e.textContent=''; e.classList.remove('show');
  openModal('modal-password');
}
async function saveNewPassword() {
  const oldPw=document.getElementById('pw-old').value, newPw=document.getElementById('pw-new').value, newPw2=document.getElementById('pw-new2').value;
  const err=document.getElementById('pw-error'); err.classList.remove('show');
  if (newPw!==newPw2) { err.textContent='Novi gesli se ne ujemata.'; err.classList.add('show'); return; }
  const r=await fetch('/api/auth/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({old_password:oldPw,new_password:newPw})});
  const d=await r.json();
  if (d.ok) { closeModal(); showToast('Geslo uspešno spremenjeno!'); }
  else { err.textContent=d.error; err.classList.add('show'); }
}
async function showUserManagement() {
  openModal('modal-users');
  const users=await api('/api/auth/users');
  document.getElementById('users-list-modal').innerHTML=users.map(u=>`
    <div class="user-row">
      <div class="user-row-info"><div class="user-row-name">${u.username}</div>
        <div class="user-row-meta">${u.email||'—'} · ${u.role==='admin'?'Administrator':'Uporabnik'} · Od ${fmtDate(u.created_at)}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteUser('${u.id}','${u.username}')">Izbriši</button>
    </div>`).join('');
}
async function deleteUser(uid, uname) {
  if (!confirm(`Izbriši račun "${uname}"?`)) return;
  const r=await fetch(`/api/auth/users/${uid}`,{method:'DELETE'});
  const d=await r.json();
  if(d.ok){showToast('Račun izbrisan.');showUserManagement();}else showToast(d.error||'Napaka.','err');
}
async function registerUser() {
  const err=document.getElementById('reg-error'); err.classList.remove('show');
  const data={username:document.getElementById('reg-username').value.trim(),email:document.getElementById('reg-email').value.trim(),password:document.getElementById('reg-password').value,role:document.getElementById('reg-role').value};
  const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const res=await r.json();
  if(res.ok){['reg-username','reg-email','reg-password'].forEach(id=>document.getElementById(id).value='');showToast('Račun ustvarjen!');showUserManagement();}
  else{err.textContent=res.error;err.classList.add('show');}
}

// ── Audit ─────────────────────────────────────────────────────────────────
async function loadAudit() {
  const data=await api('/api/audit');
  const aLabel={CREATE:'Dodano',UPDATE:'Urejeno',DELETE:'Izbrisano',SAVE_ATTENDANCE:'Prisotnost',CHANGE_PASSWORD:'Geslo'};
  const aClass={CREATE:'badge-green',UPDATE:'badge-blue',DELETE:'badge-red',SAVE_ATTENDANCE:'badge-amber',CHANGE_PASSWORD:'badge-gray'};
  document.getElementById('audit-content').innerHTML=`<div class="table-wrap"><table>
    <thead><tr><th>Čas</th><th>Uporabnik</th><th>Akcija</th><th>Tabela</th><th>Podrobnosti</th></tr></thead>
    <tbody>${data.map(r=>`<tr>
      <td style="font-size:.78rem;color:var(--text-2);white-space:nowrap">${r.timestamp.replace('T',' ').substring(0,16)}</td>
      <td><strong>${r.username}</strong></td>
      <td><span class="badge ${aClass[r.action]||'badge-gray'}">${aLabel[r.action]||r.action}</span></td>
      <td style="font-size:.82rem;color:var(--text-2)">${r.table_name}</td>
      <td style="font-size:.8rem;color:var(--text-2)">${r.detail||''}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

// ── Init ──────────────────────────────────────────────────────────────────
// ── Mobile menu ───────────────────────────────────────────────────────────
function toggleMobileMenu() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const btn = document.getElementById('mobile-menu-btn');
  const isOpen = sidebar.classList.toggle('open');
  overlay.classList.toggle('open', isOpen);
  btn.classList.toggle('is-open', isOpen);
}
function closeMobileMenu() {
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
  document.getElementById('mobile-menu-btn').classList.remove('is-open');
}

// Zapri meni po navigaciji na mobilu
document.querySelectorAll('.nav-links a').forEach(a => {
  a.addEventListener('click', () => {
    if (window.innerWidth <= 1024) closeMobileMenu();
  });
});

fetch('/api/auth/me').then(r=>r.json()).then(me=>{
  if(me.role==='admin') document.getElementById('nav-audit').style.display='';
});
loadDashboard();
