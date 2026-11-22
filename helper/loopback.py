"""System-audio spectrum for Bandwave without any screen capture: WASAPI loopback of the default output device,
16384-point FFT (Blackman window, same dB scale as Web Audio's AnalyserNode), reduced to the app's bands.

The app sends band edges in Hz ("bands [..]"); ~60 times a second this emits {"type": "spec", "v": [dB per band]}.
Follows the default output device when it changes (headphones <-> speakers).
"""
import threading, time

import numpy as np
import pyaudiowpatch as pa

N = 16384


class Loopback:
    def __init__(self, emit):
        self.emit, self.edges, self.plan, self.rate = emit, None, None, 48000
        threading.Thread(target=self._run, daemon=True).start()

    def set_edges(self, edges):
        self.edges = [float(e) for e in edges]
        self._plan()

    def _plan(self):
        """Per band: an interpolated bin (narrower than one bin) or a slice whose max is taken (as the app did)."""
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
            if kind == "i":
                out.append(db[a] * (1 - b) + db[a + 1] * b)
            else:
                out.append(db[a:b].max() if b > a else db[a])
        return [round(float(v), 1) for v in out]

    def _run(self):
        p = pa.PyAudio()
        win = np.blackman(N).astype(np.float32)
        while True:
            try:
                dev = p.get_default_wasapi_loopback()
                self.rate, ch = int(dev["defaultSampleRate"]), max(1, dev["maxInputChannels"])
                self._plan()
                hop = self.rate // 60
                stream = p.open(format=pa.paFloat32, channels=ch, rate=self.rate, input=True,
                                input_device_index=dev["index"], frames_per_buffer=hop)
                buf, quiet, checked = np.zeros(N, np.float32), 0.0, time.time()
                while True:
                    avail = stream.get_read_available()
                    if avail >= hop:
                        x = np.frombuffer(stream.read(avail, exception_on_overflow=False), np.float32).reshape(-1, ch).mean(axis=1)
                        quiet = 0.0
                    else:
                        time.sleep(1 / 120)
                        quiet += 1 / 120
                        if quiet < 0.05:
                            continue
                        x = np.zeros(hop, np.float32)  # loopback delivers nothing during silence: feed zeros so bars fall
                        quiet = 0.0
                    x = x[-N:]
                    buf = np.concatenate([buf[len(x):], x])
                    if self.plan:
                        mag = np.abs(np.fft.rfft(buf * win)) / N
                        self.emit({"type": "spec", "v": self._bands(20 * np.log10(mag + 1e-12))})
                    if time.time() - checked > 2:  # output device switched? reopen on the new default
                        checked = time.time()
                        if p.get_default_wasapi_loopback()["index"] != dev["index"]:
                            break
                stream.close()
            except Exception as e:
                self.emit({"type": "log", "msg": f"loopback: {type(e).__name__}: {e}"})
                time.sleep(2)
                p.terminate()
                p = pa.PyAudio()
