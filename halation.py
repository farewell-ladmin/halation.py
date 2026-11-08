"""halation.py - CineStill-style halation for JPEG/TIFF, calibrated on real film scans.

Presets were fitted on scans of the author's own film (36 CineStill 800T / 400D frames for the colour presets,
48 Kodak 5222 / BwXX frames for the black-and-white one); the measured ring profiles are in calibration/.
  * 400D vs 800T (21 x 400D, 15 x 800T): 400D's ring is TIGHTER
    and PEAKS HIGHER than 800T's (R/G 1.5 at 0.2-0.3% of the frame, gone by 0.6%); 800T's is softer and
    carries further (R/G 1.3 at 0.3%, still 1.15 at 0.6%, and a long faint tail round big clipped areas).
    Frames with no clipped source show no ring on either stock, which is why 400D "looks subtle" in daylight
  * a third, wide kernel component so large clipped areas (windows, blown skies) spread further than point
    lights, as they do on film
  * --report measures the ring on the output and prints it next to the film's numbers, so a result can be
    checked instead of eyeballed; --out-dir batches a folder

Model (linear light):
  energy_c  = smoothstep(threshold, 1, channel_c)          for c in {red, green}; blue never halates
  spread_c  = w1 * G(energy_c, r) + w2 * G(energy_c, k2 r) + w3 * G(energy_c, k3 r)   (G = gaussian blur)
  ring_c    = 1 - exp(-gain * spread_c)
  receive   = 1 - smoothstep(threshold - 0.25, threshold + 0.02, max(R, G, B))         (sources stay white)
  out       = in + strength * receive * [ring_red * tint_r, ring_green * tint_g, ring_red * tint_b]
r is --radius-pct of the long edge. Blur is three box passes (separable, cumulative sums) on a reduced
grid, so a 50 MP file takes a few seconds in numpy and the same maths ports to a shader or JS verbatim.

Usage:
  python halation.py in.jpg out.jpg                          # 800T
  python halation.py in.jpg out.jpg --preset 400d --report   # 400D, then measure the ring vs film
  python halation.py in.jpg out.jpg --strength 0.6 --ladder ladder.jpg
  python halation.py folder --out-dir done --preset 800t     # batch
Knobs, most useful first: --auto (fit strength to the film per frame), --strength, --threshold, --radius-pct, --gain, --color, --tail.
--preset bwxx is black and white: converts the photo to luminance, then adds the soft neutral glow of CineStill BwXX /
Kodak 5222 round clipped lights. The colour presets are a separate code path and are not affected by it.
"""
import argparse, glob, os, sys
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))

# Fitted 2026-11-06 on the CineStill corpus (see calibration/cinestill_profile_2026-11-06.*).
# tail = (w1, w2, k2, w3, k3): kernel weights and radius multipliers of the three gaussian components.
PRESETS = {
    "800t":   dict(radius_pct=0.30, gain=5.0, strength=0.35, threshold=0.88, color="255,80,30",  tail=(0.65, 0.25, 2.5, 0.10, 5.0)),
    "400d":   dict(radius_pct=0.20, gain=7.0, strength=0.42, threshold=0.90, color="255,70,28",  tail=(0.80, 0.15, 2.0, 0.05, 4.0)),
    "subtle": dict(radius_pct=0.25, gain=3.0, strength=0.20, threshold=0.92, color="255,80,30",  tail=(0.70, 0.25, 2.5, 0.05, 5.0)),
    "heavy":  dict(radius_pct=0.40, gain=9.0, strength=0.75, threshold=0.82, color="255,75,28",  tail=(0.60, 0.25, 2.5, 0.15, 5.0)),
    # Black and white: CineStill BwXX / Kodak 5222 (same stock; grey-base anti-halation, no remjet). Fitted 2026-11-07 on
    # the BwXX corpus (48 frames, 36 with clipped lights, 17 with point sources). The glow is NEUTRAL, SOFT and WIDE:
    # as a fraction of headroom above the far field it is 0.37 at 0.3% of the frame, 0.27 at 0.6%, 0.20 at 1.0%, 0.10 at 2.0%,
    # where the colour ring is gone by 1%. mono=True converts the input to luminance first and adds white light.
    # deveil: subtract 0.7 x a 3%-of-frame blur of the ring map from itself, so the broad low-frequency lift (which reads as
    # lost contrast) is removed while the local glow stays. Mono only; colour presets have no such key.
    "bwxx":   dict(radius_pct=0.40, gain=3.0, strength=0.30, threshold=0.86, color="255,255,255", tail=(0.55, 0.30, 3.0, 0.15, 5.0), mono=True, edge_tail=True, deveil=0.7, deveil_pct=3.0),
}
LADDER = (0.2, 0.35, 0.55, 0.8)
# film ring targets, R/G at 0.3 / 0.6 / 1.0 / 1.3 % of the long edge (median over frames with sources)
FILM = {"800t": (1.28, 1.16, 1.07, 1.17), "400d": (1.49, 1.10, 1.06, 0.98)}
# mono target: glow as a fraction of headroom (L - far) / (255 - far) at 0.3 / 0.6 / 1.0 / 2.0 % of the long edge, film XX point-source frames
FILM_MONO = {"bwxx": (0.37, 0.27, 0.20, 0.10)}


