#!/usr/bin/env python3
"""Verify pinned bundle hooks, cache busting, upgrades and complete restoration."""

import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_web_vault import prepare, ROOT
from web_vault_patches import ORIGINAL_ASSET, ENHANCEMENT_PATCHES, LOCAL_PATCHES, patch_bundle


class PreparationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = (ROOT / 'web-vault' / ORIGINAL_ASSET).read_bytes()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'web-vault/app').mkdir(parents=True)
        (self.root / 'web-vault' / ORIGINAL_ASSET).write_bytes(self.bundle)
        self.index = self.root / 'web-vault/index.html'
        self.original_index = f'<html><head></head><body><script src="{ORIGINAL_ASSET}" defer></script></body></html>'.encode()
        self.index.write_bytes(self.original_index)
        custom = self.root / 'web-vault-custom'
        custom.mkdir()
        for ext in ('js', 'css'):
            (custom / f'enhancements.{ext}').write_bytes((ROOT / 'web-vault-custom' / f'enhancements.{ext}').read_bytes())

    def prepare(self, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            prepare(root=self.root, **kwargs)

    def test_all_hooks_match_and_search_resets_both_terminologies(self):
        patched = patch_bundle(self.bundle, local_dev=True)
        for before, after in ENHANCEMENT_PATCHES + LOCAL_PATCHES:
            self.assertIn(after.encode(), patched)
            if before != after and before.encode() not in after.encode():
                self.assertNotIn(before.encode(), patched)
        self.assertIn(b'{sharedFolderId:t,collectionId:null,search:null}', patched)
        self.assertIn(b'{collectionId:t,sharedFolderId:null,search:null}', patched)
        self.assertIn(b'window.VaultwardenEnhancements.createCollection(this,c,u,v._)', patched)
        self.assertNotIn(b'this.collectionAdminService.create(c,u)', patched)
        self.assertIn(
            b'registerMemberCollectionSelector(this,(0,r.WQX)(w.aKT).nativeElement)', patched)
        self.assertIn(b'ngOnDestroy(){window.VaultwardenEnhancements.unregisterMemberCollectionSelector(this)}', patched)

    def test_prepare_is_idempotent_and_restore_is_exact(self):
        self.prepare(local_dev=True)
        once = self.index.read_bytes()
        self.prepare(local_dev=True)
        self.assertEqual(once, self.index.read_bytes())
        self.assertLess(once.index(b'app/vaultwarden.'), once.index(b'app/main.'))
        self.prepare(restore=True)
        self.assertEqual(self.index.read_bytes(), self.original_index)
        self.assertEqual((self.root / 'web-vault' / ORIGINAL_ASSET).read_bytes(), self.bundle)

    def test_product_mode_keeps_local_auto_unlock_disabled(self):
        patched = patch_bundle(self.bundle)
        self.assertIn(LOCAL_PATCHES[0][0].encode(), patched)
        self.assertIn(LOCAL_PATCHES[1][0].encode(), patched)
        self.prepare()
        self.prepare(local_dev=True)
        self.prepare()

    def test_resources_get_new_urls_when_changed(self):
        self.prepare()
        before = self.index.read_bytes()
        with (self.root / 'web-vault-custom/enhancements.css').open('a') as css:
            css.write('\n/* test update */\n')
        self.prepare()
        self.assertNotEqual(before, self.index.read_bytes())

    def test_old_local_bundle_reference_upgrades(self):
        legacy = 'app/main.26daa49d74f4ecb791b8.local-dev.js'
        (self.root / 'web-vault' / legacy).write_bytes(b'legacy placeholder')
        self.index.write_bytes(self.original_index.replace(ORIGINAL_ASSET.encode(), legacy.encode()))
        self.prepare(local_dev=True)
        self.assertNotIn(legacy.encode(), self.index.read_bytes())

    def test_unsupported_bundle_fails_without_changing_index(self):
        (self.root / 'web-vault' / ORIGINAL_ASSET).write_bytes(b'unsupported')
        with self.assertRaisesRegex(ValueError, 'differs'):
            self.prepare()
        self.assertEqual(self.index.read_bytes(), self.original_index)


if __name__ == '__main__':
    unittest.main()
