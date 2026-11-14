"""
ComfyAF — the phone remote's server, inside ComfyUI.                         (2026-11-13)

Ported from KcadaBRA _EcoComs/EcoRemote/server.mjs (Node). The rules are the same; what it reaches is not:

    phone (same Wi-Fi) ──ws /ws?k=KEY──►  this server  ──send_sync──►  the ComfyUI page in the browser
      phone/index.html                     0.0.0.0:8796      ◄──POST /comfyaf/reply──    web/phone-remote.js

WHY ITS OWN PORT: ComfyUI itself usually listens on 127.0.0.1 only, and should: anyone who reaches it can run
anything. The phone is on the LAN, so this server listens on 0.0.0.0, serves only the phone page, and lets in
only a phone that knows the pairing key. It is OFF until the person turns it on (Settings › ComfyAF).

The rules from EcoRemote, unchanged:
  · a pairing key (.remote-key, made on first start; "New key" on the pair page un-pairs every phone). The phone
    carries it in the URL hash and keeps it in its storage
  · 8 wrong keys from one address in 10 minutes → that address waits 10 minutes
  · same-origin only: another web page open on the phone cannot drive ComfyUI
  · /pair (the page with the key and the QR code) opens on the computer itself only
  · a short list of what a phone may do (ALLOWED / COMMANDS below)
  · gestures arrive at 60 fps and are merged: one pan/zoom at a time per phone, the next carrying everything
    that arrived meanwhile, so ComfyUI never falls behind the finger

MOUSE MODE AND THE KEYBOARD (Windows), as in EcoRemote: the phone's Select tool turns the pad into the computer's
REAL mouse, and ⌨ types with its real keyboard, anywhere on the computer, not just in ComfyUI (input-helper.ps1:
PowerShell + SendInput, started on first use, nothing to install). Because that is the whole computer, it has its
own switch, OFF by default: Settings › ComfyAF › Phone remote › "Let the phone use the mouse and keyboard".

Left out on purpose: the MCP relay, the app picker, plugin menus, Panel mode, drawing tools.

Threads: this server runs on its own thread and event loop, so it never waits on ComfyUI's. ComfyUI's
PromptServer.send_sync is thread-safe (it posts to ComfyUI's loop); replies come back on ComfyUI's loop and are
handed to ours with call_soon_threadsafe.
"""
import asyncio
import hmac
import io
import json
import logging
import os
import re
import secrets
import subprocess
import sys
import socket
import threading
import time

from aiohttp import web, WSMsgType

VERSION = "0.2.0"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))           # the ComfyAF folder
PHONE = os.path.join(HERE, "phone")
KEY_FILE = os.path.join(HERE, ".remote-key")
INPUT_PS1 = os.path.join(HERE, "comfyaf", "input-helper.ps1")
INPUT_CMD = json.loads(os.environ["COMFYAF_INPUT_CMD"]) if os.environ.get("COMFYAF_INPUT_CMD") else None   # tests: ["python","mock.py"]
DEFAULT_PORT = 8796                                                          # EcoRemote is 8795: both can run
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"                                 # no 0/O, 1/I/L
log = logging.getLogger("ComfyAF")


def say(*a):
    print("[ComfyAF]", *a, flush=True)


# ---------------------------------------------------------------------------- pairing key
def new_key():
    k = "".join(secrets.choice(ALPHABET) for _ in range(12))
    return "-".join(k[i:i + 4] for i in range(0, 12, 4))


def load_key(fresh=False):
    env = os.environ.get("COMFYAF_KEY", "").strip()
    if env:
        return env
    if not fresh:
        try:
            with open(KEY_FILE, encoding="utf-8") as f:
                k = f.read().strip()
            if k:
                return k
        except OSError:
            pass
    k = new_key()
    with open(KEY_FILE, "w", encoding="utf-8") as f:
        f.write(k + "\n")
    try:
        os.chmod(KEY_FILE, 0o600)
    except OSError:
        pass
    say("new pairing key — phones paired before must scan again" if fresh else "created a pairing key in .remote-key")
    return k


def norm(k):
    return "".join(c for c in str(k or "").upper() if c.isalnum())


def is_loopback(ip):
    ip = str(ip or "")
    return ip.startswith("127.") or ip == "::1" or ip.startswith("::ffff:127.")


def lan_addresses():
    """The addresses a phone could reach this computer at, best first. COMFYAF_ADDRESS picks one."""
    chosen = os.environ.get("COMFYAF_ADDRESS", "").strip()
    if chosen:
        return [chosen]
    found = []
    try:                                     # the adapter the default route uses (no packet is sent)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        found.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for a in socket.gethostbyname_ex(socket.gethostname())[2]:
            if a not in found:
                found.append(a)
    except OSError:
        pass
    found = [a for a in found if not a.startswith("127.") and not a.startswith("169.254.")]
    rank = lambda a: 0 if a.startswith("192.168.") else 0.5 if a.startswith("10.") else 1
    return sorted(found, key=rank)