def to_mono(lin):
    """Linear RGB -> linear luminance replicated to 3 channels (Rec. 709 weights)."""
    y = 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
    return np.repeat(y[..., None], 3, axis=2)


def srgb_to_linear(a):
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(a):
    a = np.clip(a, 0, 1)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(a, 1 / 2.4) - 0.055)


def smoothstep(lo, hi, x):
    t = np.clip((x - lo) / max(hi - lo, 1e-6), 0, 1)
    return t * t * (3 - 2 * t)


def _box1d(a, r, axis):
    if r < 1:
        return a
    pad = [(0, 0)] * a.ndim; pad[axis] = (r, r)
    p = np.pad(a, pad, mode="edge")
    c = np.cumsum(p, axis=axis, dtype=np.float64)
    c = np.concatenate([np.zeros_like(np.take(c, [0], axis=axis)), c], axis=axis)
    n = a.shape[axis]
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def blur(a, sigma):
    """Gaussian-ish blur: three box passes whose width approximates sigma (px of `a`)."""
    sigma = max(float(sigma), 0.5)
    r = max(1, int(round(np.sqrt(sigma * sigma * 12 / 3 + 1) / 2 - 0.5)))
    a = a.astype(np.float32)
    for _ in range(3):
        a = _box1d(a, r, 0); a = _box1d(a, r, 1)
    return a


