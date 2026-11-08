/* app.js - page logic for the public halation tool. All processing is client-side (see worker.js).
   Colour handling: decode with colorSpaceConversion "none", process the file's own values, and on JPEG
   export splice the source's EXIF (orientation reset) and ICC profile back in. The maths is halation-core.js,
   which mirrors ../halation.py preset for preset. */
"use strict";
const $ = id => document.getElementById(id);
const PRESETS = HalationCore.PRESETS;
const PRESET_NOTES = { "800t": "CineStill 800T", "400d": "CineStill 400D", "subtle": "a hint", "heavy": "poster-child", "bwxx": "black & white · BwXX / 5222" };
const PREVIEW_EDGE = Math.min(1600, Math.max(900, Math.round((window.innerWidth || 1200) * (window.devicePixelRatio || 1) * 0.9)));

let cfg = { ...PRESETS["800t"] }, presetName = "800t", lastPreset = "800t";
const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function notice(t, err) { const n = $("notice"); n.textContent = t || ""; n.classList.toggle("err", !!err); }
let img = null, imgTitle = "", srcMeta = { exif: null, icc: [] };
let preview = null;            // ImageData at preview size (original pixels)
let haloReady = false, pending = null, inFlight = false, reqId = 0;
// ---- processing backend: a Worker when the browser allows one, otherwise the main thread ---------------
// Chrome refuses to start a Worker from a file:// page (SecurityError) and Firefox gives every file:// script
// its own origin so the worker's importScripts fails. Both cases land on the main-thread path below, which
// runs the same HalationCore code; the page is just less responsive during a render.
let worker = null, workerDead = false, workerSeen = false;
const waiting = new Map();
const local = { cur: null };
function runLocal(m) {                                    // mirrors worker.js
  if (m.type === "halo") { const rgba = HalationCore.prepare(new Uint8ClampedArray(m.rgba), m.cfg); local.cur = { rgba, w: m.w, h: m.h, halo: HalationCore.makeHalo(rgba, m.w, m.h, m.cfg) }; return { type: "halo", id: m.id }; }
  if (m.type === "composite") { if (!local.cur) throw new Error("no image"); const out = new Uint8ClampedArray(local.cur.w * local.cur.h * 4); HalationCore.composite(local.cur.rgba, local.cur.halo, m.strength, out); return { type: "composite", id: m.id, rgba: out.buffer, w: local.cur.w, h: local.cur.h }; }
  if (m.type === "full") { const rgba = HalationCore.prepare(new Uint8ClampedArray(m.rgba), m.cfg); const halo = HalationCore.makeHalo(rgba, m.w, m.h, m.cfg); HalationCore.composite(rgba, halo, m.strength, rgba); return { type: "full", id: m.id, rgba: rgba.buffer, w: m.w, h: m.h }; }
  throw new Error("unknown request");
}
function localAsync(msg) { return new Promise((resolve, reject) => setTimeout(() => { try { resolve(runLocal(msg)); } catch (e) { reject(e); } }, 30)); }
function giveUpOnWorker(why) {
  if (workerDead) return;
  workerDead = true; console.warn("halation: worker unavailable (" + why + "), processing on the main thread");
  try { worker && worker.terminate(); } catch (e) {}
  for (const [id, w] of waiting) { waiting.delete(id); localAsync(w.msg).then(w.resolve, w.reject); }   // replay in-flight requests
}
try {
  if (new URLSearchParams(location.search).get("noworker")) throw new Error("disabled by ?noworker=1 (test hook)");
  worker = new Worker("worker.js");
  worker.onmessage = e => { workerSeen = true; const m = e.data; const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); m.type === "error" ? w.reject(new Error(m.message)) : w.resolve(m); };
  worker.onerror = e => giveUpOnWorker(e.message || "script error");
} catch (e) { worker = null; giveUpOnWorker(e.message); }
function ask(msg, transfer) {
  msg.id = ++reqId;
  if (workerDead || !worker) return localAsync(msg);
  return new Promise((resolve, reject) => {
    waiting.set(msg.id, { resolve, reject, msg: transfer && transfer.length ? { ...msg, rgba: msg.rgba ? msg.rgba.slice(0) : undefined } : msg });
    if (!workerSeen) setTimeout(() => { if (!workerSeen && waiting.has(msg.id)) giveUpOnWorker("no reply in 6 s"); }, 6000);   // watchdog for silent failures
    worker.postMessage(msg, transfer || []);
  });
}

