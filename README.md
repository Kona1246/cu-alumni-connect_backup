# CU Alumni Connect — server edition

The original `index.html` ran a *pretend* server inside the browser: every member, password,
chat message, notice and backup was saved in that one browser's local storage, so another
laptop saw none of it. This version runs a real server. All data, sign-ins and backups live
in **one place** that every computer, phone or tablet uses through a web address.

```
cu-alumni-connect/
├─ server.js            the server (website + API + live chat)
├─ src/                 storage, accounts/sign-in, API, backups
├─ public/              the website (same pages and design as before)
├─ seed/seed.json       starting data used the first time the server runs
├─ scripts/cli.js       backup / restore / reset-password commands
├─ data/                created on first start – ALL your data (see below)
├─ start-windows.bat    double-click to start on Windows
├─ start-mac-linux.sh   run to start on macOS / Linux
├─ Dockerfile, docker-compose.yml   for servers / cloud hosting
└─ .env.example         settings (copy to .env)
```

## 1. Run it (any Windows, macOS or Linux computer)

1. Install **Node.js LTS** (version 18 or newer) from https://nodejs.org.
2. Start the server:
   - Windows: double-click `start-windows.bat`
   - macOS / Linux: run `./start-mac-linux.sh` (or `npm install` then `npm start`)
3. Open **http://localhost:3000**. The staff console is **http://localhost:3000/#staff**.

The window shows the addresses other computers can use, e.g. `http://192.168.1.20:3000`.
Any laptop on the same Wi-Fi/LAN opens that address and sees the same members, chat and
notices. (On Windows, click "Allow access" if the firewall asks.)

Demo sign-ins (from the original file):

| Who | ID | Password |
|---|---|---|
| Member | `101-1211-0234-15` | `alumni2015` |
| Staff admin | `cu-admin` | `cu-admin-1857` — **change it** under *My password* |
| Staff editor | `cu-editor` | `cu-editor-1857` |

For a real launch, copy `.env.example` to `.env` and set `ADMIN_PASSWORD=...` and
`SEED_DEMO_DATA=false` **before the first start**.

## 2. Where the data lives

Everything is in the `data/` folder:

| File | Contents |
|---|---|
| `data/database.json` | student records, members, staff accounts (passwords hashed with scrypt), notices, chat, feedback, directories |
| `data/uploads/` | notice attachments (PDF, images, Word files) |
| `data/settings.json` | the secret that signs sign-in cookies |
| `data/backups/` | automatic and manual backups |

Nothing is stored in the browser any more except the sign-in cookie, so members and staff
can sign in from any computer with the same ID and password.

## 3. Moving to another computer

Pick whichever suits you:

- **Copy the whole folder.** Stop the server (Ctrl+C), copy `cu-alumni-connect/` (with `data/`)
  to the other computer, start it there. Everything — accounts, passwords, chat, attachments,
  even people's current sign-ins — comes along. Skip `node_modules/`; it is re-installed.
- **Backup file.** Staff console → *Backup & restore* → *Download backup*. On the new computer
  start the server, sign in as admin, upload the file under *Restore*. Or on the command line:
  `npm run restore -- path/to/cu-backup.json` (with the server stopped).
- **Keep the data in a synced folder.** Set `DATA_DIR` in `.env` to a folder inside OneDrive,
  Google Drive or a USB drive (e.g. `DATA_DIR=D:\CU-Data`). Run the server on **one** computer
  at a time against that folder.
- **One shared database for everyone (cloud).** Set `DATABASE_URL` to a PostgreSQL database
  (free tiers: Neon, Supabase, Render). All data, attachments and the sign-in secret are then
  kept in that database, so the server can run on any machine or cloud host and every copy
  sees the same data.

## 4. Backups

- **Automatic:** one every 24 hours, newest 14 kept (`BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP`,
  `BACKUP_DIR` in `.env`). Point `BACKUP_DIR` at a cloud-synced folder for off-site copies.
- **From the staff console** (admin): *Backup & restore* — download a backup, save one on the
  server, download older ones, or restore. Before every restore the current data is saved
  as `cu-backup-before-restore-…json`, so a restore can always be undone.
- **From the command line:**
  ```
  npm run backup                       # into data/backups
  npm run backup -- E:\cu-backup.json  # to any path
  npm run restore -- E:\cu-backup.json # server must be stopped
  ```

A backup is a single `.json` file that contains everything, including attachments.
It contains personal data and password hashes, so store it privately.

### Bringing over data from the old single-file version

If people already used the old `index.html`, their data is inside that browser. Open the old
file in the same browser, press **F12 → Console**, paste this and press Enter:

```js
(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([localStorage.getItem('cu_alumni_demo_db_v1')],{type:'application/json'}));a.download='old-browser-data.json';a.click()})()
```

Then restore `old-browser-data.json` in the new staff console (*Backup & restore*). Old
passwords keep working and are upgraded to stronger hashing the next time each person
signs in; attachments are converted to real files.

## 5. Accounts and sign-in

- Passwords are hashed with **scrypt** (random salt per password).
- Sign-in uses a signed, HttpOnly cookie valid for 30 days (`SESSION_DAYS`).
- Changing a password, or an admin resetting it, signs that account out on every other device.
- Suspending a member disconnects them from chat immediately.
- After 10 wrong passwords for the same ID from the same address, sign-in pauses for 15 minutes.
- Forgot the admin password? Stop the server and run
  `npm run reset-password -- cu-admin "a new password of 10+ characters"`.

## 6. Putting it on the internet (optional)

- **Render / Railway / similar:** deploy this folder as a Node web service, start command
  `npm start`, and set `DATABASE_URL` (their disks are wiped on redeploy, so use PostgreSQL),
  `ADMIN_PASSWORD` and `SEED_DEMO_DATA=false`. Use the HTTPS address they give you.
- **Your own server (Docker):** `docker compose up -d --build` — data stays in `./data`.

Use HTTPS for anything public; cookies are automatically marked Secure on HTTPS.
