'use strict';
// Хурдан шалгалт: npm test
const assert = require('assert');
const bank = require('../lib/bank');

const td = x => `<td class="style12">${x}</td>`;
function khan({ journal = '123', from = '5099', amount = '150,000.00', to = '5000111222', note = 'Бат 99112233' }) {
  return `<table><tr><td>Огноо<span>/Date</span>:<span>2026.11.07 10:15:00</span></td></tr>
<tr><td>Шилжүүлгийн мэдээлэл<span>/Transaction information</span><br>Журналын<span>/Journal No:</span><span>${journal}</span></td></tr>
<tr><td>Дт/From</td><td>IBAN/Дансны/Картын дугаар IBAN/Account/Card number</td><td>Нэр<span>/Name</span></td><td>Дүн/Amount</td><td>Ханш/Rate</td></tr>
<tr>${td(from)}${td('ТӨЛӨГЧ')}${td(amount)}${td('MNT')}${td('1.00')}</tr>
<tr><td>Kт/To</td><td>Банкны дугаар/Branch No</td><td>Банкны нэр/Bank Name</td>${td(amount)}${td('MNT')}${td('1.00')}</tr>
<tr>${td('05')}${td('Khan Bank - Хаан банк')}</tr><tr><td>IBAN/Дансны/Картын дугаар IBAN/Account/Card Number</td><td>Нэр<span>/Name</span></td></tr>
<tr>${td(to)}${td('КЛУБ')}</tr><tr><td>Гүйлгээний утга<span>/Transaction description:</span></td></tr><tr><td>${note}</td></tr></table>`;
}
const hdr = dom => `Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@${dom} header.s=s1;\r\nFrom: <noreply@${dom}>`;
const mail = (html, dom = 'khanbank.com', from = 'noreply@khanbank.com') => ({ id: 'm1', from, html, rawHeaders: hdr(dom) });
const ACC = ['5000111222'];

let r = bank.mailToRow(mail(khan({})), ACC);
assert.strictEqual(r.status, 'new'); assert.strictEqual(r.amount, 150000); assert.strictEqual(r.ref, 'khan-123'); assert.strictEqual(r.note, 'Бат 99112233');
r = bank.mailToRow(mail(khan({ to: 'MN120005005000111222' })), ACC);
assert.ok(r, 'IBAN хэлбэрийн данс танигдах ёстой');
assert.strictEqual(bank.mailToRow(mail(khan({ from: '5000111222', to: '5024906975' })), ACC), null, 'гарсан гүйлгээг алгасна');
assert.strictEqual(bank.mailToRow(mail(khan({}), 'evil.com'), ACC).status, 'suspicious', 'DKIM таарахгүй бол сэжигтэй');
assert.strictEqual(bank.mailToRow(mail(khan({ journal: '' })), ACC).ref, 'khan-m1', 'журналгүй бол мэйлийн ID');
assert.strictEqual(bank.mailToRow(mail('<p>Аюулгүй байдлын мэдэгдэл</p>'), ACC), null, 'гүйлгээ биш мэйл');
r = bank.mailToRow(mail('<table><tr><td>Хүлээн авагч данс</td><td>5000111222</td></tr><tr><td>Гүйлгээний дүн:</td><td>50,000.00 MNT</td></tr><tr><td>Гүйлгээний утга:</td><td>хандив</td></tr></table>', 'golomtbank.com', 'info@golomtbank.com'), ACC);
assert.strictEqual(r.status, 'review'); assert.strictEqual(r.amount, 50000); assert.strictEqual(r.bank, 'Голомт банк');
assert.strictEqual(bank.bankFor('x@example.com'), null);
console.log('Бүх шалгалт амжилттай ✔');
