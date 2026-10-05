// People sync between ZKBio Time.Net (on this PC) and the school system (online).
//
//   ZKBio -> school system : every person in ZKBio (ID, name, department, position) is sent to the
//                            server, which adds the new ones as staff / students. ZKBio is only read.
//   school system -> ZKBio : an active staff member or student who has a Fingerprint ID that ZKBio
//                            does not know is added to ZKBio's people list (name, department, position),
//                            and a name, department or position edited there is written into ZKBio for
//                            that person. Nobody is ever removed from ZKBio, and a copy of ZKBio's
//                            database is kept before every write.
//
// ZKBio Time.Net keeps its data in a plain SQLite file, TimeNet.db, in its program folder.
const fs = require("fs");
const path = require("path");

const DB_CANDIDATES = [
  process.env.MADANI_ZKBIO_DB,
  "C:\\Program Files (x86)\\ZKBio Time.Net\\TimeNet.db",
  "C:\\Program Files\\ZKBio Time.Net\\TimeNet.db",
].filter(Boolean);

const MAX_ADD_PER_RUN = 10; // a safety limit: never pour a long list into ZKBio in one go
const KEEP_BACKUPS = 14;

function findDb() {
  for (const p of DB_CANDIDATES) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

function openDb(file, readOnly) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly });
  db.exec("PRAGMA busy_timeout=8000"); // ZKBio may be using the file at the same moment — wait, don't fail
  return db;
}

const norm = (s) => String(s || "").trim().toLowerCase().replace(/[\s_]+/g, " ");

/** Everyone in ZKBio. Read only. */
function readPeople(file) {
  const db = openDb(file, true);
  try {
    return db
      .prepare(
        `SELECT e.emp_pin AS pin, e.emp_firstname AS first, e.emp_lastname AS last, e.emp_active AS active,
                d.dept_name AS department, p.posi_name AS position
         FROM hr_employee e
         LEFT JOIN hr_department d ON d.id = e.department_id
         LEFT JOIN hr_position p ON p.id = e.position_id
         ORDER BY e.id`
      )
      .all()
      .map((r) => ({
        pin: String(r.pin || "").trim(),
        name: `${r.first || ""} ${r.last || ""}`.replace(/\s+/g, " ").trim(),
        department: r.department ? String(r.department).trim() : null,
        position: r.position ? String(r.position).trim() : null,
        active: Number(r.active) === 1,
      }))
      .filter((r) => r.pin);
  } finally {
    db.close();
  }
}

function backup(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const target = path.join(dir, `TimeNet-${stamp}.db`);
  fs.copyFileSync(file, target);
  const old = fs.readdirSync(dir).filter((f) => /^TimeNet-\d{8}-\d{6}\.db$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* keep it */ }
  }
  return target;
}

/**
 * Finds a department or position in ZKBio by name; when ZKBio does not have it, makes it (the way ZKBio
 * itself does), so a name written in the school system comes back unchanged. A student's class is made
 * under ZKBio's "Students" department.
 */
function lookups(db) {
  const first = (table) => db.prepare(`SELECT company_id AS c FROM ${table} ORDER BY id LIMIT 1`).get();
  const dept = (name, student) => {
    const want = String(name || "").trim();
    if (!want) return 0;
    const all = db.prepare("SELECT id, dept_code AS code, dept_name AS name FROM hr_department").all();
    const hit = all.find((d) => norm(d.name) === norm(want));
    if (hit) return hit.id;
    const parent = student ? all.find((d) => ["students", "student"].includes(norm(d.name))) : null;
    const code = all.reduce((m, d) => Math.max(m, Number(d.code) || 0), 0) + 1;
    const company = (first("hr_department") || {}).c || 1;
    return Number(db.prepare(
      `INSERT INTO hr_department (dept_code, dept_name, dept_parentcode, useCode, dept_operationmode, middleware_id, defaultDepartment, description, company_id)
       VALUES (?, ?, ?, 1, 0, 0, 0, '', ?)`
    ).run(code, want, parent ? Number(parent.code) : 0, company).lastInsertRowid);
  };
  const posi = (name) => {
    const want = String(name || "").trim();
    if (!want) return 0;
    const all = db.prepare("SELECT id, posi_code AS code, posi_name AS name FROM hr_position").all();
    const hit = all.find((p) => norm(p.name) === norm(want));
    if (hit) return hit.id;
    const code = all.reduce((m, p) => Math.max(m, Number(p.code) || 0), 0) + 1;
    const company = (first("hr_position") || {}).c || 1;
    return Number(db.prepare(
      "INSERT INTO hr_position (posi_code, posi_name, description, posi_parentcode, defaultPosition, company_id) VALUES (?, ?, '', 0, 0, ?)"
    ).run(code, want, company).lastInsertRowid);
  };
  return { dept, posi };
}

