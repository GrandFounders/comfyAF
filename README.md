# ComfyAF

Navigation aids for ComfyUI's canvas, from the **KCadabra** workspace OS.

Two parts. **CanvasAssist**:

- **Hover-zoom.** Rest the mouse on a node that is small on screen and the view glides toward it. Rest on empty canvas (or click empty canvas when you're done with the node) and the view goes back to where you had it.
- **Edge scroll.** Rest the mouse near an edge of the canvas (without dragging anything) and the view scrolls that way.
- **Circle to zoom.** Circle the mouse over an area: clockwise zooms in there, anticlockwise zooms out. A faint ring in the middle of the circle shows the gesture: it fills as you turn, blue **+** for zooming in, gold **−** for zooming out. It never grows past 30 px.

And the **phone remote**: drive ComfyUI from a phone on the same Wi-Fi. See "Phone remote" below.

## Install

1. Copy (or link) this `ComfyAF` folder into `ComfyUI/custom_nodes/`.
2. Restart ComfyUI and reload the page.

It adds no nodes and needs no extra Python packages (it uses ComfyUI's own aiohttp and Pillow).

## Settings

**Settings › ComfyAF › CanvasAssist** turns each part on or off:

- all of it
- hover-zoom, its wait (ms) and its largest zoom
- circle to zoom, the ring, and an "invert" switch
- edge scroll
- selection box past the edge (off by default)

Everything else is on by default.

Dragging a node or a wire against an edge is ComfyUI's own **Auto-pan** (Settings › LiteGraph › Auto-pan speed), so ComfyAF leaves that alone. The one extra switch covers a selection box, in case your ComfyUI doesn't scroll for it.

## Phone remote

**The ComfyAF panel** (📱 in ComfyUI's left bar) has everything: the on/off switch, the QR code, the address and the key, how many phones are connected, **New key**, and the mouse-and-keyboard switch. The same switches are in Settings › ComfyAF › Phone remote, and Extensions › ComfyAF › **Pair a phone…** turns the remote on and opens the panel.

It is off by default: nothing listens on your network until you turn it on.

**Pair a phone:** scan the QR code in the panel with the phone's camera, or open the address on the phone and type the key. The QR code shows on the computer running ComfyUI only. The phone remembers the key; next time just open the page. Add it to the home screen for a full-screen remote.

On the phone:

| Gesture / button | Does |
|---|---|
| one-finger drag | pan the graph, **or, with nodes selected, move them** (one undo step per drag) |
| two-finger pinch | zoom around your fingers |
| double-tap | fit everything |
| hold | clear the selection |
| tap the **preview** | select the node under your finger |
| drag / pinch the preview | move it (it snaps to a corner) / resize it |
| **Queue** | queue the workflow open on the computer (the badge counts what's waiting) |
| **Cancel** | stop the run |
| **Latest** | the newest image ComfyUI made, full screen; ⇩ saves the file itself (a PNG keeps its workflow) |
| Undo · Redo · Fit · 100% | the bottom strip |
| **Select** | **Mouse mode**: the pad becomes the computer's real mouse, for the whole screen (below) |
| **Hand** | back to driving ComfyUI's graph with the pad |
| ⌨ | the keyboard (below) |
| ☰ | modes Graph · Mouse · Keys, then ComfyUI, Graph, Move, This computer, and Settings |
| ⚙ | theme (follows ComfyUI's light/dark), pan speed, mouse speed, glide, reverse direction, preview, vibration, forget this computer |

**Mouse mode and the keyboard (Windows)**, as in EcoRemote. For what the graph tools can't reach (a text field, a dialog, another program), the phone moves the computer's **real** mouse and types with its **real** keyboard (`comfyaf/input-helper.ps1`: Windows PowerShell + `SendInput`, started on first use, nothing to install).

- Turn it on first: **Let the phone use the mouse and keyboard** in the ComfyAF panel (or Settings). It is off by default, because it is the whole computer, not just ComfyUI.
- **Tap Select** (or ☰ → Mouse). **Tap Hand** to drive the graph again. The preview shows the **screen** the cursor is on, with the cursor; tap the preview to jump the cursor there.
- On the pad: move a finger = move the mouse (faster flicks go further) · tap = click · tap, then drag = drag · tap-tap = double-click · two-finger tap = right-click · two fingers = scroll. The bottom row becomes Left · Right · Double · Middle (hold one to keep it pressed).
- **⌨** opens the phone keyboard; what you type goes to the window in front on the computer. Keys: Esc, Tab, ⌫, Del, ⏎, arrows, Home, End; Ctrl / Shift / Alt / Win stay on for the next key; Copy, Paste, Cut, All, Undo.
- Windows does not let it into windows running **as administrator**, nor the lock screen. A phone that disconnects lets go of any button it held.

A thin bar on the pad shows the progress of a run; the top line says what is running.

**How it is safe**

- It listens on its **own port (8796)**, not ComfyUI's. ComfyUI itself can stay on 127.0.0.1.
- **Pairing key** in `.remote-key` (made on first start). **New key** on the pair page un-pairs every phone.
- 8 wrong keys from one address → that address waits 10 minutes.
- Same-origin only: another web page on the phone can't drive ComfyUI.
- The pair page opens on the computer itself only.
- A phone can do the list above and nothing else: no files, no nodes' settings. With **mouse and keyboard** on, it can click and type anywhere on the computer: keep the key to yourself, and use **New key** to un-pair every phone.
- Plain http on your LAN: anyone on the same Wi-Fi **with the key** can use it. Use it on your own network.

**Windows firewall:** the first start may ask whether Python may use the network. Allow **Private networks**. If the phone can't load the page, run once in an admin terminal:
`netsh advfirewall firewall add rule name="ComfyAF" dir=in action=allow protocol=TCP localport=8796 profile=private`

**Options:** the port is in Settings. Environment: `COMFYAF_ADDRESS` (the address put in the QR code, when it picks the wrong adapter), `COMFYAF_HOST` (`127.0.0.1` to test on the computer only), `COMFYAF_KEY`.


## For developers

- `web/canvas-assist.js`: CanvasAssist on ComfyUI's LiteGraph canvas. `web/lib/canvas_assist.js` and `web/lib/snapping.js` are copies from KcadaBRA `_EcoCore/jsCANVAS`. Copy them again after changing them there.
- `comfyaf/remote.py`: the phone remote's server, ported from KcadaBRA `_EcoComs/EcoRemote/server.mjs`. Same pairing, rate limit, same-origin and gesture merging; no relay, no Mouse mode or keyboard. It runs on its own thread and loop.
- `web/phone-remote.js`: ComfyUI's side. It answers the server's calls with the same tool names hostKit's `agentlink.js` uses (`canvas_state`, `canvas_command`, `canvas_select`, `canvas_snapshot`), so the phone page is EcoRemote's.
- `phone/`: EcoRemote's phone page (`public/` there), with Mouse mode and the keyboard, trimmed to ComfyUI: no app picker, plugin menus, Panel mode or drawing tools; added ComfyUI's buttons (`js/comfy.js`). `comfyaf/input-helper.ps1` is EcoRemote's.
- `web/lib/qrcode.js`: qrcode-generator as a module, for the side panel's QR code. `phone/vendor/` holds copies of KcadaBRA `hostKit` (shell drawer, dialogs and their CSS) and qrcode-generator 1.4.4 (MIT, Kazuhiko Arase).

## License

This project is licensed under the GNU General Public License v3.0. 


