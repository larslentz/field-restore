# Hosting Field Restore on GitHub Pages

The web app runs locally in the browser and can be hosted as a static site. Its
audio processing does not require the API server. The Pages workflow also builds
the unsigned Windows installer and includes it in the published site; the
installer is regenerated during the workflow and added to the Pages artifact.

## Setup

1. Push this repository to GitHub, keeping the default branch named `main`.
2. In the repository, open **Settings → Pages** and set **Build and deployment
   → Source** to **GitHub Actions**.
3. For the first deployment, open **Actions → Publish Field Restore to GitHub
   Pages → Run workflow** and check **Deploy the completed site to GitHub Pages**.
   This builds the site and installer, checks the installer checksum, and
   publishes the completed site.
4. After the first deployment, every push to `main` builds the site and
   installer and publishes them automatically, but only if the build succeeds.
   Pushes to other branches do not publish.

Manual workflow runs remain available. Leave **Deploy the completed site to
GitHub Pages** unchecked to build and verify without publishing, or check it to
publish. The optional `base_path` input overrides the inferred Pages path; set
it to `/` for a custom domain. Account-site repositories ending in `github.io`
use `/` automatically. The workflow does not create Git tags or GitHub Releases.

The first push that adds this workflow requires GitHub credentials with
permission to write workflow files. If GitHub rejects a Replit push because its
OAuth app lacks the `workflow` scope, use the repository-scoped token process
described here: create a short-lived fine-grained personal access token limited
to this repository, with **Contents: Read and write** and **Workflows: Read and
write**. Enter it through Replit Secrets, never in this workflow or a tracked
file. After pushing successfully, remove the secret and revoke the token.

For offline users, a new site version is picked up after all Field Restore
browser tabs and installed app windows are closed and the site is reopened.

The installer is approximately 107 MiB. It stays out of Git history and is
generated as part of the Pages deployment. GitHub Pages permits sites up to
1 GB and has a soft 100 GB monthly bandwidth limit, so this approach is best
for modest download traffic.
