"""Browse the Spotify desktop app through Windows UI Automation (its accessibility tree), so Bandwave can list
your library, search, and press Play on anything without a Spotify login or API key.

Runs on its own thread (UIA calls block for 1-3 s); results go out through the emit callback.
"""
import ctypes, os, queue, threading, time, urllib.parse
from ctypes import wintypes

u32, k32 = ctypes.windll.user32, ctypes.windll.kernel32


def spotify_hwnd():
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(h, _):
        pid = wintypes.DWORD()
        u32.GetWindowThreadProcessId(h, ctypes.byref(pid))
        hp = k32.OpenProcess(0x1000, False, pid.value)  # QUERY_LIMITED_INFORMATION
        if hp:
            buf, n = ctypes.create_unicode_buffer(260), wintypes.DWORD(260)
            if k32.QueryFullProcessImageNameW(hp, 0, buf, ctypes.byref(n)) and buf.value.lower().endswith("spotify.exe"):
                c, t = ctypes.create_unicode_buffer(64), ctypes.create_unicode_buffer(200)
                u32.GetClassNameW(h, c, 64)
                u32.GetWindowTextW(h, t, 200)
                if c.value.startswith("Chrome_WidgetWin") and t.value:
                    found.append(h)
            k32.CloseHandle(hp)
        return True

    u32.EnumWindows(each, 0)
    return found[0] if found else None


def split(name):
    """'Play Tum Hi Ho by Arijit Singh, Mithoon' -> ('Tum Hi Ho', 'Arijit Singh, Mithoon')"""
    body = name[5:].strip()
    title, by, who = body.rpartition(" by ")
    return (title, who) if by else (body, "")


class SpotifyUI:
    def __init__(self, emit):
        self.emit, self.q = emit, queue.Queue()
        threading.Thread(target=self._run, daemon=True).start()

    def ask(self, cmd, arg=""):
        self.q.put((cmd, arg))

    def _run(self):
        import uiautomation as auto  # COM must be set up on this thread
        self.auto = auto
        with auto.UIAutomationInitializerInThread():
            while True:
                cmd, arg = self.q.get()
                if cmd == "search" and not self.q.empty():
                    continue  # a newer request is waiting: skip this one
                try:
                    getattr(self, cmd)(arg)
                except Exception as e:
                    self.emit({"type": "browse", "kind": "error", "msg": f"{type(e).__name__}: {e}"})

    def _window(self):
        h = spotify_hwnd()
        if not h:
            os.startfile("spotify:")
            for _ in range(20):
                time.sleep(0.5)
                if (h := spotify_hwnd()):
                    break
        if not h:
            raise RuntimeError("Spotify isn't running")
        return self.auto.ControlFromHandle(h)

    def _plays(self, root, depth):
        seen, out, section = set(), [], ""
        for c, _ in self.auto.WalkControl(root, maxDepth=depth):
            if c.ControlTypeName == "GroupControl" and c.LocalizedControlType == "region" and c.Name:
                section = c.Name
            elif c.ControlTypeName == "ButtonControl" and c.Name.startswith("Play ") and c.Name not in seen:
                seen.add(c.Name)
                title, who = split(c.Name)
                out.append({"label": title, "sub": who, "section": section, "play": c.Name})
        return out

    def library(self, _=""):
        w = self._window()
        grid = w.DataGridControl(Name="Your Library", searchDepth=30)
        items = self._plays(grid, 14) if grid.Exists(3) else []
        for i in items:
            i["section"] = "Your library"
        self.emit({"type": "browse", "kind": "library", "items": items})

    def search(self, q):
        w = self._window()
        os.startfile("spotify:search:" + urllib.parse.quote(q))
        deadline, items = time.time() + 9, []
        while time.time() < deadline:  # wait for this query's results page to render
            time.sleep(0.6)
            page = w.GroupControl(AutomationId="searchPage", searchDepth=25)
            if page.Exists(0.5):
                main = page.GetParentControl()
                if main and q.lower() in (main.Name or "").lower().replace("+", " "):  # Spotify shows spaces as +
                    time.sleep(0.5)
                    items = self._plays(page, 30)
                    if items:
                        break
        self.emit({"type": "browse", "kind": "search", "q": q, "items": items})

    def play(self, name):
        w = self._window()
        b = w.ButtonControl(Name=name, searchDepth=45)
        if not b.Exists(3):
            raise RuntimeError("that item is no longer on Spotify's screen; search again")
        b.GetInvokePattern().Invoke()
        self.emit({"type": "browse", "kind": "played", "play": name})