# ---------------------------------------------------------------------------- what a phone may do
ALLOWED = {"canvas_state", "canvas_snapshot", "canvas_command", "canvas_select"}
COMMANDS = {"panBy", "zoomBy", "fitContent", "zoomReset", "undo", "redo", "moveSelection", "selectAll", "queue"}
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json"}
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}
SECURITY = {
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
                               "img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Cache-Control": "no-cache",
}


def prompt_server():
    from server import PromptServer                       # ComfyUI's; imported late (tests put a stand-in there)
    return PromptServer.instance


# ---------------------------------------------------------------------------- the computer's mouse + keyboard
class Helper:
    """input-helper.ps1: one PowerShell process, started on first use, that calls Windows' SendInput. One mouse for
    every phone, so one queue: moves are merged while the previous one runs; clicks and keys wait their turn."""

    def __init__(self, remote):
        self.r = remote
        self.proc = None
        self.ready = None
        self.seq = 0
        self.waiting = {}
        self.lock = None

    def status(self):
        if not self.r.input_on:
            return False, "Mouse and keyboard are off on the computer. Turn them on in ComfyUI: Settings › ComfyAF › Phone remote."
        if sys.platform != "win32" and not INPUT_CMD:
            return False, "Mouse and keyboard work when ComfyUI runs on Windows."
        return True, ""

    async def start(self):
        if self.ready is None:
            loop = asyncio.get_event_loop()
            self.ready = loop.create_future()
            cmd = INPUT_CMD or ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", INPUT_PS1]
            kw = {"creationflags": 0x08000000} if sys.platform == "win32" else {}          # CREATE_NO_WINDOW
            try:
                proc = await asyncio.create_subprocess_exec(*cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                                            limit=64 * 1024 * 1024, **kw)
            except Exception as e:
                self.ready = None
                raise RuntimeError("the input helper could not start: %s" % e)
            self.proc = proc
            asyncio.ensure_future(self._read(proc, self.ready))
            asyncio.ensure_future(self._stderr(proc))
        try:
            await asyncio.wait_for(asyncio.shield(self.ready), 30)
        except asyncio.TimeoutError:
            self.stop()
            raise RuntimeError("the input helper did not start (see the ComfyUI window)")

    async def _read(self, proc, ready):
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            line = line.decode("utf-8", "replace").rstrip("\r\n")
            if line == "ready":
                if not ready.done():
                    ready.set_result(True)
                say("mouse & keyboard helper ready")
                continue
            m = re.match(r"^(\d+) (ok|err) ?(.*)$", line)
            if not m:
                continue
            fut = self.waiting.pop(int(m.group(1)), None)
            if fut and not fut.done():
                if m.group(2) == "ok":
                    fut.set_result(m.group(3))
                else:
                    fut.set_exception(RuntimeError(m.group(3) or "input failed"))
        if self.proc is proc:
            self.proc, self.ready = None, None
        for fut in self.waiting.values():
            if not fut.done():
                fut.set_exception(RuntimeError("the input helper stopped"))
        self.waiting.clear()
        if not ready.done():
            ready.set_exception(RuntimeError("the input helper stopped"))

    async def _stderr(self, proc):
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            t = line.decode("utf-8", "replace").strip()
            if t:
                say("input helper:", t[:600])

    async def call(self, line, timeout=15):
        ok, why = self.status()
        if not ok:
            raise RuntimeError(why)
        if self.lock is None:
            self.lock = asyncio.Lock()
        async with self.lock:                                   # one at a time, in order
            await self.start()
            self.seq += 1
            cid = self.seq
            fut = asyncio.get_event_loop().create_future()
            self.waiting[cid] = fut
            self.proc.stdin.write(("%d %s\n" % (cid, line)).encode("utf-8"))
            await self.proc.stdin.drain()
            try:
                return await asyncio.wait_for(fut, timeout)
            except asyncio.TimeoutError:
                self.waiting.pop(cid, None)
                raise RuntimeError("the computer did not answer (input)")

    def stop(self):
        p, self.proc, self.ready = self.proc, None, None
        if p:
            try:
                p.stdin.close()
                p.kill()
            except Exception:
                pass


