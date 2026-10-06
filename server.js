// Absensi POKASA — server tanpa dependency (Node >= 22.13: http + node:sqlite bawaan)
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const PORT = Number(process.env.PORT) || 3000;
fs.mkdirSync(PHOTO_DIR, { recursive: true });

// ---------- Database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'absensi.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS divisions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    work_start TEXT NOT NULL DEFAULT '08:00',
    work_end TEXT NOT NULL DEFAULT '17:00',
    work_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
    supervisor_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    division_id INTEGER REFERENCES divisions(id),
    type TEXT NOT NULL DEFAULT 'karyawan' CHECK (type IN ('karyawan', 'freelance')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'inactive')),
    pin_hash TEXT,
    profile_photo TEXT,
    device_id TEXT,
    failed_pins INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    radius_m INTEGER NOT NULL DEFAULT 150
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    type TEXT NOT NULL CHECK (type IN ('in', 'out')),
    ts TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    lat REAL, lng REAL, accuracy REAL,
    location_id INTEGER,
    distance REAL,
    outside INTEGER NOT NULL DEFAULT 0,
    address TEXT,
    note TEXT,
    photo TEXT,
    late INTEGER NOT NULL DEFAULT 0,
    holiday INTEGER NOT NULL DEFAULT 0,
    approval TEXT NOT NULL DEFAULT 'auto' CHECK (approval IN ('auto', 'pending', 'approved', 'rejected')),
    decided_by TEXT,
    decided_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_att_day ON attendance(employee_id, date, type);
  CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
  CREATE INDEX IF NOT EXISTS idx_att_pending ON attendance(approval);
  CREATE TABLE IF NOT EXISTS holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    employee_id INTEGER,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const DEFAULTS = {
  company_name: 'POKASA',
  timezone: 'Asia/Jakarta',
  require_photo: '1',
  device_lock: '1',
  geocode: '1',
  join_code: '',
};

function getSettings() {
  const s = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) s[r.key] = r.value;
  return s;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function publicSettings(s = getSettings()) {
  return {
    company_name: s.company_name,
    timezone: s.timezone,
    require_photo: s.require_photo === '1',
    device_lock: s.device_lock === '1',
    geocode: s.geocode === '1',
    join_code: s.join_code,
  };
}

