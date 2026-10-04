# Windows offline release

## Current status: unsigned installer ready to share

An unsigned Windows x64 installer is available at
`public/releases/Field-Restore-1.0.0-Windows-x64-Setup.exe`. Download it from the
app's Install dialog. The release metadata and `SHA256SUMS.txt` describe the
final built installer. Users can verify its SHA-256 before running it.

This is a Linux-produced, unsigned cross-build. It is **not digitally signed**,
its publisher is **not verified**, and it has **not been tested on native
Windows**. Windows may show an unknown-publisher or SmartScreen warning.
`nativeWindowsTested` remains false. Treat it as an unsigned preview build; don't
represent it as a verified or Windows-tested release.

The user chose to defer code signing. No certificate has been purchased, no
signing credentials have been requested or read, and no binary has been
automatically uploaded or published. The signing and native Windows verification
requirements below remain deferred; do not claim that either has passed.

## Prerequisites requiring approval

- Exact legal publisher name and an existing, publicly trusted code-signing
  identity approved for Field Restore. A self-signed development certificate is
  not a verified-publisher release.
- Approved signing mechanism: for example a hardware-backed certificate exposed
  through the Windows certificate store, or an approved managed signing service.
  Do not send private keys, certificate passwords or access tokens in chat.
  Keep keys with the signing provider/hardware; configure any needed credentials
  through the runner's secure credential mechanism.
- An accessible native Windows 10/11 x64 machine or approved Windows runner with
  Node, pnpm, NSIS and the Windows SDK signing tools, plus an interactive Windows
  environment for the acceptance checks below. Wine is not a substitute.
- Provider-supported RFC 3161 timestamp endpoint and signing authorization.

Do not select or purchase a certificate, attach a new remote runner, or upload
source/binaries without approval. Choose the signing implementation only after
these prerequisites are established.

## Signed build requirements

The current `electron-builder.cjs`, `desktop/installer.nsi` and
`scripts/build-windows.mjs` deliberately produce unsigned output. They must be
adapted to the approved signing mechanism before creating a signed release:

1. Build the complete offline runtime on native Windows with publishing disabled.
2. Sign the packaged desktop executable using SHA-256 Authenticode and an
   RFC 3161 timestamp with SHA-256. Fail the build on any signing error.
3. Sign the NSIS-generated uninstaller **before embedding it in the installer**,
   using NSIS's uninstaller-finalization hook and the approved signer. Signing
   only the app or outer installer does not sign `WriteUninstaller` output.
4. Sign the final installer after NSIS compilation, with the same approved
   publisher and timestamp policy.
5. Verify all three final signatures on Windows using the Authenticode policy
   (`signtool verify /pa /all /v`), checking chain trust, exact approved signer,
   signing-certificate thumbprint and timestamp. Check the installed uninstaller
   too, not only an intermediate build file. Retain local verification evidence.
6. Compute SHA-256 **after final signing**. Rebuild `SHA256SUMS.txt` and release
   metadata from the final bytes, never from an unsigned intermediate.
7. Keep signed output local pending the Windows acceptance checks and explicit
   publication approval. Do not use the current script's automatic copy into
   `public/releases` for an unverified signed candidate. Never auto-publish.

## Installation dialog metadata contract

`releases/windows-release.json` uses:

- `filename`: safe local `.exe` basename, no traversal or URL.
- `version`: nonempty string up to 40 characters.
- `sha256`: 64 hexadecimal characters for the final installer.
- `unsigned`: explicit boolean; `true` preserves the unsigned warning, `false`
  keeps a signed release downloadable.
- `publisher`: optional exact approved signer display name for signed releases.
  Populate from verified signing evidence, not a guessed app/organization name.
- `nativeWindowsTested`: true only after all acceptance checks below actually
  pass on native Windows for this exact release.

The browser cannot verify Authenticode. The dialog describes metadata as such
and asks users to verify the Windows digital signature and checksum. Missing
publisher details do not silently hide the download or claim a verified
publisher. Signature status and native Windows test status are independent.
Signed installers can still receive SmartScreen reputation warnings.

## Native Windows acceptance gate

Record Windows version, release version, final installer hash, signer,
certificate thumbprint, timestamp and actual results. Until this is performed,
each item is **blocked / not run**, not passing:

- Fresh per-user installation on supported Windows; verify installed app and
  uninstaller signatures and publisher.
- Disconnect networking, launch the installed app, import WAV/RF64 and FLAC,
  edit/play back and export playable audio plus reports.
- Hash original input files before/after editing and export. Confirm exports
  cannot overwrite an original, including when the source folder is selected.
- Save an editable project, close the app completely and restart offline.
  Verify edits/settings and persisted source access or explicit relinking.
- Update an earlier installed release after saving/closing the app; verify
  project/settings retention and all updated signatures.
- Uninstall while preserving original recordings and user projects/settings.
  Confirm shortcuts/registration and shipped files are removed, and unrelated
  files in the installation directory remain.

Only after all checks pass may `nativeWindowsTested` become true. Signing alone,
Linux browser tests, NSIS compilation and inspection of bundled files do not
satisfy this gate.