"use strict";
// Reads settings from environment variables, optionally loaded from a .env file
// in the project folder. Every path is resolved relative to the project, so the
// same folder works unchanged on Windows, macOS and Linux.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(ROOT, ".env"));

const env = process.env;
const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v, d) => (v === undefined || v === "" || isNaN(Number(v)) ? d : Number(v));
const dir = (v, d) => path.resolve(ROOT, v || d);

const DATA_DIR = dir(env.DATA_DIR, "data");

module.exports = {
  ROOT,
  PORT: num(env.PORT, 3000),
  HOST: env.HOST || "0.0.0.0",
  DATA_DIR,
  BACKUP_DIR: dir(env.BACKUP_DIR, path.join(DATA_DIR, "backups")),
  // When DATABASE_URL is set (PostgreSQL), all data lives in that database instead of DATA_DIR,
  // so several computers / a cloud host can share one copy.
  DATABASE_URL: env.DATABASE_URL || "",
  SESSION_SECRET: env.SESSION_SECRET || "",
  SESSION_DAYS: num(env.SESSION_DAYS, 30),
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || "",
  SEED_DEMO_DATA: bool(env.SEED_DEMO_DATA, true),
  BACKUP_INTERVAL_HOURS: num(env.BACKUP_INTERVAL_HOURS, 24),
  BACKUP_KEEP: num(env.BACKUP_KEEP, 14),
  MAX_UPLOAD_MB: num(env.MAX_UPLOAD_MB, 10),
  TRUST_PROXY: bool(env.TRUST_PROXY, true),
};
