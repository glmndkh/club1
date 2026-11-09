'use strict';
/**
 * Энгийн, найдвартай файл өгөгдлийн сан.
 * - Бүх бичилт нэг дараалалд (mutex) явна.
 * - Түр файл руу бичээд rename хийдэг тул тасалдсан ч файл эвдрэхгүй.
 * - Өдөр бүр data/backups/ руу нөөц хуулна (сүүлийн 30 хоног).
 */
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    this.queue = Promise.resolve();
    this.db = this._read('db.json', { rev: 0, appsRev: 0, state: null });
    this.inbox = this._read('inbox.json', []);
    this.secrets = this._read('secrets.json', {});
    this.mail = this._read('mail.json', { seen: [], lastScan: null, lastOk: null, error: '' });
    this.users = this._read('users.json', []);
    this.sessions = this._read('sessions.json', {});
  }

  saveUsers() { this._write('users.json', this.users, 0o600); }
  saveSessions() { this._write('sessions.json', this.sessions, 0o600); }

  /** Анхны тохиргооны өмнөх өгөгдлийг (жишээ мэдээлэл) тусад нь хадгална. */
  archiveDb(label) {
    const file = path.join(this.dir, 'backups', `db-${label}-${Date.now()}.json`);
    try { fs.writeFileSync(file, JSON.stringify(this.db), { mode: 0o600 }); } catch (e) { console.warn('Архивлаж чадсангүй:', e.message); }
  }

  _read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch (e) { return fallback; }
  }

  _write(name, value, mode = 0o640) {
    const file = path.join(this.dir, name);
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value), { mode });
    fs.renameSync(tmp, file);
  }

  /** fn нь бусад бичилттэй давхцахгүй ажиллана. */
  lock(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  saveDb() {
    this._write('db.json', this.db);
    this._backup();
  }
  saveInbox() { this._write('inbox.json', this.inbox); }
  saveSecrets() { this._write('secrets.json', this.secrets, 0o600); }
  saveMail() { this._write('mail.json', this.mail); }

  _backup() {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.dir, 'backups', `db-${day}.json`);
    if (fs.existsSync(file)) return;
    try {
      fs.copyFileSync(path.join(this.dir, 'db.json'), file);
      const old = fs.readdirSync(path.join(this.dir, 'backups')).filter(f => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      old.slice(0, Math.max(0, old.length - 30)).forEach(f => fs.unlinkSync(path.join(this.dir, 'backups', f)));
    } catch (e) { console.warn('Нөөц хуулж чадсангүй:', e.message); }
  }
}

module.exports = { Store };
