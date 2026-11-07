'use strict';
/**
 * VOLLEYBALL ZONE сервер
 *  - Апп-ыг (public/index.html) үйлчилнэ
 *  - /api: өгөгдөл хадгалах, элсэлтийн хүсэлт, банкны гүйлгээ
 *  - 5 минут тутам клубийн Gmail-ийг IMAP-аар уншиж, клубийн дансанд орсон гүйлгээг бүртгэнэ
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./lib/store');
const bank = require('./lib/bank');

const TZ = 'Asia/Ulaanbaatar';
const MAX_BODY = 6 * 1024 * 1024;

function digits(s) { return String(s || '').replace(/\D/g, '').replace(/^976(?=\d{8}$)/, ''); }
function clip(s, n) { return String(s == null ? '' : s).slice(0, n); }
function ubDate(fmt) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return fmt === 'yyMMdd' ? p.year.slice(2) + p.month + p.day : `${p.year}-${p.month}-${p.day}`;
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function mergeById(target, source) {
  const ids = new Set(target.map(x => x && x.id));
  (source || []).forEach(x => { if (x && !ids.has(x.id)) target.push(x); });
  return target;
}

function createApp(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const publicDir = opts.publicDir || path.join(__dirname, 'public');
  const mailer = opts.mailer || require('./lib/mail');
  const scanMinutes = Number(opts.scanMinutes || process.env.SCAN_MINUTES || 5);
  const trustProxy = opts.trustProxy ?? /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
  const store = new Store(dataDir);

  if (process.env.VZ_API_TOKEN && process.env.VZ_API_TOKEN !== store.secrets.apiToken) {
    store.secrets.apiToken = process.env.VZ_API_TOKEN; store.saveSecrets();
  }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    store.secrets.gmail = { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD };
  }

  /* ---------- Gmail шалгалт ---------- */
  let scanning = null;
  function clubAccounts() {
    const st = store.db.state;
    if (!st) return [];
    const c = (st.clubs || []).find(x => x.id === st.clubId) || (st.clubs || [])[0] || {};
    return String(c.bankAccounts || '').split(/[,;\s]+/).filter(Boolean);
  }
  function mailStatus() {
    const g = store.secrets.gmail;
    return {
      configured: !!(g && g.user && g.pass), user: g ? g.user : '', lastScan: store.mail.lastScan, lastOk: store.mail.lastOk,
      error: store.mail.error || '', accounts: clubAccounts(), scanMinutes,
      suspicious: store.inbox.filter(r => r.status === 'suspicious').length,
    };
  }
  async function scan() {
    if (scanning) return scanning;
    scanning = (async () => {
      const g = store.secrets.gmail;
      if (!g || !g.user || !g.pass) return 0;
      const accounts = clubAccounts();
      try {
        if (!accounts.length) throw new Error('Клубийн дансны дугаар тохируулаагүй байна (Клубийн тохиргоо → Gmail холболт).');
        const seen = new Set(store.mail.seen);
        const mails = await mailer.fetchBankMails(g, seen, 14);
        let added = 0;
        await store.lock(() => {
          const refs = new Set(store.inbox.map(r => r.ref));
          for (const m of mails) {
            store.mail.seen.push(m.id);
            const row = bank.mailToRow(m, accounts);
            if (row && !refs.has(row.ref)) { store.inbox.push(row); refs.add(row.ref); added++; }
          }
          store.mail.seen = store.mail.seen.slice(-5000);
          store.mail.lastScan = store.mail.lastOk = new Date().toISOString();
          store.mail.error = '';
          if (added) store.saveInbox();
          store.saveMail();
        });
        if (added) console.log(`[gmail] ${added} шинэ гүйлгээ`);
        return added;
      } catch (e) {
        store.mail.lastScan = new Date().toISOString();
        store.mail.error = String(e.message || e);
        store.saveMail();
        console.warn('[gmail]', store.mail.error);
        return 0;
      }
    })();
    try { return await scanning; } finally { scanning = null; }
  }
  const timer = scanMinutes > 0 ? setInterval(scan, scanMinutes * 60000) : null;
  if (timer && timer.unref) timer.unref();

  /* ---------- API ---------- */
  const pendingInbox = () => store.inbox.filter(r => r.status === 'new' || r.status === 'review');
  const rateHits = new Map();
  function rateLimit(ip, limit, windowMs) {
    const now = Date.now();
    const arr = (rateHits.get(ip) || []).filter(t => now - t < windowMs);
    arr.push(now); rateHits.set(ip, arr);
    return arr.length <= limit;
  }

  function publicInfo() {
    const st = store.db.state;
    if (!st) return { ok: false, error: 'Клубийн систем хараахан тохируулагдаагүй байна.' };
    const monthly = (st.members || []).find(m => m.plan === 'monthly');
    const pack = (st.members || []).find(m => m.plan === 'session');
    return { ok: true, public: {
      clubId: st.clubId,
      clubs: (st.clubs || []).map(c => ({ id: c.id, name: c.name, tagline: c.tagline, location: c.location, phone: c.phone, support: c.support, email: c.email, activities: c.activities })),
      classes: st.classes || [],
      coaches: (st.coaches || []).map(c => ({ id: c.id, clubId: c.clubId, name: c.name })),
      holidays: st.holidays || [], sessionOverrides: st.sessionOverrides || {},
      pricing: { monthly: monthly ? monthly.price : null, pack: pack ? pack.price : null },
    } };
  }

  async function apply(a) {
    if (!a || typeof a !== 'object') throw new Error('Хүсэлтийн мэдээлэл алга.');
    const type = a.type === 'kid' ? 'kid' : a.type === 'adult' ? 'adult' : '';
    const phone = digits(type === 'kid' ? a.guardianPhone : a.phone);
    const age = Number(a.age);
    if (!type || !clip(a.name, 90).trim() || !/^\d{8}$/.test(phone)) throw new Error('Нэр, утасны дугаараа шалгана уу.');
    if (!(type === 'kid' ? age >= 3 && age <= 17 : age >= 18 && age <= 99)) throw new Error('Нас буруу байна.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.meetingDate || '')) || !/^\d{2}:\d{2}$/.test(String(a.meetingTime || ''))) throw new Error('Уулзалтын цаг буруу байна.');
    return store.lock(() => {
      const st = store.db.state;
      if (!st) throw new Error('Клубийн систем хараахан тохируулагдаагүй байна.');
      const cls = (st.classes || []).find(c => c.id === a.classId);
      if (!cls) throw new Error('Сонгосон анги олдсонгүй.');
      st.applications = st.applications || [];
      const pending = st.applications.filter(x => x.status === 'pending' && digits(x.type === 'kid' ? x.guardianPhone : x.phone) === phone);
      if (pending.length >= 3) throw new Error('Энэ дугаараас хүлээгдэж буй хүсэлт олон байна. Клубтэй холбогдоно уу.');
      const prefix = 'VZ-' + ubDate('yyMMdd') + '-';
      const used = st.applications.filter(x => String(x.id).startsWith(prefix)).map(x => Number(String(x.id).slice(prefix.length)) || 0);
      const id = prefix + String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0');
      const item = { id, clubId: st.clubId, type, classId: cls.id, age, status: 'pending', meetingDate: a.meetingDate, meetingTime: a.meetingTime,
        meetingStatus: 'scheduled', createdAt: new Date().toISOString(), approvedBy: '', memberId: '', rejectionReason: '', source: 'public',
        guardianPhone: type === 'kid' ? phone : '', phone: type === 'kid' ? digits(a.childPhone) : phone, childPhone: type === 'kid' ? digits(a.childPhone) : '',
        emergencyPhone: digits(a.emergencyPhone) || phone };
      const keep = { name: 90, gender: 20, school: 100, grade: 30, guardian: 90, relationship: 40, email: 100, experience: 40, emergencyName: 80 };
      for (const k of Object.keys(keep)) item[k] = clip(a[k], keep[k]);
      if (type === 'adult') item.guardian = 'Өөрөө';
      st.applications.push(item);
      st.notifications = st.notifications || [];
      st.notifications.unshift({ id: 'nt_' + crypto.randomBytes(4).toString('hex'), date: ubDate(), createdAt: Date.now(), channel: 'Internal', to: 'Club owner',
        type: 'Шинэ элсэлтийн хүсэлт', text: `${item.name} · ${cls.name} · Уулзалт ${item.meetingDate} ${item.meetingTime}`, status: 'Simulated' });
      store.db.appsRev++;
      store.saveDb();
      return { ok: true, id };
    });
  }

  function appStatus(id, phone) {
    const st = store.db.state;
    if (!st) throw new Error('Клубийн систем хараахан тохируулагдаагүй байна.');
    const a = (st.applications || []).find(x => String(x.id).toUpperCase() === String(id || '').trim().toUpperCase()
      && digits(x.type === 'kid' ? x.guardianPhone : x.phone) === digits(phone));
    if (!a) return { ok: true, application: null };
    const out = {};
    ['id', 'name', 'type', 'classId', 'status', 'meetingDate', 'meetingTime', 'guardianPhone', 'phone', 'rejectionReason', 'createdAt'].forEach(k => { out[k] = a[k]; });
    return { ok: true, application: out };
  }

  function save(state, baseRev) {
    if (!state || state.version !== 3 || !Array.isArray(state.members) || !Array.isArray(state.classes)) throw new Error('Өгөгдлийн бүтэц буруу байна.');
    return store.lock(() => {
      const cur = store.db.state;
      if (cur && Number(baseRev) !== store.db.rev) return { ok: false, conflict: true, rev: store.db.rev, appsRev: store.db.appsRev, state: cur };
      state.applications = state.applications || [];
      state.notifications = state.notifications || [];
      if (cur) { mergeById(state.applications, cur.applications); mergeById(state.notifications, cur.notifications); }
      store.db.state = state;
      store.db.rev++;
      store.saveDb();
      return { ok: true, rev: store.db.rev, appsRev: store.db.appsRev, applications: state.applications };
    });
  }

  function markInbox(refs, status) {
    if (!Array.isArray(refs) || !refs.length) return { ok: true, updated: 0 };
    status = ['imported', 'review', 'new', 'ignored'].includes(status) ? status : 'imported';
    return store.lock(() => {
      let updated = 0;
      store.inbox.forEach(r => { if (refs.includes(r.ref) && r.status !== status) { r.status = status; updated++; } });
      if (updated) store.saveInbox();
      return { ok: true, updated };
    });
  }

  async function handleApi(p, ip) {
    const base = { server: 'vz' };
    if (p.action === 'public') return publicInfo();
    if (p.action === 'status') {
      if (!rateLimit('s:' + ip, 30, 3600e3)) throw new Error('Хэт олон оролдлого. Хэсэг хугацааны дараа дахин оролдоно уу.');
      return appStatus(p.id, p.phone);
    }
    if (p.action === 'apply') {
      if (!rateLimit('a:' + ip, 10, 3600e3)) throw new Error('Хэт олон хүсэлт. Хэсэг хугацааны дараа дахин оролдоно уу.');
      return apply(p.application);
    }
    if (!safeEqual(p.token, store.secrets.apiToken)) {
      if (!rateLimit('t:' + ip, 20, 600e3)) throw new Error('Хэт олон буруу оролдлого. 10 минутын дараа дахин оролдоно уу.');
      return { ok: false, error: 'API түлхүүр буруу байна.' };
    }
    switch (p.action) {
      case 'ping': return { ok: true, ...base, rev: store.db.rev, appsRev: store.db.appsRev, mail: mailStatus() };
      case 'load': return { ok: true, ...base, rev: store.db.rev, appsRev: store.db.appsRev, state: store.db.state, inbox: pendingInbox(), mail: mailStatus() };
      case 'poll': return { ok: true, ...base, rev: store.db.rev, appsRev: store.db.appsRev, inbox: pendingInbox(),
        applications: (store.db.state && store.db.state.applications) || [], mail: mailStatus() };
      case 'save': return { ...(await save(p.state, p.baseRev)), ...base };
      case 'markInbox': return markInbox(p.refs, p.status);
      case 'scanNow': { const added = await scan(); return { ok: true, ...base, added, inbox: pendingInbox(), mail: mailStatus() }; }
      case 'gmailSave': {
        const user = clip(p.user, 120).trim(), pass = String(p.pass || '').replace(/\s+/g, '');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user)) throw new Error('Gmail хаягаа зөв оруулна уу.');
        if (!pass && !(store.secrets.gmail && store.secrets.gmail.user === user)) throw new Error('App Password-оо оруулна уу.');
        const creds = { user, pass: pass || store.secrets.gmail.pass };
        await mailer.testLogin(creds);
        await store.lock(() => {
          store.secrets.gmail = creds; store.saveSecrets();
          if (store.mail.user !== user) { store.mail.seen = []; store.mail.user = user; }
          store.mail.error = ''; store.saveMail();
        });
        const added = await scan();
        return { ok: true, ...base, added, inbox: pendingInbox(), mail: mailStatus() };
      }
      case 'gmailRemove':
        await store.lock(() => { delete store.secrets.gmail; store.saveSecrets(); store.mail.error = ''; store.saveMail(); });
        return { ok: true, ...base, mail: mailStatus() };
      default: return { ok: false, error: 'Үл мэдэгдэх үйлдэл' };
    }
  }

  /* ---------- HTTP ---------- */
  let indexCache = null;
  function indexHtml() {
    if (indexCache && !opts.noCache) return indexCache;
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replace("const VZ_CLOUD_URL='';", "const VZ_CLOUD_URL='/api';");
    indexCache = html;
    return html;
  }
  function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
    });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
    try {
      if (url.pathname === '/api') {
        let p = Object.fromEntries(url.searchParams);
        if (req.method === 'POST') {
          let size = 0; const chunks = [];
          for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(res, 413, JSON.stringify({ ok: false, error: 'Хүсэлт хэт том байна.' })); chunks.push(c); }
          try { p = { ...p, ...JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }; } catch (e) { return send(res, 400, JSON.stringify({ ok: false, error: 'JSON буруу' })); }
        } else if (req.method !== 'GET') return send(res, 405, '{"ok":false}');
        const out = await handleApi(p, ip);
        return send(res, 200, JSON.stringify(out));
      }
      if (url.pathname === '/health') return send(res, 200, JSON.stringify({ ok: true, rev: store.db.rev, gmail: !!store.secrets.gmail }));
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, indexHtml(), 'text/html; charset=utf-8');
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    } catch (e) {
      return send(res, 200, JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  });

  return { server, store, scan, close: () => { if (timer) clearInterval(timer); server.close(); } };
}

module.exports = { createApp };

if (require.main === module) {
  if (process.argv[2] === 'token') {
    const { store } = createApp({ scanMinutes: 0 });
    console.log(store.secrets.apiToken);
    process.exit(0);
  }
  const port = Number(process.env.PORT || 8080), host = process.env.HOST || '0.0.0.0';
  const app = createApp();
  app.server.listen(port, host, () => {
    console.log(`Volleyball Zone сервер: http://${host}:${port}`);
    if (app.store.generatedToken) console.log('Шинэ API түлхүүр үүслээ (апп-ын Клубийн тохиргоонд оруулна):\n  ' + app.store.secrets.apiToken);
    else console.log('API түлхүүрээ харах: npm run token');
  });
  setTimeout(() => app.scan(), 5000);
  const stop = () => { app.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
