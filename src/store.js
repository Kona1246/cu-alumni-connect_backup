"use strict";
// Storage layer. Two interchangeable back ends with the same interface:
//
//   FileStore     – everything inside one folder (DATA_DIR, default ./data).
//                   Copy that folder to another computer and the site, its members,
//                   passwords, chat, attachments and backups move with it.
//   PostgresStore – used when DATABASE_URL is set. One shared database that any
//                   number of computers / a cloud host can point at.
//
// The application keeps the whole database document in memory and calls saveDoc()
// after changes; attachments are stored separately so the document stays small.
const fs = require("fs");
const path = require("path");

function atomicWrite(file, data) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows can briefly lock a file (antivirus, indexer); retry a few times.
      if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      const until = Date.now() + 50 * (i + 1);
      while (Date.now() < until);
    }
  }
}

class FileStore {
  constructor(dataDir) {
    this.kind = "file";
    this.dir = dataDir;
    this.dbFile = path.join(dataDir, "database.json");
    this.kvFile = path.join(dataDir, "settings.json");
    this.filesDir = path.join(dataDir, "uploads");
  }
  async init() {
    fs.mkdirSync(this.filesDir, { recursive: true });
  }
  describe() {
    return "folder " + this.dir;
  }
  async loadDoc() {
    if (!fs.existsSync(this.dbFile)) return null;
    return JSON.parse(fs.readFileSync(this.dbFile, "utf8"));
  }
  async saveDoc(doc) {
    atomicWrite(this.dbFile, JSON.stringify(doc));
  }
  async getKV(key) {
    if (!fs.existsSync(this.kvFile)) return null;
    const o = JSON.parse(fs.readFileSync(this.kvFile, "utf8"));
    return o[key] ?? null;
  }
  async setKV(key, value) {
    const o = fs.existsSync(this.kvFile) ? JSON.parse(fs.readFileSync(this.kvFile, "utf8")) : {};
    o[key] = value;
    atomicWrite(this.kvFile, JSON.stringify(o, null, 2));
  }
  fileName(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("bad file id");
    return path.join(this.filesDir, id);
  }
  async putFile(id, buf) {
    atomicWrite(this.fileName(id), buf);
  }
  async getFile(id) {
    try {
      return fs.readFileSync(this.fileName(id));
    } catch (e) {
      return null;
    }
  }
  async deleteFile(id) {
    try {
      fs.unlinkSync(this.fileName(id));
    } catch (e) {}
  }
  async close() {}
}

class PostgresStore {
  constructor(url) {
    this.kind = "postgres";
    this.url = url;
  }
  async init() {
    let pg;
    try {
      pg = require("pg");
    } catch (e) {
      throw new Error('DATABASE_URL is set but the "pg" package is not installed. Run: npm install pg');
    }
    const local = /localhost|127\.0\.0\.1/.test(this.url) || /sslmode=disable/.test(this.url);
    this.pool = new pg.Pool({ connectionString: this.url, ssl: local ? false : { rejectUnauthorized: false } });
    await this.pool.query("CREATE TABLE IF NOT EXISTS cu_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    await this.pool.query("CREATE TABLE IF NOT EXISTS cu_files (id TEXT PRIMARY KEY, data BYTEA NOT NULL)");
  }
  describe() {
    return "PostgreSQL database " + this.url.replace(/\/\/([^:@/]+)(:[^@]*)?@/, "//$1:***@");
  }
  async loadDoc() {
    const v = await this.getKV("database");
    return v ? JSON.parse(v) : null;
  }
  async saveDoc(doc) {
    await this.setKV("database", JSON.stringify(doc));
  }
  async getKV(key) {
    const r = await this.pool.query("SELECT v FROM cu_kv WHERE k=$1", [key]);
    return r.rows[0] ? r.rows[0].v : null;
  }
  async setKV(key, value) {
    await this.pool.query("INSERT INTO cu_kv (k, v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v", [key, value]);
  }
  async putFile(id, buf) {
    await this.pool.query("INSERT INTO cu_files (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data", [id, buf]);
  }
  async getFile(id) {
    const r = await this.pool.query("SELECT data FROM cu_files WHERE id=$1", [id]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  async deleteFile(id) {
    await this.pool.query("DELETE FROM cu_files WHERE id=$1", [id]);
  }
  async close() {
    await this.pool.end();
  }
}

function createStore(cfg) {
  return cfg.DATABASE_URL ? new PostgresStore(cfg.DATABASE_URL) : new FileStore(cfg.DATA_DIR);
}

module.exports = { createStore, atomicWrite };
