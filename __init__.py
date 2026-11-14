"""ComfyAF (2026-11-13) — CanvasAssist and a phone remote for ComfyUI, from the KCadabra workspace OS.

  · CanvasAssist (web/canvas-assist.js): hover-zoom, edge scroll and circle to zoom (with a faint ring).
  · The phone remote (comfyaf/remote.py + web/phone-remote.js + phone/): pan, pinch, fit, undo, move the
    selected nodes, Queue, Cancel, progress and the latest image, from a phone on the same Wi-Fi.
    OFF until turned on in Settings › ComfyAF; it then listens on its own port (8796) with a pairing key.

No nodes of its own. Settings › ComfyAF turns each part on or off.
"""
from .comfyaf import remote as _remote

_remote.register_routes()

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
