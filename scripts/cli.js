"use strict";
// Command-line maintenance tools. Run from the project folder:
//   npm run backup                         -> writes a full backup into the backups folder
//   npm run backup -- D:\usb\cu.json       -> writes it to a path you choose
//   npm run restore -- path\to\backup.json -> replaces all data with that backup
//   npm run reset-password -- cu-admin "New password here"
//
// Stop the server before "restore" or "reset-password" when using the folder storage
// (the running server would otherwise overwrite the change with its own copy).
const fs = require("fs");
const path = require("path");
const cfg = require("../src/config");
const { createStore, atomicWrite } = require("../src/store");
const { Database } = require("../src/db");
const { hashPassword } = require("../src/auth");

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const store = createStore(cfg);
  const db = new Database(store, cfg);
  await db.open();
  try {
    if (cmd === "backup") {
      if (args[0]) {
        const out = path.resolve(process.cwd(), args[0]);
        atomicWrite(out, JSON.stringify(await db.exportBackup()));
        console.log("Backup written to " + out);
      } else {
        const name = await db.writeBackupFile("manual");
        console.log("Backup written to " + path.join(cfg.BACKUP_DIR, name));
      }
    } else if (cmd === "restore") {
      if (!args[0]) throw new Error("Usage: npm run restore -- <backup-file.json>");
      const text = fs.readFileSync(path.resolve(process.cwd(), args[0]), "utf8");
      Database.parseBackup(text);
      const safety = await db.writeBackupFile("before-restore");
      const r = await db.restore(text);
      console.log("Restored: " + r.registry + " student records, " + r.members + " members, " + r.staff + " staff accounts.");
      console.log("The previous data was saved first as " + path.join(cfg.BACKUP_DIR, safety));
    } else if (cmd === "reset-password") {
      const [username, pw] = args;
      if (!username || !pw) throw new Error('Usage: npm run reset-password -- <staff-id> "<new password, min 10 characters>"');
      if (pw.length < 10) throw new Error("The new password must be at least 10 characters.");
      const s = db.doc.staff.find((x) => x.username.toLowerCase() === username.toLowerCase());
      if (!s) throw new Error('No staff account "' + username + '". Existing: ' + db.doc.staff.map((x) => x.username).join(", "));
      s.pass_hash = await hashPassword(pw);
      s.tv = (s.tv || 0) + 1;
      await db.flush();
      console.log('Password changed for staff account "' + s.username + '".');
    } else {
      console.log("Commands: backup [file] | restore <file> | reset-password <staff-id> <password>");
    }
  } finally {
    await db.saving;
    await store.close();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
