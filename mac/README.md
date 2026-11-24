# Bandwave for Mac

The same visualizer as the Windows version (shapes, styles, bands, themes, album colours, record, synced lyrics, profiles),
ported to macOS. It lives in the menu bar; click the icon for settings.

## Install

1. Download `Bandwave-Mac.dmg` from the release (one file for both Apple silicon and Intel Macs; needs macOS 12 Monterey or newer).
2. Open it and drag Bandwave into Applications.
3. The app isn't notarised by Apple, so the first open is blocked. Open it once, then go to **System Settings -> Privacy & Security**,
   scroll down and click **Open Anyway** (on macOS 14 and older you can instead right-click the app -> Open).
4. Allow the prompts: **System audio / Screen & System Audio Recording** (so it can hear what the Mac plays) and
   **Automation -> Spotify / Music** (song name, cover, play / pause / skip). If you click Don't Allow, turn it on later in
   System Settings -> Privacy & Security, then quit and reopen Bandwave.

## What differs from Windows

| | Windows | Mac |
|---|---|---|
| System audio | WASAPI loopback (Python helper) | CoreAudio tap, macOS 14.2+; older macOS uses the microphone |
| Now playing | any player (Windows media session) | Spotify and Apple Music (AppleScript) |
| Wallpaper mode | pinned behind the desktop icons | a desktop-level window behind the icons, on every Space |
| Spotify browser (Tab) | yes | no |
| Open with Spotify | yes | no |
| Shortcuts | Ctrl+Alt+Space / Left / Right | Control+Option+Space / Left / Right |

## Build

On a Mac: `npm install`, `npm start` to run, `npm run dist` for the .dmg files in `dist/`.
Or let GitHub build it: `.github/workflows/mac.yml` runs on every push that touches `mac/`.

Settings: `~/Library/Application Support/bandwave/settings.json`. Log: `bandwave.log` in the same folder.
