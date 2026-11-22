// Bandwave main process: the visualizer window (wallpaper / window / on top / full screen), the settings window,
// the tray, global media shortcuts, and the Python helper (now playing + pinning behind the desktop icons).
const { app, BrowserWindow, Tray, Menu, ipcMain, session, desktopCapturer, globalShortcut, nativeImage, screen, net } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const DEFAULTS = require("./defaults");

// BW_TEST=<folder>: button test run (test/buttons.js) with its own settings, no helper, no shortcuts, nothing sent to Spotify
const TEST = process.env.BW_TEST;
if (TEST) app.setPath("userData", TEST);
if (!app.requestSingleInstanceLock()) app.quit();

const FILE = path.join(app.getPath("userData"), "settings.json");
const PFILE = path.join(app.getPath("userData"), "profiles.json");  // owner's named looks: { name: settings }
const readProfiles = () => { try { return JSON.parse(fs.readFileSync(PFILE, "utf8")); } catch { return {}; } };
const writeProfiles = (p) => { fs.writeFileSync(PFILE, JSON.stringify(p, null, 2)); tray && tray.rebuild(); return p; };
function loadProfile(name) {
  const p = readProfiles()[name];
  if (!p) return;
  const { savedAt, ...look } = p;
  set(look);
}
let S = { ...load(), ...(process.env.BW_SET ? JSON.parse(process.env.BW_SET) : {}) };  // BW_SET: test hook
let viz, settingsWin, tray, helper, media = { type: "media", title: null };
let fullscreen = false, saveTimer, browseWin, lastBands = null, browseBusy = 0;

function load() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { s = { ...DEFAULTS }; }
  if (s.theme === "cover") s.theme = "album";  // renamed 2026-11-22
  return s;
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(FILE, JSON.stringify(S, null, 2), () => {}), 400);
}
function broadcast(ch, v) {
  for (const w of [viz, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send(ch, v);
}

// Time-synced lyrics from LRCLIB (free, open, no key). Only the song's title/artist/album/length are sent.
let lyricKey = null, lyrics = { key: null, lines: null };
function parseLrc(text) {
  const out = [];
  for (const l of text.split(/\r?\n/)) {
    const words = l.replace(/\[[^\]]*\]/g, "").trim();
    for (const g of l.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) out.push({ t: +g[1] * 60 + +g[2], text: words });
  }
  return out.sort((a, b) => a.t - b.t);
}
async function fetchLyrics(m, retry = false) {
  const key = m.title ? `${m.title}|${m.artist}` : null;
  if (key === lyricKey && !retry) return;
  lyricKey = key; lyrics = { key, lines: null }; broadcast("lyrics", lyrics);
  if (!key) return;
  const headers = { "User-Agent": "Bandwave/0.1 (desktop music visualizer)" };
  let lines = [];
  try {
    const q = new URLSearchParams({ track_name: m.title, artist_name: m.artist || "" });
    if (m.album) q.set("album_name", m.album);
    if (m.dur) q.set("duration", Math.round(m.dur));
    let r = await net.fetch("https://lrclib.net/api/get?" + q, { headers }), j = r.ok ? await r.json() : null;
    if (!j || !j.syncedLyrics) {  // exact match missed (album/length differ): best synced search hit
      r = await net.fetch("https://lrclib.net/api/search?" + new URLSearchParams({ track_name: m.title, artist_name: m.artist || "" }), { headers });
      const hits = r.ok ? await r.json() : [];
      j = hits.find((h) => h.syncedLyrics && (!m.dur || Math.abs(h.duration - m.dur) < 8)) || hits.find((h) => h.syncedLyrics) || j;
    }
    if (j && j.syncedLyrics) lines = parseLrc(j.syncedLyrics);
  } catch (e) {
    console.log("[lyrics]", e.message);
    if (!retry) { setTimeout(() => { if (lyricKey === key) fetchLyrics(m, true); }, 8000); return; }
  }
  if (lyricKey === key) { lyrics = { key, lines }; broadcast("lyrics", lyrics); }
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
        if (m.type === "hit" || m.type === "bpm") { if (viz && !viz.isDestroyed()) viz.webContents.send(m.type, m); continue; }
        if (m.type === "spec") { if (viz && !viz.isDestroyed()) viz.webContents.send("spec", m.v); continue; }
        if (m.type === "pos") broadcast("pos", m);
        if (m.type === "browse" && browseWin && !browseWin.isDestroyed()) browseWin.webContents.send("browse", m);
        if (m.type === "media") { media = { ...media, ...m }; if (!("cover" in m) && m.title === null) media.cover = null; broadcast("media", media); fetchLyrics(media); }
      } catch {}
    }
  });
  helper.stderr.on("data", (d) => process.stderr.write(d));
  if (lastBands) tell(`bands ${lastBands}`);  // a restarted helper needs the band layout again
  for (const l of queued.splice(0)) tell(l);
  helper.on("exit", () => { helper = null; if (!app.isQuitting) setTimeout(startHelper, 3000); });  // crash: restart it
}
let queued = [];  // commands sent while the helper is (re)starting go out once it is back
const told = [];
const tell = (line) => { if (TEST) { told.push(line); return; } if (helper && helper.stdin.writable) helper.stdin.write(line + "\n"); else if (queued.push(line) > 20) queued.shift(); };
const hwnd = () => viz.getNativeWindowHandle().readBigUInt64LE(0).toString();

