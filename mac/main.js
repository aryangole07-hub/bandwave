// Bandwave for macOS, main process: the visualizer window (wallpaper / window / on top / full screen), the settings
// window, the menu bar icon, global media shortcuts, and now playing from Spotify / Apple Music via AppleScript.
// The audio is captured in the visualizer window itself (preload.js); this process only grants it system audio.
const { app, BrowserWindow, Tray, Menu, ipcMain, session, desktopCapturer, globalShortcut, nativeImage, screen, net } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const DEFAULTS = require("./defaults");

// BW_TEST=<folder>: run with its own settings folder, no shortcuts, nothing sent to the player
const TEST = process.env.BW_TEST;
if (TEST) app.setPath("userData", TEST);
if (!app.requestSingleInstanceLock()) app.quit();
// a window the system thinks is covered stops drawing; Bandwave must always draw
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

// bandwave.log in userData: which audio source was used and a 10 s health line from the visualizer
const LOG = path.join(app.getPath("userData"), "bandwave.log");
function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(" ")}\n`;
  try { if (fs.statSync(LOG).size > 2e6) fs.renameSync(LOG, LOG + ".1"); } catch {}
  try { fs.appendFileSync(LOG, line); } catch {}
}

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
let viz, settingsWin, tray, media = { type: "media", title: null };
let fullscreen = false, saveTimer;

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

// ---------- now playing: Spotify, else Apple Music, polled with AppleScript ----------
// "if application X is running" never launches the player. Fields are joined with ASCII 31.
const US = String.fromCharCode(31);
const playerScript = (a, cover) => `if application "${a}" is running then
  tell application "${a}"
    if player state is stopped then return ""
    set t to current track
    return "${a}" & "${US}" & (name of t) & "${US}" & (artist of t) & "${US}" & (album of t) & "${US}" & (duration of t) & "${US}" & player position & "${US}" & (player state as string) & "${US}" & ${cover}
  end tell
