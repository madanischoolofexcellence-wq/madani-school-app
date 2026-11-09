// Windows app for Madani School of Excellence.
// Online, it opens the live school system, so every website update appears here immediately.
// Offline (no internet), it runs the same school system on this PC from a copy of the data and sends the
// work to the website when the internet is back (see offline.js). It starts by itself when Windows starts.
// The app shell itself also updates automatically from the GitHub release.
// On a school PC it also relays the fingerprint device's punches to the server (see bridge.js).
const { app, BrowserWindow, Menu, shell, dialog, session, Notification, powerMonitor } = require("electron");
const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { autoUpdater } = require("electron-updater");
const { syncAll, runDeviceCommands } = require("./bridge");
const { syncPeople } = require("./zkbio");
const { copyToPc, newestCopy } = require("./backup");
const { Offline } = require("./offline");

const APP_URL = "https://srv2045997.hstgr.cloud";
const APP_ORIGIN = new URL(APP_URL).origin;
const COOKIE = "sms_session";

let win = null;
let lastBridge = "Not run yet";
let bridgeBusy = false;
const appFetch = (url, opts) => session.defaultSession.fetch(url, opts);
const backupFolder = () => path.join(app.getPath("documents"), "Madani School Backups");

// ==================== Online / offline ====================

let offline = null; // set up when the app is ready
let mode = "online"; // "online": the website. "offline": the copy on this PC.
let switching = false;
let netFails = 0, netOks = 0;
let lastNet = "Not checked yet";

const isLocal = (url) => !!offline && !!offline.localUrl && String(url || "").startsWith(offline.localUrl);
const isLive = (url) => String(url || "").startsWith(APP_ORIGIN);
const currentUrl = () => (win && !win.isDestroyed() ? win.webContents.getURL() : "");
/** Where the fingerprint punches go: the website, or the offline copy while offline. */
const serverUrl = () => (mode === "offline" && offline && offline.running ? offline.localUrl : APP_URL);

/** Can the website be reached? (Its /api/version is never served from a cache.) */
async function websiteReachable() {
  try {
    const r = await Promise.race([
      appFetch(`${APP_URL}/api/version`, { cache: "no-store" }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error("no answer in 10 seconds")), 10000)),
    ]);
    lastNet = r.ok ? "Internet: the website answers" : `Internet: the website answered ${r.status}`;
    return r.ok;
  } catch (e) {
    lastNet = `Internet: the website cannot be reached (${e && e.message ? e.message : e})`;
    return false;
  }
}

/** Nobody is in the middle of something: the PC has been idle a while, or the window is out of sight. */
const quietMoment = (seconds) => !win || win.isMinimized() || !win.isVisible() || powerMonitor.getSystemIdleTime() >= seconds;

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

/** A small note at the bottom of the page with one button (the button is a link the app catches). */
function showNote(text, href, label) {
  if (!win || win.isDestroyed()) return;
  const html = `<span>${text}</span> <a href="${href}" style="background:#E8C66A;color:#14233A;padding:6px 12px;border-radius:8px;text-decoration:none;font-weight:600;white-space:nowrap">${label}</a>`;
  win.webContents.executeJavaScript(`(() => {
    const old = document.getElementById("madani-net-note"); if (old) old.remove();
    const d = document.createElement("div"); d.id = "madani-net-note";
    d.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:2147483647;background:#14233A;color:#fff;padding:10px 14px;border-radius:12px;font:14px 'Segoe UI',sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center;max-width:92vw";
    d.innerHTML = ${JSON.stringify(html)}; document.body.appendChild(d);
  })()`).catch(() => { /* page still loading: shown at the next check */ });
}

/** The website's login, carried to the offline copy (same database, so the same login works there). */
async function carryLogin(localUrl) {
  try {
    const [c] = await session.defaultSession.cookies.get({ url: APP_URL, name: COOKIE });
    if (c && c.value) await session.defaultSession.cookies.set({ url: localUrl, name: COOKIE, value: c.value, path: "/", httpOnly: true, sameSite: "lax" });
  } catch { /* they sign in again offline */ }
}

