// Build check only (not shipped): proves the SQLite reader that zkbio.js relies on works inside this Electron version.
const { app } = require("electron");
app.whenReady().then(() => {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('ok')");
    const row = db.prepare("SELECT a FROM t").get();
    db.close();
    if (row.a !== "ok") throw new Error("unexpected answer");
    console.log(`node:sqlite works in Electron ${process.versions.electron} (Node ${process.versions.node})`);
    app.exit(0);
  } catch (e) {
    console.error(`node:sqlite does NOT work in Electron ${process.versions.electron}: ${e && e.message}`);
    app.exit(1);
  }
});
