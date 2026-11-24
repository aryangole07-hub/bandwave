// Every setting the visualizer understands, with its default. The settings window edits these; main.js saves them.
const DEFAULTS = {
  mode: "wallpaper",        // wallpaper (behind desktop icons) | window | ontop
  startup: false,           // start with Windows
  closeWithSpotify: true,   // quit Bandwave when Spotify quits (only after Spotify was seen running)
  withSpotify: true,        // open Bandwave whenever Spotify starts (watcher runs from logon)

  // Layout: the shape the bands are spread around
  shape: "circle",          // circle | polygon | star | heart | infinity | line | wave | spiral
  sides: 6,                 // polygon sides / star points
  size: 0.24,               // shape size, share of the shorter screen side
  rotate: 0.04,             // turns per second (closed shapes)
  offsetX: 0, offsetY: 0,   // shape centre shift, share of the screen

  // Bands
  bands: 96,
  minHz: 30, maxHz: 16000,
  spacing: "log",           // log | mel | linear | custom
  customEdges: "20, 45, 90, 150, 250, 400, 650, 1000, 1600, 2500, 4000, 6300, 10000, 16000",
  symmetric: true,          // spectrum mirrored around the shape, so closed shapes join seamlessly
  mirror: false,            // bands grow both outward and inward
  tilt: 0.7,                // treble lift (dB per octave above 1 kHz x 3)

  // Look
  style: "bars",            // bars | curve | dots | blocks
  length: 0.32,             // longest band, share of the shorter screen side
  thickness: 0.62,          // bar width as a share of the gap
  rounded: true,
  fill: true,               // curve: fill under the line
  layers: 3,                // echo layers trailing the bands (all styles)
  echoShadow: 0.6,          // shadow each newer echo layer casts on the older ones below it (0 = none)
  echoBeat: 0.25,           // each echo layer lags this fraction of a beat (tempo detected from the kicks)
  theme: "nebula",          // nebula | sunset | ocean | neon | fire | ice | album (colours from the cover) | custom
  custom: "#7c5cff",
  colorBy: "position",      // position | level
  hueDrift: 0.02,           // hue turns per second
  flow: 0.12,               // colour cycles per second travelling along the shape (speeds up with the music)

  // Motion
  sensitivity: 1.0,
  floorDb: -82,
  attack: 0.55, decay: 0.12,
  glow: 0.75, trails: 0.5,
  particles: true,
  beatPulse: 0.7, shake: 0.25,
  barShake: 0,              // bands jitter with their own loudness (0 = off)

  // Scene
  background: "blend",      // blend (live average of the on-screen colours over the album art) | cover | gradient | black
  bgDim: 0.6,
  coverCenter: true,        // spinning record in the centre (album art label, song name around the groove)
  spin: 0.12,               // record turns per second while playing
  lyrics: true,             // time-synced lyrics inside the record (LRCLIB)
  lyricsOffset: 0,
  lyricsBounce: 1,          // how hard the current lyric line kicks on the beat (0 = still)
  lyricsPos: "bottom-left", // bottom-left (above the now-playing card) | record (inside the spinning record)          // seconds; + shows lines earlier
  card: "bottom-left",      // bottom-left | bottom-center | top-left | hidden
  clock: true, clock24: false,
  keyGuide: true,           // translucent list of keys, top right
  renderScale: 0.5,         // drawing resolution vs the screen (1 = full 4K, much heavier; 0.5 = 1080p canvas)
  fps: 60,                  // frame cap
};
if (typeof module !== "undefined") module.exports = DEFAULTS;
