#!/usr/bin/env python3
"""Install version-checked Vaultwarden web-vault enhancements."""

import argparse
import hashlib
from pathlib import Path
import re
import sys

from web_vault_patches import (
    ORIGINAL_ASSET,
    ORIGINAL_LAZY_ASSETS,
    ORIGINAL_SHA256,
    patch_bundle,
    patch_lazy_bundle,
)

ROOT = Path(__file__).resolve().parents[1]
BLOCK = re.compile(rb'<!-- vaultwarden-enhancements:start -->.*?<!-- vaultwarden-enhancements:end -->', re.S)
MAIN = re.compile(rb'<script\b[^>]*\bsrc="(app/main\.[a-f0-9]+(?:\.(?:local-dev|vaultwarden))?\.js)"[^>]*></script>')


def write_checked(path, contents):
    if path.exists():
        if path.read_bytes() != contents:
            raise ValueError("Generated asset has unexpected contents: " + path.name)
    else:
        path.write_bytes(contents)


def prepare(restore=False, local_dev=False, root=ROOT):
    web_vault = root / "web-vault"
    index_path = web_vault / "index.html"
    original = (web_vault / ORIGINAL_ASSET).read_bytes()
    if hashlib.sha256(original).hexdigest() != ORIGINAL_SHA256:
        raise ValueError("The web-vault bundle differs from the supported 2026.10.1 release.")
    index = index_path.read_bytes()
    clean = BLOCK.sub(b"", index)
    matches = list(MAIN.finditer(clean))
    if len(matches) != 1 or not (web_vault / matches[0].group(1).decode()).is_file():
        raise ValueError("The web-vault index does not reference a supported main bundle.")
    match = matches[0]
    original_tag = match.group(0).replace(match.group(1), ORIGINAL_ASSET.encode())
    if restore:
        updated = clean[:match.start()] + original_tag + clean[match.end():]
    else:
        lazy_assets = {}
        for original_name, spec in ORIGINAL_LAZY_ASSETS.items():
            lazy_path = web_vault / original_name
            if not lazy_path.is_file():
                raise ValueError("The web-vault lazy chunk is missing: " + original_name)
            lazy_original = lazy_path.read_bytes()
            if hashlib.sha256(lazy_original).hexdigest() != spec["sha256"]:
                raise ValueError("The web-vault lazy chunk differs from the supported release: " +
                                 original_name)
            lazy_patched = patch_lazy_bundle(lazy_original, original_name)
            lazy_digest = hashlib.sha256(lazy_patched).hexdigest()[:20]
            lazy_asset = f"{original_name.split('.', 1)[0]}.{lazy_digest}.js"
            write_checked(web_vault / lazy_asset, lazy_patched)
            lazy_assets[original_name] = lazy_asset
        patched = patch_bundle(original, local_dev, lazy_assets)
        digest = hashlib.sha256(patched).hexdigest()[:20]
        asset = f"app/main.{digest}.vaultwarden.js"
        write_checked(web_vault / asset, patched)
        resources = {}
        for extension in ("js", "css"):
            contents = (root / "web-vault-custom" / f"enhancements.{extension}").read_bytes()
            name = f"app/vaultwarden.{hashlib.sha256(contents).hexdigest()[:20]}.{extension}"
            write_checked(web_vault / name, contents)
            resources[extension] = name
        block = (
            '<!-- vaultwarden-enhancements:start -->'
            f'<link rel="stylesheet" href="{resources["css"]}">'
            f'<script src="{resources["js"]}" defer></script>'
            '<!-- vaultwarden-enhancements:end -->'
        ).encode()
        tag = original_tag.replace(ORIGINAL_ASSET.encode(), asset.encode())
        updated = clean[:match.start()] + block + tag + clean[match.end():]
    if updated != index:
        temporary = index_path.with_name("index.html.vaultwarden.tmp")
        temporary.write_bytes(updated)
        temporary.replace(index_path)
    if restore:
        print("Restored the original web-vault bundle reference.")
    else:
        print("Prepared vault and Admin Console scrolling, navigation, search and collection updates.")
        if local_dev:
            print("Enabled Never timeout for HTTPS loopback pages on port 8001.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restore", action="store_true")
    parser.add_argument("--local-dev", action="store_true")
    args = parser.parse_args()
    try:
        prepare(args.restore, args.local_dev)
    except (OSError, ValueError) as error:
        print(f"Web-vault preparation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
