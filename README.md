# Bandwave

Live music visualizer for the Windows desktop. It sits behind your desktop icons (or in a window / on top / full screen),
reacts to whatever your PC is playing, and shows the Spotify (or any player's) song, artist and cover.

- Start: double-click `start.vbs`. It lives in the tray; click the tray icon for settings.
- Shapes: circle, polygon, star, heart, infinity, spiral, line, wave. Styles: bars, smooth curve, dots, LED blocks.
- Bands: count, lowest/highest Hz with log/mel/linear spacing, or your own band edges in Hz.
- Shortcuts: Ctrl+Alt+F full screen, Ctrl+Alt+Space play/pause, Ctrl+Alt+Left/Right skip.

How it works: Electron draws the visualizer on a canvas from Chromium's system-audio loopback (Web Audio FFT, 16384 points).
`helper/media.py` reads the Windows media session (title, artist, cover, play/pause/skip) and pins the window into the
desktop's WorkerW layer behind the icons. Settings: `%APPDATA%\bandwave\settings.json`.

Setup (already done here): `npm install`, then `py -3.12 -m venv .venv` and
`.venv\Scripts\pip install winrt-runtime winrt-Windows.Media.Control winrt-Windows.Storage.Streams winrt-Windows.Foundation winrt-Windows.Foundation.Collections`.

Test hooks: `BW_DEMO=1` feeds a fake spectrum; `BW_SNAP=<dir>` saves both windows as PNG and quits; `BW_SET=<json>` overrides settings for that run.

uiautomation (pip) is also needed for the Spotify browser.