VK = {"Enter": 13, "Backspace": 8, "Tab": 9, "Escape": 27, "Delete": 46, "Insert": 45, "Home": 36, "End": 35, "PageUp": 33, "PageDown": 34,
      "ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40, "Space": 32, "Win": 91, "ContextMenu": 93, "PrintScreen": 44}


def vk_of(key):
    if key in VK:
        return VK[key]
    if re.match(r"^F([1-9]|1[0-2])$", key):
        return 111 + int(key[1:])
    if re.match(r"^[A-Za-z]$", key):
        return ord(key.upper())
    if re.match(r"^[0-9]$", key):
        return 48 + int(key)
    raise ValueError("unknown key " + key)


class Phone:
    def __init__(self, remote, ws, ip, name):
        self.r, self.ws, self.ip, self.name = remote, ws, ip, name
        self.q = dict(dx=0.0, dy=0.0, f=1.0, fx=0.5, fy=0.5, begin=False, mdx=0.0, mdy=0.0, end=False)
        self.dragging = False
        self.busy = False

    async def send(self, m):
        if not self.ws.closed:
            try:
                await self.ws.send_str(json.dumps(m))
            except Exception:                                # closing
                pass

    def gesture(self, m):
        t, q = m.get("t"), self.q
        num = lambda v, d=0.0: float(v) if isinstance(v, (int, float)) else d
        if t == "pan":
            q["dx"] += num(m.get("dx")); q["dy"] += num(m.get("dy"))
        elif t == "drag":
            if m.get("phase") == "begin":
                q["begin"], q["end"] = True, False
            q["mdx"] += num(m.get("dx")); q["mdy"] += num(m.get("dy"))
            if m.get("phase") == "end":
                q["end"] = True
        else:
            q["f"] *= max(0.2, min(5.0, num(m.get("f"), 1.0)))
            if isinstance(m.get("fx"), (int, float)):
                q["fx"], q["fy"] = m["fx"], num(m.get("fy"), 0.5)
        asyncio.ensure_future(self.pump())

    async def pump(self):
        if self.busy:
            return
        q = self.q
        zoom, pan = abs(q["f"] - 1) > 0.002, abs(q["dx"]) >= 0.5 or abs(q["dy"]) >= 0.5
        move = abs(q["mdx"]) >= 0.5 or abs(q["mdy"]) >= 0.5
        if not (zoom or pan or q["begin"] or move or q["end"]):
            return
        f, fx, fy, dx, dy, begin, mdx, mdy, end = q["f"], q["fx"], q["fy"], q["dx"], q["dy"], q["begin"], q["mdx"], q["mdy"], q["end"]
        self.q = dict(dx=0.0, dy=0.0, f=1.0, fx=fx, fy=fy, begin=False, mdx=0.0 if move else mdx, mdy=0.0 if move else mdy, end=False)
        self.busy = True
        try:
            r = None
            if zoom:
                r = await self.r.call_tab("canvas_command", {"command": "zoomBy", "factor": f, "fx": fx, "fy": fy})
            if pan:
                r = await self.r.call_tab("canvas_command", {"command": "panBy", "dx": round(dx), "dy": round(dy)})
            if r and r.get("camera"):
                await self.send({"t": "view", "camera": r["camera"]})
            # the selection follows the finger: begin … move … end is one undo step in ComfyUI
            if begin:
                b = await self.r.call_tab("canvas_command", {"command": "moveSelection", "phase": "begin"}) or {}
                self.dragging = bool(b.get("moved"))
                await self.send({"t": "drag", "moved": b.get("moved", 0), "selected": b.get("selected", [])})
            if move and self.dragging:
                await self.r.call_tab("canvas_command", {"command": "moveSelection", "phase": "move", "dx": round(mdx), "dy": round(mdy)})
            if end and self.dragging:
                self.dragging = False
                await self.r.call_tab("canvas_command", {"command": "moveSelection", "phase": "end"})
                await self.send({"t": "drag", "done": True})
        except Exception as e:
            await self.send({"t": "toast", "level": "error", "text": str(e)})
        finally:
            self.busy = False
            asyncio.get_event_loop().call_soon(lambda: asyncio.ensure_future(self.pump()))

    async def request(self, m):
        async def reply(**o):
            await self.send({"t": "reply", "id": m.get("id"), **o})
        try:
            t = m.get("t")
            if t == "call":
                name, a = m.get("name"), m.get("args") if isinstance(m.get("args"), dict) else {}
                if name not in ALLOWED:
                    raise ValueError('"%s" is not available from the remote.' % name)
                if name == "canvas_command" and a.get("command") not in COMMANDS:
                    raise ValueError("%s is not available from the remote." % a.get("command"))
                if name == "canvas_snapshot":
                    a = {"maxSide": max(200, min(2400, int(a.get("maxSide") or 900)))}
                return await reply(ok=True, data=await self.r.call_tab(name, a, timeout=20))
            if t == "input":
                return await reply(ok=True, data=await self.r.input_op(m, self))
            if t == "comfy":
                return await reply(ok=True, data=await self.r.comfy_op(m.get("op")))
            if t == "status":
                return await reply(ok=True, data=self.r.status_msg())
            raise ValueError("unknown request %s" % t)
        except Exception as e:
            await reply(ok=False, error=str(e) or e.__class__.__name__)


class Remote:
    """One per ComfyUI. start()/stop() from any thread; everything else runs on its own loop."""

    def __init__(self):
        self.thread = None
        self.loop = None
        self.port = None
        self.error = ""
        self.key = None
        self.phones = set()
        self.tabs = {}                     # tab id → what the ComfyUI page last said (see on_tab)
        self.pending = {}                  # call id → future (on our loop)
        self.misses = {}
        self.last_status = None
        self.lock = threading.Lock()
        self.input_on = False              # the phone may use the mouse and keyboard (its own setting, off by default)
        self.helper = Helper(self)
        self.mouse = {"dx": 0.0, "dy": 0.0, "busy": False, "screen": None, "held": {}}   # held: button → phone

    # ------------------------------------------------------------------ life
    @property
    def running(self):
        return bool(self.thread and self.thread.is_alive() and self.loop)

    def info(self):
        return {"on": self.running, "port": self.port, "error": self.error, "phones": len(self.phones), "version": VERSION, "input": self.input_on,
                "pair": "http://127.0.0.1:%s/pair" % self.port if self.running else None}

    def set_input(self, on):
        on = bool(on)
        if on == self.input_on:
            return
        self.input_on = on
        if not on and self.loop:
            self.loop.call_soon_threadsafe(self.helper.stop)
        self._poke()

    def start(self, port=DEFAULT_PORT, host=None):
        port = int(port or DEFAULT_PORT)
        host = host or os.environ.get("COMFYAF_HOST", "0.0.0.0")
        with self.lock:
            if self.running and self.port == port:
                return self.info()
            self._stop_locked()
            self.key = load_key()
            self.error = ""
            ready = threading.Event()
            self.thread = threading.Thread(target=self._run, args=(host, port, ready), name="ComfyAF", daemon=True)
            self.thread.start()
            ready.wait(10)
            return self.info()

    def stop(self):
        with self.lock:
            self._stop_locked()
            return self.info()

    def _stop_locked(self):
        if not self.running:
            self.thread, self.loop = None, None
            return
        loop = self.loop
        try:
            asyncio.run_coroutine_threadsafe(self._close_phones(), loop).result(3)
        except Exception:
            pass
        loop.call_soon_threadsafe(self.helper.stop)
        loop.call_soon_threadsafe(loop.stop)
        self.thread.join(5)
        self.thread, self.loop = None, None
        say("phone remote off")

    def _run(self, host, port, ready):
        # the input helper is a subprocess: on Windows that needs the Proactor loop, whatever policy ComfyUI chose
        loop = asyncio.ProactorEventLoop() if sys.platform == "win32" else asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        runner = web.AppRunner(self._app(), access_log=None)
        try:
            loop.run_until_complete(runner.setup())
            loop.run_until_complete(web.TCPSite(runner, host, port).start())
        except OSError as e:
            self.error = "port %s is taken — is another ComfyAF (or EcoRemote) using it? Choose another port in Settings › ComfyAF." % port \
                if getattr(e, "errno", None) in (48, 98, 10048) else str(e)
            say("could not start the phone remote:", self.error)
            loop.run_until_complete(runner.cleanup())
            loop.close()
            ready.set()
            return
        self.loop, self.port = loop, port
        ready.set()
        addrs = lan_addresses() if host != "127.0.0.1" else []
        say("phone remote on %s:%s — pair a phone: open http://127.0.0.1:%s/pair on this computer" % (host, port, port))
        if addrs:
            say("or on the phone (same Wi-Fi): http://%s:%s/   key %s" % (addrs[0], port, self.key))
        loop.create_task(self._status_loop())
        try:
            loop.run_forever()
        finally:
            loop.run_until_complete(runner.cleanup())
            loop.close()

    async def _close_phones(self):
        for p in list(self.phones):
            try:
                await p.ws.close()
            except Exception:
                pass

    # ------------------------------------------------------------------ the ComfyUI page (browser tab)
    def front_tab(self):
        now = time.time()
        live = [(k, t) for k, t in self.tabs.items() if now - t["at"] < 8]
        if not live:
            return None
        live.sort(key=lambda kt: (kt[1].get("focused", False), kt[1].get("visible", False), kt[1].get("focusAt", 0)), reverse=True)
        return live[0]

    def on_tab(self, d):
        """Called on ComfyUI's loop: a ComfyUI page says it is there (every 2 s, and at once on a change)."""
        tab = str(d.get("tab") or "")[:64]
        if not tab:
            return
        if d.get("gone"):
            self.tabs.pop(tab, None)
        else:
            t = self.tabs.setdefault(tab, {"focusAt": 0})
            if d.get("focused") and not t.get("focused"):
                t["focusAt"] = time.time()
            t.update(at=time.time(), visible=bool(d.get("visible")), focused=bool(d.get("focused")),
                     title=str(d.get("title") or "")[:120], theme=str(d.get("theme") or "")[:24],
                     progress=d.get("progress") if isinstance(d.get("progress"), dict) else None)
        self._poke()

    def on_reply(self, d):
        """Called on ComfyUI's loop: the page answered a call."""
        fut = self.pending.pop(str(d.get("id")), None)
        if fut and self.loop:
            def settle():
                if fut.done():
                    return
                if d.get("ok"):
                    fut.set_result(d.get("data"))
                else:
                    fut.set_exception(RuntimeError(str(d.get("error") or "ComfyUI could not do that")))
            self.loop.call_soon_threadsafe(settle)

    async def call_tab(self, name, args, timeout=8):
        front = self.front_tab()
        if not front:
            raise RuntimeError("ComfyUI is not open in a browser on the computer.")
        cid = secrets.token_hex(8)
        fut = asyncio.get_event_loop().create_future()
        self.pending[cid] = fut
        prompt_server().send_sync("comfyaf.call", {"id": cid, "tab": front[0], "name": name, "args": args})
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise RuntimeError("ComfyUI did not answer in time.")
        finally:
            self.pending.pop(cid, None)

    # ------------------------------------------------------------------ ComfyUI itself: queue, cancel, latest image
    async def comfy_op(self, op):
        if op == "queue":
            r = await self.call_tab("canvas_command", {"command": "queue"}, timeout=30)
            self._poke()
            return r
        if op == "cancel":
            try:
                import comfy.model_management as mm
                mm.interrupt_current_processing()
            except Exception:
                import nodes
                nodes.interrupt_processing()
            self._poke()
            return {"cancelled": True}
        raise ValueError("unknown %s" % op)

    # ------------------------------------------------------------------ Mouse mode and the keyboard
    def mouse_move(self, m):
        if not self.helper.status()[0]:
            return
        clampv = lambda v: max(-4000.0, min(4000.0, float(v) if isinstance(v, (int, float)) else 0.0))
        self.mouse["dx"] += clampv(m.get("dx")); self.mouse["dy"] += clampv(m.get("dy"))
        asyncio.ensure_future(self._pump_mouse())

    def _flush_mouse(self):
        ix, iy = int(self.mouse["dx"]), int(self.mouse["dy"])
        if not ix and not iy:
            return None
        self.mouse["dx"] -= ix; self.mouse["dy"] -= iy
        return self.helper.call("move %d %d" % (ix, iy))

    async def _pump_mouse(self):
        if self.mouse["busy"]:
            return
        job = self._flush_mouse()
        if not job:
            return
        self.mouse["busy"] = True
        try:
            await job
        except Exception:
            pass                                             # reported on the next request
        finally:
            self.mouse["busy"] = False
            asyncio.get_event_loop().call_soon(lambda: asyncio.ensure_future(self._pump_mouse()))

    async def input_op(self, m, phone):
        btn = m.get("button") if m.get("button") in ("left", "right", "middle") else "left"
        flushed = self._flush_mouse()                         # moves first, in order
        if flushed:
            try:
                await flushed
            except Exception:
                pass
        op = m.get("op")
        if op == "button":
            action = m.get("action") if m.get("action") in ("down", "up", "click", "dbl") else "click"
            await self.helper.call("button %s %s" % (btn, action))
            if action == "down":
                self.mouse["held"][btn] = phone
            elif action == "up":
                self.mouse["held"].pop(btn, None)
            return {}
        if op == "wheel":
            await self.helper.call("wheel %d %d" % (round(float(m.get("dy") or 0)), round(float(m.get("dx") or 0))))
            return {}
        if op == "text":
            text = str(m.get("text") or "")[:4000]
            if text:
                import base64
                await self.helper.call("text " + base64.b64encode(text.encode("utf-8")).decode("ascii"))
            return {}
        if op == "key":
            mods = [x for x in (m.get("mods") or []) if x in ("ctrl", "shift", "alt", "win")]
            await self.helper.call("key %d %s" % (vk_of(str(m.get("key") or "")), ",".join(mods) if mods else "-"))
            return {}
        if op == "moveTo":
            sc = self.mouse["screen"]
            if not sc:
                raise RuntimeError("take a picture of the screen first")
            self.mouse["dx"] = self.mouse["dy"] = 0.0
            fx, fy = max(0.0, min(1.0, float(m.get("fx") or 0))), max(0.0, min(1.0, float(m.get("fy") or 0)))
            x, y = round(sc["left"] + fx * (sc["width"] - 1)), round(sc["top"] + fy * (sc["height"] - 1))
            await self.helper.call("moveto %d %d" % (x, y))
            return {"x": x, "y": y}
        if op == "pos":
            x, y = (await self.helper.call("pos")).split(" ")
            return {"x": int(x), "y": int(y)}
        if op == "screen":
            max_side = max(240, min(2000, int(m.get("maxSide") or 1200)))
            r = await self.helper.call("screen %d %d" % (max_side, max(30, min(90, int(m.get("quality") or 62)))), timeout=20)
            left, top, width, height, cx, cy, data = r.split(" ")
            self.mouse["screen"] = {"left": int(left), "top": int(top), "width": int(width), "height": int(height)}
            return {**self.mouse["screen"], "cx": int(cx), "cy": int(cy), "mimeType": "image/jpeg", "data": data}
        raise ValueError("unknown input %s" % op)

    def comfy_state(self):
        out = {"queue": 0, "running": False, "latest": None}
        try:
            q = prompt_server().prompt_queue
            out["queue"] = int(q.get_tasks_remaining())
            cur = q.get_current_queue_volatile() if hasattr(q, "get_current_queue_volatile") else q.get_current_queue()
            out["running"] = bool(cur and cur[0])
            for pid, item in (q.get_history(max_items=1) or {}).items():
                for node_out in ((item or {}).get("outputs") or {}).values():
                    for im in (node_out or {}).get("images") or []:
                        if isinstance(im, dict) and im.get("filename"):
                            out["latest"] = {"filename": im["filename"], "subfolder": im.get("subfolder", ""),
                                             "type": im.get("type", "output"), "prompt": pid}
        except Exception as e:
            log.debug("comfy_state: %s", e)
        return out

    def status_msg(self):
        front = self.front_tab()
        apps = []
        if front:
            t = front[1]
            apps.append({"id": front[0], "name": "ComfyUI", "title": t.get("title", ""), "inFront": True, "canvas": True, "theme": t.get("theme", "")})
        comfy = self.comfy_state()
        comfy["progress"] = front[1].get("progress") if front else None
        ok, why = self.helper.status()
        return {"t": "status", "comfy": comfy, "apps": apps, "phones": len(self.phones), "version": VERSION, "input": ok, "inputWhy": why}

    def _poke(self):
        if self.loop:
            self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._broadcast()))

    async def _broadcast(self, force=False):
        m = self.status_msg()
        sig = json.dumps(m, sort_keys=True)
        if not force and sig == self.last_status:
            return
        self.last_status = sig
        for p in list(self.phones):
            await p.send(m)

    async def _status_loop(self):
        while True:
            await asyncio.sleep(1.0)
            if self.phones:
                await self._broadcast()

    # ------------------------------------------------------------------ keys
    def key_ok(self, k):
        return bool(self.key) and hmac.compare_digest(norm(k).encode(), norm(self.key).encode())

    def blocked(self, ip):
        m = self.misses.get(ip)
        return bool(m and m["until"] > time.time())

    def missed(self, ip):
        now = time.time()
        m = self.misses.get(ip) or {"n": 0, "first": now, "until": 0}
        if now - m["first"] > 600:
            m["n"], m["first"] = 0, now
        m["n"] += 1
        if m["n"] >= 8:
            m["until"] = now + 600
            say("too many wrong keys from", ip, "— blocked for 10 minutes")
        self.misses[ip] = m

    # ------------------------------------------------------------------ HTTP
    def _app(self):
        app = web.Application(client_max_size=64 * 1024)
        app.router.add_get("/health", self._health)
        app.router.add_get("/pair", self._pair)
        app.router.add_post("/pair/new-key", self._new_key)
        app.router.add_get("/ws", self._ws)
        app.router.add_get("/image", self._image)
        app.router.add_get("/{path:.*}", self._static)
        return app

    @staticmethod
    def _ip(request):
        return str(request.remote or "").replace("::ffff:", "")

    def _same_origin(self, request):
        origin = request.headers.get("Origin")
        if not origin:
            return True
        try:
            from urllib.parse import urlparse
            return urlparse(origin).netloc == request.host
        except Exception:
            return False

    async def _health(self, request):
        return web.json_response({"ok": True, "remote": VERSION, "phones": len(self.phones)}, headers=SECURITY)

    async def _static(self, request):
        rel = request.match_info.get("path") or "index.html"
        f = os.path.realpath(os.path.join(PHONE, rel))
        ext = os.path.splitext(f)[1].lower()
        if not f.startswith(os.path.realpath(PHONE) + os.sep) or ext not in TYPES or "/." in "/" + rel.replace("\\", "/") or not os.path.isfile(f):
            raise web.HTTPNotFound()
        with open(f, "rb") as fh:
            body = fh.read()
        return web.Response(body=body, headers={"Content-Type": TYPES[ext], **SECURITY})

    async def _image(self, request):
        """The latest image (or any ComfyUI output a phone names). The key comes in a header, never in the URL."""
        ip = self._ip(request)
        if self.blocked(ip):
            raise web.HTTPTooManyRequests()
        if not self.key_ok(request.headers.get("X-Remote-Key")):
            self.missed(ip)
            raise web.HTTPUnauthorized()
        import folder_paths
        kind = request.query.get("type", "output")
        if kind not in ("output", "temp", "input"):
            raise web.HTTPBadRequest()
        base = os.path.realpath(folder_paths.get_directory_by_type(kind))
        f = os.path.realpath(os.path.join(base, request.query.get("subfolder", ""), request.query.get("filename", "")))
        ext = os.path.splitext(f)[1].lower()
        if not f.startswith(base + os.sep) or ext not in IMAGE_TYPES or not os.path.isfile(f):
            raise web.HTTPNotFound()
        max_side = int(request.query.get("maxSide") or 0)
        if max_side:                                     # a lighter copy for the phone's screen
            try:
                from PIL import Image
                im = Image.open(f)
                im.thumbnail((max_side, max_side))
                buf = io.BytesIO()
                im.convert("RGB").save(buf, "JPEG", quality=86)
                return web.Response(body=buf.getvalue(), headers={"Content-Type": "image/jpeg", **SECURITY})
            except Exception:
                pass
        with open(f, "rb") as fh:
            return web.Response(body=fh.read(), headers={"Content-Type": IMAGE_TYPES[ext], **SECURITY})

    async def _new_key(self, request):
        if not is_loopback(self._ip(request)) or not self._same_origin(request):
            raise web.HTTPForbidden(text="Open /pair on the computer itself.")
        self.key = load_key(fresh=True)
        await self._close_phones()
        raise web.HTTPSeeOther("/pair")

    async def _pair(self, request):
        if not is_loopback(self._ip(request)):
            raise web.HTTPForbidden(text="Open /pair on the computer itself.")
        return web.Response(text=pair_page(self.key, self.port, lan_addresses()), headers={"Content-Type": "text/html; charset=utf-8", **SECURITY})

    async def _ws(self, request):
        ip = self._ip(request)
        if not self._same_origin(request):
            raise web.HTTPForbidden()
        if self.blocked(ip):
            raise web.HTTPTooManyRequests()
        if not self.key_ok(request.query.get("k")):
            self.missed(ip)
            raise web.HTTPUnauthorized()
        self.misses.pop(ip, None)
        ws = web.WebSocketResponse(max_msg_size=64 * 1024, heartbeat=15)
        await ws.prepare(request)
        ua = request.headers.get("User-Agent", "")
        name = "iPhone" if ("iPhone" in ua or "iPad" in ua) else "Android" if "Android" in ua else "browser"
        phone = Phone(self, ws, ip, name)
        self.phones.add(phone)
        say("📱 %s connected from %s (%d connected)" % (name, ip, len(self.phones)))
        await phone.send({**self.status_msg(), "t": "hello"})
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    m = json.loads(msg.data)
                except ValueError:
                    continue
                if not isinstance(m, dict):
                    continue
                if m.get("t") in ("pan", "zoom", "drag"):
                    phone.gesture(m)
                elif m.get("t") == "mouse":
                    self.mouse_move(m)
                elif m.get("t") == "ping":
                    await phone.send({"t": "pong", "at": m.get("at")})
                elif m.get("id") is not None:
                    asyncio.ensure_future(phone.request(m))
        finally:
            for b, p in list(self.mouse["held"].items()):      # let go of a mouse button this phone was holding
                if p is phone:
                    self.mouse["held"].pop(b, None)
                    try:
                        await self.helper.call("button %s up" % b)
                    except Exception:
                        pass
            if phone.dragging:                           # let go of a selection drag this phone had open
                phone.dragging = False
                try:
                    await self.call_tab("canvas_command", {"command": "moveSelection", "phase": "end"})
                except Exception:
                    pass
            self.phones.discard(phone)
            say("📱 %s (%s) left (%d connected)" % (name, ip, len(self.phones)))
        return ws


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;")


