# OmniOCR — Master Engineering Specification

**Version 1.0 · Document owner: engineering · Status: implemented and measured**

---

## 1. Purpose and scope

OmniOCR is an offline desktop application that converts document images into
accurate, **structurally faithful** text. It targets the case that general OCR
tools handle worst: originals that are faint, blurred, low-resolution, skewed,
photographed at an angle, stained, speckled, or physically damaged — while
losing nothing on clean originals.

Two properties define the product:

1. **Recovery.** The engine adapts its own effort to the damage in front of it,
   recognises the same page several ways, and fuses the evidence.
2. **Structure.** Output is rebuilt from a layout model — headings, paragraphs,
   reading order, columns, lists, tables, running heads — not emitted as a flat
   stream of characters.

### 1.1 In scope

- Multi-page PDF, plus PNG / JPEG / TIFF (multi-page) / BMP / WEBP / GIF / HEIC / HEIF
- Batch and folder ingest; unattended processing of long documents
- Searchable PDF, DOCX, HTML, Markdown, plain text, hOCR, JSON, CSV output
- Depth-assisted capture for phones that record a depth or disparity map
- Fully offline operation; no document ever leaves the machine
- macOS (Apple silicon) and Windows (x64) desktop builds

### 1.2 Out of scope (v1)

- Handwriting recognition (the engine is trained for printed text)
- Non-Latin scripts in the *invisible PDF text layer* (recognition works; see §9.3)
- Cloud sync, collaboration, server deployment

---

## 2. Requirements

### 2.1 Functional

| ID | Requirement |
|----|-------------|
| F1 | Ingest PDF and common raster formats, including multi-page PDF and TIFF |
| F2 | Detect and reuse an existing PDF text layer rather than re-recognising it |
| F3 | Detect the page within a photograph and correct perspective |
| F4 | Correct orientation (0/90/180/270°) and residual skew |
| F5 | Restore faint, blurred, noisy, stained and speckled pages before recognition |
| F6 | Recognise each page through multiple restoration variants and fuse the results |
| F7 | Reject recogniser output that is not plausibly text |
| F8 | Reconstruct document structure: headings, paragraphs, lists, columns, tables, running heads |
| F9 | Apply lexicon-gated correction that can never overwrite a word already read correctly |
| F10 | Export searchable PDF with an invisible text layer aligned to the visible glyphs |
| F11 | Export DOCX/HTML/MD/TXT/hOCR/JSON/CSV preserving the structure model |
| F12 | Use a camera depth map, when present, for page segmentation and curl flattening |
| F13 | Install additional Tesseract language packs on demand |
| F14 | Expose per-page diagnostics: quality metrics, chosen variants, timings, corrections |

### 2.2 Non-functional

| ID | Requirement | Status |
|----|-------------|--------|
| N1 | No network access required for recognition | Met — all models bundled |
| N2 | No native compilation; identical engine on macOS and Windows | Met — WASM only |
| N3 | A pathological page must not stall the application | Met — per-variant timeout with worker replacement (§5.8) |
| N4 | Memory must stay bounded on large scans | Met — 12 MP working ceiling, explicit Mat lifetimes (§5.9) |
| N5 | UI must remain responsive during recognition | Met — engine runs in a dedicated worker |
| N6 | Accuracy must be measurable and regression-gated | Met — deterministic suite, §10 |

---

## 3. Architecture

### 3.1 Process model

