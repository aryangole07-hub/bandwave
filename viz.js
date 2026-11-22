// Bandwave visualizer: system audio -> FFT -> bands -> drawn around a shape, with beat pulse, glow, trails, particles.
const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const cv = $("viz"), ctx = cv.getContext("2d");
const gl = $("glow"), gctx = gl.getContext("2d");
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

let S = null, media = {}, fullscreen = false;
let W = 0, H = 0, scale = 1;            // canvas pixels, canvas px per CSS px
let analyser = null, freq = null, sr = 48000;
let bands = [], raw = new Float32Array(0), levels = new Float32Array(0), hist = [];
let pts = [], closed = true, cx = 0, cy = 0, R = 1, gap = 4;
let rot = 0, hue = 0, pulse = 0, bassAvg = 0.1, lastBeat = 0, particles = [], last = performance.now();
let spec = null;  // latest dB per band from the helper
// drums + tempo: onsets from spectral flux (kick < 150 Hz, snare/hats 1.5-8 kHz); BPM from the spacing of kicks
let prevRaw = new Float32Array(0), fluxAvg = 0, fluxVar = 0.001, lastOnset = 0, kicks = [], beatMs = 500, lyricPulse = 0;
let lutHue = null, lutRGB = [], tint = [0, 0, 0], lut = [], flowPh = 0, energy = 0, spinAng = 0, spinVel = 0, recGlow = '';
let lyrFont = "";
let pos = { pos: 0, at: 0, playing: false }, lyr = { key: null, lines: [] }, lyrIdx = -2, lyrLit = -1, lyrEls = [];
const DEMO = new URLSearchParams(location.search).has("demo");                           // 256 palette colours

// ---------- palette ----------
const THEMES = {
  nebula: ["#7c5cff", "#ff4fd8", "#3de1ff"], sunset: ["#ff5f6d", "#ffc371", "#ff2e93"], ocean: ["#00c6ff", "#2f6bff", "#00ffa3"],
  neon: ["#39ff14", "#00e5ff", "#ff00e5"], fire: ["#ff3d00", "#ffb300", "#ff006a"], ice: ["#e6fbff", "#7fdbff", "#6c7bff"],
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function hsl2rgb(h, s, l) {
  const k = (n) => (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
}
function rgb2hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
let coverStops = null;
function coverPalette(img) {
  const c = document.createElement("canvas"); c.width = c.height = 32;
  const x = c.getContext("2d"), cut = /spotify/i.test(media.app || "") ? 0.74 : 1;  // Spotify stamps its logo on the bottom of the art
  x.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight * cut, 0, 0, 32, 32);
  const d = x.getImageData(0, 0, 32, 32).data, bucket = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < d.length; i += 4) {
    const [h, s, l] = rgb2hsl([d[i], d[i + 1], d[i + 2]]);
    if (l < 0.12 || l > 0.95) continue;
    const w = s * s + 0.02, k = Math.floor(h * 12) % 12;
    Object.assign(bucket[k], { w: bucket[k].w + w, r: bucket[k].r + d[i] * w, g: bucket[k].g + d[i + 1] * w, b: bucket[k].b + d[i + 2] * w });
  }
  let sat = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { const [, s, l] = rgb2hsl([d[i], d[i + 1], d[i + 2]]); if (l > 0.08 && l < 0.97) { sat += s; n++; } }
  if (!n || sat / n < 0.12) { coverStops = [[235, 238, 245], [150, 158, 175], [255, 255, 255]]; return; }  // black & white art: silver
  const top = bucket.filter((b) => b.w > 0).sort((a, b) => b.w - a.w).slice(0, 3)
    .map((b) => { const [h, s] = rgb2hsl([b.r / b.w, b.g / b.w, b.b / b.w]); return hsl2rgb(h, Math.min(1, Math.max(s, 0.55) * 1.15), 0.6); });
  while (top.length && top.length < 3) { const [h] = rgb2hsl(top[0]); top.push(hsl2rgb((h + 0.12 * top.length) % 1, 0.8, 0.62)); }
  coverStops = top.length ? top : null;
}
function buildLut() {
  let stops;
  if ((S.theme === "album" || S.theme === "cover") && coverStops) stops = coverStops;
  else if (S.theme === "custom") { const [h, s] = rgb2hsl(hex(S.custom)); stops = [-0.09, 0, 0.09].map((o) => hsl2rgb((h + o + 1) % 1, Math.max(s, 0.7), 0.62)); }
  else stops = (THEMES[S.theme] || THEMES.nebula).map(hex);
  lutHue = hue;
  if (S.hueDrift) stops = stops.map((c) => { const [h, s, l] = rgb2hsl(c); return hsl2rgb((h + hue / 360) % 1, s, l); });
  lut = [];
  const cyc = [...stops, stops[0]];  // a -> b -> c -> a: no seam when the colours travel round
  for (let i = 0; i < 256; i++) {
    const x = (i / 256) * 3, j = Math.floor(x), f = x - j, a = cyc[j], b = cyc[j + 1];
    const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
    lutRGB[i] = c;
    lut.push(`rgb(${c.join(",")})`);
  }
  recGlow = lut[0].replace("rgb", "rgba").replace(")", ",.38)");
  $("track").style.setProperty("--litGlow", recGlow.replace(",.38)", ",.95)"));
  if (S.background === "gradient") {
    const c = stops.map((s) => `rgb(${s.map((v) => Math.round(v * 0.35)).join(",")})`);
    $("bg").style.backgroundImage = `radial-gradient(circle at 30% 30%, ${c[0]}, transparent 60%), radial-gradient(circle at 75% 70%, ${c[2]}, transparent 55%), radial-gradient(circle, ${c[1]}, #05050a 80%)`;
  }
}
// Colour travels along the shape (flowPh) with a slow ripple on top, so the gradient swirls rather than slides.
const slot = (x) => (Math.floor((x - Math.floor(x)) * 256)) & 255;
const wrap = (x) => lut[slot(x)];
const colour = (k, n, v) => wrap((S.colorBy === "level" ? v : k / n) + flowPh + 0.07 * Math.sin((k / n) * TAU * 3 + flowPh * TAU * 2));

