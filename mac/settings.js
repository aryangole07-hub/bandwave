// Settings window: built from SCHEMA; every change is sent straight to the visualizer (live) and saved by main.js.
const $ = (id) => document.getElementById(id);
let S = {};

// [key, label, kind, ...args, hint?]   kinds: seg(options) | range(min,max,step,fmt) | toggle | color | text | number(min,max)
const pct = (v) => Math.round(v * 100) + "%";
const SCHEMA = [
  ["Shape", [
    ["shape", "Spread around", "seg", ["circle", "polygon", "star", "heart", "infinity", "spiral", "line", "wave"]],
    ["sides", "Sides / points", "range", 3, 16, 1, (v) => v, (s) => ["polygon", "star"].includes(s.shape)],
    ["size", "Size", "range", 0.05, 0.45, 0.01, pct],
    ["rotate", "Spin", "range", -0.3, 0.3, 0.01, (v) => (v ? v.toFixed(2) + " /s" : "off")],
    ["offsetX", "Move left/right", "range", -0.4, 0.4, 0.01, pct],
    ["offsetY", "Move up/down", "range", -0.4, 0.4, 0.01, pct],
  ]],
  ["Bands", [
    ["spacing", "Band spacing", "seg", ["log", "mel", "linear", "custom"]],
    ["bands", "Number of bands", "range", 4, 256, 1, (v) => v, (s) => s.spacing !== "custom"],
    ["minHz", "Lowest (Hz)", "number", 10, 20000, (s) => s.spacing !== "custom"],
    ["maxHz", "Highest (Hz)", "number", 50, 24000, (s) => s.spacing !== "custom"],
    ["customEdges", "Band edges (Hz)", "text", (s) => s.spacing === "custom", "Each pair of neighbours is one band, e.g. 20, 60, 250 = two bands: 20–60 and 60–250 Hz."],
    ["symmetric", "Mirror spectrum", "toggle"],
    ["mirror", "Grow both ways", "toggle"],
    ["tilt", "Treble lift", "range", 0, 2, 0.05, (v) => v.toFixed(2)],
  ]],
  ["Style", [
    ["style", "Draw as", "seg", ["bars", "curve", "dots", "blocks"]],
    ["length", "Band length", "range", 0.05, 0.6, 0.01, pct],
    ["thickness", "Thickness", "range", 0.1, 1, 0.01, pct],
    ["rounded", "Rounded ends", "toggle", (s) => s.style === "bars"],
    ["fill", "Fill under curve", "toggle", (s) => s.style === "curve"],
    ["layers", "Echo layers", "range", 1, 6, 1, (v) => (v > 1 ? v - 1 : "off")],
    ["echoShadow", "Echo shadows", "range", 0, 1, 0.05, (v) => (v ? Math.round(v * 100) + "%" : "off"), (s) => s.layers > 1],
    ["echoBeat", "Echo lag", "range", 0.0625, 1, 0.0625, (v) => (v >= 1 ? "1 beat" : `1/${Math.round(1 / v)} beat`), (s) => s.layers > 1, "Follows the song's tempo, detected from the kick drum."],
  ]],
  ["Colour", [
    ["theme", "Theme", "seg", ["album", "nebula", "sunset", "ocean", "neon", "fire", "ice", "custom"]],
    ["custom", "Custom colour", "color", (s) => s.theme === "custom"],
    ["colorBy", "Colour by", "seg", ["position", "level"]],
    ["flow", "Colour flow", "range", 0, 0.6, 0.01, (v) => (v ? v.toFixed(2) + " /s" : "off")],
    ["hueDrift", "Hue drift", "range", 0, 0.2, 0.005, (v) => (v ? v.toFixed(3) : "off")],
  ]],
  ["Motion", [
    ["sensitivity", "Sensitivity", "range", 0.3, 3, 0.05, (v) => v.toFixed(2) + "×"],
    ["floorDb", "Noise floor", "range", -110, -40, 1, (v) => v + " dB"],
    ["attack", "Rise speed", "range", 0.05, 1, 0.01, pct],
    ["decay", "Fall speed", "range", 0.02, 0.6, 0.01, pct],
    ["beatPulse", "Beat pulse", "range", 0, 1.5, 0.05, pct],
    ["shake", "Beat shake", "range", 0, 1, 0.05, pct],
    ["barShake", "Bar shake", "range", 0, 1, 0.05, (v) => (v ? pct(v) : "off"), null, "Each band trembles with its own loudness."],
    ["glow", "Glow", "range", 0, 1.5, 0.05, pct],
    ["trails", "Trails", "range", 0, 0.95, 0.01, pct],
    ["particles", "Beat particles", "toggle"],
  ]],
  ["Scene", [
    ["mode", "Show", "seg", ["wallpaper", "window", "ontop"]],
    ["background", "Background", "seg", ["blend", "cover", "gradient", "black"]],
    ["bgDim", "Background strength", "range", 0, 0.95, 0.01, pct, null, "Blend: how much the live colour covers the album art (lower lets the album shine through)."],
    ["coverCenter", "Spinning record", "toggle"],
    ["spin", "Record speed", "range", 0, 0.6, 0.01, (v) => (v ? v.toFixed(2) + " /s" : "still"), (s) => s.coverCenter],
    ["lyrics", "Lyrics", "toggle"],
    ["lyricsPos", "Lyrics position", "seg", ["bottom-left", "record"], (s) => s.lyrics],
    ["lyricsBounce", "Lyrics breathing", "range", 0, 2, 0.05, pct, (s) => s.lyrics],
    ["lyricsOffset", "Lyrics timing", "range", -2, 2, 0.1, (v) => (v > 0 ? "+" : "") + v.toFixed(1) + " s", (s) => s.lyrics, "If the words run late, move right; early, move left."],
    ["card", "Now playing card", "seg", ["bottom-left", "bottom-center", "top-left", "hidden"]],
    ["clock", "Clock", "toggle"],
    ["clock24", "24-hour clock", "toggle", (s) => s.clock],
    ["keyGuide", "Key guide (top right)", "toggle"],
    ["renderScale", "Render quality", "range", 0.35, 1, 0.05, pct, null, "Lower = lighter on the Mac. 50% is a 1080p canvas; glow hides the difference on 4K."],
    ["fps", "Frame rate cap", "seg", [30, 60]],
    ["closeWithSpotify", "Close with Spotify", "toggle"],
    ["startup", "Open at login", "toggle"],
  ]],
];
const PRESETS = {
  "Nebula ring": { shape: "circle", style: "bars", bands: 96, symmetric: true, theme: "nebula", glow: 0.8, trails: 0.5, rotate: 0.04, coverCenter: true, size: 0.22, length: 0.3 },
  "Liquid aurora": { shape: "circle", style: "curve", layers: 4, fill: true, bands: 64, theme: "album", glow: 1, trails: 0.75, hueDrift: 0.03, rotate: 0.02, size: 0.24 },
  "Neon skyline": { shape: "line", style: "bars", bands: 140, symmetric: true, mirror: true, theme: "neon", glow: 0.9, trails: 0.35, length: 0.32, thickness: 0.55, coverCenter: false },
  "Heartbeat": { shape: "heart", style: "dots", bands: 120, symmetric: true, theme: "sunset", glow: 1, trails: 0.7, size: 0.2, length: 0.18, beatPulse: 1.1 },
  "Hex blocks": { shape: "polygon", sides: 6, style: "blocks", bands: 36, symmetric: true, theme: "fire", glow: 0.7, trails: 0.2, rotate: -0.03, size: 0.2, length: 0.3, thickness: 0.8 },
  "Infinity wave": { shape: "infinity", style: "curve", layers: 3, bands: 90, theme: "ocean", glow: 0.9, trails: 0.8, size: 0.3, length: 0.12, rotate: 0 },
  "Galaxy spiral": { shape: "spiral", style: "dots", bands: 200, symmetric: false, theme: "ice", glow: 1.1, trails: 0.85, rotate: 0.06, size: 0.4, length: 0.1, particles: true },
};