```
┌───────────────────────────────────────────────────────────────────┐
│ Main process (Node)                                               │
│  · window & lifecycle          · omni:// privileged scheme        │
│  · file dialogs and disk I/O   · language pack installer          │
│  · macOS depth helper (Swift binary, spawned per file)            │
└───────────────┬───────────────────────────────────────────────────┘
                │ contextBridge (no Node in the renderer)
┌───────────────▼───────────────────────────────────────────────────┐
│ Renderer (Chromium)                                               │
│  · ingest: pdf.js / UTIF / libheif → page bitmaps                 │
│  · UI, page viewer, structure and diagnostics views                │
│  · exporters: pdf-lib, docx, HTML/MD/TXT/hOCR/JSON/CSV            │
└───────────────┬───────────────────────────────────────────────────┘
                │ postMessage, bitmaps transferred zero-copy
┌───────────────▼───────────────────────────────────────────────────┐
│ Engine worker (dedicated Web Worker)                              │
│  · OpenCV (WASM): profiling, geometry, restoration                │
│  · Tesseract pool (WASM): N recognition workers + 1 OSD worker    │
│  · fusion, layout analysis, table reconstruction, correction      │
└───────────────────────────────────────────────────────────────────┘
```

**Why this split.** Decoding (pdf.js, HEIC, TIFF) needs browser APIs and is
cheap; recognition is expensive and must never block the UI. Putting the engine
in a worker and shipping only bitmaps across the boundary keeps the interface
responsive on an 8 GB laptop, and means the engine has no DOM dependency.

**Why WASM rather than native binaries.** A native Tesseract/OpenCV build would
be several times faster, but would require per-platform compilation, per-platform
packaging of shared libraries, and code signing of native dylibs. The WASM path
gives one engine that behaves identically on macOS and Windows, packages as plain
files, and cannot break on a user's machine because of a missing system library.
The cost is roughly 5–8× native recognition time, which §11 quantifies.

### 3.2 The `omni://` scheme

WASM cores, traineddata, the lexicon and application code are served over a
privileged custom scheme registered as `standard`, `secure`, `corsEnabled`,
`supportFetchAPI` and `stream`.

This exists because `file://` in Chromium is not a valid fetch origin: WASM
instantiation, `importScripts` in a worker, and traineddata loading would all be
blocked. Hosts are mapped explicitly (`app`, `node`, `tessdata`, `userlang`),
paths are normalised, and any path escaping its root is refused. In packaged
builds, paths inside `app.asar` are rewritten to `app.asar.unpacked` so binary
assets stream from real files.

### 3.3 Module map

| Path | Responsibility |
|------|----------------|
| `electron/main.js` | Lifecycle, protocol, IPC, depth helper, language installer |
| `electron/preload.js` | The entire renderer-visible API surface |
| `src/ingest.js` | PDF/TIFF/HEIC/raster decode; PDF text-layer extraction |
| `src/engine-client.js` | Promise RPC to the engine worker |
| `src/ui/*` | Application shell, page viewer, overlays, diagnostics |
| `src/exporters/*` | PDF, DOCX, and the text-family exporters |
| `src/workers/engine.js` | Worker entry point and message dispatch |
| `core/cvbridge.js` | OpenCV loading, Mat lifetime helpers, BMP encoder, 3×3 matrix maths |
| `core/quality.js` | Degradation profiling and tier classification |
| `core/geometry.js` | Page detection, rectification, rotation, deskew, content guard |
| `core/restore.js` | Restoration primitives and variant planning |
| `core/ocr.js` | Tesseract worker pool, timeouts, OSD |
| `core/ensemble.js` | Line/word fusion, plausibility scoring, garbage rejection |
| `core/layout.js` | Columns, paragraphs, headings, lists, running heads |
| `core/tables.js` | Ruled and unruled table reconstruction |
| `core/postprocess.js` | Lexicon-gated text repair |
| `core/lexicon.js` | Word membership, frequency ranking, confusion model |
| `core/depth.js` | Depth acquisition and depth-assisted geometry |
| `core/pipeline.js` | Per-page orchestration and the escalation loop |
| `native/macos-depth/main.swift` | Depth/disparity extraction from HEIC/JPEG |
| `test/*` | Corpus, degradation model, harness, scoring |

---

## 4. Data model

A recognised page is the single currency of the system.