// ---- JPEG metadata ---------------------------------------------------------
function jpegSegments(bytes) {
  const segs = []; let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xFF) {
    const marker = bytes[i + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    if (marker === 0xDA) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    segs.push({ marker, start: i, end: i + 2 + len }); i += 2 + len;
  }
  return segs;
}
function tagOf(bytes, s, n) { return String.fromCharCode(...bytes.slice(s.start + 4, s.start + 4 + n)); }
function extractMeta(bytes) {
  const meta = { exif: null, icc: [] };
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return meta;
  for (const s of jpegSegments(bytes)) {
    if (s.marker === 0xE1 && tagOf(bytes, s, 4) === "Exif") meta.exif = resetOrientation(bytes.slice(s.start, s.end));
    if (s.marker === 0xE2 && tagOf(bytes, s, 11) === "ICC_PROFILE") meta.icc.push(bytes.slice(s.start, s.end));
  }
  return meta;
}
function resetOrientation(seg) {
  const t = 10, le = seg[t] === 0x49;
  const u16 = o => le ? seg[o] | (seg[o + 1] << 8) : (seg[o] << 8) | seg[o + 1];
  const u32 = o => le ? (u16(o) | (u16(o + 2) << 16)) >>> 0 : ((u16(o) << 16) | u16(o + 2)) >>> 0;
  if (u16(t + 2) !== 42) return seg;
  const ifd = t + u32(t + 4), n = u16(ifd);
  for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (u16(e) === 0x0112) { if (le) { seg[e + 8] = 1; seg[e + 9] = 0; } else { seg[e + 8] = 0; seg[e + 9] = 1; } } }
  return seg;
}
function withMeta(jpegBytes, meta) {
  if (!meta.exif && !meta.icc.length) return jpegBytes;
  const parts = [jpegBytes.slice(0, 2)];
  if (meta.exif) parts.push(meta.exif);
  for (const c of meta.icc) parts.push(c);
  let rest = jpegBytes.slice(2);
  if (meta.icc.length) {
    const keep = []; let pos = 2;
    for (const sg of jpegSegments(jpegBytes)) if (sg.marker === 0xE2 && tagOf(jpegBytes, sg, 11) === "ICC_PROFILE") { keep.push(jpegBytes.slice(pos, sg.start)); pos = sg.end; }
    keep.push(jpegBytes.slice(pos));
    const n = keep.reduce((a, b) => a + b.length, 0); rest = new Uint8Array(n); let o = 0; for (const k of keep) { rest.set(k, o); o += k.length; }
  }
  parts.push(rest);
  const total = parts.reduce((a, b) => a + b.length, 0), out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- loading -------------------------------------------------------------------------------------------
async function decode(blob) {
  try { return await createImageBitmap(blob, { colorSpaceConversion: "none", imageOrientation: "from-image" }); }
  catch (e) { const im = new Image(); im.src = URL.createObjectURL(blob); await new Promise((res, rej) => { im.onload = res; im.onerror = rej; }); return im; }
}
async function loadBlob(blob, name) {
  notice("Opening photo…");
  srcMeta = extractMeta(new Uint8Array(await blob.arrayBuffer()));
  try { img = await decode(blob); } catch (e) { notice(`Could not open ${name || "that file"}. Try a JPEG or PNG.`, true); return; }
  notice("");
  imgTitle = name || "image";
  $("drop").hidden = true; $("work").hidden = false;
  const s = Math.min(1, PREVIEW_EDGE / Math.max(img.width, img.height));
  const w = Math.round(img.width * s), h = Math.round(img.height * s);
  const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h);
  preview = c.getContext("2d").getImageData(0, 0, w, h);
  for (const id of ["before", "after"]) { $(id).width = w; $(id).height = h; }
  $("before").getContext("2d").putImageData(preview, 0, 0);
  $("meta_name").textContent = `${imgTitle} · ${img.width}×${img.height}` + (srcMeta.exif ? (srcMeta.icc.length ? " · EXIF + ICC kept on JPEG export" : " · EXIF kept on JPEG export") : "");
  $("work").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  await rebuild();
}
$("file").onchange = e => { if (e.target.files[0]) loadBlob(e.target.files[0], e.target.files[0].name); };
$("pick").onclick = () => $("file").click();
$("pick2").onclick = () => $("file").click();
const drop = $("drop");
drop.addEventListener("click", e => { if (e.target.tagName !== "BUTTON") $("file").click(); });
for (const ev of ["dragenter", "dragover"]) document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) document.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); });
document.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) loadBlob(f, f.name); });
document.addEventListener("paste", e => { const f = [...(e.clipboardData.files || [])][0]; if (f) loadBlob(f, f.name); });

