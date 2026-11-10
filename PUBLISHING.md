# Publishing

This repository is prepared for a GitHub-first release. The package name is
`dsh-cloud-memory`; the npm name was available at preparation time.

## 1. Replace placeholders

`dsh-memory/package.json` points at the `AiLunSin` GitHub account:

```json
"repository": { "url": "git+https://github.com/AiLunSin/dsh-cloud-memory.git" },
"homepage": "https://github.com/AiLunSin/dsh-cloud-memory#readme",
"bugs": { "url": "https://github.com/AiLunSin/dsh-cloud-memory/issues" }
```

If the repository is created under a different account or name, update all
three URLs before publishing.

## 2. Create the GitHub repository

```bash
git init
git add .
git commit -m "feat: initial dsh-cloud-memory plugin"
git branch -M main
git remote add origin git@github.com:AiLunSin/dsh-cloud-memory.git
git push -u origin main
git tag v1.0.0
git push origin v1.0.0
```

Do not commit `node_modules/`, `.cache/`, `.tmp/`, or the 570MB ONNX model.
They are covered by `.gitignore`; the model is reproducible with
`embedding-service/download-model.mjs`.

Create a GitHub Release from `v1.0.0`. Attach the npm tarball if you want a
one-file install artifact:

```bash
cd dsh-memory
npm pack
```

## 3. Verify a clean install

```bash
npm pack --dry-run
```

Then install the packed tarball or the GitHub source into a **clean** DSH
profile (not the development profile) and confirm:

- the bundle row is active;
- `memory_search` / `memory_write` / `memory_manage` are registered;
- the Memory page registers in `main` and `sidebar.panellist`;
- `npm test` passes from a fresh checkout.

## 4. Publish to npm (optional, for market index entries)

```bash
cd dsh-memory
npm publish --access public
```

Before publishing, confirm:

- `private` is `false` (already);
- `engines.dsh` matches the DSH runtime you tested;
- `license`, `repository`, `homepage`, `bugs`, and `keywords` are real;
- `npm pack --dry-run` contains only runtime files and docs.

## 5. Official DSH market/index

DSH's Discover page reads plugin indexes. An index entry installs an npm
version (`name@version`) or a commit-pinned Git source. Submit the published
package/version to the official index only after the GitHub release and a
clean-profile install have both been verified.

Useful details for an index entry:

- package name: `dsh-cloud-memory`
- bundle patch: `cordis.patch.yml`
- client platform: `web`
- icon: `icon.svg`
- locales: `locale/en.json`, `locale/zh.json`
- compatibility: `engines.dsh`
- detail document: `README.md` or `docs/USAGE.md`

## 6. Remaining product hardening

- Add a Config schema if you want a Plugin Manager form instead of YAML.
- Add real screenshots/GIFs to `docs/`.
- Add a security note for endpoint credentials and data retention.
- Keep `test:semantic` out of CI unless the CI runner starts an embedding
  service; it intentionally requires a real endpoint.
