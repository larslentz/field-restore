---
name: TypeScript validation shim
description: Workaround for a workspace executable-permission quirk when checking TypeScript.
---

The workspace package-manager shim for the TypeScript compiler can lack execute permission even when the compiler package itself is usable.

**Why:** A package script failed with `tsc: Permission denied` while invoking the compiler's JavaScript entry point with Node succeeded; this is a launcher permission issue, not a type error.

**How to apply:** If the typecheck script fails before TypeScript starts, invoke the installed compiler entry point with Node and the same project configuration. Do not treat the script's permission error as a failed type check.