"use strict";
// The REST API (/api/...). Same routes, rules and messages as the browser-only
// version, now running on a real server with shared storage.
const crypto = require("crypto");
const { hashPassword, verifyPassword, parseCookies, cookie, makeLimiter } = require("./auth");
const { nowStr, fileUrl } = require("./db");

const NOTICE_CATEGORIES = ["Events", "Convocation", "Certificates", "Opportunities", "Circular"];
const FEEDBACK_CATEGORIES = ["Curriculum & syllabus", "Research & laboratories", "Teaching & pedagogy", "Library & infrastructure", "Industry linkage & placements", "Digital & online learning", "Examinations & evaluation", "Other"];
const FEEDBACK_STATUSES = ["Received", "Under review", "Forwarded to department", "Implemented", "Not feasible"];
const OFFICIAL_GROUPS = ["Principal Officers", "Syndicate", "Senate", "Deans of Faculty Councils", "Other Officers"];
const REG_NO_PATTERN = /^\d{3}-\d{4}-\d{4}-\d{2}$/;
const REG_NO_EXAMPLE = "123-1111-0456-15";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);

const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\b(dr|prof|mr|mrs|ms|miss|smt|sri|shri|kumari)\b/g, " ").split(/\s+/).filter(Boolean).join(" ");
const sameName = (a, b) => normName(a).split(" ").sort().join(" ") === normName(b).split(" ").sort().join(" ");
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ""));
const isMobile = (s) => /^\+?[\d\s-]{10,16}$/.test(String(s || ""));
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || ""));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const like = (q, ...fields) => {
  q = String(q || "").trim().toLowerCase();
  return !q || fields.some((f) => String(f ?? "").toLowerCase().includes(q));
};
const ieq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function str(v, { max = 500, required = false, label = "Field" } = {}) {
  const s = String(v ?? "").trim();
  if (required && !s) throw bad(label + " is required.");
  if (s.length > max) throw bad(label + " is too long (maximum " + max + " characters).");
  return s;
}
function oneOf(v, list, label) {
  if (!list.includes(v)) throw bad(label + " must be one of: " + list.join(", ") + ".");
  return v;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  text = String(text).replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
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
    head.forEach((h, j) => (o[h] = (r[j] ?? "").trim()));
    return o;
  });
}