// Alt+Tab (owner 2026-11-22): a real entry in window / full screen. On the wallpaper the visualizer is part of the
// desktop, which Windows never lists, so a minimised stand-in window carries the "Bandwave" entry; picking it
// (Alt+Tab or the taskbar) opens full screen.
let proxy = null;
function syncProxy() {
  const need = S.mode === "wallpaper" && !fullscreen;
  if (need && !proxy) {
    proxy = new BrowserWindow({ width: 480, height: 270, show: false, title: "Bandwave", icon: iconImage(), backgroundColor: "#000000", autoHideMenuBar: true });
    proxy.loadURL("data:text/html,<title>Bandwave</title><body style='background:%23000'>");
    proxy.once("ready-to-show", () => { proxy.showInactive(); proxy.minimize(); });
    proxy.on("restore", () => setImmediate(() => { if (proxy) proxy.minimize(); setFullscreen(true); }));
    proxy.on("close", (e) => { if (!app.isQuitting) { e.preventDefault(); proxy.minimize(); } });
    proxy.on("closed", () => { proxy = null; });
  } else if (!need && proxy) { const p = proxy; proxy = null; setImmediate(() => p.destroy()); }
}

// unpin only a window that was pinned: "unwallpaper" on a normal window landed after show() and left it hidden
let pinned = false;
const unpin = () => { if (pinned) { pinned = false; tell(`unwallpaper ${hwnd()}`); } };
function applyMode() {
  if (!viz) return;
  const b = screen.getPrimaryDisplay().bounds;
  syncProxy();
  viz.setSkipTaskbar(!fullscreen && S.mode === "wallpaper");
  viz.webContents.send("fullscreen", fullscreen);
  if (fullscreen) {
    unpin();
    viz.setBounds(b); viz.setAlwaysOnTop(true, "screen-saver"); viz.setIgnoreMouseEvents(false); viz.show(); viz.focus();
    return;
  }
  if (S.mode === "wallpaper") {
    viz.setAlwaysOnTop(false); viz.setBounds(b); viz.showInactive();
    pinned = true; tell(`wallpaper ${hwnd()}`);
  } else {
    unpin();
    const w = Math.round(b.width * 0.5), h = Math.round(b.height * 0.5);
    viz.setBounds({ x: b.x + (b.width - w) / 2, y: b.y + (b.height - h) / 2, width: w, height: h });
    viz.setAlwaysOnTop(S.mode === "ontop", "floating");
    viz.show();
  }
}

