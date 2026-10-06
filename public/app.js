// Aplikasi karyawan (PWA)
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
    throw new Error('Tidak ada koneksi internet. Coba lagi.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* bukan JSON */ }
  if (!res.ok) {
    const err = new Error(data.error || `Gagal (${res.status})`);
    err.status = res.status;
    throw err;
  }
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

function show(id) {
  $$('.view').forEach((v) => (v.hidden = v.id !== 'v-' + id));
  window.scrollTo(0, 0);
}

// ---------- Perangkat ----------
function deviceId() {
  try {
    let id = localStorage.getItem('device_id');
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
      localStorage.setItem('device_id', id);
    }
    return id;
  } catch {
    return '';
  }
}
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Tombol "Pasang aplikasi" untuk Android/Chrome
let installEvent = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('#install-banner').hidden = false;
  $('#install-banner-home').hidden = false;
});
for (const id of ['#install-btn', '#install-btn-home']) {
  $(id).addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    $('#install-banner').hidden = true;
    $('#install-banner-home').hidden = true;
  });
}

// ---------- Format ----------
let me = null;
let clockOffset = 0;
let clockTimer = null;

const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
const hhmm = (t) => (t ? t.slice(0, 5) : '--:--');
function fmtDate(dateStr, opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) {
  return new Intl.DateTimeFormat('id-ID', { ...opts, timeZone: 'UTC' }).format(new Date(dateStr + 'T00:00:00Z'));
}

function recordBadges(r) {
  if (!r) return '';
  const b = [];
  if (r.late) b.push('<span class="badge warn">Telat</span>');
  if (r.holiday) b.push('<span class="badge info">Hari libur</span>');
  if (r.overtime) b.push('<span class="badge accent">Lembur</span>');
  if (r.outside) {
    if (r.approval === 'pending') b.push('<span class="badge warn">Menunggu ACC</span>');
    else if (r.approval === 'approved') b.push('<span class="badge ok">Luar kantor ✓</span>');
    else if (r.approval === 'rejected') b.push('<span class="badge danger">Ditolak</span>');
  } else if (r.location) {
    b.push(`<span class="badge accent">${esc(r.location)}</span>`);
  }
  return b.join(' ');
}

// ---------- Beranda ----------
async function loadHome() {
  me = await api('/api/me');
  $$('.company-name').forEach((el) => (el.textContent = me.settings.company_name));
  const e = me.employee;
  const hour = Number(new Intl.DateTimeFormat('en', { hour: 'numeric', hourCycle: 'h23', timeZone: me.settings.timezone }).format(new Date()));
  const greet = hour < 11 ? 'Selamat pagi' : hour < 15 ? 'Selamat siang' : hour < 18 ? 'Selamat sore' : 'Selamat malam';
  $('#greeting').textContent = `${greet}, ${e.name.split(' ')[0]}`;
  $('#emp-meta').textContent = [e.division || 'Tanpa divisi', e.type === 'freelance' ? 'Freelance' : 'Karyawan'].join(' · ');
  $('#today-date').textContent = fmtDate(me.date);
  const sc = me.schedule;
  $('#schedule').innerHTML = sc.off
    ? `<span class="badge info">Hari libur${sc.holiday_name ? ': ' + esc(sc.holiday_name) : ''}</span> <small>Absen tetap bisa, ditandai hari libur.</small>`
    : `<span class="badge">Jadwal ${esc(sc.work_start)}–${esc(sc.work_end)}</span>`;

  const { in: rin, out: rout } = me.today;
  $('#in-time').textContent = hhmm(rin?.time);
  $('#out-time').textContent = hhmm(rout?.time);
  $('#in-badges').innerHTML = recordBadges(rin);
  $('#out-badges').innerHTML = recordBadges(rout);

  const btn = $('#attend-btn');
  btn.classList.toggle('out', !!rin && !rout);
  if (!rin) { btn.textContent = 'Absen Masuk'; btn.disabled = false; btn.dataset.type = 'in'; }
  else if (!rout) { btn.textContent = 'Absen Pulang'; btn.disabled = false; btn.dataset.type = 'out'; }
  else { btn.textContent = 'Selesai untuk hari ini ✓'; btn.disabled = true; }

  $('#approvals-card').hidden = !me.supervisor;
  $('#approvals-count').textContent = me.pendingApprovals;
  $('#approvals-count').hidden = !me.pendingApprovals;

  clockOffset = me.serverTime - Date.now();
  clearInterval(clockTimer);
  const tick = () => {
    $('#clock').textContent = new Intl.DateTimeFormat('id-ID', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: me.settings.timezone,
    }).format(new Date(Date.now() + clockOffset)).replace(/\./g, ':');
  };
  tick();
  clockTimer = setInterval(tick, 1000);

  show('home');
  loadHistory();
}