async function goOffline(reason) {
  if (switching || mode === "offline") return;
  if (!offline.ready()) {
    lastNet += "\nOffline work is not ready on this PC yet (it is prepared while the internet is on and an admin is signed in).";
    return;
  }
  switching = true;
  try {
    const url = await offline.start();
    mode = "offline";
    await carryLogin(url);
    netOks = 0;
    win.loadURL(`${url}/dashboard`);
    notify("Madani School — working offline", `${reason} The school system is running on this PC. Your work is sent online when the internet is back.`);
  } catch (e) {
    dialog.showMessageBox(win, { type: "warning", message: "Could not start offline work", detail: String(e && e.message ? e.message : e) });
  } finally {
    switching = false;
  }
}

async function goOnline() {
  if (switching || mode === "online") return;
  switching = true;
  try {
    await offline.stop();
    mode = "online";
    netFails = 0;
    win.loadURL(APP_URL);
    await sendOfflineWork(false);
  } finally {
    switching = false;
  }
}

let sending = false;
async function sendOfflineWork(manual) {
  if (sending || mode !== "online") return;
  sending = true;
  try {
    const r = await offline.send();
    if (r.nothing) { if (manual) dialog.showMessageBox(win, { type: "info", message: r.message }); return; }
    if (r.ok) {
      notify("Madani School — offline work sent", r.message);
      if (manual || r.conflicts) dialog.showMessageBox(win, { type: r.conflicts ? "warning" : "info", message: "Offline work sent", detail: r.message });
    } else if (manual || !r.waiting) {
      if (manual) dialog.showMessageBox(win, { type: "warning", message: "Offline work not sent yet", detail: r.message });
      lastNet += `\n${r.message}`;
    }
  } catch (e) {
    if (manual) dialog.showMessageBox(win, { type: "warning", message: "Offline work not sent yet", detail: String(e && e.message ? e.message : e) });
  } finally {
    sending = false;
  }
}

/** Every 20 seconds: is the internet there? Switch when it has changed twice in a row. */
async function checkNetwork() {
  if (switching) return;
  const up = await websiteReachable();
  if (up) { netOks++; netFails = 0; } else { netFails++; netOks = 0; }

  // The offline copy stopped by itself (it should not): start it again on the same work.
  if (mode === "offline" && !offline.running) {
    mode = "online";
    if (!up) { await goOffline("The offline copy was restarted."); return; }
    win.loadURL(APP_URL);
    await sendOfflineWork(false);
    return;
  }

  if (mode === "online" && netFails >= 2 && offline.ready()) {
    const onErrorPage = currentUrl().startsWith("file:");
    if (onErrorPage || quietMoment(60)) await goOffline("The internet is off.");
    else showNote("The internet is off. Saving will not work online.", `${APP_URL}/__madani/offline`, "Work offline");
  } else if (mode === "offline" && netOks >= 2) {
    if (quietMoment(60) || offline.pendingChanges() === 0) await goOnline();
    else showNote("The internet is back.", `${offline.localUrl}/__madani/online`, "Go online and send the offline work");
  } else if (mode === "online" && up) {
    if (offline.work()) await sendOfflineWork(false);
    keepOfflineReady();
  }
}

/** While online: keep a fresh copy of the data and the current school system on this PC. */
let preparing = false;
let lastPrepared = 0;
async function keepOfflineReady(force) {
  if (preparing || mode !== "online") return;
  if (!force && Date.now() - lastPrepared < 5 * 60 * 1000) return; // looked at every 5 minutes
  lastPrepared = Date.now();
  preparing = true;
  const lines = [];
  try {
    const admin = await offline.isAdmin();
    if (!admin.ok) {
      lines.push(admin.why === "login" || admin.why === "admin" ? "An admin must be signed in on this PC to keep offline work ready." : admin.why);
    } else {
      try { lines.push(`Data: ${await offline.refreshCopy(force)}`); } catch (e) { lines.push(`Data: ${e.message}`); }
      try { lines.push(`School system: ${await offline.refreshBuild(force)}`); } catch (e) { lines.push(`School system: ${e.message}`); }
    }
  } finally {
    preparing = false;
  }
  if (force) dialog.showMessageBox(win, { type: "info", message: "Offline work on this PC", detail: `${lines.join("\n")}\n\n${offlineStatusText()}` });
}

