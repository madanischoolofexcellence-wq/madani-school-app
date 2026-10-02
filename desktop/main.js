// Windows app for Madani School of Excellence.
// It opens the live school system, so every website update appears here immediately.
// The app shell itself also updates automatically from the GitHub release.
// On a school PC it also relays the fingerprint device's punches to the server (see bridge.js).
const { app, BrowserWindow, Menu, shell, dialog, session } = require("electron");
const path = require("path");
const { autoUpdater } = require("electron-updater");
const { syncAll } = require("./bridge");

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
  } catch (e) {
    lastBridge = `Could not reach the server: ${e && e.message ? e.message : e}`;
  } finally {
    bridgeBusy = false;
  }
  lastBridge = `${new Date().toLocaleTimeString()} — ${lastBridge}`;
  if (manual) dialog.showMessageBox(win, { type: "info", message: "Fingerprint device sync", detail: lastBridge });
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
          { label: "Sync fingerprint device now", click: () => runBridge(true) },
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
    if (manual && (!r || !r.isUpdateAvailable)) {
      dialog.showMessageBox(win, { type: "info", message: "Madani School is up to date.", detail: `Version ${app.getVersion()}` });
    }
  }).catch((err) => {
    if (manual) dialog.showMessageBox(win, { type: "warning", message: "Could not check for updates.", detail: String(err) });
  });
}

// Download updates silently in the background and install them when the app is closed.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on("update-downloaded", (info) => {
  dialog
    .showMessageBox(win, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      message: `A new version (${info.version}) of Madani School is ready.`,
      detail: "Restart now to finish updating, or it will update the next time you close the app.",
    })
    .then(({ response }) => { if (response === 0) autoUpdater.quitAndInstall(); });
});

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
    setInterval(() => checkForUpdates(false), 4 * 60 * 60 * 1000); // every 4 hours
    setTimeout(() => runBridge(false), 20 * 1000); // first fingerprint sync shortly after start
    setInterval(() => runBridge(false), 5 * 60 * 1000); // then every 5 minutes
  });
  app.on("window-all-closed", () => app.quit());
}