/** Where a person with no department goes: "Students" / "Others" if ZKBio has them, else ZKBio's default department. */
function fallbackDept(db, student) {
  const all = db.prepare("SELECT id, dept_name AS name, defaultDepartment AS def FROM hr_department").all();
  const hit = all.find((d) => (student ? ["students", "student"] : ["others", "other"]).includes(norm(d.name)));
  const def = hit || all.find((d) => Number(d.def) === 1) || all[0];
  return def ? def.id : 0;
}

/**
 * Write details edited in the school system into ZKBio. `changes`: [{ id, pin, name, department, position }].
 * Only the name, department and position of that one person are touched. Returns [{ id, ok, message }].
 */
function applyChanges(file, changes, backupDir) {
  if (changes.length === 0) return [];
  const out = [];
  const db0 = openDb(file, true);
  let present;
  try {
    present = new Set(db0.prepare("SELECT emp_pin AS pin FROM hr_employee").all().map((r) => String(r.pin).trim()));
  } finally {
    db0.close();
  }
  const todo = changes.filter((c) => present.has(String(c.pin).trim()));
  if (todo.length === 0) return out; // not in ZKBio yet: they arrive there as new people, with these details
  backup(file, backupDir);
  const db = openDb(file, false);
  try {
    const { dept, posi } = lookups(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const c of todo) {
        const pin = String(c.pin).trim();
        const cur = db.prepare("SELECT id, emp_firstname AS first, emp_lastname AS last FROM hr_employee WHERE emp_pin = ?").get(pin);
        const name = String(c.name || "").trim();
        const student = norm(c.position) === "student";
        if (name && `${cur.first || ""} ${cur.last || ""}`.replace(/\s+/g, " ").trim() !== name) {
          db.prepare("UPDATE hr_employee SET emp_firstname = ?, emp_lastname = '' WHERE id = ?").run(name, cur.id);
        }
        const d = dept(c.department, student);
        if (d) db.prepare("UPDATE hr_employee SET department_id = ? WHERE id = ?").run(d, cur.id);
        const p = posi(c.position);
        if (p) db.prepare("UPDATE hr_employee SET position_id = ? WHERE id = ?").run(p, cur.id);
        out.push({ id: c.id, ok: true, message: "Written into ZKBio", name: name || pin });
      }
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* nothing was open */ }
      throw e;
    }
  } finally {
    db.close();
  }
  return out;
}

/**
 * Add people to ZKBio's list. `people`: [{ pin, name, kind: "STAFF"|"STUDENT", department, position }].
 * Only INSERTs; existing people are never touched here. Returns the names added.
 */