// ---- processing ---------------------------------------------------------------------------------------
function setStatus(t, err) { const s = $("status"); s.textContent = t; s.classList.toggle("err", !!err); }
function busy(on) { $("viewer").classList.toggle("busy", on); }
async function rebuild() {              // halo maps change: full recompute at preview size
  if (!preview) return;
  if (inFlight) { pending = "rebuild"; return; }
  inFlight = true; busy(true); haloReady = false;
  const t0 = performance.now();
  try {
    const copy = preview.data.slice();
    await ask({ type: "halo", rgba: copy.buffer, w: preview.width, h: preview.height, cfg }, [copy.buffer]);
    haloReady = true;
    const r = await ask({ type: "composite", strength: cfg.strength });
    $("after").getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.w, r.h), 0, 0);
    setStatus("Ready");
  } catch (e) { setStatus(e.message, true); }
  inFlight = false; busy(false);
  if (pending) { const p = pending; pending = null; p === "rebuild" ? rebuild() : recomposite(); }
}
async function recomposite() {          // only strength changed: cheap pass
  if (!preview || !haloReady) return rebuild();
  if (inFlight) { pending = "composite"; return; }
  inFlight = true;
  try {
    const r = await ask({ type: "composite", strength: cfg.strength });
    $("after").getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.w, r.h), 0, 0);
    setStatus("Ready");
  } catch (e) { setStatus(e.message, true); }
  inFlight = false;
  if (pending) { const p = pending; pending = null; p === "rebuild" ? rebuild() : recomposite(); }
}

// ---- controls ------------------------------------------------------------------------------------------
const SLIDERS = { strength: 2, threshold: 3, radius_pct: 2, gain: 1 };
function syncUI() {
  for (const k in SLIDERS) { $(k).value = cfg[k]; $(k + "_v").textContent = (+cfg[k]).toFixed(SLIDERS[k]) + (k === "radius_pct" ? "%" : ""); }
  for (const b of document.querySelectorAll(".presets button")) b.setAttribute("aria-pressed", b.dataset.p === presetName ? "true" : "false");
  $("reset").textContent = presetName === "custom" ? `Reset to ${lastPreset.toUpperCase()}` : "Reset to preset";
}
for (const k in SLIDERS) {
  $(k).addEventListener("input", () => { cfg[k] = +$(k).value; presetName = "custom"; syncUI(); k === "strength" ? recomposite() : rebuild(); });
}
const presetsEl = $("presets");
for (const k of Object.keys(PRESETS)) {
  const b = document.createElement("button"); b.dataset.p = k;
  b.innerHTML = `${k.toUpperCase()}<small>${PRESET_NOTES[k]}</small>`;
  b.onclick = () => { presetName = lastPreset = k; cfg = { ...PRESETS[k] }; syncUI(); rebuild(); };
  presetsEl.appendChild(b);
}
$("reset").onclick = () => { presetName = lastPreset; cfg = { ...PRESETS[lastPreset] }; syncUI(); rebuild(); };
syncUI();

