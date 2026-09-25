---
name: Harmonic spectral floors
description: Why low-frequency harmonic suppression cannot use fixed nearby-bin floor samples.
---

At common recording sample rates, a 2048-point FFT places 50/60 Hz harmonics only about two to three bins apart. Nearby spectral bins can therefore contain another, stronger harmonic rather than a clean background estimate.

**Why:** A fixed offset of five bins failed to reduce a weaker 180 Hz partial next to a stronger 120 Hz partial, despite working on widely separated 600/1200 Hz test tones.

**How to apply:** When estimating a harmonic floor, account for FFT resolution and exclude all selected neighboring harmonic lobes; test unequal-amplitude 50/60 Hz series at 44.1 and 48 kHz, not only widely spaced synthetic tones.