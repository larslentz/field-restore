---
name: Wind crossover test timing
description: Timing clean-passage checks around automatic wind detector confirmation and release.
---

When measuring wanted low-frequency material in a clean passage after a gust, leave time for the detector to confirm idle and for the reduction envelope to finish releasing. An inactive detector callback does not mean its crossfade is already at zero.

**Why:** Crossover attenuation fades rather than stopping immediately when the gust ends, so a near-tail measurement can falsely report clean-passage damage.

**How to apply:** In wind DSP regression tests, assert detector transitions and place the clean measurement sufficiently after the idle transition; keep wind-overlap and clean-passage measurements separate.
