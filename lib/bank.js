'use strict';
/**
 * Банкны мэйл задлагч.
 * Хаан банкны "Шилжүүлгийн баримт/Transaction receipt"-ийн бүтцийг бодит мэйл дээр шалгасан.
 * Бусад банкинд түлхүүр үгээр ажилладаг ерөнхий задлагч ашиглана (үр дүн нь "review" төлөвтэй).
 */

const BANKS = [
  { id: 'khan', name: 'Хаан банк', domains: ['khanbank.com'], parser: 'khan' },
  { id: 'golomt', name: 'Голомт банк', domains: ['golomtbank.com'] },
  { id: 'tdb', name: 'Худалдаа хөгжлийн банк', domains: ['tdbm.mn'] },
  { id: 'xac', name: 'Хас банк', domains: ['xacbank.mn'] },
  { id: 'state', name: 'Төрийн банк', domains: ['statebank.mn'] },
  { id: 'bogd', name: 'Богд банк', domains: ['bogdbank.com'] },
  { id: 'capitron', name: 'Капитрон банк', domains: ['capitronbank.mn'] },
  { id: 'arig', name: 'Ариг банк', domains: ['arigbank.mn'] },
  { id: 'ckb', name: 'Чингис хаан банк', domains: ['ckbank.mn'] },
  { id: 'mbank', name: 'М банк', domains: ['mbank.mn'] },
  { id: 'trans', name: 'Тээвэр хөгжлийн банк', domains: ['transbank.mn'] },
  { id: 'nib', name: 'Үндэсний хөрөнгө оруулалтын банк', domains: ['nibank.mn'] },
];
const ALL_DOMAINS = BANKS.flatMap(b => b.domains);

function bankFor(fromAddress) {
  const m = String(fromAddress || '').toLowerCase().match(/@([a-z0-9.-]+)/);
  if (!m) return null;
  const host = m[1];
  return BANKS.find(b => b.domains.some(d => host === d || host.endsWith('.' + d))) || null;
}

/** Мэйлийн толгой хэсгээс Gmail-ийн DKIM шалгалтын үр дүнг уншина. */
function dkimPass(rawHeaders, domains) {
  const head = String(rawHeaders || '').split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  return head.split(/\r?\n/)
    .filter(l => /^(ARC-)?Authentication-Results:/i.test(l))
    .some(l => {
      const re = /dkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/ig;
      let m;
      while ((m = re.exec(l))) {
        const d = m[1].toLowerCase();
        if (domains.some(x => d === x || d.endsWith('.' + x))) return true;
      }
      return false;
    });
}

function acctKey(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length >= 18) d = d.slice(-12); // IBAN: MN + 2 шалгах + 4 банк + 12 данс
  return d.replace(/^0+/, '');
}

function isClubAccount(acc, clubAccounts) {
  const k = acctKey(acc);
  return !!k && k.length >= 6 && (clubAccounts || []).some(c => acctKey(c) === k);
}

function htmlCells(html) {
  const t = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(td|th|tr|table|tbody|thead|p|div|br|li|h\d)\b[^>]*>/gi, '\u0001')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
  return t.split('\u0001').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const AMOUNT_RE = /^-?[\d\s,]+\.\d{2}$/;
const num = s => Number(String(s || '').replace(/[\s,]/g, '')) || 0;

