// A copy of the school's data on this PC, so the school always holds its own data and does not depend
// on the hosting. Once a day, while an admin is signed in here, the app fetches the whole database
// (one file per day, 30 days kept) and any new photos or uploaded files.
//
//   <folder>/madani-school-YYYY-MM-DD.db   the database for that day
//   <folder>/files/uploads/..., files/...   photos and uploaded files (only new or changed ones are fetched)
//   <folder>/READ ME.txt
const fs = require("fs");
const path = require("path");

const KEEP_DAYS = 30;
const MAX_FILES_PER_RUN = 500;
const pad = (n) => String(n).padStart(2, "0");
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dbName = (day) => `madani-school-${day}.db`;
const isSqlite = (buf) => buf.length > 100 && buf.subarray(0, 15).toString("latin1") === "SQLite format 3";

const README = [
  "Madani School - copies of the school's data",
  "",
  "The Madani School app saves these by itself, once a day.",
  "  madani-school-YYYY-MM-DD.db : the whole database for that day (students, staff, attendance, fees, ...).",
  "  files\\                      : photos and uploaded files.",
  "",
  "Do not edit these files. To use a copy, give the newest .db file and the files folder to the person",
  "who looks after the software (see HANDOVER.md in the GitHub repository madani-school-management).",
  "Keep this folder private: it holds everyone's details and the logins.",
].join("\r\n");

function prune(folder) {
  const days = fs.readdirSync(folder).filter((f) => /^madani-school-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse();
  for (const f of days.slice(KEEP_DAYS)) { try { fs.unlinkSync(path.join(folder, f)); } catch { /* in use: removed next time */ } }
}

/** When the newest database copy in the folder was made ("" when there is none). */
function newestCopy(folder) {
  try {
    const f = fs.readdirSync(folder).filter((x) => /^madani-school-\d{4}-\d{2}-\d{2}\.db$/.test(x)).sort().pop();
    return f ? f.slice("madani-school-".length, -3) : "";
  } catch { return ""; }
}

async function copyFiles(appUrl, fetch, folder) {
  const res = await fetch(`${appUrl}/api/backup/files`, { cache: "no-store" });
  if (!res.ok) return { fetched: 0, left: 0, total: 0 };
  const list = ((await res.json()).files || []).filter((f) => f && typeof f.path === "string" && !f.path.includes("..") && !path.isAbsolute(f.path));
  const root = path.join(folder, "files");
  let fetched = 0, left = 0;
  for (const f of list) {
    const dest = path.join(root, ...f.path.split("/"));
    let have = -1;
    try { have = fs.statSync(dest).size; } catch { /* not copied yet */ }
    if (have === f.size) continue;
    if (fetched >= MAX_FILES_PER_RUN) { left++; continue; }
    const r = await fetch(`${appUrl}/api/backup/files?path=${encodeURIComponent(f.path)}`, { cache: "no-store" });
    if (!r.ok) { left++; continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    fetched++;
  }
  return { fetched, left, total: list.length };
}

/**
 * Make today's copy if it is not there yet (`force` makes one anyway). `fetch` carries the app's login.
 * Returns { ok, done, message } - `done` is false when today's copy already existed.
 */
async function copyToPc(appUrl, fetch, folder, force) {
  fs.mkdirSync(folder, { recursive: true });
  const day = today();
  const dest = path.join(folder, dbName(day));
  if (!force && fs.existsSync(dest)) return { ok: true, done: false, message: `Today's copy is already in ${folder}.` };

  const res = await fetch(`${appUrl}/api/backup/download?by=app`, { cache: "no-store" });
  if (res.status === 401) return { ok: false, done: false, message: "Nobody is signed in, so no copy was made." };
  if (res.status === 403) return { ok: false, done: false, message: "Only an admin login can copy the data. Sign in as admin on this PC." };
  if (res.status === 404) return { ok: false, done: false, message: "The school system does not offer copies yet (it needs its update)." };
  if (!res.ok) return { ok: false, done: false, message: `The school system answered ${res.status}; no copy was made.` };
  const data = Buffer.from(await res.arrayBuffer());
  if (!isSqlite(data)) return { ok: false, done: false, message: "What arrived was not a database, so it was not saved." };

  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dest); // a half-written file never carries the day's name
  try { fs.writeFileSync(path.join(folder, "READ ME.txt"), README); } catch { /* the copies matter, not the note */ }
  prune(folder);

  let filesText = "";
  try {
    const f = await copyFiles(appUrl, fetch, folder);
    filesText = ` Photos and files: ${f.fetched} new, ${f.total} in all${f.left ? `, ${f.left} still to fetch next time` : ""}.`;
  } catch (e) {
    filesText = ` Photos and files could not be fetched (${e && e.message ? e.message : e}).`;
  }
  return { ok: true, done: true, message: `Database copied (${Math.round(data.length / 1024)} KB) to ${dest}.${filesText}` };
}

module.exports = { copyToPc, newestCopy };
