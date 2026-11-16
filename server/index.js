"use strict";
// CU Alumni Connect: HTTP API, real-time chat (Socket.IO) and static front-end.
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { Server } = require("socket.io");
const DB = require("./db");

// ---------- configuration (all optional, see .env.example) ----------
const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));
const CFG = {
  port: Number(process.env.PORT) || 8080,
  dataDir: process.env.DATA_DIR || path.join(__dirname, "..", "data"),
  demoData: bool(process.env.SEED_DEMO_DATA, true),
  demoHints: bool(process.env.SHOW_DEMO_LOGINS, true),
  adminPassword: process.env.ADMIN_PASSWORD || "",
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  sessionDays: Number(process.env.SESSION_DAYS) || 30,
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 10,
};
const UPLOAD_DIR = path.join(CFG.dataDir, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = DB.open({ file: path.join(CFG.dataDir, "cu-alumni.sqlite"), demo: CFG.demoData, adminPassword: CFG.adminPassword });
const { nowStr, hashPw, checkPw, needsRehash } = DB;

// ---------- constants & validation (same rules as the original front-end) ----------
const NOTICE_CATEGORIES = ["Events", "Convocation", "Certificates", "Opportunities", "Circular"];
const FEEDBACK_CATEGORIES = ["Curriculum & syllabus", "Research & laboratories", "Teaching & pedagogy", "Library & infrastructure",
  "Industry linkage & placements", "Digital & online learning", "Examinations & evaluation", "Other"];
const FEEDBACK_STATUSES = ["Received", "Under review", "Forwarded to department", "Implemented", "Not feasible"];
const OFFICIAL_GROUPS = ["Principal Officers", "Syndicate", "Senate", "Deans of Faculty Councils", "Other Officers"];
const REG_NO_PATTERN = /^\d{3}-\d{4}-\d{4}-\d{2}$/;
const REG_NO_EXAMPLE = "123-1111-0456-15";

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ")
  .replace(/\b(dr|prof|mr|mrs|ms|miss|smt|sri|shri|kumari)\b/g, " ").split(/\s+/).filter(Boolean).join(" ");
const sameName = (a, b) => normName(a).split(" ").sort().join(" ") === normName(b).split(" ").sort().join(" ");
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ""));
const isMobile = (s) => /^\+?[\d\s-]{10,16}$/.test(String(s || ""));
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || ""));
function str(v, { max = 500, required = false, label = "Field" } = {}) {
  const s = String(v != null ? v : "").trim();
  if (required && !s) throw bad(`${label} is required.`);
  if (s.length > max) throw bad(`${label} is too long (maximum ${max} characters).`);
  return s;
}
function oneOf(v, list, label) {
  if (!list.includes(v)) throw bad(`${label} must be one of: ${list.join(", ")}.`);
  return v;
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const ieq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const truthy = (v) => v === true || v === "true" || v === "1" || v === 1 || v === "on";

function parseCsv(text) {
  const rows = []; let row = []; let field = ""; let q = false;
  text = String(text).replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter((r) => r.some((x) => x.trim() !== ""));
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return clean.slice(1).map((r, i) => {
    const o = { _line: i + 2 };
    head.forEach((h, j) => { o[h] = (r[j] != null ? r[j] : "").trim(); });
    return o;
  });
}

// ---------- small query helpers ----------
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const contains = (col) => `(? = '' OR instr(lower(${col}), lower(?)) > 0)`;

// ---------- sessions (cookie "cu_sid", rows in the sessions table) ----------
const COOKIE = "cu_sid";
function parseCookies(h) {
  const out = {};
  String(h || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function sessionFromCookie(cookieHeader) {
  const id = parseCookies(cookieHeader)[COOKIE];
  if (!id) return null;
  const s = one("SELECT * FROM sessions WHERE id = ?", id);
  if (!s || s.expires_at < Date.now()) return null;
  return s;
}
const memberCols = "id, reg_no, reg_year, name, subject, college, email, mobile, org, status, created_at";
const loadMember = (id) => (id ? one(`SELECT ${memberCols} FROM members WHERE id = ? AND status = 'active'`, id) || null : null);
const loadStaff = (id) => (id ? one("SELECT id, username, name, role FROM staff WHERE id = ?", id) || null : null);

// ---------- chat helpers ----------
function roomsFor(m) {
  return [
    { key: "general", name: "General Lounge", sub: "All verified alumni" },
    { key: "careers", name: "Careers & Mentoring", sub: "Jobs, referrals and mentoring" },
    { key: `batch-${m.reg_year}`, name: `Batch of ${m.reg_year}`, sub: `Alumni registered in ${m.reg_year}` },
    { key: `dept-${slug(m.subject)}`, name: m.subject, sub: "Department room" },
  ];
}
const dmKey = (a, b) => `dm-${Math.min(a, b)}-${Math.max(a, b)}`;
const dmPair = (room) => { const m = /^dm-(\d+)-(\d+)$/.exec(String(room)); return m ? [Number(m[1]), Number(m[2])] : null; };
function canJoin(m, room) {
  if (typeof room !== "string") return false;
  if (roomsFor(m).some((r) => r.key === room)) return true;
  const dm = dmPair(room);
  if (!dm) return false;
  const [a, b] = dm;
  if (a === b || (a !== m.id && b !== m.id)) return false;
  return !!loadMember(a === m.id ? b : a);
}
const MSG_SELECT = `SELECT x.id, x.room, x.body, x.created_at, x.member_id, m.name, m.reg_year
  FROM messages x JOIN members m ON m.id = x.member_id`;
const roomTargets = (room) => { const dm = dmPair(room); return dm ? [room, `member:${dm[0]}`, `member:${dm[1]}`] : [room]; };

// ---------- routing with one SQLite transaction per request ----------
const app = express();
app.disable("x-powered-by");
if (CFG.trustProxy) app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "SAMEORIGIN" });
  next();
});
const api = express.Router();
api.use(express.json({ limit: "1mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CFG.maxUploadMb * 1024 * 1024, files: 2 } });

let io; // set below
const limits = new Map();
function rateLimit(req, key, max, windowMs) {
  const k = `${key}:${req.ip}`;
  const now = Date.now();
  const e = limits.get(k);
  if (!e || now - e.t > windowMs) { limits.set(k, { t: now, n: 1 }); return; }
  if (++e.n > max) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.");
}
setInterval(() => { const now = Date.now(); for (const [k, e] of limits) if (now - e.t > 3600e3) limits.delete(k); }, 600e3).unref();

function route(method, p, fn, { multipart = false } = {}) {
  const handlers = [];
  if (multipart) handlers.push(upload.any());
  handlers.push((req, res) => {
    const ctx = {
      req, res, params: req.params, query: req.query || {}, body: req.body || {}, files: {},
      events: [], newFiles: [], oldFiles: [],
      sess: sessionFromCookie(req.headers.cookie),
    };
    for (const f of req.files || []) if (f.size) ctx.files[f.fieldname] = f;
    for (const k of Object.keys(ctx.query)) if (typeof ctx.query[k] !== "string") ctx.query[k] = "";
    let status = 200, out;
    db.exec("BEGIN IMMEDIATE");
    try {
      out = fn(ctx);
      if (Array.isArray(out) && out.length === 2 && typeof out[0] === "number") [status, out] = out;
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      ctx.newFiles.forEach((f) => fs.rm(f, { force: true }, () => {}));
      if (!(e instanceof HttpError)) console.error(e);
      return res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong. Please try again." });
    }
    ctx.oldFiles.forEach((f) => fs.rm(f, { force: true }, () => {}));
    ctx.events.forEach(([fnName, args]) => fnName(...args));
    res.status(status).json(out);
  });
  api[method.toLowerCase()](p, ...handlers);
}

function setSession(ctx, patch) {
  let s = ctx.sess;
  if (!s) {
    const id = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    s = { id, member_id: null, staff_id: null, created_at: now, expires_at: now + CFG.sessionDays * 864e5 };
    run("INSERT INTO sessions (id, member_id, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", s.id, null, null, s.created_at, s.expires_at);
    ctx.res.cookie(COOKIE, id, { httpOnly: true, sameSite: "lax", secure: CFG.cookieSecure, path: "/", maxAge: CFG.sessionDays * 864e5 });
    ctx.sess = s;
  }
  Object.assign(s, patch);
  run("UPDATE sessions SET member_id = ?, staff_id = ? WHERE id = ?", s.member_id, s.staff_id, s.id);
}
const curMember = (ctx) => loadMember(ctx.sess && ctx.sess.member_id);
const curStaff = (ctx) => loadStaff(ctx.sess && ctx.sess.staff_id);
const needMember = (ctx) => { const m = curMember(ctx); if (!m) throw new HttpError(401, "Please sign in as a registered member."); return m; };
const needStaff = (ctx) => { const s = curStaff(ctx); if (!s) throw new HttpError(401, "Please sign in to the University staff console."); return s; };
const needAdmin = (ctx) => { const s = needStaff(ctx); if (s.role !== "admin") throw new HttpError(403, "Only staff with the admin role can do this."); return s; };
const emit = (ctx, fn, ...args) => ctx.events.push([fn, args]);
const broadcast = (ev, data) => io.emit(ev, data);

// ---------- public & member routes ----------
route("GET", "/health", () => ({ ok: true, time: nowStr() }));
route("GET", "/config", () => ({ regNoExample: REG_NO_EXAMPLE }));

function checkRecord({ name, reg_no, reg_year }) {
  name = str(name, { max: 120, required: true, label: "Full name" });
  reg_no = str(reg_no, { max: 40, required: true, label: "Registration number" });
  const year = Number(reg_year);
  if (normName(name).split(" ").length < 2) throw bad("Please enter your full name (first name and surname) as in University records.");
  if (!REG_NO_PATTERN.test(reg_no)) throw bad(`Registration number should look like ${REG_NO_EXAMPLE}.`);
  if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear()) throw bad("Please select a valid year of registration.");
  const rec = one("SELECT * FROM registry WHERE reg_no = ?", reg_no);
  if (!rec) throw new HttpError(404, "This registration number was not found in University records. If you believe this is a mistake, contact the Alumni Cell for manual verification.");
  if (rec.reg_year !== year) throw bad("The year of registration does not match University records for this number.");
  if (!sameName(rec.name, name)) throw bad("The name does not match the name on record for this registration number. Use your name exactly as on your registration certificate.");
  if (one("SELECT 1 FROM members WHERE reg_no = ?", reg_no)) throw new HttpError(409, "This registration number is already linked to a member account. Please sign in instead.");
  return rec;
}
route("POST", "/register/verify", ({ req, body }) => {
  rateLimit(req, "verify", 40, 10 * 60e3);
  const r = checkRecord(body);
  return { ok: true, name: r.name, reg_year: r.reg_year, subject: r.subject, college: r.college };
});
route("POST", "/register", (ctx) => {
  const { body } = ctx;
  rateLimit(ctx.req, "register", 20, 10 * 60e3);
  const rec = checkRecord(body);
  const email = str(body.email, { max: 160, required: true, label: "Email" });
  const mobile = str(body.mobile, { max: 20, label: "Mobile" });
  const org = str(body.org, { max: 160, label: "City / organisation" });
  const password = String(body.password || "");
  if (!isEmail(email)) throw bad("Please enter a valid email address.");
  if (mobile && !isMobile(mobile)) throw bad("Please enter a valid mobile number, or leave it blank.");
  if (password.length < 8) throw bad("Password must be at least 8 characters.");
  if (!body.agree) throw bad("Please confirm the declaration.");
  if (one("SELECT 1 FROM members WHERE email = ? COLLATE NOCASE", email)) throw new HttpError(409, "That email is already registered.");
  const r = run(`INSERT INTO members (reg_no, reg_year, name, subject, college, email, mobile, org, pass_hash, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`, rec.reg_no, rec.reg_year, rec.name, rec.subject, rec.college, email, mobile, org, hashPw(password), nowStr());
  const id = Number(r.lastInsertRowid);
  setSession(ctx, { member_id: id });
  emit(ctx, broadcast, "member:joined", { name: rec.name, reg_year: rec.reg_year });
  return [201, { member: loadMember(id) }];
});
route("POST", "/login", (ctx) => {
  rateLimit(ctx.req, "login", 20, 10 * 60e3);
  const id = str(ctx.body.id, { max: 160, required: true, label: "Registration number or email" });
  const m = one("SELECT * FROM members WHERE reg_no = ? OR email = ? COLLATE NOCASE", id, id);
  const pw = String(ctx.body.password || "");
  if (!m || !checkPw(pw, m.pass_hash)) throw new HttpError(401, "Registration number/email or password is incorrect.");
  if (m.status !== "active") throw new HttpError(403, "This account has been suspended. Please contact the Alumni Cell.");
  if (needsRehash(m.pass_hash)) run("UPDATE members SET pass_hash = ? WHERE id = ?", hashPw(pw), m.id);
  setSession(ctx, { member_id: m.id });
  return { member: loadMember(m.id) };
});
route("POST", "/logout", (ctx) => { if (ctx.sess) setSession(ctx, { member_id: null }); return { ok: true }; });
route("GET", "/me", (ctx) => ({ member: curMember(ctx) }));
route("PATCH", "/me", (ctx) => {
  const { body } = ctx;
  const me = needMember(ctx);
  const mobile = str(body.mobile, { max: 20, label: "Mobile" });
  const org = str(body.org, { max: 160, label: "City / organisation" });
  if (mobile && !isMobile(mobile)) throw bad("Please enter a valid mobile number.");
  if (body.new_password) {
    const row = one("SELECT pass_hash FROM members WHERE id = ?", me.id);
    if (!checkPw(String(body.current_password || ""), row.pass_hash)) throw bad("Current password is incorrect.");
    if (String(body.new_password).length < 8) throw bad("New password must be at least 8 characters.");
    run("UPDATE members SET pass_hash = ? WHERE id = ?", hashPw(String(body.new_password)), me.id);
  }
  run("UPDATE members SET mobile = ?, org = ? WHERE id = ?", mobile, org, me.id);
  return { member: loadMember(me.id) };
});
route("GET", "/members", (ctx) => {
  needMember(ctx);
  return all("SELECT id, name, reg_year, subject, college, org FROM members WHERE status = 'active' ORDER BY name COLLATE NOCASE");
});
route("GET", "/chat/rooms", (ctx) => {
  const me = needMember(ctx);
  const keys = all("SELECT DISTINCT room FROM messages WHERE room LIKE ? OR room LIKE ?", `dm-${me.id}-%`, `dm-%-${me.id}`).map((r) => r.room);
  const dms = keys.map((key) => {
    const pair = dmPair(key);
    if (!pair) return null;
    const [a, b] = pair;
    const o = one("SELECT id, name, reg_year, subject FROM members WHERE id = ?", a === me.id ? b : a);
    return o && { key, other: o };
  }).filter(Boolean);
  return { rooms: roomsFor(me), dms };
});
route("GET", "/chat/history", (ctx) => {
  const me = needMember(ctx);
  const room = String(ctx.query.room || "");
  if (!canJoin(me, room)) throw new HttpError(403, "You cannot open this room.");
  const before = Number(ctx.query.before) || 1e15;
  return all(`${MSG_SELECT} WHERE x.room = ? AND x.id < ? ORDER BY x.id DESC LIMIT 60`, room, before).reverse();
});
route("GET", "/chat/dm/:otherId", (ctx) => {
  const me = needMember(ctx);
  const key = dmKey(me.id, Number(ctx.params.otherId));
  if (!canJoin(me, key)) throw bad("That member is not available for messaging.");
  return { key };
});
route("GET", "/notices", ({ query }) => {
  const q = String(query.q || "").trim();
  const cat = String(query.category || "");
  const notices = all(`SELECT id, title, category, body, link, attachment, attachment_name, pinned, created_at FROM notices
    WHERE (${contains("title")} OR ${contains("body")}) AND (? = '' OR category = ?)
    ORDER BY pinned DESC, created_at DESC, id DESC LIMIT 200`, q, q, q, q, cat, cat);
  return { categories: NOTICE_CATEGORIES, notices };
});
route("GET", "/feedback", (ctx) => {
  const me = needMember(ctx);
  const mine = ctx.query.view === "mine";
  const feedback = all(`SELECT f.id, f.category, f.department, f.title, f.body, f.shared, f.status, f.reply, f.replied_at, f.created_at,
      f.member_id, m.name AS member_name, m.reg_year,
      (SELECT COUNT(*) FROM support s WHERE s.feedback_id = f.id) AS supporters,
      EXISTS (SELECT 1 FROM support s WHERE s.feedback_id = f.id AND s.member_id = ?) AS supported
    FROM feedback f JOIN members m ON m.id = f.member_id
    WHERE ${mine ? "f.member_id = ?" : "f.shared = 1 AND ? IS NOT NULL"}
    ORDER BY ${mine ? "f.id DESC" : "supporters DESC, f.id DESC LIMIT 300"}`, me.id, me.id);
  return { categories: FEEDBACK_CATEGORIES, feedback };
});
route("POST", "/feedback", (ctx) => {
  const { body } = ctx;
  const me = needMember(ctx);
  const category = oneOf(body.category, FEEDBACK_CATEGORIES, "Area");
  const department = str(body.department, { max: 160, required: true, label: "Department" });
  const title = str(body.title, { max: 160, required: true, label: "Title" });
  const text = str(body.body, { max: 5000, required: true, label: "Feedback" });
  if (title.length < 8) throw bad("Please give your suggestion a short descriptive title.");
  if (text.length < 30) throw bad("Please describe your suggestion in a little more detail (at least 30 characters).");
  const r = run(`INSERT INTO feedback (member_id, category, department, title, body, shared, status, reply, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Received', '', ?)`, me.id, category, department, title, text, body.shared ? 1 : 0, nowStr());
  return [201, { id: Number(r.lastInsertRowid) }];
});
route("POST", "/feedback/:id/support", (ctx) => {
  const me = needMember(ctx);
  const f = one("SELECT id, shared FROM feedback WHERE id = ?", Number(ctx.params.id));
  if (!f || !f.shared) throw new HttpError(404, "Suggestion not found.");
  const had = one("SELECT 1 FROM support WHERE feedback_id = ? AND member_id = ?", f.id, me.id);
  if (had) run("DELETE FROM support WHERE feedback_id = ? AND member_id = ?", f.id, me.id);
  else run("INSERT INTO support (feedback_id, member_id) VALUES (?, ?)", f.id, me.id);
  return { supported: !had };
});
route("GET", "/directory/officials", () => ({ groups: OFFICIAL_GROUPS, officials: all("SELECT * FROM officials ORDER BY sort, id") }));
route("GET", "/directory/departments", () => {
  const faculty = all("SELECT * FROM faculty ORDER BY id");
  const byDept = new Map();
  faculty.forEach((f) => { if (!byDept.has(f.department_id)) byDept.set(f.department_id, []); byDept.get(f.department_id).push(f); });
  return {
    campuses: all("SELECT * FROM campuses ORDER BY id"),
    departments: all("SELECT * FROM departments ORDER BY lower(name)").map((d) => ({ ...d, faculty: byDept.get(d.id) || [] })),
  };
});

// ---------- staff console ----------
route("POST", "/staff/login", (ctx) => {
  rateLimit(ctx.req, "staff-login", 15, 10 * 60e3);
  const s = one("SELECT * FROM staff WHERE username = ? COLLATE NOCASE", String(ctx.body.username || "").trim());
  const pw = String(ctx.body.password || "");
  if (!s || !checkPw(pw, s.pass_hash)) throw new HttpError(401, "Staff ID or password is incorrect.");
  if (needsRehash(s.pass_hash)) run("UPDATE staff SET pass_hash = ? WHERE id = ?", hashPw(pw), s.id);
  setSession(ctx, { staff_id: s.id });
  return { staff: loadStaff(s.id) };
});
route("POST", "/staff/logout", (ctx) => { if (ctx.sess) setSession(ctx, { staff_id: null }); return { ok: true }; });
route("GET", "/staff/me", (ctx) => ({ staff: curStaff(ctx) }));
route("POST", "/staff/password", (ctx) => {
  const st = needStaff(ctx);
  const row = one("SELECT pass_hash FROM staff WHERE id = ?", st.id);
  if (!checkPw(String(ctx.body.current || ""), row.pass_hash)) throw bad("Current password is incorrect.");
  if (String(ctx.body.next || "").length < 10) throw bad("New password must be at least 10 characters.");
  run("UPDATE staff SET pass_hash = ? WHERE id = ?", hashPw(String(ctx.body.next)), st.id);
  return { ok: true };
});
route("GET", "/staff/stats", (ctx) => {
  needStaff(ctx);
  const n = (sql) => one(sql).n;
  return {
    registry: n("SELECT COUNT(*) n FROM registry"),
    members: n("SELECT COUNT(*) n FROM members WHERE status = 'active'"),
    suspended: n("SELECT COUNT(*) n FROM members WHERE status = 'suspended'"),
    notices: n("SELECT COUNT(*) n FROM notices"),
    feedbackOpen: n("SELECT COUNT(*) n FROM feedback WHERE status IN ('Received', 'Under review')"),
    feedback: n("SELECT COUNT(*) n FROM feedback"),
    messages: n("SELECT COUNT(*) n FROM messages"),
    departments: n("SELECT COUNT(*) n FROM departments"),
    faculty: n("SELECT COUNT(*) n FROM faculty"),
    officials: n("SELECT COUNT(*) n FROM officials"),
  };
});

function noticeInput(b) {
  const link = str(b.link, { max: 500, label: "Link" });
  if (link && !isUrl(link)) throw bad("Link must start with http:// or https://");
  return {
    title: str(b.title, { max: 200, required: true, label: "Title" }),
    category: oneOf(b.category, NOTICE_CATEGORIES, "Category"),
    body: str(b.body, { max: 5000, required: true, label: "Details" }),
    link,
    pinned: truthy(b.pinned) ? 1 : 0,
  };
}
function saveAttachment(ctx, file) {
  if (!file) return null;
  if (!/\.(pdf|jpe?g|png|docx?)$/i.test(file.originalname)) throw bad("Attachment must be PDF, JPG, PNG, DOC or DOCX.");
  const safe = path.basename(file.originalname).replace(/[^\w.\-]+/g, "_").slice(-80);
  const name = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${safe}`;
  const full = path.join(UPLOAD_DIR, name);
  fs.writeFileSync(full, file.buffer);
  ctx.newFiles.push(full);
  return { url: `/uploads/${name}`, name: file.originalname };
}
const uploadPath = (url) => (url && url.startsWith("/uploads/") ? path.join(UPLOAD_DIR, path.basename(url)) : null);

route("POST", "/staff/notices", (ctx) => {
  const st = needStaff(ctx);
  const n = noticeInput(ctx.body);
  const att = saveAttachment(ctx, ctx.files.attachment);
  const r = run(`INSERT INTO notices (title, category, body, link, attachment, attachment_name, pinned, posted_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, n.title, n.category, n.body, n.link, att ? att.url : "", att ? att.name : "", n.pinned, st.id, nowStr());
  const id = Number(r.lastInsertRowid);
  emit(ctx, broadcast, "notice:new", { id, title: n.title });
  return [201, { id }];
}, { multipart: true });
route("PUT", "/staff/notices/:id", (ctx) => {
  needStaff(ctx);
  const old = one("SELECT * FROM notices WHERE id = ?", Number(ctx.params.id));
  if (!old) throw new HttpError(404, "Notice not found.");
  const n = noticeInput(ctx.body);
  const att = saveAttachment(ctx, ctx.files.attachment);
  let attachment = old.attachment, attachment_name = old.attachment_name;
  if (att) { attachment = att.url; attachment_name = att.name; }
  else if (ctx.body.remove_attachment === "true") { attachment = ""; attachment_name = ""; }
  if (attachment !== old.attachment && uploadPath(old.attachment)) ctx.oldFiles.push(uploadPath(old.attachment));
  run("UPDATE notices SET title = ?, category = ?, body = ?, link = ?, pinned = ?, attachment = ?, attachment_name = ? WHERE id = ?",
    n.title, n.category, n.body, n.link, n.pinned, attachment, attachment_name, old.id);
  return { ok: true };
}, { multipart: true });
route("DELETE", "/staff/notices/:id", (ctx) => {
  needStaff(ctx);
  const old = one("SELECT * FROM notices WHERE id = ?", Number(ctx.params.id));
  if (!old) throw new HttpError(404, "Notice not found.");
  run("DELETE FROM notices WHERE id = ?", old.id);
  if (uploadPath(old.attachment)) ctx.oldFiles.push(uploadPath(old.attachment));
  return { ok: true };
});

route("GET", "/staff/feedback", (ctx) => {
  needStaff(ctx);
  const status = String(ctx.query.status || "");
  const feedback = all(`SELECT f.*, m.name AS member_name, m.reg_year, m.email AS member_email,
      (SELECT COUNT(*) FROM support s WHERE s.feedback_id = f.id) AS supporters, st.name AS replied_by_name
    FROM feedback f JOIN members m ON m.id = f.member_id LEFT JOIN staff st ON st.id = f.replied_by
    WHERE (? = '' OR f.status = ?) ORDER BY f.id DESC`, status, status);
  return { statuses: FEEDBACK_STATUSES, feedback };
});
route("PATCH", "/staff/feedback/:id", (ctx) => {
  const st = needStaff(ctx);
  const status = oneOf(ctx.body.status, FEEDBACK_STATUSES, "Status");
  const reply = str(ctx.body.reply, { max: 3000, label: "Response" });
  const r = run("UPDATE feedback SET status = ?, reply = ?, replied_by = ?, replied_at = ? WHERE id = ?", status, reply, st.id, nowStr(), Number(ctx.params.id));
  if (!r.changes) throw new HttpError(404, "Feedback not found.");
  return { ok: true };
});

function officialInput(b) {
  const o = {
    grp: oneOf(b.grp, OFFICIAL_GROUPS, "Group"),
    designation: str(b.designation, { max: 200, required: true, label: "Designation" }),
    name: str(b.name, { max: 160, required: true, label: "Name" }),
    email: str(b.email, { max: 160, label: "Email" }),
    mobile: str(b.mobile, { max: 20, label: "Mobile" }),
    office: str(b.office, { max: 300, label: "Office" }),
    sort: Number(b.sort) || 100,
  };
  if (o.email && !isEmail(o.email)) throw bad(`Invalid email: ${o.email}`);
  if (o.mobile && !isMobile(o.mobile)) throw bad(`Invalid mobile number: ${o.mobile}`);
  return o;
}
const insOfficial = (o) => run("INSERT INTO officials (grp, designation, name, email, mobile, office, sort) VALUES (?, ?, ?, ?, ?, ?, ?)",
  o.grp, o.designation, o.name, o.email, o.mobile, o.office, o.sort);
route("POST", "/staff/officials", (ctx) => { needStaff(ctx); insOfficial(officialInput(ctx.body)); return [201, { ok: true }]; });
route("PUT", "/staff/officials/:id", (ctx) => {
  needStaff(ctx);
  const o = officialInput(ctx.body);
  const r = run("UPDATE officials SET grp = ?, designation = ?, name = ?, email = ?, mobile = ?, office = ?, sort = ? WHERE id = ?",
    o.grp, o.designation, o.name, o.email, o.mobile, o.office, o.sort, Number(ctx.params.id));
  if (!r.changes) throw new HttpError(404, "Not found.");
  return { ok: true };
});
route("DELETE", "/staff/officials/:id", (ctx) => { needStaff(ctx); run("DELETE FROM officials WHERE id = ?", Number(ctx.params.id)); return { ok: true }; });

function csvRows(files) {
  if (!files.file) throw bad("Please choose a CSV file to upload.");
  const rows = parseCsv(files.file.buffer.toString("utf8"));
  if (!rows.length) throw bad("The CSV file has no data rows.");
  return rows;
}
function eachRow(rows, fn) {
  const errors = []; let added = 0;
  rows.forEach((r) => { try { fn(r); added++; } catch (e) { if (!(e instanceof HttpError)) throw e; errors.push(`Line ${r._line}: ${e.message}`); } });
  return { added, errors };
}
route("POST", "/staff/officials/import", (ctx) => {
  needStaff(ctx);
  const rows = csvRows(ctx.files);
  if (ctx.body.mode === "replace") run("DELETE FROM officials");
  return eachRow(rows, (r) => insOfficial(officialInput({ grp: r.group, designation: r.designation, name: r.name, email: r.email, mobile: r.mobile, office: r.office, sort: r.sort })));
}, { multipart: true });

route("POST", "/staff/campuses", (ctx) => {
  needStaff(ctx);
  const name = str(ctx.body.name, { max: 160, required: true, label: "Campus name" });
  const address = str(ctx.body.address, { max: 300, required: true, label: "Address" });
  if (one("SELECT 1 FROM campuses WHERE name = ?", name)) throw bad("A campus with that name already exists.");
  run("INSERT INTO campuses (name, address) VALUES (?, ?)", name, address);
  return [201, { ok: true }];
});
route("PUT", "/staff/campuses/:id", (ctx) => {
  needStaff(ctx);
  const name = str(ctx.body.name, { max: 160, required: true, label: "Campus name" });
  const address = str(ctx.body.address, { max: 300, required: true, label: "Address" });
  const id = Number(ctx.params.id);
  if (one("SELECT 1 FROM campuses WHERE name = ? AND id <> ?", name, id)) throw bad("A campus with that name already exists.");
  run("UPDATE campuses SET name = ?, address = ? WHERE id = ?", name, address, id);
  return { ok: true };
});
function campusId(v) {
  if (!v) return null;
  const c = one("SELECT id FROM campuses WHERE id = ? OR lower(name) = lower(?)", Number(v) || -1, String(v));
  if (!c) throw bad(`Unknown campus "${v}". Add it under Campuses first.`);
  return c.id;
}
function deptInput(b) {
  const d = {
    name: str(b.name, { max: 200, required: true, label: "Department name" }),
    type: oneOf(b.type || "Department", ["Department", "Centre"], "Type"),
    council: str(b.council, { max: 200, label: "Faculty council" }),
    campus_id: campusId(b.campus_id || b.campus),
    email: str(b.email, { max: 160, label: "Email" }),
    phone: str(b.phone, { max: 40, label: "Phone" }),
  };
  if (d.email && !isEmail(d.email)) throw bad(`Invalid email: ${d.email}`);
  return d;
}
function upsertDept(d) {
  const ex = one("SELECT id FROM departments WHERE name = ? COLLATE NOCASE", d.name);
  if (ex) {
    run("UPDATE departments SET type = ?, council = ?, campus_id = ?, email = ?, phone = ? WHERE id = ?", d.type, d.council, d.campus_id, d.email, d.phone, ex.id);
    return ex.id;
  }
  return Number(run("INSERT INTO departments (name, type, council, campus_id, email, phone) VALUES (?, ?, ?, ?, ?, ?)",
    d.name, d.type, d.council, d.campus_id, d.email, d.phone).lastInsertRowid);
}
route("POST", "/staff/departments", (ctx) => {
  needStaff(ctx);
  const d = deptInput(ctx.body);
  if (one("SELECT 1 FROM departments WHERE name = ? COLLATE NOCASE", d.name)) throw bad("A department with that name already exists.");
  return [201, { id: upsertDept(d) }];
});
route("PUT", "/staff/departments/:id", (ctx) => {
  needStaff(ctx);
  const d = deptInput(ctx.body);
  const id = Number(ctx.params.id);
  if (one("SELECT 1 FROM departments WHERE name = ? COLLATE NOCASE AND id <> ?", d.name, id)) throw bad("Another department already has that name.");
  run("UPDATE departments SET name = ?, type = ?, council = ?, campus_id = ?, email = ?, phone = ? WHERE id = ?", d.name, d.type, d.council, d.campus_id, d.email, d.phone, id);
  return { ok: true };
});
route("DELETE", "/staff/departments/:id", (ctx) => {
  needStaff(ctx);
  const id = Number(ctx.params.id);
  run("DELETE FROM faculty WHERE department_id = ?", id);
  run("DELETE FROM departments WHERE id = ?", id);
  return { ok: true };
});
route("POST", "/staff/departments/import", (ctx) => {
  needStaff(ctx);
  const rows = csvRows(ctx.files);
  return eachRow(rows, (r) => upsertDept(deptInput({ name: r.name, type: r.type, council: r.faculty_council, campus: r.campus, email: r.email, phone: r.phone })));
}, { multipart: true });

function facultyInput(b) {
  const f = {
    name: str(b.name, { max: 160, required: true, label: "Name" }),
    designation: str(b.designation, { max: 120, required: true, label: "Designation" }),
    specialization: str(b.specialization, { max: 300, required: true, label: "Specialisation" }),
    email: str(b.email, { max: 160, label: "Email" }),
    phone: str(b.phone, { max: 40, label: "Phone" }),
    room: str(b.room, { max: 200, label: "Room / office" }),
  };
  if (f.email && !isEmail(f.email)) throw bad(`Invalid email: ${f.email}`);
  return f;
}
const insFaculty = (deptId, f) => run("INSERT INTO faculty (department_id, name, designation, specialization, email, phone, room) VALUES (?, ?, ?, ?, ?, ?, ?)",
  deptId, f.name, f.designation, f.specialization, f.email, f.phone, f.room);
route("POST", "/staff/departments/:id/faculty", (ctx) => {
  needStaff(ctx);
  const id = Number(ctx.params.id);
  if (!one("SELECT 1 FROM departments WHERE id = ?", id)) throw new HttpError(404, "Department not found.");
  insFaculty(id, facultyInput(ctx.body));
  return [201, { ok: true }];
});
route("PUT", "/staff/faculty/:id", (ctx) => {
  needStaff(ctx);
  const f = facultyInput(ctx.body);
  run("UPDATE faculty SET name = ?, designation = ?, specialization = ?, email = ?, phone = ?, room = ? WHERE id = ?",
    f.name, f.designation, f.specialization, f.email, f.phone, f.room, Number(ctx.params.id));
  return { ok: true };
});
route("DELETE", "/staff/faculty/:id", (ctx) => { needStaff(ctx); run("DELETE FROM faculty WHERE id = ?", Number(ctx.params.id)); return { ok: true }; });
route("POST", "/staff/faculty/import", (ctx) => {
  needStaff(ctx);
  const rows = csvRows(ctx.files);
  const replace = ctx.body.mode === "replace";
  const cleared = new Set();
  return eachRow(rows, (r) => {
    const d = one("SELECT id FROM departments WHERE name = ? COLLATE NOCASE", r.department || "");
    if (!d) throw bad(`Unknown department "${r.department}". Add the department first.`);
    const f = facultyInput(r);
    if (replace && !cleared.has(d.id)) { run("DELETE FROM faculty WHERE department_id = ?", d.id); cleared.add(d.id); }
    insFaculty(d.id, f);
  });
}, { multipart: true });

route("GET", "/staff/messages", (ctx) => {
  needStaff(ctx);
  const q = String(ctx.query.q || "").trim();
  return all(`${MSG_SELECT} WHERE ${contains("x.body")} OR ${contains("m.name")} ORDER BY x.id DESC LIMIT 200`, q, q, q, q);
});
route("DELETE", "/staff/messages/:id", (ctx) => {
  needStaff(ctx);
  const id = Number(ctx.params.id);
  const m = one("SELECT id, room FROM messages WHERE id = ?", id);
  if (m) {
    run("DELETE FROM messages WHERE id = ?", id);
    emit(ctx, (room, data) => io.to(roomTargets(room)).emit("message:deleted", data), m.room, { id, room: m.room });
  }
  return { ok: true };
});

function registryInput(r) {
  const rec = {
    reg_no: str(r.reg_no || r.registration_no || r.registration_number, { max: 40, required: true, label: "Registration number" }),
    reg_year: Number(r.reg_year || r.year || r.year_of_registration),
    name: str(r.name, { max: 160, required: true, label: "Name" }),
    subject: str(r.subject || r.department, { max: 160, required: true, label: "Subject / department" }),
    college: str(r.college, { max: 200, label: "College" }),
  };
  if (!REG_NO_PATTERN.test(rec.reg_no)) throw bad(`Registration number "${rec.reg_no}" does not match the expected format (${REG_NO_EXAMPLE}).`);
  if (!Number.isInteger(rec.reg_year) || rec.reg_year < 1900 || rec.reg_year > new Date().getFullYear()) throw bad("Invalid year of registration.");
  return rec;
}
const upsertRec = (r) => run(`INSERT INTO registry (reg_no, reg_year, name, subject, college, added_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(reg_no) DO UPDATE SET reg_year = excluded.reg_year, name = excluded.name, subject = excluded.subject, college = excluded.college`,
  r.reg_no, r.reg_year, r.name, r.subject, r.college, nowStr());
route("GET", "/staff/registry", (ctx) => {
  needAdmin(ctx);
  const q = String(ctx.query.q || "").trim();
  const rows = all(`SELECT r.*, (SELECT m.id FROM members m WHERE m.reg_no = r.reg_no) AS member_id FROM registry r
    WHERE ${contains("r.reg_no")} OR ${contains("r.name")} ORDER BY r.added_at DESC, r.reg_no LIMIT 100`, q, q, q, q);
  return { total: one("SELECT COUNT(*) n FROM registry").n, rows };
});
route("POST", "/staff/registry", (ctx) => { needAdmin(ctx); upsertRec(registryInput(ctx.body)); return [201, { ok: true }]; });
route("DELETE", "/staff/registry/:regNo", (ctx) => {
  needAdmin(ctx);
  const reg = String(ctx.params.regNo);
  if (one("SELECT 1 FROM members WHERE reg_no = ?", reg)) throw bad("This record belongs to a registered member. Remove or suspend the member first.");
  run("DELETE FROM registry WHERE reg_no = ?", reg);
  return { ok: true };
});
route("POST", "/staff/registry/import", (ctx) => {
  needAdmin(ctx);
  const r = eachRow(csvRows(ctx.files), (row) => upsertRec(registryInput(row)));
  return { added: r.added, errors: r.errors.slice(0, 200), errorCount: r.errors.length };
}, { multipart: true });

route("GET", "/staff/members", (ctx) => {
  needAdmin(ctx);
  const q = String(ctx.query.q || "").trim();
  return all(`SELECT ${memberCols} FROM members WHERE ${contains("name")} OR ${contains("reg_no")} OR ${contains("email")} ORDER BY id DESC LIMIT 200`, q, q, q, q, q, q);
});
route("PATCH", "/staff/members/:id", (ctx) => {
  needAdmin(ctx);
  const status = oneOf(ctx.body.status, ["active", "suspended"], "Status");
  const id = Number(ctx.params.id);
  run("UPDATE members SET status = ? WHERE id = ?", status, id);
  if (status === "suspended") {
    run("UPDATE sessions SET member_id = NULL WHERE member_id = ?", id);
    emit(ctx, () => io.in(`member:${id}`).disconnectSockets(true));
  }
  return { ok: true };
});
route("POST", "/staff/members/:id/reset-password", (ctx) => {
  needAdmin(ctx);
  const m = one("SELECT id FROM members WHERE id = ?", Number(ctx.params.id));
  if (!m) throw new HttpError(404, "Member not found.");
  const temp = crypto.randomBytes(5).toString("hex");
  run("UPDATE members SET pass_hash = ? WHERE id = ?", hashPw(temp), m.id);
  return { temporaryPassword: temp };
});
route("GET", "/staff/accounts", (ctx) => { needAdmin(ctx); return all("SELECT id, username, name, role, created_at FROM staff ORDER BY id"); });
route("POST", "/staff/accounts", (ctx) => {
  needAdmin(ctx);
  const username = str(ctx.body.username, { max: 60, required: true, label: "Staff ID" });
  const name = str(ctx.body.name, { max: 120, required: true, label: "Name" });
  const role = oneOf(ctx.body.role, ["admin", "editor"], "Role");
  if (String(ctx.body.password || "").length < 10) throw bad("Password must be at least 10 characters.");
  if (one("SELECT 1 FROM staff WHERE username = ? COLLATE NOCASE", username)) throw bad("That staff ID is taken.");
  run("INSERT INTO staff (username, name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)", username, name, role, hashPw(String(ctx.body.password)), nowStr());
  return [201, { ok: true }];
});
route("DELETE", "/staff/accounts/:id", (ctx) => {
  const st = needAdmin(ctx);
  const id = Number(ctx.params.id);
  if (id === st.id) throw bad("You cannot delete your own account.");
  run("DELETE FROM staff WHERE id = ?", id);
  run("UPDATE sessions SET staff_id = NULL WHERE staff_id = ?", id);
  return { ok: true };
});

api.use((req, res) => res.status(404).json({ error: "Not found." }));
api.use((err, req, res, next) => { // body-parser / multer errors
  if (err && err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: `Attachment is too large (maximum ${CFG.maxUploadMb} MB).` });
  if (err && (err.type === "entity.parse.failed" || err.name === "MulterError")) return res.status(400).json({ error: "The request could not be read." });
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "The request is too large." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});
app.use("/api", api);

