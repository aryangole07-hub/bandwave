// Mac preload. On Windows a Python helper captures the system audio and sends the spectrum; on the Mac the
// visualizer window does it itself: system audio (macOS 14.2+, via the main process's loopback handler), else the
// microphone. setBands / onSpec / onHit keep the same shape, so viz.js is identical on both systems.
const { contextBridge, ipcRenderer } = require("electron");

const N = 16384;
const specFns = [], hitFns = [];
let analyser = null, db = null, plan = null, edges = null, rate = 48000, starting = false;

function makePlan() {
  if (!edges) return;
  const hz = rate / N;
  plan = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i] / hz, b = edges[i + 1] / hz;
    if (b - a < 1) { const x = (a + b) / 2; plan.push([0, Math.floor(x), x - Math.floor(x)]); }  // narrower than a bin: interpolate
    else plan.push([1, Math.ceil(a), Math.min(Math.floor(b), N / 2 - 1) + 1]);  // max over the bins it covers
  }
}

async function startAudio() {
  if (starting) return;
  starting = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach((t) => t.stop());  // only the audio is wanted
    if (!stream.getAudioTracks().length) throw new Error("no system audio track");
    ipcRenderer.send("health", "audio: system audio");
  } catch (e) {
    ipcRenderer.send("health", "audio: system audio unavailable (" + e.message + "), using the microphone");
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  }
  const ac = new AudioContext();
  rate = ac.sampleRate;
  analyser = ac.createAnalyser();
  analyser.fftSize = N; analyser.smoothingTimeConstant = 0; analyser.minDecibels = -120; analyser.maxDecibels = 0;
  ac.createMediaStreamSource(stream).connect(analyser);
  db = new Float32Array(analyser.frequencyBinCount);
  makePlan();
  setInterval(tick, 16);
}

// kick detector: rise in 40-130 Hz energy above the recent median + 2.2 x upper spread (same rule as the Windows helper)
const hist = [];
let prev = -120, prev1 = 0, prev2 = 0, lastHit = 0;
function kick(now) {
  const hz = rate / N;
  let e = -240;
  for (let i = Math.ceil(40 / hz); i <= 130 / hz; i++) e = Math.max(e, db[i]);
  const x = Math.max(0, e - prev); prev = e;
  if (hist.length >= 10) {
    const h = [...hist].sort((a, b) => a - b), q = (p) => h[Math.min(h.length - 1, Math.floor(p * h.length))];
    const med = q(0.5), thr = med + 2.2 * (q(0.8) - med) + 1e-3;
    if (prev1 > thr && prev1 >= prev2 && prev1 >= x && now - lastHit > 250) {
      lastHit = now;
      const s = Math.min(1, Math.max(0.3, (prev1 - med) / (q(0.97) - med + 1e-6)));
      for (const f of hitFns) f({ k: "kick", s });
    }
  }
  hist.push(prev1); if (hist.length > 36) hist.shift();
  prev2 = prev1; prev1 = x;
}

function tick() {
  if (!plan) return;
  analyser.getFloatFrequencyData(db);
  for (let i = 0; i < db.length; i++) if (!isFinite(db[i])) db[i] = -240;
  const v = plan.map(([interp, a, b]) => {
    if (!interp) return db[a] * (1 - b) + db[a + 1] * b;
    let m = -240; for (let i = a; i < b; i++) if (db[i] > m) m = db[i];
    return m;
  });
  for (const f of specFns) f(v);
  kick(performance.now());
}

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
  toggleBrowse: () => {},  // the Spotify browser is Windows-only
  setBands: (e) => { edges = e; makePlan(); startAudio().catch((err) => ipcRenderer.send("health", "audio failed: " + err.message)); },
  health: (h) => ipcRenderer.send("health", h),
  onSpec: (fn) => specFns.push(fn),
  onHit: (fn) => hitFns.push(fn),
  onBpm: () => {},
  browse: () => {},
  onBrowse: () => {},
  onBrowseOpen: () => {},
  profiles: () => ipcRenderer.invoke("profiles"),
  saveProfile: (name) => ipcRenderer.invoke("profile-save", name),
  deleteProfile: (name) => ipcRenderer.invoke("profile-delete", name),
  loadProfile: (name) => ipcRenderer.send("profile-load", name),
  toggleSettings: () => ipcRenderer.send("toggle-settings"),
});
