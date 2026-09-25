---
name: Fixed spectrogram at short heights
description: Constraint discovered when keeping a spectrogram and optional actions visible in a short viewport.
---

In a fixed-height spectrogram workspace, reserve a bounded footer for optional actions but keep the primary action independently visible; allow variable-length guidance to scroll within its own space rather than wrapping the button onto another row.

**Why:** A generous reserved footer left too little height for a usable plot. Shrinking that footer alone let narrow-screen guidance wrap and push the main action entirely out of view.

**How to apply:** When adding new plot controls or messages, check both inactive and active states at short desktop and mobile heights. Constrain copy and error states inside the footer without letting them change the plot or statistics position, and check that the action remains visible without scrolling.