// ---------- profiles: save the current look under a name, search yours + the presets, click to load ----------
let profiles = {};
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 1800); }
function renderProfiles() {
  const q = $("psearch").value.trim().toLowerCase(), list = $("plist");
  const mine = Object.entries(profiles).sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0)).map(([n]) => [n, true]);
  const items = [...mine, ...Object.keys(PRESETS).map((n) => [n, false])].filter(([n]) => n.toLowerCase().includes(q));
  list.textContent = "";
  if (!items.length) { list.innerHTML = `<div class="empty">No profile matches “${q.replace(/</g, "&lt;")}”.</div>`; return; }
  for (const [name, isMine] of items) {
    const b = document.createElement("button"); b.className = "chip" + (isMine ? " mine" : "");
    b.append(name);
    if (isMine) {
      const x = document.createElement("span"); x.className = "x"; x.textContent = "×"; x.title = `Delete ${name}`; x.setAttribute("aria-label", `Delete ${name}`);
      x.tabIndex = 0; x.setAttribute("role", "button");
      x.onclick = async (e) => { e.stopPropagation(); profiles = await window.bw.deleteProfile(name); renderProfiles(); toast(`Deleted “${name}”`); };
      x.onkeydown = (e) => { if (e.key === "Enter" || e.key === " " || e.key === "Delete") { e.preventDefault(); e.stopPropagation(); x.click(); } };
      b.append(x);
    } else { const s = document.createElement("small"); s.textContent = "preset"; b.append(s); }
    b.onclick = () => { isMine ? window.bw.loadProfile(name) : window.bw.set(PRESETS[name]); toast(`Loaded “${name}”`); };
    list.append(b);
  }
}
async function saveProfile() {
  const name = $("pname").value.trim().slice(0, 40);
  if (!name) { $("pname").focus(); return; }
  const existed = name in profiles;
  profiles = await window.bw.saveProfile(name);
  $("pname").value = ""; $("psearch").value = ""; renderProfiles();
  toast(existed ? `Updated “${name}”` : `Saved “${name}”`);
}