function addPeople(file, people, backupDir) {
  if (people.length === 0) return [];
  backup(file, backupDir);
  const db = openDb(file, false);
  const added = [];
  try {
    const cols = new Set(db.prepare("PRAGMA table_info(hr_employee)").all().map((c) => c.name));
    const zone = db.prepare("SELECT id FROM att_zone ORDER BY id LIMIT 1").get();
    const hasPay = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pay_empDetail'").get();
    const hasZone = !!zone && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='att_employee_zone'").get();
    const { dept, posi } = lookups(db);
    const exists = db.prepare("SELECT 1 FROM hr_employee WHERE emp_pin = ?");

    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 00:00:00`;
    // The same values ZKBio itself writes for a person added by hand with only ID, name, department, position.
    const TEXT_BLANK = ["emp_ssn", "emp_role", "emp_lastname", "emp_username", "emp_pwd", "emp_timezone", "emp_phone", "emp_payroll_id",
      "emp_payroll_type", "emp_pin2", "emp_group", "emp_address", "emp_firereason", "emp_emergencyphone1", "emp_emergencyphone2",
      "emp_emergencyname", "emp_emergencyaddress", "emp_cardNumber", "emp_country", "emp_city", "emp_state", "emp_postal", "emp_fax",
      "emp_email", "emp_title", "nationalID"];
    const ZERO = ["emp_hourlyrate1", "emp_hourlyrate2", "emp_hourlyrate3", "emp_hourlyrate4", "emp_hourlyrate5", "emp_operationmode", "IsSelect", "middleware_id"];

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const p of people) {
        if (exists.get(p.pin)) continue;
        const row = { emp_pin: p.pin, emp_firstname: p.name, emp_privilege: "0", emp_hiredate: today, emp_active: 1, emp_gender: -1 };
        for (const c of TEXT_BLANK) row[c] = "";
        for (const c of ZERO) row[c] = 0;
        row.department_id = dept(p.department, p.kind === "STUDENT") || fallbackDept(db, p.kind === "STUDENT");
        row.position_id = posi(p.kind === "STUDENT" ? "Student" : p.position) || 0;
        const names = Object.keys(row).filter((c) => cols.has(c));
        const r = db
          .prepare(`INSERT INTO hr_employee (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
          .run(...names.map((n) => row[n]));
        const id = Number(r.lastInsertRowid);
        if (hasZone) db.prepare("INSERT INTO att_employee_zone (employee_id, zone_id) VALUES (?, ?)").run(id, zone.id);
        if (hasPay)
          db.prepare(
            `INSERT INTO pay_empDetail (payment_type, bank_name, bank_account, bank_accounts, national_id, national_ids, agent_id, agent_ids, agent_account, agent_accounts, employee_id)
             VALUES (0, '', 0, '', 0, '', 0, '', 0, '', ?)`
          ).run(id);
        added.push(p.name);
      }
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* nothing was open */ }
      throw e;
    }
  } finally {
    db.close();
  }
  return added;
}

/** Fingerprint IDs this app has ever seen in ZKBio — so a person removed from ZKBio on purpose is not put back. */
function loadSeen(file) {
  try { return new Set(JSON.parse(fs.readFileSync(file, "utf8")).pins || []); } catch { return new Set(); }
}
function saveSeen(file, set) {
  try { fs.writeFileSync(file, JSON.stringify({ pins: [...set].sort() })); } catch { /* tried */ }
}

/**
 * Decide who should be added to ZKBio. Pure — no files, no network — so it can be tested.
 * `zk`: people in ZKBio; `server`: { staff, students } from the school system; `seen`: Set of IDs seen before.
 */
function planAdditions(zk, server, seen) {
  const have = new Set(zk.map((p) => p.pin));
  const haveNumbers = new Set(zk.filter((p) => /^\d+$/.test(p.pin)).map((p) => Number(p.pin)));
  const add = [];
  const skipped = [];
  const taken = new Set();
  const consider = (r, kind) => {
    const pin = String(r.pin || "").trim();
    const name = String(r.name || "").trim();
    if (!pin || r.status !== "ACTIVE" || have.has(pin) || taken.has(pin)) return;
    if (!/^\d{1,9}$/.test(pin)) return skipped.push(`${name} (ID ${pin}: ZKBio IDs are numbers only)`);
    if (!name || /^Fingerprint ID /i.test(name)) return; // a placeholder made from a scan, not a real person record
    if (seen.has(pin)) return skipped.push(`${name} (ID ${pin} was removed from ZKBio earlier)`);
    // "5" here and "005" there are most likely the same person typed without the zeros — never guess.
    // ("0006" next to "006" is fine: the school uses both forms for different people.)
    if (String(Number(pin)) === pin && haveNumbers.has(Number(pin))) return skipped.push(`${name} (ID ${pin} looks like an ID already in ZKBio written with other zeros)`);
    taken.add(pin);
    add.push(kind === "STUDENT"
      ? { pin, name, kind, department: r.class || null, position: "Student" }
      : { pin, name, kind, department: r.department || null, position: r.designation || null });
  };
  for (const s of server.staff || []) consider(s, "STAFF");
  for (const s of server.students || []) consider(s, "STUDENT");
  return { add, skipped };
}