async function loadHistory() {
  const { days } = await api('/api/history');
  $('#history').innerHTML = days.length
    ? days.map((d) => `
      <div class="list-item">
        <div class="grow">
          <div style="font-weight:600">${esc(fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</div>
          <div class="row" style="gap:4px">${recordBadges(d.in)}${d.out?.overtime ? ' <span class="badge accent">Lembur</span>' : ''}</div>
        </div>
        <div class="mono" style="text-align:right">${hhmm(d.in?.time)} – ${hhmm(d.out?.time)}</div>
      </div>`).join('')
    : '<p class="muted" style="margin:0">Belum ada absen.</p>';
}

// ---------- Kamera ----------
function createCamera(box) {
  const video = $('video', box), img = $('img', box), msg = $('.cam-msg', box);
  let stream = null;
  return {
    async start() {
      img.hidden = true;
      video.hidden = false;
      msg.textContent = 'Membuka kamera…';
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } }, audio: false,
        });
        video.srcObject = stream;
        await video.play().catch(() => {});
        msg.textContent = '';
        return true;
      } catch {
        msg.textContent = 'Kamera tidak bisa dibuka. Izinkan akses kamera untuk aplikasi ini, lalu coba lagi.';
        return false;
      }
    },
    capture() {
      if (!stream || !video.videoWidth) return null;
      const size = 480, side = Math.min(video.videoWidth, video.videoHeight);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, size, size);
      const data = canvas.toDataURL('image/jpeg', 0.75);
      this.stop();
      img.src = data;
      img.hidden = false;
      video.hidden = true;
      return data;
    },
    stop() {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
    },
  };
}

// ---------- Lembar absen ----------
const sheetCam = createCamera($('#sheet-cam'));
const sheet = { type: 'in', pos: null, photo: null, outside: false, askOt: false, overtime: null };

// Jam sekarang menurut server (JJ:MM), dipakai untuk menentukan perlu tanya lembur atau tidak
const serverHHMM = () => new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: me.settings.timezone,
}).format(new Date(Date.now() + clockOffset));

function setLocStatus(kind, html) {
  const el = $('#loc-status');
  el.className = 'loc-status ' + kind;
  const ico = { ok: '✓', warn: '⚠', danger: '✕', '': '<span class="spinner"></span>' }[kind];
  el.innerHTML = `<span class="ico">${ico}</span><span>${html}</span>`;
}

function evaluateLocation(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  const acc = accuracy > 100 ? `<br><small>Akurasi GPS rendah (±${Math.round(accuracy)} m). Coba di tempat terbuka.</small>` : '';
  if (!me.locations.length) {
    sheet.outside = false;
    setLocStatus('ok', `Lokasi didapat (akurasi ±${Math.round(accuracy)} m)`);
    return;
  }
  let best = null;
  for (const l of me.locations) {
    const d = distance(lat, lng, l.lat, l.lng);
    if (!best || d - l.radius_m < best.d - best.l.radius_m) best = { l, d };
  }
  sheet.outside = best.d > best.l.radius_m;
  if (sheet.outside) {
    setLocStatus('warn', `<b>Di luar area kantor</b> — ±${fmtDist(best.d)} dari ${esc(best.l.name)}.<br>Isi keterangan; absen ini perlu persetujuan atasan.${acc}`);
  } else {
    setLocStatus('ok', `<b>Dalam area ${esc(best.l.name)}</b> (±${fmtDist(best.d)})${acc}`);
  }
}