// ---------- Hash, PIN & sesi ----------
function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(String(secret), salt, 32).toString('hex');
}
function verifySecret(secret, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const a = crypto.scryptSync(String(secret), Buffer.from(salt, 'hex'), 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const newPin = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

// Password admin pertama: dari env ADMIN_PASSWORD, atau dibuat acak lalu ditulis ke data/ADMIN_PASSWORD.txt
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'admin_pass_hash'").get()) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  setSetting('admin_pass_hash', hashSecret(pw));
  if (!process.env.ADMIN_PASSWORD) {
    fs.writeFileSync(path.join(DATA_DIR, 'ADMIN_PASSWORD.txt'), pw + '\n');
    console.log(`\n  Password admin awal: ${pw}\n  (tersimpan juga di data/ADMIN_PASSWORD.txt — ganti lewat menu Pengaturan)\n`);
  }
}
if (!getSettings().join_code) setSetting('join_code', 'POKASA' + String(crypto.randomInt(1000, 10000)));

const SESSION_DAYS = { emp: 180, admin: 7 };
const COOKIE = { emp: 'sid', admin: 'asid' };
const MAX_PIN_FAILS = 5;

function createSession(req, res, role, employeeId = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  const maxAge = SESSION_DAYS[role] * 86400;
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(sha256(token), role, employeeId, Date.now() + maxAge * 1000);
  setCookie(req, res, COOKIE[role], token, maxAge);
}
function getSession(req, role) {
  const token = parseCookies(req)[COOKIE[role]];
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND role = ?').get(sha256(token), role);
  if (!s || s.expires < Date.now()) return null;
  if (role === 'emp' && !db.prepare("SELECT 1 FROM employees WHERE id = ? AND status = 'active'").get(s.employee_id)) return null;
  return s;
}
function endSession(req, res, role) {
  const token = parseCookies(req)[COOKIE[role]];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setCookie(req, res, COOKIE[role], '', 0);
}
const killEmpSessions = (id) => db.prepare("DELETE FROM sessions WHERE role = 'emp' AND employee_id = ?").run(id);
db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
function setCookie(req, res, name, value, maxAge) {
  const prev = res.getHeader('Set-Cookie') || [];
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
    (isHttps(req) ? '; Secure' : '');
  res.setHeader('Set-Cookie', [...[].concat(prev), cookie]);
}

// Batas percobaan per IP (login admin, kode registrasi): 8 gagal per 15 menit
const fails = new Map();
const clientIp = (req) =>
  req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
function checkRate(key, max = 8) {
  const f = fails.get(key);
  if (f && f.count >= max && Date.now() - f.first < 15 * 60e3)
    throw new HttpError(429, 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.');
}
function noteFail(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.first > 15 * 60e3) fails.set(key, { count: 1, first: Date.now() });
  else f.count++;
}

// ---------- Utilitas ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function localParts(d, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
const today = () => localParts(new Date(), getSettings().timezone).date;

function distanceM(lat1, lng1, lat2, lng2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const toMinutes = (t) => { const [h, m, s = 0] = t.split(':').map(Number); return h * 60 + m + s / 60; };
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const isHHMM = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '');
const str = (v, max) => String(v ?? '').trim().slice(0, max);

// Nomor HP disimpan dalam format 62xxxxxxxxxx
function normPhone(v) {
  let s = String(v ?? '').replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '62' + s.slice(1);
  else if (s.startsWith('8')) s = '62' + s;
  return /^62\d{8,13}$/.test(s) ? s : null;
}

function savePhoto(dataUrl, prefix) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new HttpError(400, 'Format foto tidak valid.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 1_500_000) throw new HttpError(413, 'Ukuran foto terlalu besar.');
  const name = `${prefix}_${crypto.randomBytes(6).toString('hex')}.jpg`;
  fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
  return name;
}
const removePhoto = (name) => name && fs.rmSync(path.join(PHOTO_DIR, name), { force: true });

// Jadwal kerja per divisi + hari libur
const DEFAULT_SCHED = { work_start: '08:00', work_end: '17:00', work_days: '1,2,3,4,5' };
function scheduleLookup() {
  const divs = new Map(db.prepare('SELECT * FROM divisions').all().map((d) => [d.id, d]));
  const holidays = new Map(db.prepare('SELECT date, name FROM holidays').all().map((h) => [h.date, h.name]));
  return (divisionId, date) => {
    const d = divs.get(divisionId) || DEFAULT_SCHED;
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    const holidayName = holidays.get(date);
    const off = !!holidayName || !d.work_days.split(',').map(Number).includes(dow);
    return { work_start: d.work_start, work_end: d.work_end, off, holiday_name: holidayName || null };
  };
}

function locationNames() {
  return new Map(db.prepare('SELECT id, name FROM locations').all().map((l) => [l.id, l.name]));
}

function recordView(r, locNames) {
  if (!r) return null;
  return {
    id: r.id, type: r.type, date: r.date, time: r.time,
    late: !!r.late, holiday: !!r.holiday, outside: !!r.outside,
    location: r.location_id ? locNames.get(r.location_id) || 'Kantor' : r.outside ? 'Luar kantor' : null,
    distance: r.distance == null ? null : Math.round(r.distance),
    accuracy: r.accuracy == null ? null : Math.round(r.accuracy),
    lat: r.lat, lng: r.lng, address: r.address, note: r.note,
    approval: r.approval, decided_by: r.decided_by,
    photo: r.photo ? `/photos/${r.photo}` : null,
  };
}

// Status satu hari: dasar penilaian adalah absen masuk
function dayStatus(day, off) {
  if (!day?.in) return off ? 'off' : 'absent';
  if (day.in.approval === 'rejected') return 'rejected';
  if (day.in.approval === 'pending') return 'pending';
  if (day.in.holiday) return 'holiday';
  return day.in.late ? 'late' : 'present';
}
const PRESENT = new Set(['present', 'late', 'holiday']);

// Gabungkan record masuk/pulang jadi satu baris per karyawan per tanggal
function groupDays(rows, sched, locNames) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.date}|${r.employee_id}`;
    if (!map.has(key)) map.set(key, {
      date: r.date, employee_id: r.employee_id, name: r.name, phone: r.phone, division: r.division,
      division_id: r.division_id, emp_type: r.emp_type, in: null, out: null,
    });
    map.get(key)[r.type] = recordView(r, locNames);
  }
  for (const d of map.values()) {
    const sc = sched(d.division_id, d.date);
    const outOk = d.out && d.out.approval !== 'rejected';
    d.minutes = d.in && outOk ? Math.max(0, Math.round(toMinutes(d.out.time) - toMinutes(d.in.time))) : null;
    d.early = !!(outOk && !d.out.holiday && d.out.time.slice(0, 5) < sc.work_end);
    d.status = dayStatus(d, sc.off);
  }
  return [...map.values()];
}

const ATT_SELECT = `SELECT a.*, e.name, e.phone, e.division_id, e.type AS emp_type, e.profile_photo, d.name AS division
  FROM attendance a JOIN employees e ON e.id = a.employee_id LEFT JOIN divisions d ON d.id = e.division_id`;

// ---------- Alamat otomatis (OpenStreetMap Nominatim, maks. 1 permintaan/detik) ----------
const geoQueue = [];
let geoBusy = false;
function queueGeocode(id, lat, lng) {
  if (getSettings().geocode !== '1') return;
  geoQueue.push({ id, lat, lng });
  pumpGeocode();
}
async function pumpGeocode() {
  if (geoBusy) return;
  geoBusy = true;
  while (geoQueue.length) {
    const job = geoQueue.shift();
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${job.lat}&lon=${job.lng}&zoom=18&accept-language=id`;
      const r = await fetch(url, { headers: { 'User-Agent': 'AbsensiPOKASA/1.0 (internal attendance app)' }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const d = await r.json();
        if (d.display_name) db.prepare('UPDATE attendance SET address = ? WHERE id = ?').run(d.display_name.slice(0, 300), job.id);
      }
    } catch { /* alamat opsional; koordinat tetap tersimpan */ }
    await new Promise((r) => setTimeout(r, 1100));
  }
  geoBusy = false;
}

// ---------- HTTP ----------
// strict-origin-when-cross-origin: ke situs lain hanya mengirim origin (tanpa path). Tile OpenStreetMap
// mewajibkan Referer; dengan 'same-origin' peta diblokir (403 "Access blocked").
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}
async function readJson(req, limit = 3_000_000) {
  if (!(req.headers['content-type'] || '').includes('application/json'))
    throw new HttpError(415, 'Content-Type harus application/json');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Data terlalu besar.');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'JSON tidak valid.'); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.ico': 'image/x-icon', '.jpg': 'image/jpeg',
};
function serveFile(res, file, cache = 'no-cache') {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
    send(res, 200, data, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': cache });
  });
}

// ---------- Routes ----------
const routes = [];
function route(method, pattern, role, fn) {
  routes.push({ method, role, fn, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });
}

async function handleApi(req, res, pathname, query) {
  const r = routes.find((r) => r.method === req.method && r.re.test(pathname));
  if (!r) throw new HttpError(404, 'Endpoint tidak ditemukan.');
  const params = pathname.match(r.re).groups || {};
  let session = null;
  if (r.role) {
    session = getSession(req, r.role);
    if (!session) throw new HttpError(401, 'Sesi habis, silakan login lagi.');
  }
  const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
  const out = await r.fn({ req, res, query, params, body, session });
  if (out !== undefined && !res.headersSent) json(res, 200, out);
}