```jsonc
{
  "index": 0, "name": "report.pdf — page 3",
  "width": 2480, "height": 3508, "dpi": 300,
  "profile": { "tier": "degraded", "sharpness": 41.2, "noiseSigma": 7.8,
               "contrast": 63.1, "componentHeight": 18, "estDpi": 348,
               "skew": -3.42, "foreignMarkScore": 0.31, "speckRatio": 0.44 },
  "rotation": 90,
  "geometrySteps": [ { "op": "rectify", "quad": [[..]] }, { "op": "deskew", "deg": -3.42 } ],
  "transform": { "toCanonical": [9 numbers], "toOriginal": [9 numbers] },
  "depth": { "used": true, "source": "native", "kind": "disparity", "quad": true, "curl": true },
  "lines":  [ { "text": "...", "conf": 94.1, "bbox": {}, "bboxOriginal": {}, "words": [...] } ],
  "blocks": [ { "type": "heading", "level": 2, "column": 0, "bbox": {}, "text": "..." } ],
  "tables": [ { "bbox": {}, "rows": 7, "cols": 4, "ruled": true, "cells": [[...]] } ],
  "attempts": [ { "level": 0, "psm": "3", "variants": ["gray","otsu"], "score": 0.91 } ],
  "variantsRun": [ { "id": "clahe-sauvola", "scale": 1, "psm": "3", "conf": 88.4, "ms": 9210 } ],
  "corrections": [ { "from": "reoognition", "to": "recognition", "rule": "confusion" } ],
  "rejected": [ { "text": "le Lar SE | ||", "conf": 31.2, "score": 0.28 } ],
  "confidence": 93.7, "score": 0.94, "timings": { }
}
```

### 4.1 The coordinate contract

Geometric correction composes into a single 3×3 matrix mapping **original page
pixels → canonical (corrected) pixels**. Its inverse is stored alongside, and
every line and word carries both `bbox` (canonical) and `bboxOriginal`.

This is what makes structure preservation real rather than nominal: exports that
overlay the corrected page use canonical boxes, while anything that must refer
back to the untouched original — hOCR, JSON, downstream tooling — gets true
original-page coordinates. Rotations, perspective rectification and fine deskew
are all folded into the same matrix, so no stage can silently desynchronise the
geometry from the text.

---

## 5. Recognition pipeline

### 5.1 Ingest and the born-digital fast path

PDF pages are rasterised with pdf.js at the requested density (200/300/400/600
dpi), clamped so no page exceeds 40 MP.

Before recognising, the page's own text layer is examined. If it contains at
least 40 characters at a plausible density, that text is used directly: exact
characters, exact positions, zero recognition error. **Re-recognising a
born-digital PDF can only lose information**, so the engine never does. Structure
analysis and table detection still run, so a digital PDF still gains headings,
reading order and tables. Scanned PDFs expose either no text layer or a few junk
glyphs, and fall through to full recognition.

### 5.2 Degradation profiling

All measurements are taken at a fixed working resolution (1500 px long edge).
This is deliberate: it makes every threshold meaningful regardless of whether the
input is a 150 dpi fax or a 600 dpi archival scan, and it makes profiling cost
constant rather than quadratic in scan resolution. Size-derived values are
converted back to original pixels.

| Metric | Method | Drives |
|--------|--------|--------|
| Sharpness | Variance of the Laplacian (16-bit) | Unsharp amount, tier |
| Noise σ | Median-residual, ×1.4826 | Denoise strategy, tier |
| Ink/paper contrast | Otsu split, mean of each population | Faintness, boost variant |
| Illumination spread | σ of a large-scale blur | Flattening, tier |
| Character height | Median height of text-shaped connected components | **Working scale** |
| Skew | Length-weighted median angle of smeared text lines | Deskew |
| Foreign-mark load | Ink fraction in oversized blobs | Despeckle aggressiveness |
| Speck ratio | Fraction of components of ≤3 px | Despeckle aggressiveness |
| Component count | Total connected components | Speckle-field guard |
| Inverted | Median grey below 100 | Polarity inversion |

