const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bw", {
  onSettings: (fn) => ipcRenderer.on("settings", (_e, s) => fn(s)),
  onMedia: (fn) => ipcRenderer.on("media", (_e, m) => fn(m)),
  onFullscreen: (fn) => ipcRenderer.on("fullscreen", (_e, on) => fn(on)),
  set: (patch) => ipcRenderer.send("set", patch),
  reset: () => ipcRenderer.send("reset"),
  media: (cmd) => ipcRenderer.send("media-cmd", cmd),
  fullscreen: (on) => ipcRenderer.send("fullscreen", on),
  ready: () => ipcRenderer.send("ready"),
});
