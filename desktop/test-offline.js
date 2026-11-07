// Check of offline work (not shipped), run by the school system's GitHub check with plain Node:
//   node test-offline.js <built school system folder> <packed build .tgz>
// It starts the school system as "the website", lets offline.js get ready from it exactly as the app does,
// works offline on this machine, then sends the work back and looks at the website's database.
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, fork } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { Offline } = require("./offline");

const [standalone, bundle] = process.argv.slice(2).map((p) => path.resolve(p));
if (!standalone || !bundle) { console.error("usage: node test-offline.js <standalone folder> <bundle.tgz>"); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mse-pc-"));
const siteData = path.join(tmp, "website-data");
const photos = path.join(tmp, "daily-copy-files");
fs.mkdirSync(siteData, { recursive: true });
fs.mkdirSync(path.join(photos, "uploads"), { recursive: true });
fs.writeFileSync(path.join(photos, "uploads", "old-photo.jpg"), "old photo");

const PORT = 4101;
const SITE = `http://127.0.0.1:${PORT}`;
const TOKEN = "pc-app-check-session";
const ok = (what) => console.log(`  ok  ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Like the app's window: every request carries the website login (and the offline copy gets the same cookie).
const appFetch = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), Cookie: `sms_session=${TOKEN}` } });

async function up(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${url}/api/version`)).ok) return; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error(`${url} did not start`);
}

async function main() {
  const site = spawn(process.execPath, [path.join(standalone, "server.js")], {
    cwd: standalone,
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), HOSTNAME: "127.0.0.1", SMS_DATA_DIR: siteData, OFFLINE_BUNDLE: bundle },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const offline = new Offline({
    appUrl: SITE, root: path.join(tmp, "pc"), fetch: appFetch, photosFrom: photos,
    runServer: (entry, opts) => fork(entry, [], opts), log: (m) => console.log(`    [offline] ${m}`),
  });
  try {
    await up(SITE);
    const siteDb = new DatabaseSync(path.join(siteData, "school.db"));
    siteDb.exec("PRAGMA busy_timeout = 5000");
    siteDb.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    siteDb.prepare("INSERT INTO sessions (token, user_id) VALUES (?, (SELECT id FROM users WHERE role='ADMIN' ORDER BY id LIMIT 1))").run(TOKEN);
    const before = Number(siteDb.prepare("INSERT INTO students (student_uid, name, class) VALUES ('PC-1', 'On the website', 'KG')").run().lastInsertRowid);

    // ---------- getting ready while online ----------
    assert.equal(offline.ready(), false);
    assert.deepEqual(await offline.isAdmin(), { ok: true });
    assert.match(await offline.refreshCopy(true), /copy of the data saved/);
    assert.match(await offline.refreshBuild(true), /saved for offline use/);
    assert.equal(await offline.refreshBuild(true), "already the newest");
    assert.equal(offline.ready(), true);
    const version = (await (await fetch(`${SITE}/api/version`)).json()).version;
    assert.equal(offline.status().buildVersion, version);
    ok("while online, the PC keeps a copy of the data and the website's own version of the school system");

    // ---------- offline ----------
    const local = await offline.start();
    const dash = await (await appFetch(`${local}/dashboard`, { redirect: "manual" })).text();
    assert.ok(dash.includes("Offline — working on this PC"), "offline dashboard with the website login");
    assert.ok(fs.existsSync(path.join(offline.p.work, "uploads", "old-photo.jpg")), "photos from the daily copy are there offline");
    ok(`offline copy runs on this PC (${local}) with the same login and the photos`);

    const work = new DatabaseSync(path.join(offline.p.work, "school.db"));
    work.exec("PRAGMA busy_timeout = 5000");
    const made = Number(work.prepare("INSERT INTO students (student_uid, name, class, photo_url) VALUES ('PC-2', 'Admitted offline', 'KG', '/uploads/new-photo.jpg')").run().lastInsertRowid);
    work.prepare("UPDATE students SET class='Nursery' WHERE id=?").run(before);
    work.close();
    fs.writeFileSync(path.join(offline.p.work, "uploads", "new-photo.jpg"), "photo taken offline");
    siteDb.prepare("UPDATE students SET name='Renamed on the website' WHERE id=?").run(before); // meanwhile online
    assert.ok(offline.pendingChanges() >= 2);
    const list = await (await appFetch(`${local}/dashboard/students`)).text();
    assert.ok(list.includes("Admitted offline"));
    ok("work done offline is visible offline and noted");

    assert.equal((await offline.send()).ok, false, "not sent while the offline copy is open");
    await offline.stop();
    assert.equal(offline.running, false);

    // ---------- back online ----------
    const r = await offline.send();
    assert.equal(r.ok, true, r.message);
    assert.equal(r.conflicts, 0, r.message);
    console.log(`    ${r.message}`);
    const row = (id) => siteDb.prepare("SELECT name, class FROM students WHERE id=?").get(id);
    assert.deepEqual({ ...row(before) }, { name: "Renamed on the website", class: "Nursery" }, "both sides' changes kept");
    assert.deepEqual({ ...row(made) }, { name: "Admitted offline", class: "KG" });
    assert.equal(fs.readFileSync(path.join(siteData, "uploads", "new-photo.jpg"), "utf8"), "photo taken offline");
    assert.ok(!fs.existsSync(path.join(siteData, "uploads", "old-photo.jpg")), "photos that came from the website are not sent back");
    assert.equal(offline.work(), null, "work cleared after sending");
    assert.equal(fs.readdirSync(offline.p.sent).length, 1, "sent work kept on the PC");
    assert.equal((await offline.send()).nothing, true);
    ok("back online: the offline work and the new photo reached the website, merged with the website's own change");

    // ---------- a second time offline starts from fresh data ----------
    await offline.refreshCopy(true);
    const again = await offline.start();
    const list2 = await (await appFetch(`${again}/dashboard/students`)).text();
    assert.ok(list2.includes("Renamed on the website") && list2.includes("Admitted offline"));
    await offline.stop();
    const r2 = await offline.send();
    assert.equal(r2.ok, true);
    assert.equal(r2.summary.total, 0);
    ok("the next time offline starts from the website's current data");

    siteDb.close();
  } finally {
    await offline.stop();
    site.kill();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nPC app offline check: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
