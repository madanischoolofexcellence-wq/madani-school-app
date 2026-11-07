// Working without internet on the school PC.
//
// While online (and an admin is signed in), the app keeps two things on this PC:
//   offline/base.db       a copy of the school's database, refreshed every 15 minutes
//   offline/b/<version>/  the same version of the school system as the website, fetched when it changes
// When the internet goes off, it copies base.db into offline/work/, starts the school system from
// offline/b/... on this PC (http://127.0.0.1:<port>, this PC only) and shows it in the window. That copy
// notes every change it makes. When the internet is back, the noted changes are sent to the website
// (POST /api/offline/apply), which merges them; the work folder is then kept in offline/sent/ for 30 sends.
//
// Plain Node + node:sqlite, no Electron here, so test-offline.js can run it with Node.
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { fork, execFile } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { readChanges, countChanges } = require("./offline-changes");

const REFRESH_COPY_MS = 15 * 60 * 1000;
const REFRESH_BUILD_MS = 60 * 60 * 1000;
const KEEP_SENT = 30;
const FILE_FOLDERS = ["uploads", "files"];
const isSqlite = (buf) => buf.length > 100 && buf.subarray(0, 15).toString("latin1") === "SQLite format 3";
const pad = (n) => String(n).padStart(2, "0");
/** UTC time as the school system stores it: "YYYY-MM-DD HH:MM:SS". */
const utcText = (d = new Date()) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const writeJson = (file, v) => { fs.writeFileSync(`${file}.part`, JSON.stringify(v, null, 2)); fs.renameSync(`${file}.part`, file); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(from) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once("error", () => tryPort(p + 1));
      srv.once("listening", () => srv.close(() => resolve(p)));
      srv.listen(p, "127.0.0.1");
    };
    tryPort(from);
  });
}
function waitForPort(port, ms) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", () => { s.destroy(); if (Date.now() > until) reject(new Error("the offline copy did not start in time")); else setTimeout(tick, 400); });
    };
    tick();
  });
}
function untar(file, dest) {
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  return new Promise((resolve, reject) => {
    execFile(tar, ["-xzf", file, "-C", dest], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) =>
      err ? reject(new Error(`could not unpack (${(stderr || err.message).toString().trim().slice(0, 300)})`)) : resolve());
  });
}
/** Every file under the photo and file folders of a data folder, as "uploads/x.jpg" paths. */
function listFiles(dataDir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(dataDir, ...rel.split("/")), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && !e.name.endsWith(".part")) out.push(r);
    }
  };
  for (const f of FILE_FOLDERS) walk(f);
  return out;
}

class Offline {
  /**
   * appUrl: the website. root: folder for everything offline. fetch: carries the website login.
   * photosFrom: the daily copy's "files" folder (photos are taken from it for offline use).
   * runServer(entry, options): starts the school system (Electron's fork, or Node's in the checks).
   */
  constructor({ appUrl, root, fetch, photosFrom, runServer, log }) {
    this.appUrl = appUrl;
    this.root = root;
    this.fetch = fetch;
    this.photosFrom = photosFrom;
    this.runServer = runServer || ((entry, opts) => fork(entry, [], opts));
    this.log = log || (() => {});
    this.child = null;
    this.port = null;
    this.lastCopyTry = 0;
    this.lastBuildTry = 0;
    this.lastSend = null;
    fs.mkdirSync(this.root, { recursive: true });
  }

  get p() {
    const r = this.root;
    return {
      base: path.join(r, "base.db"), baseInfo: path.join(r, "base.json"),
      builds: path.join(r, "b"), buildInfo: path.join(r, "build.json"),
      work: path.join(r, "work"), workInfo: path.join(r, "work.json"),
      sent: path.join(r, "sent"), serverLog: path.join(r, "offline-server.log"),
    };
  }

  build() {
    const info = readJson(this.p.buildInfo);
    if (!info || !info.dir) return null;
    const entry = path.join(this.p.builds, info.dir, "server.js");
    return fs.existsSync(entry) ? { ...info, entry } : null;
  }
  base() {
    const info = readJson(this.p.baseInfo);
    return info && fs.existsSync(this.p.base) ? info : null;
  }
  work() {
    const info = readJson(this.p.workInfo);
    return info && fs.existsSync(path.join(this.p.work, "school.db")) ? info : null;
  }
  get running() { return !!this.child && this.child.exitCode === null; }
  get localUrl() { return this.port ? `http://127.0.0.1:${this.port}` : null; }
  /** Offline work can start: the school system and a copy of the data are on this PC. */
  ready() { return !!this.build() && (!!this.work() || !!this.base()); }
  pendingChanges() {
    const w = this.work();
    return w ? countChanges(path.join(this.p.work, "school.db")) : 0;
  }