function distance(lat1, lng1, lat2, lng2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function locate() {
  sheet.pos = null;
  $('#loc-retry').hidden = true;
  setLocStatus('', 'Mencari lokasi…');
  updateSubmit();
  if (!navigator.geolocation) {
    setLocStatus('danger', 'HP ini tidak mendukung lokasi.');
    return;
  }
  const ok = (pos) => {
    sheet.pos = pos;
    evaluateLocation(pos);
    updateSubmit();
  };
  const fail = (err) => {
    setLocStatus('danger', err.code === 1
      ? 'Izin lokasi ditolak. Aktifkan izin lokasi untuk aplikasi/browser ini di Pengaturan HP, lalu coba lagi.'
      : 'Lokasi belum didapat. Pastikan GPS/Lokasi HP aktif, lalu coba lagi.');
    $('#loc-retry').hidden = false;
  };
  // GPS akurat dulu; kalau gagal (misalnya di dalam gedung), ulangi dengan lokasi WiFi/jaringan
  navigator.geolocation.getCurrentPosition(ok, (err) => {
    if (err.code === 1) return fail(err);
    navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: false, timeout: 20000, maximumAge: 30000 });
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

function updateSubmit() {
  // Catatan: selalu ada saat pulang (opsional), wajib kalau di luar kantor atau lembur
  const noteRequired = sheet.outside || sheet.overtime === true;
  $('#note-wrap').hidden = !(sheet.type === 'out' || sheet.outside);
  $('#note-label').textContent = sheet.outside ? 'Keterangan (wajib, kamu di luar kantor)'
    : sheet.overtime === true ? 'Keterangan pekerjaan lembur (wajib)'
    : 'Catatan untuk atasan/HRD (opsional)';
  $('#note').placeholder = sheet.outside ? 'Contoh: Meeting dengan klien di PT ABC, Cikarang'
    : sheet.overtime === true ? 'Contoh: Lanjut pemasangan panel proyek X'
    : 'Contoh: Pulang dari meeting di luar, lanjut kerja dari kantor';
  $('#ot-wrap').hidden = !sheet.askOt;
  $$('#ot-wrap [data-ot]').forEach((b) => b.classList.toggle('selected', sheet.overtime === (b.dataset.ot === '1')));

  const needPhoto = me?.settings.require_photo;
  const ok = sheet.pos && (!needPhoto || sheet.photo)
    && (!noteRequired || $('#note').value.trim().length >= 3)
    && (!sheet.askOt || sheet.overtime !== null);
  $('#submit-btn').disabled = !ok;
}

$('#ot-wrap').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ot]');
  if (!b) return;
  sheet.overtime = b.dataset.ot === '1';
  updateSubmit();
});

async function openSheet(type) {
  const otAfter = me.settings.overtime_ask_after;
  Object.assign(sheet, {
    type, pos: null, photo: null, outside: false, overtime: null,
    askOt: type === 'out' && !!otAfter && serverHHMM() >= otAfter,
  });
  $('#ot-time').textContent = otAfter || '';
  $('#sheet-title').textContent = type === 'in' ? 'Absen Masuk' : 'Absen Pulang';
  $('#note').value = '';
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  locate();
  const needPhoto = me.settings.require_photo;
  $('#sheet-cam-wrap').hidden = !needPhoto;
  $('#shot-btn').hidden = false;
  $('#retake-btn').hidden = true;
  if (needPhoto) await sheetCam.start();
  updateSubmit();
}

function closeSheet() {
  sheetCam.stop();
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
}

