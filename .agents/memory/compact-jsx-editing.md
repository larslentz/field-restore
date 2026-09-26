---
name: Compact JSX editing
description: A safer approach to editing densely compressed JSX in the Field Restore interface.
---

When changing a dense one-line JSX return, expand the affected component into readable nesting before making substantive edits.

**Why:** A small copy change in compressed markup took multiple attempts because rewriting the line accidentally removed an enclosing element, and a syntax error surfaced only at the very end of the line.

**How to apply:** When the surrounding structure cannot be checked at a glance, reformat the local JSX block first and validate with a TypeScript check before continuing with behavioral work. Avoid repeating full-line replacements with small manual differences.