// ---------- bands ----------
const SCALES = {
  log: [Math.log, Math.exp], linear: [(x) => x, (x) => x],
  mel: [(f) => 2595 * Math.log10(1 + f / 700), (m) => 700 * (10 ** (m / 2595) - 1)],
};
function buildBands() {
  let e;
  if (S.spacing === "custom") {
    e = [...new Set(String(S.customEdges).split(/[\s,;]+/).map(Number).filter((x) => x > 0 && x < sr / 2))].sort((a, b) => a - b);
  } else {
    const [f, g] = SCALES[S.spacing] || SCALES.log, lo = clamp(+S.minHz, 10, sr / 2 - 100), hi = clamp(+S.maxHz, lo + 50, sr / 2);
    const n = clamp(S.bands | 0, 2, 512), a = f(lo), b = f(hi);
    e = Array.from({ length: n + 1 }, (_, i) => g(a + ((b - a) * i) / n));
  }
  if (e.length < 3) e = [60, 250, 1000, 4000];
  window.bw.setBands(e);  // the helper captures the system audio and reduces its FFT to these bands
  spec = null;
  const hz = sr / 16384;
  bands = e.slice(0, -1).map((lo, i) => ({ lo: lo / hz, hi: e[i + 1] / hz, fc: Math.sqrt(lo * e[i + 1]) }));
  raw = new Float32Array(bands.length); levels = new Float32Array(bands.length); hist = [];
}
function bandDb(b) {
  if (b.hi - b.lo < 1) {  // narrower than one FFT bin (low end with many bands): interpolate
    const x = (b.lo + b.hi) / 2, i = Math.floor(x), f = x - i;
    return freq[i] * (1 - f) + freq[i + 1] * f;
  }
  let m = -200;
  for (let i = Math.ceil(b.lo), e = Math.min(Math.floor(b.hi), freq.length - 1); i <= e; i++) if (freq[i] > m) m = freq[i];
  return m;
}
function analyse(dt) {
  const n = bands.length;
  if (spec && spec.length === n && !DEMO) {
    const top = -14, floor = +S.floorDb;
    for (let i = 0; i < n; i++) {
      const db = spec[i] + clamp(S.tilt * 3 * Math.log2(bands[i].fc / 1000), -18, 18);
      raw[i] = clamp(Math.pow(clamp((db - floor) / (top - floor), 0, 1), 1.35) * S.sensitivity, 0, 1);
    }
  } else if (DEMO) {  // test hook (?demo=1): a fake beat and spectrum, so visuals can be checked silently
    const t = performance.now() / 1000, kick = Math.exp(-((t * 2) % 1) * 6);
    for (let i = 0; i < n; i++) raw[i] = clamp(0.25 + 0.35 * Math.sin(i * 0.37 + t * 3) ** 2 + (bands[i].fc < 160 ? kick * 0.7 : 0.15 * Math.random()), 0, 1);
  } else raw.fill(0);
  const ka = 1 - Math.pow(1 - S.attack, dt * 60), kd = 1 - Math.pow(1 - S.decay, dt * 60);
  for (let i = 0; i < n; i++) levels[i] += (raw[i] - levels[i]) * (raw[i] > levels[i] ? ka : kd);

  // beat: bass energy jumping well above its running average
  let bass = 0, c = 0;
  for (let i = 0; i < n; i++) if (bands[i].fc < 160) { bass += raw[i]; c++; }
  bass = c ? bass / c : raw[0] || 0;
  const now = performance.now();
  if (bass > bassAvg * 1.3 + 0.04 && bass > 0.3 && now - lastBeat > 170) { lastBeat = now; pulse = 1; burst(); }
  bassAvg += (bass - bassAvg) * Math.min(1, dt * 2.5);
  drums(now, dt);
  let all = 0; for (let i = 0; i < n; i++) all += levels[i];
  energy += ((n ? all / n : 0) * 1.6 - energy) * Math.min(1, dt * 4);
  pulse *= Math.pow(0.02, dt);
}

