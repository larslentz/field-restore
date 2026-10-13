# Operator manual source and PDF build

## Previous creation path

The repository originally shipped two static files in `public/`:
`operator-manual.html` and `Field-Restore-Operators-Manual.pdf`. No PDF generator
or package build step was checked in. The existing PDF's metadata identifies
HeadlessChrome 152 / Skia as its producer, with Letter pages and no browser
headers; the HTML already contains `@page` and `@media print` styling. The
original one-off command is not recorded in the repository.

## Repeatable creation path

Edit **only `public/operator-manual.html`** for manual content and print styling.
From the workspace root, run:

```sh
pnpm --filter @workspace/field-restore run build:manual
pnpm --filter @workspace/field-restore run test:manual
```

The generator uses the existing `@playwright/test` dependency to open the local
HTML in Chromium, wait for fonts, and print with the guide's CSS page size,
backgrounds, and print layout. It writes the PDF atomically, so a failed build
does not replace the previous download with a partial file. Source and output
paths are relative to the script, not the caller's working directory.

Replit's supplied `/repl/tools/bin/chromium` is used when present. On other
machines, install the Playwright browser once:

```sh
pnpm --filter @workspace/field-restore exec playwright install chromium
```

Linux hosts also need Chromium's system libraries (use Playwright's documented
`install --with-deps chromium` setup where supported). A compatible existing
browser can instead be selected with `CHROMIUM_PATH`. Missing browsers or render
errors fail the build explicitly. The tests additionally require Poppler's
`pdftotext`, as does the existing manual-guidance test.

`pnpm --filter @workspace/field-restore run build` regenerates the PDF **before**
Vite copies public resources. Offline caching and Windows packaging therefore
consume the same freshly generated PDF. The small PDF remains checked in to
support development downloads before a full build; commit it alongside HTML
changes. Do not edit the PDF separately.

## Public download contract

The filename and links are unchanged:

- Online guide: `/operator-manual.html`
- Download: `/Field-Restore-Operators-Manual.pdf`
- Built file: `dist/public/Field-Restore-Operators-Manual.pdf`

The HTML link is relative, and the app link uses its artifact base path, so
these resources also work when the app is mounted below a prefix. Verify a
complete GET of the PDF (not only HEAD), check for an `application/pdf` response
and `%PDF-` signature, and compare the downloaded bytes with the built file.
