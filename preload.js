const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bw", {
  onSettings: (fn) => ipcRenderer.on("settings", (_e, s) => fn(s)),
  onMedia: (fn) => ipcRenderer.on("media", (_e, m) => fn(m)),
  onFullscreen: (fn) => ipcRenderer.on("fullscreen", (_e, on) => fn(on)),
  set: (patch) => ipcRenderer.send("set", patch),
  reset: () => ipcRenderer.send("reset"),
  media: (cmd) => ipcRenderer.send("media-cmd", cmd),
  fullscreen: (on) => ipcRenderer.send("fullscreen", on),
  onPos: (fn) => ipcRenderer.on("pos", (_e, p) => fn(p)),
  onLyrics: (fn) => ipcRenderer.on("lyrics", (_e, l) => fn(l)),
  escape: () => ipcRenderer.send("escape"),
  toggleBrowse: () => ipcRenderer.send("toggle-browse"),
  browse: (cmd, arg) => ipcRenderer.send("browse", cmd, arg),
  onBrowse: (fn) => ipcRenderer.on("browse", (_e, m) => fn(m)),
  onBrowseOpen: (fn) => ipcRenderer.on("browse-open", () => fn()),
  profiles: () => ipcRenderer.invoke("profiles"),
  saveProfile: (name) => ipcRenderer.invoke("profile-save", name),
  deleteProfile: (name) => ipcRenderer.invoke("profile-delete", name),
  loadProfile: (name) => ipcRenderer.send("profile-load", name),
  toggleSettings: () => ipcRenderer.send("toggle-settings"),
});
