# Halation

CineStill-style halation for digital photos, calibrated on real film scans. Two front ends over one model:

- **`halation.py`**: command-line tool. Python 3, Pillow and numpy only.
- **`site/`**: the same maths in the browser, no build step, no server. Live at [halation.moe](https://halation.moe/),
  and the same files run offline from a local folder. Everything runs on the user's device; nothing is uploaded.

The red ring CineStill 800T and 400D put round bright lights comes from the missing anti-halation (remjet)
layer: light passes the emulsion, reflects off the base, and re-exposes the red-sensitive layer from behind.
This tool reproduces the measured ring rather than a generic glow. There is also a black-and-white preset
for Kodak 5222 (CineStill BwXX, Double-X, Cine 800), whose glow is soft and neutral rather than a ring.

## Quick start

```bash
pip install pillow numpy
python halation.py in.jpg out.jpg                              # 800T preset
python halation.py in.jpg out.jpg --preset 400d --report       # 400D, then measure the ring vs film
python halation.py in.jpg out.jpg --preset bwxx                # black and white
python halation.py in.jpg out.jpg --auto --crop-compare c.jpg  # fit strength to the film's ring on this frame
python halation.py in.jpg out.jpg --ladder ladder.jpg          # one crop at four strengths, pick by eye
python halation.py folder --out-dir done --preset 800t         # batch
```

Browser: open `site/index.html`, or serve the repository root with `python -m http.server` and visit
`/site/`. Browser specifics are at the end of this file.

## Presets

| preset | ring radius (% of long edge) | gain | strength | threshold | character |
|---|---|---|---|---|---|
| `800t` | 0.30 | 5 | 0.35 | 0.88 | softer ring, carries further, faint tail round big clipped areas |
| `400d` | 0.20 | 7 | 0.42 | 0.90 | tighter, peaks higher, gone within 0.6% |
| `subtle` | 0.25 | 3 | 0.20 | 0.92 | |
| `heavy` | 0.40 | 9 | 0.75 | 0.82 | poster-child |
| `bwxx` | 0.40 | 3 | 0.30 | 0.86 | **black and white.** Converts to luminance, adds a soft wide neutral glow, then removes the broad veil so contrast is kept. Separate code path from the colour presets |

Knobs, most useful first:

- `--strength`: how much light is added. 0.2 faint, 0.35 default, 0.6+ obvious.
- `--auto`: fits strength per frame so the output's ring matches the film's. Capped at 1.0 and says so when it
  hits the cap (frames shot through a bloom filter usually do). Frames with no clipped light get no ring,
  which is also what film does.
- `--threshold`: what counts as a light source (linear 0-1). Raise toward 0.95 if white paint or signs pick up
  a ring; lower to 0.8 if lamps do not.
- `--radius-pct`: ring radius as a percentage of the long edge, so settings transfer between a 50 MP file and
  a web export.
- `--gain`: how quickly small sources reach a full-strength ring. High values look like a hard outline.
- `--color`, `--tail`: ring colour and the three-component kernel. `--deveil` (mono only): how much of the broad
  veil to remove, 0.7 default.
- `--report`: measures the output's ring and prints it next to the film's numbers.

## What the film does, and how the presets were fitted

`halation_calibrate.py` takes rings of pixels at increasing distance from clipped light sources and reports
mean R, G, B per ring. Over the colour corpus (36 frames with clipped sources, median over frames):

| distance from source edge, % of long edge | 0.2 | 0.3 | 0.4 | 0.6 | 0.8 | 1.0 | 1.3 |
|---|---|---|---|---|---|---|---|
| **400D** red/green ratio | 1.40 | 1.49 | 1.25 | 1.10 | 1.04 | 1.06 | 0.98 |
| **800T** red/green ratio | 1.26 | 1.28 | 1.27 | 1.16 | 1.06 | 1.07 | 1.17 |
| 500T (has remjet, control) | 1.05 | 1.10 | 1.10 | 1.14 | 1.09 | 1.06 | 1.13 |

Real halation is a tight red ring: it peaks 0.2 to 0.6% of the frame width from the source edge and is gone
by about 1%. 400D is not weaker than 800T where there is a hard light; its ring is narrower and peaks higher.
It looks subtle because daylight frames rarely have a clipped source, and without one there is no ring on
either stock. 800T spreads further, and round large clipped areas its red carries past 1% of the frame,
which the third kernel component is for.

Black and white (Kodak 5222: no remjet, but a grey-base anti-halation layer), glow above the far field as a
fraction of remaining headroom, 48 frames:

| distance, % of long edge | 0.2 | 0.3 | 0.6 | 1.0 | 1.3 | 2.0 |
|---|---|---|---|---|---|---|
| film, point-source frames | 0.44 | 0.37 | 0.27 | 0.20 | 0.17 | 0.10 |
| film, pushed +2/+3 only | 0.63 | 0.52 | 0.32 | 0.19 | 0.16 | 0.09 |
| `bwxx` on a clean synthetic frame | 0.40 | 0.36 | 0.27 | 0.17 | 0.14 | 0.07 |

Soft, neutral and about twice the reach of the colour ring. The `bwxx` preset also high-passes the glow
(ring minus 0.7 x a blur of itself at 3% of the frame): the measured broad lift is real on film, but on a digital
frame whose blacks are already set it reads as lost contrast, and the film workflow takes it back out at the
scan's black point anyway. Local glow stays, the veil goes, tone percentiles return to the original.

Measured profiles are in `calibration/` (JSON and text). Fits were done by hand against a synthetic black frame
with clipped discs so lens bloom could not confound them.

## Model

All in linear light. For each of R and G (blue never halates: the film's yellow filter layer absorbs it):

```
energy = smoothstep(threshold, 1, channel)
spread = w1 * gauss(energy, r) + w2 * gauss(energy, k2 r) + w3 * gauss(energy, k3 r)
ring   = 1 - exp(-gain * spread)
```

`r` is `radius_pct` of the long edge. Sources themselves take no halo (`receive = 1 - smoothstep(threshold -
0.25, threshold + 0.02, max(R, G, B))`), so cores stay white. The ring is **added**, not screened: halation is
extra exposure, the same amount of light everywhere, which makes it vivid against black and gentle inside
bright glow, as on film. Blur is three box passes on a reduced grid; a 50 MP frame takes a few seconds in numpy
and the same maths ports to a shader. `site/halation-core.js` is a second implementation of these equations
and agrees with the Python to within 8-bit rounding (see "Verify" below for the check).

## Known limits

- A JPEG has already clipped, so the tool cannot tell a street lamp ten stops over from white paint that just
  reaches 255. Reflective markings and white signs sometimes get a ring film would not give them. `--threshold`
  is the lever; working from raw headroom would fix it properly and is not built.
- Frames shot through a bloom or mist filter already glow, so the same added light reads weaker than on film.
  `--ladder` and your eye beat the numbers there.
- The exported JPEG is re-encoded by the browser (quality 0.97); use PNG when that matters.

## License

MIT. The calibration data in `calibration/` is measured from the author's own film scans and is covered by
the same license; the scans themselves are not in the repository.

## Layout

| path | purpose |
|---|---|
| `halation.py` | the tool |
| `halation_calibrate.py` | ring measurement, for refitting on more scans |
| `calibration/` | measured film profiles the presets were fitted to |
| `site/` | the browser version, static files |

## The browser version

Static files only: `index.html`, `styles.css`, `app.js` (decode with colour conversion off, Web Worker
orchestration with a main-thread fallback, split compare, export with EXIF and ICC carried over, Web Share on
phones), `worker.js`, `halation-core.js` (the model, streamed per pixel so a 50 MP export needs only the RGBA
buffer plus two small float grids), `_headers`, `robots.txt`, and `test/` with the synthetic parity assets.

### Opening it from disk

Double-clicking `index.html` works, but differently: Chrome refuses to start a Web Worker from a `file://`
page and Firefox blocks the worker's `importScripts` (every `file://` script is its own origin). `app.js`
detects both (creation error, worker error event, or no reply within 6 s) and falls back to running the
same maths on the main thread; the page is just unresponsive while a render runs. Served over http
(`python -m http.server`, or any static host) the worker is used. `?noworker=1` forces the fallback for testing.
Before this fallback existed, a `file://` open died at `new Worker` in Chrome (so drag-and-drop fell through
to the browser and Choose did nothing) and hung at "processing" in Firefox.

### Verify after changing `halation-core.js` or a preset

```bash
python -m http.server 8765        # from the repository root
```

Open `http://localhost:8765/site/index.html?src=test/synthetic_sources.png&ref=test/synthetic_ref_800t.png&preset=800t`
and read the status line: mean abs diff should be about 0.01/255, p99 0. Regenerate the reference PNGs with
`python halation.py site/test/synthetic_sources.png site/test/synthetic_ref_<preset>.png --preset <preset>` if a preset changes.

### Design notes

Deliberately not the usual near-black + orange photo-tool skin (xere.my/halation-lab, among others, already
owns that): warm darkroom blacks (`#141210`), a film-red accent (`#d9442f`) used only for selection and the
slider, a cream primary button, serif headings from the system stack (Iowan Old Style / Palatino / Georgia,
no webfont), hairline cards with a red left rule instead of dashed boxes. All of it is in `styles.css`
custom properties at the top; swap the palette there.

A Codex UX/design pass (2026-11-06) drove these changes: a visible status region outside the workspace
for opening/decode errors; the viewer is a keyboard-operable slider (arrows, Home/End, space) and only
captures horizontal drags so the page still scrolls on phones; 44 px handle and touch targets; small text
raised to AA contrast; export locks the controls and says what is happening; copy trimmed; Strength above
the preset grid; Reset restores the last chosen preset. Not done, by design: zoom / 100% inspection in the
browser (exports are full resolution; the preview is scaled).