function getEmployee(id) {
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(id));
  if (!e) throw new HttpError(404, 'Karyawan tidak ditemukan.');
  return e;
}
function divisionIdOrNull(v) {
  const id = num(v);
  if (id == null) return null;
  if (!db.prepare('SELECT 1 FROM divisions WHERE id = ?').get(id)) throw new HttpError(400, 'Divisi tidak ditemukan.');
  return id;
}
const empType = (v) => (/free/i.test(String(v || '')) ? 'freelance' : 'karyawan');

// ===== Publik =====
route('GET', '/api/public/info', null, () => ({
  company_name: getSettings().company_name,
  divisions: db.prepare('SELECT id, name FROM divisions ORDER BY name').all(),
}));

route('POST', '/api/register', null, ({ req, body }) => {
  const key = 'reg:' + clientIp(req);
  checkRate(key);
  const s = getSettings();
  if (str(body.join_code, 40).toUpperCase() !== s.join_code.toUpperCase()) {
    noteFail(key);
    throw new HttpError(403, 'Kode perusahaan salah. Tanyakan ke HRD.');
  }
  const name = str(body.name, 80);
  if (name.length < 3) throw new HttpError(400, 'Nama lengkap wajib diisi.');
  const phone = normPhone(body.phone);
  if (!phone) throw new HttpError(400, 'No. HP tidak valid. Contoh: 0812xxxxxxx');
  const existing = db.prepare('SELECT status FROM employees WHERE phone = ?').get(phone);
  if (existing) throw new HttpError(409, existing.status === 'pending'
    ? 'No. HP ini sudah mendaftar dan sedang menunggu persetujuan HRD.'
    : 'No. HP ini sudah terdaftar. Silakan login, atau hubungi HRD kalau lupa PIN.');
  const divisionId = divisionIdOrNull(body.division_id);
  if (divisionId == null) throw new HttpError(400, 'Pilih divisi.');
  if (!body.photo) throw new HttpError(400, 'Foto wajah wajib untuk pendaftaran.');
  noteFail(key); // tiap pendaftaran ikut dihitung supaya tidak bisa spam
  const photo = savePhoto(body.photo, 'p');
  db.prepare("INSERT INTO employees (name, phone, division_id, type, status, profile_photo) VALUES (?, ?, ?, ?, 'pending', ?)")
    .run(name, phone, divisionId, empType(body.type), photo);
  return { ok: true };
});

// ===== Karyawan (aplikasi HP) =====
route('POST', '/api/login', null, ({ req, res, body }) => {
  const ipKey = 'emp:' + clientIp(req);
  checkRate(ipKey, 20);
  const phone = normPhone(body.phone);
  const emp = phone && db.prepare('SELECT * FROM employees WHERE phone = ?').get(phone);
  if (!emp || emp.status === 'inactive') { noteFail(ipKey); throw new HttpError(401, 'No. HP atau PIN salah.'); }
  if (emp.status === 'pending') throw new HttpError(403, 'Pendaftaran kamu masih menunggu persetujuan HRD.');
  if (emp.failed_pins >= MAX_PIN_FAILS) throw new HttpError(423, 'Akun terkunci karena salah PIN 5 kali. Hubungi HRD untuk membukanya.');
  if (!verifySecret(String(body.pin || ''), emp.pin_hash)) {
    noteFail(ipKey);
    db.prepare('UPDATE employees SET failed_pins = failed_pins + 1 WHERE id = ?').run(emp.id);
    const left = MAX_PIN_FAILS - emp.failed_pins - 1;
    throw new HttpError(401, left > 0 ? `PIN salah. Sisa ${left} percobaan sebelum akun terkunci.` : 'PIN salah. Akun terkunci, hubungi HRD.');
  }
  const deviceId = str(body.device_id, 64);
  if (getSettings().device_lock === '1') {
    if (!deviceId) throw new HttpError(400, 'Perangkat tidak dikenali. Muat ulang aplikasi.');
    if (emp.device_id && emp.device_id !== deviceId)
      throw new HttpError(403, 'Akun ini sudah terhubung ke HP lain. Minta HRD untuk "Reset perangkat" kalau kamu ganti HP.');
  }
  db.prepare('UPDATE employees SET failed_pins = 0, device_id = COALESCE(device_id, ?) WHERE id = ?').run(deviceId || null, emp.id);
  createSession(req, res, 'emp', emp.id);
  return { ok: true };
});

route('POST', '/api/logout', null, ({ req, res }) => { endSession(req, res, 'emp'); return { ok: true }; });

route('GET', '/api/me', 'emp', ({ session }) => {
  const s = getSettings();
  const emp = db.prepare(`SELECT e.id, e.name, e.phone, e.type, e.division_id, d.name AS division
                          FROM employees e LEFT JOIN divisions d ON d.id = e.division_id WHERE e.id = ?`).get(session.employee_id);
  const { date } = localParts(new Date(), s.timezone);
  const sc = scheduleLookup()(emp.division_id, date);
  const locNames = locationNames();
  const recs = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').all(emp.id, date);
  const pick = (t) => recordView(recs.find((x) => x.type === t), locNames);
  const supervises = db.prepare('SELECT id FROM divisions WHERE supervisor_id = ?').all(emp.id).map((d) => d.id);
  const pendingApprovals = supervises.length
    ? db.prepare(`SELECT COUNT(*) AS n FROM attendance a JOIN employees e ON e.id = a.employee_id
                  WHERE a.approval = 'pending' AND a.employee_id != ? AND e.division_id IN (${supervises.map(() => '?').join(',')})`)
        .get(emp.id, ...supervises).n
    : 0;
  return {
    employee: emp, date, schedule: sc,
    today: { in: pick('in'), out: pick('out') },
    locations: db.prepare('SELECT name, lat, lng, radius_m FROM locations').all(),
    settings: { company_name: s.company_name, timezone: s.timezone, require_photo: s.require_photo === '1' },
    supervisor: supervises.length > 0, pendingApprovals,
    serverTime: Date.now(),
  };
});

