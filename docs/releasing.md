# Releasing

Releases use [Changesets](https://changesets.dev). `@openfleet-tools/cli` and `@openfleet-tools/create` are a `fixed` group, so they always share a version. `@openfleet-tools/create` installs `@openfleet-tools/cli@^<its own version>` by default.

1. In a PR that changes a package, run `pnpm changeset` and commit the generated file. CI warns (without failing) when a PR has no changeset; use `pnpm changeset --empty` for changes that need no release.
2. On every push to `main`, [`release.yml`](../.github/workflows/release.yml) opens or updates a **Version Packages** PR that bumps the versions and writes the `CHANGELOG.md` files.
3. Merging that PR publishes both packages to npm with [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, provenance, no `NPM_TOKEN`) and creates GitHub Releases.

## One-time setup

Trusted publishing can only be configured for a package that already exists on npm. So each package needs one manual placeholder publish at `0.0.0` before the first CI release. The repo is at `0.0.0` with an initial `minor` changeset, so the first Version Packages PR releases `0.1.0`.

1. Publish placeholders from an empty directory, signed in with `npm login` as a member of the `openfleet-tools` npm org:

   ```sh
   cd "$(mktemp -d)"
   for name in @openfleet-tools/cli @openfleet-tools/create; do
     printf '{"name":"%s","version":"0.0.0","description":"Placeholder. See https://openfleet.tools","repository":{"type":"git","url":"git+https://github.com/yashicon21/openfleet-tools.git"}}\n' "$name" > package.json
     npm publish --access public
   done
   ```

2. For **each** package on npmjs.com, go to **Settings → Trusted publishing → GitHub Actions** and enter:
   - Organization or user: `yashicon21`
   - Repository: `openfleet`
   - Workflow filename: `release.yml`
   - Environment: `npm` (the `publish` job waits for a maintainer to approve it)

   A new trusted publisher must complete a publish within 2 days, or it expires and must be recreated. So configure it just before you merge the first Version Packages PR.

3. Optional, recommended: in each package's **Settings → Publishing access**, choose **Require two-factor authentication and disallow tokens**.
4. In the GitHub repo, under **Settings → Actions → General**, enable **Allow GitHub Actions to create and approve pull requests**.
5. The initializer used to be published as `create-openfleet`. Deprecate it so users are pointed to the new name:

   ```sh
   npm deprecate create-openfleet "Renamed to @openfleet-tools/create — use: npm create @openfleet-tools"
   ```

`pnpm release` builds and runs `changeset publish` for a manual local publish. CI does not use it.

---

[← README](../README.md) · [How it works](./how-it-works.md) · [Greenfield projects](./greenfield.md) · [Workspace](./workspace.md) · [Commands](./commands.md) · [Models and hosts](./models-and-hosts.md) · [Run report](./run-report.md) · [Limitations and troubleshooting](./limitations-and-troubleshooting.md) · **Releasing**