A weighted score classifies the page as `clean`, `moderate`, `degraded` or
`severe`, which selects the variant plan.

**Ink/paper contrast, not global spread.** A global percentile spread is
meaningless on a text page — 95 % of pixels are paper, so p5–p95 reports ~7 on a
perfectly crisp page. Splitting at Otsu and comparing the ink and paper
populations measures what "faint" actually means. This was a measured bug, not a
theoretical concern: before the fix, clean pages were classified `moderate` and
paid for unnecessary variants.

### 5.3 Geometry

1. **Page detection.** Brightness segmentation on a wide-span
   illumination-flattened copy: a page is a bright quadrilateral on a darker
   surface. The largest component's **convex hull** is reduced to four corners
   by `approxPolyDP` at progressively looser tolerances, falling back to the
   minimum-area rectangle. Canny-contour detection is the fallback.

   Three details were each required by a measured failure:
   - *Wide-span flattening* — lamp falloff otherwise pushes a whole corner below
     the threshold, and that corner gets cropped off the page.
   - *Convex hull* — a shadowed corner excluded from the bright component is
     restored, because paper is convex.
   - *Multiple epsilons* — a single tolerance frequently yields a 5- or 6-gon,
     and the page is then never rectified at all.

2. **Content guard.** Before any quad is accepted, the engine measures how much
   *text-sized* ink falls outside it and refuses crops that would discard more
   than 2 %. A mis-detected boundary is the most damaging thing geometry can do —
   it deletes content before the recogniser ever sees it — so detection is never
   trusted unconditionally. The ink map is built from a flattened image, because
   under a shadow the text and the shadow are equally dark and a raw threshold
   merges them into one blob that hides the very loss being checked for.

3. **Orientation.** Tesseract OSD (legacy engine + `osd.traineddata`) on a
   downscaled, flattened copy; applied only above a confidence floor.

4. **Deskew.** Coarse angle from length-weighted text-line orientation, refined
   by maximising the gradient energy of the horizontal projection profile over
   ±4° at 1° then 0.25° resolution.

### 5.4 Restoration variants

The engine does not bet on one enhancement. It builds a set of variants and lets
§5.6 decide which was right — per line and per word.

Primitives: illumination flattening (background estimated on a small copy and
scaled back — a direct large-kernel blur on a 300 dpi page costs seconds, this
costs milliseconds), CLAHE, percentile level normalisation, unsharp masking,
median/bilateral denoise, Otsu / adaptive-Gaussian / **Sauvola** binarisation,
isolation-aware despeckling, stroke repair, stroke thinning, and resampling.

Sauvola is computed from separable box filters in float32 rather than the
textbook double-precision integral images: at page resolution those integrals are
~140 MB each and exhausted the WASM heap on speckled scans.

| Variant | Recipe | Recovers |
|---------|--------|----------|
| `gray` | flatten → levels | Clean and near-clean pages; the LSTM prefers greyscale |
| `otsu` | flatten → Otsu | Crisp bitonal originals |
| `clahe-sauvola` | flatten → CLAHE → denoise → Sauvola → despeckle | Faint, stained, unevenly lit |
| `sharp-adaptive` | flatten → denoise → unsharp → adaptive → despeckle | Soft focus, low contrast |
| `boost` | flatten → strong CLAHE → denoise → unsharp → tight Sauvola → hard despeckle → repair | Washed-out, third-generation photocopies |
| `gray-soft` | flatten → CLAHE → denoise | Escalation: preserves detail binarisation destroys |
| `thin` | flatten → CLAHE → Sauvola → thin → despeckle | Over-inked, smudged, bled |
| `raw` | none | Escalation control: proves restoration is not hurting |

**Working scale.** Tesseract's LSTM wants glyphs in a specific pixel range.
Below ~14 px median component height accuracy falls away; above ~40 px it gains
nothing and costs time quadratically. So small text is upscaled towards 21 px and
oversampled scans are *downscaled*. This single rule cut clean-page time from
32.6 s to 9.8 s with no accuracy change — the engine had been enlarging pages
that were already large enough.