end if
return ""`;
const osa = (script) => new Promise((res) => execFile("osascript", ["-e", script], { timeout: 4000 }, (err, out) => res(err ? "" : String(out).trim())));
let lastKey = null, polling = false;
async function pollMedia() {
  if (polling) return;
  polling = true;
  try {
    let line = await osa(playerScript("Spotify", "(artwork url of t)"));
    if (!line) line = await osa(playerScript("Music", '""'));
    if (!line) {
      if (lastKey !== null) { lastKey = null; media = { type: "media", title: null, cover: null }; broadcast("media", media); fetchLyrics(media); }
      return;
    }
    const [player, title, artist, album, durRaw, posRaw, state, art] = line.split(US);
    const playing = state === "playing";
    const dur = player === "Spotify" ? +durRaw / 1000 : +String(durRaw).replace(",", ".");  // Spotify gives ms, Music seconds
    broadcast("pos", { type: "pos", pos: +String(posRaw).replace(",", "."), at: Date.now(), playing });
    const key = `${title}|${artist}|${playing}`;
    if (key === lastKey) return;
    const songChanged = !lastKey || !lastKey.startsWith(`${title}|${artist}|`);
    lastKey = key;
    media = { ...media, type: "media", title, artist, album, playing, app: player, dur };
    if (songChanged) {
      media.cover = null;
      if (art) {
        try {  // a data URL, so the visualizer can read the cover's colours (album mode)
          const r = await net.fetch(art);
          media.cover = `data:${r.headers.get("content-type") || "image/jpeg"};base64,` + Buffer.from(await r.arrayBuffer()).toString("base64");
        } catch {}
      }
    }
    broadcast("media", media);
    fetchLyrics(media);
  } finally { polling = false; }
}
const told = [];
function tell(cmd) {
  const verb = { play_pause: "playpause", next: "next track", prev: "previous track" }[cmd];
  if (!verb) return;  // wallpaper pinning and the Spotify browser are Windows-only
  if (TEST) { told.push(cmd); return; }
  const player = media.app === "Music" ? "Music" : "Spotify";
  osa(`if application "${player}" is running then tell application "${player}" to ${verb}`).then(() => setTimeout(pollMedia, 300));
}
ipcMain.on("health", (_e, h) => log("[viz]", h));



// Wallpaper on the Mac = a window of type "desktop" (below the icons, on every Space). The type is fixed when the
// window is made, so switching to or from the wallpaper rebuilds the window.
function applyMode() {
  if (!viz) return;
  const b = screen.getPrimaryDisplay().bounds;
  const desktop = S.mode === "wallpaper" && !fullscreen;
  if (desktop !== viz.isDesktop) { const old = viz; createViz(desktop); old.destroy(); return; }
  viz.webContents.send("fullscreen", fullscreen);
  if (fullscreen) {
    viz.setBounds(b); viz.setAlwaysOnTop(true, "screen-saver"); viz.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); viz.show(); viz.focus();
    return;
  }
  if (desktop) { viz.setBounds(b); viz.setVisibleOnAllWorkspaces(true); viz.showInactive(); return; }
  viz.setVisibleOnAllWorkspaces(false);
  const w = Math.round(b.width * 0.5), h = Math.round(b.height * 0.5);
  viz.setBounds({ x: b.x + (b.width - w) / 2, y: b.y + (b.height - h) / 2, width: w, height: h });
  viz.setAlwaysOnTop(S.mode === "ontop", "floating"); viz.show(); viz.focus();
}

function createViz(desktop = S.mode === "wallpaper" && !fullscreen) {
  const b = screen.getPrimaryDisplay().bounds;
  const w = new BrowserWindow({
    ...b, title: "Bandwave", frame: false, show: false, backgroundColor: "#000000", resizable: true, ...(desktop ? { type: "desktop" } : {}),
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
  });
  w.isDesktop = desktop;
  viz = w;
  w.loadFile("viz.html", process.env.BW_DEMO ? { query: { demo: "1" } } : undefined);
  w.webContents.once("did-finish-load", () => { w.webContents.send("settings", S); w.webContents.send("media", media); w.webContents.send("lyrics", lyrics); applyMode(); });
  w.on("closed", () => { if (viz === w) viz = null; });
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

function iconImage() { return nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 18, height: 18 }); }

function buildTray() {
  tray = new Tray(iconImage());
  tray.setToolTip("Bandwave");
  const menu = tray.menu = () => Menu.buildFromTemplate([
    { label: "Settings", click: openSettings },
    { label: "Full screen  (F)", click: () => setFullscreen(!fullscreen) },
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


// "Close with Spotify": quit when Spotify's process goes from running to gone. Never quits if Spotify was not
// running to begin with (opening Bandwave on its own keeps it open).
function watchSpotifyExit() {
  if (TEST) return;
  let seen = false;
  setInterval(() => {
    execFile("pgrep", ["-x", "Spotify"], (err) => {
      if (err && err.code !== 1) return;  // 1 = not running; anything else = pgrep failed
      const running = !err;
      if (seen && !running && S.closeWithSpotify) { app.isQuitting = true; app.quit(); }
      seen = running;
    });
  }, 4000);
}

function set(patch) {
  const modeChanged = "mode" in patch && patch.mode !== S.mode;
  S = { ...S, ...patch };
  if ("startup" in patch && !TEST) app.setLoginItemSettings({ openAtLogin: !!S.startup });
  save();
  broadcast("settings", S);
  if (modeChanged) { fullscreen = false; applyMode(); }
  if (modeChanged || "theme" in patch) tray && tray.rebuild();
}

app.whenReady().then(() => {
  // system audio for the visualizer: answer its getDisplayMedia with the screen + "loopback" audio (CoreAudio tap,
  // macOS 14.2+); on older macOS preload.js falls back to the microphone
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
      .then((src) => cb(src.length ? { video: src[0], audio: "loopback" } : {}))
      .catch(() => cb({}));
  });
  createViz();
  buildTray();
  watchSpotifyExit();
  pollMedia(); setInterval(pollMedia, 1000);
  // no global Ctrl+Alt+F any more: it fired by itself right after launch (owner 2026-11-22); full screen = F in Bandwave
  globalShortcut.register("Control+Alt+Space", () => tell("play_pause"));
  globalShortcut.register("Control+Alt+Right", () => tell("next"));
  globalShortcut.register("Control+Alt+Left", () => tell("prev"));
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
app.on("activate", openSettings);  // Dock icon click
app.on("window-all-closed", (e) => e.preventDefault?.());  // lives in the tray
app.on("will-quit", () => globalShortcut.unregisterAll());

ipcMain.on("set", (_e, patch) => set(patch));
ipcMain.on("reset", () => set({ ...DEFAULTS, mode: S.mode, startup: S.startup }));
ipcMain.on("media-cmd", (_e, cmd) => tell(cmd));
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