def pair_page(key, port, addrs):
    urls = ["http://%s:%s/#k=%s" % (a, port, norm(key)) for a in addrs]
    cards = "".join('<figure class="%s"><div class="qr" data-url="%s"></div><figcaption><b>%s</b><code>%s</code></figcaption></figure>'
                    % ("alt" if i else "", _esc(u), _esc(a), _esc(u)) for i, (a, u) in enumerate(zip(addrs, urls)))
    if not cards:
        cards = "<p>This computer has no network address right now. Connect it to the same Wi-Fi as the phone and reload this page.</p>"
    many = "More than one network address: try the first; the dimmer ones are other adapters." if len(addrs) > 1 else ""
    return """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair a phone · ComfyAF</title>
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#141518;color:#e9e9ec;display:grid;place-items:center;min-height:100vh}main{max-width:760px;padding:32px}h1{font-size:22px;margin:0 0 6px}p{color:#a4a7b0;margin:0 0 20px}
.grid{display:flex;flex-wrap:wrap;gap:20px}figure{margin:0;background:#1d1f24;border:1px solid #2c2f36;border-radius:14px;padding:16px;width:300px}figure.alt{opacity:.75}.qr svg{width:100%%;height:auto;border-radius:8px;display:block}
figcaption{margin-top:10px;font-size:13px}code{display:block;margin-top:6px;font-size:11px;color:#8b8f99;word-break:break-all}.key{font:600 20px ui-monospace,monospace;letter-spacing:.08em;color:#7cc4ff}
form{margin-top:22px}button{font:inherit;background:#2a2d34;color:#e9e9ec;border:1px solid #3a3e47;border-radius:10px;padding:8px 14px;cursor:pointer}button:hover{background:#343842}</style></head>
<body><main><h1>Pair your phone with ComfyAF</h1>
<p>Phone on the same Wi-Fi as this computer → open the camera → scan. Or open the address on the phone and type the key <span class="key">%(key)s</span>. %(many)s</p>
<div class="grid">%(cards)s</div>
<p style="margin-top:22px">Nothing loads on the phone? Windows may be blocking port %(port)s: allow Python on <b>Private networks</b> when Windows asks, or run <code style="display:inline">netsh advfirewall firewall add rule name="ComfyAF" dir=in action=allow protocol=TCP localport=%(port)s profile=private</code> in an admin terminal.</p>
<form method="post" action="/pair/new-key" onsubmit="return confirm('Make a new key? Every phone paired before will have to scan again.')"><button type="submit">New key — un-pair every phone</button></form>
</main>
<script src="/vendor/qrcode.js"></script>
<script>
for (const el of document.querySelectorAll('.qr')) {
  const q = qrcode(0, 'M'); q.addData(el.dataset.url); q.make();
  const n = q.getModuleCount(), m = 4, c = 6, size = (n + m * 2) * c; let d = '';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) d += 'M' + (k + m) * c + ',' + (r + m) * c + 'h' + c + 'v' + c + 'h-' + c + 'z';
  el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="QR code"><rect width="100%%" height="100%%" fill="#fff"/><path d="' + d + '" fill="#111"/></svg>';
}
</script></body></html>""" % {"key": _esc(key), "many": many, "cards": cards, "port": int(port)}


