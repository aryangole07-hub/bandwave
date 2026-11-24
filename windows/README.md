# Bandwave

Live music visualizer for the Windows desktop. It sits behind your desktop icons (or in a window / on top / full screen),
reacts to whatever your PC is playing, and shows the Spotify (or any player's) song, artist and cover.

- Start: double-click `start.vbs`. It lives in the tray; click the tray icon for settings.
- Shapes: circle, polygon, star, heart, infinity, spiral, line, wave. Styles: bars, smooth curve, dots, LED blocks.
- Bands: count, lowest/highest Hz with log/mel/linear spacing, or your own band edges in Hz.
- Shortcuts: F full screen (in Bandwave), Ctrl+Alt+Space play/pause, Ctrl+Alt+Left/Right skip.

How it works: Electron draws the visualizer on a canvas from Chromium's system-audio loopback (Web Audio FFT, 16384 points).
`helper/media.py` reads the Windows media session (title, artist, cover, play/pause/skip) and pins the window into the
desktop's WorkerW layer behind the icons. Settings: `%APPDATA%\bandwave\settings.json`.

## Install (for anyone)

Run `Bandwave-Setup.exe` (from the GitHub release). It installs for the current user, no admin needed, adds Start
menu and desktop shortcuts, and opens Bandwave. Windows may show "Windows protected your PC" because the installer
isn't code-signed: click **More info -> Run anyway**. Uninstall from Settings -> Apps.

## Build setup.exe from this folder

```
npm install
py -3.12 -m venv .venv
.venv\Scripts\pip install -r helper\requirements.txt pyinstaller
.venv\Scripts\activate && npm run helper     # freezes helper/media.py into build/helper-dist (no Python needed on the target PC)
npm run dist                                  # -> dist/Bandwave-Setup.exe
```

From source without installing: `npm start` (uses `.venv\Scripts\python.exe` for the helper), or double-click `start.vbs`.

Test hooks: `BW_DEMO=1` feeds a fake spectrum; `BW_SNAP=<dir>` saves both windows as PNG and quits; `BW_SET=<json>` overrides settings for that run.