function parseKhan(cells) {
  const joined = cells.join(' | ');
  if (!/Transaction (information|receipt)|Шилжүүлгийн мэдээлэл/i.test(joined)) return null;
  const iFrom = cells.findIndex(c => /^Дт\s*\/\s*From$/i.test(c));
  const iTo = cells.findIndex(c => /^[KК]т\s*\/\s*To$/i.test(c));
  if (iFrom < 0 || iTo < 0) return null;
  const iAmt = cells.findIndex((c, i) => i > iFrom && i < iTo && AMOUNT_RE.test(c));
  if (iAmt < 2) return null;
  const iName = cells.findIndex((c, i) => i > iTo && /^Нэр\s*\/\s*Name$/i.test(c));
  const iDesc = cells.findIndex(c => /Transaction description/i.test(c));
  const date = (joined.match(/Огноо\s*\/\s*Date\s*:\s*(\d{4}\.\d{2}\.\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/i) || [])[1] || '';
  const tx = {
    date: date.replace(/\./g, '-'),
    journal: (joined.match(/Journal No\s*:\s*(\d+)/i) || [])[1] || '',
    amount: num(cells[iAmt]),
    currency: cells[iAmt + 1] || 'MNT',
    fromAccount: cells[iAmt - 2],
    fromName: cells[iAmt - 1],
    toAccount: iName > 0 ? cells[iName + 1] : '',
    note: iDesc >= 0 ? (cells[iDesc + 1] || '') : '',
  };
  if (/^(Харилцагч танд|Гүйлгээний баримтыг)/.test(tx.note)) tx.note = '';
  tx.confident = !!(tx.amount > 0 && tx.toAccount && tx.currency === 'MNT');
  return tx;
}

function parseGeneric(cells, clubAccounts) {
  const t = cells.join(' | ');
  const after = re => {
    const i = cells.findIndex(c => re.test(c));
    if (i < 0) return '';
    const inline = cells[i].replace(re, '').replace(/^[\s:：/-]+/, '').trim();
    return inline || cells[i + 1] || '';
  };
  let amount = 0;
  const a = after(/(Гүйлгээний дүн|Орлогын дүн|Шилжүүлсэн дүн|Дүн|Amount)\s*[:：]?/i);
  if (a) amount = num((a.match(/[\d\s,]+(?:\.\d{1,2})?/) || [])[0]);
  if (!amount) { const m = t.match(/([\d,]+\.\d{2})\s*(MNT|₮|төг)/i); if (m) amount = num(m[1]); }
  if (!amount) return null;
  const note = after(/(Гүйлгээний утга|Утга|Transaction description|Description|Тайлбар)\s*[:：]?/i);
  const journal = ((t.match(/(Журнал(?:ын)?(?:\s*дугаар)?|Journal No|Гүйлгээний дугаар|Reference(?: No)?|Ref\.?\s*No)\s*[:：]?\s*\|?\s*([A-Z0-9-]{4,})/i) || [])[2]) || '';
  const toAccount = (t.match(/\b(?:MN\d{18}|\d{9,12})\b/g) || []).find(x => isClubAccount(x, clubAccounts)) || '';
  return { date: '', journal, amount, currency: 'MNT', fromAccount: '', fromName: '', toAccount, note, confident: false };
}

/**
 * Нэг мэйлийг "Банкны гүйлгээ"-ний мөр болгоно. Клубийн дансанд орсон гүйлгээ биш бол null.
 * @param {{id:string, from:string, html:string, text:string, rawHeaders:string, date:Date}} mail
 */
function mailToRow(mail, clubAccounts) {
  const bank = bankFor(mail.from);
  if (!bank) return null;
  const body = mail.html || String(mail.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
  const cells = htmlCells(body);
  const tx = (bank.parser === 'khan' && parseKhan(cells)) || parseGeneric(cells, clubAccounts);
  if (!tx || !tx.amount || !isClubAccount(tx.toAccount, clubAccounts)) return null;
  const dkim = dkimPass(mail.rawHeaders, bank.domains);
  return {
    ref: bank.id + '-' + (tx.journal || mail.id),
    date: tx.date || (mail.date ? new Date(mail.date).toISOString().slice(0, 16).replace('T', ' ') : ''),
    bank: bank.name,
    amount: tx.amount,
    note: tx.note || '',
    fromName: tx.fromName || '',
    fromAccount: tx.fromAccount || '',
    toAccount: tx.toAccount || '',
    status: !dkim ? 'suspicious' : tx.confident ? 'new' : 'review',
    dkim: dkim ? 'pass' : 'fail',
    mailId: mail.id,
    addedAt: new Date().toISOString(),
  };
}

module.exports = { BANKS, ALL_DOMAINS, bankFor, dkimPass, acctKey, isClubAccount, htmlCells, parseKhan, parseGeneric, mailToRow };
