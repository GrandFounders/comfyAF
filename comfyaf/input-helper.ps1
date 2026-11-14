# ComfyAF input helper (Windows) - the phone's mouse, keyboard and screen picture. Copied from KcadaBRA _EcoComs/EcoRemote/input-helper.ps1 (2026-11-10).
#
# Started by remote.py only when a phone first uses Mouse mode or the keyboard. Reads one command per
# line on stdin and answers one line on stdout:   <id> <command> <args...>   ->   <id> ok <data>  |  <id> err <message>
#
#   move dx dy            move the cursor by (dx, dy) screen pixels (clamped to the desktop)
#   moveto x y            put the cursor at (x, y) desktop pixels
#   button left|right|middle down|up|click|dbl
#   wheel dy [dx]         scroll (120 = one notch; dx scrolls sideways)
#   text <base64 utf-8>   type the text (any language; newlines press Enter)
#   key <vk> [mods]       press one key, mods = ctrl,shift,alt,win (comma separated, or -)
#   screen <maxSide> <quality>   JPEG of the screen the cursor is on, cursor drawn in
#                                -> "<left> <top> <width> <height> <cursorX> <cursorY> <base64>"
#   pos                   -> "<cursorX> <cursorY>"
#
# Windows will not deliver this input to windows running as administrator, nor to the lock screen.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public static class EcoInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOVE = 0x1, LDOWN = 0x2, LUP = 0x4, RDOWN = 0x8, RUP = 0x10, MDOWN = 0x20, MUP = 0x40, WHEEL = 0x800, HWHEEL = 0x1000;
  const uint KEYUP = 0x2, UNICODE = 0x4, EXTENDED = 0x1;

  public static void Init() { try { SetProcessDPIAware(); } catch { } }

  static void Send(params INPUT[] list) {
    if (list.Length == 0) return;
    uint sent = SendInput((uint)list.Length, list, Marshal.SizeOf(typeof(INPUT)));
    if (sent == 0) throw new Exception("Windows refused the input (error " + Marshal.GetLastWin32Error() + ") - an administrator window or the lock screen is in front?");
  }
  static INPUT Mouse(uint flags, int data) { var i = new INPUT { type = INPUT_MOUSE }; i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data); return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT { type = INPUT_KEYBOARD }; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }

  static Rectangle Desktop() {   // the whole virtual desktop (every monitor)
    return new Rectangle(GetSystemMetrics(76), GetSystemMetrics(77), Math.Max(1, GetSystemMetrics(78)), Math.Max(1, GetSystemMetrics(79)));
  }
  static void MoveTo(int x, int y) {
    var d = Desktop();
    x = Math.Max(d.Left, Math.Min(d.Right - 1, x));
    y = Math.Max(d.Top, Math.Min(d.Bottom - 1, y));
    SetCursorPos(x, y);
    Send(Mouse(MOVE, 0));        // a real mouse-move message, so drags and hovers follow
  }

  static readonly ushort[] ExtendedKeys = { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x6F, 0x90 };
  static void PressKey(ushort vk, string mods) {
    var mvk = (mods ?? "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries).Select(m => {
      switch (m.Trim().ToLowerInvariant()) { case "ctrl": return (ushort)0x11; case "shift": return (ushort)0x10; case "alt": return (ushort)0x12; case "win": return (ushort)0x5B; default: return (ushort)0; }
    }).Where(v => v != 0).ToArray();
    uint ext = ExtendedKeys.Contains(vk) ? EXTENDED : 0;
    var list = mvk.Select(m => Key(m, 0, m == 0x5B ? EXTENDED : 0)).ToList();
    list.Add(Key(vk, 0, ext)); list.Add(Key(vk, 0, ext | KEYUP));
    list.AddRange(mvk.Reverse().Select(m => Key(m, 0, (m == 0x5B ? EXTENDED : 0) | KEYUP)));
    Send(list.ToArray());
  }
  static void TypeText(string s) {
    var list = new System.Collections.Generic.List<INPUT>();
    foreach (char c in s.Replace("\r\n", "\n")) {
      if (c == '\n' || c == '\r') { Send(list.ToArray()); list.Clear(); PressKey(0x0D, null); continue; }
      if (c == '\t') { Send(list.ToArray()); list.Clear(); PressKey(0x09, null); continue; }
      list.Add(Key(0, c, UNICODE)); list.Add(Key(0, c, UNICODE | KEYUP));   // surrogate pairs go as two units, which Windows joins
    }
    Send(list.ToArray());
  }

  static string Capture(int maxSide, long quality) {
    POINT p; GetCursorPos(out p);
    var b = System.Windows.Forms.Screen.FromPoint(new Point(p.X, p.Y)).Bounds;
    using (var full = new Bitmap(b.Width, b.Height, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(full)) g.CopyFromScreen(b.Left, b.Top, 0, 0, b.Size, CopyPixelOperation.SourceCopy);
      double k = Math.Min(1.0, (double)maxSide / Math.Max(b.Width, b.Height));
      int w = Math.Max(1, (int)Math.Round(b.Width * k)), h = Math.Max(1, (int)Math.Round(b.Height * k));
      using (var small = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
        using (var g = Graphics.FromImage(small)) {
          g.InterpolationMode = InterpolationMode.HighQualityBilinear;
          g.DrawImage(full, 0, 0, w, h);
          g.SmoothingMode = SmoothingMode.AntiAlias;   // the cursor (CopyFromScreen leaves it out)
          float cx = (float)((p.X - b.Left) * k), cy = (float)((p.Y - b.Top) * k);
          var arrow = new[] { new PointF(cx, cy), new PointF(cx, cy + 17), new PointF(cx + 4.5f, cy + 13), new PointF(cx + 8, cy + 20), new PointF(cx + 11, cy + 18.5f), new PointF(cx + 7.5f, cy + 12), new PointF(cx + 13, cy + 12) };
          using (var white = new Pen(Color.White, 2.2f)) { g.FillPolygon(Brushes.Black, arrow); g.DrawPolygon(white, arrow); }
        }
        var enc = ImageCodecInfo.GetImageEncoders().First(e => e.MimeType == "image/jpeg");
        var ps = new EncoderParameters(1); ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        using (var ms = new MemoryStream()) {
          small.Save(ms, enc, ps);
          return b.Left + " " + b.Top + " " + b.Width + " " + b.Height + " " + p.X + " " + p.Y + " " + Convert.ToBase64String(ms.ToArray());
        }
      }
    }
  }

  public static string Run(string[] a) {
    POINT p;
    switch (a[1]) {
      case "move": GetCursorPos(out p); MoveTo(p.X + int.Parse(a[2]), p.Y + int.Parse(a[3])); return "";
      case "moveto": MoveTo(int.Parse(a[2]), int.Parse(a[3])); return "";
      case "pos": GetCursorPos(out p); return p.X + " " + p.Y;
      case "button": {
        uint dn = a[2] == "right" ? RDOWN : a[2] == "middle" ? MDOWN : LDOWN, up = a[2] == "right" ? RUP : a[2] == "middle" ? MUP : LUP;
        switch (a[3]) {
          case "down": Send(Mouse(dn, 0)); break;
          case "up": Send(Mouse(up, 0)); break;
          case "dbl": Send(Mouse(dn, 0), Mouse(up, 0), Mouse(dn, 0), Mouse(up, 0)); break;
          default: Send(Mouse(dn, 0), Mouse(up, 0)); break;
        }
        return "";
      }
      case "wheel": {
        int dy = int.Parse(a[2]), dx = a.Length > 3 ? int.Parse(a[3]) : 0;
        if (dy != 0) Send(Mouse(WHEEL, dy));
        if (dx != 0) Send(Mouse(HWHEEL, dx));
        return "";
      }
      case "text": TypeText(Encoding.UTF8.GetString(Convert.FromBase64String(a[2]))); return "";
      case "key": PressKey((ushort)int.Parse(a[2]), a.Length > 3 && a[3] != "-" ? a[3] : null); return "";
      case "screen": return Capture(a.Length > 2 ? int.Parse(a[2]) : 1280, a.Length > 3 ? long.Parse(a[3]) : 60L);
      default: throw new Exception("unknown command " + a[1]);
    }
  }
}
'@

[EcoInput]::Init()
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim().Split(' ')
  if ($parts.Length -lt 2) { continue }
  try { $r = [EcoInput]::Run($parts); [Console]::Out.WriteLine($parts[0] + ' ok ' + $r) }
  catch { $m = $_.Exception.Message; if ($_.Exception.InnerException) { $m = $_.Exception.InnerException.Message }; [Console]::Out.WriteLine($parts[0] + ' err ' + ($m -replace '\s+', ' ')) }
  [Console]::Out.Flush()
}