  status() {
    const b = this.base(), bd = this.build(), w = this.work();
    return {
      ready: this.ready(),
      running: this.running,
      copyAt: b ? b.at : null,
      buildVersion: bd ? bd.version : null,
      working: !!w,
      workFrom: w ? w.baseAt : null,
      changes: w ? this.pendingChanges() : 0,
      lastSend: this.lastSend,
    };
  }

  // ---------- kept ready while online ----------

  async isAdmin() {
    try {
      const r = await this.fetch(`${this.appUrl}/api/offline/apply`, { cache: "no-store" });
      if (r.status === 401) return { ok: false, why: "login" };
      if (!r.ok) return { ok: false, why: `the website answered ${r.status}` };
      const j = await r.json();
      return j.admin ? { ok: true } : { ok: false, why: "admin" };
    } catch (e) {
      return { ok: false, why: e && e.message ? e.message : String(e) };
    }
  }

  /** Fetch a fresh copy of the database. (Waiting offline work keeps its own copy of what it started from.) */
  async refreshCopy(force) {
    if (!force && Date.now() - this.lastCopyTry < REFRESH_COPY_MS) return "not due";
    this.lastCopyTry = Date.now();
    const at = utcText();
    const res = await this.fetch(`${this.appUrl}/api/backup/download?by=offline`, { cache: "no-store" });
    if (res.status === 401 || res.status === 403) return "needs an admin signed in";
    if (!res.ok) return `the website answered ${res.status}`;
    const data = Buffer.from(await res.arrayBuffer());
    if (!isSqlite(data)) return "what arrived was not a database";
    fs.writeFileSync(`${this.p.base}.part`, data);
    fs.renameSync(`${this.p.base}.part`, this.p.base);
    writeJson(this.p.baseInfo, { at, size: data.length });
    return `copy of the data saved (${Math.round(data.length / 1024)} KB)`;
  }

