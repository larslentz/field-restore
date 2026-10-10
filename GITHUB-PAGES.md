# Hosting Field Restore on GitHub Pages

The web app runs locally in the browser and can be hosted as a static site. Its
audio processing does not require the API server. The Pages workflow also builds
the unsigned Windows installer and includes it in the published site; the
installer is regenerated during the workflow and added to the Pages artifact.

## Setup

1. Push this repository to GitHub, keeping the default branch named `main`.
2. In the repository, open **Settings → Pages** and set **Build and deployment
   → Source** to **GitHub Actions**.
3. Open **Actions → Publish Field Restore to GitHub Pages → Run workflow**.
   Leave **Deploy the completed site to GitHub Pages** unchecked for the first
   run. This builds the site and installer and checks the installer checksum,
   without publishing the site.
4. After reviewing a successful build, run the workflow again and check the
   deploy option to publish it.

The workflow is manual-only; pushing commits does not publish the site. It
does not create Git tags or GitHub Releases. The default Pages path is inferred
from the repository name, and account-site repositories ending in
`github.io` use `/`. For a custom domain, set the optional workflow input
`base_path` to `/`.

The installer is approximately 107 MiB. It stays out of Git history and is
generated as part of the Pages deployment. GitHub Pages permits sites up to
1 GB and has a soft 100 GB monthly bandwidth limit, so this approach is best
for modest download traffic.