def ring(channel, radius_px, threshold, gain, tail, edge_tail=False):
    """Halo intensity 0..1 driven by one linear channel.
    edge_tail: feed the widest component from compact sources and edges only (energy minus its own 2r blur),
    so a blown sky or window does not lay a veil over the whole frame. Used by the mono preset."""
    w1, w2, k2, w3, k3 = tail
    h, w = channel.shape
    e = smoothstep(threshold, 1.0, channel)
    f = max(1, int(radius_px // 4))
    if f > 1:
        hh, ww = (h // f) * f, (w // f) * f
        small = e[:hh, :ww].reshape(hh // f, f, ww // f, f).mean(axis=(1, 3))
    else:
        small = e
    s = radius_px / f
    wide_src = np.clip(small - blur(small, 2.0 * s), 0, 1) if edge_tail else small
    spread = w1 * blur(small, s) + w2 * blur(small, k2 * s) + w3 * blur(wide_src, k3 * s)
    halo = 1.0 - np.exp(-gain * spread)
    if f > 1:
        halo = np.asarray(Image.fromarray(halo.astype(np.float32), mode="F").resize((w, h), Image.BILINEAR))
    return halo


def deveil(ring_map, long_edge, pct, alpha):
    """Remove the broad veil: ring - alpha * blur(ring, pct% of the long edge), clipped at 0. Computed on a reduced grid."""
    sig = pct / 100.0 * long_edge; f = max(1, int(sig // 8))
    h_, w_ = ring_map.shape; hh, ww = (h_ // f) * f, (w_ // f) * f
    small = ring_map[:hh, :ww].reshape(hh // f, f, ww // f, f).mean(axis=(1, 3)) if f > 1 else ring_map
    wide = blur(small, sig / f)
    if f > 1:
        wide = np.asarray(Image.fromarray(wide.astype(np.float32), mode="F").resize((w_, h_), Image.BILINEAR))
    return np.clip(ring_map - alpha * wide, 0, None)


def halation_layers(lin, radius_px, threshold, gain, color, tail, edge_tail=False, deveil_alpha=0.0, deveil_pct=3.0):
    """Light to add at strength 1.0 (HxWx3, linear)."""
    ring_r = ring(lin[..., 0], radius_px, threshold, gain, tail, edge_tail)
    ring_g = ring(lin[..., 1], radius_px, threshold, gain, tail, edge_tail)
    if deveil_alpha > 0:
        L = max(lin.shape[:2])
        ring_r = deveil(ring_r, L, deveil_pct, deveil_alpha); ring_g = deveil(ring_g, L, deveil_pct, deveil_alpha)
    receive = 1.0 - smoothstep(threshold - 0.25, threshold + 0.02, lin.max(axis=2))
    tint = srgb_to_linear(np.array(color, np.float32))
    add = np.empty_like(lin)
    add[..., 0] = ring_r * receive * tint[0]
    add[..., 1] = ring_g * receive * tint[1]
    add[..., 2] = ring_r * receive * tint[2]
    return add


def apply(img, cfg, radius_px=None):
    """Return (output PIL image, add layer, linear input)."""
    srgb = img.convert("RGB")
    lin = srgb_to_linear(np.asarray(srgb).astype(np.float32) / 255.0)
    if cfg.get("mono"):
        lin = to_mono(lin)                                   # B&W film: the image itself goes monochrome first
    if radius_px is None:
        radius_px = max(1.0, cfg["radius_pct"] / 100.0 * max(srgb.size))
    color = tuple(int(c) / 255.0 for c in cfg["color"].split(","))
    add = halation_layers(lin, radius_px, cfg["threshold"], cfg["gain"], color, cfg["tail"], bool(cfg.get("edge_tail")), float(cfg.get("deveil", 0.0)), float(cfg.get("deveil_pct", 3.0)))
    return to_image(lin + cfg["strength"] * add), add, lin


def to_image(lin):
    return Image.fromarray((linear_to_srgb(lin) * 255 + 0.5).astype(np.uint8))


def strongest_crop(add, size, half):
    st = max(1, max(size) // 800)
    sm = blur(add[::st, ::st, 0], 12)
    hy, hx = np.unravel_index(int(np.argmax(sm)), sm.shape)
    s = min(half, size[0] // 2, size[1] // 2)
    x0 = max(0, min(size[0] - 2 * s, hx * st - s)); y0 = max(0, min(size[1] - 2 * s, hy * st - s))
    return (x0, y0, x0 + 2 * s, y0 + 2 * s)


def report(out_path, preset):
    sys.path.insert(0, HERE)
    import halation_calibrate as hc
    pr = hc.profile(hc.load(out_path))
    if not pr.get("rings"):
        print("  report: no clipped sources in this frame, so no ring to measure (film would show none either)"); return
    rr = pr["rings"]
    if PRESETS.get(preset, {}).get("mono"):
        far = sum(pr["bg"]) / 3 if pr.get("bg") else float("nan")
        got = [((sum(r) / 3 - far) / max(255 - far, 1)) if r else float("nan") for r in (rr[2], rr[4], rr[6], rr[9])]
        want = FILM_MONO.get(preset)
        print(f"  glow as fraction of headroom at 0.3 / 0.6 / 1.0 / 2.0 % of frame:  output " + " ".join(f"{g:.2f}" for g in got)
              + (f"   film XX " + " ".join(f"{w:.2f}" for w in want) if want else "") + f"   (far field {far:.0f}, sources {100 * pr['core_frac']:.2f}%)")
        return
    got = [(r[0] / max(r[1], 1)) if r else float("nan") for r in (rr[2], rr[4], rr[6], rr[7])]
    want = FILM.get(preset)
    print(f"  ring R/G at 0.3 / 0.6 / 1.0 / 1.3 % of frame:  output " + " ".join(f"{g:.2f}" for g in got)
          + (f"   film {preset} " + " ".join(f"{w:.2f}" for w in want) if want else "") + f"   (scene: {pr['scene']}, sources {100 * pr['core_frac']:.2f}% of frame)")


def auto_strength(img, cfg, preset, radius_px=None, max_strength=1.0, iters=6):
    """Fit --strength so the output's ring R/G at 0.3% of the frame matches the film's, on a 1600 px copy.
    Returns (strength, measured R/G) or (None, None) when the frame has no clipped sources."""
    sys.path.insert(0, HERE)
    import halation_calibrate as hc
    mono = bool(cfg.get("mono"))
    target = (FILM_MONO.get(preset, FILM_MONO["bwxx"]) if mono else FILM.get(preset, FILM["800t"]))[0]
    small = img.convert("RGB"); small.thumbnail((hc.LONG, hc.LONG))
    lin = srgb_to_linear(np.asarray(small).astype(np.float32) / 255.0)
    if mono: lin = to_mono(lin)
    rp = (radius_px * max(small.size) / max(img.size)) if radius_px else max(1.0, cfg["radius_pct"] / 100.0 * max(small.size))
    color = tuple(int(c) / 255.0 for c in cfg["color"].split(","))
    add = halation_layers(lin, rp, cfg["threshold"], cfg["gain"], color, cfg["tail"], bool(cfg.get("edge_tail")), float(cfg.get("deveil", 0.0)), float(cfg.get("deveil_pct", 3.0)))
    def measure(strength):
        pr = hc.profile(to_image(lin + strength * add))
        if not pr.get("rings") or not pr["rings"][2]: return None
        r = pr["rings"][2]
        if mono:
            far = sum(pr["bg"]) / 3 if pr.get("bg") else 0.0
            return (sum(r) / 3 - far) / max(255 - far, 1)
        return r[0] / max(r[1], 1)
    base = measure(0.0)
    if base is None: return None, None
    lo, hi = 0.0, max_strength
    if (measure(hi) or 0) < target: return hi, measure(hi)
    for _ in range(iters):
        mid = (lo + hi) / 2
        m = measure(mid)
        if m is None or m < target: lo = mid
        else: hi = mid
    return round((lo + hi) / 2, 3), measure((lo + hi) / 2)


def process_one(src_path, dst_path, cfg, a):
    src = Image.open(src_path); exif = src.info.get("exif")
    cfg = dict(cfg)
    if a.auto:
        st, got = auto_strength(src, cfg, a.preset, a.radius)
        tgt = (FILM_MONO.get(a.preset, FILM_MONO["bwxx"]) if cfg.get("mono") else FILM.get(a.preset, FILM["800t"]))[0]
        if st is None: print(f"  auto: {os.path.basename(src_path)} has no clipped sources; strength left at {cfg['strength']}")
        else:
            cfg["strength"] = st
            note = "" if got >= tgt - 0.02 else "  (capped: the bloom round these lights is brighter than film glow, so the film ratio is out of reach; judge by eye or --ladder)"
            print(f"  auto: strength {st} gives {'glow fraction' if cfg.get('mono') else 'ring R/G'} {got:.2f} at 0.3% (film {a.preset}: {tgt:.2f}){note}")
    out, add, lin = apply(src, cfg, a.radius)
    kw = {"quality": a.quality}
    if exif: kw["exif"] = exif
    out.save(dst_path, **kw)
    srgb = src.convert("RGB")
    stem = os.path.splitext(dst_path)[0]
    if a.compare:
        x = srgb.copy(); x.thumbnail((1400, 1400)); y = out.copy(); y.thumbnail((1400, 1400))
        sheet = Image.new("RGB", (x.width + y.width + 10, max(x.height, y.height)), (20, 20, 20))
        sheet.paste(x, (0, 0)); sheet.paste(y, (x.width + 10, 0)); sheet.save(a.compare if not a.out_dir else stem + "_compare.jpg", quality=90)
    if a.crop_compare:
        box = strongest_crop(add, srgb.size, 450)
        x, y = srgb.crop(box), out.crop(box)
        sheet = Image.new("RGB", (x.width * 2 + 10, x.height), (20, 20, 20)); sheet.paste(x, (0, 0)); sheet.paste(y, (x.width + 10, 0))
        sheet.save(a.crop_compare if not a.out_dir else stem + "_crop.jpg", quality=92)
    if a.ladder:
        l, t, r, b = strongest_crop(add, srgb.size, 300)
        tiles = [srgb.crop((l, t, r, b))] + [to_image(lin[t:b, l:r] + s * add[t:b, l:r]) for s in LADDER]
        w = tiles[0].width
        sheet = Image.new("RGB", (len(tiles) * (w + 6), tiles[0].height), (20, 20, 20))
        for i, tile in enumerate(tiles): sheet.paste(tile, (i * (w + 6), 0))
        sheet.save(a.ladder if not a.out_dir else stem + "_ladder.jpg", quality=92)
    print(f"wrote {dst_path}  ({a.preset}: strength {cfg['strength']} threshold {cfg['threshold']} radius {cfg['radius_pct']}% gain {cfg['gain']})")
    if a.report: report(dst_path, a.preset)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("src", help="image, or a folder with --out-dir"); p.add_argument("dst", nargs="?", help="output image (omit with --out-dir)")
    p.add_argument("--out-dir", help="batch: write every image in SRC here with the same name")
    p.add_argument("--preset", choices=sorted(PRESETS), default="800t")
    p.add_argument("--strength", type=float, help="how much red is added: 0.2 faint, 0.35 default, 0.6+ obvious")
    p.add_argument("--threshold", type=float, help="linear level (0-1) where a channel counts as a light source")
    p.add_argument("--radius-pct", type=float, help="ring radius, %% of the long edge")
    p.add_argument("--radius", type=float, help="ring radius in pixels (overrides --radius-pct)")
    p.add_argument("--gain", type=float, help="how quickly small sources reach a full ring")
    p.add_argument("--color", help="ring colour for a white source, sRGB R,G,B")
    p.add_argument("--tail", help="kernel w1,w2,k2,w3,k3 (weights and radius multipliers)")
    p.add_argument("--deveil", type=float, help="mono presets: how much of the broad veil to remove (0 = none, 0.7 default for bwxx)")
    p.add_argument("--compare", help="before/after side-by-side path (with --out-dir: flag only, written beside each output)", nargs="?", const=True)
    p.add_argument("--crop-compare", help="100%% crop before/after path (with --out-dir: flag only)", nargs="?", const=True)
    p.add_argument("--ladder", help="crop at strengths %s (with --out-dir: flag only)" % (LADDER,), nargs="?", const=True)
    p.add_argument("--auto", action="store_true", help="fit --strength per frame so the ring matches the film's R/G at 0.3%% of the frame")
    p.add_argument("--report", action="store_true", help="measure the ring on the output and print it next to the film's")
    p.add_argument("--quality", type=int, default=94)
    a = p.parse_args()
    cfg = dict(PRESETS[a.preset])
    for k in ("radius_pct", "gain", "strength", "threshold", "color"):
        v = getattr(a, k)
        if v is not None: cfg[k] = v
    if a.tail: cfg["tail"] = tuple(float(x) for x in a.tail.split(","))
    if a.deveil is not None: cfg["deveil"] = a.deveil
    if a.out_dir:
        os.makedirs(a.out_dir, exist_ok=True)
        files = sorted(glob.glob(os.path.join(a.src, "*.jp*g")) + glob.glob(os.path.join(a.src, "*.tif*")) + glob.glob(os.path.join(a.src, "*.png")))
        for f in files:
            process_one(f, os.path.join(a.out_dir, os.path.basename(f)), cfg, a)
    else:
        if not a.dst: p.error("dst is required unless --out-dir is given")
        process_one(a.src, a.dst, cfg, a)


if __name__ == "__main__":
    main()
