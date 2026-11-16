"use strict";
// SQLite storage for CU Alumni Connect, using Node's built-in node:sqlite
// (no native add-ons to compile, so the image builds the same on any CPU).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const nowStr = (ms = Date.now()) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

// ---------- passwords ----------
// New hashes use scrypt. Hashes carried over from the original demo data
// (sha256 of "cu:" + password) are still accepted and upgraded on next sign-in.
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
function checkPw(pw, stored) {
  pw = String(pw || "");
  stored = String(stored || "");
  if (stored.startsWith("scrypt$")) {
    const [, saltHex, keyHex] = stored.split("$");
    const key = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
    const want = Buffer.from(keyHex, "hex");
    return want.length === key.length && crypto.timingSafeEqual(key, want);
  }
  if (stored.startsWith("plain:")) return stored === "plain:" + pw;
  const legacy = crypto.createHash("sha256").update("cu:" + pw, "utf8").digest("hex");
  return /^[0-9a-f]{64}$/.test(stored) && crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(stored));
}
const needsRehash = (stored) => !String(stored || "").startsWith("scrypt$");

// ---------- schema ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS registry (
  reg_no TEXT PRIMARY KEY, reg_year INTEGER NOT NULL, name TEXT NOT NULL,
  subject TEXT NOT NULL, college TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT, reg_no TEXT NOT NULL UNIQUE, reg_year INTEGER NOT NULL,
  name TEXT NOT NULL, subject TEXT NOT NULL, college TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL UNIQUE COLLATE NOCASE, mobile TEXT NOT NULL DEFAULT '', org TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL, role TEXT NOT NULL, pass_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, member_id INTEGER, staff_id INTEGER,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, category TEXT NOT NULL, body TEXT NOT NULL,
  link TEXT NOT NULL DEFAULT '', attachment TEXT NOT NULL DEFAULT '', attachment_name TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0, posted_by INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, member_id INTEGER NOT NULL,
  body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_room ON messages(room, id);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, category TEXT NOT NULL,
  department TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'Received', reply TEXT NOT NULL DEFAULT '', replied_by INTEGER,
  replied_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS support (
  feedback_id INTEGER NOT NULL, member_id INTEGER NOT NULL, PRIMARY KEY (feedback_id, member_id));
CREATE TABLE IF NOT EXISTS officials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT NOT NULL, designation TEXT NOT NULL, name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '', mobile TEXT NOT NULL DEFAULT '', office TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 100);
CREATE TABLE IF NOT EXISTS campuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, address TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type TEXT NOT NULL DEFAULT 'Department', council TEXT NOT NULL DEFAULT '', campus_id INTEGER,
  email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS faculty (
  id INTEGER PRIMARY KEY AUTOINCREMENT, department_id INTEGER NOT NULL, name TEXT NOT NULL,
  designation TEXT NOT NULL, specialization TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS faculty_dept ON faculty(department_id);
`;

function insertRows(db, table, rows, cols) {
  if (!rows || !rows.length) return;
  const st = db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const r of rows) st.run(...cols.map((c) => (r[c] === undefined ? null : r[c])));
}

// First start only: load the directories, the two staff accounts and (unless
// SEED_DEMO_DATA=false) the sample registry, members, notices, chat and feedback.
function seed(db, { demo, adminPassword }) {
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, "seed.json"), "utf8"));
  const t = Date.now();
  insertRows(db, "campuses", s.campuses, ["id", "name", "address"]);
  insertRows(db, "departments", s.departments, ["id", "name", "type", "council", "campus_id", "email", "phone"]);
  insertRows(db, "faculty", s.faculty, ["id", "department_id", "name", "designation", "specialization", "email", "phone", "room"]);
  insertRows(db, "officials", s.officials, ["id", "grp", "designation", "name", "email", "mobile", "office", "sort"]);
  const staff = s.staff.map((x) => ({ ...x }));
  if (!demo) staff.forEach((x) => { x.name = x.name.replace(/\s*\(demo [^)]*\)/, ""); });
  if (adminPassword) {
    const admin = staff.find((x) => x.username === "cu-admin");
    if (admin) admin.pass_hash = hashPw(adminPassword);
  }
  insertRows(db, "staff", demo ? staff : staff.filter((x) => x.role === "admin"), ["id", "username", "name", "role", "pass_hash", "created_at"]);
  if (demo) {
    insertRows(db, "registry", s.registry, ["reg_no", "reg_year", "name", "subject", "college", "added_at"]);
    insertRows(db, "members", s.members, ["id", "reg_no", "reg_year", "name", "subject", "college", "email", "mobile", "org", "pass_hash", "status", "created_at"]);
    insertRows(db, "notices", s.notices, ["id", "title", "category", "body", "link", "attachment", "attachment_name", "pinned", "posted_by", "created_at"]);
    insertRows(db, "messages", s.messages.map((m) => ({ ...m, created_at: nowStr(t - m.ago * 864e5) })), ["id", "room", "member_id", "body", "created_at"]);
    insertRows(db, "feedback", s.feedback.map((f) => ({ ...f, created_at: nowStr(t - f.ago * 864e5) })),
      ["id", "member_id", "category", "department", "title", "body", "shared", "status", "reply", "replied_by", "replied_at", "created_at"]);
    insertRows(db, "support", s.support, ["feedback_id", "member_id"]);
  }
}

function open({ file, demo = true, adminPassword = "" }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  const seeded = db.prepare("SELECT value FROM meta WHERE key = 'seeded_at'").get();
  if (!seeded) {
    db.exec("BEGIN");
    try {
      seed(db, { demo, adminPassword });
      db.prepare("INSERT INTO meta (key, value) VALUES ('seeded_at', ?)").run(nowStr());
      db.exec("COMMIT");
      console.log(`[db] new database created at ${file} (${demo ? "with demo data" : "directories + admin only"})`);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

module.exports = { open, hashPw, checkPw, needsRehash, nowStr };
