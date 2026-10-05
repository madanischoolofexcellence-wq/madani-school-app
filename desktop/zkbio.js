// People sync between ZKBio Time.Net (on this PC) and the school system (online).
//
// This app only carries: it reads ZKBio's people list and sends it to the school system, which compares
// the two sides and decides. Clear cases (a brand-new person, a change on one side only) come back as
// writes for ZKBio; anything doubtful — a person removed from one side, details that disagree — waits
// in the school system for an admin (Biometric → ZKBio differences) and nothing is written.
//
// Writes this app makes in ZKBio, only when the school system asks:
//   ADD     a new person (ID, name, department, position)
//   UPDATE  one person's name, department, position
//   OFF     untick "Enable" for one person (nobody is ever deleted)
// A copy of ZKBio's database is kept before every write.
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

/** Everyone in ZKBio, with which fingers ZKBio holds for them (numbers only). Read only. */
function readPeople(file) {
  const db = openDb(file, true);
  try {
    const fingers = new Map();
    try {
      for (const r of db.prepare("SELECT employee_id AS id, template_no AS no FROM hr_biotemplate WHERE bio_type = 1 AND template_no BETWEEN 0 AND 9").all()) {
        if (!fingers.has(r.id)) fingers.set(r.id, new Set());
        fingers.get(r.id).add(Number(r.no));
      }
    } catch { /* an older ZKBio without this table: fingers are simply not reported */ }
    return db
      .prepare(
        `SELECT e.id, e.emp_pin AS pin, e.emp_firstname AS first, e.emp_lastname AS last, e.emp_active AS active,
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
        fingers: [...(fingers.get(r.id) || [])].sort(),
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

/** Untick "Enable" for these IDs in ZKBio. Nobody is deleted. Returns [{ id, ok, message }]. */
function switchOff(file, items, backupDir) {
  if (items.length === 0) return [];
  backup(file, backupDir);
  const db = openDb(file, false);
  const out = [];
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const c of items) {
        const r = db.prepare("UPDATE hr_employee SET emp_active = 0 WHERE emp_pin = ?").run(String(c.pin).trim());
        out.push({ id: c.id, ok: true, message: Number(r.changes) ? "Switched off in ZKBio" : "Was not in ZKBio any more", name: c.name || c.pin });
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

/** Carry out the writes the school system asked for. Returns [{ id, ok, message, name, op }]. */
function carryOut(file, writes, backupDir) {
  const done = [];
  const attempt = (op, items, fn) => {
    if (items.length === 0) return;
    try {
      for (const r of fn()) done.push({ ...r, op });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      const why = /readonly|EPERM|EACCES|access/i.test(msg) ? `Windows did not let this app write into ZKBio's folder (${msg})` : msg;
      for (const w of items) done.push({ id: w.id, ok: false, message: why, name: w.name || w.pin, op });
    }
  };
  const adds = writes.filter((w) => w.op === "ADD").slice(0, MAX_ADD_PER_RUN);
  attempt("ADD", adds, () => {
    const people = adds.map((w) => ({ pin: String(w.pin).trim(), name: String(w.name || "").trim(), kind: w.kind === "STUDENT" ? "STUDENT" : "STAFF", department: w.department, position: w.position }));
    const added = new Set(addPeople(file, people, backupDir));
    return adds.map((w) => ({ id: w.id, ok: true, message: added.has(String(w.name || "").trim()) ? "Added to ZKBio" : "Already in ZKBio", name: w.name || w.pin }));
  });
  const updates = writes.filter((w) => w.op === "UPDATE");
  attempt("UPDATE", updates, () => {
    const res = applyChanges(file, updates, backupDir);
    const got = new Set(res.map((r) => r.id));
    return [...res, ...updates.filter((w) => !got.has(w.id)).map((w) => ({ id: w.id, ok: false, message: "This person is not in ZKBio", name: w.name || w.pin }))];
  });
  const offs = writes.filter((w) => w.op === "OFF");
  attempt("OFF", offs, () => switchOff(file, offs, backupDir));
  return done;
}

/**
 * One full people sync. `fetch` must carry the app's login. Returns a short text for the status box.
 * `stateDir`: a folder of this app (not ZKBio's) for the backup copies.
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

  const url = `${appUrl}/api/biometric/personnel`;
  const send = (body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const post = await send({ people: zk });
  if (post.status === 401) return "People: log in to the school system first.";
  const j = await post.json().catch(() => ({}));
  if (!post.ok || !j.ok) return `People: the school system did not accept ZKBio's list (${j.error || `HTTP ${post.status}`}).`;

  const parts = [];
  const newHere = ((j.added && j.added.staff) || 0) + ((j.added && j.added.students) || 0);
  parts.push(`ZKBio → school system: ${zk.length} people compared, ${newHere} new added${j.updated ? `, ${j.updated} updated` : ""}.`);

  // An older school system does not decide for this app — then nothing is written into ZKBio at all.
  if (!Array.isArray(j.writes)) {
    parts.push("School system → ZKBio: waiting for the school system's update; nothing was written.");
    return parts.join("\n");
  }
  if (j.writes.length === 0) {
    parts.push("School system → ZKBio: nothing to write.");
  } else {
    const done = carryOut(file, j.writes, path.join(stateDir, "zkbio-backups"));
    if (done.length) await send({ done: done.map(({ id, ok, message }) => ({ id, ok, message })) }).catch(() => {});
    const say = { ADD: "added", UPDATE: "updated", OFF: "switched off" };
    for (const op of ["ADD", "UPDATE", "OFF"]) {
      const good = done.filter((d) => d.op === op && d.ok).map((d) => d.name);
      if (good.length) parts.push(`School system → ZKBio: ${say[op]} ${good.join(", ")}.`);
    }
    const bad = done.filter((d) => !d.ok);
    if (bad.length) parts.push(`School system → ZKBio: could not write ${bad.map((d) => d.name).join(", ")} — ${bad[0].message}.`);
    if (done.some((d) => d.ok)) parts.push("In ZKBio, leave and re-open the Employee page to see it.");
  }
  if (j.needDecision) parts.push(`${j.needDecision} difference(s) are waiting for an admin: Biometric → ZKBio differences.`);
  return parts.join("\n");
}

module.exports = { syncPeople, readPeople, addPeople, applyChanges, switchOff, carryOut, findDb };
