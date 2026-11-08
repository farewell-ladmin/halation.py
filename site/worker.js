/* worker.js - runs the halation maths off the main thread. Keeps the current halo maps so a strength
   change is one cheap composite pass. Protocol: {type:"halo", id, rgba, w, h, cfg} -> {type:"halo", id}
   {type:"composite", id, strength} -> {type:"composite", id, rgba}   (preview-size, reuses stored halo + rgba)
   {type:"full", id, rgba, w, h, cfg, strength} -> {type:"full", id, rgba}   (one-shot, full size) */
importScripts("halation-core.js?v=4c6471ad");
let cur = null;   // { rgba, w, h, halo }
self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === "halo") {
      const rgba = HalationCore.prepare(new Uint8ClampedArray(m.rgba), m.cfg);
      cur = { rgba, w: m.w, h: m.h, halo: HalationCore.makeHalo(rgba, m.w, m.h, m.cfg) };
      self.postMessage({ type: "halo", id: m.id });
    } else if (m.type === "composite") {
      if (!cur) throw new Error("no image");
      const out = new Uint8ClampedArray(cur.w * cur.h * 4);
      HalationCore.composite(cur.rgba, cur.halo, m.strength, out);
      self.postMessage({ type: "composite", id: m.id, rgba: out.buffer, w: cur.w, h: cur.h }, [out.buffer]);
    } else if (m.type === "full") {
      const rgba = HalationCore.prepare(new Uint8ClampedArray(m.rgba), m.cfg);
      const halo = HalationCore.makeHalo(rgba, m.w, m.h, m.cfg);
      HalationCore.composite(rgba, halo, m.strength, rgba);      // in place: the input buffer becomes the output
      self.postMessage({ type: "full", id: m.id, rgba: rgba.buffer, w: m.w, h: m.h }, [rgba.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, message: String(err && err.message || err) });
  }
};
