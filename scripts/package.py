"""Build the Chrome Web Store upload zip.

Includes ONLY the files Chrome needs to run the extension:
    manifest.json
    src/**
    vendor/**       — bundled libraries (lamejs.js etc.) referenced from src/
    icons/icon16.png, icon48.png, icon128.png
    LICENSE

Explicitly excludes:
    docs/        — GitHub Pages content + sample episode m4a files (90MB+)
    examples/    — workflow templates (users copy these into their own repo)
    IMPLEMENTATION_NOTES.md, README.md  — dev/repo docs, not for end users
    scripts/     — build scripts (this file etc.)
    icons/store-icon-128.png — only used in the Web Store listing form
    .git/, .gitignore, dist/  — repo / build artifacts

Output:
    dist/notebooklm-podcast-sync-v{version}.zip

Run from repo root:
    python scripts/package.py
"""
from __future__ import annotations

import json
import os
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

INCLUDE_FILES = ["manifest.json", "LICENSE"]
INCLUDE_DIRS = ["src", "vendor"]
INCLUDE_ICONS = ["icons/icon16.png", "icons/icon48.png", "icons/icon128.png"]


def collect() -> list[Path]:
    out: list[Path] = []
    for f in INCLUDE_FILES:
        p = ROOT / f
        if not p.exists():
            raise SystemExit(f"missing required file: {f}")
        out.append(p)
    for icon in INCLUDE_ICONS:
        p = ROOT / icon
        if not p.exists():
            raise SystemExit(f"missing icon: {icon} — run scripts/make_icons.py first")
        out.append(p)
    for d in INCLUDE_DIRS:
        base = ROOT / d
        if not base.exists():
            raise SystemExit(f"missing required dir: {d}")
        for path in base.rglob("*"):
            if path.is_file():
                out.append(path)
    return out


def main() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    name_slug = "notebooklm-podcast-sync"

    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    zip_path = dist / f"{name_slug}-v{version}.zip"

    files = collect()

    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for f in files:
            arc = f.relative_to(ROOT).as_posix()
            zf.write(f, arc)
            print(f"  + {arc}")

    size_kb = zip_path.stat().st_size / 1024
    print()
    print(f"wrote {zip_path.relative_to(ROOT).as_posix()}  ({size_kb:.1f} KB, {len(files)} files)")
    print(f"upload this zip to https://chrome.google.com/webstore/devconsole")


if __name__ == "__main__":
    main()
