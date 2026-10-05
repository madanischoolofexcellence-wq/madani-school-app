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

// ---------- Things to do on the device, asked for from the school system ----------
// ZKTeco protocol command numbers.
const CMD = { USER_WRQ: 8, OPTIONS_RRQ: 11, GET_FREE_SIZES: 50, STARTVERIFY: 60, STARTENROLL: 61, CANCELCAPTURE: 62, REFRESHDATA: 1013, ACK_OK: 2000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ackOk = (reply) => !!reply && reply.length >= 2 && reply.readUInt16LE(0) === CMD.ACK_OK;

/** One setting of the device (e.g. "~SerialNumber"), or null when the device does not have it. */
async function readOption(zk, key) {
  try {
    const reply = await zk.executeCmd(CMD.OPTIONS_RRQ, `${key}\0`);
    if (!ackOk(reply)) return null;
    const text = reply.subarray(8).toString("ascii").split("\0")[0];
    const i = text.indexOf("=");
    return i >= 0 ? text.slice(i + 1).trim() : null;
  } catch {
    return null;
  }
}

/** Serial number, and whether the device can send its scans to a server by itself. Read only. */
async function readInfo(zk) {
  const serial = await readOption(zk, "~SerialNumber");
  if (!serial) return null;
  const url = await readOption(zk, "ICLOCKSVRURL");
  const ip = await readOption(zk, "WebServerIP");
  const port = await readOption(zk, "WebServerPort");
  return {
    serial,
    pushSupported: await readOption(zk, "IclockSvrFun"),
    serverAddress: url || (ip && ip !== "0.0.0.0" ? `${ip}${port ? `:${port}` : ""}` : null),
  };
}

async function fingerCount(zk) {
  const reply = await zk.executeCmd(CMD.GET_FREE_SIZES, "");
  return ackOk(reply) && reply.length >= 36 ? reply.readUInt32LE(32) : null;
}

/** Put a person on the device (ID + name). Someone already there is left exactly as they are. */
async function setUser(zk, users, pin, name) {
  if (users.some((u) => String(u.userId) === pin)) return "Already on the device";
  const uid = users.reduce((m, u) => Math.max(m, Number(u.uid) || 0), 0) + 1;
  const rec = Buffer.alloc(72);
  rec.writeUInt16LE(uid, 0); // the device's own row number
  rec.writeUInt8(0, 2); // ordinary user, never an administrator
  rec.write(String(name || "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 23), 11, "ascii");
  rec.write("0", 40, "ascii"); // no special group
  rec.write(pin, 48, "ascii");
  if (!ackOk(await zk.executeCmd(CMD.USER_WRQ, rec))) throw new Error("the device refused the new person");
  try { await zk.executeCmd(CMD.REFRESHDATA, ""); } catch { /* the person is saved; refresh is a courtesy */ }
  users.push({ uid, userId: pin, name });
  return "Added to the device";
}

/** Make the device ask for a finger now, and wait (up to a minute) to see whether one was saved. */
async function enrolFinger(zk, pin, finger) {
  const before = await fingerCount(zk).catch(() => null);
  try { await zk.executeCmd(CMD.CANCELCAPTURE, ""); } catch { /* nothing was being captured */ }
  const data = Buffer.alloc(26);
  data.write(pin, 0, "ascii");
  data.writeUInt8(Number.isInteger(finger) && finger >= 0 && finger <= 9 ? finger : 6, 24);
  data.writeUInt8(1, 25); // a valid fingerprint
  if (!ackOk(await zk.executeCmd(CMD.STARTENROLL, data))) throw new Error("the device did not start taking the fingerprint");
  let saved = false;
  for (let i = 0; i < 20 && !saved; i++) {
    await sleep(3000);
    const now = await fingerCount(zk).catch(() => null);
    saved = before != null && now != null && now > before;
  }
  try { await zk.executeCmd(CMD.STARTVERIFY, ""); } catch { /* the device goes back to normal by itself */ }
  if (!saved) throw new Error("the device asked for the finger, but no fingerprint was saved within a minute");
  return "Fingerprint saved on the device";
}

/** Carry out the waiting commands on one device. Returns [{ id, ok, message }] and what the device says about itself. */
async function runCommands(ip, port, commands, wantInfo) {
  const results = [];
  let info = null;
  const zk = new ZKLib(ip, port, 10000, 4000);
  try {
    await zk.createSocket();
    if (wantInfo) info = await readInfo(zk);
    let users = null;
    for (const c of commands) {
      try {
        const pin = String(c.pin);
        if (!users) users = ((await zk.getUsers()) || {}).data || [];
        let message = await setUser(zk, users, pin, c.name);
        if (c.kind === "ENROLL_FP") message = await enrolFinger(zk, pin, c.finger);
        results.push({ id: c.id, ok: true, message });
      } catch (e) {
        results.push({ id: c.id, ok: false, message: describeError(e) });
      }
    }
  } catch (e) {
    for (const c of commands) if (!results.some((r) => r.id === c.id)) results.push({ id: c.id, ok: false, message: describeError(e) });
  } finally {
    try { await zk.disconnect(); } catch { /* ignore */ }
  }
  return { results, info };
}

let infoSent = false;

/**
 * Ask the school system whether a device has something to do, and do it. Cheap when there is nothing.
 * `devices` may be passed in when the list was just fetched. Returns a short text, or "" when nothing was done.
 */
async function runDeviceCommands(appUrl, fetch, devices) {
  if (!devices) {
    const res = await fetch(`${appUrl}/api/biometric/bridge?commands=1`, { cache: "no-store" });
    if (!res.ok) return "";
    devices = (await res.json()).devices || [];
  }
  const lines = [];
  for (const d of devices) {
    const commands = d.commands || [];
    if (commands.length === 0 && infoSent) continue;
    const { results, info } = await runCommands(d.ip, d.port || 4370, commands, !infoSent);
    if (info) infoSent = true;
    if (results.length === 0 && !info) continue;
    try {
      await fetch(`${appUrl}/api/biometric/bridge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: d.id, commandResults: results, ...(info ? { info } : {}) }),
      });
    } catch { /* the server asks again after 2 minutes */ }
    for (const r of results) {
      const c = commands.find((x) => x.id === r.id);
      lines.push(`${d.name}: ${c && c.kind === "ENROLL_FP" ? "fingerprint" : "add person"} ID ${c ? c.pin : "?"} — ${r.ok ? "" : "FAILED: "}${r.message}`);
    }
  }
  return lines.join("\n");
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

  // People to add / fingerprints to take come first, so the scan below already sees the new people.
  let commandText = "";
  try { commandText = await runDeviceCommands(appUrl, fetch, devices); } catch { /* tried again at the next round */ }

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
  return { loggedIn: true, results, commandText };
}

module.exports = { syncAll, runDeviceCommands };
