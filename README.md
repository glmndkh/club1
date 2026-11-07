# Volleyball Zone

Волейболын клубийн бүртгэл, хуваарь, ирц, төлбөрийн апп. Банкнаас Gmail-д ирсэн орлогын мэйлийг уншиж, төлбөрийг автоматаар бүртгэнэ.

- `server.js`, `lib/`: Node.js сервер (API, өгөгдөл хадгалах, Gmail IMAP уншигч)
- `public/index.html`: апп
- `deploy/hostinger-compose.yml`: Hostinger Docker Manager-т зориулсан тохиргоо
- Суулгах заавар: [ЗААВАР.md](ЗААВАР.md)

Шалгах: `npm ci && npm test`