**Despeckling by company, not size.** Dust and legitimate punctuation overlap in
size, so size alone cannot separate them. What separates them is context: a full
stop sits on a text line beside letter-sized neighbours; a speck sits alone. The
engine indexes letter-shaped "anchor" components by row band and removes small
components with no anchor within 3.5 character widths. Before this change the
minimum-area threshold was ~2 px against 9–25 px specks and removed nothing —
pages of dust survived into the recogniser and were read as text.

### 5.5 Recognition

A pool of Tesseract LSTM workers (default 3, sized from CPU count) recognises the
variants concurrently. Images are handed over as uncompressed 8-bit BMP, which
Leptonica reads directly — skipping PNG compression saves 200–400 ms per variant
— with the DPI written into the header so Tesseract's own size heuristics agree
with the engine's.

Page segmentation modes escalate along a ladder (`3` auto → `6` uniform block →
`4` single column → `11` sparse) as effort increases.

### 5.6 Fusion

Each variant sees the page differently: one recovers faint strokes but fuses
characters, another separates characters but drops light ones. Fusion recovers
text that no single variant read correctly.

1. Boxes are rescaled to canonical coordinates.
2. The variant with the best aggregate line quality becomes the reference.
3. Reference lines are matched to lines from other variants by box overlap.
4. Each candidate is scored: `0.50·confidence + 0.27·lexicality + 0.23·structure`.
5. With three or more candidates, words are aligned horizontally and voted on,
   with a lexicon bonus — this is where `rn`→`m` class errors are repaired.
6. Lines only some variants found are recovered, unless they clash geometrically
   or duplicate text already present. Containment is checked as well as equality:
   variants routinely disagree about where a line ends, and without that check
   the leftover halves reappear as repeated fragments.

### 5.7 Rejecting invented text

On a speckled or stained page the recogniser will confidently emit text where
there is none. Such lines are simultaneously low-confidence, non-lexical and
structurally implausible, while genuinely faint text fails at most one of those
tests — so rejection requires two independent failures. Runs of `| I l / _ —`
with no words (scratches, fold lines, table rules) are rejected outright.

Rejected lines are retained in the result for inspection, never silently dropped.

Measured effect on the `severe` case: **89.8 % → 8.9 % character error rate.**

### 5.8 Adaptive escalation

```
level ← 0
repeat
    plan   ← variants(profile, level)          # new variants only
    round  ← recognise(plan, psm[level])
    fused  ← fuse(all rounds so far)
    score  ← Σ lineScore·length / Σ length
    if score ≥ target                  : stop   # good enough
    if level > 0 and Δscore < 0.004    : stop   # escalation stopped paying
    level ← level + 1
until level > maxLevel
```

| Effort | Target score | Max level | Max variants | PSM ladder |
|--------|--------------|-----------|--------------|------------|
| Fast | 0.80 | 0 | 2 | 3 |
| Balanced (default) | 0.88 | 2 | 4 | 3, 6 |
| Maximum | 0.95 | 4 | 8 | 3, 6, 4, 11 |

Hard pages get more compute; easy pages do not pay for it.

**Timeouts are structural, not defensive.** Tesseract's layout analysis degrades
badly on images with very large blob counts: one heavily speckled variant was
measured at **8.6 minutes** for a single page. Every recognition call is bounded
(90 s default); on timeout the worker is destroyed, replaced, and the variant is
dropped from the ensemble. Combined with the speckle guard — pages carrying more
than 12 000 ink fragments are never upscaled and always get aggressive
cleaning — that page now completes in 12.7 s.

### 5.9 Memory discipline

OpenCV Mats are manually freed; a scope guard releases a whole stage even when it
throws. Two rules exist because they were violated and caused hard failures:

