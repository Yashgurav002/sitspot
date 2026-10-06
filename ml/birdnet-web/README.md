# BirdNET in the browser (T12-A)

**Verdict: works.** The official BirdNET V2.4 model runs on-device in a Web Worker with TensorFlow.js and gives the same scores in Node (WASM/CPU) and in headless Chromium (WASM, WebGL, CPU). Audio never leaves the device. It has **not yet been run on a real phone**: battery and per-window time on a phone are still unmeasured.

## Path chosen

Option (a): an existing TF.js build. Nothing was converted.

- `birdnet-team/BirdNET-Analyzer` at tag **v1.5.1** (commit `3f726d6`) ships `checkpoints/V2.4/BirdNET_GLOBAL_6K_V2.4_Model_TFJS/`. It contains a Keras layers-model with a custom `MelSpecLayerSimple` layer (raw audio in, mel spectrogram computed in-graph), plus a graph-model location/season "mdata" model. Later tags removed it.
- The official BirdNET Live PWA (`birdnet-team/real-time-pwa`, MIT code) serves the **byte-identical** `model.json` and adds a fast WebGL STFT kernel. We ported that kernel.
- Our change: on CPU and WASM, tfjs's generic `tf.signal.stft` took **~49 s per window**, so the STFT is now a plain-JS radix-2 FFT (`stftRealJS`, ~ms). It is unit-tested against a naive DFT and gives scores identical to tfjs's STFT to 3 decimals.

Reproduce: `python ml/birdnet-web/fetch_model.py` (stdlib only; downloads from raw.githubusercontent with 12 parallel connections, then copies the tfjs WASM binaries from `node_modules`). The files are gitignored.

## Files (`apps/web/public/birdnet/`)

| File | Size |
| --- | --- |
| `model.json` + `group1-shard{1..13}of13.bin` (audio model, FP32) | 0.9 MB + 51.3 MB |
| `labels.json` (6522 × `"Scientific name_Common Name"`, index-aligned with the output) | 0.3 MB |
| `mdata/model.json` + 8 shards (location/season model, loaded lazily only if `speciesAt` is called) | 29.5 MB |
| `wasm/tfjs-backend-wasm{,-simd,-threaded-simd}.wasm` | 1.2 MB |
| **Total** | **~83 MB** (the phone downloads ~53 MB, or ~82 MB with `speciesAt`) |

The worker bundle (tfjs + wasm backend + our code) is ~3.1 MB unminified.

## Licence

- **Models: CC BY-NC-SA 4.0**, per the BirdNET-Analyzer README ("educational and research purposes are considered non-commercial"). The real-time-pwa README says CC BY-SA 4.0 for the same files. We follow the stricter one (**non-commercial**) and must credit BirdNET (Kahl et al. 2021, *Ecological Informatics* 61:101236) in the app/DEV post.
- BirdNET-Analyzer and real-time-pwa code: MIT. tfjs: Apache-2.0.

## Model spec

- **Input:** `[batch, 144000]` float32. That is 3 s of mono audio at **48 kHz**, raw samples (the layer normalises to [-1, 1] itself).
- **Output:** `[batch, 6522]`, already **sigmoid** (the last layer is `Activation(sigmoid)`), so this is BirdNET's default sensitivity of 1.0. Includes ~10 non-bird classes (e.g. `Human vocal_Human vocal`, `Engine_Engine`, `Dog_Dog`).
- **Labels:** `labels.json`, `"Pycnonotus cafer_Red-vented Bulbul"`. Split on the first `_`. There are **no eBird species codes**.
- **Location model:** input `[[lat, lon, week]]`, where week is BirdNET's 48-week year (4 per month, `-1` = all year). Output is an occurrence score per label. BirdNET's default cutoff is 0.03. At Vasai (19.39, 72.84), week 37: 224 species.

## Results: real clips

Clip 1 is "Red-vented bulbul male song recorded in August 2013 at Sangli" (Wikimedia Commons, Sharadapte, **CC BY-SA 4.0**), 14.9 s, 4 windows. Run with `node ml/birdnet-web/run_node.mjs <clip>`:

```
[0-3s]  Red-vented Bulbul 0.928 | Red-whiskered Bulbul 0.165 | Indian White-eye 0.075
[3-6s]  Red-vented Bulbul 0.912 | Red-whiskered Bulbul 0.068 | Indian White-eye 0.010
[6-9s]  Mottled Wood-Owl 0.198 | Indian Golden Oriole 0.079 | Blue Ground Dove 0.040   (gap in song)
[9-12s] Red-vented Bulbul 0.853 | Red-whiskered Bulbul 0.031 | Indian White-eye 0.023
top-5 over clip: Red-vented Bulbul 0.928, Mottled Wood-Owl 0.198, Red-whiskered Bulbul 0.165,
                 Indian Golden Oriole 0.079, Indian White-eye 0.075
```

At the 0.5 threshold, all 3 bulbul windows are reported correctly, with no false positives.

Clip 2 is "Pycnonotus cafer - Red-vented Bulbul XC129368" (Wikimedia Commons / xeno-canto, Sudipto Roy, **CC BY-SA 3.0**), 114 s, 38 windows, with the location filter at Vasai. Top-5: Red-vented Bulbul 0.997, House Crow 0.876, House Sparrow 0.270, Indian Golden Oriole 0.215, Spot-breasted Fantail 0.189.

- The House Crow detection (one window, 36–39 s) is plausible background in an Indian recording, but we have not verified it by ear.
- **Without** the location filter, "Yellow-vented Bulbul" reached **0.684** in one window. That species is not in India; the location filter removes it. **Use a regional filter.**

## Inference time per 3-s window (desktop: Windows, Node 24 / Playwright Chromium)

| Where | Backend | Load + warm-up | Per window |
| --- | --- | --- | --- |
| Node | wasm | 0.5 s | median **153 ms** (n=38) |
| Node | cpu, with tfjs STFT (before the fix) | 95 s | ~107 s |
| Node | cpu, with JS STFT | — | median 2.0 s |
| Headless Chromium worker | wasm | 1.6 s | **~340 ms** |
| Headless Chromium worker | webgl (SwiftShader = *software* GL, not representative) | 3.8 s | ~700 ms (first window 3.3 s) |
| Headless Chromium worker | cpu | 6.1 s | 2.7–5.4 s |

All backends give the same top-3 (identical to 3 decimals). Reproduce with `node ml/birdnet-web/browser_bench.mjs <clip> webgl wasm cpu`.

## Known limitations / to do

1. **Not yet measured on a phone.** Expect wasm to be 3–6× slower than desktop (~1–2 s/window): fine for a 3-s cadence, but battery is unknown (benchmark 9). Chrome's CPU throttling does not apply to workers, so it couldn't be emulated.
2. **First load is ~53 MB.** Cache it (HTTP cache or a service worker) before the user is outdoors on mobile data.
3. **Cadence:** if a window takes longer than 3 s (e.g. the cpu fallback on a slow phone), skip windows rather than queue them.
4. **Regional filter:** the spec's eBird `spplist` returns eBird codes, but the labels use scientific names. Map codes to scientific names via the eBird taxonomy API, or use `speciesAt()` (BirdNET's own location model, offline).
5. The resampler is linear with no anti-alias filter. That's fine for 44.1k→48k; avoid big downsamples.
6. Benchmark 3 (precision on 30 labelled clips) is **not done yet**. `run_node.mjs` is the harness for it.