function offlineStatusText() {
  const s = offline.status();
  const when = (t) => (t ? new Date(`${t.replace(" ", "T")}Z`).toLocaleString() : "never yet");
  return [
    `Now: ${mode === "offline" ? "OFFLINE — working on this PC" : "online"}`,
    lastNet,
    `Ready for offline work: ${s.ready ? "yes" : "no"}`,
    `Copy of the data on this PC from: ${when(s.copyAt)}`,
    `School system on this PC: ${s.buildVersion ? s.buildVersion.slice(0, 7) : "not yet"}`,
    s.working ? `Offline work waiting to be sent: ${s.changes} change(s), started from data of ${when(s.workFrom)}` : "No offline work waiting.",
    s.lastSend ? `Last sent: ${s.lastSend.message}` : "",
  ].filter(Boolean).join("\n");
}

// ==================== Fingerprint device and data copy ====================

// Read the fingerprint device(s) on the school network and send the punches to the server
// (to the offline copy while offline: the device keeps them, and the website gets them again later).
async function runBridge(manual) {
  if (bridgeBusy) return;
  bridgeBusy = true;
  try {
    const base = serverUrl();
    const r = await syncAll(base, appFetch, { commands: mode !== "offline" });
    if (!r.loggedIn) {
      lastBridge = "Waiting for someone to log in";
    } else if (r.results.length === 0) {
      lastBridge = "No device added on the website yet";
    } else {
      lastBridge = r.results.map((x) => `${x.name}: ${x.ok ? "OK" : "FAILED"} — ${x.message}`).join("\n");
    }
    if (mode === "offline") lastBridge += "\n(Offline: scans are shown on this PC and reach the website when the internet is back.)";
    if (r.commandText) lastBridge += `\n\nDone on the device\n${r.commandText}`;
    // People: ZKBio Time.Net on this PC <-> the school system (see zkbio.js). Online only.
    if (r.loggedIn && mode !== "offline") {
      try {
        const people = await syncPeople(APP_URL, appFetch, app.getPath("userData"));
        lastBridge += `\n\nPeople\n${people}`;
      } catch (e) {
        lastBridge += `\n\nPeople: ${e && e.message ? e.message : e}`;
      }
    }
  } catch (e) {
    lastBridge = `Could not reach the server: ${e && e.message ? e.message : e}`;
  } finally {
    bridgeBusy = false;
  }
  lastBridge = `${new Date().toLocaleTimeString()} — ${lastBridge}`;
  if (manual) dialog.showMessageBox(win, { type: "info", message: "Fingerprint device and people sync", detail: lastBridge });
}

// A copy of the school's data on this PC, once a day (see backup.js).
let lastCopy = "Not run yet";
let copyBusy = false;
async function runCopy(manual) {
  if (copyBusy || mode === "offline") return;
  copyBusy = true;
  try {
    const r = await copyToPc(APP_URL, appFetch, backupFolder(), manual);
    if (r.done || !r.ok || manual) lastCopy = `${new Date().toLocaleString()} — ${r.message}`;
  } catch (e) {
    lastCopy = `${new Date().toLocaleString()} — Could not copy: ${e && e.message ? e.message : e}`;
  } finally {
    copyBusy = false;
  }
  if (manual) dialog.showMessageBox(win, { type: "info", message: "Copy of the school's data on this PC", detail: lastCopy });
}

// Every 20 seconds: is there a person to add to the device, or a fingerprint to take (asked for on the website)?
async function runCommandsOnly() {
  if (bridgeBusy || mode === "offline") return;
  bridgeBusy = true;
  try {
    const text = await runDeviceCommands(APP_URL, appFetch);
    if (text) lastBridge = `${new Date().toLocaleTimeString()} — Done on the device\n${text}`;
  } catch { /* tried again in 20 seconds */ } finally {
    bridgeBusy = false;
  }
}

// ==================== Printing receipts ====================

/** The school page asks to print "/__madani/print?url=<receipt page>": returns that receipt page, else null. */
function printTarget(url) {
  try {
    const u = new URL(url);
    return u.pathname === "/__madani/print" ? u.searchParams.get("url") : null;
  } catch {
    return null;
  }
}

