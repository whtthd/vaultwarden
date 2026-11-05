#!/usr/bin/env python3
"""Prepare the enhanced web vault and the existing local Never timeout option."""

import argparse
import sys

from prepare_web_vault import prepare as prepare_web_vault


def prepare(restore=False):
    prepare_web_vault(restore=restore, local_dev=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restore", action="store_true", help="Restore the upstream bundle reference")
    args = parser.parse_args()
    try:
        prepare(args.restore)
    except (OSError, ValueError) as error:
        print(f"Local web-vault preparation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