// ---- compare slider ------------------------------------------------------------------------------------
const viewer = $("viewer"), over = $("over_wrap"), handle = $("handle");
let split = 0.5;
function setSplit(v) { split = Math.min(1, Math.max(0, v)); over.style.clipPath = `inset(0 0 0 ${split * 100}%)`; handle.style.left = `${split * 100}%`; viewer.setAttribute("aria-valuenow", Math.round(split * 100)); viewer.setAttribute("aria-valuetext", split <= 0 ? "halation only" : split >= 1 ? "before only" : `${Math.round(split * 100)}% before`); }
function posFrom(e) { const r = viewer.getBoundingClientRect(); return (e.clientX - r.left) / r.width; }
// Touch: the handle owns the gesture (touch-action: none on it, so the browser never turns the drag into a
// scroll); a tap anywhere else on the photo jumps the split there and the page still scrolls over the image.
// Mouse: drag from anywhere.
let dragging = false, tap = null;
viewer.addEventListener("pointerdown", e => {
  if (e.pointerType === "mouse") { if (e.button !== 0) return; dragging = true; viewer.setPointerCapture(e.pointerId); setSplit(posFrom(e)); return; }
  if (e.target === handle || handle.contains(e.target)) { dragging = true; viewer.setPointerCapture(e.pointerId); e.preventDefault(); return; }
  tap = { x: e.clientX, y: e.clientY, t: performance.now() };
});
viewer.addEventListener("pointermove", e => {
  if (dragging) { setSplit(posFrom(e)); return; }
  if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 12) tap = null;   // became a scroll
});
viewer.addEventListener("pointerup", e => {
  if (dragging) { dragging = false; return; }
  if (tap && performance.now() - tap.t < 400) setSplit(posFrom(e));
  tap = null;
});
viewer.addEventListener("pointercancel", () => { dragging = false; tap = null; });
viewer.addEventListener("keydown", e => {
  const k = e.key; let v = null;
  if (k === "ArrowLeft" || k === "ArrowDown") v = split - 0.05; else if (k === "ArrowRight" || k === "ArrowUp") v = split + 0.05;
  else if (k === "Home") v = 0; else if (k === "End") v = 1; else if (k === " " || k === "Enter") v = split < 0.5 ? 1 : 0;
  if (v !== null) { e.preventDefault(); setSplit(v); }
});
setSplit(0.5);