function drums(now, dt) {
  const n = raw.length;
  if (prevRaw.length !== n) prevRaw = new Float32Array(n);
  let fk = 0, ck = 0, fs = 0, cs = 0;
  for (let i = 0; i < n; i++) {
    const d = raw[i] - prevRaw[i], fc = bands[i].fc;
    if (fc < 150) { ck++; if (d > 0) fk += d; } else if (fc > 1500 && fc < 8000) { cs++; if (d > 0) fs += d; }
  }
  prevRaw.set(raw);
  fk = ck ? fk / ck : 0; fs = cs ? fs / cs : 0;
  const flux = fk + 0.7 * fs, sd = Math.sqrt(fluxVar), k = Math.min(1, dt * 1.6);
  if (flux > fluxAvg + 1.4 * sd + 0.012 && now - lastOnset > 95) {
    lastOnset = now;
    lyricPulse = Math.max(lyricPulse, clamp((flux - fluxAvg) / (3 * sd + 0.02), 0.3, 1));  // every drum hit, sized by how hard it hits
    if (fk >= fs * 0.7) {  // a kick: feeds the tempo estimate
      kicks.push(now); if (kicks.length > 24) kicks.shift();
      const iv = [];
      for (let j = 1; j < kicks.length; j++) {
        let d = kicks[j] - kicks[j - 1];
        if (d < 200 || d > 2000) continue;
        while (d < 333) d *= 2;  // fold into 70-180 BPM
        while (d > 857) d /= 2;
        iv.push(d);
      }
      if (iv.length >= 4) { iv.sort((a, b) => a - b); beatMs += (iv[iv.length >> 1] - beatMs) * 0.25; }
    }
  }
  fluxAvg += (flux - fluxAvg) * k; fluxVar += ((flux - fluxAvg) ** 2 - fluxVar) * k;
  lyricPulse *= Math.exp(-dt / Math.max(0.06, (beatMs / 1000) * 0.3));  // falls back well before the next beat
}
const bpm = () => Math.round(60000 / beatMs);
function histAt(ms) {  // the values as they were ms ago (echo layers lag by a fraction of the beat)
  const now = performance.now();
  for (const h of hist) if (now - h.t >= ms) return h.v;
  return hist.length ? hist[hist.length - 1].v : null;
}