- **No inline scalar Mats.** `cv.add(x, new cv.Mat(rows, cols, CV_32F, scalar), y)`
  leaks ~35 MB per call at page resolution. Affine constants are folded into
  `convertTo` instead. This was the direct cause of an out-of-memory abort.
- **A hard pixel ceiling.** No recognition pass processes more than 12 MP.

---

## 6. Structure reconstruction

- **Columns** — coverage-weighted vertical projection; interior gutters with text
  on both sides split the page. Pages whose lines are mostly full width are never
  split, so a single-column page cannot be mis-segmented.
- **Line typing** — height relative to the page median, boldness, centring and
  capitalisation classify headings (four levels), list items and body text.
- **Paragraphs** — breaks on vertical gap, type change, size change or indent.
- **De-hyphenation** — a hyphen at a line end is removed only if the joined form
  is in the lexicon, so `co-operate` survives while `regolith-` is rejoined.
- **Running heads** — single short blocks in the top/bottom 7.5 % become headers,
  footers or page numbers, and are emitted as real Word headers/footers.
- **Reading order** — column, then vertical, then horizontal position.

### 6.1 Tables

*Ruled* tables are recovered from their printed rules: morphological extraction
of long horizontal and vertical runs, closure of scanner-induced breaks,
projection to row/column separators, then cell assignment by word centroid.
Detection runs on a downscaled copy (≈10× cheaper; rules survive downscaling).

*Unruled* tables are recovered from the whitespace columns the text itself forms:
runs of closely spaced lines whose word-start positions cluster into consistent
columns, subject to a whitespace-gap test that prevents ordinary paragraphs from
being read as tables.

Both produce a real row/column grid, so tables survive into DOCX, HTML and CSV
as tables rather than as run-together text.

---

## 7. Text repair

Correction is gated so it cannot damage correct text:

- A token is rewritten **only** when the original is not in the lexicon, the
  replacement is, and the recogniser was not already confident.
- Confusion candidates are generated one substitution at a time from an explicit
  OCR confusion model (`rn`↔`m`, `cl`↔`d`, `0`↔`O`, `1`↔`l`, …). No free-form
  edit distance search, so no invented words.
- Numeric context repair fixes `O`→`0`, `l`→`1`, `S`→`5` inside tokens that are
  clearly numeric (amounts, dates, account numbers), and the reverse for
  alphabetic words — each only when the result is a lexicon word.
- Run-together tokens are split only when both halves are common words.
- Ligatures and Unicode forms are normalised.

Every change is recorded with its rule and location, visible in Diagnostics, and
the whole stage can be disabled.

Lexicon: 379 941 word forms for membership, 46 982 frequency-ranked forms for
ranking corrections, plus domain vocabulary (invoicing, legal, medical,
educational, East African currency and place names).

---

## 8. Depth-assisted capture

Phones that record a depth or disparity map alongside the photo provide
something edge detection cannot: the page as a physical surface.

**Acquisition**, in order of preference:

1. **macOS native helper** — a small Swift binary reads the depth, disparity or
   portrait-matte auxiliary image from HEIC/HEIF and JPEG via ImageIO, and emits
   a float32 grid over a 16-byte header. Handles 16- and 32-bit float and 8-bit
   formats.
2. **Android Dynamic Depth** — base64 depth payload parsed from XMP
   (`GDepth:Data`), including multi-segment extended XMP. Pure JS, so it works on
   Windows too.
3. **Apple MPF** — the secondary JPEG image, size-checked so a second full
   photograph is not mistaken for a depth map.
4. **Sidecar** — a depth image supplied beside the original.

**Use:**

- **Page segmentation** — the dominant depth mode is the page surface; its mask
  yields corners that are reliable even against cluttered backgrounds where
  brightness segmentation fails.
- **Curl flattening** — column-wise depth is converted to a cumulative arc length
  and the image is resampled so equal output distance represents equal real-world
  distance, straightening text that bends near a bound spine.