function createApi({ db, cfg, tokens, events }) {
  const DB = () => db.doc;
  const limiter = makeLimiter();
  const R = [];
  const route = (method, p, fn) => {
    const keys = [];
    const re = new RegExp("^" + p.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    R.push({ method, re, keys, fn });
  };

  // ---------- sessions (signed HttpOnly cookies) ----------
  const COOKIE = { member: "cu_member", staff: "cu_staff" };
  const memberById = (id) => DB().members.find((m) => m.id === id);
  const memberCols = (m) => m && { id: m.id, reg_no: m.reg_no, reg_year: m.reg_year, name: m.name, subject: m.subject, college: m.college, email: m.email, mobile: m.mobile, org: m.org, status: m.status, seen_notice: m.seen_notice || 0, created_at: m.created_at };
  const loadMember = (id) => {
    const m = memberById(id);
    return m && m.status === "active" ? memberCols(m) : null;
  };
  const loadStaff = (id) => {
    const s = DB().staff.find((x) => x.id === id);
    return s ? { id: s.id, username: s.username, name: s.name, role: s.role } : null;
  };

  // Used by both HTTP requests and the chat socket.
  function memberFromCookies(header) {
    const p = tokens.verify(parseCookies(header)[COOKIE.member]);
    if (!p || p.t !== "m") return null;
    const m = memberById(p.id);
    return m && m.status === "active" && (m.tv || 0) === p.v ? memberCols(m) : null;
  }
  function staffFromCookies(header) {
    const p = tokens.verify(parseCookies(header)[COOKIE.staff]);
    if (!p || p.t !== "s") return null;
    const s = DB().staff.find((x) => x.id === p.id);
    return s && (s.tv || 0) === p.v ? loadStaff(s.id) : null;
  }
  const isSecure = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";
  function setSession(ctx, kind, row) {
    const exp = Date.now() + cfg.SESSION_DAYS * 864e5;
    const tok = tokens.sign({ t: kind === "member" ? "m" : "s", id: row.id, v: row.tv || 0, exp });
    ctx.res.append("Set-Cookie", cookie(COOKIE[kind], tok, { maxAgeSec: Math.floor(cfg.SESSION_DAYS * 86400), secure: isSecure(ctx.req) }));
  }
  function clearSession(ctx, kind) {
    ctx.res.append("Set-Cookie", cookie(COOKIE[kind], "", { maxAgeSec: 0, secure: isSecure(ctx.req) }));
  }
  const curMember = (ctx) => memberFromCookies(ctx.req.headers.cookie);
  const curStaff = (ctx) => staffFromCookies(ctx.req.headers.cookie);
  const needMember = (ctx) => {
    const m = curMember(ctx);
    if (!m) throw new HttpError(401, "Please sign in as a registered member.");
    return m;
  };
  const needStaff = (ctx) => {
    const s = curStaff(ctx);
    if (!s) throw new HttpError(401, "Please sign in to the University staff console.");
    return s;
  };
  const needAdmin = (ctx) => {
    const s = needStaff(ctx);
    if (s.role !== "admin") throw new HttpError(403, "Only staff with the admin role can do this.");
    return s;
  };

  // Checks a password; upgrades legacy hashes to scrypt on success.
  async function checkPw(row, pw) {
    const r = await verifyPassword(pw, row.pass_hash);
    if (r.ok && r.upgrade) {
      row.pass_hash = await hashPassword(pw);
      db.markDirty();
    }
    return r.ok;
  }
  const limitKey = (ctx, id) => (ctx.req.ip || "") + "|" + String(id).toLowerCase();
  function guard(ctx, id) {
    if (limiter.blocked(limitKey(ctx, id))) throw new HttpError(429, "Too many unsuccessful sign-in attempts. Please wait 15 minutes and try again.");
  }

  // ---------- chat helpers (shared with the socket server) ----------
  function roomsFor(m) {
    return [
      { key: "general", name: "General Lounge", sub: "All verified alumni" },
      { key: "careers", name: "Careers & Mentoring", sub: "Jobs, referrals and mentoring" },
      { key: "batch-" + m.reg_year, name: "Batch of " + m.reg_year, sub: "Alumni registered in " + m.reg_year },
      { key: "dept-" + slug(m.subject), name: m.subject, sub: "Department room" },
    ];
  }
  const dmKey = (a, b) => "dm-" + Math.min(a, b) + "-" + Math.max(a, b);
  function canJoin(m, room) {
    if (typeof room !== "string") return false;
    if (roomsFor(m).some((r) => r.key === room)) return true;
    const dm = /^dm-(\d+)-(\d+)$/.exec(room);
    if (dm) {
      const [a, b] = [Number(dm[1]), Number(dm[2])];
      if (a === b || (a !== m.id && b !== m.id)) return false;
      const o = memberById(a === m.id ? b : a);
      return !!o && o.status === "active";
    }
    return false;
  }
  const msgRow = (x) => {
    const b = memberById(x.member_id);
    return b && { id: x.id, room: x.room, body: x.body, created_at: x.created_at, member_id: x.member_id, name: b.name, reg_year: b.reg_year };
  };
  const history = (room, before = 1e15, limit = 60) =>
    DB().messages.filter((x) => x.room === room && x.id < before).sort((a, b) => b.id - a.id).slice(0, limit).reverse().map(msgRow).filter(Boolean);
  function postMessage(me, room, body) {
    body = String(body || "").trim();
    if (!body) throw bad("Message is empty.");
    if (body.length > 2000) throw bad("Messages are limited to 2000 characters.");
    if (!canJoin(me, room)) throw bad("You cannot post in this room.");
    const id = db.nextId("messages");
    DB().messages.push({ id, room, member_id: me.id, body, created_at: nowStr() });
    db.markDirty();
    return msgRow(DB().messages[DB().messages.length - 1]);
  }

  // Runs fn synchronously; on error restores the data as it was (used for CSV imports).
  const tx = (fn) => {
    const snap = JSON.stringify(db.doc);
    try {
      return fn();
    } catch (e) {
      db.doc = JSON.parse(snap);
      throw e;
    }
  };
  const nextId = (t) => db.nextId(t);

  // ---------- registration & member account ----------
  function checkRecord({ name, reg_no, reg_year }) {
    name = str(name, { max: 120, required: true, label: "Full name" });
    reg_no = str(reg_no, { max: 40, required: true, label: "Registration number" });
    const year = Number(reg_year);
    if (normName(name).split(" ").length < 2) throw bad("Please enter your full name (first name and surname) as in University records.");
    if (!REG_NO_PATTERN.test(reg_no)) throw bad("Registration number should look like " + REG_NO_EXAMPLE + ".");
    if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear()) throw bad("Please select a valid year of registration.");
    const rec = DB().registry.find((r) => r.reg_no === reg_no);
    if (!rec) throw new HttpError(404, "This registration number was not found in University records. If you believe this is a mistake, contact the Alumni Cell for manual verification.");
    if (rec.reg_year !== year) throw bad("The year of registration does not match University records for this number.");
    if (!sameName(rec.name, name)) throw bad("The name does not match the name on record for this registration number. Use your name exactly as on your registration certificate.");
    if (DB().members.some((m) => m.reg_no === reg_no)) throw new HttpError(409, "This registration number is already linked to a member account. Please sign in instead.");
    return rec;
  }
  route("GET", "/config", () => ({ regNoExample: REG_NO_EXAMPLE }));
  route("POST", "/register/verify", ({ body }) => {
    const r = checkRecord(body);
    return { ok: true, name: r.name, reg_year: r.reg_year, subject: r.subject, college: r.college };
  });
  route("POST", "/register", async (ctx) => {
    const { body } = ctx;
    checkRecord(body);
    const email = str(body.email, { max: 160, required: true, label: "Email" });
    const mobile = str(body.mobile, { max: 20, label: "Mobile" });
    const org = str(body.org, { max: 160, label: "City / organisation" });
    const password = String(body.password || "");
    if (!isEmail(email)) throw bad("Please enter a valid email address.");
    if (mobile && !isMobile(mobile)) throw bad("Please enter a valid mobile number, or leave it blank.");
    if (password.length < 8) throw bad("Password must be at least 8 characters.");
    if (!body.agree) throw bad("Please confirm the declaration.");
    const pass_hash = await hashPassword(password);
    const rec = checkRecord(body); // re-check after the await: someone may have claimed it meanwhile
    if (DB().members.some((m) => ieq(m.email, email))) throw new HttpError(409, "That email is already registered.");
    const id = nextId("members");
    const row = { id, reg_no: rec.reg_no, reg_year: rec.reg_year, name: rec.name, subject: rec.subject, college: rec.college, email, mobile, org, pass_hash, status: "active", tv: 0, created_at: nowStr() };
    DB().members.push(row);
    setSession(ctx, "member", row);
    events.broadcast("member:joined", { name: rec.name, reg_year: rec.reg_year });
    return [201, { member: loadMember(id) }];
  });
  route("POST", "/login", async (ctx) => {
    const id = str(ctx.body.id, { max: 160, required: true, label: "Registration number or email" });
    guard(ctx, id);
    const m = DB().members.find((x) => x.reg_no === id || ieq(x.email, id));
    if (!m || !(await checkPw(m, ctx.body.password))) {
      limiter.fail(limitKey(ctx, id));
      throw new HttpError(401, "Registration number/email or password is incorrect.");
    }
    limiter.clear(limitKey(ctx, id));
    if (m.status !== "active") throw new HttpError(403, "This account has been suspended. Please contact the Alumni Cell.");
    setSession(ctx, "member", m);
    return { member: loadMember(m.id) };
  });
  route("POST", "/logout", (ctx) => {
    clearSession(ctx, "member");
    return { ok: true };
  });
  route("GET", "/me", (ctx) => ({ member: curMember(ctx) }));
  route("PATCH", "/me", async (ctx) => {
    const { body } = ctx;
    const me = needMember(ctx);
    const mobile = str(body.mobile, { max: 20, label: "Mobile" });
    const org = str(body.org, { max: 160, label: "City / organisation" });
    if (mobile && !isMobile(mobile)) throw bad("Please enter a valid mobile number.");
    const row = memberById(me.id);
    if (body.new_password) {
      if (!(await verifyPassword(body.current_password, row.pass_hash)).ok) throw bad("Current password is incorrect.");
      if (String(body.new_password).length < 8) throw bad("New password must be at least 8 characters.");
      row.pass_hash = await hashPassword(String(body.new_password));
      row.tv = (row.tv || 0) + 1; // signs this account out on every other computer
      setSession(ctx, "member", row);
      events.kickMember(row.id);
    }
    row.mobile = mobile;
    row.org = org;
    return { member: loadMember(me.id) };
  });
  route("POST", "/me/seen", (ctx) => {
    const me = needMember(ctx);
    const row = memberById(me.id);
    const id = Number(ctx.body.id) || 0;
    if (id > (row.seen_notice || 0)) row.seen_notice = id;
    return { ok: true };
  });
  route("GET", "/members", (ctx) => {
    needMember(ctx);
    return DB().members.filter((m) => m.status === "active").sort((a, b) => a.name.localeCompare(b.name)).map((m) => ({ id: m.id, name: m.name, reg_year: m.reg_year, subject: m.subject, college: m.college, org: m.org }));
  });

  // ---------- chat ----------
  route("GET", "/chat/rooms", (ctx) => {
    const me = needMember(ctx);
    const keys = [...new Set(DB().messages.map((x) => x.room).filter((r) => r.startsWith("dm-" + me.id + "-") || (r.startsWith("dm-") && r.endsWith("-" + me.id))))];
    const dms = keys
      .map((key) => {
        const [, a, b] = key.split("-").map(Number);
        const o = memberById(a === me.id ? b : a);
        return o && { key, other: { id: o.id, name: o.name, reg_year: o.reg_year, subject: o.subject } };
      })
      .filter(Boolean);
    return { rooms: roomsFor(me), dms };
  });
  route("GET", "/chat/history", (ctx) => {
    const me = needMember(ctx);
    const room = String(ctx.query.room || "");
    if (!canJoin(me, room)) throw new HttpError(403, "You cannot open this room.");
    return history(room, Number(ctx.query.before) || 1e15);
  });
  route("GET", "/chat/dm/:otherId", (ctx) => {
    const me = needMember(ctx);
    const key = dmKey(me.id, Number(ctx.params.otherId));
    if (!canJoin(me, key)) throw bad("That member is not available for messaging.");
    return { key };
  });

  // ---------- notices, feedback, directory ----------
  route("GET", "/notices", ({ query }) => {
    const cat = String(query.category || "");
    const rows = DB().notices
      .filter((n) => like(query.q, n.title, n.body) && (!cat || n.category === cat))
      .sort((a, b) => b.pinned - a.pinned || (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0) || b.id - a.id)
      .slice(0, 200)
      .map(({ id, title, category, body, link, attachment, attachment_name, pinned, created_at }) => ({ id, title, category, body, link, attachment, attachment_name, pinned, created_at }));
    return { categories: NOTICE_CATEGORIES, notices: rows };
  });
  const supporters = (fid) => DB().support.filter((s) => s.feedback_id === fid).length;
  route("GET", "/feedback", (ctx) => {
    const me = needMember(ctx);
    const mine = ctx.query.view === "mine";
    let rows = DB().feedback
      .filter((f) => (mine ? f.member_id === me.id : f.shared))
      .map((f) => {
        const m = memberById(f.member_id);
        if (!m) return null;
        return {
          id: f.id, category: f.category, department: f.department, title: f.title, body: f.body, shared: f.shared, status: f.status,
          reply: f.reply, replied_at: f.replied_at, created_at: f.created_at, member_id: f.member_id, member_name: m.name, reg_year: m.reg_year,
          supporters: supporters(f.id), supported: DB().support.some((s) => s.feedback_id === f.id && s.member_id === me.id) ? 1 : 0,
        };
      })
      .filter(Boolean);
    rows = mine ? rows.sort((a, b) => b.id - a.id) : rows.sort((a, b) => b.supporters - a.supporters || b.id - a.id).slice(0, 300);
    return { categories: FEEDBACK_CATEGORIES, feedback: rows };
  });
  route("POST", "/feedback", (ctx) => {
    const { body } = ctx;
    const me = needMember(ctx);
    const category = oneOf(body.category, FEEDBACK_CATEGORIES, "Area");
    const department = str(body.department, { max: 160, required: true, label: "Department" });
    const title = str(body.title, { max: 160, required: true, label: "Title" });
    const text = str(body.body, { max: 5e3, required: true, label: "Feedback" });
    if (title.length < 8) throw bad("Please give your suggestion a short descriptive title.");
    if (text.length < 30) throw bad("Please describe your suggestion in a little more detail (at least 30 characters).");
    const id = nextId("feedback");
    DB().feedback.push({ id, member_id: me.id, category, department, title, body: text, shared: body.shared ? 1 : 0, status: "Received", reply: "", replied_by: null, replied_at: null, created_at: nowStr() });
    return [201, { id }];
  });
  route("POST", "/feedback/:id/support", (ctx) => {
    const me = needMember(ctx);
    const f = DB().feedback.find((x) => x.id === Number(ctx.params.id));
    if (!f || !f.shared) throw new HttpError(404, "Suggestion not found.");
    const i = DB().support.findIndex((s) => s.feedback_id === f.id && s.member_id === me.id);
    if (i >= 0) DB().support.splice(i, 1);
    else DB().support.push({ feedback_id: f.id, member_id: me.id });
    return { supported: i < 0 };
  });
  route("GET", "/directory/officials", () => ({ groups: OFFICIAL_GROUPS, officials: [...DB().officials].sort((a, b) => a.sort - b.sort || a.id - b.id) }));
  route("GET", "/directory/departments", () => ({
    campuses: [...DB().campuses].sort((a, b) => a.id - b.id),
    departments: [...DB().departments]
      .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1))
      .map((d) => ({ ...d, faculty: DB().faculty.filter((f) => f.department_id === d.id).sort((a, b) => a.id - b.id) })),
  }));

  // ---------- staff: account ----------
  route("POST", "/staff/login", async (ctx) => {
    const username = String(ctx.body.username || "").trim();
    guard(ctx, "staff:" + username);
    const s = DB().staff.find((x) => ieq(x.username, username));
    if (!s || !(await checkPw(s, ctx.body.password))) {
      limiter.fail(limitKey(ctx, "staff:" + username));
      throw new HttpError(401, "Staff ID or password is incorrect.");
    }
    limiter.clear(limitKey(ctx, "staff:" + username));
    setSession(ctx, "staff", s);
    return { staff: loadStaff(s.id) };
  });
  route("POST", "/staff/logout", (ctx) => {
    clearSession(ctx, "staff");
    return { ok: true };
  });
  route("GET", "/staff/me", (ctx) => ({ staff: curStaff(ctx) }));
  route("POST", "/staff/password", async (ctx) => {
    const st = needStaff(ctx);
    const row = DB().staff.find((x) => x.id === st.id);
    if (!(await verifyPassword(ctx.body.current, row.pass_hash)).ok) throw bad("Current password is incorrect.");
    if (String(ctx.body.next || "").length < 10) throw bad("New password must be at least 10 characters.");
    row.pass_hash = await hashPassword(String(ctx.body.next));
    row.tv = (row.tv || 0) + 1;
    setSession(ctx, "staff", row);
    return { ok: true };
  });
  route("GET", "/staff/stats", (ctx) => {
    needStaff(ctx);
    const d = DB();
    return {
      registry: d.registry.length,
      members: d.members.filter((m) => m.status === "active").length,
      suspended: d.members.filter((m) => m.status === "suspended").length,
      notices: d.notices.length,
      feedbackOpen: d.feedback.filter((f) => ["Received", "Under review"].includes(f.status)).length,
      feedback: d.feedback.length,
      messages: d.messages.length,
      departments: d.departments.length,
      faculty: d.faculty.length,
      officials: d.officials.length,
    };
  });

  // ---------- staff: notices ----------
  function noticeInput(b) {
    const link = str(b.link, { max: 500, label: "Link" });
    if (link && !isUrl(link)) throw bad("Link must start with http:// or https://");
    return {
      title: str(b.title, { max: 200, required: true, label: "Title" }),
      category: oneOf(b.category, NOTICE_CATEGORIES, "Category"),
      body: str(b.body, { max: 5e3, required: true, label: "Details" }),
      link,
      pinned: b.pinned === "true" || b.pinned === true || b.pinned === "1" || b.pinned === "on" ? 1 : 0,
    };
  }
  function checkAttachment(file) {
    if (!file) return null;
    if (!/\.(pdf|jpe?g|png|docx?)$/i.test(file.originalname)) throw bad("Attachment must be PDF, JPG, PNG, DOC or DOCX.");
    if (file.size > cfg.MAX_UPLOAD_MB * 1024 * 1024) throw bad("Attachments are limited to " + cfg.MAX_UPLOAD_MB + " MB.");
    return file;
  }
  route("POST", "/staff/notices", async (ctx) => {
    const st = needStaff(ctx);
    const n = noticeInput(ctx.body);
    const file = checkAttachment(ctx.files.attachment);
    const f = file ? await db.addFile(file.originalname, file.buffer) : null;
    const id = nextId("notices");
    DB().notices.push({ id, ...n, attachment: f ? fileUrl(f) : "", attachment_name: f ? f.name : "", posted_by: st.id, created_at: nowStr() });
    events.broadcast("notice:new", { id, title: n.title });
    return [201, { id }];
  });
  route("PUT", "/staff/notices/:id", async (ctx) => {
    needStaff(ctx);
    const old = DB().notices.find((x) => x.id === Number(ctx.params.id));
    if (!old) throw new HttpError(404, "Notice not found.");
    const n = noticeInput(ctx.body);
    const file = checkAttachment(ctx.files.attachment);
    const f = file ? await db.addFile(file.originalname, file.buffer) : null;
    Object.assign(old, n);
    if (f) {
      await db.removeFileByUrl(old.attachment);
      old.attachment = fileUrl(f);
      old.attachment_name = f.name;
    } else if (ctx.body.remove_attachment === "true") {
      await db.removeFileByUrl(old.attachment);
      old.attachment = "";
      old.attachment_name = "";
    }
    return { ok: true };
  });
  route("DELETE", "/staff/notices/:id", async (ctx) => {
    needStaff(ctx);
    const i = DB().notices.findIndex((x) => x.id === Number(ctx.params.id));
    if (i < 0) throw new HttpError(404, "Notice not found.");
    const [gone] = DB().notices.splice(i, 1);
    await db.removeFileByUrl(gone.attachment);
    return { ok: true };
  });

  // ---------- staff: feedback ----------
  route("GET", "/staff/feedback", (ctx) => {
    needStaff(ctx);
    const status = String(ctx.query.status || "");
    return {
      statuses: FEEDBACK_STATUSES,
      feedback: DB().feedback
        .filter((f) => !status || f.status === status)
        .sort((a, b) => b.id - a.id)
        .map((f) => {
          const m = memberById(f.member_id);
          if (!m) return null;
          const st = DB().staff.find((s) => s.id === f.replied_by);
          return { ...f, member_name: m.name, reg_year: m.reg_year, member_email: m.email, supporters: supporters(f.id), replied_by_name: st?.name || null };
        })
        .filter(Boolean),
    };
  });
  route("PATCH", "/staff/feedback/:id", (ctx) => {
    const st = needStaff(ctx);
    const status = oneOf(ctx.body.status, FEEDBACK_STATUSES, "Status");
    const reply = str(ctx.body.reply, { max: 3e3, label: "Response" });
    const f = DB().feedback.find((x) => x.id === Number(ctx.params.id));
    if (!f) throw new HttpError(404, "Feedback not found.");
    Object.assign(f, { status, reply, replied_by: st.id, replied_at: nowStr() });
    return { ok: true };
  });

  // ---------- staff: officials ----------
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
    if (o.email && !isEmail(o.email)) throw bad("Invalid email: " + o.email);
    if (o.mobile && !isMobile(o.mobile)) throw bad("Invalid mobile number: " + o.mobile);
    return o;
  }
  const insOfficial = (o) => DB().officials.push({ id: nextId("officials"), ...o });
  route("POST", "/staff/officials", (ctx) => {
    needStaff(ctx);
    insOfficial(officialInput(ctx.body));
    return [201, { ok: true }];
  });
  route("PUT", "/staff/officials/:id", (ctx) => {
    needStaff(ctx);
    const o = officialInput(ctx.body);
    const ex = DB().officials.find((x) => x.id === Number(ctx.params.id));
    if (!ex) throw new HttpError(404, "Not found.");
    Object.assign(ex, o);
    return { ok: true };
  });
  route("DELETE", "/staff/officials/:id", (ctx) => {
    needStaff(ctx);
    DB().officials = DB().officials.filter((x) => x.id !== Number(ctx.params.id));
    return { ok: true };
  });
  const csvRows = (files) => {
    if (!files.file) throw bad("Please choose a CSV file to upload.");
    const rows = parseCsv(files.file.buffer.toString("utf8"));
    if (!rows.length) throw bad("The CSV file has no data rows.");
    return rows;
  };
  route("POST", "/staff/officials/import", (ctx) => {
    needStaff(ctx);
    const rows = csvRows(ctx.files);
    const errors = [];
    let added = 0;
    tx(() => {
      if (ctx.body.mode === "replace") DB().officials = [];
      rows.forEach((r) => {
        try {
          insOfficial(officialInput({ grp: r.group, designation: r.designation, name: r.name, email: r.email, mobile: r.mobile, office: r.office, sort: r.sort }));
          added++;
        } catch (e) {
          errors.push("Line " + r._line + ": " + e.message);
        }
      });
    });
    return { added, errors };
  });

  // ---------- staff: campuses, departments, faculty ----------
  route("POST", "/staff/campuses", (ctx) => {
    needStaff(ctx);
    const name = str(ctx.body.name, { max: 160, required: true, label: "Campus name" });
    const address = str(ctx.body.address, { max: 300, required: true, label: "Address" });
    if (DB().campuses.some((c) => c.name === name)) throw bad("A campus with that name already exists.");
    DB().campuses.push({ id: nextId("campuses"), name, address });
    return [201, { ok: true }];
  });
  route("PUT", "/staff/campuses/:id", (ctx) => {
    needStaff(ctx);
    const c = DB().campuses.find((x) => x.id === Number(ctx.params.id));
    const name = str(ctx.body.name, { max: 160, required: true, label: "Campus name" });
    const address = str(ctx.body.address, { max: 300, required: true, label: "Address" });
    if (c) Object.assign(c, { name, address });
    return { ok: true };
  });
  const campusId = (v) => {
    if (!v) return null;
    const c = DB().campuses.find((x) => x.id === Number(v) || ieq(x.name, v));
    if (!c) throw bad('Unknown campus "' + v + '". Add it under Campuses first.');
    return c.id;
  };
  function deptInput(b) {
    const d = {
      name: str(b.name, { max: 200, required: true, label: "Department name" }),
      type: oneOf(b.type || "Department", ["Department", "Centre"], "Type"),
      council: str(b.council, { max: 200, label: "Faculty council" }),
      campus_id: campusId(b.campus_id || b.campus),
      email: str(b.email, { max: 160, label: "Email" }),
      phone: str(b.phone, { max: 40, label: "Phone" }),
    };
    if (d.email && !isEmail(d.email)) throw bad("Invalid email: " + d.email);
    return d;
  }
  const upsertDept = (d) => {
    const ex = DB().departments.find((x) => ieq(x.name, d.name));
    if (ex) {
      Object.assign(ex, d, { name: ex.name });
      return ex.id;
    }
    const id = nextId("departments");
    DB().departments.push({ id, ...d });
    return id;
  };
  route("POST", "/staff/departments", (ctx) => {
    needStaff(ctx);
    const d = deptInput(ctx.body);
    if (DB().departments.some((x) => ieq(x.name, d.name))) throw bad("A department with that name already exists.");
    return [201, { id: upsertDept(d) }];
  });
  route("PUT", "/staff/departments/:id", (ctx) => {
    needStaff(ctx);
    const d = deptInput(ctx.body);
    const id = Number(ctx.params.id);
    if (DB().departments.some((x) => ieq(x.name, d.name) && x.id !== id)) throw bad("Another department already has that name.");
    const ex = DB().departments.find((x) => x.id === id);
    if (ex) Object.assign(ex, d);
    return { ok: true };
  });
  route("DELETE", "/staff/departments/:id", (ctx) => {
    needStaff(ctx);
    const id = Number(ctx.params.id);
    DB().departments = DB().departments.filter((x) => x.id !== id);
    DB().faculty = DB().faculty.filter((f) => f.department_id !== id);
    return { ok: true };
  });
  route("POST", "/staff/departments/import", (ctx) => {
    needStaff(ctx);
    const rows = csvRows(ctx.files);
    const errors = [];
    let saved = 0;
    tx(() =>
      rows.forEach((r) => {
        try {
          upsertDept(deptInput({ name: r.name, type: r.type, council: r.faculty_council, campus: r.campus, email: r.email, phone: r.phone }));
          saved++;
        } catch (e) {
          errors.push("Line " + r._line + ": " + e.message);
        }
      })
    );
    return { added: saved, errors };
  });
  function facultyInput(b) {
    const f = {
      name: str(b.name, { max: 160, required: true, label: "Name" }),
      designation: str(b.designation, { max: 120, required: true, label: "Designation" }),
      specialization: str(b.specialization, { max: 300, required: true, label: "Specialisation" }),
      email: str(b.email, { max: 160, label: "Email" }),
      phone: str(b.phone, { max: 40, label: "Phone" }),
      room: str(b.room, { max: 200, label: "Room / office" }),
    };
    if (f.email && !isEmail(f.email)) throw bad("Invalid email: " + f.email);
    return f;
  }
  const insFaculty = (deptId, f) => DB().faculty.push({ id: nextId("faculty"), department_id: deptId, ...f });
  route("POST", "/staff/departments/:id/faculty", (ctx) => {
    needStaff(ctx);
    const id = Number(ctx.params.id);
    if (!DB().departments.some((d) => d.id === id)) throw new HttpError(404, "Department not found.");
    insFaculty(id, facultyInput(ctx.body));
    return [201, { ok: true }];
  });
  route("PUT", "/staff/faculty/:id", (ctx) => {
    needStaff(ctx);
    const f = facultyInput(ctx.body);
    const ex = DB().faculty.find((x) => x.id === Number(ctx.params.id));
    if (ex) Object.assign(ex, f);
    return { ok: true };
  });
  route("DELETE", "/staff/faculty/:id", (ctx) => {
    needStaff(ctx);
    DB().faculty = DB().faculty.filter((x) => x.id !== Number(ctx.params.id));
    return { ok: true };
  });
  route("POST", "/staff/faculty/import", (ctx) => {
    needStaff(ctx);
    const rows = csvRows(ctx.files);
    const errors = [];
    let added = 0;
    const replace = ctx.body.mode === "replace";
    tx(() => {
      const cleared = new Set();
      rows.forEach((r) => {
        try {
          const d = DB().departments.find((x) => ieq(x.name, r.department));
          if (!d) throw bad('Unknown department "' + r.department + '". Add the department first.');
          if (replace && !cleared.has(d.id)) {
            DB().faculty = DB().faculty.filter((f) => f.department_id !== d.id);
            cleared.add(d.id);
          }
          insFaculty(d.id, facultyInput(r));
          added++;
        } catch (e) {
          errors.push("Line " + r._line + ": " + e.message);
        }
      });
    });
    return { added, errors };
  });

  // ---------- staff: chat moderation ----------
  route("GET", "/staff/messages", (ctx) => {
    needStaff(ctx);
    return DB().messages.map(msgRow).filter((m) => m && like(ctx.query.q, m.body, m.name)).sort((a, b) => b.id - a.id).slice(0, 200);
  });
  route("DELETE", "/staff/messages/:id", (ctx) => {
    needStaff(ctx);
    const id = Number(ctx.params.id);
    const m = DB().messages.find((x) => x.id === id);
    if (m) {
      DB().messages = DB().messages.filter((x) => x.id !== id);
      events.toRoom(m.room, "message:deleted", { id, room: m.room });
    }
    return { ok: true };
  });

  // ---------- admin: student records, members, staff accounts ----------
  function registryInput(r) {
    const rec = {
      reg_no: str(r.reg_no || r.registration_no || r.registration_number, { max: 40, required: true, label: "Registration number" }),
      reg_year: Number(r.reg_year || r.year || r.year_of_registration),
      name: str(r.name, { max: 160, required: true, label: "Name" }),
      subject: str(r.subject || r.department, { max: 160, required: true, label: "Subject / department" }),
      college: str(r.college, { max: 200, label: "College" }),
    };
    if (!REG_NO_PATTERN.test(rec.reg_no)) throw bad('Registration number "' + rec.reg_no + '" does not match the expected format (' + REG_NO_EXAMPLE + ").");
    if (!Number.isInteger(rec.reg_year) || rec.reg_year < 1900 || rec.reg_year > new Date().getFullYear()) throw bad("Invalid year of registration.");
    return rec;
  }
  const upsertRec = (r) => {
    const ex = DB().registry.find((x) => x.reg_no === r.reg_no);
    if (ex) Object.assign(ex, r);
    else DB().registry.push({ ...r, added_at: nowStr() });
  };
  route("GET", "/staff/registry", (ctx) => {
    needAdmin(ctx);
    const rows = DB().registry
      .filter((r) => like(ctx.query.q, r.reg_no, r.name))
      .sort((a, b) => (a.added_at < b.added_at ? 1 : a.added_at > b.added_at ? -1 : 0) || (a.reg_no < b.reg_no ? -1 : 1))
      .slice(0, 100)
      .map((r) => ({ ...r, member_id: DB().members.find((m) => m.reg_no === r.reg_no)?.id ?? null }));
    return { total: DB().registry.length, rows };
  });
  route("POST", "/staff/registry", (ctx) => {
    needAdmin(ctx);
    upsertRec(registryInput(ctx.body));
    return [201, { ok: true }];
  });
  route("DELETE", "/staff/registry/:regNo", (ctx) => {
    needAdmin(ctx);
    const reg = decodeURIComponent(ctx.params.regNo);
    if (DB().members.some((m) => m.reg_no === reg)) throw bad("This record belongs to a registered member. Remove or suspend the member first.");
    DB().registry = DB().registry.filter((r) => r.reg_no !== reg);
    return { ok: true };
  });
  route("POST", "/staff/registry/import", (ctx) => {
    needAdmin(ctx);
    const rows = csvRows(ctx.files);
    const errors = [];
    let saved = 0;
    tx(() =>
      rows.forEach((r) => {
        try {
          upsertRec(registryInput(r));
          saved++;
        } catch (e) {
          errors.push("Line " + r._line + ": " + e.message);
        }
      })
    );
    return { added: saved, errors: errors.slice(0, 200), errorCount: errors.length };
  });
  route("GET", "/staff/members", (ctx) => {
    needAdmin(ctx);
    return DB().members.filter((m) => like(ctx.query.q, m.name, m.reg_no, m.email)).sort((a, b) => b.id - a.id).slice(0, 200).map(memberCols);
  });
  route("PATCH", "/staff/members/:id", (ctx) => {
    needAdmin(ctx);
    const status = oneOf(ctx.body.status, ["active", "suspended"], "Status");
    const m = memberById(Number(ctx.params.id));
    if (m) m.status = status;
    if (m && status === "suspended") events.kickMember(m.id);
    return { ok: true };
  });
  route("POST", "/staff/members/:id/reset-password", async (ctx) => {
    needAdmin(ctx);
    const m = memberById(Number(ctx.params.id));
    if (!m) throw new HttpError(404, "Member not found.");
    const temp = crypto.randomBytes(5).toString("hex");
    m.pass_hash = await hashPassword(temp);
    m.tv = (m.tv || 0) + 1;
    events.kickMember(m.id);
    return { temporaryPassword: temp };
  });
  route("GET", "/staff/accounts", (ctx) => {
    needAdmin(ctx);
    return DB().staff.map(({ id, username, name, role, created_at }) => ({ id, username, name, role, created_at }));
  });
  route("POST", "/staff/accounts", async (ctx) => {
    needAdmin(ctx);
    const username = str(ctx.body.username, { max: 60, required: true, label: "Staff ID" });
    const name = str(ctx.body.name, { max: 120, required: true, label: "Name" });
    const role = oneOf(ctx.body.role, ["admin", "editor"], "Role");
    if (String(ctx.body.password || "").length < 10) throw bad("Password must be at least 10 characters.");
    const pass_hash = await hashPassword(String(ctx.body.password));
    if (DB().staff.some((s) => ieq(s.username, username))) throw bad("That staff ID is taken.");
    DB().staff.push({ id: nextId("staff"), username, name, role, pass_hash, tv: 0, created_at: nowStr() });
    return [201, { ok: true }];
  });
  route("DELETE", "/staff/accounts/:id", (ctx) => {
    const st = needAdmin(ctx);
    if (Number(ctx.params.id) === st.id) throw bad("You cannot delete your own account.");
    DB().staff = DB().staff.filter((s) => s.id !== Number(ctx.params.id));
    return { ok: true };
  });

  // ---------- admin: backup & restore ----------
  route("GET", "/staff/backups", (ctx) => {
    needAdmin(ctx);
    return {
      storage: db.store.describe(),
      backupDir: cfg.BACKUP_DIR,
      intervalHours: cfg.BACKUP_INTERVAL_HOURS,
      keep: cfg.BACKUP_KEEP,
      backups: db.listBackups(),
    };
  });
  route("POST", "/staff/backups", async (ctx) => {
    needAdmin(ctx);
    const name = await db.writeBackupFile("manual");
    return [201, { name }];
  });
  route("POST", "/staff/restore", async (ctx) => {
    const st = needAdmin(ctx);
    if (!ctx.files.file) throw bad("Please choose a backup file (.json) to restore.");
    if (String(ctx.body.confirm || "") !== "RESTORE") throw bad('Type RESTORE in the confirmation box to replace all current data.');
    const text = ctx.files.file.buffer.toString("utf8");
    require("./db").Database.parseBackup(text); // validate before touching anything
    const safety = await db.writeBackupFile("before-restore");
    const counts = await db.restore(text);
    events.disconnectAll();
    console.log("Data restored from an uploaded backup by staff #" + st.id + ". Previous data saved as " + safety);
    return { ok: true, safetyBackup: safety, ...counts };
  });

  // ---------- dispatcher ----------
  async function handle(req, res) {
    const p = req.path;
    const method = req.method.toUpperCase();
    const files = {};
    (req.files || []).forEach((f) => {
      if (f.size) files[f.fieldname] = f;
    });
    const ctx = { req, res, body: req.body || {}, files, query: req.query || {}, params: {} };
    for (const r of R) {
      if (r.method !== method) continue;
      const m = r.re.exec(p);
      if (!m) continue;
      r.keys.forEach((k, i) => (ctx.params[k] = m[i + 1]));
      try {
        let out = await r.fn(ctx);
        let status = 200;
        if (Array.isArray(out) && out.length === 2 && typeof out[0] === "number") [status, out] = out;
        if (method !== "GET") db.markDirty();
        res.status(status).json(out);
      } catch (e) {
        if (!(e instanceof HttpError)) console.error(e);
        res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong. Please try again." });
      }
      return;
    }
    res.status(404).json({ error: "Not found." });
  }

  return { handle, memberFromCookies, canJoin, postMessage, staffFromCookies };
}

module.exports = { createApi };