REMOTE = Remote()


def register_routes():
    """ComfyUI's own server: the ComfyUI page turns the remote on/off, says it is there, and answers calls."""
    try:
        ps = prompt_server()
    except Exception as e:                                # not inside ComfyUI
        log.debug("no PromptServer: %s", e)
        return
    routes = ps.routes

    @routes.get("/comfyaf/remote")
    async def _info(request):
        return web.json_response(REMOTE.info())

    @routes.post("/comfyaf/remote")
    async def _switch(request):
        d = await request.json()
        loop = asyncio.get_event_loop()
        if "input" in d:
            REMOTE.set_input(d.get("input"))
        if d.get("on"):
            info = await loop.run_in_executor(None, REMOTE.start, d.get("port") or DEFAULT_PORT)
        else:
            info = await loop.run_in_executor(None, REMOTE.stop)
        return web.json_response(info)

    @routes.get("/comfyaf/pair-info")
    async def _pair_info(request):
        """For ComfyAF's side panel: the key and the addresses for the QR code. On the computer itself only,
        like the /pair page (ComfyUI may be reachable from elsewhere with --listen)."""
        if not is_loopback(str(request.remote or "")):
            return web.json_response({"local": False, **REMOTE.info()})
        if not REMOTE.running:
            return web.json_response({"local": True, **REMOTE.info()})
        addrs = lan_addresses()
        return web.json_response({"local": True, **REMOTE.info(), "key": REMOTE.key,
                                  "urls": [{"address": a, "url": "http://%s:%s/#k=%s" % (a, REMOTE.port, norm(REMOTE.key))} for a in addrs]})

    @routes.post("/comfyaf/new-key")
    async def _new_key(request):
        if not is_loopback(str(request.remote or "")):
            return web.json_response({"ok": False, "error": "On the computer itself only."}, status=403)
        REMOTE.key = load_key(fresh=True)
        if REMOTE.loop:
            asyncio.run_coroutine_threadsafe(REMOTE._close_phones(), REMOTE.loop)
        return web.json_response({"ok": True})

    @routes.post("/comfyaf/tab")
    async def _tab(request):
        REMOTE.on_tab(await request.json())
        return web.json_response({"ok": True, "on": REMOTE.running})

    @routes.post("/comfyaf/reply")
    async def _reply(request):
        REMOTE.on_reply(await request.json())
        return web.json_response({"ok": True})