// ---- export --------------------------------------------------------------------------------------------
async function renderFull() {
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const r = await ask({ type: "full", rgba: d.data.buffer, w: c.width, h: c.height, cfg, strength: cfg.strength }, [d.data.buffer]);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.w, r.h), 0, 0);
  return c;
}
function toBlob(c, type, q) { return new Promise(r => c.toBlob(r, type, q)); }
function baseName() { return (imgTitle || "image").replace(/\.[^.]+$/, "") + "_halation"; }
const LOCK = ["export_jpg", "export_png", "share", "pick2", "reset", "strength", "threshold", "radius_pct", "gain"];
function lockControls(on, btnId) {
  for (const id of LOCK) $(id).disabled = on;
  for (const b of document.querySelectorAll(".presets button")) b.disabled = on;
  $("panel").setAttribute("aria-busy", on ? "true" : "false");
  if (btnId) { const b = $(btnId); if (on) { b.dataset.label = b.innerHTML; b.textContent = "Rendering full resolution…"; } else if (b.dataset.label) { b.innerHTML = b.dataset.label; } }
}
async function exportFile(kind) {
  if (!img) return;
  const btnId = kind === "png" ? "export_png" : kind === "share" ? "share" : "export_jpg";
  busy(true); lockControls(true, btnId);
  setStatus(`Rendering ${img.width}×${img.height}. Large photos can take 20 seconds or more; keep this page open.`);
  const t0 = performance.now();
  try {
    const c = await renderFull();
    let blob, ext;
    if (kind === "png") { blob = await toBlob(c, "image/png"); ext = "png"; }
    else { const b = await toBlob(c, "image/jpeg", 0.97); blob = new Blob([withMeta(new Uint8Array(await b.arrayBuffer()), srcMeta)], { type: "image/jpeg" }); ext = "jpg"; }
    const file = new File([blob], `${baseName()}.${ext}`, { type: blob.type });
    if (kind === "share" && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Halation" });
    } else {
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    setStatus(`File ready: ${file.name}, ${(blob.size / 1048576).toFixed(1)} MB, ${((performance.now() - t0) / 1000).toFixed(1)} s. If it opened in a new tab, use the browser's Save or Share.`);
  } catch (e) { if (e && e.name === "AbortError") setStatus("Share cancelled."); else setStatus("Export failed: " + e.message, true); }
  finally { busy(false); lockControls(false, btnId); }
}
$("export_jpg").onclick = () => exportFile("jpg");
$("export_png").onclick = () => exportFile("png");
$("share").onclick = () => exportFile("share");
if (!(navigator.canShare && navigator.share)) $("share").hidden = true;

// ---- verification hook: ?src=<url>&ref=<python output url>&preset=800t  (native size, no scaling) --------
const q = new URLSearchParams(location.search);
if (q.get("preset") && PRESETS[q.get("preset")]) { presetName = q.get("preset"); cfg = { ...PRESETS[presetName] }; syncUI(); }
if (q.get("src")) (async () => {
  const blob = await (await fetch(q.get("src"))).blob();
  srcMeta = extractMeta(new Uint8Array(await blob.arrayBuffer()));
  img = await decode(blob); imgTitle = q.get("src");
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; c.getContext("2d").drawImage(img, 0, 0);
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  const beforePixels = d.data.slice();                      // keep a copy: the buffer below is transferred
  const t0 = performance.now();
  const r = await ask({ type: "full", rgba: d.data.buffer, w: c.width, h: c.height, cfg, strength: cfg.strength }, [d.data.buffer]);
  const out = new Uint8ClampedArray(r.rgba), w = r.w, h = r.h;
  const res = { w, h, ms: Math.round(performance.now() - t0), meta: { exif: !!srcMeta.exif, icc: srcMeta.icc.length } };
  if (q.get("ref")) {
    const ref = await decode(await (await fetch(q.get("ref"))).blob());
    const rc = document.createElement("canvas"); rc.width = w; rc.height = h; rc.getContext("2d").drawImage(ref, 0, 0);
    const rd = rc.getContext("2d").getImageData(0, 0, w, h).data;
    const sums = [0, 0, 0], diffs = [[], [], []];
    for (let i = 0; i < w * h; i++) for (let ch = 0; ch < 3; ch++) { const dd = Math.abs(out[i * 4 + ch] - rd[i * 4 + ch]); sums[ch] += dd; diffs[ch].push(dd); }
    res.mean = sums.map(s => +(s / (w * h)).toFixed(3)); res.p99 = diffs.map(a => { a.sort((x, y) => x - y); return a[Math.floor(a.length * 0.99)]; });
  }
  window.__verify = res; window.__done = true;
  $("drop").hidden = true; $("work").hidden = false;
  $("before").width = $("after").width = w; $("before").height = $("after").height = h;
  $("before").getContext("2d").putImageData(new ImageData(beforePixels, w, h), 0, 0); $("after").getContext("2d").putImageData(new ImageData(out, w, h), 0, 0);
  setStatus("verify: " + JSON.stringify(res));
})();