/** Print a school page (a fee receipt) on this PC's default printer, without a print window. */
function silentPrint(url) {
  if (!url || !(isLive(url) || isLocal(url))) return; // only the school's own pages
  const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const close = () => { if (!w.isDestroyed()) w.destroy(); };
  w.webContents.once("did-fail-load", (_e, code) => {
    if (code === -3) return;
    notify("Receipt not printed", "The receipt could not be opened. Try again.");
    close();
  });
  w.webContents.once("did-finish-load", () => {
    w.webContents.print({ silent: true, printBackground: true }, (ok, reason) => {
      if (!ok) notify("Receipt not printed", `The printer did not take it (${reason || "no printer"}). Check that the printer is on and set as the default printer in Windows.`);
      close();
    });
  });
  setTimeout(close, 2 * 60 * 1000); // never left hanging
  w.loadURL(url);
}

// ==================== Window ====================

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "Madani School",
    icon: path.join(__dirname, "build", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // No internet / server unreachable -> work offline if this PC is ready for it, else a friendly page.
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted, e.g. a redirect */) return;
    if (isLocal(url)) return; // the offline copy is restarting; the check below reopens it
    if (mode === "online" && offline.ready()) { goOffline("The website cannot be reached."); return; }
    win.loadFile(path.join(__dirname, "offline.html"), { query: { url: url || APP_URL } });
  });

  // Links to other websites open in the normal browser; school pages (online or offline) stay in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const receipt = printTarget(url);
    if (receipt) { silentPrint(receipt); return { action: "deny" }; } // "Print receipt": straight to the printer
    if (isLive(url) || isLocal(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.endsWith("/__madani/offline")) { e.preventDefault(); goOffline("The internet is off."); return; }
    if (url.endsWith("/__madani/online")) { e.preventDefault(); goOnline(); return; }
    if (mode === "offline" && isLive(url)) { e.preventDefault(); return; } // the website cannot be reached now
    if (isLive(url) || isLocal(url) || url.startsWith("file:")) return;
    e.preventDefault();
    shell.openExternal(url);
  });

  // The offline copy stopped by itself: start it again.
  win.webContents.on("render-process-gone", () => { if (win && !win.isDestroyed()) win.reload(); });

  // Receipts, ID cards, payslips: ask where to save, then open the file.
  win.webContents.session.on("will-download", (_e, item) => {
    item.once("done", (_ev, state) => {
      if (state === "completed") shell.openPath(item.getSavePath());
    });
  });
}

/** Start with Windows: on from the first run; the menu can switch it off (that choice is kept). */
const autostartFlag = () => path.join(app.getPath("userData"), "autostart-chosen");
function setupAutostart() {
  if (!app.isPackaged) return;
  if (!fs.existsSync(autostartFlag())) {
    app.setLoginItemSettings({ openAtLogin: true });
    try { fs.writeFileSync(autostartFlag(), "on"); } catch { /* asked again next start */ }
  }
}
const startsWithWindows = () => app.isPackaged && app.getLoginItemSettings().openAtLogin;

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "App",
        submenu: [
          { label: "Home", accelerator: "Alt+Home", click: () => win && win.loadURL(mode === "offline" ? `${offline.localUrl}/dashboard` : APP_URL) },
          { role: "reload" },
          { role: "forceReload" },
          { type: "separator" },
          { label: "Sync fingerprint device and people now", click: () => runBridge(true) },
          { label: "Fingerprint sync status", click: () => dialog.showMessageBox(win, { type: "info", message: "Last fingerprint sync", detail: lastBridge }) },
          { type: "separator" },
          { label: "Copy the school's data to this PC now", click: () => runCopy(true) },
          { label: "Open the folder of copies", click: () => { fs.mkdirSync(backupFolder(), { recursive: true }); shell.openPath(backupFolder()); } },
          { label: "Copy status", click: () => dialog.showMessageBox(win, { type: "info", message: "Copy of the school's data on this PC", detail: `${lastCopy}\n\nNewest copy: ${newestCopy(backupFolder()) || "none yet"}\nFolder: ${backupFolder()}` }) },
          { type: "separator" },
          {
            label: "Start with Windows",
            type: "checkbox",
            checked: startsWithWindows(),
            enabled: app.isPackaged,
            click: (item) => {
              app.setLoginItemSettings({ openAtLogin: item.checked });
              try { fs.writeFileSync(autostartFlag(), item.checked ? "on" : "off"); } catch { /* kept by Windows anyway */ }
            },
          },
          { label: "Check for updates", click: () => checkForUpdates(true) },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Offline",
        submenu: [
          { label: "Offline status", click: () => dialog.showMessageBox(win, { type: "info", message: "Working without internet", detail: offlineStatusText() }) },
          { label: "Get ready for offline now (copy data and school system)", click: () => keepOfflineReady(true) },
          { label: "Work offline now", click: () => goOffline("Switched by hand.") },
          { label: "Go online and send the offline work", click: () => (mode === "offline" ? goOnline() : sendOfflineWork(true)) },
        ],
      },
      { label: "View", submenu: [{ role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" }, { role: "togglefullscreen" }] },
      { label: "Navigate", submenu: [
        { label: "Back", accelerator: "Alt+Left", click: () => win && win.webContents.navigationHistory.canGoBack() && win.webContents.navigationHistory.goBack() },
        { label: "Forward", accelerator: "Alt+Right", click: () => win && win.webContents.navigationHistory.canGoForward() && win.webContents.navigationHistory.goForward() },
      ] },
    ])
  );
}