function createViz() {
  const b = screen.getPrimaryDisplay().bounds;
  viz = new BrowserWindow({
    ...b, title: "Bandwave", icon: iconImage(), frame: false, skipTaskbar: true, show: false, backgroundColor: "#000000", resizable: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
  });
  viz.setMenu(null);
  viz.loadFile("viz.html", process.env.BW_DEMO ? { query: { demo: "1" } } : undefined);
  viz.webContents.once("did-finish-load", () => { viz.webContents.send("settings", S); viz.webContents.send("media", media); viz.webContents.send("lyrics", lyrics); applyMode(); });
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

// Spotify browser: a glass panel on top of everything (Tab in Bandwave, Ctrl+Alt+B anywhere)
function toggleBrowse() {
  if (browseWin && !browseWin.isDestroyed() && browseWin.isVisible()) { browseWin.hide(); return; }
  if (!browseWin || browseWin.isDestroyed()) {
    const b = screen.getPrimaryDisplay().workArea, w = 760, h = 680;
    browseWin = new BrowserWindow({
      x: Math.round(b.x + (b.width - w) / 2), y: Math.round(b.y + (b.height - h) / 2), width: w, height: h,
      frame: false, transparent: true, resizable: false, skipTaskbar: true, show: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, "preload.js") },
    });
    browseWin.setAlwaysOnTop(true, "screen-saver");
    browseWin.loadFile("browse.html");
    // click away to close; but not while a search/play is running (Spotify grabs focus for a moment, the helper gives it back)
    browseWin.on("blur", () => { if (browseWin && !browseWin.isDestroyed() && Date.now() > browseBusy) browseWin.hide(); });
    browseWin.once("ready-to-show", () => { browseWin.show(); browseWin.focus(); });
  } else { browseWin.show(); browseWin.focus(); browseWin.webContents.send("browse-open"); }
}

function setFullscreen(on) { fullscreen = on; applyMode(); }

function iconImage() { return nativeImage.createFromPath(path.join(__dirname, "icon.png")); }

