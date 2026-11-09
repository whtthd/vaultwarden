#!/usr/bin/env python3
"""Verify pinned bundle hooks, cache busting, upgrades and complete restoration."""

import contextlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
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

    def test_descendant_search_observes_scope_and_account_changes_without_queuing_stale_results(self):
        patched = patch_bundle(self.bundle)
        self.assertIn(
            b'a=(0,Ke.z)([o,i,this.currentSearchText$,r,this.accountService.activeAccount$]).pipe(',
            patched)
        self.assertIn(
            b'(0,Le.n)(([t,i,n,r,s])=>null!=s&&s.id===e?'
            b'window.VaultwardenEnhancements.searchVaultCiphers(this,e,t,i,n,r,Bh.Jpj,u._)'
            b':Promise.resolve([]))', patched)
        self.assertNotIn(
            b'a=(0,Ke.z)([o,i,this.currentSearchText$]).pipe(', patched)
        # Search still receives the original filter factory; no global predicate is widened.
        start = self.bundle.index(b'function Ib(e){')
        end = self.bundle.index(b'const Bb=', start)
        self.assertIn(self.bundle[start:end], patched)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is needed for JavaScript syntax validation')
    def test_generated_bundles_have_valid_javascript_syntax(self):
        for local_dev in (False, True):
            result = subprocess.run(
                ['node', '--check'], input=patch_bundle(self.bundle, local_dev),
                capture_output=True, check=False)
            error = re.search(rb'SyntaxError:[^\n]*', result.stderr)
            self.assertEqual(result.returncode, 0, error.group().decode() if error else 'Syntax check failed')

    @unittest.skipUnless(shutil.which('node'), 'Node.js is needed for pinned search integration tests')
    def test_pinned_search_preserves_existing_filters_and_checks_the_active_account(self):
        patched = patch_bundle(self.bundle)
        start = patched.index(b'function Ib(e){')
        end = patched.index(b'const Bb=', start)
        projection = re.findall(
            rb'\(0,Le\.n\)\((\(\[t,i,n,r,s\]\)=>null!=s&&s.id===e\?.*?:Promise.resolve\(\[\]\))\)',
            patched)
        self.assertEqual(len(projection), 1)
        payload = json.dumps({
            'factory': patched[start:end].decode(),
            'projection': projection[0].decode(),
            'runtime': str(ROOT / 'web-vault-custom/enhancements.js'),
        })
        script = r"""
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const makeFilter = vm.runInNewContext('(' + input.factory + ')', {
  k: { n: { getType: c => c.type, isDeleted: c => !!c.deleted, isArchived: c => !!c.archived } },
  Bt: { gC: { Login: 1, SecureNote: 2, Card: 3, Identity: 4, SshKey: 5,
    BankAccount: 6, DriversLicense: 7, Passport: 8 } },
  dn: { I_: 'unassigned' }, ly: 'all',
});
let searches = 0;
const component = {
  cipherService: { failedToDecryptCiphers$: () => [] },
  searchService: {
    isSearchable: async text => !!text?.trim(),
    searchCiphers: async (user, org, text, candidates) => { searches++; return candidates; },
  },
};
const project = vm.runInNewContext('(function(){return ' + input.projection + ';})', {
  window: { VaultwardenEnhancements: require(input.runtime) }, Bh: { Jpj: makeFilter },
  u: { _: async value => value }, e: 'active-user',
}).call(component);
const node = (id, name, children = []) =>
  ({ node: { id, fullName: name, organizationId: 'org' }, children });
const nodes = [node('parent', 'A', [node('child', 'A/B')])];
const item = (id, extra = {}) => ({ id, organizationId: 'org', collectionIds: ['child'],
  type: 1, favorite: false, folderId: null, ...extra });
const ciphers = [item('login'), item('favorite', { favorite: true }),
  item('folder', { folderId: 'folder' }), item('note', { type: 2 }),
  item('card', { type: 3 }), item('archived', { archived: true }),
  item('deleted', { deleted: true }), item('sibling', { collectionIds: ['sibling'] })];
async function search(filter = {}, account = { id: 'active-user' }, tree = nodes, text = 'demo') {
  return Array.from(await project(
    [ciphers, { collectionId: 'parent', ...filter }, text, tree, account]), c => c.id);
}
(async () => {
  assert.deepEqual(await search(), ['login', 'favorite', 'folder', 'note', 'card']);
  assert.deepEqual(await search({ type: 'login' }), ['login', 'favorite', 'folder']);
  assert.deepEqual(await search({ type: 'favorites' }), ['favorite']);
  assert.deepEqual(await search({ type: 'note' }), ['note']);
  assert.deepEqual(await search({ type: 'card' }), ['card']);
  assert.deepEqual(await search({ folderId: 'folder' }), ['folder']);
  assert.deepEqual(await search({ folderId: 'unassigned', type: 'login' }), ['login', 'favorite']);
  assert.deepEqual(await search({ type: 'archive' }), ['archived']);
  assert.deepEqual(await search({ type: 'trash' }), ['deleted']);
  assert.deepEqual(await search({ organizationId: 'other' }), []);
  assert.deepEqual(await search({}, undefined, []), []);
  assert.deepEqual(await search({}, undefined, nodes, ''), []);
  const before = searches;
  assert.deepEqual(await search({}, { id: 'other-user' }), []);
  assert.deepEqual(await search({}, null), []);
  assert.equal(searches, before);
})().catch(error => { console.error(error); process.exitCode = 1; });
"""
        result = subprocess.run(
            ['node', '-e', script], input=payload, text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])

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
