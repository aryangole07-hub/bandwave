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
let lut = [];
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
  const x = c.getContext("2d"); x.drawImage(img, 0, 0, 32, 32);
  const d = x.getImageData(0, 0, 32, 32).data, bucket = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < d.length; i += 4) {
    const [h, s, l] = rgb2hsl([d[i], d[i + 1], d[i + 2]]);
    if (l < 0.12 || l > 0.95) continue;
    const w = s * s + 0.02, k = Math.floor(h * 12) % 12;
    Object.assign(bucket[k], { w: bucket[k].w + w, r: bucket[k].r + d[i] * w, g: bucket[k].g + d[i + 1] * w, b: bucket[k].b + d[i + 2] * w });
  }
  const top = bucket.filter((b) => b.w > 0).sort((a, b) => b.w - a.w).slice(0, 3)
    .map((b) => { const [h, s] = rgb2hsl([b.r / b.w, b.g / b.w, b.b / b.w]); return hsl2rgb(h, Math.max(s, 0.7), 0.62); });
  while (top.length && top.length < 3) { const [h] = rgb2hsl(top[0]); top.push(hsl2rgb((h + 0.12 * top.length) % 1, 0.8, 0.62)); }
  coverStops = top.length ? top : null;
}
function buildLut() {
  let stops;
  if (S.theme === "cover" && coverStops) stops = coverStops;
  else if (S.theme === "custom") { const [h, s] = rgb2hsl(hex(S.custom)); stops = [-0.09, 0, 0.09].map((o) => hsl2rgb((h + o + 1) % 1, Math.max(s, 0.7), 0.62)); }
  else stops = (THEMES[S.theme] || THEMES.nebula).map(hex);
  lut = [];
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * 2, j = Math.min(1, Math.floor(x)), f = x - j, a = stops[j], b = stops[j + 1];
    lut.push(`rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`);
  }
  if (S.background === "gradient") {
    const c = stops.map((s) => `rgb(${s.map((v) => Math.round(v * 0.35)).join(",")})`);
    $("bg").style.backgroundImage = `radial-gradient(circle at 30% 30%, ${c[0]}, transparent 60%), radial-gradient(circle at 75% 70%, ${c[2]}, transparent 55%), radial-gradient(circle, ${c[1]}, #05050a 80%)`;
  }
}
const colour = (k, n, v) => lut[Math.round(255 * clamp(S.colorBy === "level" ? v : k / Math.max(1, n - 1), 0, 1))];

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
  const hz = sr / (analyser ? analyser.fftSize : 16384);
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
  if (analyser && !DEMO) {
    analyser.getFloatFrequencyData(freq);
    const top = -14, floor = +S.floorDb;
    for (let i = 0; i < n; i++) {
      const db = bandDb(bands[i]) + clamp(S.tilt * 3 * Math.log2(bands[i].fc / 1000), -18, 18);
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
  pulse *= Math.pow(0.02, dt);
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
function strokeGradient() {
  if (closed && ctx.createConicGradient) {
    const g = ctx.createConicGradient(-Math.PI / 2, cx, cy);
    for (let i = 0; i <= 8; i++) g.addColorStop(i / 8, lut[Math.round(255 * (i <= 4 ? i / 4 : (8 - i) / 4))]);
    return g;
  }
  const g = ctx.createLinearGradient(pts[0][0], 0, pts[pts.length - 1][0] || W, 0);
  for (let i = 0; i <= 4; i++) g.addColorStop(i / 4, lut[Math.round((255 * i) / 4)]);
  return g;
}
function draw(v) {
  const N = pts.length, maxLen = S.length * Math.min(W, H), lw = Math.max(1, gap * S.thickness);
  const len = (x) => 2 * scale + x * maxLen;
  ctx.lineCap = S.rounded ? "round" : "butt";
  if (S.style === "curve") {
    const layers = clamp(S.layers | 0, 1, 6);
    for (let L = layers - 1; L >= 0; L--) {
      const src = L === 0 ? v : hist[Math.min(hist.length - 1, L * 4)] || v, grow = 1 + L * 0.12;
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
  for (let k = 0; k < N; k++) {
    const [x, y, nx, ny] = pts[k], h = len(v[k]), back = S.mirror ? h * 0.55 : 0;
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
        ctx.strokeStyle = lut[Math.round(255 * clamp(j / all, 0, 1))];
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
  const dt = clamp((now - last) / 1000, 0, 0.1); last = now;
  analyse(dt);
  const v = values();
  hist.unshift(Float32Array.from(v)); if (hist.length > 26) hist.pop();
  rot += S.rotate * TAU * dt * (closed || S.shape === "spiral" ? 1 : 0);
  hue = (hue + S.hueDrift * 360 * dt) % 360;

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
  $("stage").style.filter = S.hueDrift ? `hue-rotate(${hue.toFixed(1)}deg)` : "";
  $("bg").style.transform = `scale(${1 + pulse * S.beatPulse * 0.025})`;
  const disc = $("disc");
  if (disc.classList.contains("on")) {
    const d = (R * 2 * 0.72) / scale;
    Object.assign(disc.style, { width: d + "px", height: d + "px", left: cx / scale - d / 2 + "px", top: cy / scale - d / 2 + "px", transform: `scale(${1 + pulse * S.beatPulse * 0.07})` });
  }
}

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
  if (S.background === "cover") bg.style.backgroundImage = media.cover ? `url("${media.cover}")` : "radial-gradient(circle, #1b1430, #05050a 75%)";
  bg.style.filter = S.background === "cover" ? `blur(80px) saturate(1.6) brightness(${1 - S.bgDim})` : `brightness(${1.2 - S.bgDim})`;
  $("disc").classList.toggle("on", !!(S.coverCenter && closed && media.cover));
  $("card").className = `${S.card} ${S.card !== "hidden" && media.title ? "on" : ""}`;
  $("clock").classList.toggle("on", !!S.clock);
  document.body.classList.toggle("drag", !fullscreen && S.mode !== "wallpaper");
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
    $("cover").src = $("disc").src = m.cover;
    const img = new Image(); img.onload = () => { coverPalette(img); S && buildLut(); }; img.src = m.cover;
  }
  if (S) scene();
});
window.bw.onFullscreen((on) => { fullscreen = on; document.body.classList.toggle("fs", on); if (S) scene(); });
$("prev").onclick = () => window.bw.media("prev");
$("next").onclick = () => window.bw.media("next");
$("pp").onclick = () => window.bw.media("play_pause");
addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.bw.fullscreen(false);
  else if (e.key === " ") window.bw.media("play_pause");
  else if (e.key === "ArrowRight") window.bw.media("next");
  else if (e.key === "ArrowLeft") window.bw.media("prev");
});
addEventListener("resize", resize);
setInterval(tick, 1000);

async function startAudio() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());  // only the sound is needed
    const ac = new AudioContext();
    analyser = ac.createAnalyser(); analyser.fftSize = 16384; analyser.smoothingTimeConstant = 0; analyser.minDecibels = -120; analyser.maxDecibels = 0;
    ac.createMediaStreamSource(stream).connect(analyser);
    freq = new Float32Array(analyser.frequencyBinCount); sr = ac.sampleRate;
    if (S) { buildBands(); layout(); }
  } catch (e) { console.error("audio", e); setTimeout(startAudio, 3000); }
}
startAudio();
requestAnimationFrame(frame);