  /** Fetch the website's version of the school system when it is not on this PC yet. */
  async refreshBuild(force) {
    if (!force && Date.now() - this.lastBuildTry < REFRESH_BUILD_MS) return "not due";
    this.lastBuildTry = Date.now();
    const vr = await this.fetch(`${this.appUrl}/api/version`, { cache: "no-store" });
    if (!vr.ok) return `the website answered ${vr.status}`;
    const version = String((await vr.json()).version || "");
    const have = this.build();
    if (have && have.version === version) return "already the newest";
    if (this.running) return "waiting (the offline copy is in use)";
    const res = await this.fetch(`${this.appUrl}/api/offline/bundle`, { cache: "no-store" });
    if (res.status === 401 || res.status === 403) return "needs an admin signed in";
    if (res.status === 404) return "the website has no offline copy to give yet";
    if (!res.ok || !res.body) return `the website answered ${res.status}`;
    fs.mkdirSync(this.p.builds, { recursive: true });
    const dir = crypto.createHash("sha1").update(version).digest("hex").slice(0, 10);
    const tgz = path.join(this.root, "build.tgz");
    const into = path.join(this.p.builds, `${dir}.part`);
    try {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tgz));
      fs.rmSync(into, { recursive: true, force: true });
      fs.mkdirSync(into, { recursive: true });
      await untar(tgz, into);
      if (!fs.existsSync(path.join(into, "server.js"))) throw new Error("the copy has no server.js");
      fs.rmSync(path.join(this.p.builds, dir), { recursive: true, force: true });
      fs.renameSync(into, path.join(this.p.builds, dir));
    } finally {
      fs.rmSync(tgz, { force: true });
      fs.rmSync(into, { recursive: true, force: true });
    }
    writeJson(this.p.buildInfo, { version, dir, at: utcText() });
    // Older versions are removed (the one just installed stays).
    for (const d of fs.readdirSync(this.p.builds)) if (d !== dir) fs.rmSync(path.join(this.p.builds, d), { recursive: true, force: true });
    return `school system ${version.slice(0, 7)} saved for offline use`;
  }

  // ---------- offline ----------

  /** Start the school system on this PC (from the waiting work, or a fresh copy of the data). Returns its address. */
  async start() {
    if (this.running) return this.localUrl;
    const build = this.build();
    if (!build) throw new Error("The school system has not been saved on this PC yet. It is saved while the internet is on and an admin is signed in.");
    let work = this.work();
    if (!work) {
      const base = this.base();
      if (!base) throw new Error("There is no copy of the data on this PC yet. It is saved while the internet is on and an admin is signed in.");
      fs.rmSync(this.p.work, { recursive: true, force: true });
      fs.mkdirSync(this.p.work, { recursive: true });
      fs.copyFileSync(this.p.base, path.join(this.p.work, "school.db"));
      fs.copyFileSync(this.p.base, path.join(this.p.work, "base.db")); // what the PC started from, never changed
      const copied = [];
      for (const f of FILE_FOLDERS) {
        const from = this.photosFrom && path.join(this.photosFrom, f);
        if (from && fs.existsSync(from)) {
          try { fs.cpSync(from, path.join(this.p.work, f), { recursive: true }); } catch (e) { this.log(`photos not copied: ${e.message}`); }
        }
      }
      copied.push(...listFiles(this.p.work));
      fs.writeFileSync(path.join(this.p.work, "copied-files.json"), JSON.stringify(copied));
      work = { session: `${os.hostname().replace(/[^\w-]/g, "").slice(0, 20) || "pc"}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`, baseAt: base.at, startedAt: utcText(), version: build.version };
      writeJson(this.p.workInfo, work);
    }
    this.port = await freePort(37641);
    const logFd = fs.openSync(this.p.serverLog, "w");
    this.child = this.runServer(build.entry, {
      cwd: path.dirname(build.entry),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        PORT: String(this.port),
        HOSTNAME: "127.0.0.1", // this PC only
        SMS_DATA_DIR: this.p.work,
        SMS_OFFLINE_MODE: "1",
        SMS_OFFLINE_SINCE: work.baseAt,
        SECURE_COOKIES: "",
      },
      stdio: ["ignore", logFd, logFd, "ipc"],
    });
    this.child.once("exit", () => { try { fs.closeSync(logFd); } catch { /* closed */ } });
    try {
      await waitForPort(this.port, 60000);
    } catch (e) {
      await this.stop();
      let tail = "";
      try { tail = fs.readFileSync(this.p.serverLog, "utf8").slice(-600); } catch { /* no log */ }
      throw new Error(`${e.message}${tail ? `\n\n${tail}` : ""}`);
    }
    return this.localUrl;
  }

  async stop() {
    const c = this.child;
    this.child = null;
    if (!c || c.exitCode !== null) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 8000);
      c.once("exit", () => { clearTimeout(t); resolve(); });
      try { c.kill(); } catch { clearTimeout(t); resolve(); }
    });
  }

  /**
   * Send the offline work to the website. Only when the offline copy is stopped and an admin is signed in.
   * Returns { ok, message, summary? }. The work stays on this PC until the website has taken it.
   */
  async send() {
    if (this.running) return { ok: false, message: "The offline copy is still open." };
    const work = this.work();
    if (!work) return { ok: true, nothing: true, message: "Nothing waiting to be sent." };
    const admin = await this.isAdmin();
    if (!admin.ok) {
      const message = admin.why === "login" || admin.why === "admin"
        ? "The offline work is waiting on this PC. Sign in here as an admin and it is sent by itself."
        : `The offline work is waiting on this PC (${admin.why}).`;
      return { ok: false, waiting: true, message };
    }
    const db = path.join(this.p.work, "school.db");
    const changes = readChanges(db, path.join(this.p.work, "base.db"));

    // Photos and files added offline go first, so the rows that name them find them.
    let copied = [];
    try { copied = JSON.parse(fs.readFileSync(path.join(this.p.work, "copied-files.json"), "utf8")); } catch { /* none */ }
    const had = new Set(copied);
    let files = 0;
    for (const rel of listFiles(this.p.work)) {
      if (had.has(rel)) continue;
      const r = await this.fetch(`${this.appUrl}/api/offline/file?path=${encodeURIComponent(rel)}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: fs.readFileSync(path.join(this.p.work, ...rel.split("/"))),
      });
      if (!r.ok) return { ok: false, message: `A photo or file could not be sent (${rel}: ${r.status}). It is tried again later.` };
      files++;
    }

    const res = await this.fetch(`${this.appUrl}/api/offline/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: work.session, pcName: os.hostname(), offlineFrom: work.baseAt, changes }),
    });
    let j = {};
    try { j = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !j.ok) return { ok: false, message: `The website did not take the offline work (${j.error || res.status}). It is tried again later.` };

    // Taken: keep the work for a while, then start fresh from the online data next time.
    fs.mkdirSync(this.p.sent, { recursive: true });
    try { fs.renameSync(db, path.join(this.p.sent, `${work.session}.db`)); } catch (e) { this.log(`could not keep the sent work: ${e.message}`); }
    const kept = fs.readdirSync(this.p.sent).filter((f) => f.endsWith(".db")).sort();
    for (const f of kept.slice(0, Math.max(0, kept.length - KEEP_SENT))) fs.rmSync(path.join(this.p.sent, f), { force: true });
    fs.rmSync(this.p.workInfo, { force: true });
    fs.rmSync(this.p.work, { recursive: true, force: true });
    this.lastCopyTry = 0; // a fresh copy at the next chance

    const message = `Offline work sent: ${j.total} change${j.total === 1 ? "" : "s"}${files ? ` and ${files} file${files === 1 ? "" : "s"}` : ""}. ` +
      `${j.applied} saved, ${j.same} already the same online` +
      (j.conflicts ? `, ${j.conflicts} to decide at System → Security & backups → Offline work.` : ".");
    this.lastSend = { at: new Date().toISOString(), message };
    return { ok: true, message, summary: j, conflicts: j.conflicts || 0 };
  }
}

module.exports = { Offline, utcText, sleep };
