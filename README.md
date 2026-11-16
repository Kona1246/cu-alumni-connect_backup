# CU Alumni Connect: Docker edition

The University of Calcutta alumni portal and staff console, packaged so that it runs
on any computer that has Docker. In the original single HTML file, the backend
ran inside the browser and saved data to `localStorage`. This version has a real
server instead:

| Part | What it does |
|---|---|
| **Web front-end** (`public/index.html`) | The original member portal and staff console UI, unchanged apart from removing the in-browser fake backend |
| **API server** (`server/index.js`, Node.js + Express) | All `/api/...` routes: registration and verification, sign-in, notices, feedback, directories, staff console, CSV imports |
| **Real-time chat** (Socket.IO) | Rooms, direct messages, typing indicators, online presence, live notice alerts, moderation |
| **Database** (SQLite, `server/db.js`) | Stores all data in `/data/cu-alumni.sqlite` inside a Docker volume, so it survives restarts and upgrades |
| **File storage** | Notice attachments (PDF, JPG, PNG, DOC, DOCX, up to 10 MB) are stored in `/data/uploads` |

Everything runs in **one container**. No separate database server is needed.

---

## 1. Install Docker (one time)

* **Windows / macOS:** install **Docker Desktop** from https://www.docker.com/products/docker-desktop/ and start it.
* **Linux:** install Docker Engine and the Compose plugin (https://docs.docker.com/engine/install/).

To check that Docker is installed, run `docker compose version` in a terminal.

## 2. Start the site

Open a terminal in this folder (the one that contains `docker-compose.yml`) and run:

```bash
docker compose up -d --build
```

The first build takes a minute or two. Then open **http://localhost:8080**.

| Where | URL | Demo sign-in |
|---|---|---|
| Member portal | http://localhost:8080/#home | Reg. no. `101-1211-0234-15`, password `alumni2015` |
| Staff console | http://localhost:8080/#staff | Staff ID `cu-admin`, password `cu-admin-1857` (admin)<br>Staff ID `cu-editor` (editor) |

To try the registration flow, sign in to the staff console, open **Student records**,
and pick any record that has no member yet. Then register on the member portal with
that name, registration number and year.

## 3. Everyday commands

```bash
docker compose logs -f        # watch the server log
docker compose stop           # stop (data is kept)
docker compose start          # start again
docker compose down           # remove the container (data is kept in the volume)
docker compose up -d --build  # rebuild after changing the code
docker compose down -v        # remove the container AND all data (fresh start)
```

## 4. Settings

To change a setting, copy `.env.example` to `.env`, edit the values, and run
`docker compose up -d` again.

| Setting | Default | Meaning |
|---|---|---|
| `HOST_PORT` | `8080` | Port on your computer, so the site is at `http://localhost:<port>` |
| `SEED_DEMO_DATA` | `true` | `true` loads the sample alumni, members, notices, chat and feedback. `false` starts with only the campuses, departments, faculty, officials and the `cu-admin` account |
| `SHOW_DEMO_LOGINS` | `true` | Shows the sample sign-in details in a bar at the top of every page |
| `ADMIN_PASSWORD` | *(empty)* | Password for `cu-admin` when the database is first created. Empty keeps `cu-admin-1857` |
| `COOKIE_SECURE`, `TRUST_PROXY` | `false` | Set both to `true` when the site is served over HTTPS behind a reverse proxy |
| `MAX_UPLOAD_MB` | `10` | Maximum size of a notice attachment |

The seed settings only apply the **first** time the database is created. To apply
them again, run `docker compose down -v` (this deletes all data) and then
`docker compose up -d`.

### Going live with real data

1. In `.env`, set `SEED_DEMO_DATA=false`, `SHOW_DEMO_LOGINS=false` and a strong `ADMIN_PASSWORD`.
2. Start with a fresh volume by running `docker compose down -v`, then `docker compose up -d --build`.
3. Sign in at `/#staff` and follow the "Setting up the portal" checklist on the dashboard: upload the student-records CSV, departments, faculty and officials, then create editor accounts.
4. Put the site behind HTTPS, for example with Caddy, nginx or Traefik, and set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.

## 5. Backups

All data is in the Docker volume `cu_data`, which holds the database file and the uploads.

```bash
# back up to cu-backup.tgz in the current folder
docker run --rm -v cu-alumni-connect_cu_data:/data -v "$PWD":/backup busybox tar czf /backup/cu-backup.tgz -C /data .
# restore (stop the app first)
docker compose stop
docker run --rm -v cu-alumni-connect_cu_data:/data -v "$PWD":/backup busybox sh -c "rm -rf /data/* && tar xzf /backup/cu-backup.tgz -C /data"
docker compose start
```

The volume name is `<folder name>_cu_data`. To see the exact name, run `docker volume ls`.

## 6. Running without Docker (optional)

If Node.js 22.13 or newer is installed, run `npm install`, then `npm start`. The data is saved in `./data`.

## Notes

* Passwords are hashed with scrypt. The sample accounts' older SHA-256 hashes are still accepted and are upgraded automatically the next time each account signs in.
* Sign-in, registration and verification are rate-limited for each IP address.
* The page loads the Fraunces and Inter fonts from Google Fonts. On a computer with no internet connection, it falls back to system fonts.