function checkForUpdates(manual) {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdates().then((r) => {
    if (!manual) return;
    if (r && r.isUpdateAvailable) {
      dialog.showMessageBox(win, { type: "info", message: `Downloading version ${r.updateInfo.version}…`, detail: "It will install by itself and the app will reopen — nothing to do." });
    } else {
      dialog.showMessageBox(win, { type: "info", message: "Madani School is up to date.", detail: `Version ${app.getVersion()}` });
    }
  }).catch((err) => {
    if (manual) dialog.showMessageBox(win, { type: "warning", message: "Could not check for updates.", detail: String(err) });
  });
}

// Fully automatic updates: download in the background, then install silently and reopen the app
// as soon as nobody is using it (PC idle 2+ minutes, window minimised/hidden) — or when it is closed.
// Waiting for an idle moment means a restart never wipes a form someone is typing.
// Never while offline work is open: the offline copy is closed properly first.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
let pendingUpdate = null;

function installPendingUpdate() {
  if (!pendingUpdate || mode === "offline") return;
  if (quietMoment(120)) {
    app.isQuitting = true;
    autoUpdater.quitAndInstall(true /* silent */, true /* reopen after install */);
  }
}

autoUpdater.on("update-downloaded", (info) => {
  pendingUpdate = info;
  notify("Madani School is updating", `Version ${info.version} is ready. It will install by itself in a quiet moment and the app will reopen.`);
  installPendingUpdate();
});
setInterval(installPendingUpdate, 60 * 1000);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(async () => {
    // Tells the school pages this app can print receipts straight to the printer.
    app.userAgentFallback = `${app.userAgentFallback} MadaniPrint/1`;
    offline = new Offline({
      appUrl: APP_URL,
      root: path.join(app.getPath("userData"), "offline"),
      fetch: appFetch,
      photosFrom: path.join(backupFolder(), "files"),
      runServer: (entry, opts) => fork(entry, [], opts), // Electron runs it as Node (ELECTRON_RUN_AS_NODE)
      log: (m) => console.log(`[offline] ${m}`),
    });
    setupAutostart();
    buildMenu();
    createWindow();
    // Online if the website answers; otherwise straight to offline work when this PC is ready for it.
    if ((await websiteReachable()) || !offline.ready()) win.loadURL(APP_URL);
    else { netFails = 2; await goOffline("The internet is off."); }

    checkForUpdates(false);
    setInterval(() => checkForUpdates(false), 60 * 60 * 1000); // every hour
    setInterval(checkNetwork, 20 * 1000); // online / offline
    setTimeout(() => keepOfflineReady(false), 2 * 60 * 1000); // copy of the data + school system for offline work
    setTimeout(() => runBridge(false), 20 * 1000); // first fingerprint sync shortly after start
    setInterval(() => runBridge(false), 5 * 60 * 1000); // then every 5 minutes
    setTimeout(() => runCopy(false), 90 * 1000); // today's copy of the data, if this PC does not have it yet
    setInterval(() => runCopy(false), 60 * 60 * 1000); // looked at every hour; fetched once a day
    setInterval(runCommandsOnly, 20 * 1000); // requests from the website reach the device quickly
  });
  app.on("window-all-closed", () => app.quit());
  // Close the offline copy properly; its work stays on this PC and is sent when the internet is back.
  let closing = false;
  app.on("before-quit", (e) => {
    if (closing || !offline || !offline.running) return;
    e.preventDefault();
    closing = true;
    offline.stop().finally(() => app.quit());
  });
}
