# Unofficial Windows Desktop Build

This fork ships an **unofficial** Windows 10/11 **x64** build of Superset Desktop, anchored to upstream stable `desktop-v1.15.1`.

It is **not** an official Superset product release and is not affiliated with, endorsed by, or supported by Superset, Inc.

License remains **Elastic License 2.0 (ELv2)**. See `LICENSE.md`. Upstream project: https://github.com/superset-sh/superset

## What you get

- NSIS installer (`.exe`), per-user install
- `latest.yml` auto-update manifest (points at **this fork’s** GitHub releases when built with `GITHUB_REPOSITORY` set)
- Optional `.blockmap` (when electron-builder emits it)
- `SHA256SUMS.txt`

## Remaining limitation: unsigned installer

Unless a Windows Authenticode signing certificate is configured in CI (`CSC_LINK` / related secrets), the installer is **unsigned**. Windows SmartScreen may show a warning on first download/launch. **Do not** use a self-signed certificate as a substitute for real signing.

This fork intentionally keeps unsigned packaging explicit and functional rather than faking trust.

## Install

1. Download the `Superset-*-x64.exe` asset from this fork’s `windows-v*` GitHub release.
2. Run the installer (per-user; optional “reset local data” checkboxes on reinstall).
3. Sign in with your normal Superset cloud account (`app.superset.sh` / `api.superset.sh`).

## Release (maintainers)

Tags of the form `windows-v*` trigger [`.github/workflows/release-desktop-windows.yml`](../.github/workflows/release-desktop-windows.yml), which builds on `windows-latest`, runs smoke checks, and publishes a **normal (non-prerelease)** GitHub release with installer + manifest + checksums.

```bash
git tag windows-v1.15.1
git push origin windows-v1.15.1
```

Or run the workflow manually via `workflow_dispatch`.

## Local packaging (Windows machine)

Prerequisites: Bun, Visual Studio Build Tools 2022 (MSVC v143 x64/x86 + Spectre libs), Windows 10/11 SDK.

```powershell
bun install --frozen --ignore-scripts
bun run --cwd apps/desktop install:deps
bun run --cwd apps/desktop prebuild
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
$env:TARGET_PLATFORM = "win32"
$env:TARGET_ARCH = "x64"
$env:GITHUB_REPOSITORY = "christopheraaronhogg/superset"  # fork updater metadata
bun run --cwd apps/desktop scripts/run-electron-builder.ts --publish never --win --x64
```

Installer: `apps/desktop/release/Superset-<version>-x64.exe`

## Runtime notes

- Pty control sockets use Windows named pipes (`\\.\pipe\superset-ptyd-…`).
- Process cleanup uses `taskkill.exe /T /F` where POSIX signals are not available.
- Shell launch understands `cmd.exe`, PowerShell, and Git Bash paths.
- Packaged builds sanitize local `localhost` URLs to production cloud defaults unless `SUPERSET_DESKTOP_ALLOW_LOCAL_BUILD_URLS=1`.

## Provenance

Windows runtime and packaging behavior is ported from the community reference branch `windows-port/windows-native-port` (commits `61132970ec3f`, `b930f6267dbf`) onto stable `desktop-v1.15.1`, without pulling unreleased upstream `main` product changes.