Depth is always advisory: if the map is too flat or too noisy to be informative,
the engine falls back to ordinary geometry. Absence of depth is not an error.

**Verification status.** The extraction helper builds and correctly reports
absence on images without depth data; the depth *consumption* path is exercised
end-to-end by the harness with a synthetic depth map. The macOS positive path
(a real Portrait-mode capture) was not exercised, as no depth-bearing photograph
was available on the build machine.

---

## 9. Output

| Format | Fidelity |
|--------|----------|
| **Searchable PDF** | Restored page image + invisible text layer, positioned per word |
| **DOCX** | Headings, lists, tables, alignment, real headers/footers, page size |
| **HTML** | Semantic (reflowable) or layout mode (absolute positioning over the scan) |
| **Markdown** | Headings, lists, GFM tables |
| **Text** | Reading order preserved, tables column-aligned |
| **hOCR** | Standard `ocr_page`/`ocr_carea`/`ocr_par`/`ocr_line`/`ocrx_word` with confidences |
| **JSON** | Full structure model, quality metrics, variants, corrections, both coordinate spaces |
| **CSV** | Every detected table |

### 9.1 The invisible text layer

Text is drawn in PDF rendering mode 3 (invisible) over the page image. Each word
gets a font size derived from its glyph box and a **horizontal scale factor** so
the invisible run matches the real word width — without it, selection drifts
progressively across a line and search highlights land in the wrong place.

### 9.2 Verification

Generated PDFs are verified by extracting their text with an independent tool
(`pdftotext`) and comparing against the engine's own output — see §10.4.

### 9.3 Known limitation

The invisible layer embeds DejaVu Sans (subset), covering Latin, Greek and
Cyrillic. Characters outside that coverage — CJK, Indic, Arabic — are recognised
and appear in every other export, but are omitted from the *PDF text layer*
only. Adding a CJK font would raise the installer by ~15 MB and is a packaging
decision, not an engine limitation.

---

## 10. Quality assurance

### 10.1 Method

Accuracy is measured, not asserted. The harness renders documents from known
ground truth, degrades them in controlled ways, runs the **real engine** over the
result, and scores output against the exact source text using character error
rate (Levenshtein over normalised text) and word error rate (token-level
Levenshtein).

Degradations are driven by a **seeded** generator. Without a fixed seed two runs
produce different speckle and smudge patterns, and the suite cannot distinguish a
regression from a different dice roll.

### 10.2 Corpus

Five archetypes exercising different structural machinery: `article`
(headings + paragraphs), `invoice` (ruled table + totals), `twoColumn` (column
detection and reading order), `form` (label/value pairs and rules), `dense`
(small type, numbered clauses).

### 10.3 Degradation model

`clean`, `faint`, `blurred`, `pixelated`, `noisy`, `jpegArtefacts`, `skewed`,
`perspective`, `shadowed`, `smudged`, `foreignMarks` (dust, fibres, coffee ring,
staple shadow), `photocopyGeneration3`, `phonePhoto` (perspective + shadow +
blur + noise + JPEG), `severe` (eight simultaneous degradations), `worstCase`
(nine), and `beyondRecovery`.

`beyondRecovery` is deliberately past the point of physical recoverability —
0.3× resolution under a 2.6 px blur leaves no glyph strokes. Nothing can read it.
It is scored on **restraint**: the requirement is that the engine emits almost
nothing rather than inventing a page of text, and neither crashes nor hangs.
Returning nothing is the correct behaviour; returning confident fiction is not.

### 10.4 Results

See `docs/TEST-RESULTS.md` for the full measured matrix, regenerated by
`npm run harness`.

---

## 11. Performance

Measured on an Apple M1 (8 cores, 8 GB), A4 at 300 dpi (2480 × 3508), Balanced
effort, 3 recognition workers.

