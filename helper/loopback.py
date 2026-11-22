"""System audio for Bandwave without any screen capture: WASAPI loopback of the default output device.

Two analyses run on the same stream:
  * display spectrum: 16384-point FFT (Blackman, Web Audio's dB scale) reduced to the app's bands, ~60 times a second
      -> {"type": "spec", "v": [dB per band]}
  * drums: a 2048-point FFT every 512 samples (~12 ms). A hit is a sharp, broadband rise in log-magnitude:
      kick  = most bins of 40-130 Hz jump at once; snare = most bins of 1-5 kHz AND of its 150-500 Hz body jump at
      once (a snare's noise is broadband; a sung or bass note lifts only a few harmonic bins, a hi-hat has no body). Thresholds adapt to the
      song (median + spread of the last 0.6 s), with a one-hop look-ahead so only peaks count.
      -> {"type": "hit", "k": "kick"|"snare", "s": strength 0.3-1}
  * tempo: autocorrelation of the drum-onset envelope over the last 8 s, every second
      -> {"type": "bpm", "bpm": 60-200, "conf": 0-1}
The app sends band edges in Hz ("bands [..]"). Follows the default output device when it changes.
"""
import collections, threading, time

import numpy as np
import pyaudiowpatch as pa

N, SMALL, HOP = 16384, 2048, 512


class Detector:
    """Adaptive peak picker for one drum: band flux must clear median + 2.2 x upper spread of the recent past."""

    def __init__(self, gap_s, hops_per_s):
        self.hist = collections.deque(maxlen=int(0.6 * hops_per_s))
        self.prev2 = self.prev1 = 0.0
        self.gap, self.last = gap_s, -1.0

    def step(self, x, t):
        """Feed this hop's flux; returns the strength of a hit that peaked one hop ago, else 0."""
        hit = 0.0
        if len(self.hist) >= 10:
            h = np.fromiter(self.hist, float)
            med, hi, top = np.median(h), np.percentile(h, 80), np.percentile(h, 97)
            thr = med + 2.2 * (hi - med) + 1e-3
            if self.prev1 > thr and self.prev1 >= self.prev2 and self.prev1 >= x and t - self.last > self.gap:
                self.last = t
                hit = float(np.clip((self.prev1 - med) / (top - med + 1e-6), 0.3, 1.0))
        self.hist.append(self.prev1)
        self.prev2, self.prev1 = self.prev1, x
        return hit


