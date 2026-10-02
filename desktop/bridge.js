// Fingerprint bridge: the online server cannot reach a device on the school network
// (e.g. a ZKTeco K40 at 192.168.0.100), so this app — running on a school PC — reads the
// device over the LAN and sends the punches to the server. It uses the login of the app window.
const ZKLib = require("node-zklib");

const pad = (n) => String(n).padStart(2, "0");
// The device clock is local school time; send it as plain wall-clock text so no timezone shifts it.
const wallClock = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// node-zklib throws ZKError objects ({ err, command, ip }), not Error instances.
function describeError(e) {
  const inner = (e && e.err) || e;
  const code = inner && inner.code;
  const base = (e && typeof e.toast === "function" && e.toast()) || (inner && inner.message) || String(e);
  if (code === "ETIMEDOUT" || /timeout/i.test(base))
    return `${base} — device did not answer. Check that this PC is on the same network as the device and the IP/port are correct.`;
  if (code === "ECONNRESET")
    return `${base} — close other software using the device (e.g. ZKBio Time.Net) and try again.`;
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH")
    return `${base} — check the device IP address and that the device is switched on.`;
  return base;
}

async function readDevice(ip, port) {
  const zk = new ZKLib(ip, port, 10000, 4000);
  try {
    await zk.createSocket();
    const users = [];
    try {
      const u = await zk.getUsers();
      for (const row of (u && u.data) || []) users.push({ pin: String(row.userId ?? row.uid), name: String(row.name || "").trim() });
    } catch { /* some firmwares block reading users; punches still work */ }
    const att = await zk.getAttendances();
    const punches = ((att && att.data) || []).map((r) => {
      const t = r.recordTime instanceof Date ? r.recordTime : new Date(r.recordTime);
      return { pin: String(r.deviceUserId), time: wallClock(t), state: typeof r.state === "number" ? r.state : undefined };
    });
    return { punches, users };
  } finally {
    try { await zk.disconnect(); } catch { /* ignore */ }
  }
}

/**
 * Sync every active device once. `fetch` must carry the app's login cookies
 * (Electron's session.fetch). Returns a list of { name, ok, message }.
 */
async function syncAll(appUrl, fetch) {
  const res = await fetch(`${appUrl}/api/biometric/bridge`, { cache: "no-store" });
  if (res.status === 401) return { loggedIn: false, results: [] };
  if (!res.ok) throw new Error(`Server answered ${res.status}`);
  const { devices = [] } = await res.json();

  const results = [];
  for (const d of devices) {
    let payload;
    try {
      payload = { deviceId: d.id, ...(await readDevice(d.ip, d.port || 4370)) };
    } catch (e) {
      payload = { deviceId: d.id, error: `${d.ip}:${d.port || 4370} — ${describeError(e)}` };
    }
    try {
      const r = await fetch(`${appUrl}/api/biometric/bridge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      results.push({ name: d.name, ok: !!j.ok, message: j.message || j.error || `HTTP ${r.status}` });
    } catch (e) {
      results.push({ name: d.name, ok: false, message: `Could not send to server: ${e && e.message ? e.message : e}` });
    }
  }
  return { loggedIn: true, results };
}

module.exports = { syncAll };