/**
 * One full people sync. `fetch` must carry the app's login. Returns a short text for the status box.
 * `stateDir`: a folder of this app (not ZKBio's) for the backup copies and the "seen" list.
 */
async function syncPeople(appUrl, fetch, stateDir) {
  const file = findDb();
  if (!file) return "ZKBio Time.Net was not found on this PC, so people were not compared.";

  let zk;
  try {
    zk = readPeople(file);
  } catch (e) {
    return `Could not read ZKBio's people list: ${e && e.message ? e.message : e}`;
  }
  const parts = [];

  // 1) ZKBio -> school system
  const url = `${appUrl}/api/biometric/personnel`;
  const post = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ people: zk.filter((p) => p.active).map(({ pin, name, department, position }) => ({ pin, name, department, position })) }),
  });
  if (post.status === 401) return "People: log in to the school system first.";
  const pj = await post.json().catch(() => ({}));
  if (!post.ok || !pj.ok) return `People: the server did not accept ZKBio's list (${pj.error || `HTTP ${post.status}`}).`;
  const newHere = ((pj.added && pj.added.staff) || 0) + ((pj.added && pj.added.students) || 0);
  parts.push(`ZKBio → school system: ${zk.length} people checked, ${newHere} new added.`);

  // 2) school system -> ZKBio
  const seenFile = path.join(stateDir, "zkbio-seen.json");
  const seen = loadSeen(seenFile);
  try {
    const get = await fetch(url, { cache: "no-store" });
    const gj = await get.json().catch(() => ({}));
    if (!get.ok || !gj.ok) throw new Error(gj.error || `HTTP ${get.status}`);
    // Details edited in the school system since the last round.
    const pending = Array.isArray(gj.pending) ? gj.pending : [];
    if (pending.length) {
      try {
        const done = applyChanges(file, pending, path.join(stateDir, "zkbio-backups"));
        if (done.length) {
          await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: done.map(({ id, ok, message }) => ({ id, ok, message })) }) });
          parts.push(`School system → ZKBio: updated ${done.map((d) => d.name).join(", ")}. In ZKBio press Refresh to see it.`);
        }
      } catch (e) {
        parts.push(`School system → ZKBio: could not write ${pending.length} edit(s) (${e && e.message ? e.message : e}).`);
      }
    }
    const plan = planAdditions(zk, gj, seen);
    const now = plan.add.slice(0, MAX_ADD_PER_RUN);
    let added = [];
    if (now.length) {
      try {
        added = addPeople(file, now, path.join(stateDir, "zkbio-backups"));
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        parts.push(/readonly|EPERM|EACCES|access/i.test(msg)
          ? `School system → ZKBio: ${now.length} waiting, but Windows did not let this app write into ZKBio's folder (${msg}).`
          : `School system → ZKBio: could not add ${now.length} people (${msg}).`);
      }
    }
    if (added.length && pending.length) {
      const pins = new Set(now.map((p) => p.pin));
      const done = pending.filter((c) => pins.has(String(c.pin).trim())).map((c) => ({ id: c.id, ok: true, message: "Added to ZKBio with these details" }));
      if (done.length) await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done }) }).catch(() => {});
    }
    if (added.length) parts.push(`School system → ZKBio: added ${added.join(", ")}. In ZKBio press Refresh to see them. Take the fingerprint from the person's page in Madani School.`);
    else if (!now.length) parts.push("School system → ZKBio: nothing new to add.");
    if (plan.add.length > now.length) parts.push(`${plan.add.length - now.length} more will follow at the next sync.`);
    if (plan.skipped.length) parts.push(`Left alone: ${plan.skipped.join("; ")}.`);
    for (const p of added.length ? now : []) seen.add(p.pin);
  } catch (e) {
    parts.push(`School system → ZKBio: could not get the list (${e && e.message ? e.message : e}).`);
  }
  for (const p of zk) seen.add(p.pin);
  saveSeen(seenFile, seen);
  return parts.join("\n");
}

module.exports = { syncPeople, planAdditions, readPeople, addPeople, applyChanges, findDb };
