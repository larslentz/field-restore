# Windows offline release

## Current status: unsigned pre-release 1.0.0 with MP4 audio import; native Windows checks pending

An unsigned Windows x64 installer is available at
`public/releases/Field-Restore-1.0.0-Windows-x64-Setup.exe`. Download it from the
app's Install dialog. The release metadata and `SHA256SUMS.txt` describe the
final built installer. Users can verify its SHA-256 before running it.

This is a Linux-produced, unsigned cross-build. It is **not digitally signed**,
and its publisher is **not verified**. The product has not been publicly
released. The MP4-capable candidate replaces the preceding candidate in place;
no older installer is retained. `1.0.0` is a fixed internal packaging value,
not a new release or a claim of public release history.

`nativeWindowsTested` is **false** for the rebuilt installer. Earlier
user-performed Windows 11 checks covered different installer bytes and do not
validate the new MP4 decoder path. Fresh Windows 10/11 x64 checks are pending.
Cross-version update testing is not applicable because there is no publicly
released predecessor; same-version reinstall/retention still requires checking.
Windows may show an unknown-publisher or SmartScreen warning; functional
testing does not establish a verified publisher or guarantee download reliability.

The user chose to defer code signing. No certificate has been purchased, no
signing credentials have been requested or read, and no binary has been
automatically uploaded or published by this verification work. Signing remains
deferred. Do not describe this installer as signed or its publisher as verified.

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
- `nativeWindowsTested`: true only after all applicable acceptance checks below
  actually pass on native Windows for this exact release, with results and any
  justified not-applicable checks recorded. It does not claim testing on every
  supported Windows version or publisher verification.

The browser cannot verify Authenticode. The dialog describes metadata as such
and asks users to verify the Windows digital signature and checksum. Missing
publisher details do not silently hide the download or claim a verified
publisher. Signature status and native Windows test status are independent.
Signed installers can still receive SmartScreen reputation warnings.

## Native Windows acceptance gate

Use the printable [native Windows checklist](docs/windows-acceptance.html) to
run these checks locally and return evidence. The checklist itself is not
passing evidence. For the first released installer, cross-version updating is
not applicable because no earlier release exists. For later releases, inability
to obtain a genuine earlier installer leaves update testing blocked.

Record Windows version, release version, final installer hash, signer,
certificate thumbprint, timestamp and actual results. Until this is performed,
each item is **blocked / not run**, not passing:

- Fresh per-user installation on supported Windows; for signed candidates,
  verify installed app and uninstaller signatures and publisher.
- Disconnect networking, launch the installed app, import WAV/RF64, FLAC and AAC MP4,
  edit/play back and export playable audio plus reports.
- Hash original input files before/after editing and export. Confirm exports
  cannot overwrite an original, including when the source folder is selected.
- Save an editable project, close the app completely and restart offline.
  Verify edits/settings and persisted source access or explicit relinking.
- For releases with a genuine released predecessor, update an earlier installed
  release after saving/closing the app; verify project/settings retention and,
  for signed candidates, all updated signatures. Record this as not applicable
  for a confirmed first release; never fabricate a predecessor.
- Uninstall while preserving original recordings and user projects/settings.
  Confirm shortcuts/registration and shipped files are removed, and unrelated
  files in the installation directory remain.

Only after all applicable checks pass may `nativeWindowsTested` become true.
An unexplained omission or unavailable test environment is not a justified
not-applicable result. Signing alone, Linux browser tests, NSIS compilation and
inspection of bundled files do not satisfy this gate. Each new installer build
resets the flag to false; prior evidence does not transfer to new bytes.

## MP4 pre-release candidate

MP4 import reads the primary mono/stereo audio track locally using a bounded
Blob reader and the runtime's codec support. AAC is covered by browser tests.
There is no server upload, remote codec fetch, full-video JavaScript buffer,
video editing, or MP4 re-export. All MP4 recordings stay file-backed, including
short recordings. Edited audio exports as 32-bit float WAV. Lossy source audio
does not become lossless merely by exporting it as WAV.

Container timestamps are retained, with negative AAC priming excluded and
declared presentation duration respected. Range reads warm the decoder before
the requested range. Import verifies the beginning and end of the audio track;
this is not a complete integrity scan of every compressed packet. Unsupported
codecs/layouts and import failures leave the current project intact.

Synthetic fixtures and automated tests cover AAC video and audio-only MP4,
WAV export, saved-project verification/relinking, unsupported/no-audio/damaged
inputs, cancellation, bounded reads and sample-aligned ranged decoding.
The production offline test also imports and relinks MP4 while disconnected.

The build regenerates `windows-release.json` and `SHA256SUMS.txt` from the exact
new installer bytes. Those files are the checksum authority; no historical
checksum is reused here. A complete workspace download must match that hash.
Workspace/browser checks are not native Windows acceptance.

Native Windows installation, offline AAC import/playback/export, source
protection, saved-project relinking, same-version reinstall and uninstall
retention remain **not run** for these new bytes. Do not set
`nativeWindowsTested` true until those checks pass on the exact rebuilt binary.
Signing and publication remain separate, deferred actions.