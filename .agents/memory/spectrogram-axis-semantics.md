---
name: Spectrogram axis semantics
description: How the two stacked audio channels should map to frequency and level rulers.
---

Keep a synchronized frequency ruler for each of the two stacked channel panes, but a single continuous level ruler across the graph. During pan, render fixed-value labels at their changing screen positions rather than changing values at fixed screen positions.

**Why:** Each channel pane independently displays the same low-to-high frequency interval. A single continuous frequency ruler across both would assign incorrect frequencies to one channel, unlike the shared color-level range. Stationary labels made both drags feel unresponsive even when the displayed range changed.

**How to apply:** For new spectrogram gestures, anchor frequency input to the pane under the pointer while updating both panes together. Anchor level input to the whole graph. Preserve the interval during pan, and reposition label ticks to follow the content.