$('#attend-btn').addEventListener('click', () => openSheet($('#attend-btn').dataset.type));
$('#sheet-close').addEventListener('click', closeSheet);
$('#loc-retry').addEventListener('click', locate);
$('#note').addEventListener('input', updateSubmit);
$('#shot-btn').addEventListener('click', async () => {
  const data = sheetCam.capture();
  if (!data) {
    await sheetCam.start(); // coba buka kamera lagi (misalnya setelah izin diberikan)
    return;
  }
  sheet.photo = data;
  $('#shot-btn').hidden = true;
  $('#retake-btn').hidden = false;
  updateSubmit();
});
$('#retake-btn').addEventListener('click', async () => {
  sheet.photo = null;
  $('#shot-btn').hidden = false;
  $('#retake-btn').hidden = true;
  updateSubmit();
  await sheetCam.start();
});
$('#submit-btn').addEventListener('click', async () => {
  const btn = $('#submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Mengirim…';
  try {
    const c = sheet.pos.coords;
    const r = await api('/api/attend', {
      body: {
        type: sheet.type, lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, photo: sheet.photo,
        note: $('#note').value, overtime: sheet.askOt ? sheet.overtime : undefined,
      },
    });
    closeSheet();
    navigator.vibrate?.(80);
    const label = r.type === 'in' ? 'masuk' : 'pulang';
    const extra = r.late ? ' (telat)' : r.overtime ? ' (lembur)' : '';
    toast(r.outside ? `Absen ${label} ${hhmm(r.time)} terkirim, menunggu persetujuan.` : `Absen ${label} tercatat ${hhmm(r.time)}${extra}.`);
    await loadHome();
  } catch (err) {
    toast(err.message, true);
    if (err.status === 401) return start();
    // Jam HP sedikit beda dengan server di sekitar batas jam lembur → tampilkan pertanyaannya
    if (/lembur atau tidak/.test(err.message)) sheet.askOt = true;
  } finally {
    btn.textContent = 'Kirim absen';
    updateSubmit();
  }
});

// ---------- Persetujuan ----------
async function loadApprovals() {
  show('approvals');
  const box = $('#approvals-list');
  box.innerHTML = '<span class="spinner"></span>';
  try {
    const { items } = await api('/api/approvals');
    box.innerHTML = items.length ? items.map((a) => `
      <div class="approval" data-id="${a.id}">
        ${a.photo ? `<img src="${esc(a.photo)}" alt="Selfie ${esc(a.name)}">` : '<span></span>'}
        <div class="stack" style="gap:6px">
          <div><b>${esc(a.name)}</b> <small>${esc(a.division || '')}</small></div>
          <div class="muted" style="font-size:13px">${a.type === 'in' ? 'Masuk' : 'Pulang'} · ${esc(fmtDate(a.date, { day: 'numeric', month: 'short' }))} ${hhmm(a.time)} · ±${fmtDist(a.distance ?? 0)} dari kantor</div>
          <div style="font-size:14px">“${esc(a.note || '-')}”</div>
          ${a.address ? `<div class="muted" style="font-size:12px">${esc(a.address)}</div>` : ''}
          <a href="https://www.google.com/maps?q=${a.lat},${a.lng}" target="_blank" rel="noopener" style="font-size:13px">Lihat di Google Maps</a>
          <div class="row">
            <button class="ghost small" data-decide="rejected">Tolak</button>
            <button class="ok small" data-decide="approved">Setujui</button>
          </div>
        </div>
      </div>`).join('') : '<p class="muted" style="margin:0">Tidak ada yang menunggu persetujuan.</p>';
  } catch (err) {
    box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

$('#approvals-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-decide]');
  if (!btn) return;
  const item = btn.closest('[data-id]');
  const decision = btn.dataset.decide;
  if (decision === 'rejected' && !confirm('Tolak absen ini? Hari itu akan dihitung tidak hadir.')) return;
  btn.disabled = true;
  try {
    await api(`/api/approvals/${item.dataset.id}`, { body: { decision } });
    toast(decision === 'approved' ? 'Disetujui.' : 'Ditolak.');
    loadApprovals();
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});
$('#approvals-card').addEventListener('click', loadApprovals);

// ---------- Registrasi ----------
const regCam = createCamera($('#reg-cam'));
let regPhoto = null;
let lastAuthView = 'login';

async function openRegister() {
  show('register');
  regPhoto = null;
  $('#reg-cam-start').hidden = false;
  $('#reg-cam-shot').hidden = true;
  $('#reg-cam-retake').hidden = true;
  $('#reg-cam .cam-msg').textContent = 'Tekan "Buka kamera" untuk foto wajah.';
  try {
    const info = await api('/api/public/info');
    const sel = $('#register-form [name=division_id]');
    sel.innerHTML = '<option value="">Pilih divisi…</option>' +
      info.divisions.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  } catch (err) {
    toast(err.message, true);
  }
}
$('#reg-cam-start').addEventListener('click', async () => {
  if (await regCam.start()) {
    $('#reg-cam-start').hidden = true;
    $('#reg-cam-shot').hidden = false;
  }
});
$('#reg-cam-shot').addEventListener('click', () => {
  regPhoto = regCam.capture();
  if (!regPhoto) return toast('Kamera belum siap.', true);
  $('#reg-cam-shot').hidden = true;
  $('#reg-cam-retake').hidden = false;
});
$('#reg-cam-retake').addEventListener('click', async () => {
  regPhoto = null;
  $('#reg-cam-retake').hidden = true;
  if (await regCam.start()) $('#reg-cam-shot').hidden = false;
});
$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!regPhoto) return toast('Ambil foto wajah dulu.', true);
  const f = new FormData(e.target);
  const btn = $('button[type=submit]', e.target);
  btn.disabled = true;
  try {
    await api('/api/register', { body: { ...Object.fromEntries(f), photo: regPhoto } });
    regCam.stop();
    e.target.reset();
    show('registered');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Login ----------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = $('button[type=submit]', e.target);
  btn.disabled = true;
  try {
    await api('/api/login', { body: { phone: f.get('phone'), pin: f.get('pin'), device_id: deviceId() } });
    e.target.reset();
    await loadHome();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  if (!confirm('Keluar dari aplikasi? Kamu perlu login lagi pakai PIN.')) return;
  await api('/api/logout', { body: {} }).catch(() => {});
  clearInterval(clockTimer);
  start();
});

// Navigasi tombol data-go
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]')?.dataset.go;
  if (!go) return;
  if (go === 'register') openRegister();
  else if (go === 'home') loadHome().catch((err) => toast(err.message, true));
  else if (go === 'back') { regCam.stop(); show(lastAuthView); }
  else show(go);
});

// Muat ulang data saat aplikasi dibuka lagi dari background
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && me && !$('#v-home').hidden) loadHome().catch(() => {});
});

async function start() {
  me = null;
  try {
    await loadHome();
  } catch (err) {
    if (err.status !== 401) toast(err.message, true);
    lastAuthView = isIOS && !isStandalone ? 'install' : 'login';
    api('/api/public/info').then((i) => $$('.company-name').forEach((el) => (el.textContent = i.company_name))).catch(() => {});
    show(lastAuthView);
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
