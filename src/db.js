"use strict";
// In-memory database document + persistence, seeding, backups and restore.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { atomicWrite } = require("./store");
const { hashPassword } = require("./auth");

const SCHEMA_VERSION = 2;
const BACKUP_FORMAT = "cu-alumni-connect-backup";
const COLLECTIONS = ["registry", "members", "staff", "notices", "messages", "feedback", "support", "officials", "campuses", "departments", "faculty", "files"];

const nowStr = (ms = Date.now()) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

const MIME = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const mimeOf = (name) => MIME[String(name).split(".").pop().toLowerCase()] || "application/octet-stream";
const newFileId = () => crypto.randomBytes(12).toString("hex");
const fileUrl = (f) => "/files/" + f.id + "/" + encodeURIComponent(f.name);

class Database {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.doc = null;
    this.saveTimer = null;
    this.saving = Promise.resolve();
  }

  // ---------- lifecycle ----------
  async open() {
    await this.store.init();
    let doc = await this.store.loadDoc();
    const fresh = !doc;
    if (fresh) doc = await this.freshDoc();
    this.doc = await this.migrate(doc);
    if (fresh) await this.flush();
    return { fresh };
  }

  async freshDoc() {
    const seedFile = path.join(this.cfg.ROOT, "seed", "seed.json");
    const s = JSON.parse(fs.readFileSync(seedFile, "utf8"));
    const t = Date.now();
    s.messages.forEach((m) => {
      m.created_at = nowStr(t - (m.ago || 0) * 864e5);
      delete m.ago;
    });
    s.feedback.forEach((f) => {
      f.created_at = nowStr(t - (f.ago || 0) * 864e5);
      delete f.ago;
    });
    if (!this.cfg.SEED_DEMO_DATA) {
      // Start with the directories and student records but no demo people or posts.
      s.members = [];
      s.messages = [];
      s.feedback = [];
      s.support = [];
      s.staff = s.staff.filter((x) => x.role === "admin").slice(0, 1);
      s.staff[0].name = "Alumni Cell";
    }
    const admin = s.staff.find((x) => x.role === "admin");
    if (this.cfg.ADMIN_PASSWORD && admin) admin.pass_hash = await hashPassword(this.cfg.ADMIN_PASSWORD);
    return s;
  }

  async migrate(doc) {
    delete doc.session; // the browser-only version kept the signed-in user inside the data
    doc.seq = doc.seq || {};
    COLLECTIONS.forEach((c) => (doc[c] = Array.isArray(doc[c]) ? doc[c] : []));
    doc.members.forEach((m) => (m.tv = m.tv || 0));
    doc.staff.forEach((m) => (m.tv = m.tv || 0));
    // Attachments that were embedded as data: URLs (browser-only version) become real files.
    for (const n of doc.notices) {
      if (typeof n.attachment === "string" && n.attachment.startsWith("data:")) {
        const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(n.attachment);
        if (m) {
          const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
          const f = { id: newFileId(), name: n.attachment_name || "attachment", mime: m[1] || mimeOf(n.attachment_name || ""), size: buf.length, created_at: nowStr() };
          await this.store.putFile(f.id, buf);
          doc.files.push(f);
          n.attachment = fileUrl(f);
        } else n.attachment = "";
      }
    }
    for (const c of COLLECTIONS) {
      if (c === "support" || c === "registry" || c === "files") continue;
      const max = doc[c].reduce((a, x) => Math.max(a, Number(x.id) || 0), 0);
      doc.seq[c] = Math.max(doc.seq[c] || 0, max);
    }
    doc.schema_version = SCHEMA_VERSION;
    return doc;
  }

  // ---------- persistence ----------
  markDirty() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((e) => console.error("Could not save the database:", e));
    }, 200);
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const snapshot = JSON.stringify(this.doc);
    this.saving = this.saving.then(() => this.store.saveDoc(JSON.parse(snapshot)));
    return this.saving;
  }

  nextId(t) {
    return (this.doc.seq[t] = (this.doc.seq[t] || 0) + 1);
  }

  // ---------- attachments ----------
  async addFile(name, buf) {
    const f = { id: newFileId(), name: String(name).slice(0, 200), mime: mimeOf(name), size: buf.length, created_at: nowStr() };
    await this.store.putFile(f.id, buf);
    this.doc.files.push(f);
    return f;
  }

  async removeFileByUrl(url) {
    const m = /^\/files\/([a-f0-9]+)\//.exec(String(url || ""));
    if (!m) return;
    this.doc.files = this.doc.files.filter((f) => f.id !== m[1]);
    await this.store.deleteFile(m[1]);
  }

  // ---------- backups ----------
  async exportBackup() {
    await this.flush();
    const files = {};
    for (const f of this.doc.files) {
      const buf = await this.store.getFile(f.id);
      if (buf) files[f.id] = Buffer.from(buf).toString("base64");
    }
    return { format: BACKUP_FORMAT, version: 1, created_at: new Date().toISOString(), database: this.doc, files };
  }

  // Accepts a backup made by this server, or the raw data exported from the old
  // browser-only version (localStorage key "cu_alumni_demo_db_v1").
  static parseBackup(text) {
    let o;
    try {
      o = JSON.parse(String(text).replace(/^﻿/, ""));
    } catch (e) {
      throw new Error("This file is not a valid backup (it is not JSON).");
    }
    if (typeof o === "string") o = JSON.parse(o); // localStorage value copied as a JSON string
    const doc = o && o.format === BACKUP_FORMAT ? o.database : o;
    const files = (o && o.format === BACKUP_FORMAT && o.files) || {};
    const need = ["registry", "members", "staff", "notices", "departments"];
    if (!doc || typeof doc !== "object" || need.some((k) => !Array.isArray(doc[k])))
      throw new Error("This file does not look like a CU Alumni Connect backup.");
    if (!doc.staff.some((s) => s.role === "admin")) throw new Error("The backup has no admin staff account, so nobody could sign in to the staff console. Restore cancelled.");
    return { doc, files };
  }

  async restore(text) {
    const { doc, files } = Database.parseBackup(text);
    for (const [id, b64] of Object.entries(files)) {
      if (/^[a-zA-Z0-9_-]+$/.test(id)) await this.store.putFile(id, Buffer.from(b64, "base64"));
    }
    this.doc = await this.migrate(doc);
    await this.flush();
    return { members: this.doc.members.length, registry: this.doc.registry.length, staff: this.doc.staff.length };
  }

  // Writes a backup file to BACKUP_DIR and keeps the newest BACKUP_KEEP automatic ones.
  async writeBackupFile(label = "auto") {
    fs.mkdirSync(this.cfg.BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
    const name = "cu-backup-" + (label === "auto" ? "" : label + "-") + stamp + ".json";
    atomicWrite(path.join(this.cfg.BACKUP_DIR, name), JSON.stringify(await this.exportBackup()));
    this.pruneBackups();
    return name;
  }

  listBackups() {
    if (!fs.existsSync(this.cfg.BACKUP_DIR)) return [];
    return fs
      .readdirSync(this.cfg.BACKUP_DIR)
      .filter((n) => /^cu-backup-[\w-]+\.json$/.test(n))
      .map((name) => {
        const st = fs.statSync(path.join(this.cfg.BACKUP_DIR, name));
        return { name, size: st.size, created_at: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  pruneBackups() {
    const keep = Math.max(1, this.cfg.BACKUP_KEEP);
    const auto = this.listBackups().filter((b) => /^cu-backup-\d/.test(b.name));
    auto.slice(keep).forEach((b) => fs.unlinkSync(path.join(this.cfg.BACKUP_DIR, b.name)));
  }

  backupPath(name) {
    if (!/^cu-backup-[\w-]+\.json$/.test(name)) return null;
    const p = path.join(this.cfg.BACKUP_DIR, name);
    return fs.existsSync(p) ? p : null;
  }

  startAutoBackups() {
    const hours = this.cfg.BACKUP_INTERVAL_HOURS;
    if (!(hours > 0)) return;
    const due = () => {
      const last = this.listBackups().find((b) => /^cu-backup-\d/.test(b.name));
      return !last || Date.now() - new Date(last.created_at).getTime() >= hours * 3600e3;
    };
    const run = () => {
      if (due()) this.writeBackupFile("auto").then((n) => console.log("Automatic backup written: " + n), (e) => console.error("Automatic backup failed:", e));
    };
    run();
    setInterval(run, 15 * 60 * 1000).unref();
  }
}

module.exports = { Database, nowStr, fileUrl };