| Page condition | Variants | Time |
|----------------|----------|------|
| Clean | 2 | ~9–10 s |
| Moderate (noise, smudges) | 3 | ~13–20 s |
| Degraded (faint, shadowed) | 3–4 | ~25–45 s |
| Severe (eight degradations) | 4–7 | ~13–30 s |
| Born-digital PDF text layer | 0 | < 1 s |

Optimisations that mattered, with measured effect:

| Change | Effect |
|--------|--------|
| Stop upscaling pages already large enough | 32.6 s → 9.8 s |
| Illumination background at reduced scale | ~8 s → ~30 ms per call |
| Table detection on a downscaled binary | 8.6 s → 0.5 s |
| Profiling at fixed working resolution | 11 s → 0.55 s |
| BMP instead of PNG handoff | −200–400 ms per variant |
| Speckle guard + per-variant timeout | 528 s → 12.7 s worst observed page |

---

## 12. Security and privacy

- **Offline by default.** Recognition never touches the network. The only
  outbound request the app can make is an explicit, user-initiated language-pack
  download from the Tesseract data repository.
- **Renderer isolation.** `contextIsolation` on, `nodeIntegration` off; the
  renderer's entire privileged surface is the explicit preload API.
- **Path containment.** Every `omni://` request is normalised and refused if it
  escapes its declared root; language codes are pattern-validated before use in a
  path or URL.
- **CSP.** Restricted to the app's own scheme plus the `wasm-unsafe-eval` and
  `blob:` worker sources that WASM and Tesseract require.
- **No telemetry.** Nothing is collected or transmitted.

---

## 13. Packaging and distribution

| Target | Artefact | Built on |
|--------|----------|----------|
| macOS arm64 | `OmniOCR-1.0.0-arm64.dmg` | macOS (local or CI) |
| Windows x64 | `OmniOCR Setup 1.0.0.exe` (NSIS) + portable `.zip` | Windows CI runner |
| Linux x64 | `AppImage` | CI |

WASM cores, traineddata, lexicon and fonts are unpacked beside the asar archive
so they can be streamed as real files. The macOS depth helper is compiled during
packaging and bundled in `Resources`.

Windows installers are produced on a Windows runner rather than cross-built:
electron-builder cannot produce an NSIS installer from macOS without Wine, and a
native runner matches what users install. A portable Windows `zip` **can** be
produced from macOS, since it only repacks platform binaries.

Builds are unsigned. macOS users must right-click → Open on first launch (or
clear the quarantine attribute); Windows shows a SmartScreen prompt. Signing
requires an Apple Developer ID and an Authenticode certificate.

---

## 14. Limitations

1. **Handwriting** is out of scope; the models are trained on printed text.
2. **PDF text layer beyond Latin/Greek/Cyrillic** — see §9.3.
3. **Depth positive path unverified on this machine** — see §8.
4. **WASM speed** — roughly 5–8× slower than native Tesseract, traded for
   identical cross-platform behaviour and zero native dependencies.
5. **Physically destroyed originals** cannot be recovered; the engine is designed
   to say so by producing nothing rather than inventing text.
6. **Table detection** targets rules and whitespace alignment; irregular merged
   cells and nested tables degrade to text blocks.

---

## 15. Extension points

- Additional recognisers can join the ensemble by emitting the normalised line
  structure from `core/ocr.js`; fusion is engine-agnostic.
- New restoration variants are declarative recipes in `core/restore.js`.
- New exporters consume the page model and need no engine knowledge.
- The escalation controller's targets and ladders are data (`PROFILES`).

---

## 16. Interface contracts

**Preload API** (the complete renderer surface): `info`, `openFiles`,
`saveDialog`, `readFile`, `writeFile`, `stat`, `reveal`, `pathFor`,
`extractDepth`, `listLanguages`, `installLanguage`, `harness.*`.

**Engine worker messages:** `init`, `page`, `languages`, `depth-parse`,
`terminate` → `ready`, `result`, `progress`, `log`, `error`.

---

*End of specification.*
