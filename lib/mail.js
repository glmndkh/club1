'use strict';
/**
 * Gmail-ийг IMAP + App Password-аар уншина (зөвхөн уншина, юу ч өөрчлөхгүй).
 * App Password хугацаагүй тул сервер 24/7 ажиллана.
 */
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { ALL_DOMAINS } = require('./bank');

async function withClient(creds, fn) {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT || 993),
    secure: !/^(0|false|no)$/i.test(process.env.IMAP_SECURE || 'true'),
    auth: { user: creds.user, pass: String(creds.pass || '').replace(/\s+/g, '') },
    logger: false, socketTimeout: 60000,
  });
  try {
    await client.connect();
  } catch (e) {
    const msg = /auth|credential|invalid/i.test(String(e && (e.responseText || e.message)))
      ? 'Gmail нэвтрэлт амжилтгүй. Хаяг болон App Password-оо шалгана уу.'
      : 'Gmail-тэй холбогдож чадсангүй: ' + (e && e.message);
    throw new Error(msg);
  }
  try { return await fn(client); } finally { try { await client.logout(); } catch (e) { client.close(); } }
}

async function testLogin(creds) {
  await withClient(creds, async () => true);
}

/** Банкнаас ирсэн, өмнө нь уншаагүй мэйлүүдийг буцаана. */
async function fetchBankMails(creds, seen, days = 14) {
  return withClient(creds, async client => {
    const boxes = await client.list();
    const all = boxes.find(b => b.specialUse === '\\All');
    const box = all ? all.path : 'INBOX';
    const lock = await client.getMailboxLock(box);
    try {
      const since = new Date(Date.now() - days * 864e5);
      const uids = await client.search({ since, or: ALL_DOMAINS.map(d => ({ from: d })) }, { uid: true });
      if (!uids || !uids.length) return [];
      const fresh = [];
      for await (const m of client.fetch(uids, { uid: true, emailId: true }, { uid: true })) {
        const id = m.emailId || `${box}:${m.uid}`;
        if (!seen.has(id)) fresh.push({ uid: m.uid, id });
      }
      if (!fresh.length) return [];
      const byUid = new Map(fresh.map(f => [f.uid, f.id]));
      const out = [];
      for await (const m of client.fetch(fresh.map(f => f.uid), { uid: true, source: true }, { uid: true })) {
        const raw = m.source.toString('utf8');
        const parsed = await simpleParser(m.source);
        out.push({
          id: byUid.get(m.uid),
          from: (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '',
          html: parsed.html || '',
          text: parsed.text || '',
          rawHeaders: raw.split(/\r?\n\r?\n/)[0],
          date: parsed.date,
        });
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

module.exports = { testLogin, fetchBankMails };
