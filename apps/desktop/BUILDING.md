# Development

Run the dev server without env validation or auth:

```bash
SKIP_ENV_VALIDATION=1 bun run dev
```

This skips environment variable validation and the sign-in screen. Desktop chat also falls back to local-only session bootstrap in this mode, so you can test chat/streaming without the cloud API as long as you have local model credentials configured.

# Release

When building for release, make sure `node-pty` is built for the correct architecture with `bun run install:deps`, then run `bun run release`.

# Linux (AppImage) local build

From `apps/desktop`:

```bash
bun run clean:dev
bun run compile:app
bun run package -- --publish never --config electron-builder.ts
```

Expected outputs in `apps/desktop/release/`:

- `*.AppImage`
- `*-linux.yml` (Linux auto-update manifest)

# Linux auto-update verification (local)

From `apps/desktop` after packaging:

```bash
ls -la release/*.AppImage
ls -la release/*-linux.yml
```

If both files exist, packaging produced the Linux artifact + updater metadata that `electron-updater` expects.

# Windows (NSIS) local / CI build

This fork supports an unofficial Windows 10/11 x64 build. See
[`docs/windows-desktop.md`](../../docs/windows-desktop.md) for install notes,
unsigned-installer / SmartScreen limitations, release tagging (`windows-v*`),
and the rolling `windows-latest` auto-update feed.

From `apps/desktop` on a Windows machine (or GitHub `windows-latest`):

```powershell
bun run install:deps
bun run prebuild
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
$env:TARGET_PLATFORM = "win32"
$env:TARGET_ARCH = "x64"
$env:GITHUB_REPOSITORY = "christopheraaronhogg/superset"
bun run scripts/run-electron-builder.ts --publish never --win --x64
```

Expected outputs in `apps/desktop/release/`:

- `Superset-<version>-x64.exe` (NSIS)
- `latest.yml` (Windows auto-update manifest)
- optional `*.blockmap`
