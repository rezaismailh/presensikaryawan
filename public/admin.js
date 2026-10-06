// Dashboard admin / HRD
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, { method, body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('Tidak bisa terhubung ke server.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* bukan JSON */ }
  if (res.status === 401 && !path.endsWith('/login')) {
    showLogin();
    throw new Error(data.error || 'Sesi habis, silakan login lagi.');
  }
  if (!res.ok) throw new Error(data.error || `Gagal (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5000 : 3000);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ($(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Gagal memuat library. Periksa koneksi internet.'));
    document.head.append(s);
  });
}
function loadCss(href) {
  return new Promise((resolve) => {
    const found = $(`link[href="${href}"]`);
    if (found) return found.sheet ? resolve() : found.addEventListener('load', resolve, { once: true });
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = resolve;
    l.onerror = resolve;
    document.head.append(l);
  });
}
const LIB = {
  leafletJs: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  leafletCss: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  qr: 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
};

// ---------- Format ----------
const hhmm = (t) => (t ? t.slice(0, 5) : '');
const fmtDist = (m) => (m == null ? '' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
const fmtDur = (m) => (m == null ? '' : `${Math.floor(m / 60)}j ${String(m % 60).padStart(2, '0')}m`);
const showPhone = (p) => (p ? '0' + p.slice(2) : '');
const fmtDate = (d, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Intl.DateTimeFormat('id-ID', { ...opts, timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));
const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const typeLabel = (t) => (t === 'freelance' ? 'Freelance' : 'Karyawan');
const mapsLink = (r) => (r?.lat != null ? `<a href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank" rel="noopener">Maps</a>` : '');

const STATUS = {
  present: ['ok', 'Hadir'],
  late: ['warn', 'Terlambat'],
  pending: ['info', 'Menunggu ACC'],
  rejected: ['danger', 'Ditolak'],
  holiday: ['accent', 'Masuk hari libur'],
  absent: ['danger', 'Tidak hadir'],
  off: ['', 'Libur'],
};
function statusBadge(status, isToday = false) {
  const [cls, label] = STATUS[status] || ['', status];
  return `<span class="badge ${cls}">${status === 'absent' && isToday ? 'Belum absen' : label}</span>`;
}
function approvalBadge(r) {
  if (!r?.outside) return '';
  return { pending: '<span class="badge info">Menunggu ACC</span>', approved: '<span class="badge ok">Disetujui</span>',
           rejected: '<span class="badge danger">Ditolak</span>' }[r.approval] || '';
}

function timeCell(r) {
  if (!r) return '<span class="muted">—</span>';
  const where = r.outside ? `Luar kantor · ±${fmtDist(r.distance)}` : r.location || (r.decided_by?.includes('manual') ? 'Input manual' : '');
  return `<div class="cell-time">
    <div class="row" style="gap:8px">
      ${r.photo ? `<img class="thumb" src="${esc(r.photo)}" alt="" data-photo="${esc(r.photo)}" loading="lazy">` : ''}
      <div class="stack" style="gap:2px">
        <span class="t">${hhmm(r.time)} ${r.late ? '<span class="badge warn">Telat</span>' : ''} ${approvalBadge(r)}</span>
        <span class="sub">${esc(where)} ${mapsLink(r)}</span>
      </div>
    </div>
    ${r.note ? `<span class="sub">“${esc(r.note)}”</span>` : ''}
    ${r.address ? `<span class="sub">${esc(r.address)}</span>` : ''}
  </div>`;
}

document.addEventListener('click', (e) => {
  const img = e.target.closest('[data-photo]');
  if (!img) return;
  $('#photo-big').src = img.dataset.photo;
  $('#photo-dlg').showModal();
});

// ---------- Dialog ----------
function dialog(html, onSubmit) {
  const dlg = $('#dlg'), body = $('#dlg-body');
  body.innerHTML = html;
  body.onsubmit = async (e) => {
    e.preventDefault();
    if (!onSubmit) return dlg.close();
    const btn = e.submitter;
    if (btn) btn.disabled = true;
    try {
      const keepOpen = await onSubmit(new FormData(body), btn);
      if (keepOpen !== false) dlg.close();
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  $$('[data-close]', body).forEach((b) => (b.onclick = () => dlg.close()));
  dlg.showModal();
  return body;
}
const cancelBtn = '<button type="button" class="ghost" data-close>Batal</button>';

// ---------- Data bersama ----------
const state = { settings: null, today: '', divisions: [], employees: [] };

async function loadDivisions() {
  state.divisions = (await api('/api/admin/divisions')).divisions;
  for (const sel of $$('.division-filter')) {
    const v = sel.value;
    sel.innerHTML = '<option value="">Semua divisi</option>' + state.divisions.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    sel.value = v;
  }
}
async function loadEmployees() {
  state.employees = (await api('/api/admin/employees')).employees;
}
for (const sel of $$('.type-filter')) {
  sel.innerHTML = '<option value="">Semua</option><option value="karyawan">Karyawan</option><option value="freelance">Freelance</option>';
}
const divisionOptions = (selected, blank = 'Tanpa divisi') =>
  `<option value="">${blank}</option>` + state.divisions.map((d) => `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${esc(d.name)}</option>`).join('');

async function refreshCounts() {
  const me = await api('/api/admin/me');
  state.settings = me.settings;
  state.today = me.today;
  $('#company').textContent = me.settings.company_name;
  const set = (id, n) => { $(id).textContent = n; $(id).hidden = !n; };
  set('#count-approvals', me.pendingApprovals);
  set('#count-regs', me.pendingRegistrations);
}

// ---------- PIN & WhatsApp ----------
function waLink(e, pin) {
  const msg = `Halo ${e.name}, akun Presensi ${state.settings.company_name} kamu sudah aktif.\n\n` +
    `Buka: ${location.origin}/\nNo. HP: ${showPhone(e.phone)}\nPIN: ${pin}\n\n` +
    'Pasang ke layar utama HP, lalu login. Jangan bagikan PIN ke siapa pun.';
  return `https://wa.me/${e.phone}?text=${encodeURIComponent(msg)}`;
}
function showPin(e, title = 'PIN dibuat') {
  dialog(`
    <h2>${esc(title)}</h2>
    <p class="muted" style="margin:0">${esc(e.name)} · ${esc(showPhone(e.phone))}</p>
    <div class="pin-box">${esc(e.pin)}</div>
    <p class="muted" style="margin:0;font-size:13px">PIN hanya ditampilkan sekali. Kirim sekarang, atau reset lagi nanti kalau lupa.</p>
    <div class="dlg-actions">
      <button type="button" class="ghost" data-close>Tutup</button>
      <a class="btn" href="${waLink(e, e.pin)}" target="_blank" rel="noopener">Kirim via WA</a>
    </div>`);
}

// ---------- Tab ----------
let currentTab = 'today';
const loaders = {};
function switchTab(tab) {
  currentTab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('main > section').forEach((s) => (s.hidden = s.id !== 'tab-' + tab));
  try { localStorage.setItem('admin_tab', tab); } catch { /* opsional */ }
  loaders[tab]?.().catch((err) => toast(err.message, true));
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) switchTab(b.dataset.tab);
});

// ===== HARI INI =====
async function loadToday() {
  const date = $('#t-date').value || state.today;
  $('#t-date').value = date;
  const q = new URLSearchParams({ date, division_id: $('#t-division').value, type: $('#t-type').value });
  const d = await api('/api/admin/overview?' + q);
  const isToday = date === state.today;
  $('#t-holiday').hidden = !d.holiday;
  $('#t-holiday').textContent = d.holiday ? `Libur nasional: ${d.holiday}. Yang masuk ditandai "Masuk hari libur".` : '';
  const s = d.stats;
  $('#t-stats').innerHTML = `
    <div class="stat"><div class="n">${s.total}</div><div class="l">Wajib hadir</div></div>
    <div class="stat ok"><div class="n">${s.present}</div><div class="l">Hadir</div></div>
    <div class="stat warn"><div class="n">${s.late}</div><div class="l">Terlambat</div></div>
    <div class="stat info"><div class="n">${s.pending}</div><div class="l">Luar kantor, menunggu ACC</div></div>
    <div class="stat danger"><div class="n">${s.absent}</div><div class="l">${isToday ? 'Belum absen / ditolak' : 'Tidak hadir'}</div></div>`;
  $('#t-table').innerHTML = `
    <thead><tr><th>Karyawan</th><th>Jadwal</th><th>Masuk</th><th>Pulang</th><th>Status</th><th>Aksi</th></tr></thead>
    <tbody>${d.rows.length ? d.rows.map((r) => `
      <tr data-emp="${r.employee_id}">
        <td><div class="who"><span class="n">${esc(r.name)}</span><span class="s">${esc(r.division || 'Tanpa divisi')} · ${typeLabel(r.emp_type)}</span></div></td>
        <td class="mono">${r.off ? '<span class="badge">Libur</span>' : esc(r.schedule)}</td>
        <td>${timeCell(r.in)}</td>
        <td>${timeCell(r.out)}${r.early ? ' <span class="badge warn">Pulang cepat</span>' : ''}${r.minutes != null ? `<div class="muted" style="font-size:12px">${fmtDur(r.minutes)}</div>` : ''}</td>
        <td>${statusBadge(r.status, isToday)}</td>
        <td><div class="actions">
          ${[r.in, r.out].filter((x) => x?.approval === 'pending').map((x) => `
            <button class="ok small" data-decide="approved" data-id="${x.id}">Setujui ${x.type === 'in' ? 'masuk' : 'pulang'}</button>
            <button class="ghost small" data-decide="rejected" data-id="${x.id}">Tolak</button>`).join('')}
          ${!r.in || !r.out ? `<button class="ghost small" data-manual="${!r.in ? 'in' : 'out'}">+ ${!r.in ? 'Masuk' : 'Pulang'} manual</button>` : ''}
          ${[r.in, r.out].filter(Boolean).map((x) => `<button class="ghost small" data-del="${x.id}" title="Hapus absen ${x.type === 'in' ? 'masuk' : 'pulang'}">Hapus ${x.type === 'in' ? 'masuk' : 'pulang'}</button>`).join('')}
        </div></td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">Belum ada karyawan. Tambahkan di tab Karyawan.</td></tr>'}</tbody>`;
  $('#t-updated').textContent = 'Diperbarui ' + new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  refreshCounts().catch(() => {});
}
loaders.today = loadToday;
['#t-date', '#t-division', '#t-type'].forEach((s) => $(s).addEventListener('change', () => loadToday().catch((e) => toast(e.message, true))));
$('#t-refresh').addEventListener('click', () => loadToday().catch((e) => toast(e.message, true)));
setInterval(() => {
  if (currentTab === 'today' && !document.hidden && !$('#dlg').open) loadToday().catch(() => {});
}, 30000);

async function decide(id, decision) {
  if (decision === 'rejected' && !confirm('Tolak absen ini? Hari itu akan dihitung tidak hadir.')) return false;
  await api(`/api/admin/attendance/${id}/decision`, { body: { decision } });
  toast(decision === 'approved' ? 'Disetujui.' : 'Ditolak.');
  return true;
}

$('#t-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  try {
    if (btn.dataset.decide) {
      if (await decide(btn.dataset.id, btn.dataset.decide)) loadToday();
    } else if (btn.dataset.del) {
      if (!confirm('Hapus data absen ini? Foto ikut terhapus.')) return;
      await api(`/api/admin/attendance/${btn.dataset.del}`, { method: 'DELETE' });
      toast('Absen dihapus.');
      loadToday();
    } else if (btn.dataset.manual) {
      const empId = btn.closest('tr').dataset.emp;
      const name = btn.closest('tr').querySelector('.n').textContent;
      const type = btn.dataset.manual;
      dialog(`
        <h2>Input absen ${type === 'in' ? 'masuk' : 'pulang'} manual</h2>
        <p class="muted" style="margin:0">${esc(name)} · ${esc(fmtDate($('#t-date').value))}</p>
        <label class="field">Jam <input type="time" name="time" required></label>
        <label class="field">Keterangan <input name="note" maxlength="300" placeholder="Contoh: lupa absen, dikonfirmasi atasan"></label>
        <div class="dlg-actions">${cancelBtn}<button type="submit">Simpan</button></div>`,
      async (f) => {
        await api('/api/admin/attendance', { body: { employee_id: empId, type, date: $('#t-date').value, time: f.get('time'), note: f.get('note') } });
        toast('Absen manual disimpan.');
        loadToday();
      });
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// ===== PETA =====
let map = null, mapLayer = null;
const MARK = { present: '#067647', late: '#d97706', pending: '#2563eb', rejected: '#b42318', holiday: '#0f766e' };
async function loadMap() {
  await Promise.all([loadCss(LIB.leafletCss), loadScript(LIB.leafletJs)]);
  const date = $('#m-date').value || state.today;
  $('#m-date').value = date;
  const d = await api('/api/admin/map?date=' + date);
  const L = window.L;
  if (!map) {
    map = L.map('map').setView([-6.2, 106.82], 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
  }
  mapLayer?.remove();
  mapLayer = L.featureGroup().addTo(map);
  for (const l of d.locations) {
    L.circle([l.lat, l.lng], { radius: l.radius_m, color: '#0f766e', weight: 1, fillOpacity: 0.12 })
      .bindTooltip(esc(l.name)).addTo(mapLayer);
  }
  const which = $('#m-type').value;
  let n = 0;
  for (const day of d.days) {
    const r = day[which];
    if (!r || r.lat == null) continue;
    n++;
    const status = r.approval === 'rejected' ? 'rejected' : r.approval === 'pending' ? 'pending' : r.late ? 'late' : day.status === 'holiday' ? 'holiday' : 'present';
    L.circleMarker([r.lat, r.lng], { radius: 8, color: '#fff', weight: 2, fillColor: MARK[status], fillOpacity: 1 })
      .bindPopup(`<b>${esc(day.name)}</b><br>${esc(day.division || '')}<br>${which === 'in' ? 'Masuk' : 'Pulang'} ${hhmm(r.time)} · ${esc(r.outside ? 'Luar kantor' : r.location || '')}
        ${r.note ? `<br>“${esc(r.note)}”` : ''}${r.address ? `<br><small>${esc(r.address)}</small>` : ''}
        <br><a href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank" rel="noopener">Buka di Google Maps</a>
        ${r.photo ? `<img src="${esc(r.photo)}" alt="">` : ''}`)
      .addTo(mapLayer);
  }
  setTimeout(() => {
    map.invalidateSize();
    if (mapLayer.getLayers().length) map.fitBounds(mapLayer.getBounds().pad(0.2), { maxZoom: 16 });
  }, 50);
  $('#m-info').textContent = `${n} titik absen ${which === 'in' ? 'masuk' : 'pulang'} pada ${fmtDate(date)}.` +
    (d.locations.length ? '' : ' Lokasi kantor belum diatur (tab Pengaturan).');
}
loaders.map = loadMap;
['#m-date', '#m-type'].forEach((s) => $(s).addEventListener('change', () => loadMap().catch((e) => toast(e.message, true))));

// ===== PERSETUJUAN =====
async function loadApprovals() {
  const { items } = await api('/api/admin/approvals');
  $('#a-table').innerHTML = `
    <thead><tr><th>Foto absen / profil</th><th>Karyawan</th><th>Waktu</th><th>Lokasi & keterangan</th><th>Aksi</th></tr></thead>
    <tbody>${items.length ? items.map((a) => `
      <tr>
        <td><div class="row">
          ${a.photo ? `<img class="thumb" src="${esc(a.photo)}" data-photo="${esc(a.photo)}" alt="Selfie">` : ''}
          ${a.profile_photo ? `<img class="thumb" src="${esc(a.profile_photo)}" data-photo="${esc(a.profile_photo)}" alt="Foto profil">` : ''}
        </div></td>
        <td><div class="who"><span class="n">${esc(a.name)}</span><span class="s">${esc(a.division || '')}</span></div></td>
        <td class="mono">${esc(fmtDate(a.date))}<br>${a.type === 'in' ? 'Masuk' : 'Pulang'} ${hhmm(a.time)}</td>
        <td><div class="cell-time"><span>“${esc(a.note || '-')}”</span>
          <span class="sub">±${fmtDist(a.distance)} dari kantor · ${mapsLink(a)}</span>
          ${a.address ? `<span class="sub">${esc(a.address)}</span>` : ''}</div></td>
        <td><div class="actions">
          <button class="ok small" data-decide="approved" data-id="${a.id}">Setujui</button>
          <button class="ghost small" data-decide="rejected" data-id="${a.id}">Tolak</button>
        </div></td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty">Tidak ada yang menunggu persetujuan.</td></tr>'}</tbody>`;
  refreshCounts().catch(() => {});
}
loaders.approvals = loadApprovals;
$('#a-refresh').addEventListener('click', () => loadApprovals().catch((e) => toast(e.message, true)));
$('#a-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-decide]');
  if (!btn) return;
  try {
    if (await decide(btn.dataset.id, btn.dataset.decide)) loadApprovals();
  } catch (err) {
    toast(err.message, true);
  }
});

// ===== REKAP =====
function recapQuery() {
  return new URLSearchParams({
    from: $('#r-from').value, to: $('#r-to').value, division_id: $('#r-division').value,
    type: $('#r-type').value, employee_id: $('#r-employee').value,
  });
}
async function loadRecap() {
  if (!$('#r-from').value) {
    $('#r-from').value = state.today.slice(0, 8) + '01';
    $('#r-to').value = state.today;
  }
  if (!state.employees.length) await loadEmployees();
  const sel = $('#r-employee'), v = sel.value;
  sel.innerHTML = '<option value="">Semua</option>' + state.employees.filter((e) => e.status !== 'pending')
    .map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  sel.value = v;
  const d = await api('/api/admin/recap?' + recapQuery());
  $('#r-summary').innerHTML = `
    <thead><tr><th>Nama</th><th>Divisi</th><th>Tipe</th><th class="num">Hadir</th><th class="num">Telat</th><th class="num">Pulang cepat</th>
      <th class="num">Luar kantor</th><th class="num">Menunggu</th><th class="num">Ditolak</th><th class="num">Masuk hari libur</th>
      <th class="num">Tanpa absen pulang</th><th class="num">Total jam</th></tr></thead>
    <tbody>${d.summary.length ? d.summary.map((s) => `
      <tr><td>${esc(s.name)}</td><td>${esc(s.division || '')}</td><td>${typeLabel(s.emp_type)}</td>
        <td class="num">${s.present}</td><td class="num">${s.late || ''}</td><td class="num">${s.early || ''}</td>
        <td class="num">${s.outside || ''}</td><td class="num">${s.pending || ''}</td><td class="num">${s.rejected || ''}</td>
        <td class="num">${s.holiday || ''}</td><td class="num">${s.no_out || ''}</td><td class="num">${fmtDur(s.minutes)}</td></tr>`).join('')
      : '<tr><td colspan="12" class="empty">Tidak ada data.</td></tr>'}</tbody>`;
  $('#r-days').innerHTML = `
    <thead><tr><th>Tanggal</th><th>Nama</th><th>Masuk</th><th>Pulang</th><th>Durasi</th><th>Status</th></tr></thead>
    <tbody>${d.days.length ? d.days.map((x) => `
      <tr><td class="mono">${esc(fmtDate(x.date))}</td>
        <td><div class="who"><span class="n">${esc(x.name)}</span><span class="s">${esc(x.division || '')}</span></div></td>
        <td>${timeCell(x.in)}</td><td>${timeCell(x.out)}${x.early ? ' <span class="badge warn">Pulang cepat</span>' : ''}</td>
        <td class="mono">${fmtDur(x.minutes)}</td><td>${statusBadge(x.status)}</td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">Tidak ada absen pada periode ini.</td></tr>'}</tbody>`;
}
loaders.recap = loadRecap;
$('#r-show').addEventListener('click', () => loadRecap().catch((e) => toast(e.message, true)));
$('#r-export').addEventListener('click', () => { location.href = '/api/admin/export.csv?' + recapQuery(); });

// ===== KARYAWAN =====
async function loadEmployeesTab() {
  await Promise.all([loadEmployees(), loadDivisions()]);
  renderPending();
  renderEmployees();
  refreshCounts().catch(() => {});
}
loaders.employees = loadEmployeesTab;

function renderPending() {
  const pending = state.employees.filter((e) => e.status === 'pending');
  $('#e-pending-wrap').hidden = !pending.length;
  $('#e-pending').innerHTML = `
    <thead><tr><th>Foto</th><th>Nama & No. HP</th><th>Divisi</th><th>Tipe</th><th>Daftar</th><th>Aksi</th></tr></thead>
    <tbody>${pending.map((e) => `
      <tr data-id="${e.id}">
        <td>${e.profile_photo ? `<img class="thumb" src="${esc(e.profile_photo)}" data-photo="${esc(e.profile_photo)}" alt="">` : ''}</td>
        <td><div class="who"><span class="n">${esc(e.name)}</span><span class="s">${esc(showPhone(e.phone))}</span></div></td>
        <td><select data-f="division_id">${divisionOptions(e.division_id)}</select></td>
        <td><select data-f="type"><option value="karyawan">Karyawan</option><option value="freelance" ${e.type === 'freelance' ? 'selected' : ''}>Freelance</option></select></td>
        <td class="muted">${esc(e.created_at.slice(0, 16))}</td>
        <td><div class="actions">
          <button class="ok small" data-act="approve">Setujui</button>
          <button class="ghost small" data-act="reject">Tolak</button>
        </div></td>
      </tr>`).join('')}</tbody>`;
}

function renderEmployees() {
  const q = $('#e-search').value.trim().toLowerCase();
  const div = $('#e-division').value, type = $('#e-type').value, status = $('#e-status').value;
  const list = state.employees.filter((e) => e.status !== 'pending'
    && (!q || e.name.toLowerCase().includes(q) || showPhone(e.phone).includes(q) || e.phone.includes(q))
    && (!div || String(e.division_id) === div) && (!type || e.type === type) && (!status || e.status === status));
  $('#e-table').innerHTML = `
    <thead><tr><th>Nama & No. HP</th><th>Divisi</th><th>Tipe</th><th>Status</th><th>HP terhubung</th><th>Aksi</th></tr></thead>
    <tbody>${list.length ? list.map((e) => `
      <tr data-id="${e.id}">
        <td><div class="row" style="gap:10px;flex-wrap:nowrap">
          ${e.profile_photo ? `<img class="thumb" src="${esc(e.profile_photo)}" data-photo="${esc(e.profile_photo)}" alt="">` : ''}
          <div class="who"><span class="n">${esc(e.name)}</span><span class="s">${esc(showPhone(e.phone))}</span></div></div></td>
        <td>${esc(e.division || '—')} ${e.supervisor ? '<span class="badge accent">Atasan</span>' : ''}</td>
        <td>${typeLabel(e.type)}</td>
        <td>${e.status === 'active' ? '<span class="badge ok">Aktif</span>' : '<span class="badge">Nonaktif</span>'}
            ${e.locked ? '<span class="badge danger">Terkunci</span>' : ''}</td>
        <td>${e.has_device ? 'Ya' : '<span class="muted">Belum</span>'}</td>
        <td><div class="actions">
          <button class="ghost small" data-act="edit">Edit</button>
          <button class="ghost small" data-act="reset-pin">Reset PIN</button>
          ${e.has_device ? '<button class="ghost small" data-act="reset-device">Reset HP</button>' : ''}
          ${e.locked ? '<button class="small" data-act="unlock">Buka kunci</button>' : ''}
        </div></td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">Tidak ada karyawan yang cocok.</td></tr>'}</tbody>`;
}
['#e-search', '#e-division', '#e-type', '#e-status'].forEach((s) => $(s).addEventListener('input', renderEmployees));

$('#e-pending').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr'), id = tr.dataset.id;
  try {
    if (btn.dataset.act === 'approve') {
      const r = await api(`/api/admin/employees/${id}/approve`, {
        body: { division_id: $('[data-f=division_id]', tr).value, type: $('[data-f=type]', tr).value },
      });
      await loadEmployeesTab();
      showPin(r, 'Pendaftaran disetujui');
    } else if (confirm('Tolak pendaftaran ini? Datanya akan dihapus.')) {
      await api(`/api/admin/employees/${id}/reject`, { body: {} });
      toast('Pendaftaran ditolak.');
      loadEmployeesTab();
    }
  } catch (err) {
    toast(err.message, true);
  }
});

function employeeForm(e = {}) {
  return `
    <label class="field">Nama lengkap <input name="name" required maxlength="80" value="${esc(e.name)}"></label>
    <label class="field">No. HP (WhatsApp) <input name="phone" type="tel" required value="${esc(showPhone(e.phone))}" placeholder="0812xxxxxxxx"></label>
    <div class="form-grid">
      <label class="field">Divisi <select name="division_id">${divisionOptions(e.division_id)}</select></label>
      <label class="field">Tipe <select name="type"><option value="karyawan">Karyawan</option><option value="freelance" ${e.type === 'freelance' ? 'selected' : ''}>Freelance</option></select></label>
    </div>`;
}

$('#e-add').addEventListener('click', () => {
  dialog(`<h2>Tambah karyawan</h2>${employeeForm()}
    <p class="muted" style="margin:0;font-size:13px">PIN 4 angka dibuat otomatis setelah disimpan.</p>
    <div class="dlg-actions">${cancelBtn}<button type="submit">Simpan</button></div>`,
  async (f) => {
    const r = await api('/api/admin/employees', { body: Object.fromEntries(f) });
    await loadEmployeesTab();
    setTimeout(() => showPin(r, 'Karyawan ditambahkan'), 0);
  });
});

$('#e-table').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('tr').dataset.id);
  const emp = state.employees.find((x) => x.id === id);
  try {
    if (btn.dataset.act === 'edit') {
      dialog(`<h2>Edit karyawan</h2>${employeeForm(emp)}
        <label class="field">Status <select name="status"><option value="active">Aktif</option><option value="inactive" ${emp.status === 'inactive' ? 'selected' : ''}>Nonaktif (tidak bisa login)</option></select></label>
        <div class="dlg-actions">${cancelBtn}<button type="submit">Simpan</button></div>`,
      async (f) => {
        await api(`/api/admin/employees/${id}`, { method: 'PUT', body: Object.fromEntries(f) });
        toast('Tersimpan.');
        loadEmployeesTab();
      });
    } else if (btn.dataset.act === 'reset-pin') {
      if (!confirm(`Buat PIN baru untuk ${emp.name}? PIN lama tidak berlaku lagi dan ia harus login ulang.`)) return;
      showPin(await api(`/api/admin/employees/${id}/reset-pin`, { body: {} }), 'PIN baru');
      loadEmployeesTab();
    } else if (btn.dataset.act === 'reset-device') {
      if (!confirm(`Lepas HP yang terhubung ke akun ${emp.name}? Ia bisa login dari HP baru.`)) return;
      await api(`/api/admin/employees/${id}/reset-device`, { body: {} });
      toast('Perangkat direset.');
      loadEmployeesTab();
    } else if (btn.dataset.act === 'unlock') {
      await api(`/api/admin/employees/${id}/unlock`, { body: {} });
      toast('Akun dibuka.');
      loadEmployeesTab();
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// --- Import Excel ---
const HEADER_MAP = [
  [/^nama/, 'name'],
  [/(no\.?\s*)?(hp|handphone|telp|telepon|wa|whatsapp)/, 'phone'],
  [/^divisi|^bagian|^departemen/, 'division'],
  [/^tipe|^jenis|^status/, 'type'],
];
function sheetRows(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const headerIdx = raw.findIndex((r) => r.some((c) => /nama/i.test(String(c))));
  if (headerIdx < 0) throw new Error('Kolom "Nama" tidak ditemukan. Pakai template yang disediakan.');
  const cols = raw[headerIdx].map((h) => {
    const k = String(h).trim().toLowerCase();
    return HEADER_MAP.find(([re]) => re.test(k))?.[1] || null;
  });
  if (!cols.includes('phone')) throw new Error('Kolom "No HP" tidak ditemukan.');
  return raw.slice(headerIdx + 1)
    .map((r, i) => [r, headerIdx + 2 + i]) // nomor baris di Excel
    .filter(([r]) => r.some((c) => String(c).trim()))
    .map(([r, excelRow]) => {
      const o = { row: excelRow };
      cols.forEach((k, i) => {
        if (!k) return;
        const v = r[i];
        o[k] = typeof v === 'number' ? String(Math.round(v)) : String(v).trim();
      });
      return o;
    });
}

$('#e-import').addEventListener('click', () => {
  let rows = [];
  const body = dialog(`
    <h2>Import karyawan dari Excel</h2>
    <p class="muted" style="margin:0">Kolom: <b>Nama</b>, <b>No HP</b>, <b>Divisi</b>, <b>Tipe</b> (Karyawan / Freelance). Divisi baru dibuat otomatis. PIN 4 angka dibuat acak untuk tiap orang.</p>
    <div class="row"><button type="button" class="ghost small" id="imp-template">Unduh template</button></div>
    <input type="file" id="imp-file" accept=".xlsx,.xls,.csv">
    <div id="imp-preview" class="stack"></div>
    <div class="dlg-actions">${cancelBtn}<button type="submit" id="imp-commit" disabled>Import</button></div>`,
  async () => {
    const r = await api('/api/admin/import', { body: { rows, commit: true } });
    await loadEmployeesTab();
    setTimeout(() => showImportResult(r.created), 0);
  });
  body.closest('dialog').style.width = 'min(760px, calc(100vw - 32px))';

  $('#imp-template', body).onclick = async () => {
    try {
      await loadScript(LIB.xlsx);
      const XLSX = window.XLSX;
      const ws = XLSX.utils.aoa_to_sheet([['Nama', 'No HP', 'Divisi', 'Tipe'], ['Contoh Nama', '081234567890', 'Marketing', 'Karyawan'], ['Contoh Freelance', '081298765432', 'Workshop', 'Freelance']]);
      ws['!cols'] = [{ wch: 28 }, { wch: 16 }, { wch: 18 }, { wch: 12 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Karyawan');
      XLSX.writeFile(wb, 'template-import-karyawan.xlsx');
    } catch (err) {
      toast(err.message, true);
    }
  };

  $('#imp-file', body).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const prev = $('#imp-preview', body);
    prev.innerHTML = '<span class="spinner"></span>';
    try {
      await loadScript(LIB.xlsx);
      const wb = window.XLSX.read(await file.arrayBuffer());
      rows = sheetRows(window.XLSX, wb);
      const { results } = await api('/api/admin/import', { body: { rows, commit: false } });
      const ok = results.filter((r) => r.ok).length;
      const newDivs = [...new Set(results.filter((r) => r.ok && r.new_division).map((r) => r.division))];
      prev.innerHTML = `
        <div class="row"><span class="badge ok">${ok} siap diimport</span>
          ${results.length - ok ? `<span class="badge danger">${results.length - ok} bermasalah (dilewati)</span>` : ''}
          ${newDivs.length ? `<span class="badge info">Divisi baru: ${esc(newDivs.join(', '))}</span>` : ''}</div>
        <div class="table-wrap" style="max-height:320px;box-shadow:none"><table>
          <thead><tr><th>Baris</th><th>Nama</th><th>No. HP</th><th>Divisi</th><th>Tipe</th><th>Cek</th></tr></thead>
          <tbody>${results.map((r) => `<tr><td>${r.row}</td><td>${esc(r.name)}</td><td>${esc(/^62\d+$/.test(r.phone) ? showPhone(r.phone) : r.phone)}</td><td>${esc(r.division)}</td>
            <td>${typeLabel(r.type)}</td><td>${r.ok ? '<span class="badge ok">OK</span>' : `<span class="badge danger">${esc(r.error)}</span>`}</td></tr>`).join('')}</tbody>
        </table></div>`;
      $('#imp-commit', body).disabled = !ok;
      $('#imp-commit', body).textContent = `Import ${ok} orang`;
    } catch (err) {
      prev.innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
      $('#imp-commit', body).disabled = true;
    }
  };
});

function showImportResult(created) {
  const body = dialog(`
    <h2>${created.length} karyawan berhasil diimport</h2>
    <p class="muted" style="margin:0">Daftar PIN ini <b>hanya muncul sekali</b>. Unduh Excel-nya atau kirim satu per satu via WA sekarang.</p>
    <div class="row"><button type="button" id="imp-download">Unduh daftar PIN (Excel)</button></div>
    <div class="table-wrap" style="max-height:360px;box-shadow:none"><table>
      <thead><tr><th>Nama</th><th>No. HP</th><th>PIN</th><th></th></tr></thead>
      <tbody>${created.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(showPhone(c.phone))}</td><td class="mono"><b>${esc(c.pin)}</b></td>
        <td><a class="btn small ghost" href="${waLink(c, c.pin)}" target="_blank" rel="noopener">Kirim via WA</a></td></tr>`).join('')}</tbody>
    </table></div>
    <div class="dlg-actions"><button type="button" class="ghost" data-close>Tutup</button></div>`);
  body.closest('dialog').style.width = 'min(760px, calc(100vw - 32px))';
  $('#imp-download', body).onclick = () => {
    const XLSX = window.XLSX;
    const ws = XLSX.utils.aoa_to_sheet([['Nama', 'No HP', 'Divisi', 'Tipe', 'PIN'],
      ...created.map((c) => [c.name, showPhone(c.phone), c.division, typeLabel(c.type), c.pin])]);
    ws['!cols'] = [{ wch: 28 }, { wch: 16 }, { wch: 18 }, { wch: 12 }, { wch: 8 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'PIN');
    XLSX.writeFile(wb, `pin-karyawan-${state.today}.xlsx`);
  };
}

// ===== PENGATURAN =====
async function loadSettings() {
  const [{ settings }] = await Promise.all([api('/api/admin/settings'), loadDivisions(), loadEmployees()]);
  const f = $('#s-form');
  f.company_name.value = settings.company_name;
  f.timezone.value = settings.timezone;
  f.join_code.value = settings.join_code;
  f.require_photo.checked = settings.require_photo;
  f.device_lock.checked = settings.device_lock;
  f.geocode.checked = settings.geocode;

  const link = location.origin + '/';
  $('#s-link').value = link;
  loadScript(LIB.qr).then(() => {
    $('#s-qr').innerHTML = '';
    new window.QRCode($('#s-qr'), { text: link, width: 148, height: 148 });
  }).catch(() => ($('#s-qr').hidden = true));

  renderDivisions();
  await Promise.all([loadLocations(), loadHolidays()]);
}
loaders.settings = loadSettings;

$('#s-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/admin/settings', { method: 'PUT', body: {
      company_name: f.company_name.value, timezone: f.timezone.value, join_code: f.join_code.value,
      require_photo: f.require_photo.checked, device_lock: f.device_lock.checked, geocode: f.geocode.checked,
    } });
    toast('Pengaturan disimpan.');
    refreshCounts();
  } catch (err) {
    toast(err.message, true);
  }
});
$('#s-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#s-link').value); toast('Link disalin.'); }
  catch { $('#s-link').select(); }
});

// --- Divisi ---
function renderDivisions() {
  $('#d-table').innerHTML = `
    <thead><tr><th>Divisi</th><th>Jam kerja</th><th>Hari kerja</th><th>Atasan</th><th class="num">Anggota aktif</th><th></th></tr></thead>
    <tbody>${state.divisions.length ? state.divisions.map((d) => `
      <tr data-id="${d.id}"><td><b>${esc(d.name)}</b></td><td class="mono">${esc(d.work_start)}–${esc(d.work_end)}</td>
        <td>${d.work_days.split(',').map((x) => DAYS[x]).join(', ')}</td>
        <td>${esc(d.supervisor_name || '—')}</td><td class="num">${d.members}</td>
        <td><div class="actions"><button class="ghost small" data-act="edit">Edit</button>
          ${d.members ? '' : '<button class="ghost small" data-act="delete">Hapus</button>'}</div></td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">Belum ada divisi. Tambahkan, atau otomatis dibuat saat import Excel.</td></tr>'}</tbody>`;
}
function divisionDialog(d = { work_start: '08:00', work_end: '17:00', work_days: '1,2,3,4,5' }) {
  const days = d.work_days.split(',');
  const candidates = state.employees.filter((e) => e.status === 'active');
  dialog(`
    <h2>${d.id ? 'Edit divisi' : 'Tambah divisi'}</h2>
    <label class="field">Nama divisi <input name="name" required maxlength="60" value="${esc(d.name)}"></label>
    <div class="form-grid">
      <label class="field">Jam masuk <input type="time" name="work_start" required value="${esc(d.work_start)}"></label>
      <label class="field">Jam pulang <input type="time" name="work_end" required value="${esc(d.work_end)}"></label>
    </div>
    <div class="field" style="display:grid;gap:4px"><span class="muted" style="font-size:13px;font-weight:600">Hari kerja</span>
      <div class="days">${[1, 2, 3, 4, 5, 6, 0].map((i) => `<label><input type="checkbox" name="work_days" value="${i}" ${days.includes(String(i)) ? 'checked' : ''}>${DAYS[i]}</label>`).join('')}</div>
    </div>
    <label class="field">Atasan (menyetujui absen luar kantor)
      <select name="supervisor_id"><option value="">— Belum ada (HRD yang menyetujui)</option>
        ${candidates.map((e) => `<option value="${e.id}" ${e.id === d.supervisor_id ? 'selected' : ''}>${esc(e.name)}${e.division ? ' · ' + esc(e.division) : ''}</option>`).join('')}
      </select></label>
    <div class="dlg-actions">${cancelBtn}<button type="submit">Simpan</button></div>`,
  async (f) => {
    const body = { name: f.get('name'), work_start: f.get('work_start'), work_end: f.get('work_end'),
                   work_days: f.getAll('work_days'), supervisor_id: f.get('supervisor_id') };
    await api(d.id ? `/api/admin/divisions/${d.id}` : '/api/admin/divisions', { method: d.id ? 'PUT' : 'POST', body });
    toast('Divisi disimpan.');
    await loadDivisions();
    renderDivisions();
  });
}
$('#d-add').addEventListener('click', () => divisionDialog());
$('#d-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const d = state.divisions.find((x) => x.id === Number(btn.closest('tr').dataset.id));
  if (btn.dataset.act === 'edit') return divisionDialog(d);
  if (!confirm(`Hapus divisi ${d.name}?`)) return;
  try {
    await api(`/api/admin/divisions/${d.id}`, { method: 'DELETE' });
    await loadDivisions();
    renderDivisions();
  } catch (err) {
    toast(err.message, true);
  }
});

// --- Lokasi ---
let locations = [];
async function loadLocations() {
  locations = (await api('/api/admin/locations')).locations;
  $('#l-table').innerHTML = `
    <thead><tr><th>Nama</th><th>Koordinat</th><th class="num">Radius</th><th></th></tr></thead>
    <tbody>${locations.length ? locations.map((l) => `
      <tr data-id="${l.id}"><td><b>${esc(l.name)}</b></td>
        <td class="mono">${l.lat.toFixed(6)}, ${l.lng.toFixed(6)} · <a href="https://www.google.com/maps?q=${l.lat},${l.lng}" target="_blank" rel="noopener">Maps</a></td>
        <td class="num">${l.radius_m} m</td>
        <td><div class="actions"><button class="ghost small" data-act="edit">Edit</button><button class="ghost small" data-act="delete">Hapus</button></div></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">Belum ada lokasi. Selama kosong, semua absen dianggap di kantor.</td></tr>'}</tbody>`;
}
function parseCoords(text) {
  const m = String(text).match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
function locationDialog(l = { radius_m: 150 }) {
  const body = dialog(`
    <h2>${l.id ? 'Edit lokasi' : 'Tambah lokasi kantor'}</h2>
    <label class="field">Nama <input name="name" required maxlength="60" placeholder="Kantor / Workshop" value="${esc(l.name)}"></label>
    <label class="field">Koordinat (lat, lng)
      <input name="coords" required placeholder="-6.200000, 106.816666" value="${l.id ? `${l.lat}, ${l.lng}` : ''}"></label>
    <p class="muted" style="margin:0;font-size:13px">Cara cepat: buka Google Maps, klik kanan titik kantor, klik angka koordinat (otomatis tersalin), lalu tempel di sini. Atau datang ke lokasi dan tekan tombol di bawah.</p>
    <div class="row"><button type="button" class="ghost small" id="loc-here">Pakai lokasi saya sekarang</button></div>
    <label class="field">Radius (meter) <input type="number" name="radius_m" min="10" max="100000" required value="${l.radius_m}"></label>
    <div class="dlg-actions">${cancelBtn}<button type="submit">Simpan</button></div>`,
  async (f) => {
    const c = parseCoords(f.get('coords'));
    if (!c) throw new Error('Format koordinat: -6.2, 106.8');
    const payload = { name: f.get('name'), lat: c[0], lng: c[1], radius_m: f.get('radius_m') };
    await api(l.id ? `/api/admin/locations/${l.id}` : '/api/admin/locations', { method: l.id ? 'PUT' : 'POST', body: payload });
    toast('Lokasi disimpan.');
    loadLocations();
  });
  $('#loc-here', body).onclick = () => {
    navigator.geolocation?.getCurrentPosition(
      (p) => { body.coords.value = `${p.coords.latitude.toFixed(6)}, ${p.coords.longitude.toFixed(6)}`; toast(`Akurasi ±${Math.round(p.coords.accuracy)} m`); },
      () => toast('Lokasi tidak bisa diambil. Izinkan akses lokasi.', true),
      { enableHighAccuracy: true, timeout: 20000 },
    );
  };
}
$('#l-add').addEventListener('click', () => locationDialog());
$('#l-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const l = locations.find((x) => x.id === Number(btn.closest('tr').dataset.id));
  if (btn.dataset.act === 'edit') return locationDialog(l);
  if (!confirm(`Hapus lokasi ${l.name}?`)) return;
  await api(`/api/admin/locations/${l.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, true));
  loadLocations();
});

// --- Libur ---
async function loadHolidays() {
  const { holidays } = await api('/api/admin/holidays');
  $('#h-table').innerHTML = `<tbody>${holidays.length ? holidays.map((h) => `
    <tr><td class="mono">${esc(fmtDate(h.date))}</td><td>${esc(h.name)}</td>
      <td><button class="ghost small" data-del="${h.date}">Hapus</button></td></tr>`).join('')
    : '<tr><td class="empty">Belum ada libur nasional.</td></tr>'}</tbody>`;
}
$('#h-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/holidays', { body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    loadHolidays();
  } catch (err) {
    toast(err.message, true);
  }
});
$('#h-table').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-del]')?.dataset.del;
  if (!d) return;
  await api(`/api/admin/holidays/${d}`, { method: 'DELETE' }).catch((err) => toast(err.message, true));
  loadHolidays();
});

$('#p-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/password', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    toast('Password diganti.');
  } catch (err) {
    toast(err.message, true);
  }
});

// ===== Login / mulai =====
function showLogin() {
  $('#shell').hidden = true;
  $('#login').hidden = false;
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/login', { body: { password: e.target.password.value } });
    e.target.reset();
    start();
  } catch (err) {
    toast(err.message, true);
  }
});
$('#logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { body: {} }).catch(() => {});
  showLogin();
});

async function start() {
  try {
    await refreshCounts();
  } catch {
    return showLogin();
  }
  $('#login').hidden = true;
  $('#shell').hidden = false;
  await loadDivisions().catch(() => {});
  let tab = 'today';
  try { tab = localStorage.getItem('admin_tab') || 'today'; } catch { /* opsional */ }
  switchTab(loaders[tab] ? tab : 'today');
}
start();