// ---------- static front-end ----------
const PUBLIC = path.join(__dirname, "..", "public");
const indexHtml = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8")
  .replace("/*__CU_ENV__*/", `window.CU_ENV = ${JSON.stringify({ demoHints: CFG.demoHints })};`);
const sendIndex = (req, res) => res.type("html").set("Cache-Control", "no-cache").send(indexHtml);
app.get(["/", "/index.html"], sendIndex);
app.use("/uploads", express.static(UPLOAD_DIR, { fallthrough: false, maxAge: "7d", setHeaders: (res) => res.set("Content-Security-Policy", "sandbox") }));
app.use(express.static(PUBLIC, { index: false, maxAge: "1h" }));
app.use((req, res) => (req.method === "GET" && req.accepts("html") ? sendIndex(req, res) : res.status(404).end()));

// ---------- real-time chat ----------
const server = http.createServer(app);
io = new Server(server, { serveClient: true, maxHttpBufferSize: 64 * 1024 });
const online = new Map(); // member id -> open socket count
const presence = () => io.emit("presence", [...online.keys()]);

io.use((socket, next) => {
  const s = sessionFromCookie(socket.handshake.headers.cookie);
  const m = s && loadMember(s.member_id);
  if (!m) return next(new Error("unauthorised"));
  socket.data.memberId = m.id;
  next();
});
io.on("connection", (socket) => {
  const id = socket.data.memberId;
  socket.join(`member:${id}`);
  online.set(id, (online.get(id) || 0) + 1);
  presence();
  const ack = (fn, v) => { if (typeof fn === "function") fn(v); };

  socket.on("join", (room, cb) => {
    const me = loadMember(id);
    if (!me || typeof room !== "string" || !canJoin(me, room)) return ack(cb, { error: "You cannot open this room." });
    socket.join(room);
    ack(cb, { ok: true });
  });
  socket.on("message", (data, cb) => {
    try {
      const me = loadMember(id);
      if (!me) return ack(cb, { error: "Your account is not active." });
      const body = String((data && data.body) || "").trim();
      const room = data && data.room;
      if (!body) return ack(cb, { error: "Message is empty." });
      if (body.length > 2000) return ack(cb, { error: "Messages are limited to 2000 characters." });
      if (!canJoin(me, room)) return ack(cb, { error: "You cannot post in this room." });
      const r = run("INSERT INTO messages (room, member_id, body, created_at) VALUES (?, ?, ?, ?)", room, me.id, body, nowStr());
      const row = one(`${MSG_SELECT} WHERE x.id = ?`, Number(r.lastInsertRowid));
      io.to(roomTargets(room)).emit("message", row);
      ack(cb, { ok: true });
    } catch (e) {
      console.error(e);
      ack(cb, { error: "Message could not be sent." });
    }
  });
  socket.on("typing", (room) => {
    if (typeof room !== "string" || !socket.rooms.has(room)) return;
    const me = loadMember(id);
    if (me) socket.to(room).emit("typing", { room, name: me.name });
  });
  socket.on("disconnect", () => {
    const n = (online.get(id) || 1) - 1;
    if (n > 0) online.set(id, n); else online.delete(id);
    presence();
  });
});

// expired sessions cleanup
setInterval(() => { try { run("DELETE FROM sessions WHERE expires_at < ?", Date.now()); } catch (e) { console.error(e); } }, 3600e3).unref();

server.listen(CFG.port, () => console.log(`CU Alumni Connect listening on http://localhost:${CFG.port}`));
const shutdown = () => { console.log("shutting down"); io.close(); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
