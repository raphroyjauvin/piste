r"""Image-trace the classic-ride photos into flat clear-line illustrations (review mock-up; nothing in the app uses the output yet).

Usage (numpy + Pillow only):  C:\bikeapp\.venv\Scripts\python.exe tools\photo_trace.py
Reads prototypes/shared/photos/*.jpg (never modified), writes prototypes/shared/photos-trace/<variant>/<id>.png
and one review sheet per variant: prototypes/shared/photos-trace/review_<variant>.png

Method: grey -> gaussian blur -> luminance quantiles -> 3 or 4 palette fills -> mode filter (flat regions, specks gone)
-> fine navy lines where the label map changes AND the blurred Sobel gradient is strong, thinned (non-max suppression)
and cleaned of short bits. Works at 2x so lines stay hairline-fine.
"""
import json, pathlib, numpy as np
from PIL import Image, ImageFilter, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent / "prototypes" / "shared"
SRC, OUT = ROOT / "photos", ROOT / "photos-trace"
H = lambda s: tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))
PAPER, PAPER_W, TEAL, NAVY2, NAVY, AMBER, SKY = map(H, ["#f5f0e4", "#fffdf8", "#8fcfbd", "#3d43a8", "#1e2160", "#ffb000", "#bfe0ea"])
# the app orange #ff6a1f pulled most of the way to grey-paper: used only where the photo was warm and saturated (brick, roofs, doors, autumn leaves, sand)
WARM = H("#c9a691")
WARM_MAX = 0.10   # warm regions never cover more than 10 % of a picture

VARIANTS = {
    # (the first two, without the warm colour, were the first review round; the "+warm" pair is the current one)
    # 3 colours, light linework: calm and airy
    "v1_3col_light": dict(ramp=[PAPER, TEAL, NAVY2], cuts=[0.38, 0.72], blur=2.0, mode=9, line_pct=92, line_w=2, minnb=8),
    # 4 colours, denser linework: more depth, more drawing
    "v2_4col_dense": dict(ramp=[PAPER, SKY, TEAL, NAVY2], cuts=[0.24, 0.50, 0.78], blur=1.6, mode=7, line_pct=85, line_w=2, minnb=5),
}
VARIANTS = {k + "_warm": dict(v, warm=True) for k, v in VARIANTS.items()}

def warm_mask(im, lab):
    """pixels that were warm (red to yellow-orange) and fairly saturated in the photo, smoothed into flat blobs, capped at WARM_MAX of the picture"""
    hsv = np.asarray(im.filter(ImageFilter.GaussianBlur(3)).convert("HSV"), dtype=np.float32)
    h, sat, val = hsv[..., 0] * 360 / 255, hsv[..., 1] / 255, hsv[..., 2] / 255
    hue_ok = (h <= 42) | (h >= 345)
    for thr in np.arange(0.30, 0.90, 0.05):
        m = hue_ok & (sat > thr) & (val > 0.28) & (val < 0.97)
        mi = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(9)).filter(ImageFilter.ModeFilter(9))
        m = np.asarray(mi) > 127
        m &= box(m.astype(np.float32), 25) > 0.25 * 625      # drop small specks
        if m.mean() <= WARM_MAX: break
    return m

