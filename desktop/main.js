// Windows app for Madani School of Excellence.
// It opens the live school system, so every website update appears here immediately.
// The app shell itself also updates automatically from the GitHub release.
// On a school PC it also relays the fingerprint device's punches to the server (see bridge.js).
const { app, BrowserWindow, Menu, shell, dialog, session, Notification, powerMonitor } = require("electron");
const path = require("path");
const { autoUpdater } = require("electron-updater");
const { syncAll } = require("./bridge");
const { syncPeople } = require("./zkbio");

const APP_URL = "https://madani-school-management-production.up.railway.app";
const APP_ORIGIN = new URL(APP_URL).origin;

let win = null;
let lastBridge = "Not run yet";
let bridgeBusy = false;

// Read the fingerprint device(s) on the school network and send the punches to the server.
async function runBridge(manual) {
  if (bridgeBusy) return;
  bridgeBusy = true;
  try {
    const r = await syncAll(APP_URL, (url, opts) => session.defaultSession.fetch(url, opts));
    if (!r.loggedIn) {
      lastBridge = "Waiting for someone to log in";
    } else if (r.results.length === 0) {
      lastBridge = "No device added on the website yet";
    } else {
      lastBridge = r.results.map((x) => `${x.name}: ${x.ok ? "OK" : "FAILED"} — ${x.message}`).join("\n");
    }
    // People: ZKBio Time.Net on this PC <-> the school system (see zkbio.js).
    if (r.loggedIn) {
      try {
        const people = await syncPeople(APP_URL, (url, opts) => session.defaultSession.fetch(url, opts), app.getPath("userData"));
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

  win.loadURL(APP_URL);

  // No internet / server unreachable -> friendly offline page with a retry button.
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted, e.g. a redirect */) return;
    win.loadFile(path.join(__dirname, "offline.html"), { query: { url: url || APP_URL } });
  });

  // Links to other websites open in the normal browser; school pages stay in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_ORIGIN)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(APP_ORIGIN) || url.startsWith("file:")) return;
    e.preventDefault();
    shell.openExternal(url);
  });

  // Receipts, ID cards, payslips: ask where to save, then open the file.
  win.webContents.session.on("will-download", (_e, item) => {
    item.once("done", (_ev, state) => {
      if (state === "completed") shell.openPath(item.getSavePath());
    });
  });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "App",
        submenu: [
          { label: "Home", accelerator: "Alt+Home", click: () => win && win.loadURL(APP_URL) },
          { role: "reload" },
          { role: "forceReload" },
          { type: "separator" },
          { label: "Sync fingerprint device and people now", click: () => runBridge(true) },
          { label: "Fingerprint sync status", click: () => dialog.showMessageBox(win, { type: "info", message: "Last fingerprint sync", detail: lastBridge }) },
          { type: "separator" },
          { label: "Check for updates", click: () => checkForUpdates(true) },
          { type: "separator" },
          { role: "quit" },
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
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
let pendingUpdate = null;

function installPendingUpdate() {
  if (!pendingUpdate) return;
  const idle = powerMonitor.getSystemIdleTime() >= 120;
  const away = !win || win.isMinimized() || !win.isVisible();
  if (idle || away) {
    app.isQuitting = true;
    autoUpdater.quitAndInstall(true /* silent */, true /* reopen after install */);
  }
}

autoUpdater.on("update-downloaded", (info) => {
  pendingUpdate = info;
  if (Notification.isSupported()) {
    new Notification({
      title: "Madani School is updating",
      body: `Version ${info.version} is ready. It will install by itself in a quiet moment and the app will reopen.`,
    }).show();
  }
  installPendingUpdate();
});
setInterval(installPendingUpdate, 60 * 1000);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    checkForUpdates(false);
    setInterval(() => checkForUpdates(false), 60 * 60 * 1000); // every hour
    setTimeout(() => runBridge(false), 20 * 1000); // first fingerprint sync shortly after start
    setInterval(() => runBridge(false), 5 * 60 * 1000); // then every 5 minutes
  });
  app.on("window-all-closed", () => app.quit());
}