function buildTray() {
  tray = new Tray(iconImage());
  tray.setToolTip("Bandwave");
  const menu = tray.menu = () => Menu.buildFromTemplate([
    { label: "Settings", click: openSettings },
    { label: "Full screen  (Ctrl+Alt+F)", click: () => setFullscreen(!fullscreen) },
    { label: "Album mode (colours from the cover)", type: "checkbox", checked: S.theme === "album",
      click: () => set(S.theme === "album" ? { theme: S.prevTheme || "nebula" } : { prevTheme: S.theme, theme: "album" }) },
    { label: "Profiles", submenu: Object.keys(readProfiles()).length
        ? Object.keys(readProfiles()).sort((a, b) => a.localeCompare(b)).map((n) => ({ label: n, click: () => loadProfile(n) }))
        : [{ label: "No saved profiles yet", enabled: false }] },
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

// "Open with Spotify": a logon entry runs spotify-watch.vbs, which opens Bandwave whenever Spotify starts
function syncSpotifyWatch() {
  if (TEST) return;
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", name = "Bandwave with Spotify";
  const vbs = path.join(__dirname, "spotify-watch.vbs");
  const args = S.withSpotify ? ["add", key, "/v", name, "/t", "REG_SZ", "/d", `wscript.exe "${vbs}"`, "/f"] : ["delete", key, "/v", name, "/f"];
  spawn("reg.exe", args, { windowsHide: true }).on("error", () => {});
  if (S.withSpotify) spawn("wscript.exe", [vbs], { windowsHide: true, detached: true, stdio: "ignore" }).unref();  // start watching now, not only after the next logon
  else spawn("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | ? CommandLine -like '*spotify-watch.ps1*' | % { Stop-Process -Id $_.ProcessId -Force }"], { windowsHide: true });
}

// "Close with Spotify": quit when Spotify's process goes from running to gone. Never quits if Spotify was not
// running to begin with (opening Bandwave on its own keeps it open).
function watchSpotifyExit() {
  if (TEST) return;
  let seen = false;
  setInterval(() => {
    const p = spawn("tasklist.exe", ["/FI", "IMAGENAME eq Spotify.exe", "/NH"], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => {});
    p.on("close", (code) => {
      if (code !== 0) return;
      const running = /spotify\.exe/i.test(out);
      if (seen && !running && S.closeWithSpotify) { app.isQuitting = true; app.quit(); }
      seen = running;
    });
  }, 4000);
}

function set(patch) {
  const modeChanged = "mode" in patch && patch.mode !== S.mode;
  S = { ...S, ...patch };
  if ("withSpotify" in patch) syncSpotifyWatch();
  if ("startup" in patch && !TEST) app.setLoginItemSettings({ openAtLogin: !!S.startup, path: process.execPath, args: [app.getAppPath()] });  // unpackaged: electron.exe + this folder
  save();
  broadcast("settings", S);
  if (modeChanged) { fullscreen = false; applyMode(); }
  if (modeChanged || "theme" in patch) tray && tray.rebuild();
}

app.whenReady().then(() => {
  if (TEST) {
    createViz(); buildTray();
    return require("./test/buttons")({ app, get viz() { return viz; }, get settingsWin() { return settingsWin; }, get browseWin() { return browseWin; },
      get S() { return S; }, get fullscreen() { return fullscreen; }, told, tray, openSettings, toggleBrowse, readProfiles, DEFAULTS });
  }
  startHelper();
  createViz();
  buildTray();
  syncSpotifyWatch();
  watchSpotifyExit();
  globalShortcut.register("Control+Alt+F", () => setFullscreen(!fullscreen));
  globalShortcut.register("Control+Alt+Space", () => tell("play_pause"));
  globalShortcut.register("Control+Alt+Right", () => tell("next"));
  globalShortcut.register("Control+Alt+Left", () => tell("prev"));
  globalShortcut.register("Control+Alt+B", toggleBrowse);
  if (!fs.existsSync(FILE)) openSettings();  // first run: show what it can do
  screen.on("display-metrics-changed", applyMode);
  if (process.env.BW_SNAP) setTimeout(snap, 7000);
  if (process.env.BW_PERF) setInterval(() => {  // test hook: CPU per Electron process
    console.log("[perf] gpu:", app.getGPUFeatureStatus().gpu_compositing, app.getGPUFeatureStatus()["2d_canvas"], app.getAppMetrics().map((m) => `${m.type}:${m.cpu.percentCPUUsage.toFixed(1)}%`).join(" "));
  }, 3000);  // test hook: save what each window shows, then quit
});

async function snap() {
  openSettings();
  await new Promise((r) => setTimeout(r, 2500));
  for (const [name, w] of [["viz", viz], ["settings", settingsWin]]) fs.writeFileSync(path.join(process.env.BW_SNAP, (process.env.BW_NAME || "") + name + ".png"), (await w.webContents.capturePage()).toPNG());
  app.isQuitting = true; app.quit();
}

app.on("second-instance", openSettings);
app.on("window-all-closed", (e) => e.preventDefault?.());  // lives in the tray
app.on("will-quit", () => { globalShortcut.unregisterAll(); if (viz) unpin(); helper && helper.stdin.end(); });

ipcMain.on("set", (_e, patch) => set(patch));
ipcMain.on("reset", () => set({ ...DEFAULTS, mode: S.mode, startup: S.startup }));
ipcMain.on("media-cmd", (_e, cmd) => tell(cmd));
ipcMain.on("toggle-browse", toggleBrowse);
ipcMain.on("bands", (_e, edges) => { lastBands = JSON.stringify(edges); tell(`bands ${lastBands}`); });
ipcMain.on("browse", (_e, cmd, arg) => {
  browseBusy = Date.now() + 3000;
  tell(`browse_${cmd} ${String(arg || "").replace(/\s+/g, " ")}`);
});
ipcMain.handle("profiles", () => readProfiles());
ipcMain.handle("profile-save", (_e, name) => {
  const { startup, mode, ...look } = S;  // a profile is a look, not where/when the app runs
  return writeProfiles({ ...readProfiles(), [name]: { ...look, savedAt: Date.now() } });
});
ipcMain.handle("profile-delete", (_e, name) => { const p = readProfiles(); delete p[name]; return writeProfiles(p); });
ipcMain.on("profile-load", (_e, name) => loadProfile(name));
ipcMain.on("fullscreen", (_e, on) => setFullscreen(on));
// Esc in full screen: drop to a normal window (owner 2026-11-22)
ipcMain.on("escape", () => { if (!fullscreen) return; fullscreen = false; if (S.mode !== "window") set({ mode: "window" }); else applyMode(); });
// ` (backtick): settings on top of everything, including full screen; again to hide
ipcMain.on("toggle-settings", () => {
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible() && settingsWin.isFocused()) { settingsWin.hide(); viz && viz.focus(); return; }
  openSettings(); settingsWin.setAlwaysOnTop(true, "screen-saver"); settingsWin.show(); settingsWin.focus();
});
