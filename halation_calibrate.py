"""halation_calibrate.py - measure the halation ring in real film scans (or in script output).

For each image: find clipped light sources (all channels >= --core), then take rings of pixels at
increasing distance from those sources and record mean R, G, B per ring. Halation shows up as red
excess (R - (G+B)/2) and R/G above the far-field level within about 1% of the long edge.

  python halation_calibrate.py path/to/scans            # one folder, grouped by stock in the filename (800T, 400D, 500T, XX)
  python halation_calibrate.py out1.jpg out2.jpg --label "v2 800t"             # script output, one group
  python halation_calibrate.py folder --json profile.json                     # keep per-frame numbers

Frames are also classed by scene: "point" = clipped sources cover < 1.5% of the frame and the frame is
dark (median L < 45): hard lights against dark. "area" = everything else (daylight, big bright areas,
no sources). The two behave differently and presets are tuned per class. Only needs Pillow + numpy.
"""
import argparse, glob, json, os, re, sys
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None

LONG = 1600                                        # analysis size (long edge, px)
STEPS = [2, 3, 5, 6, 10, 13, 16, 21, 26, 32, 40, 48, 64]   # ring outer radii in px at LONG
PCT = [100 * r / LONG for r in STEPS]


def load(path, long_edge=LONG):
    im = Image.open(path)
    try: im.draft("RGB", (long_edge * 2, long_edge * 2))
    except Exception: pass
    im = im.convert("RGB"); s = long_edge / max(im.size)
    if s < 1: im = im.resize((round(im.width * s), round(im.height * s)), Image.BILINEAR, reducing_gap=2.0)
    return im


def dilate(mask, r):
    """Square dilation by r px via 2-D cumulative sums."""
    m = mask.astype(np.int32); p = np.pad(m, r)
    c = np.pad(p.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    h, w = m.shape; k = 2 * r + 1
    return (c[k:k + h, k:k + w] - c[:h, k:k + w] - c[k:k + h, :w] + c[:h, :w]) > 0


def count_blobs(mask, max_px=400):
    """Connected clipped blobs at reduced size (4-connectivity, iterative)."""
    st = max(1, max(mask.shape) // max_px)
    m = mask[::st, ::st].copy(); n = 0
    h, w = m.shape
    for y in range(h):
        for x in range(w):
            if not m[y, x]: continue
            n += 1; stack = [(y, x)]; m[y, x] = False
            while stack:
                cy, cx = stack.pop()
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if 0 <= ny < h and 0 <= nx < w and m[ny, nx]:
                        m[ny, nx] = False; stack.append((ny, nx))
    return n


def profile(im, core=242):
    a = np.asarray(im).astype(np.float32)
    mask = a.min(axis=2) >= core
    frac = float(mask.mean())
    L50 = float(np.median(a.mean(axis=2)))
    out = {"core_frac": frac, "L50": L50, "blobs": count_blobs(mask) if frac > 0 else 0, "rings": []}
    if frac < 0.0002 or frac > 0.06:
        out["rings"] = None; return out
    prev = mask
    for r in STEPS:
        d = dilate(mask, r); ring = d & ~prev; prev = d
        px = a[ring]; px = px[px.min(axis=1) < 235] if len(px) else px
        out["rings"].append(px.mean(axis=0).tolist() if len(px) >= 50 else None)
    far = ~dilate(mask, 120)
    out["bg"] = a[far].mean(axis=0).tolist() if far.sum() > 1000 else None
    out["scene"] = "point" if (frac < 0.015 and L50 < 45) else "area"
    return out


def summarize(label, profs):
    profs = [p for p in profs if p and p.get("rings")]
    if not profs:
        print(f"\n{label}: no frames with usable sources"); return None
    arr = np.array([[r if r else [np.nan] * 3 for r in p["rings"]] for p in profs])
    R, G, B = (np.nanmedian(arr[..., i], axis=0) for i in range(3))
    bg = np.nanmedian(np.array([p["bg"] if p.get("bg") else [np.nan] * 3 for p in profs]), axis=0)
    print(f"\n{label}: {len(profs)} frames")
    print(f"  {'dist (% long edge)':>22s} " + " ".join(f"{v:5.1f}" for v in PCT))
    print(f"  {'R/G':>22s} " + " ".join(f"{v:5.2f}" for v in R / np.maximum(G, 1)))
    print(f"  {'red excess':>22s} " + " ".join(f"{v:5.0f}" for v in R - (G + B) / 2))
    print(f"  {'ring luminance':>22s} " + " ".join(f"{v:5.0f}" for v in (R + G + B) / 3))
    print(f"  far field: R/G {bg[0] / max(bg[1], 1):.2f}, red excess {bg[0] - (bg[1] + bg[2]) / 2:+.0f}, level {bg.mean():.0f}")
    return {"R": R.tolist(), "G": G.tolist(), "B": B.tolist(), "bg": bg.tolist(), "n": len(profs)}


def stock_of(path):
    name = os.path.basename(path)
    for pat, st in [(r"800T", "800T"), (r"400D", "400D"), (r"500T", "500T"), (r"250D", "250D")]:
        if re.search(pat, name, re.I): return st
    return "unlabelled"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="image files and/or folders")
    ap.add_argument("--label", help="treat all inputs as one group with this name")
    ap.add_argument("--core", type=int, default=242, help="8-bit level all channels must reach to count as a source")
    ap.add_argument("--json", help="write per-frame and summary numbers here")
    a = ap.parse_args()
    files = []
    for x in a.inputs:
        files += sorted(glob.glob(os.path.join(x, "**", "*.jp*g"), recursive=True)) if os.path.isdir(x) else [x]
    frames = []
    for p in files:
        try: pr = profile(load(p), a.core)
        except Exception as e: print("skip", p, e); continue
        pr["path"] = p; pr["stock"] = a.label or stock_of(p); frames.append(pr)
    print(f"{'frame':40s} {'stock':6s} {'scene':5s} {'L50':>4s} {'core%':>5s} {'blobs':>5s}  R/G at 0.3 / 0.6 / 1.0 / 1.3 %")
    for f in frames:
        rr = f["rings"]
        rg = " ".join((f"{r[0] / max(r[1], 1):.2f}" if (rr and r) else "  -  ") for r in ([rr[i] for i in (2, 4, 6, 7)] if rr else [None] * 4))
        print(f"{os.path.basename(f['path'])[:40]:40s} {f['stock']:6s} {f.get('scene', '-'):5s} {f['L50']:4.0f} {100 * f['core_frac']:5.2f} {f['blobs']:5d}  {rg}")
    summary = {}
    groups = sorted(set((f["stock"], f.get("scene")) for f in frames if f.get("rings")))
    for st in sorted(set(f["stock"] for f in frames)):
        summary[st] = summarize(st + " (all)", [f for f in frames if f["stock"] == st])
        for sc in ("point", "area"):
            if (st, sc) in groups:
                summary[f"{st}/{sc}"] = summarize(f"{st} / {sc} sources", [f for f in frames if f["stock"] == st and f.get("scene") == sc])
    if a.json:
        json.dump({"steps_pct": PCT, "frames": frames, "summary": summary}, open(a.json, "w"), indent=1)
        print("wrote", a.json)


if __name__ == "__main__":
    main()