class Loopback:
    def __init__(self, emit):
        self.emit, self.edges, self.plan, self.rate = emit, None, None, 48000
        threading.Thread(target=self._run, daemon=True).start()

    def set_edges(self, edges):
        self.edges = [float(e) for e in edges]
        self._plan()

    def _plan(self):
        """Per display band: an interpolated bin (narrower than one bin) or a slice whose max is taken."""
        if not self.edges:
            return
        hz = self.rate / N
        plan = []
        for lo, hi in zip(self.edges[:-1], self.edges[1:]):
            a, b = lo / hz, hi / hz
            if b - a < 1:
                x = (a + b) / 2
                plan.append(("i", int(x), x - int(x)))
            else:
                plan.append(("s", int(np.ceil(a)), min(int(np.floor(b)), N // 2) + 1))
        self.plan = plan

    def _bands(self, db):
        out = []
        for kind, a, b in self.plan:
            out.append(db[a] * (1 - b) + db[a + 1] * b if kind == "i" else (db[a:b].max() if b > a else db[a]))
        return [round(float(v), 1) for v in out]

    def _tempo(self, env, fps):
        """BPM from the autocorrelation of the onset envelope, gently preferring ~120 (halves/doubles are ambiguous)."""
        x = np.asarray(env, float)
        x = x - x.mean()
        if not x.any():
            return
        f = np.fft.rfft(x, 2 * len(x))
        ac = np.fft.irfft(f * np.conj(f))[: len(x)]
        if ac[0] <= 0:
            return
        lags = np.arange(int(60 * fps / 200), int(60 * fps / 60) + 1)
        bpms = 60 * fps / lags
        score = ac[lags] * np.exp(-0.5 * (np.log2(bpms / 120) / 0.9) ** 2)
        i = int(np.argmax(score))
        lag = float(lags[i])
        if 0 < i < len(lags) - 1:  # parabolic refinement between lags
            a, b, c = ac[lags[i] - 1], ac[lags[i]], ac[lags[i] + 1]
            d = a - 2 * b + c
            if d:
                lag += 0.5 * (a - c) / d
        self.emit({"type": "bpm", "bpm": round(60 * fps / lag, 1), "conf": round(float(max(0.0, ac[lags[i]] / ac[0])), 2)})

    def _run(self):
        p = pa.PyAudio()
        win_big = np.blackman(N).astype(np.float32)
        win_small = np.hanning(SMALL).astype(np.float32)
        while True:
            try:
                dev = p.get_default_wasapi_loopback()
                self.rate, ch = int(dev["defaultSampleRate"]), max(1, dev["maxInputChannels"])
                self._plan()
                fps = self.rate / HOP
                hz = self.rate / SMALL
                kick_bins = slice(max(1, int(40 / hz)), int(130 / hz) + 1)
                snare_bins = slice(int(1000 / hz), int(5000 / hz) + 1)
                body_bins = slice(int(150 / hz), int(500 / hz) + 1)  # a snare's thump; hi-hats have none
                kick, snare = Detector(0.11, fps), Detector(0.11, fps)
                env = collections.deque(maxlen=int(8 * fps))
                stream = p.open(format=pa.paFloat32, channels=ch, rate=self.rate, input=True,
                                input_device_index=dev["index"], frames_per_buffer=HOP)
                buf, pending = np.zeros(N, np.float32), np.zeros(0, np.float32)
                prev = np.zeros(SMALL // 2 + 1, np.float32)
                t0 = last_data = time.time()
                hops, last_spec, last_tempo, checked = 0, 0.0, time.time(), time.time()
                while True:
                    avail = stream.get_read_available()
                    now = time.time()
                    if avail >= HOP:
                        pending = np.concatenate([pending, np.frombuffer(stream.read(avail, exception_on_overflow=False), np.float32).reshape(-1, ch).mean(axis=1)])
                        last_data = now
                    elif now - last_data > 0.03:  # loopback delivers nothing during silence: keep time moving with zeros
                        pending = np.concatenate([pending, np.zeros(int((now - last_data) * self.rate), np.float32)])
                        last_data = now
                    else:
                        time.sleep(0.004)
                        continue
                    while len(pending) >= HOP:
                        chunk, pending = pending[:HOP], pending[HOP:]
                        buf = np.concatenate([buf[HOP:], chunk])
                        hops += 1
                        t = t0 + hops / fps
                        mag = np.log1p(100 * np.abs(np.fft.rfft(buf[-SMALL:] * win_small)))
                        d = mag - prev
                        prev = mag
                        dk, ds = d[kick_bins], d[snare_bins]
                        # flux counts only when the rise is broadband within the band (drum), not a few harmonic bins (voice, bass note)
                        fk = float(np.maximum(dk, 0).mean()) * min(1.0, (dk > 0.05).mean() / 0.6)
                        db_ = d[body_bins]
                        fs = float(np.maximum(ds, 0).mean()) * min(1.0, (ds > 0.05).mean() / 0.5) * min(1.0, (db_ > 0.05).mean() / 0.5)
                        env.append(fk + fs)
                        if mag[kick_bins].mean() > 0.05 or mag[snare_bins].mean() > 0.05:  # not silence
                            sk, ss = kick.step(fk, t), snare.step(fs, t)
                            if sk:
                                self.emit({"type": "hit", "k": "kick", "s": round(sk, 2)})
                            elif ss:
                                self.emit({"type": "hit", "k": "snare", "s": round(ss, 2)})
                    if self.plan and now - last_spec >= 1 / 60:
                        last_spec = now
                        big = np.abs(np.fft.rfft(buf * win_big)) / N
                        self.emit({"type": "spec", "v": self._bands(20 * np.log10(big + 1e-12))})
                    if now - last_tempo >= 1 and len(env) > fps * 4:
                        last_tempo = now
                        self._tempo(env, fps)
                    if now - checked > 2:  # output device switched? reopen on the new default
                        checked = now
                        if p.get_default_wasapi_loopback()["index"] != dev["index"]:
                            break
                stream.close()
            except Exception as e:
                self.emit({"type": "log", "msg": f"loopback: {type(e).__name__}: {e}"})
                time.sleep(2)
                p.terminate()
                p = pa.PyAudio()
