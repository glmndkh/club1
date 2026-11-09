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
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const a = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
      lastStats: store.mail.lastStats || null,
      recent: (store.mail.recent || []).slice(0, 15),
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
        let added = 0, club = 0;
        await store.lock(() => {
          const refs = new Set(store.inbox.map(r => r.ref));
          const recent = store.mail.recent || [];
          for (const m of mails) {
            store.mail.seen.push(m.id);
            const { row, info } = bank.inspectMail(m, accounts);
            if (info) recent.unshift(info);
            if (row) club++;
            if (row && !refs.has(row.ref)) { store.inbox.push(row); refs.add(row.ref); added++; }
          }
          store.mail.recent = recent.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
          store.mail.seen = store.mail.seen.slice(-5000);
          store.mail.lastScan = store.mail.lastOk = new Date().toISOString();
          store.mail.lastStats = { at: store.mail.lastScan, checked: mails.length, club, added };
          store.mail.error = '';
          if (added) store.saveInbox();
          store.saveMail();
        });
        if (mails.length) console.log(`[gmail] ${mails.length} шинэ банкны мэйл уншлаа, клубийн дансанд орсон: ${club}, шинээр нэмсэн: ${added}`);
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

  /* ---------- Хэрэглэгч ба нэвтрэлт ---------- */
  const ROLES = ['owner', 'manager', 'coach', 'student'];
  const STUDENT_ACTIONS = ['logout', 'changePassword', 'ping', 'load', 'poll', 'studentTaskDone'];
  const validLogin = (id, role) => role === 'student' ? (/^[a-z0-9._-]{3,40}$/.test(id) || validEmail(id)) : validEmail(id);
  const SESSION_MS = 30 * 864e5;
  const tokHash = t => crypto.createHash('sha256').update(String(t || '')).digest('hex');
  const normEmail = e => String(e || '').trim().toLowerCase();
  const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  function validPassword(p) { if (String(p || '').length < 8) throw new Error('Нууц үг дор хаяж 8 тэмдэгт байна.'); }
  function publicUser(u) {
    return { id: u.id, name: u.name, email: u.email, phone: u.phone || '', role: u.role, coachId: u.coachId || '', memberId: u.memberId || '', active: u.active !== false };
  }

  /** Сурагчид зөвхөн өөрийнх нь мэдээллийг өгнө (бусад хүүхдийн нэр, утас, төлбөр орохгүй). */
  function studentState(me) {
    const st = store.db.state;
    if (!st) return null;
    const m = (st.members || []).find(x => x.id === me.memberId);
    if (!m) return null;
    const att = {};
    for (const [k, v] of Object.entries(st.attendance || {})) if (k.endsWith('|' + m.id)) att[k] = v;
    const tasks = (st.tasks || []).filter(t => t.memberId === m.id);
    const progIds = new Set(tasks.map(t => t.programId));
    return {
      ...st,
      members: [m], tasks, attendance: att,
      programs: (st.programs || []).filter(p => progIds.has(p.id)),
      classes: (st.classes || []).filter(c => c.id === m.classId),
      coaches: (st.coaches || []).map(c => ({ id: c.id, clubId: c.clubId, name: c.name })),
      manualPayments: (st.manualPayments || []).filter(p => p.memberId === m.id).map(p => ({ ...p, staff: '' })),
      transactions: (st.transactions || []).filter(t => (t.allocations || []).some(a => a.memberId === m.id))
        .map(t => ({ ...t, allocations: t.allocations.filter(a => a.memberId === m.id), payerAccount: '', excess: 0 })),
      applications: [], notifications: [], audit: [], payerCredits: {}, refunds: [], transfers: [], gmailSeen: [],
      bank: { connected: false, connectedAt: null, inbox: '' },
    };
  }

  function studentTaskDone(p, me) {
    return store.lock(() => {
      const st = store.db.state;
      const t = st && (st.tasks || []).find(x => x.id === p.taskId && x.memberId === me.memberId);
      if (!t) throw new Error('Дасгал олдсонгүй.');
      if (t.status !== 'assigned') return { ok: true, rev: store.db.rev };
      t.status = 'pending'; t.markedBy = 'student'; t.markedAt = ubDate();
      (st.audit = st.audit || []).unshift({ date: ubDate(), text: `${me.name} дасгалаа хийсэн гэж тэмдэглэв` });
      store.db.rev++;
      store.saveDb();
      return { ok: true, rev: store.db.rev, state: studentState(me) };
    });
  }
  function authUser(token) {
    if (!token) return null;
    const s = store.sessions[tokHash(token)];
    if (!s || s.exp < Date.now()) return null;
    const u = store.users.find(x => x.id === s.userId);
    return u && u.active !== false ? u : null;
  }
  function newSession(u) {
    const token = crypto.randomBytes(32).toString('hex'), now = Date.now();
    for (const [k, s] of Object.entries(store.sessions)) if (s.exp < now) delete store.sessions[k];
    store.sessions[tokHash(token)] = { userId: u.id, exp: now + SESSION_MS, created: new Date().toISOString() };
    store.saveSessions();
    return token;
  }
  function dropSessions(userId, keepHash) {
    for (const [k, s] of Object.entries(store.sessions)) if (s.userId === userId && k !== keepHash) delete store.sessions[k];
    store.saveSessions();
  }
  const activeOwners = except => store.users.filter(u => u.role === 'owner' && u.active !== false && u.id !== except).length;
  const usersList = () => ({ ok: true, users: store.users.map(publicUser) });
  /** Gmail-ийн дэлгэрэнгүй (хаяг, банкны мэйлүүд) зөвхөн эзэнд. */
  const mailFor = me => me.role === 'owner' ? mailStatus() : { configured: !!(store.secrets.gmail && store.secrets.gmail.user) };

  /** Анхны тохиргоо: клуб ба эзний бүртгэл үүсгэнэ. Хэрэглэгч байхгүй үед л ажиллана. */
  function setup(p) {
    const o = p.owner || {}, st = p.state;
    const email = normEmail(o.email), name = clip(o.name, 90).trim();
    if (!name || !validEmail(email)) throw new Error('Эзний нэр, имэйлээ зөв оруулна уу.');
    validPassword(o.password);
    if (!st || st.version !== 3 || !Array.isArray(st.clubs) || !st.clubs[0] || !String(st.clubs[0].name || '').trim()) throw new Error('Клубийн нэрээ оруулна уу.');
    return store.lock(() => {
      if (store.users.length) throw new Error('Клуб аль хэдийн үүссэн байна. Нэвтэрнэ үү.');
      if (store.db.state) store.archiveDb('before-setup');
      store.db = { rev: 1, appsRev: 0, state: st };
      store.saveDb();
      store.inbox = []; store.saveInbox();
      const u = { id: 'u_' + crypto.randomBytes(6).toString('hex'), name, email, phone: clip(o.phone, 30), role: 'owner', active: true,
        passwordHash: hashPassword(o.password), createdAt: new Date().toISOString() };
      store.users = [u]; store.saveUsers();
      return { ok: true, server: 'vz', token: newSession(u), user: publicUser(u), rev: 1, appsRev: 0 };
    });
  }

  function login(p, ip) {
    if (!rateLimit('l:' + ip, 10, 600e3)) throw new Error('Хэт олон оролдлого. 10 минутын дараа дахин оролдоно уу.');
    const u = store.users.find(x => x.email === normEmail(p.email) && x.active !== false);
    if (!u || !verifyPassword(p.password, u.passwordHash)) throw new Error('Имэйл эсвэл нууц үг буруу байна.');
    return { ok: true, server: 'vz', token: newSession(u), user: publicUser(u) };
  }

  function userCreate(p) {
    const email = normEmail(p.email), name = clip(p.name, 90).trim(), role = String(p.role || '');
    if (!ROLES.includes(role)) throw new Error('Үүрэг буруу байна.');
    if (!name || !validLogin(email, role)) throw new Error(role === 'student' ? 'Нэвтрэх нэр 3–40 тэмдэгт (латин жижиг үсэг, тоо, . _ -) байна.' : 'Нэр, имэйлээ зөв оруулна уу.');
    validPassword(p.password);
    return store.lock(() => {
      if (store.users.some(u => u.email === email)) throw new Error('Энэ нэвтрэх нэр/имэйл бүртгэлтэй байна.');
      let memberId = '';
      if (role === 'student') {
        memberId = clip(p.memberId, 60);
        if (!(store.db.state && (store.db.state.members || []).some(m => m.id === memberId))) throw new Error('Сурагч олдсонгүй.');
        if (store.users.some(u => u.role === 'student' && u.memberId === memberId)) throw new Error('Энэ сурагчид нэвтрэх эрх аль хэдийн үүссэн байна.');
      }
      store.users.push({ id: 'u_' + crypto.randomBytes(6).toString('hex'), name, email, phone: clip(p.phone, 30), role,
        coachId: clip(p.coachId, 60), memberId, active: true, passwordHash: hashPassword(p.password), createdAt: new Date().toISOString() });
      store.saveUsers();
      return usersList();
    });
  }

  function userUpdate(p, me) {
    return store.lock(() => {
      const u = store.users.find(x => x.id === p.id);
      if (!u) throw new Error('Ажилтан олдсонгүй.');
      const next = { ...u };
      if (p.name !== undefined) { next.name = clip(p.name, 90).trim(); if (!next.name) throw new Error('Нэрээ оруулна уу.'); }
      if (p.phone !== undefined) next.phone = clip(p.phone, 30);
      if (p.coachId !== undefined) next.coachId = clip(p.coachId, 60);
      if (p.role !== undefined && (u.role === 'student') !== (p.role === 'student')) throw new Error('Сурагчийн эрхийг ажилтны эрх болгох боломжгүй.');
      if (p.email !== undefined) {
        next.email = normEmail(p.email);
        if (!validLogin(next.email, u.role)) throw new Error('Нэвтрэх нэр/имэйлээ зөв оруулна уу.');
        if (store.users.some(x => x.id !== u.id && x.email === next.email)) throw new Error('Энэ имэйлтэй ажилтан бүртгэлтэй байна.');
      }
      if (p.role !== undefined) { if (!ROLES.includes(p.role)) throw new Error('Үүрэг буруу байна.'); next.role = p.role; }
      if (p.active !== undefined) next.active = !!p.active;
      if (u.role === 'owner' && u.active !== false && (next.role !== 'owner' || next.active === false) && !activeOwners(u.id)) {
        throw new Error('Дор хаяж нэг идэвхтэй клубийн эзэн байх ёстой.');
      }
      if (p.password) { validPassword(p.password); next.passwordHash = hashPassword(p.password); }
      Object.assign(u, next);
      store.saveUsers();
      if (next.active === false || p.password) dropSessions(u.id, u.id === me.id ? tokHash(p.token) : undefined);
      return usersList();
    });
  }

  function changePassword(p, me) {
    if (!verifyPassword(p.current, me.passwordHash)) throw new Error('Одоогийн нууц үг буруу байна.');
    validPassword(p.next);
    return store.lock(() => {
      me.passwordHash = hashPassword(p.next);
      store.saveUsers();
      dropSessions(me.id, tokHash(p.token));
      return { ok: true };
    });
  }

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
    if (p.action === 'session') {
      const u = authUser(p.token);
      return { ok: true, ...base, setupNeeded: store.users.length === 0, user: u ? publicUser(u) : null };
    }
    if (p.action === 'setup') return setup(p);
    if (p.action === 'login') return login(p, ip);
    const me = authUser(p.token);
    if (!me) return { ok: false, auth: true, error: 'Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.' };
    const need = (...roles) => { if (!roles.includes(me.role)) throw new Error('Энэ үйлдлийг хийх эрх танд алга.'); };
    if (me.role === 'student') {
      if (!STUDENT_ACTIONS.includes(p.action)) throw new Error('Энэ үйлдлийг хийх эрх танд алга.');
      if (p.action === 'load') return { ok: true, ...base, rev: store.db.rev, appsRev: store.db.appsRev, state: studentState(me), inbox: [] };
      if (p.action === 'poll') return { ok: true, ...base, rev: store.db.rev, appsRev: store.db.appsRev, inbox: [], applications: [] };
      if (p.action === 'ping') return { ok: true, ...base, user: publicUser(me), rev: store.db.rev };
      if (p.action === 'studentTaskDone') return { ...(await studentTaskDone(p, me)), ...base };
    }
    switch (p.action) {
      case 'logout': delete store.sessions[tokHash(p.token)]; store.saveSessions(); return { ok: true };
      case 'changePassword': return changePassword(p, me);
      case 'users': need('owner'); return usersList();
      case 'userCreate': need('owner'); return userCreate(p);
      case 'userUpdate': need('owner'); return userUpdate(p, me);
      case 'ping': return { ok: true, ...base, user: publicUser(me), rev: store.db.rev, appsRev: store.db.appsRev, mail: mailFor(me) };
      case 'load': return { ok: true, ...base, rev: store.db.rev, appsRev: store.db.appsRev, state: store.db.state, inbox: pendingInbox(), mail: mailFor(me) };
      case 'poll': return { ok: true, ...base, rev: store.db.rev, appsRev: store.db.appsRev, inbox: pendingInbox(),
        applications: (store.db.state && store.db.state.applications) || [], mail: mailFor(me) };
      case 'save': return { ...(await save(p.state, p.baseRev)), ...base };
      case 'markInbox': return markInbox(p.refs, p.status);
      case 'rescan': {
        need('owner');
        await store.lock(() => { store.mail.seen = []; store.mail.recent = []; store.saveMail(); });
        const added = await scan();
        return { ok: true, ...base, added, inbox: pendingInbox(), mail: mailStatus() };
      }
      case 'scanNow': { need('owner', 'manager'); const added = await scan(); return { ok: true, ...base, added, inbox: pendingInbox(), mail: mailFor(me) }; }
      case 'gmailSave': {
        need('owner');
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
        need('owner');
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
  // Нууц үгээ мартсан үед:  node server.js reset-password имэйл@жишээ.mn ШинэНууцҮг
  if (process.argv[2] === 'reset-password') {
    const { store } = createApp({ scanMinutes: 0 });
    const u = store.users.find(x => x.email === String(process.argv[3] || '').trim().toLowerCase());
    if (!u || String(process.argv[4] || '').length < 8) { console.error('Хэрэглэгч олдсонгүй эсвэл нууц үг 8-аас богино байна.'); process.exit(1); }
    u.passwordHash = hashPassword(process.argv[4]); u.active = true; store.saveUsers();
    console.log('Нууц үг шинэчлэгдлээ:', u.email);
    process.exit(0);
  }
  const port = Number(process.env.PORT || 8080), host = process.env.HOST || '0.0.0.0';
  const app = createApp();
  app.server.listen(port, host, () => {
    console.log(`Volleyball Zone сервер: http://${host}:${port}`);
    if (!app.store.users.length) console.log('Клуб хараахан үүсээгүй. Апп-ыг нээгээд "Нэвтрэх" дарж клубээ үүсгэнэ үү.');
  });
  setTimeout(() => app.scan(), 5000);
  const stop = () => { app.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
