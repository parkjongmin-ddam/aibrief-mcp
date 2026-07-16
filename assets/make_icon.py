"""Render the aibrief MCP icon to PNG (RGBA, transparent rounded corners)."""
import math
from PIL import Image, ImageDraw

S = 512          # canvas
SS = 4           # supersample factor for smooth edges
W = S * SS
R = 112 * SS     # corner radius

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

C0 = (0x63, 0x66, 0xF1)   # indigo
C1 = (0x8B, 0x5C, 0xF6)   # violet

# --- diagonal gradient background ---
bg = Image.new("RGB", (W, W))
px = bg.load()
for y in range(W):
    for x in range(W):
        t = (x + y) / (2 * W)
        px[x, y] = lerp(C0, C1, t)

# rounded-square alpha mask
mask = Image.new("L", (W, W), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, W - 1, W - 1], radius=R, fill=255)

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
img.paste(bg, (0, 0), mask)

d = ImageDraw.Draw(img)
def s(v):  # scale helper
    return v * SS

# --- briefing card ---
d.rounded_rectangle([s(130), s(150), s(382), s(402)], radius=s(34), fill=(255, 255, 255, 255))

# --- summary lines ---
d.rounded_rectangle([s(170), s(212), s(342), s(236)], radius=s(12), fill=(0x63, 0x66, 0xF1, 255))
d.rounded_rectangle([s(170), s(266), s(342), s(286)], radius=s(10), fill=(0xC7, 0xCB, 0xF5, 255))
d.rounded_rectangle([s(170), s(312), s(282), s(332)], radius=s(10), fill=(0xC7, 0xCB, 0xF5, 255))

# --- AI sparkle (4-point star) ---
def star(cx, cy, outer, inner):
    pts = []
    for i in range(8):
        ang = math.pi / 2 * i / 2 - math.pi / 2  # start at top
        rad = outer if i % 2 == 0 else inner
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    return pts

cx, cy = s(382), s(174)
outer, inner = s(64), s(26)
# white outline underneath
d.polygon(star(cx, cy, outer + s(5), inner + s(4)), fill=(255, 255, 255, 255))
d.polygon(star(cx, cy, outer, inner), fill=(0xFB, 0xBF, 0x24, 255))

# downsample
out = img.resize((S, S), Image.LANCZOS)
out.save("C:/Project/aibrief/aibrief-mcp/assets/icon.png")
# also a 128 preview
out.resize((128, 128), Image.LANCZOS).save("C:/Project/aibrief/aibrief-mcp/assets/icon-128.png")
print("saved icon.png (512) and icon-128.png")
