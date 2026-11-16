"use strict";
// CU Alumni Connect — server.
// Start with:  npm start   (then open http://localhost:3000 or http://<this-computer's-IP>:3000)
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const { Server } = require("socket.io");

const cfg = require("./src/config");
const { createStore } = require("./src/store");
const { Database } = require("./src/db");
const { makeTokens, randomSecret, verifyPassword } = require("./src/auth");
const { createApi } = require("./src/api");

async function main() {
  const store = createStore(cfg);
  const db = new Database(store, cfg);
  const { fresh } = await db.open();

  // The signing secret travels with the data (settings.json in the data folder, or the
  // database), so moving the data to another computer keeps everyone signed in.
  let secret = cfg.SESSION_SECRET || (await store.getKV("session_secret"));
  if (!secret) {
    secret = randomSecret();
    await store.setKV("session_secret", secret);
  }
  const tokens = makeTokens(secret);

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { serveClient: true, maxHttpBufferSize: 1e5 });
  if (cfg.TRUST_PROXY) app.set("trust proxy", true);

  // Events from the API to connected chat clients.
  const events = {
    broadcast: (ev, data) => io.to("members").emit(ev, data),
    toRoom: (room, ev, data) => io.to("room:" + room).emit(ev, data),
    kickMember: (id) => io.in("u:" + id).disconnectSockets(true),
    disconnectAll: () => io.disconnectSockets(true),
  };
  const api = createApi({ db, cfg, tokens, events });

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    res.set("X-Frame-Options", "SAMEORIGIN");
    next();
  });

  // ---- backup downloads (files, not JSON responses) ----
  const needAdmin = (req, res) => {
    const s = api.staffFromCookies(req.headers.cookie);
    if (!s || s.role !== "admin") {
      res.status(s ? 403 : 401).json({ error: "Only staff with the admin role can download backups." });
      return null;
    }
    return s;
  };
  app.get("/api/staff/backup/download", async (req, res) => {
    if (!needAdmin(req, res)) return;
    const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
    res.set("Content-Type", "application/json");
    res.set("Content-Disposition", 'attachment; filename="cu-backup-' + stamp + '.json"');
    res.send(JSON.stringify(await db.exportBackup()));
  });
  app.get("/api/staff/backups/:name", (req, res) => {
    if (!needAdmin(req, res)) return;
    const p = db.backupPath(req.params.name);
    if (!p) return res.status(404).json({ error: "Backup not found." });
    res.download(p, req.params.name);
  });

  // ---- REST API ----
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Math.max(cfg.MAX_UPLOAD_MB, 200) * 1024 * 1024, files: 2 } });
  app.use(
    "/api",
    express.json({ limit: "2mb" }),
    (req, res, next) => (req.is("multipart/form-data") ? upload.any()(req, res, next) : next()),
    (req, res) => api.handle(req, res)
  );
  app.use((err, req, res, next) => {
    if (err && err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "That file is too large." });
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid request." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  // ---- notice attachments ----
  app.get("/files/:id{/:name}", async (req, res) => {
    const meta = db.doc.files.find((f) => f.id === req.params.id);
    const buf = meta && (await store.getFile(meta.id));
    if (!buf) return res.status(404).send("File not found");
    res.set("Content-Type", meta.mime);
    res.set("Content-Disposition", "inline; filename*=UTF-8''" + encodeURIComponent(meta.name));
    res.set("Cache-Control", "private, max-age=86400");
    res.send(Buffer.from(buf));
  });

  // ---- website ----
  app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
  app.get("/health", (req, res) => res.json({ ok: true }));

  // ---- live chat (Socket.IO) ----
  const online = new Map(); // member id -> open connections
  const presence = () => io.to("members").emit("presence", [...online.keys()]);
  io.use((socket, next) => {
    const me = api.memberFromCookies(socket.handshake.headers.cookie);
    if (!me) return next(new Error("unauthorised"));
    socket.data.memberId = me.id;
    next();
  });
  io.on("connection", (socket) => {
    const id = socket.data.memberId;
    const current = () => api.memberFromCookies(socket.handshake.headers.cookie);
    socket.join(["members", "u:" + id]);
    online.set(id, (online.get(id) || 0) + 1);
    presence();

    socket.on("join", (room, ack) => {
      const me = current();
      const reply = typeof ack === "function" ? ack : () => {};
      if (!me || !api.canJoin(me, room)) return reply({ error: "You cannot open this room." });
      for (const r of socket.rooms) if (r.startsWith("room:")) socket.leave(r);
      socket.join("room:" + room);
      reply({ ok: true });
    });
    socket.on("message", (data, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const me = current();
      if (!me) return reply({ error: "Your account is not active." });
      try {
        const row = api.postMessage(me, data && data.room, data && data.body);
        const targets = ["room:" + row.room];
        const dm = /^dm-(\d+)-(\d+)$/.exec(row.room);
        if (dm) targets.push("u:" + dm[1], "u:" + dm[2]);
        io.to(targets).emit("message", row);
        reply({ ok: true });
      } catch (e) {
        reply({ error: e.message });
      }
    });
    socket.on("typing", (room) => {
      const me = current();
      if (me && typeof room === "string" && socket.rooms.has("room:" + room)) socket.to("room:" + room).emit("typing", { room, name: me.name });
    });
    socket.on("disconnect", () => {
      const n = (online.get(id) || 1) - 1;
      if (n <= 0) online.delete(id);
      else online.set(id, n);
      presence();
    });
  });

  db.startAutoBackups();

  // Save everything before the process stops (Ctrl+C, service stop, container stop).
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log("\n" + sig + " received – saving data…");
    try {
      await db.flush();
      await store.close();
    } catch (e) {
      console.error(e);
    }
    process.exit(0);
  };
  ["SIGINT", "SIGTERM", "SIGHUP"].forEach((s) => process.on(s, () => stop(s)));

  server.listen(cfg.PORT, cfg.HOST, () => {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal)
      .map((i) => i.address);
    console.log("");
    console.log("  CU Alumni Connect is running.");
    console.log("  Data is stored in: " + store.describe());
    if (fresh) console.log("  (First start: a new database was created from seed/seed.json)");
    console.log("");
    console.log("  On this computer:      http://localhost:" + cfg.PORT);
    ips.forEach((ip) => console.log("  From other computers:  http://" + ip + ":" + cfg.PORT));
    console.log("  Staff console:         add #staff to the address");
    console.log("");
    const admin = db.doc.staff.find((s) => s.username === "cu-admin");
    if (admin)
      verifyPassword("cu-admin-1857", admin.pass_hash).then((r) => {
        if (r.ok) console.log("  ! The staff account cu-admin still uses the demo password (cu-admin-1857).\n    Sign in to the staff console and change it under “My password”, or set ADMIN_PASSWORD in .env before the first start.\n");
      });
  });
}

main().catch((e) => {
  console.error("Could not start CU Alumni Connect:\n", e.message || e);
  process.exit(1);
});
