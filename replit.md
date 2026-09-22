# Field Restore

Field Restore is a local-first browser editor for conservative, non-destructive restoration of mono, stereo, and binaural field recordings.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/field-restore run dev` — run the Field Restore web app through its managed workflow
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Field Restore requires no backend, login, cloud database, or audio-upload service.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/field-restore/src/App.tsx` — editor shell and browser-local user workflows
- `artifacts/field-restore/src/lib/audio.ts` — WAV parsing/encoding and synthesized demo audio
- `artifacts/field-restore/src/lib/edit-chain.ts` — typed non-destructive processing model
- `artifacts/field-restore/src/lib/persistence.ts` — local project persistence
- `artifacts/field-restore/src/index.css` — visual system and responsive editor layout
- `artifacts/field-restore/README.md` — supported formats, workflow, and honest limitations

## Architecture decisions

- Audio never leaves the browser; the shared API and database are intentionally unused.
- Imported channel data is treated as immutable, and processing is replayed from an ordered edit chain.
- Stereo and binaural channels keep exact frame alignment and linked processing by default.
- Advanced measurements and hum detection are labeled as estimates instead of overstating certainty.
- The first build favors transparent, conservative sample-domain processing over simulated commercial spectral repair.

## Product

Import WAV files, inspect and select waveform ranges, compare Original and Current monitoring, add and manage restoration edits, work with markers/regions and presets, calculate practical statistics, save locally, and export a rendered WAV with a restoration report.

## User preferences

- Use Figtree for interface text and Space Mono for technical values.
- Keep the product restrained, technical, local-first, and honest about browser DSP limitations.

## Gotchas

- Do not add server-side audio processing, uploads, analytics, accounts, or cloud persistence.
- Never silently downmix stereo or binaural sources.
- Browser storage and memory limits must be surfaced for long recordings.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
