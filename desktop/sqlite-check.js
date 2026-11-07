// Build check only (not shipped): proves that inside this Electron version
//  1. the SQLite reader that zkbio.js and offline-changes.js rely on works, and
//  2. a child started the way offline.js starts the offline school system (fork + ELECTRON_RUN_AS_NODE)
//     runs as Node and can open SQLite too (the school system needs it).
const { app } = require("electron");
const { fork } = require("child_process");
const path = require("path");

if (process.env.ELECTRON_RUN_AS_NODE === "1") {
  // The child.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('ok')");
  process.send({ ok: db.prepare("SELECT a FROM t").get().a === "ok", node: process.versions.node });
  db.close();
} else {
  app.whenReady().then(async () => {
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(":memory:");
      db.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('ok')");
      const row = db.prepare("SELECT a FROM t").get();
      db.close();
      if (row.a !== "ok") throw new Error("unexpected answer");
      console.log(`node:sqlite works in Electron ${process.versions.electron} (Node ${process.versions.node})`);

      const child = fork(path.join(__dirname, "sqlite-check.js"), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
      const answer = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("the child did not answer")), 20000);
        child.once("message", (m) => { clearTimeout(t); resolve(m); });
        child.once("exit", (code) => { clearTimeout(t); reject(new Error(`the child stopped (${code})`)); });
      });
      if (!answer.ok) throw new Error("SQLite failed in the child");
      console.log(`a child started as Node runs Node ${answer.node} with node:sqlite (the offline school system can run)`);
      app.exit(0);
    } catch (e) {
      console.error(`Check failed in Electron ${process.versions.electron}: ${e && e.message}`);
      app.exit(1);
    }
  });
}
