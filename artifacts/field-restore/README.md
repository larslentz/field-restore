# Field Restore

Field Restore is a standalone, local-first browser editor for conservative cleanup of mono, stereo, and binaural field recordings. Audio stays on the device, the imported source remains immutable, and edits are stored as a reversible processing chain until a WAV is rendered.

## Run

From the workspace root:

```bash
pnpm --filter @workspace/field-restore run dev
```

The managed Replit workflow supplies the required `PORT` and `BASE_PATH` values.

## Core workflow

1. Import an uncompressed WAV or load the locally synthesized stereo demo.
2. Inspect the waveform and signal statistics.
3. Drag across the waveform to make a precise time selection.
4. Add conservative processing modules to the non-destructive edit chain.
5. Bypass, duplicate, reorder, rename, or remove edits while comparing Original and Current playback.
6. Add markers and named regions for repair documentation.
7. Save the project locally.
8. Render a WAV and download the restoration report.

## Privacy and offline design

- No login, upload, analytics, telemetry, subscription, or server-side audio processing.
- Audio parsing, playback, analysis, editing, and export run in the browser.
- The original decoded channel data is never modified.
- Project metadata and a compact local project snapshot are stored in browser storage.
- A deterministic synthesized stereo demo is included and requires no network access.

## WAV support

### Large browser-download regression

The picker-free RF64 download test writes a file just over 4 GiB and is excluded from normal test runs. With at least 8 GiB free in the temporary directory, run:

```sh
cd artifacts/field-restore
RF64_BROWSER_DOWNLOAD=1 pnpm exec playwright test tests/rf64-browser-download.spec.ts --browser chromium --workers 1
```

It waits for the browser to finish the download, then reads only the header and three short sample ranges from the saved file; Playwright removes the download when the test context closes.

### Import

- RIFF/WAVE
- Integer PCM: 8, 16, 24, and 32 bit
- 32-bit IEEE float
- Mono and multichannel files are decoded without an automatic downmix

Compressed WAV codecs and non-WAV containers are rejected with a clear message.

### Export

- 32-bit IEEE float WAV
- Correct RIFF chunk lengths, little-endian samples, and channel interleaving
- Browser download fallback

The current prototype keeps the source sample rate and channel count. It does not silently downmix stereo or binaural material.

## Non-destructive edit chain

Processing is represented as ordered typed instructions. The app includes practical local implementations for gain, fades, broad EQ shaping, DC-offset correction, conservative hum reduction, wind/rumble control, region attenuation, and manual ambience blending. Edits can be enabled, bypassed, duplicated, reordered, renamed, and removed. Undo and redo operate on edit-chain snapshots.

Stereo channels receive the same timing and linked settings by default so channel alignment is preserved.

New imports and the demo source start with this linked chain:

1. Neutral gain
2. Automatic DC-offset removal
3. Low-rumble removal using a 55.5 Hz high-pass filter at Q 0.38, with an enabled +2 dB low-end shelf at 55 Hz and Q 0.4
4. Adaptive hum removal
5. Wind/rumble removal using a 100 Hz high-pass filter at Q 0.7
6. A combined 7-second fade in and 7-second fade out
7. Neutral output gain

The same chain is available under Local presets as **Common Field Recording Adjustments**.

## Statistics

Field Restore calculates browser-local true-peak estimates, integrated loudness, loudness range, and maximum short-term loudness for the full file and active selection. Loudness uses BS.1770-style K-weighting and absolute/relative gating; true peak uses 4× inter-sample interpolation. These are practical estimates rather than certified compliance-meter readings.

## Hum processing

The visible Static, Dynamic, and Adaptive modes document the intended restoration workflow and expose conservative controls. The current sample-domain processing is deliberately modest and does not claim to reproduce commercial spectral-repair or adaptive de-hum algorithms. Sustained insects, aircraft, water, road noise, and other environmental tones can be mistaken for hum; preview before export.

## Binaural and stereo handling

- Original channel count and sample alignment are retained.
- Processing settings are linked across channels by default.
- No automatic mono conversion is performed.
- Independent time-varying left/right tracking is intentionally avoided in the prototype because it can damage spatial coherence.

## Known limitations

- Project snapshots currently use browser local storage rather than a full IndexedDB blob store, so very long recordings may exceed storage limits.
- Advanced adaptive hum tracking is represented conservatively rather than as a commercial-grade frequency-tracking implementation.
- Export uses 32-bit IEEE float at the source sample rate and channel count; no normalization or dither is applied.
- Sample-rate conversion and certified true-peak/loudness compliance are not claimed.
- Browser memory limits determine the maximum practical file length.

## Accessibility

The interface includes keyboard-focus styling, labeled controls, readable technical values, tooltips, error states, and keyboard shortcuts for the core transport and history actions.