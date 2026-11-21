// Bandwave main process: the visualizer window (wallpaper / window / on top / full screen), the settings window,
// the tray, global media shortcuts, and the Python helper (now playing + pinning behind the desktop icons).
const { app, BrowserWindow, Tray, Menu, ipcMain, session, desktopCapturer, globalShortcut, nativeImage, screen } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const DEFAULTS = require("./defaults");

if (!app.requestSingleInstanceLock()) app.quit();

const FILE = path.join(app.getPath("userData"), "settings.json");
let S = { ...load(), ...(process.env.BW_SET ? JSON.parse(process.env.BW_SET) : {}) };  // BW_SET: test hook
let viz, settingsWin, tray, helper, media = { type: "media", title: null };
let fullscreen = false, saveTimer;

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { return { ...DEFAULTS }; }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(FILE, JSON.stringify(S, null, 2), () => {}), 400);
}
function broadcast(ch, v) {
  for (const w of [viz, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send(ch, v);
}

function startHelper() {
  const py = path.join(__dirname, ".venv", "Scripts", "python.exe");
  helper = spawn(py, [path.join(__dirname, "helper", "media.py")], { windowsHide: true });
  let buf = "";
  helper.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.type === "log") console.log("[helper]", m.msg);
        if (m.type === "media") { media = { ...media, ...m }; if (!("cover" in m) && m.title === null) media.cover = null; broadcast("media", media); }
      } catch {}
    }
  });
  helper.stderr.on("data", (d) => process.stderr.write(d));
  helper.on("exit", () => { if (!app.isQuitting) setTimeout(startHelper, 3000); });  // crash: restart it
}
const tell = (line) => helper && helper.stdin.writable && helper.stdin.write(line + "\n");
const hwnd = () => viz.getNativeWindowHandle().readBigUInt64LE(0).toString();

function applyMode() {
  if (!viz) return;
  const b = screen.getPrimaryDisplay().bounds;
  viz.webContents.send("fullscreen", fullscreen);
  if (fullscreen) {
    tell(`unwallpaper ${hwnd()}`);
    viz.setBounds(b); viz.setAlwaysOnTop(true, "screen-saver"); viz.setIgnoreMouseEvents(false); viz.show(); viz.focus();
    return;
  }
  if (S.mode === "wallpaper") {
    viz.setAlwaysOnTop(false); viz.setBounds(b); viz.showInactive();
    tell(`wallpaper ${hwnd()}`);
  } else {
    tell(`unwallpaper ${hwnd()}`);
    const w = Math.round(b.width * 0.5), h = Math.round(b.height * 0.5);
    viz.setBounds({ x: b.x + (b.width - w) / 2, y: b.y + (b.height - h) / 2, width: w, height: h });
    viz.setAlwaysOnTop(S.mode === "ontop", "floating");
    viz.show();
  }
}

function createViz() {
  const b = screen.getPrimaryDisplay().bounds;
  viz = new BrowserWindow({
    ...b, frame: false, skipTaskbar: true, show: false, backgroundColor: "#000000", resizable: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
  });
  viz.setMenu(null);
  viz.loadFile("viz.html", process.env.BW_DEMO ? { query: { demo: "1" } } : undefined);
  viz.webContents.once("did-finish-load", () => { viz.webContents.send("settings", S); viz.webContents.send("media", media); applyMode(); });
  viz.on("closed", () => { viz = null; });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 1120, height: 860, minWidth: 760, minHeight: 560, title: "Bandwave", backgroundColor: "#0d0e12",
    autoHideMenuBar: true, icon: iconImage(), webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile("settings.html");
  settingsWin.webContents.once("did-finish-load", () => { settingsWin.webContents.send("settings", S); settingsWin.webContents.send("media", media); });
}

function setFullscreen(on) { fullscreen = on; applyMode(); }

function iconImage() { return nativeImage.createFromPath(path.join(__dirname, "icon.png")); }

function buildTray() {
  tray = new Tray(iconImage());
  tray.setToolTip("Bandwave");
  const menu = () => Menu.buildFromTemplate([
    { label: "Settings", click: openSettings },
    { label: "Full screen  (Ctrl+Alt+F)", click: () => setFullscreen(!fullscreen) },
    { type: "separator" },
    ...[["wallpaper", "On the wallpaper"], ["window", "In a window"], ["ontop", "Always on top"]].map(([v, label]) => ({
      label, type: "radio", checked: S.mode === v, click: () => set({ mode: v }),
    })),
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on("click", openSettings);
  tray.rebuild = () => tray.setContextMenu(menu());
}

function set(patch) {
  const modeChanged = "mode" in patch && patch.mode !== S.mode;
  S = { ...S, ...patch };
  if ("startup" in patch) app.setLoginItemSettings({ openAtLogin: !!S.startup, path: process.execPath, args: [app.getAppPath()] });  // unpackaged: electron.exe + this folder
  save();
  broadcast("settings", S);
  if (modeChanged) { fullscreen = false; applyMode(); tray && tray.rebuild(); }
}

app.whenReady().then(() => {
  // System audio for the analyser: Chromium's own WASAPI loopback, granted without a picker.
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ["screen"] }).then((src) => cb({ video: src[0], audio: "loopback" }));
  });
  startHelper();
  createViz();
  buildTray();
  globalShortcut.register("Control+Alt+F", () => setFullscreen(!fullscreen));
  globalShortcut.register("Control+Alt+Space", () => tell("play_pause"));
  globalShortcut.register("Control+Alt+Right", () => tell("next"));
  globalShortcut.register("Control+Alt+Left", () => tell("prev"));
  if (!fs.existsSync(FILE)) openSettings();  // first run: show what it can do
  screen.on("display-metrics-changed", applyMode);
  if (process.env.BW_SNAP) setTimeout(snap, 7000);  // test hook: save what each window shows, then quit
});

async function snap() {
  openSettings();
  await new Promise((r) => setTimeout(r, 2500));
  for (const [name, w] of [["viz", viz], ["settings", settingsWin]]) fs.writeFileSync(path.join(process.env.BW_SNAP, (process.env.BW_NAME || "") + name + ".png"), (await w.webContents.capturePage()).toPNG());
  app.isQuitting = true; app.quit();
}

app.on("second-instance", openSettings);
app.on("window-all-closed", (e) => e.preventDefault?.());  // lives in the tray
app.on("will-quit", () => { globalShortcut.unregisterAll(); if (viz) tell(`unwallpaper ${hwnd()}`); helper && helper.stdin.end(); });

ipcMain.on("set", (_e, patch) => set(patch));
ipcMain.on("reset", () => set({ ...DEFAULTS, mode: S.mode, startup: S.startup }));
ipcMain.on("media-cmd", (_e, cmd) => tell(cmd));
ipcMain.on("fullscreen", (_e, on) => setFullscreen(on));
