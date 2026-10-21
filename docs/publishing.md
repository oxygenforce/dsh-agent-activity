# Publishing and releasing

The repository is a self-contained DeepSeek Harness bundle: the same directory is
the npm package, the bundle patch, and the installable plugin. Nothing is built —
`lib/*.js` and `lib/client.js` are shipped as authored.

## Checks before a release

```bash
node scripts/check-manifest.mjs        # manifest, exports, patch row, icon, locales
node --test tests/activity.test.mjs    # projection fold against synthetic events
node --check lib/index.js && node --check lib/activity.js && node --check lib/client.js
```

CI (`.github/workflows/ci.yml`) runs the same three steps on Node 22 and 24.

## Install into a profile

```
plugin_manager action=install_bundle target=/absolute/path/to/dsh-agent-activity
```

That links the checkout into the profile and inserts the bundle row. `application: applied`
means the Host half is live. A new bundle's client half reaches an open Web UI after a
page reload; the client bundle is read from disk per request, so client-only edits need
a reload, not a restart.

## Release

```bash
pnpm pack --pack-destination dist        # dist/dsh-agent-activity-<version>.tgz
git tag v<version> && git push origin v<version>
# create the release, then upload the tarball as an asset:
#   POST /repos/oxygenforce/dsh-agent-activity/releases
#   POST https://uploads.github.com/repos/oxygenforce/dsh-agent-activity/releases/<id>/assets?name=dsh-agent-activity-<version>.tgz
```

Download URL pattern (pinned tag, required by community indexes):

```
https://github.com/oxygenforce/dsh-agent-activity/releases/download/v<version>/dsh-agent-activity-<version>.tgz
```

`package.json` `files` decides what the tarball contains; keep the patch, locales,
icon and every runtime file in that list, and `scripts/check-manifest.mjs` will fail
if a listed file disappears.

## Community index

`docs/awesome-entry.yml` is the entry for the community catalog (Dsh Get /
`awesome-dsh-plugin`). Submit it as `data/plugins/oxygenforce__dsh-agent-activity.yml`
once the repository has the `dsh-plugin` topic and is at least 24 hours old. Update the
`tarball` URL when the version changes.
