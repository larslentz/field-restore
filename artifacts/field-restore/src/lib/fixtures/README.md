# Outdoor wind regression fixture

## Provenance and permission

`wind-night-stereo.wav` is a two-second excerpt of an outdoor recording supplied
by its recordist, Lars Lentz. His description was: “Night recording with wind and
passing car.” His permission was: “Free for any use.” This permission covers the
fixture's use and redistribution here; it is not presented as a named Creative
Commons license. No location, equipment, or recording date is asserted.

Original upload: `0_261003_0040_excerpt_1791885104230.wav`, stereo 44,100 Hz,
32-bit IEEE float, 274.973061 seconds. Original SHA-256:
`8404fdc0614ff40705ac45578e6f06d986a9fee5a507b3d01b30b1c36e60f067`.
The approximately 97 MB upload is excluded from Git and deployment.

## Compact derivation

The fixture contains source seconds **35.000–37.000**, keeping both recorded
channels in their original order and at their original gain. This is a sustained
gust-dominated passage, with unequal levels between the microphones. It is not
claimed to contain an animal call or a passing car within these two seconds.

The only conversions are resampling to 24,000 Hz and quantizing to signed 16-bit
PCM (no normalization, denoising, mixing, or channel duplication). Duration:
2 seconds; channels: 2; frames: 48,000; size: 192,078 bytes. SHA-256:
`9d5a5c086c01054015a90ba6c856ba53a9cc0c00f226f817a09e2c3ecfe8a364`.

Recreate with FFmpeg (the original upload is needed; tests do not need FFmpeg):

```sh
ffmpeg -ss 35 -i 0_261003_0040_excerpt_1791885104230.wav \
  -t 2 -map 0:a:0 -ar 24000 -c:a pcm_s16le -map_metadata -1 \
  wind-night-stereo.wav
```

## What the test establishes — and what it does not

The user approved **hybrid** coverage because no real low-call recording was
available. `../wind-outdoor.test.mjs` adds reproducible 105–135 Hz gliding calls
with second and third harmonics, before, during, and well after the recorded
gust. The recording starts one second into the six-second test passage, with a
10 ms taper at each edge to avoid abrupt splice edges. These calls and the
wind-free intervals are synthetic, not recordings of real animal calls.

The tests compare 140, 300, and 700 Hz crossovers against a DC-corrected reference,
in memory and via bounded WAV reads at two non-window-aligned chunk sizes.
Background-only subtraction isolates the gust-overlap call response, **only
after asserting identical detector history through that probe**. Clean calls are
measured directly in the delivered output, without subtraction. The natural stereo
excerpt exercises unequal microphone levels. A separately labelled right-mic-only
variant routes the recorded left channel to the right test channel and leaves
the left call wind-free; it checks linked reduction and channel-swap symmetry.

In this one-mic mixture the call briefly produces an idle detector decision at
test second 2.0, and the gust is detected again at 2.1. The tests retain that
observation rather than assuming perfect wind classification. The overlap
measurement ends at 1.98, before those decisions differ from the background-only
render. Whole-passage memory/file parity includes the idle blip and both fades.

This covers real gust texture interacting with known wanted signals. It does
**not** establish real animal-call classification, natural call/gust overlap,
stereo spatial fidelity for a natural call, or microphone overload recovery.
The excerpt has headroom and is not an overload fixture. Do not describe these
tests as confirmation that arbitrary real low calls are protected.
