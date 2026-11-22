"""Bandwave helper: now-playing info + media keys (Windows media session, so Spotify and any player work),
and pinning the visualizer window behind the desktop icons.

stdout: one JSON object per line  {"type": "media", "title", "artist", "album", "playing", "app", "cover"?}
stdin:  play_pause | next | prev | wallpaper <hwnd> | unwallpaper <hwnd>
"""
import asyncio, base64, ctypes, json, sys, threading
from ctypes import wintypes

from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as Manager
from winrt.windows.storage.streams import Buffer, InputStreamOptions

u32 = ctypes.windll.user32
try:
    u32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # physical pixels, so the 4K desktop is covered exactly
except Exception:
    pass
for f in ("FindWindowW", "FindWindowExW", "SetParent"):
    getattr(u32, f).restype = wintypes.HWND
u32.FindWindowExW.argtypes = [wintypes.HWND, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR]
u32.SetParent.argtypes = [wintypes.HWND, wintypes.HWND]
u32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
u32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM, wintypes.UINT,
                                    wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]


_lock = threading.Lock()


def out(obj):
    with _lock:  # the Spotify browser thread writes too
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def worker_w():
    """The desktop layer between the wallpaper and the icons (0x052C asks Explorer to create it)."""
    progman = u32.FindWindowW("Progman", None)
    r = ctypes.c_size_t()
    u32.SendMessageTimeoutW(progman, 0x052C, 0xD, 0x1, 0, 1000, ctypes.byref(r))
    u32.SendMessageTimeoutW(progman, 0x052C, 0, 0, 0, 1000, ctypes.byref(r))
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(h, _):
        if u32.FindWindowExW(h, None, "SHELLDLL_DefView", None):
            w = u32.FindWindowExW(None, h, "WorkerW", None)  # Windows 10: the WorkerW after the icons' host
            if w:
                found.append(w)
        return True

    u32.EnumWindows(each, 0)
    return found[0] if found else (u32.FindWindowExW(progman, None, "WorkerW", None) or progman)  # 11 24H2: child of Progman


def wallpaper(h):
    u32.SetParent(h, worker_w())
    vx, vy = u32.GetSystemMetrics(76), u32.GetSystemMetrics(77)  # virtual-screen origin (monitors left/above primary)
    u32.SetWindowPos(h, None, -vx, -vy, u32.GetSystemMetrics(0), u32.GetSystemMetrics(1), 0x0014)


async def pick(mgr):
    """Spotify if it has a session, else whatever is playing, else Windows' current session."""
    sessions = list(mgr.get_sessions())
    playing = [s for s in sessions if s.get_playback_info().playback_status == 4]
    for group in (playing, sessions):
        for s in group:
            if "spotify" in (s.source_app_user_model_id or "").lower():
                return s
    return playing[0] if playing else mgr.get_current_session()


async def cover(ref):
    if ref is None:
        return None
    stream = await ref.open_read_async()
    buf = await stream.read_async(Buffer(stream.size), stream.size, InputStreamOptions.READ_AHEAD)
    data = bytes(memoryview(buf))
    kind = "png" if data[:4] == b"\x89PNG" else "jpeg"
    return f"data:image/{kind};base64," + base64.b64encode(data).decode()


async def main():
    mgr = await Manager.request_async()
    from spotify_ui import SpotifyUI
    browser = SpotifyUI(out)
    loop = asyncio.get_running_loop()
    state = {"session": None}

    async def command(line):
        try:
            await run(line)
        except Exception as e:  # run_coroutine_threadsafe would swallow it
            out({"type": "log", "msg": f"{line.strip()}: {type(e).__name__}: {e}"})

    async def run(line):
        cmd, _, arg = line.strip().partition(" ")
        s = state["session"]
        if cmd.startswith("browse_"):
            browser.ask(cmd[7:], arg)
        elif cmd == "wallpaper":
            wallpaper(int(arg))
            out({"type": "log", "msg": f"pinned {arg} under WorkerW"})
        elif cmd == "unwallpaper":
            u32.SetParent(int(arg), None)
        elif s and cmd == "play_pause":
            await s.try_toggle_play_pause_async()
        elif s and cmd == "next":
            await s.try_skip_next_async()
        elif s and cmd == "prev":
            await s.try_skip_previous_async()

    def read_stdin():
        for line in sys.stdin:
            asyncio.run_coroutine_threadsafe(command(line), loop)
        loop.call_soon_threadsafe(loop.stop)  # the app closed our stdin: exit with it

    threading.Thread(target=read_stdin, daemon=True).start()
    last = None
    while True:
        try:
            s = await pick(mgr)
            state["session"] = s
            if s is None:
                msg = {"type": "media", "title": None}
            else:
                p = await s.try_get_media_properties_async()
                tl = s.get_timeline_properties()
                playing = s.get_playback_info().playback_status == 4
                msg = {"type": "media", "title": p.title, "artist": p.artist, "album": p.album_title,
                       "playing": playing, "app": s.source_app_user_model_id, "dur": tl.end_time.total_seconds()}
                # position as of last_updated_time (Spotify refreshes it every few s); the app extrapolates in between
                out({"type": "pos", "pos": tl.position.total_seconds(), "at": tl.last_updated_time.timestamp() * 1000, "playing": playing})
            key = (msg.get("title"), msg.get("artist"), msg.get("playing"))
            if key != last:
                if s is not None and (last is None or key[:2] != last[:2]):
                    try:
                        msg["cover"] = await cover(p.thumbnail)
                    except Exception:
                        msg["cover"] = None
                last = key
                out(msg)
        except Exception as e:  # a player closing mid-read; try again next tick
            out({"type": "log", "msg": f"{type(e).__name__}: {e}"})
        await asyncio.sleep(0.8)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except RuntimeError:
        pass  # loop stopped by read_stdin
