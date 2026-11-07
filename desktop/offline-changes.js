// Reads what was done offline: every row the offline copy noted in `_offline_log`, with how it looked in
// the copy the PC started from (base) and how it looks now. The online system decides what to do with it.
// Kept separate from Electron so it can be checked with plain Node (see test-offline.js).
const { DatabaseSync } = require("node:sqlite");

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

function toCell(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return { $b64: Buffer.from(v).toString("base64") };
  if (typeof v === "bigint") return Number(v);
  return v;
}
function toSql(c) {
  if (c === null || c === undefined) return null;
  if (typeof c === "object") return new Uint8Array(Buffer.from(String(c.$b64 || ""), "base64"));
  return c;
}
const cells = (row) => (row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toCell(v)])) : null);

/** The key column(s) of a table in one database, in key order. */
function keyColumns(db, schema, table) {
  return db.prepare(`PRAGMA ${schema}.table_info(${q(table)})`).all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
}

/** How many different rows were touched offline (0 when nothing, or no log yet). */
function countChanges(workDb) {
  const db = new DatabaseSync(workDb, { readOnly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM (SELECT DISTINCT tbl, pk FROM _offline_log)").get().n);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Every touched row, in the order it was first touched: [{ tbl, pk, base, now }].
 * `base` is null for a row added offline, `now` is null for a row removed offline.
 */
function readChanges(workDb, baseDb) {
  const db = new DatabaseSync(workDb, { readOnly: true });
  try {
    db.exec(`ATTACH DATABASE '${String(baseDb).replace(/'/g, "''")}' AS base`);
    let touched;
    try {
      touched = db.prepare("SELECT tbl, pk, MIN(seq) AS first FROM _offline_log GROUP BY tbl, pk ORDER BY first").all();
    } catch {
      return []; // the offline copy never started, so nothing was noted
    }
    const hasTable = (schema, t) => !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(t);
    const keysOf = new Map();
    const out = [];
    for (const t of touched) {
      const pk = JSON.parse(t.pk);
      if (!keysOf.has(t.tbl)) keysOf.set(t.tbl, hasTable("main", t.tbl) ? keyColumns(db, "main", t.tbl) : null);
      const keys = keysOf.get(t.tbl);
      if (!keys || keys.length !== pk.length) continue;
      const where = keys.map((k) => `${q(k)} = ?`).join(" AND ");
      const args = pk.map(toSql);
      const now = db.prepare(`SELECT * FROM main.${q(t.tbl)} WHERE ${where}`).get(...args) || null;
      const base = hasTable("base", t.tbl) ? db.prepare(`SELECT * FROM base.${q(t.tbl)} WHERE ${where}`).get(...args) || null : null;
      if (!now && !base) continue; // added and removed again while offline
      const b = cells(base), n = cells(now);
      if (b && n && JSON.stringify(b) === JSON.stringify(n)) continue; // changed and changed back
      out.push({ tbl: t.tbl, pk: pk.map(toCell), base: b, now: n });
    }
    return out;
  } finally {
    db.close();
  }
}

module.exports = { readChanges, countChanges };