const rows = [];
function build() {
  const main = $("main");
  const pro = document.createElement("div"); pro.className = "profiles";
  pro.innerHTML = `<div class="pbar">
      <input id="pname" type="text" maxlength="40" placeholder="Name this look, e.g. Late night purple" aria-label="Profile name" spellcheck="false">
      <button class="primary" id="psave">Save profile</button>
      <input id="psearch" type="search" placeholder="Search profiles and presets" aria-label="Search profiles">
    </div><div class="chips" id="plist"></div>`;
  main.append(pro);
  $("psave").onclick = saveProfile;
  $("pname").onkeydown = (e) => { if (e.key === "Enter") saveProfile(); };
  $("psearch").oninput = renderProfiles;
  window.bw.profiles().then((p) => { profiles = p; renderProfiles(); });
  for (const [title, items] of SCHEMA) {
    const sec = document.createElement("section");
    sec.innerHTML = `<h2>${title}</h2>`;
    for (const [key, label, kind, ...a] of items) {
      const row = document.createElement("div"); row.className = "row";
      const id = "f_" + key;
      row.innerHTML = `<label for="${id}">${label}</label>`;
      let input, show = null, fmt = null, hint = null;
      if (kind === "seg") {
        input = document.createElement("div"); input.className = "seg"; input.id = id;
        for (const o of a[0]) {
          const b = document.createElement("button"); b.textContent = String(o).replace("-", " "); b.dataset.v = o;
          b.onclick = () => window.bw.set({ [key]: o });
          input.append(b);
        }
        row.classList.add("wide");
      } else if (kind === "range") {
        const [min, max, step] = a; fmt = a[3]; show = a[4]; hint = a[5];
        input = Object.assign(document.createElement("input"), { type: "range", id, min, max, step });
        input.oninput = () => { window.bw.set({ [key]: +input.value }); };
      } else if (kind === "toggle") {
        show = a[0];
        input = document.createElement("span"); input.className = "switch";
        input.innerHTML = `<input type="checkbox" id="${id}"><i></i>`;
        input.firstChild.onchange = (e) => window.bw.set({ [key]: e.target.checked });
        row.classList.add("wide");
      } else if (kind === "color") {
        show = a[0];
        input = Object.assign(document.createElement("input"), { type: "color", id });
        input.oninput = () => window.bw.set({ [key]: input.value });
        row.classList.add("wide");
      } else if (kind === "number") {
        const [min, max] = a; show = a[2];
        input = Object.assign(document.createElement("input"), { type: "number", id, min, max });
        input.onchange = () => window.bw.set({ [key]: Math.min(max, Math.max(min, +input.value || min)) });
        row.classList.add("wide");
      } else {
        show = a[0]; hint = a[1];
        input = Object.assign(document.createElement("input"), { type: "text", id, spellcheck: false });
        input.onchange = () => window.bw.set({ [key]: input.value });
        row.classList.add("wide");
      }
      row.append(input);
      const val = document.createElement("span"); val.className = "val";
      if (kind === "range") row.append(val);
      sec.append(row);
      let h = null;
      if (hint) { h = document.createElement("div"); h.className = "hint"; h.textContent = hint; sec.append(h); }
      rows.push({ key, kind, input, val, fmt, show, row, h });
    }
    main.append(sec);
  }
  const f = document.createElement("footer");
  f.innerHTML = "Shortcuts: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> full screen · <kbd>Esc</kbd> full screen to window · <kbd>`</kbd> settings on top · <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Space</kbd> play / pause · <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>←</kbd> <kbd>→</kbd> skip. Bandwave lives in the tray; closing this window keeps the visualizer running.";
  main.append(f);
}
function render() {
  for (const r of rows) {
    const v = S[r.key];
    if (r.kind === "seg") for (const b of r.input.children) b.classList.toggle("on", b.dataset.v === String(v));
    else if (r.kind === "toggle") r.input.firstChild.checked = !!v;
    else if (document.activeElement !== r.input) r.input.value = v;
    if (r.kind === "range") r.val.textContent = r.fmt ? r.fmt(+v) : v;
    const hide = r.show ? !r.show(S) : false;
    r.row.classList.toggle("hidden", hide);
    if (r.h) r.h.classList.toggle("hidden", hide);
  }
}
build();
window.bw.onSettings((s) => { S = s; render(); });
window.bw.onMedia((m) => {
  $("ntxt").innerHTML = m.title ? `<b></b> · <span></span>` : "Nothing playing";
  if (m.title) { $("ntxt").querySelector("b").textContent = m.title; $("ntxt").querySelector("span").textContent = m.artist || ""; }
  if (m.cover) { $("ncov").src = m.cover; $("ncov").hidden = false; }
});
$("fs").onclick = () => window.bw.fullscreen(true);
addEventListener("keydown", (e) => { if (e.key === "`" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); window.bw.toggleSettings(); } });
$("reset").onclick = () => window.bw.reset();
