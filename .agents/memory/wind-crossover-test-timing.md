---
name: Wind crossover test timing
description: Timing clean-passage checks and validating causal references for automatic wind measurements.
---

When measuring wanted low-frequency material in a clean passage after a gust, leave time for the detector to confirm idle and for the reduction envelope to finish releasing. An inactive detector callback does not mean its crossfade is already at zero.

**Why:** Crossover attenuation fades rather than stopping immediately when the gust ends, so a near-tail measurement can falsely report clean-passage damage.

**How to apply:** In wind DSP regression tests, assert detector transitions and place the clean measurement sufficiently after the idle transition; keep wind-overlap and clean-passage measurements separate.

Subtracting a noise-only counterfactual render to isolate a wanted call is valid only if both renders have identical detector decisions throughout the causal history of the measured interval.

**Why:** Adding a wanted tonal call can briefly change automatic wind classification, even when the recorded noise is unchanged. That changes the reduction envelope, so subtracting independently gated outputs can misidentify reweighted noise as retained call audio.

**How to apply:** Confirm matching detector history through the end of each subtraction probe, not just the current active flag. Measure clean-call output directly after sufficient release, and test memory/stream parity on the actual mixture including any call-driven detector transitions.