// ---------- shape ----------
function polyAt(v, t) { const n = v.length, x = t * n, i = Math.floor(x) % n, f = x - Math.floor(x), a = v[i], b = v[(i + 1) % n]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; }
const ring = (n, r = (k) => 1) => Array.from({ length: n }, (_, k) => { const a = (TAU * k) / n - Math.PI / 2; return [Math.cos(a) * r(k), Math.sin(a) * r(k)]; });
const SHAPES = {
  circle: { closed: true, f: (t) => [Math.cos(TAU * t - Math.PI / 2), Math.sin(TAU * t - Math.PI / 2)] },
  polygon: { closed: true, f: (t) => polyAt(ring(clamp(S.sides | 0, 3, 16)), t) },
  star: { closed: true, f: (t) => polyAt(ring(2 * clamp(S.sides | 0, 3, 16), (k) => (k % 2 ? 0.5 : 1)), t) },
  heart: { closed: true, ref: [0, 0.1], f: (t) => { const a = TAU * t; return [16 * Math.sin(a) ** 3 / 16, -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) / 16 + 0.1]; } },
  infinity: { closed: true, ref: (x) => [Math.sign(x) * 0.75, 0], f: (t) => { const a = TAU * t, d = 1 + Math.sin(a) ** 2; return [1.45 * Math.cos(a) / d, 1.45 * Math.sin(a) * Math.cos(a) / d]; } },
  spiral: { closed: false, ref: [0, 0], f: (t) => { const a = TAU * 2.2 * t - Math.PI / 2, r = 0.18 + 0.82 * t; return [r * Math.cos(a), r * Math.sin(a)]; } },
  line: { closed: false, up: true, f: (t) => [2 * t - 1, 0] },
  wave: { closed: false, up: true, f: (t) => [2 * t - 1, 0.32 * Math.sin(TAU * 1.5 * t)] },
};
function layout() {
  if (!S || !bands.length) return;
  const sh = SHAPES[S.shape] || SHAPES.circle, m = Math.min(W, H);
  closed = sh.closed;
  const open = sh.up;  // line / wave span the screen width
  cx = W / 2 + S.offsetX * W; cy = (open ? H * (S.mirror ? 0.5 : 0.8) : H / 2) + S.offsetY * H;
  R = S.size * m;
  const sx = open ? W * 0.44 : R, sy = open ? H * 0.44 * (S.size / 0.24) : R;
  const M = 1600, P = [];
  for (let i = 0; i <= M; i++) { const [x, y] = sh.f(closed ? (i % M) / M : i / M); P.push([cx + x * sx, cy + y * sy, x, y]); }
  const L = [0];
  for (let i = 1; i <= M; i++) L.push(L[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const N = bands.length * (S.symmetric ? 2 : 1), total = L[M];
  gap = total / (closed ? N : N - 1);
  pts = []; hist = [];  // point count may have changed: old echo layers no longer line up
  for (let k = 0, j = 0; k < N; k++) {
    const s = closed ? ((k + 0.5) / N) * total : (k / (N - 1)) * total;
    while (j < M - 1 && L[j + 1] < s) j++;
    const f = (s - L[j]) / (L[j + 1] - L[j] || 1), a = P[j], b = P[j + 1];
    const x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    let nx = ty, ny = -tx;
    if (sh.up) { if (ny > 0) { nx = -nx; ny = -ny; } }
    else {
      const ux = a[2] + (b[2] - a[2]) * f, uy = a[3] + (b[3] - a[3]) * f;
      const r = typeof sh.ref === "function" ? sh.ref(ux) : sh.ref || [0, 0];
      if (nx * (ux - r[0]) + ny * (uy - r[1]) < 0) { nx = -nx; ny = -ny; }  // point outward
    }
    pts.push([x, y, nx, ny]);
  }
}
function values() {
  const n = levels.length;
  if (!S.symmetric) return levels;
  const v = new Float32Array(2 * n);
  for (let k = 0; k < 2 * n; k++) v[k] = closed ? (k < n ? levels[k] : levels[2 * n - 1 - k]) : levels[Math.abs(n - 1 - k + (k >= n ? 1 : 0))];
  return v;
}

// ---------- drawing ----------
function smooth(c, P, isClosed) {
  const n = P.length;
  c.moveTo(P[0][0], P[0][1]);
  const at = (i) => P[isClosed ? (i + n) % n : clamp(i, 0, n - 1)];
  for (let i = 0; i < (isClosed ? n : n - 1); i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    c.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
  }
  if (isClosed) c.closePath();
}
let gradCache = null;
function strokeGradient() {
  return gradCache || (gradCache = makeGradient());
}
function makeGradient() {
  if (closed && ctx.createConicGradient) {
    const g = ctx.createConicGradient(-Math.PI / 2, cx, cy);
    for (let i = 0; i <= 12; i++) g.addColorStop(i / 12, wrap(i / 12 + flowPh));
    return g;
  }
  const g = ctx.createLinearGradient(pts[0][0], 0, pts[pts.length - 1][0] || W, 0);
  for (let i = 0; i <= 8; i++) g.addColorStop(i / 8, wrap(i / 8 + flowPh));
  return g;
}
function draw(v) {
  const N = pts.length, maxLen = S.length * Math.min(W, H), lw = Math.max(1, gap * S.thickness);
  const len = (x) => 2 * scale + x * maxLen;
  ctx.lineCap = S.rounded ? "round" : "butt";
  if (S.style === "curve") {
    const layers = clamp(S.layers | 0, 1, 6);
    for (let L = layers - 1; L >= 0; L--) {
      const src = L === 0 ? v : histAt(L * beatMs * (S.echoBeat || 0.25)) || v, grow = 1 + L * 0.12;
      const tips = pts.map((p, k) => [p[0] + p[2] * len(src[k]) * grow, p[1] + p[3] * len(src[k]) * grow]);
      ctx.globalAlpha = L === 0 ? 1 : 0.45 / L;
      ctx.beginPath(); smooth(ctx, tips, closed);
      if (S.fill) {
        if (S.mirror) { const inner = pts.map((p, k) => [p[0] - p[2] * len(src[k]) * 0.5, p[1] - p[3] * len(src[k]) * 0.5]).reverse(); if (closed) { ctx.moveTo(inner[0][0], inner[0][1]); smooth(ctx, inner, true); } else { ctx.lineTo(inner[0][0], inner[0][1]); for (const p of inner) ctx.lineTo(p[0], p[1]); } }
        else if (closed) { const base = [...pts].reverse(); ctx.moveTo(base[0][0], base[0][1]); for (const p of base) ctx.lineTo(p[0], p[1]); ctx.closePath(); }
        else { for (let k = N - 1; k >= 0; k--) ctx.lineTo(pts[k][0], pts[k][1]); ctx.closePath(); }
        ctx.save(); ctx.globalAlpha *= 0.28; ctx.fillStyle = strokeGradient(); ctx.fill("evenodd"); ctx.restore();
      }
      ctx.beginPath(); smooth(ctx, tips, closed);
      ctx.lineWidth = Math.max(1.5 * scale, lw * 0.55); ctx.strokeStyle = strokeGradient(); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    return;
  }
  const layers = clamp(S.layers | 0, 1, 6);
  for (let L = layers - 1; L >= 1; L--) {
    const src = histAt(L * beatMs * (S.echoBeat || 0.25));
    if (!src || src.length !== N) break;
    ctx.globalAlpha = 0.5 / L; ctx.lineWidth = lw; ctx.lineCap = "butt";
    for (let k = 0; k < N; k++) {
      const [x, y, nx, ny] = pts[k], h = len(src[k]) * (1 + L * 0.06), cap = Math.max(2 * scale, lw * 0.5);
      ctx.strokeStyle = colour(k, N, src[k]);
      ctx.beginPath(); ctx.moveTo(x + nx * h, y + ny * h); ctx.lineTo(x + nx * (h + cap), y + ny * (h + cap)); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1; ctx.lineCap = S.rounded ? "round" : "butt";
  const jit = (S.barShake || 0) * gap * 2.2;  // bar shake: each band jitters with its own level (owner 2026-11-22)
  for (let k = 0; k < N; k++) {
    let [x, y, nx, ny] = pts[k];
    const h = len(v[k]) * (1 + (jit ? (Math.random() - 0.5) * 0.25 * S.barShake * v[k] : 0)), back = S.mirror ? h * 0.55 : 0;
    if (jit) { const j = (Math.random() - 0.5) * jit * (0.3 + v[k] * 1.4) * (0.5 + energy); x -= ny * j; y += nx * j; }
    if (S.style === "bars") {
      ctx.strokeStyle = colour(k, N, v[k]); ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(x - nx * back, y - ny * back); ctx.lineTo(x + nx * h, y + ny * h); ctx.stroke();
    } else if (S.style === "dots") {
      ctx.fillStyle = colour(k, N, v[k]);
      const r = Math.max(1.2 * scale, lw * (0.35 + 0.4 * v[k]));
      ctx.beginPath(); ctx.arc(x + nx * h, y + ny * h, r, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.45; ctx.beginPath(); ctx.arc(x + nx * h * 0.5, y + ny * h * 0.5, r * 0.6, 0, TAU); ctx.fill();
      if (S.mirror) { ctx.beginPath(); ctx.arc(x - nx * back, y - ny * back, r * 0.8, 0, TAU); ctx.fill(); }
      ctx.globalAlpha = 1;
    } else {  // blocks: LED segments, coloured by height
      const seg = Math.max(3 * scale, lw * 0.8), step = seg * 1.55, segs = Math.floor(h / step), all = Math.max(1, Math.floor(maxLen / step));
      ctx.lineWidth = lw; ctx.lineCap = "butt";
      for (let j = 0; j <= segs; j++) {
        ctx.strokeStyle = wrap((j / all) * 0.6 + flowPh + k / N);
        const a = j * step, b = a + seg;
        ctx.beginPath(); ctx.moveTo(x + nx * a, y + ny * a); ctx.lineTo(x + nx * b, y + ny * b); ctx.stroke();
        if (S.mirror && a < back) { ctx.beginPath(); ctx.moveTo(x - nx * a, y - ny * a); ctx.lineTo(x - nx * b, y - ny * b); ctx.stroke(); }
      }
    }
  }
}
function burst() {
  if (!S.particles || !pts.length) return;
  const v = values(), sp = Math.min(W, H) / 1080;
  for (let i = 0; i < 26 && particles.length < 700; i++) {
    const k = Math.floor(Math.random() * pts.length), [x, y, nx, ny] = pts[k], h = 2 * scale + v[k] * S.length * Math.min(W, H);
    const s = (160 + Math.random() * 420) * sp, j = (Math.random() - 0.5) * 0.6;
    particles.push({ x: x + nx * h, y: y + ny * h, vx: (nx + j * ny) * s, vy: (ny - j * nx) * s, life: 0.6 + Math.random() * 0.9, age: 0, r: (1.2 + Math.random() * 2.8) * sp * 1.6, c: colour(k, pts.length, 1) });
  }
}
function drawParticles(dt) {
  ctx.globalCompositeOperation = "lighter";
  particles = particles.filter((p) => (p.age += dt) < p.life);
  for (const p of particles) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.985; p.vy *= 0.985;
    ctx.globalAlpha = (1 - p.age / p.life) ** 1.5; ctx.fillStyle = p.c;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!S || !pts.length) return;
  if (now - last < 1000 / (S.fps || 60) - 2) return;  // 120/144 Hz screens: don't draw more than the cap
  const dt = clamp((now - last) / 1000, 0, 0.1); last = now;
  analyse(dt);
  const v = values();
  hist.unshift({ t: now, v: Float32Array.from(v) });
  while (hist.length > 2 && now - hist[hist.length - 1].t > 1800) hist.pop();
  gradCache = null;
  rot += S.rotate * TAU * dt * (closed || S.shape === "spiral" ? 1 : 0);
  hue = (hue + S.hueDrift * 360 * dt) % 360;
  flowPh = (flowPh + S.flow * dt * (1 + energy * 2.2 + pulse * 1.5)) % 1;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (S.trails > 0) { ctx.globalCompositeOperation = "destination-out"; ctx.fillStyle = `rgba(0,0,0,${1 - S.trails * 0.9})`; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = "source-over"; }
  else ctx.clearRect(0, 0, W, H);
  const z = 1 + pulse * S.beatPulse * 0.13, sh = pulse * S.shake * 14 * scale;
  ctx.translate(cx + (Math.random() - 0.5) * sh, cy + (Math.random() - 0.5) * sh);
  ctx.scale(z, z); ctx.rotate(rot); ctx.translate(-cx, -cy);
  draw(v);
  drawParticles(dt);

  gctx.clearRect(0, 0, gl.width, gl.height);
  if (S.glow > 0) { gctx.filter = `blur(${3 + 7 * S.glow}px)`; gctx.drawImage(cv, 0, 0, gl.width, gl.height); }
  gl.style.opacity = S.glow * (0.75 + 0.5 * pulse);
  if (S.hueDrift && (lutHue === null || Math.abs(hue - lutHue) > 2)) buildLut();
  record(dt);
  blendBackground(v, dt);
  lyricsFrame();
}

// ---------- blend background ----------
function blendBackground(v, dt) {
  if (S.background !== "blend") return;
  const N = v.length;
  let r = 0, g = 0, b = 0, w = 0;
  for (let k = 0; k < N; k++) {
    const x = (S.colorBy === "level" ? v[k] : k / N) + flowPh + 0.07 * Math.sin((k / N) * TAU * 3 + flowPh * TAU * 2);
    const c = lutRGB[slot(x)], wt = v[k] * v[k] + 0.002;  // louder bands count more
    r += c[0] * wt; g += c[1] * wt; b += c[2] * wt; w += wt;
  }
  const k = Math.min(1, dt * 3), lvl = 0.3 + 0.3 * clamp(energy, 0, 1);  // dark enough to stay a background, breathes with the music
  tint = tint.map((t, i) => t + ([r, g, b][i] / w * lvl - t) * k);
  $("tint").style.backgroundColor = `rgba(${tint.map(Math.round).join(",")},${clamp(S.bgDim + 0.15, 0, 0.95)})`;
}

// ---------- record + lyrics ----------
function ringText() {
  const unit = `${media.title}${media.artist ? "  •  " + media.artist : ""}  •  `;
  return unit.repeat(Math.max(1, Math.round(64 / unit.length)));  // fill the groove; textLength spreads it evenly
}
function record(dt) {
  const el = $("rec");
  if (!el.classList.contains("on")) return;
  const open = !closed, d = (open ? Math.min(W, H) * 0.34 : R * 2 * 0.72) / scale;
  const x = (open ? W / 2 : cx) / scale, y = (open ? H * 0.4 : cy) / scale;
  const target = media.playing ? S.spin * (1 + energy * 0.6) : 0;  // vinyl-style spin up / wind down
  spinVel += (target - spinVel) * Math.min(1, dt * 1.6);
  spinAng = (spinAng + spinVel * 360 * dt) % 360;
  Object.assign(el.style, { width: d + "px", height: d + "px", left: x - d / 2 + "px", top: y - d / 2 + "px", transform: `scale(${1 + pulse * S.beatPulse * 0.05})` });
  el.style.setProperty("--recGlow", recGlow);
  $("spin").style.transform = `rotate(${spinAng}deg)`;
  if (S.lyricsPos === "record") $("track").style.setProperty("--fs", d * 0.062 + "px");
}
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
function buildLyrics() {
  const lines = lyr.lines || [], seen = {};
  for (const l of lines) if (l.text) seen[norm(l.text)] = (seen[norm(l.text)] || 0) + 1;
  const track = $("track");
  track.textContent = "";
  lyrEls = lines.map((l) => {
    const el = document.createElement("div"), t = l.text, words = t ? t.split(/\s+/) : ["•", "•", "•"];
    const letters = t.replace(/[^A-Za-z]/g, ""), caps = letters.length > 3 && letters === letters.toUpperCase();
    // the line's own character picks its type: chorus (repeated) caps, shouted italic, (backing vocals) serif, short big, long smaller
    el.className = "ln" + (!t ? " gap" : "") + (t && seen[norm(t)] > 1 ? " chorus" : "") + (/!/.test(t) || caps ? " loud" : "")
      + (/^\(.*\)$/.test(t) ? " soft" : "") + (t && words.length <= 3 ? " big" : "") + (words.length > 9 ? " long" : "");
    words.forEach((w, i) => { const sp = document.createElement("span"); sp.className = "w"; sp.style.setProperty("--i", i); sp.textContent = w + (i < words.length - 1 ? " " : ""); el.append(sp); });
    track.append(el);
    return el;
  });
  lyrIdx = -2; lyrLit = -1;
}
function songTime() { return pos.pos + (pos.playing ? (Date.now() - pos.at) / 1000 : 0) + (S.lyricsOffset || 0); }
function lyricsFrame() {
  const rec = $("rec"), lines = lyr.lines || [];
  const bl = S.lyricsPos !== "record";
  const show = S.lyrics && lines.length > 0 && (bl ? !!media.title : rec.classList.contains("on"));
  rec.classList.toggle("lyr", show && !bl);
  document.body.classList.toggle("lyr-on", show && bl);
  if (!show) return;
  const t = songTime();
  let i = -1;
  while (i + 1 < lines.length && lines[i + 1].t <= t) i++;
  if (i !== lyrIdx) {
    lyrIdx = i; lyrLit = -1;
    lyrEls.forEach((el, k) => { const d = Math.abs(k - i); el.classList.toggle("cur", d === 0); el.classList.toggle("d1", d === 1); el.classList.toggle("d2", d === 2); if (d) { el.style.transform = ""; el.style.fontVariationSettings = ""; } });
    lyrFont = "";
    const cur = lyrEls[Math.max(0, i)], box = $("lyr");
    if (cur) {
      $("track").style.transform = `translateY(${box.clientHeight / 2 - cur.offsetTop - cur.offsetHeight / 2}px)`;
      cur.querySelectorAll(".w").forEach((w) => { w.style.animation = "none"; void w.offsetWidth; w.style.animation = ""; });  // replay the word entrance
    }
  }
  const cur = lyrEls[i];
  if (cur && lines[i].text) {
    // light the words up through the line, weighted by length, so the highlight follows the singing
    const end = lines[i + 1] ? lines[i + 1].t : lines[i].t + 4, p = clamp((t - lines[i].t) / Math.max(0.3, (end - lines[i].t) * 0.85), 0, 1);
    const words = cur.children, total = lines[i].text.length;
    let acc = 0, lit = 0;
    for (const w of words) { acc += w.textContent.length; if (acc / total <= p + 0.02) lit++; }
    if (lit !== lyrLit) { lyrLit = lit; [...words].forEach((w, k) => w.classList.toggle("lit", k < lit)); }
  }
  if (!cur) return;
  // Only the current line is touched each frame (styling the whole song's lines every frame cost ~1 CPU core).
  // Drum hits kick its size; loud passages swell it; the variable font (heavier + narrower when loud) is
  // stepped so text is re-shaped a few times a second, not every frame.
  const e = clamp(energy, 0, 1), b = S.lyricsBounce ?? 1;
  cur.style.transform = `scale(${(1 + lyricPulse * 0.34 * b + (e - 0.35) * 0.16 * b).toFixed(3)})`;
  if (cur.classList.contains("soft")) return;
  const font = `"wght" ${Math.round((330 + 370 * e) / 40) * 40}, "wdth" ${Math.round((100 - 25 * e) / 5) * 5}`;
  if (font !== lyrFont) { lyrFont = font; cur.style.fontVariationSettings = font; }
}

// ---------- key guide (top right) ----------
function keyGuide() {
  // On the wallpaper Bandwave can't take key presses, so it lists the Ctrl+Alt shortcuts that work from anywhere.
  const wall = S.mode === "wallpaper" && !fullscreen;
  const rows = wall
    ? [["Ctrl Alt B", "Browse Spotify"], ["Ctrl Alt Space", "Play / pause"], ["Ctrl Alt ← →", "Previous / next"], ["Ctrl Alt F", "Full screen"]]
    : [["Tab", "Browse Spotify"], ["Space", "Play / pause"], ["← →", "Previous / next"], ["`", "Settings"], ["Esc", fullscreen ? "Exit full screen" : "—"], ["Ctrl Alt F", "Full screen"]];
  const el = $("keys");
  el.classList.toggle("off", !S.keyGuide);
  el.innerHTML = rows.filter((r) => r[1] !== "—").map(([k, t]) => `<kbd>${k}</kbd><span>${t}</span>`).join("");
}
function flashKeys() { const el = $("keys"); el.classList.add("flash"); clearTimeout(flashKeys.t); flashKeys.t = setTimeout(() => el.classList.remove("flash"), 900); }

// ---------- scene ----------
function resize() {
  scale = devicePixelRatio * (S ? S.renderScale : 0.75);
  W = cv.width = Math.round(innerWidth * scale); H = cv.height = Math.round(innerHeight * scale);
  gl.width = W >> 2; gl.height = H >> 2;
  layout();
}
function scene() {
  const bg = $("bg");
  bg.style.opacity = S.background === "black" ? 0 : 1;
  $("tint").style.opacity = S.background === "blend" ? 1 : 0;
  if (S.background === "cover" || S.background === "blend") bg.style.backgroundImage = media.cover ? `url("${media.cover}")` : "radial-gradient(circle, #1b1430, #05050a 75%)";
  bg.style.filter = S.background === "cover" ? `blur(80px) saturate(1.6) brightness(${1 - S.bgDim})`
    : S.background === "blend" ? "blur(80px) saturate(1.5) brightness(.8)" : `brightness(${1.2 - S.bgDim})`;
  $("rec").classList.toggle("on", !!S.coverCenter && !!media.title);
  $("ringText").textContent = media.title ? ringText() : "";
  $("card").className = `${S.card} ${S.card !== "hidden" && media.title ? "on" : ""}`;
  $("clock").classList.toggle("on", !!S.clock);
  document.body.classList.toggle("drag", !fullscreen && S.mode !== "wallpaper");
  keyGuide();
  // lyrics live in the record or in the bottom-left panel: move the one node between the two
  const lyrEl = $("lyr"), bl = S.lyricsPos !== "record";
  if (bl !== lyrEl.classList.contains("bl")) {
    lyrEl.classList.toggle("bl", bl);
    (bl ? document.body : $("rec")).append(lyrEl);
    if (bl) $("track").style.setProperty("--fs", "clamp(22px, 1.75vw, 44px)");
    lyrIdx = -2;  // recentre the current line in the new box
  }
  document.body.classList.toggle("nocard", S.card === "hidden" || S.card === "top-left");
  buildLut();
}
function tick() {
  const d = new Date();
  $("clockH").textContent = d.toLocaleTimeString(S && S.clock24 ? "en-GB" : "en-US", { hour: "numeric", minute: "2-digit", hour12: !(S && S.clock24) });
  $("clockD").textContent = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

window.bw.onSettings((s) => {
  const old = S; S = s;
  if (!old || old.renderScale !== s.renderScale) resize();
  const k = ["bands", "minHz", "maxHz", "spacing", "customEdges"];
  if (!old || k.some((x) => old[x] !== s[x])) buildBands();
  layout(); scene(); tick();
});
window.bw.onMedia((m) => {
  media = m;
  $("title").textContent = m.title || ""; $("artist").textContent = m.artist || "";
  $("ppIcon").setAttribute("d", m.playing ? "M6 5h4v14H6zM14 5h4v14h-4z" : "M7 5v14l12-7z");
  if (m.cover) {
    $("cover").src = $("label").src = m.cover;
    const img = new Image(); img.onload = () => { coverPalette(img); S && buildLut(); }; img.src = m.cover;
  }
  if (S) scene();
});
window.bw.onPos((p) => { pos = p; });
window.bw.onLyrics((l) => { lyr = { key: l.key, lines: l.lines || [] }; buildLyrics(); });
window.bw.onFullscreen((on) => { fullscreen = on; document.body.classList.toggle("fs", on); if (S) scene(); });
$("prev").onclick = () => window.bw.media("prev");
$("next").onclick = () => window.bw.media("next");
$("pp").onclick = () => window.bw.media("play_pause");
addEventListener("keydown", (e) => {
  flashKeys();
  if (e.key === "Tab") { e.preventDefault(); window.bw.toggleBrowse(); }
  else if (e.key === "Escape") window.bw.escape();
  else if (e.key === "`") window.bw.toggleSettings();
  else if (e.key === " ") window.bw.media("play_pause");
  else if (e.key === "ArrowRight") window.bw.media("next");
  else if (e.key === "ArrowLeft") window.bw.media("prev");
});
addEventListener("resize", resize);
let idle;
function wake() { document.body.classList.remove("nocursor"); clearTimeout(idle); idle = setTimeout(() => document.body.classList.add("nocursor"), 3000); }
addEventListener("mousemove", wake); addEventListener("mousedown", wake); wake();
setInterval(tick, 1000);

window.bw.onSpec((v) => { spec = v; });
async function startAudioUnused() {  // kept for reference: Chromium loopback needed a screen capture (cursor stalls)
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: 1, height: 1, frameRate: 1 }, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());  // only the sound is needed
    const ac = new AudioContext();
    analyser = ac.createAnalyser(); analyser.fftSize = 16384; analyser.smoothingTimeConstant = 0; analyser.minDecibels = -120; analyser.maxDecibels = 0;
    ac.createMediaStreamSource(stream).connect(analyser);
    freq = new Float32Array(analyser.frequencyBinCount); sr = ac.sampleRate;
    if (S) { buildBands(); layout(); }
  } catch (e) { console.error("audio", e); setTimeout(startAudio, 3000); }
}
requestAnimationFrame(frame);