route('GET', '/api/history', 'emp', ({ session }) => {
  const rows = db.prepare('SELECT * FROM attendance WHERE employee_id = ? ORDER BY date DESC LIMIT 62').all(session.employee_id);
  const locNames = locationNames();
  const days = new Map();
  for (const r of rows) {
    if (!days.has(r.date)) days.set(r.date, { date: r.date, in: null, out: null });
    days.get(r.date)[r.type] = recordView(r, locNames);
  }
  return { days: [...days.values()].slice(0, 31) };
});

route('POST', '/api/attend', 'emp', ({ session, body }) => {
  const s = getSettings();
  const emp = getEmployee(session.employee_id);
  const type = body.type;
  if (type !== 'in' && type !== 'out') throw new HttpError(400, 'Jenis absen tidak valid.');

  // Waktu selalu diambil dari server, bukan dari HP
  const { date, time } = localParts(new Date(), s.timezone);
  const done = db.prepare('SELECT type, approval FROM attendance WHERE employee_id = ? AND date = ?').all(emp.id, date);
  const has = (t) => done.some((r) => r.type === t);
  if (type === 'in' && has('in')) throw new HttpError(409, 'Kamu sudah absen masuk hari ini.');
  if (type === 'out' && !has('in')) throw new HttpError(409, 'Absen masuk dulu sebelum absen pulang.');
  if (type === 'out' && has('out')) throw new HttpError(409, 'Kamu sudah absen pulang hari ini.');

  const lat = num(body.lat), lng = num(body.lng), accuracy = num(body.accuracy);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    throw new HttpError(400, 'Lokasi wajib aktif untuk absen. Izinkan akses lokasi lalu coba lagi.');

  // Cari lokasi kantor terdekat
  let nearest = null;
  for (const l of db.prepare('SELECT * FROM locations').all()) {
    const d = distanceM(lat, lng, l.lat, l.lng);
    if (!nearest || d - l.radius_m < nearest.d - nearest.loc.radius_m) nearest = { loc: l, d };
  }
  const inside = nearest && nearest.d <= nearest.loc.radius_m;
  const outside = !!nearest && !inside;
  const note = str(body.note, 300);
  if (outside && note.length < 3) throw new HttpError(400, 'Kamu di luar area kantor. Isi keterangan lokasi/kegiatan dulu.');

  if (!body.photo && s.require_photo === '1') throw new HttpError(400, 'Foto selfie wajib untuk absen.');
  const sc = scheduleLookup()(emp.division_id, date);
  const late = type === 'in' && !sc.off && time.slice(0, 5) > sc.work_start ? 1 : 0;
  const photo = body.photo ? savePhoto(body.photo, `${date}_${emp.id}_${type}`) : null;
  let id;
  try {
    id = Number(db.prepare(`INSERT INTO attendance (employee_id, type, ts, date, time, lat, lng, accuracy, location_id, distance,
                              outside, note, photo, late, holiday, approval)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(emp.id, type, new Date().toISOString(), date, time, lat, lng, accuracy,
           inside ? nearest.loc.id : null, nearest ? nearest.d : null, outside ? 1 : 0, note || null, photo,
           late, sc.off ? 1 : 0, outside ? 'pending' : 'auto').lastInsertRowid);
  } catch (e) {
    removePhoto(photo);
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Absen ini sudah tercatat.');
    throw e;
  }
  if (outside) queueGeocode(id, lat, lng);
  return {
    ok: true, type, date, time, late: !!late, holiday: sc.off, outside,
    location: inside ? nearest.loc.name : outside ? 'Luar kantor' : null,
    distance: nearest ? Math.round(nearest.d) : null,
  };
});

// ===== Persetujuan absen luar kantor =====
function supervisedDivisionIds(empId) {
  return db.prepare('SELECT id FROM divisions WHERE supervisor_id = ?').all(empId).map((d) => d.id);
}
function decide(recordId, decision, decidedBy) {
  if (decision !== 'approved' && decision !== 'rejected') throw new HttpError(400, 'Keputusan tidak valid.');
  const r = db.prepare('SELECT * FROM attendance WHERE id = ?').get(Number(recordId));
  if (!r) throw new HttpError(404, 'Data absen tidak ditemukan.');
  if (r.approval === 'auto') throw new HttpError(400, 'Absen ini tidak memerlukan persetujuan.');
  db.prepare('UPDATE attendance SET approval = ?, decided_by = ?, decided_at = ? WHERE id = ?')
    .run(decision, decidedBy, new Date().toISOString(), r.id);
  return { ok: true };
}
function pendingList(where, params) {
  const locNames = locationNames();
  return db.prepare(`${ATT_SELECT} WHERE a.approval = 'pending' ${where} ORDER BY a.date DESC, a.time DESC`).all(...params)
    .map((r) => ({
      ...recordView(r, locNames), employee_id: r.employee_id, name: r.name, division: r.division,
      profile_photo: r.profile_photo ? `/photos/${r.profile_photo}` : null,
    }));
}

route('GET', '/api/approvals', 'emp', ({ session }) => {
  const divs = supervisedDivisionIds(session.employee_id);
  if (!divs.length) return { items: [] };
  return { items: pendingList(`AND a.employee_id != ? AND e.division_id IN (${divs.map(() => '?').join(',')})`,
                              [session.employee_id, ...divs]) };
});

route('POST', '/api/approvals/:id', 'emp', ({ session, params, body }) => {
  const r = db.prepare('SELECT a.employee_id, e.division_id FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE a.id = ?')
    .get(Number(params.id));
  if (!r || r.employee_id === session.employee_id || !supervisedDivisionIds(session.employee_id).includes(r.division_id))
    throw new HttpError(403, 'Kamu tidak berhak memutuskan absen ini.');
  return decide(params.id, body.decision, getEmployee(session.employee_id).name);
});

// ===== Admin (dashboard web) =====
route('POST', '/api/admin/login', null, ({ req, res, body }) => {
  const key = 'admin:' + clientIp(req);
  checkRate(key);
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'admin_pass_hash'").get()?.value;
  if (!verifySecret(String(body.password || ''), stored)) {
    noteFail(key);
    throw new HttpError(401, 'Password salah.');
  }
  fails.delete(key);
  createSession(req, res, 'admin');
  return { ok: true };
});

route('POST', '/api/admin/logout', null, ({ req, res }) => { endSession(req, res, 'admin'); return { ok: true }; });

route('GET', '/api/admin/me', 'admin', () => ({
  settings: publicSettings(),
  today: today(),
  pendingApprovals: db.prepare("SELECT COUNT(*) AS n FROM attendance WHERE approval = 'pending'").get().n,
  pendingRegistrations: db.prepare("SELECT COUNT(*) AS n FROM employees WHERE status = 'pending'").get().n,
}));

route('GET', '/api/admin/overview', 'admin', ({ query }) => {
  const date = isDate(query.get('date')) ? query.get('date') : today();
  const divisionId = num(query.get('division_id'));
  const type = query.get('type');
  const sched = scheduleLookup();
  const locNames = locationNames();
  const byEmp = new Map(groupDays(db.prepare(`${ATT_SELECT} WHERE a.date = ?`).all(date), sched, locNames)
    .map((d) => [d.employee_id, d]));
  const emps = db.prepare(`SELECT e.id, e.name, e.phone, e.type, e.status, e.division_id, d.name AS division
                           FROM employees e LEFT JOIN divisions d ON d.id = e.division_id
                           WHERE e.status != 'pending' ORDER BY e.name`).all()
    .filter((e) => (e.status === 'active' || byEmp.has(e.id))
      && (divisionId == null || e.division_id === divisionId)
      && (!type || e.type === type));
  const rows = emps.map((e) => {
    const d = byEmp.get(e.id);
    const sc = sched(e.division_id, date);
    return {
      employee_id: e.id, name: e.name, phone: e.phone, division: e.division, emp_type: e.type,
      schedule: `${sc.work_start}–${sc.work_end}`, off: sc.off,
      in: d?.in || null, out: d?.out || null, minutes: d?.minutes ?? null, early: d?.early || false,
      status: d ? d.status : dayStatus(null, sc.off),
    };
  });
  const count = (fn) => rows.filter(fn).length;
  return {
    date, holiday: db.prepare('SELECT name FROM holidays WHERE date = ?').get(date)?.name || null,
    stats: {
      total: rows.filter((r) => !r.off || r.in).length,
      present: count((r) => PRESENT.has(r.status)),
      late: count((r) => r.status === 'late'),
      pending: count((r) => r.status === 'pending'),
      absent: count((r) => r.status === 'absent' || r.status === 'rejected'),
    },
    rows,
  };
});

route('GET', '/api/admin/map', 'admin', ({ query }) => {
  const date = isDate(query.get('date')) ? query.get('date') : today();
  const sched = scheduleLookup();
  const locNames = locationNames();
  const days = groupDays(db.prepare(`${ATT_SELECT} WHERE a.date = ? AND a.lat IS NOT NULL`).all(date), sched, locNames);
  return { date, locations: db.prepare('SELECT * FROM locations').all(), days };
});

route('GET', '/api/admin/approvals', 'admin', () => ({ items: pendingList('', []) }));

route('POST', '/api/admin/attendance/:id/decision', 'admin', ({ params, body }) => decide(params.id, body.decision, 'HRD'));

route('POST', '/api/admin/attendance', 'admin', ({ body }) => {
  const emp = getEmployee(body.employee_id);
  const type = body.type;
  if (type !== 'in' && type !== 'out') throw new HttpError(400, 'Jenis absen tidak valid.');
  if (!isDate(body.date) || !isHHMM(body.time)) throw new HttpError(400, 'Tanggal/jam tidak valid.');
  const sc = scheduleLookup()(emp.division_id, body.date);
  const late = type === 'in' && !sc.off && body.time > sc.work_start ? 1 : 0;
  try {
    db.prepare(`INSERT INTO attendance (employee_id, type, ts, date, time, note, late, holiday, approval, decided_by, decided_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'auto', 'HRD (input manual)', ?)`)
      .run(emp.id, type, new Date().toISOString(), body.date, body.time + ':00', str(body.note, 300) || 'Input manual HRD',
           late, sc.off ? 1 : 0, new Date().toISOString());
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Absen ini sudah ada. Hapus dulu yang lama kalau mau diganti.');
    throw e;
  }
  return { ok: true };
});

route('DELETE', '/api/admin/attendance/:id', 'admin', ({ params }) => {
  const r = db.prepare('SELECT photo FROM attendance WHERE id = ?').get(Number(params.id));
  if (!r) throw new HttpError(404, 'Data absen tidak ditemukan.');
  db.prepare('DELETE FROM attendance WHERE id = ?').run(Number(params.id));
  removePhoto(r.photo);
  return { ok: true };
});

function rangeQuery(query) {
  const t = today();
  const from = isDate(query.get('from')) ? query.get('from') : t.slice(0, 8) + '01';
  const to = isDate(query.get('to')) ? query.get('to') : t;
  const divisionId = num(query.get('division_id'));
  const empId = num(query.get('employee_id'));
  const type = query.get('type') || '';
  let sql = `${ATT_SELECT} WHERE a.date BETWEEN ? AND ?`;
  const params = [from, to];
  if (divisionId) { sql += ' AND e.division_id = ?'; params.push(divisionId); }
  if (empId) { sql += ' AND a.employee_id = ?'; params.push(empId); }
  if (type) { sql += ' AND e.type = ?'; params.push(type); }
  const days = groupDays(db.prepare(sql).all(...params), scheduleLookup(), locationNames())
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  return { from, to, today: t, divisionId, empId, type, days };
}

route('GET', '/api/admin/recap', 'admin', ({ query }) => {
  const { from, to, today: t, divisionId, empId, type, days } = rangeQuery(query);
  const emps = db.prepare(`SELECT e.id, e.name, e.type, e.status, e.division_id, d.name AS division
                           FROM employees e LEFT JOIN divisions d ON d.id = e.division_id
                           WHERE e.status != 'pending' ORDER BY e.name`).all()
    .filter((e) => (empId ? e.id === empId : e.status === 'active' || days.some((d) => d.employee_id === e.id))
      && (!divisionId || e.division_id === divisionId) && (!type || e.type === type));
  const summary = emps.map((e) => {
    const mine = days.filter((d) => d.employee_id === e.id);
    const c = (fn) => mine.filter(fn).length;
    return {
      employee_id: e.id, name: e.name, division: e.division, emp_type: e.type,
      present: c((d) => PRESENT.has(d.status)),
      late: c((d) => d.status === 'late'),
      early: c((d) => d.early),
      outside: c((d) => d.in?.outside && d.status !== 'rejected'),
      pending: c((d) => d.status === 'pending'),
      rejected: c((d) => d.status === 'rejected'),
      holiday: c((d) => d.status === 'holiday'),
      no_out: c((d) => d.in && !d.out && d.date < t && d.status !== 'rejected'),
      minutes: mine.reduce((a, d) => a + (d.minutes || 0), 0),
    };
  });
  return { from, to, summary, days };
});

const STATUS_LABEL = {
  present: 'Hadir', late: 'Terlambat', pending: 'Menunggu persetujuan', rejected: 'Ditolak (tidak hadir)',
  holiday: 'Masuk hari libur', absent: 'Tidak hadir', off: 'Libur',
};

route('GET', '/api/admin/export.csv', 'admin', ({ query, res }) => {
  const { from, to, days } = rangeQuery(query);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dur = (m) => (m == null ? '' : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`);
  const loc = (r) => (r ? [r.location, r.address].filter(Boolean).join(' — ') : '');
  const lines = [['Tanggal', 'Nama', 'No. HP', 'Divisi', 'Tipe', 'Masuk', 'Lokasi Masuk', 'Pulang', 'Lokasi Pulang',
                  'Status', 'Pulang Cepat', 'Durasi (jam:menit)', 'Keterangan', 'Diputuskan oleh']];
  for (const d of [...days].reverse()) {
    lines.push([d.date, d.name, '0' + d.phone.slice(2), d.division, d.emp_type === 'freelance' ? 'Freelance' : 'Karyawan',
                d.in?.time, loc(d.in), d.out?.time, loc(d.out), STATUS_LABEL[d.status], d.early ? 'Ya' : '',
                dur(d.minutes), [d.in?.note, d.out?.note].filter(Boolean).join(' | '), d.in?.decided_by]);
  }
  // Pemisah ';' + BOM supaya langsung rapi di Excel regional Indonesia
  const csv = '﻿' + lines.map((l) => l.map(esc).join(';')).join('\r\n');
  send(res, 200, csv, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="absensi_${from}_sd_${to}.csv"`,
    'cache-control': 'no-store',
  });
});

// --- Karyawan ---
route('GET', '/api/admin/employees', 'admin', () => ({
  employees: db.prepare(`SELECT e.id, e.name, e.phone, e.type, e.status, e.division_id, d.name AS division,
                           e.profile_photo, e.device_id IS NOT NULL AS has_device, e.failed_pins >= ${MAX_PIN_FAILS} AS locked,
                           e.created_at, EXISTS (SELECT 1 FROM divisions x WHERE x.supervisor_id = e.id) AS supervisor
                         FROM employees e LEFT JOIN divisions d ON d.id = e.division_id
                         ORDER BY e.status = 'pending' DESC, e.status = 'active' DESC, e.name`).all()
    .map((e) => ({ ...e, has_device: !!e.has_device, locked: !!e.locked, supervisor: !!e.supervisor,
                   profile_photo: e.profile_photo ? `/photos/${e.profile_photo}` : null })),
}));

function validateEmployeeBody(body, currentId = null) {
  const name = str(body.name, 80);
  if (name.length < 2) throw new HttpError(400, 'Nama wajib diisi.');
  const phone = normPhone(body.phone);
  if (!phone) throw new HttpError(400, 'No. HP tidak valid. Contoh: 0812xxxxxxx');
  const dup = db.prepare('SELECT id FROM employees WHERE phone = ?').get(phone);
  if (dup && dup.id !== currentId) throw new HttpError(409, 'No. HP sudah dipakai karyawan lain.');
  return { name, phone, divisionId: divisionIdOrNull(body.division_id), type: empType(body.type) };
}

route('POST', '/api/admin/employees', 'admin', ({ body }) => {
  const { name, phone, divisionId, type } = validateEmployeeBody(body);
  const pin = newPin();
  const r = db.prepare("INSERT INTO employees (name, phone, division_id, type, status, pin_hash) VALUES (?, ?, ?, ?, 'active', ?)")
    .run(name, phone, divisionId, type, hashSecret(pin));
  return { ok: true, id: Number(r.lastInsertRowid), name, phone, pin };
});

route('PUT', '/api/admin/employees/:id', 'admin', ({ params, body }) => {
  const emp = getEmployee(params.id);
  if (emp.status === 'pending') throw new HttpError(400, 'Setujui atau tolak pendaftaran ini dulu.');
  const { name, phone, divisionId, type } = validateEmployeeBody(body, emp.id);
  const status = body.status === 'inactive' ? 'inactive' : 'active';
  db.prepare('UPDATE employees SET name = ?, phone = ?, division_id = ?, type = ?, status = ? WHERE id = ?')
    .run(name, phone, divisionId, type, status, emp.id);
  if (status === 'inactive') {
    killEmpSessions(emp.id);
    db.prepare('UPDATE divisions SET supervisor_id = NULL WHERE supervisor_id = ?').run(emp.id);
  }
  return { ok: true };
});

route('POST', '/api/admin/employees/:id/approve', 'admin', ({ params, body }) => {
  const emp = getEmployee(params.id);
  if (emp.status !== 'pending') throw new HttpError(400, 'Akun ini bukan pendaftar baru.');
  const divisionId = body.division_id !== undefined ? divisionIdOrNull(body.division_id) : emp.division_id;
  const type = body.type ? empType(body.type) : emp.type;
  const pin = newPin();
  db.prepare("UPDATE employees SET status = 'active', division_id = ?, type = ?, pin_hash = ? WHERE id = ?")
    .run(divisionId, type, hashSecret(pin), emp.id);
  return { ok: true, id: emp.id, name: emp.name, phone: emp.phone, pin };
});

route('POST', '/api/admin/employees/:id/reject', 'admin', ({ params }) => {
  const emp = getEmployee(params.id);
  if (emp.status !== 'pending') throw new HttpError(400, 'Akun ini bukan pendaftar baru.');
  db.prepare('DELETE FROM employees WHERE id = ?').run(emp.id);
  removePhoto(emp.profile_photo);
  return { ok: true };
});

route('POST', '/api/admin/employees/:id/reset-pin', 'admin', ({ params }) => {
  const emp = getEmployee(params.id);
  if (emp.status === 'pending') throw new HttpError(400, 'Setujui pendaftaran ini dulu.');
  const pin = newPin();
  db.prepare('UPDATE employees SET pin_hash = ?, failed_pins = 0 WHERE id = ?').run(hashSecret(pin), emp.id);
  killEmpSessions(emp.id);
  return { ok: true, id: emp.id, name: emp.name, phone: emp.phone, pin };
});

route('POST', '/api/admin/employees/:id/reset-device', 'admin', ({ params }) => {
  const emp = getEmployee(params.id);
  db.prepare('UPDATE employees SET device_id = NULL WHERE id = ?').run(emp.id);
  killEmpSessions(emp.id);
  return { ok: true };
});

route('POST', '/api/admin/employees/:id/unlock', 'admin', ({ params }) => {
  db.prepare('UPDATE employees SET failed_pins = 0 WHERE id = ?').run(getEmployee(params.id).id);
  return { ok: true };
});

// Import dari Excel: browser membaca .xlsx lalu mengirim baris-barisnya sebagai JSON
route('POST', '/api/admin/import', 'admin', ({ body }) => {
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
  if (!rows.length) throw new HttpError(400, 'File tidak berisi data.');
  const divByName = new Map(db.prepare('SELECT id, name FROM divisions').all().map((d) => [d.name.toLowerCase(), d.id]));
  const seen = new Set();
  const results = rows.map((r, i) => {
    const name = str(r.name, 80);
    const phone = normPhone(r.phone);
    const division = str(r.division, 60);
    const out = { row: Number(r.row) || i + 2, name, phone: phone || str(r.phone, 20), division, type: empType(r.type), ok: false, error: null };
    if (name.length < 2) out.error = 'Nama kosong';
    else if (!phone) out.error = 'No. HP tidak valid';
    else if (seen.has(phone)) out.error = 'No. HP ganda di file';
    else if (db.prepare('SELECT 1 FROM employees WHERE phone = ?').get(phone)) out.error = 'No. HP sudah terdaftar';
    else out.ok = true;
    if (phone) seen.add(phone);
    out.new_division = !!division && !divByName.has(division.toLowerCase());
    return out;
  });
  if (!body.commit) return { results };

  const created = [];
  db.exec('BEGIN');
  try {
    for (const r of results.filter((x) => x.ok)) {
      let divisionId = null;
      if (r.division) {
        const key = r.division.toLowerCase();
        if (!divByName.has(key)) divByName.set(key, Number(db.prepare('INSERT INTO divisions (name) VALUES (?)').run(r.division).lastInsertRowid));
        divisionId = divByName.get(key);
      }
      const pin = newPin();
      const id = Number(db.prepare("INSERT INTO employees (name, phone, division_id, type, status, pin_hash) VALUES (?, ?, ?, ?, 'active', ?)")
        .run(r.name, r.phone, divisionId, r.type, hashSecret(pin)).lastInsertRowid);
      created.push({ id, name: r.name, phone: r.phone, division: r.division, type: r.type, pin });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { results, created };
});

// --- Divisi ---
route('GET', '/api/admin/divisions', 'admin', () => ({
  divisions: db.prepare(`SELECT d.*, s.name AS supervisor_name,
                           (SELECT COUNT(*) FROM employees e WHERE e.division_id = d.id AND e.status = 'active') AS members
                         FROM divisions d LEFT JOIN employees s ON s.id = d.supervisor_id ORDER BY d.name`).all(),
}));

function validateDivision(body) {
  const name = str(body.name, 60);
  if (!name) throw new HttpError(400, 'Nama divisi wajib diisi.');
  if (!isHHMM(body.work_start) || !isHHMM(body.work_end)) throw new HttpError(400, 'Jam kerja harus format JJ:MM.');
  const days = [...new Set((Array.isArray(body.work_days) ? body.work_days : []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  if (!days.length) throw new HttpError(400, 'Pilih minimal satu hari kerja.');
  const sup = num(body.supervisor_id);
  if (sup != null && !db.prepare("SELECT 1 FROM employees WHERE id = ? AND status = 'active'").get(sup))
    throw new HttpError(400, 'Atasan harus karyawan aktif.');
  return [name, body.work_start, body.work_end, days.join(','), sup];
}

route('POST', '/api/admin/divisions', 'admin', ({ body }) => {
  try {
    db.prepare('INSERT INTO divisions (name, work_start, work_end, work_days, supervisor_id) VALUES (?, ?, ?, ?, ?)').run(...validateDivision(body));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Nama divisi sudah ada.');
    throw e;
  }
  return { ok: true };
});

route('PUT', '/api/admin/divisions/:id', 'admin', ({ params, body }) => {
  try {
    const r = db.prepare('UPDATE divisions SET name = ?, work_start = ?, work_end = ?, work_days = ?, supervisor_id = ? WHERE id = ?')
      .run(...validateDivision(body), Number(params.id));
    if (!r.changes) throw new HttpError(404, 'Divisi tidak ditemukan.');
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Nama divisi sudah ada.');
    throw e;
  }
  return { ok: true };
});

route('DELETE', '/api/admin/divisions/:id', 'admin', ({ params }) => {
  if (db.prepare('SELECT 1 FROM employees WHERE division_id = ?').get(Number(params.id)))
    throw new HttpError(409, 'Divisi masih punya anggota. Pindahkan anggotanya dulu.');
  db.prepare('DELETE FROM divisions WHERE id = ?').run(Number(params.id));
  return { ok: true };
});

// --- Lokasi kantor ---
route('GET', '/api/admin/locations', 'admin', () => ({ locations: db.prepare('SELECT * FROM locations ORDER BY name').all() }));

function validateLocation(body) {
  const name = str(body.name, 60);
  const lat = num(body.lat), lng = num(body.lng), radius = Math.round(num(body.radius_m) ?? 0);
  if (!name) throw new HttpError(400, 'Nama lokasi wajib diisi.');
  if (lat == null || Math.abs(lat) > 90 || lng == null || Math.abs(lng) > 180) throw new HttpError(400, 'Koordinat tidak valid.');
  if (radius < 10 || radius > 100000) throw new HttpError(400, 'Radius harus 10–100000 meter.');
  return [name, lat, lng, radius];
}
route('POST', '/api/admin/locations', 'admin', ({ body }) => {
  db.prepare('INSERT INTO locations (name, lat, lng, radius_m) VALUES (?, ?, ?, ?)').run(...validateLocation(body));
  return { ok: true };
});
route('PUT', '/api/admin/locations/:id', 'admin', ({ params, body }) => {
  db.prepare('UPDATE locations SET name = ?, lat = ?, lng = ?, radius_m = ? WHERE id = ?').run(...validateLocation(body), Number(params.id));
  return { ok: true };
});
route('DELETE', '/api/admin/locations/:id', 'admin', ({ params }) => {
  db.prepare('DELETE FROM locations WHERE id = ?').run(Number(params.id));
  return { ok: true };
});

// --- Hari libur ---
route('GET', '/api/admin/holidays', 'admin', () => ({ holidays: db.prepare('SELECT * FROM holidays ORDER BY date DESC').all() }));
route('POST', '/api/admin/holidays', 'admin', ({ body }) => {
  const name = str(body.name, 80);
  if (!isDate(body.date) || !name) throw new HttpError(400, 'Tanggal dan nama libur wajib diisi.');
  db.prepare('INSERT INTO holidays (date, name) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name').run(body.date, name);
  return { ok: true };
});
route('DELETE', '/api/admin/holidays/:date', 'admin', ({ params }) => {
  db.prepare('DELETE FROM holidays WHERE date = ?').run(params.date);
  return { ok: true };
});

// --- Pengaturan ---
route('GET', '/api/admin/settings', 'admin', () => ({ settings: publicSettings() }));

route('PUT', '/api/admin/settings', 'admin', ({ body }) => {
  const company = str(body.company_name, 60);
  if (!company) throw new HttpError(400, 'Nama perusahaan wajib diisi.');
  try { new Intl.DateTimeFormat('en', { timeZone: body.timezone }); } catch { throw new HttpError(400, 'Zona waktu tidak valid.'); }
  const code = str(body.join_code, 40).toUpperCase();
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) throw new HttpError(400, 'Kode perusahaan 4–40 huruf/angka.');
  setSetting('company_name', company);
  setSetting('timezone', body.timezone);
  setSetting('join_code', code);
  setSetting('require_photo', body.require_photo ? '1' : '0');
  setSetting('device_lock', body.device_lock ? '1' : '0');
  setSetting('geocode', body.geocode ? '1' : '0');
  return { ok: true, settings: publicSettings() };
});

route('PUT', '/api/admin/password', 'admin', ({ req, body }) => {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'admin_pass_hash'").get()?.value;
  if (!verifySecret(String(body.old || ''), stored)) throw new HttpError(400, 'Password lama salah.');
  const pw = String(body.new || '');
  if (pw.length < 8) throw new HttpError(400, 'Password baru minimal 8 karakter.');
  setSetting('admin_pass_hash', hashSecret(pw));
  // Logout semua sesi admin lain, simpan sesi saat ini
  const current = sha256(parseCookies(req)[COOKIE.admin] || '');
  db.prepare("DELETE FROM sessions WHERE role = 'admin' AND token_hash != ?").run(current);
  fs.rmSync(path.join(DATA_DIR, 'ADMIN_PASSWORD.txt'), { force: true });
  return { ok: true };
});

// ---------- Foto: admin, atau atasan divisi pemilik foto ----------
function canViewPhoto(req, name) {
  if (getSession(req, 'admin')) return true;
  const s = getSession(req, 'emp');
  if (!s) return false;
  return !!db.prepare(`SELECT 1 FROM employees e JOIN divisions d ON d.id = e.division_id
                       LEFT JOIN attendance a ON a.employee_id = e.id AND a.photo = ?
                       WHERE d.supervisor_id = ? AND (a.id IS NOT NULL OR e.profile_photo = ?) LIMIT 1`)
    .get(name, s.employee_id, name);
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/api/')) return await handleApi(req, res, p, url.searchParams);

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    if (p.startsWith('/photos/')) {
      const name = p.slice('/photos/'.length);
      if (!/^[\w-]+\.jpg$/.test(name) || !canViewPhoto(req, name)) return send(res, 404, 'Not found');
      return serveFile(res, path.join(PHOTO_DIR, name), 'private, max-age=86400');
    }

    const file = p === '/' ? '/index.html' : p === '/admin' || p === '/admin/' ? '/admin.html' : decodeURIComponent(p);
    const full = path.join(PUBLIC_DIR, path.normalize(file));
    if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
    serveFile(res, full);
  } catch (e) {
    const status = e.status || (e instanceof URIError ? 400 : 500);
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Terjadi kesalahan di server.' : e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Absensi berjalan di http://localhost:${PORT}`);
  console.log(`  Karyawan (HP) : http://localhost:${PORT}/`);
  console.log(`  Dashboard     : http://localhost:${PORT}/admin`);
});
