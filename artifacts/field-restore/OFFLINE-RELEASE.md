# Windows offline release

## Current status: unsigned 1.0.0; applicable native Windows 11 checks reported passing

An unsigned Windows x64 installer is available at
`public/releases/Field-Restore-1.0.0-Windows-x64-Setup.exe`. Download it from the
app's Install dialog. The release metadata and `SHA256SUMS.txt` describe the
final built installer. Users can verify its SHA-256 before running it.

This is a Linux-produced, unsigned cross-build. It is **not digitally signed**,
its publisher is **not verified**, and the user reports that the native Windows
applicable acceptance checks passed on Windows 11. Their PowerShell checksum
evidence matches this exact installer. The user confirmed that 1.0.0 is the
first and only released installer, so cross-version update testing is **not
applicable to this release**, not a failure or a passing update test.
Same-version reinstallation and retention were reported passing.
`nativeWindowsTested` is true for this installer on the strength of those
user-performed checks. No native Windows 10 results were supplied.
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
- Disconnect networking, launch the installed app, import WAV/RF64 and FLAC,
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

## Verification record — 2026-10-04

Candidate: `Field-Restore-1.0.0-Windows-x64-Setup.exe` (version 1.0.0).
SHA-256 of the current installer bytes:
`450306122cc53387f0bd9a49286813ad4cb38884f9f55379ec86c3def989c142`.

The installer hash was computed in the Linux workspace and matches both
`windows-release.json` and `SHA256SUMS.txt`. This checks file consistency only;
it is not evidence that the installer works on Windows.

Published-download check: the normal full-file GET returned HTTP 500 even
though HEAD returned HTTP 200. Downloading all 111,770,380 bytes using 4 MiB
HTTP range requests succeeded and produced the expected SHA-256 above.
The user subsequently reported that downloading and testing on Windows worked.
The earlier full-response failure has not been independently shown to be
resolved; the ranged-download check is not native Windows acceptance evidence.

The user performed testing on their own machine and identified the operating
system as Windows 11. They selected all four acceptance groups as passing:
fresh installation/offline audio workflow, original-source protection,
persistence across offline restarts, and update/uninstall retention.
Their additional update evidence was: “Tested update and passed.”
No failures or skipped checks were reported.

These are user-reported results, not tests executed or observed by the agent.
The Windows edition/build was not provided. The user subsequently supplied a
Windows PowerShell screenshot hashing
`Field-Restore-1.0.0-Windows-x64-Setup.exe` with SHA-256. The displayed hash
matches the candidate hash above (hexadecimal case is immaterial), tying the
reported tests to this exact installer. No personal filesystem path is retained
in this record.

In response to the request for the earlier installed version, the user supplied
“1.0.0”. This is recorded as a same-version reinstall with reported retention,
not a confirmed update from a distinct earlier release. Cross-version update
testing was not performed; the earlier grouped PASS report is not evidence of
cross-version updating.

The user then clarified: “There is not earlier installer. 1.0.0 is the only one
released.” This establishes that it is the first released installer, rather
than an older release merely being unavailable to the tester. The cross-version
update check is therefore **not applicable** to 1.0.0. No further tests are
requested for this release. A future release must verify updating from 1.0.0.

The candidate is unsigned; signer, signing-certificate thumbprint
and signing timestamp are not applicable to this unsigned-preview test.
Signature verification remains a separate requirement for a signed release.

| Required check | Actual result |
| --- | --- |
| Native Windows installation and launch | Reported PASS by user on Windows 11; installer SHA-256 confirmed by PowerShell screenshot |
| Offline WAV/RF64 and FLAC import, editing, playback, audio/report export | Reported PASS by user |
| Original-source hashes unchanged; source overwrite prevented | Reported PASS by user |
| Project, edits, settings and source access/relinking across offline restarts | Reported PASS by user |
| Same-version reinstall; project/settings retention | Reported PASS by user for 1.0.0 over 1.0.0 |
| Update from a distinct earlier installed release; project/settings retention | NOT APPLICABLE — 1.0.0 is the first and only released installer; no predecessor exists |
| Uninstall removes shipped files, shortcuts and registration while retaining projects/settings, originals and unrelated files | Reported PASS by user |

`nativeWindowsTested` is **true** for the exact candidate hash above, based on
user-reported native Windows 11 passes for every applicable acceptance check
and the supplied checksum evidence. Windows 10 has not been tested in this
record. Signing remains deferred; the installer remains unsigned.

For the next genuine release, save a project/settings in 1.0.0, close the app,
install the new candidate, and verify retention plus offline source access,
playback and export. Record both release identities and actual results before
marking that new installer tested. Do not fabricate a predecessor or label a
same-version reinstall a cross-version update. Do not substitute Wine or Linux
browser results, upload binaries or attach a remote runner without approval.