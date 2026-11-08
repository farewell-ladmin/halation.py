/*  halation-core.js - the CineStill halation model, same maths as ../halation.py.
    Plain script (no modules) so it loads in a classic Worker and in the page. Exposes `HalationCore`.

    Memory-lean layout: the two ring maps are kept at the reduced grid only; linearisation, receive
    weighting, bilinear upsample and compositing happen per pixel in one streaming pass. A 50 MP export
    needs the RGBA buffer plus two small float grids, not three full-size float images. */
(function (root) {
  "use strict";

  const PRESETS = {
    "800t":   { radius_pct: 0.30, gain: 5.0, strength: 0.35, threshold: 0.88, color: [255, 80, 30], tail: [0.65, 0.25, 2.5, 0.10, 5.0] },
    "400d":   { radius_pct: 0.20, gain: 7.0, strength: 0.42, threshold: 0.90, color: [255, 70, 28], tail: [0.80, 0.15, 2.0, 0.05, 4.0] },
    "subtle": { radius_pct: 0.25, gain: 3.0, strength: 0.20, threshold: 0.92, color: [255, 80, 30], tail: [0.70, 0.25, 2.5, 0.05, 5.0] },
    "heavy":  { radius_pct: 0.40, gain: 9.0, strength: 0.75, threshold: 0.82, color: [255, 75, 28], tail: [0.60, 0.25, 2.5, 0.15, 5.0] },
    // black and white: CineStill BwXX / Kodak 5222. mono converts the photo to luminance first; the glow is neutral, soft, wide
    // edge_tail: the widest component is fed from compact sources and edges only (energy minus its own 2r blur), so a
    // blown sky or window does not veil the whole frame. Colour presets do not use it.
    // deveil: ring - 0.7 x blur(ring, 3% of frame), clipped at 0: removes the broad lift that reads as lost contrast
    "bwxx":   { radius_pct: 0.40, gain: 3.0, strength: 0.30, threshold: 0.86, color: [255, 255, 255], tail: [0.55, 0.30, 3.0, 0.15, 5.0], mono: true, edge_tail: true, deveil: 0.7, deveil_pct: 3.0 },
  };

  const TO_LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const a = i / 255; TO_LIN[i] = a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4); }
  const ENC_N = 4096, TO_SRGB = new Uint8ClampedArray(ENC_N + 1);
  for (let i = 0; i <= ENC_N; i++) { const a = i / ENC_N; const s = a <= 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055; TO_SRGB[i] = Math.round(s * 255); }
  const srgbToLinear = v => { const a = v / 255; return a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4); };
  function smoothstep(lo, hi, x) { const t = Math.min(1, Math.max(0, (x - lo) / Math.max(hi - lo, 1e-6))); return t * t * (3 - 2 * t); }

  // three box passes via prefix sums, edge-clamped (identical to the Python _box1d)
  function box1dRows(a, w, h, r, out) {
    const row = new Float64Array(w + 2 * r + 1), k = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const o = y * w; let acc = 0; row[0] = 0;
      for (let i = 0; i < w + 2 * r; i++) { const x = Math.min(w - 1, Math.max(0, i - r)); acc += a[o + x]; row[i + 1] = acc; }
      for (let x = 0; x < w; x++) out[o + x] = (row[x + k] - row[x]) / k;
    }
  }
  function box1dCols(a, w, h, r, out) {
    const col = new Float64Array(h + 2 * r + 1), k = 2 * r + 1;
    for (let x = 0; x < w; x++) {
      let acc = 0; col[0] = 0;
      for (let i = 0; i < h + 2 * r; i++) { const y = Math.min(h - 1, Math.max(0, i - r)); acc += a[y * w + x]; col[i + 1] = acc; }
      for (let y = 0; y < h; y++) out[y * w + x] = (col[y + k] - col[y]) / k;
    }
  }
  function blur(a, w, h, sigma) {
    sigma = Math.max(sigma, 0.5);
    const r = Math.max(1, Math.round(Math.sqrt(sigma * sigma * 12 / 3 + 1) / 2 - 0.5));
    let cur = Float32Array.from(a), tmp = new Float32Array(a.length);
    for (let i = 0; i < 3; i++) { box1dRows(cur, w, h, r, tmp); box1dCols(tmp, w, h, r, cur); }
    return cur;
  }

  function radiusPx(cfg, w, h) { return Math.max(1, cfg.radius_pct / 100 * Math.max(w, h)); }

  // mono presets: replace every pixel with its linear luminance (Rec. 709), re-encoded to sRGB. In place.
  // Same maths as to_mono() in ../halation.py; colour presets never call this.
  function prepare(rgba, cfg) {
    if (!cfg.mono) return rgba;
    for (let i = 0; i < rgba.length; i += 4) {
      const y = 0.2126 * TO_LIN[rgba[i]] + 0.7152 * TO_LIN[rgba[i + 1]] + 0.0722 * TO_LIN[rgba[i + 2]];
      const v = TO_SRGB[Math.round(Math.min(1, y) * ENC_N)];
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    }
    return rgba;
  }

  // ring maps for the red and green channels at the reduced grid
  function makeHalo(rgba, w, h, cfg) {
    const rp = radiusPx(cfg, w, h), f = Math.max(1, Math.floor(rp / 4));
    const sw = Math.floor(w / f), sh = Math.floor(h / f), inv = 1 / (f * f), th = cfg.threshold;
    const eR = new Float32Array(sw * sh), eG = new Float32Array(sw * sh);
    if (f === 1) {
      for (let i = 0; i < w * h; i++) { eR[i] = smoothstep(th, 1, TO_LIN[rgba[i * 4]]); eG[i] = smoothstep(th, 1, TO_LIN[rgba[i * 4 + 1]]); }
    } else {
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        let sR = 0, sG = 0;
        for (let dy = 0; dy < f; dy++) { let p = ((y * f + dy) * w + x * f) * 4; for (let dx = 0; dx < f; dx++, p += 4) { sR += smoothstep(th, 1, TO_LIN[rgba[p]]); sG += smoothstep(th, 1, TO_LIN[rgba[p + 1]]); } }
        eR[y * sw + x] = sR * inv; eG[y * sw + x] = sG * inv;
      }
    }
    const [w1, w2, k2, w3, k3] = cfg.tail, s = rp / f;
    const ring = e => {
      let wideSrc = e;
      if (cfg.edge_tail) { const b = blur(e, sw, sh, 2.0 * s); wideSrc = new Float32Array(e.length); for (let i = 0; i < e.length; i++) wideSrc[i] = Math.min(1, Math.max(0, e[i] - b[i])); }
      const b1 = blur(e, sw, sh, s), b2 = blur(e, sw, sh, k2 * s), b3 = blur(wideSrc, sw, sh, k3 * s), out = new Float32Array(sw * sh);
      for (let i = 0; i < out.length; i++) out[i] = 1 - Math.exp(-cfg.gain * (w1 * b1[i] + w2 * b2[i] + w3 * b3[i]));
      return out;
    };
    let ringR = ring(eR), ringG = ring(eG);
    if (cfg.deveil > 0) { ringR = deveil(ringR, sw, sh, f, Math.max(w, h), cfg.deveil_pct || 3.0, cfg.deveil); ringG = deveil(ringG, sw, sh, f, Math.max(w, h), cfg.deveil_pct || 3.0, cfg.deveil); }
    return { ringR, ringG, sw, sh, f, w, h, threshold: th, tint: cfg.color.map(srgbToLinear) };
  }

  // ring - alpha * blur(ring, pct% of the long edge), clipped at 0. The ring grid is already reduced by f; the
  // Python reduces by a further floor(sigma/8) and bilinearly upsamples, so to stay close we blur a further
  // reduced copy here too and upsample back onto the ring grid.
  function deveil(ringMap, sw, sh, f, longEdge, pct, alpha) {
    const sigFull = pct / 100 * longEdge, f2 = Math.max(1, Math.floor(sigFull / 8));   // Python's grid factor relative to full res
    const g = Math.max(1, Math.round(f2 / f));                                          // extra reduction relative to the ring grid
    const sw2 = Math.floor(sw / g), sh2 = Math.floor(sh / g), small = new Float32Array(sw2 * sh2), inv = 1 / (g * g);
    if (g === 1) small.set(ringMap.subarray(0, sw2 * sh2));
    else for (let y = 0; y < sh2; y++) for (let x = 0; x < sw2; x++) { let acc = 0; for (let dy = 0; dy < g; dy++) for (let dx = 0; dx < g; dx++) acc += ringMap[(y * g + dy) * sw + x * g + dx]; small[y * sw2 + x] = acc * inv; }
    const wideSmall = blur(small, sw2, sh2, sigFull / (f * g));
    const out = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      const fy = Math.min(sh2 - 1, Math.max(0, (y + 0.5) / g - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh2 - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < sw; x++) {
        let wv;
        if (g === 1) wv = wideSmall[Math.min(sh2 - 1, y) * sw2 + Math.min(sw2 - 1, x)];
        else { const fx = Math.min(sw2 - 1, Math.max(0, (x + 0.5) / g - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw2 - 1, x0 + 1), tx = fx - x0;
          wv = (wideSmall[y0 * sw2 + x0] * (1 - tx) + wideSmall[y0 * sw2 + x1] * tx) * (1 - ty) + (wideSmall[y1 * sw2 + x0] * (1 - tx) + wideSmall[y1 * sw2 + x1] * tx) * ty; }
        out[y * sw + x] = Math.max(0, ringMap[y * sw + x] - alpha * wv);
      }
    }
    return out;
  }

  // out = in + strength * receive * ring * tint, streamed per pixel, bilinear upsample of the ring grid
  function composite(rgba, halo, strength, out) {
    const { ringR, ringG, sw, sh, f, w, h, threshold, tint } = halo;
    const lo = threshold - 0.25, hi = threshold + 0.02, tr = tint[0] * strength, tg = tint[1] * strength, tb = tint[2] * strength;
    for (let y = 0; y < h; y++) {
      let y0, y1, ty;
      if (f === 1) { y0 = y1 = y; ty = 0; } else { const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5)); y0 = Math.floor(fy); y1 = Math.min(sh - 1, y0 + 1); ty = fy - y0; }
      for (let x = 0; x < w; x++) {
        const i = y * w + x, p = i * 4;
        const r = TO_LIN[rgba[p]], g = TO_LIN[rgba[p + 1]], b = TO_LIN[rgba[p + 2]];
        let hr, hg;
        if (f === 1) { hr = ringR[i]; hg = ringG[i]; }
        else {
          const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
          const a00 = y0 * sw + x0, a01 = y0 * sw + x1, a10 = y1 * sw + x0, a11 = y1 * sw + x1;
          hr = (ringR[a00] * (1 - tx) + ringR[a01] * tx) * (1 - ty) + (ringR[a10] * (1 - tx) + ringR[a11] * tx) * ty;
          hg = (ringG[a00] * (1 - tx) + ringG[a01] * tx) * (1 - ty) + (ringG[a10] * (1 - tx) + ringG[a11] * tx) * ty;
        }
        const rec = 1 - smoothstep(lo, hi, Math.max(r, g, b));
        out[p]     = TO_SRGB[Math.round(Math.min(1, r + hr * rec * tr) * ENC_N)];
        out[p + 1] = TO_SRGB[Math.round(Math.min(1, g + hg * rec * tg) * ENC_N)];
        out[p + 2] = TO_SRGB[Math.round(Math.min(1, b + hr * rec * tb) * ENC_N)];
        out[p + 3] = 255;
      }
    }
    return out;
  }

  root.HalationCore = { PRESETS, makeHalo, composite, radiusPx, prepare };
})(typeof self !== "undefined" ? self : this);