def sobel(a):
    p = np.pad(a, 1, mode="edge")
    gx = (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    gy = (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    return gx, gy

def box(a, k):
    c = np.cumsum(np.cumsum(np.pad(a, ((k // 2 + 1, k // 2), (k // 2 + 1, k // 2))), 0), 1)
    return c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]

def trace(img, v):
    im = img.convert("RGB").resize((img.width * 2, img.height * 2), Image.LANCZOS)
    g = im.convert("L").filter(ImageFilter.GaussianBlur(v["blur"] * 2)).filter(ImageFilter.MedianFilter(5))
    a = np.asarray(g, dtype=np.float32)
    lo, hi = np.percentile(a, 2), np.percentile(a, 98)
    a = (a - lo) / (hi - lo + 1e-6)
    # dark = high index: invert so the darkest regions take the strongest colour
    lum = 1 - np.clip(a, 0, 1)
    lab = np.digitize(lum, np.quantile(lum, v["cuts"])).astype(np.uint8)
    L = Image.fromarray(lab * 40)
    L = L.filter(ImageFilter.MedianFilter(v["mode"] - (v["mode"] % 2 == 0))).filter(ImageFilter.ModeFilter(5))
    lab = (np.asarray(L) // 40).astype(np.uint8)
    ramp = v["ramp"]
    out = np.zeros(lab.shape + (3,), np.uint8)
    for i, c in enumerate(ramp): out[lab == i] = c
    # fine navy lines: region borders confirmed by real image edges
    s = np.asarray(g.filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float32)
    gx, gy = sobel(s); mag = np.hypot(gx, gy)
    ang = (np.degrees(np.arctan2(gy, gx)) + 180) % 180
    p = np.pad(mag, 1)
    def nb(dy, dx): return p[1 + dy:1 + dy + mag.shape[0], 1 + dx:1 + dx + mag.shape[1]]
    n1 = np.where((ang < 22.5) | (ang >= 157.5), np.maximum(nb(0, 1), nb(0, -1)),
         np.where(ang < 67.5, np.maximum(nb(1, 1), nb(-1, -1)),
         np.where(ang < 112.5, np.maximum(nb(1, 0), nb(-1, 0)), np.maximum(nb(1, -1), nb(-1, 1)))))
    thin = (mag >= n1) & (mag > np.percentile(mag, v["line_pct"]))
    # also draw region borders (where the flat fill changes) so shapes are outlined cleanly
    border = np.zeros_like(thin)
    border[:-1] |= lab[:-1] != lab[1:]; border[:, :-1] |= lab[:, :-1] != lab[:, 1:]
    near_edge = box(thin.astype(np.float32), 5) > 0
    lines = thin | (border & near_edge)
    lines &= box(lines.astype(np.float32), 9) >= v["minnb"]      # drop isolated specks and tiny scribbles
    lines[:2] = lines[-2:] = False; lines[:, :2] = lines[:, -2:] = False
    lm = Image.fromarray((lines * 255).astype(np.uint8))
    if v["line_w"] > 1: lm = lm.filter(ImageFilter.MaxFilter(3))
    if v.get("warm"):
        wm = warm_mask(im, lab)
        out[wm] = WARM
    res = Image.fromarray(out)
    res.paste(Image.new("RGB", res.size, NAVY), mask=lm)
    return res

def font(sz, bold=False):
    for f in (["arialbd.ttf"] if bold else []) + ["arial.ttf", "segoeui.ttf"]:
        try: return ImageFont.truetype(f, sz)
        except OSError: pass
    return ImageFont.load_default()

def card_top(img, w=320, h=112):
    """the top of a classic card at 2x: the picture (cover, centre 38%) fading to paper white at the bottom, as .cc-photo::after does"""
    W, Hh = w * 2, h * 2
    if img.width > 1200: img = img.resize((img.width // 2, img.height // 2), Image.LANCZOS)   # the 2x trace, back to photo size
    sc = max(W / img.width, Hh / img.height)
    r = img.resize((round(img.width * sc), round(img.height * sc)), Image.LANCZOS)
    y0 = round((r.height - Hh) * 0.38); x0 = (r.width - W) // 2
    c = r.crop((x0, y0, x0 + W, y0 + Hh)).convert("RGB")
    t = np.linspace(0, 1, Hh)[:, None, None]
    alpha = np.interp(t, [0, .5, 1], [.12, .3, 1.0])
    base = np.asarray(c, np.float32); white = np.array(PAPER_W, np.float32)
    mixed = base * (1 - alpha) + white * alpha
    mixed += np.random.default_rng(1).uniform(-0.5, 0.5, mixed.shape[:2])[..., None]   # dither: flat fills times a gradient would band in 8 bits
    return Image.fromarray(np.clip(np.rint(mixed), 0, 255).astype(np.uint8))

def main():
    ids = [p.stem for p in sorted(SRC.glob("*.jpg"))]
    credits = {}
    for name, v in VARIANTS.items():
        d = OUT / name; d.mkdir(parents=True, exist_ok=True)
        rows = []
        for i in ids:
            o = Image.open(SRC / f"{i}.jpg"); t = trace(o, v)
            t.save(d / f"{i}.png", optimize=True)
            rows.append((i, o, t))
        pw, ph, gap, lab = 640, 240, 24, 40
        cw, ch = 640, 224
        W = pw * 2 + cw * 2 + gap * 5
        Hs = 90 + len(rows) * (ph + gap)
        sheet = Image.new("RGB", (W, Hs), PAPER)
        dr = ImageDraw.Draw(sheet)
        dr.text((gap, 20), f"Classic rides, image trace: {name}", fill=NAVY, font=font(30, True))
        dr.text((gap, 58), "original | traced | card top today | card top traced, fade to paper white" + ("   warm accent:" if v.get("warm") else ""), fill=NAVY2, font=font(18))
        if v.get("warm"): dr.rectangle([gap + 860, 56, gap + 900, 80], fill=WARM, outline=NAVY); dr.text((gap + 910, 58), "#c9a691", fill=NAVY, font=font(18))
        y = 90
        for i, o, t in rows:
            x = gap
            for im in (o, t):
                sheet.paste(im.convert("RGB").resize((pw, ph), Image.LANCZOS), (x, y)); x += pw + gap
            for im in (o, t):
                ct = card_top(im)
                ct = ct.resize((cw, ch), Image.LANCZOS) if ct.size != (cw, ch) else ct
                sheet.paste(ct, (x, y + (ph - ch) // 2)); dr.rectangle([x, y + (ph - ch) // 2, x + cw - 1, y + (ph - ch) // 2 + ch - 1], outline=(226, 218, 200)); x += cw + gap
            dr.text((gap + 8, y + 8), i, fill=NAVY, font=font(20, True))
            y += ph + gap
        sheet.save(OUT / f"review_{name}.png", optimize=True)
        print("wrote", OUT / f"review_{name}.png")

if __name__ == "__main__":
    main()
