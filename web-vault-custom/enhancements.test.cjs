const { test } = require('node:test');
const assert = require('node:assert/strict');
const enhancements = require('./enhancements.js');
const { planCollectionUpdate, nestedCollectionTraverse, accessDelta, applyDelta, saveCollection } = enhancements;

test('every pinned bundle hook is exported by the enhancement runtime', () => {
  const fs = require('node:fs');
  const patches = fs.readFileSync(require('node:path').join(__dirname, '../tools/web_vault_patches.py'), 'utf8');
  const hooks = [...patches.matchAll(/window\.VaultwardenEnhancements\.(\w+)/g)].map((m) => m[1]);
  assert.ok(hooks.length > 0);
  for (const name of hooks) assert.equal(typeof enhancements[name], 'function', name);
});

test('filter title and search area use the left pane sticky layout', () => {
  const fs = require('node:fs');
  const css = fs.readFileSync(require('node:path').join(__dirname, 'enhancements.css'), 'utf8');
  assert.match(css, /\.vw-filter-pane app-vault-filter \[data-testid="filters-header"\][\s\S]*position:\s*sticky/);
  assert.match(css, /\.vw-filter-pane app-organization-vault-filter \[data-testid="filters-header"\]/);
  assert.match(css, /\.vw-filter-pane app-vault-filter \[data-testid="filters-body"\] > \.tw-mb-4[\s\S]*position:\s*sticky/);
  assert.match(css, /top:\s*var\(--vw-filter-header-height/);
  assert.match(css, /background:\s*var\(--color-bg-primary\)/);
  assert.match(css, /main#main-content\.vw-admin-list-page \.vw-admin-list-header/);
  assert.match(css, /\.vw-admin-list-content \{ display: block/);
  assert.doesNotMatch(css, /\.vw-admin-list-layout|\.vw-admin-list-viewport/);
});

test('admin list controls stay on the routed host without redirecting the CDK scroll reference', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const instance = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'enhancements.js'), 'utf8'),
    { module: instance, URLSearchParams });
  const runtime = instance.exports;
  const classes = () => {
    const values = new Set();
    return { add: (...names) => names.forEach((name) => values.add(name)),
      remove: (name) => values.delete(name), contains: (name) => values.has(name) };
  };
  const callbacks = {}, frames = [], timers = [], events = [];
  let onList = true;
  const status = { classList: classes(), matches: () => false, querySelector: () => ({}) };
  const viewport = { matches: () => false, querySelector: () => null };
  const header = { classList: classes(), querySelector: () => ({}),
    getBoundingClientRect: () => ({ height: 92 }) };
  const page = { classList: classes(), children: [header, status, viewport],
    querySelector: () => viewport };
  header.parentElement = page;
  const main = { classList: classes(), scrollTop: 800,
    style: { setProperty() {} }, contains: () => true,
    querySelector: () => null, querySelectorAll: () => onList ? [header] : [],
    dispatchEvent: (event) => events.push(event.type) };
  const search = { value: 'old query', closest: () => main, matches: () => true,
    dispatchEvent: (event) => events.push(event.type) };
  const document = { documentElement: {}, querySelector: (selector) =>
    selector === 'main#main-content' ? main : null,
    querySelectorAll: () => [search],
    addEventListener: (name, callback) => { callbacks[name] = callback; } };
  main.ownerDocument = document;
  const windowObject = { document, location: { hash: '#/organizations/org/members' },
    MutationObserver: class { observe() {} }, requestAnimationFrame: (callback) => frames.push(callback),
    setTimeout: (callback) => timers.push(callback), addEventListener: (name, cb) => { callbacks[name] = cb; },
    Event: class { constructor(type) { this.type = type; } } };
  let reference = { nativeElement: main };
  const original = reference;
  const signal = () => reference;
  signal.set = (next) => { reference = next; };
  const host = { ref: original, service: { scrollableRef: signal } };
  runtime.start(windowObject);
  runtime.registerScrollHost(host);
  frames.shift()();
  assert.equal(reference, original);
  assert.equal(page.classList.contains('vw-admin-list-content'), true);
  assert.equal(header.classList.contains('vw-admin-list-header'), true);
  assert.equal(status.classList.contains('vw-admin-list-controls'), true);
  callbacks.input({ target: search });
  assert.equal(main.scrollTop, 0);
  assert.deepEqual(events, ['scroll']);
  onList = false;
  windowObject.location.hash = '#/organizations/org/settings';
  callbacks.hashchange();
  frames.shift()();
  assert.equal(reference, original);
  assert.equal(main.classList.contains('vw-admin-list-page'), false);
  assert.equal(page.classList.contains('vw-admin-list-content'), false);
  runtime.unregisterScrollHost(host);
});

function collection(id, name, extra = {}) {
  return { id, name, organizationId: 'org', externalId: 'external-' + id, users: [], groups: [],
    canEdit: () => true, canEditName: () => true, ...extra };
}
const access = (id, manage = false) => ({ id, readOnly: !manage, hidePasswords: false, manage });

function treeNode(node, parent, name) {
  if (name) node.name = name;
  return { node, parent, children: [] };
}

function tree(collections) {
  const nodes = [];
  for (const model of collections) {
    const parts = model.name ? model.name.replace(/^\/+|\/+$/g, '').split('/') : [];
    nestedCollectionTraverse(nodes, 0, parts, model, undefined, '/', treeNode);
  }
  return nodes;
}

test('rename moves all descendants while retaining IDs, associations and independent access', () => {
  const root = collection('root', 'A');
  const child = collection('child', 'A/B', { users: [access('child-user')], groups: [access('child-group')] });
  const deep = collection('deep', 'A/B/C');
  const other = collection('other', 'AB/Unrelated');
  const foreign = collection('foreign', 'A/B', { organizationId: 'foreign' });
  const result = planCollectionUpdate(root, { ...root, name: 'New/A' }, [root, child, deep, other, foreign], [], {});
  assert.deepEqual(result.map((r) => [r.model.id, r.model.name]), [
    ['root', 'New/A'], ['child', 'New/A/B'], ['deep', 'New/A/B/C'],
  ]);
  assert.equal(result[1].model.externalId, child.externalId);
  assert.deepEqual(result[1].model.users, child.users);
  assert.deepEqual(result[1].model.groups, child.groups);
  assert.equal(child.name, 'A/B');
  assert.equal(result[1].usersChanged, false);
});

test('self moves, collisions and inaccessible descendants fail before saving', () => {
  const root = collection('root', 'A');
  const child = collection('child', 'A/B');
  assert.throws(() => planCollectionUpdate(root, { ...root, name: 'A/B/New' }, [root, child], [], {}), /自己的子集合/);
  assert.throws(() => planCollectionUpdate(root, { ...root, name: 'New' }, [root, child, collection('collision', 'New/B')], [], {}), /同名/);
  assert.throws(() => planCollectionUpdate(root, { ...root, name: 'New' }, [root, { ...child, canEditName: () => false }], [], {}), /没有修改权限/);
});

test('permission delta applies only to selected descendants and preserves unrelated rights', () => {
  const root = collection('root', 'A', { users: [access('changed'), access('removed')], groups: [access('g')] });
  const child = collection('child', 'A/B', { users: [access('changed'), access('removed'), access('independent')], groups: [access('g'), access('own-group')] });
  const untouched = collection('untouched', 'A/C', { users: [access('removed')] });
  const edited = { ...root, users: [access('changed', true), access('added')], groups: [access('g', true)] };
  const result = planCollectionUpdate(root, edited, [root, child, untouched], ['child'], {});
  assert.deepEqual(result.map((r) => r.model.id), ['root', 'child']);
  assert.deepEqual(result[1].model.users, [access('changed', true), access('independent'), access('added')]);
  assert.deepEqual(result[1].model.groups, [access('g', true), access('own-group')]);
  assert.deepEqual(untouched.users, [access('removed')]);
});

test('unchanged parent grants are not copied and omitted descendant permissions stay independent', () => {
  const root = collection('root', 'A', { users: [access('existing')] });
  const edited = { ...root, users: [...root.users, access('new')] };
  const child = collection('child', 'A/B');
  const result = planCollectionUpdate(root, edited, [root, child], ['child'], {});
  assert.deepEqual(result[1].model.users, [access('new')]);
  assert.equal(result[1].groupsChanged, false);
  assert.throws(() => planCollectionUpdate(root, edited, [root, child], ['foreign'], {}), /已发生变化/);
});

test('missing ancestors are structural, readonly, org-specific, and accept actual parents later', () => {
  const nodes = tree([collection('child', 'A/B/C'), collection('parent', 'A'), collection('sibling', 'A/D')]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].node.id, 'parent');
  assert.equal(nodes[0].children.length, 2);
  const structural = nodes[0].children[0].node;
  assert.equal(structural.name, 'B');
  assert.equal(structural.fullName, 'A/B');
  assert.equal(structural.vwStructuralOnly, true);
  for (const method of ['canEdit', 'canEditItems', 'canDelete', 'canEditName', 'canViewCollectionInfo', 'canEditUserAccess', 'canEditGroupAccess']) assert.equal(structural[method]({ isAdmin: true }), false);
  assert.throws(() => structural.toSdkCollectionView(), /不可保存/);
  assert.equal(nodes[0].children[0].children[0].node.id, 'child');
  const separated = tree([collection('x', 'A/B'), collection('y', 'A/C', { organizationId: 'other' })]);
  assert.equal(separated.length, 2);
  assert.notEqual(separated[0].node.id, separated[1].node.id);
});

test('real duplicate paths retain both IDs', () => {
  const nodes = tree([collection('one', 'A/B'), collection('two', 'A/B')]);
  assert.deepEqual(nodes[0].children.map((n) => n.node.id), ['one', 'two']);
});

test('delta normalizes optional false flags without creating changes', () => {
  const delta = accessDelta([{ id: 'a' }], [access('a', true)]);
  assert.equal(delta.set.length, 1);
  assert.deepEqual(accessDelta([{ id: 'a' }], [{ id: 'a', manage: false }]), { remove: [], set: [] });
  assert.deepEqual(applyDelta([access('a'), access('b')], { remove: ['a'], set: [access('c')] }), [access('b'), access('c')]);
});

test('one encrypted batch saves a rename, then updates every local cache entry', async () => {
  const root = collection('root', 'A');
  const child = collection('child', 'A/B');
  const requests = [], cached = [];
  const component = {
    collection: () => root, organization: () => ({}), allCollections$: [root, child],
    collectionAdminService: {
      encrypt: async (model) => ({ name: 'encrypted:' + model.name, externalId: model.externalId, users: model.users, groups: model.groups }),
      apiService: { send: async (...args) => {
        requests.push(args);
        return { data: args[2].collections.map((c) => ({ ...c, assigned: true })) };
      } },
      updateLocalCollections: async (response) => cached.push(response.id),
    },
  };
  const response = await saveCollection(component, { ...root, name: 'Z' }, 'test-user', async (value) => value);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1], '/organizations/org/collections/bulk-update');
  const changes = requests[0][2].collections;
  assert.deepEqual(changes.map((c) => c.name), ['encrypted:Z', 'encrypted:Z/B']);
  assert.equal('users' in changes[1], false);
  assert.equal('groups' in changes[1], false);
  assert.deepEqual(cached, ['root', 'child']);
  assert.equal(response.id, 'root');
});

test('a failed batch never changes the local cache', async () => {
  const root = collection('root', 'A');
  let writes = 0;
  const component = { collection: () => root, organization: () => ({}), allCollections$: [root],
    collectionAdminService: { encrypt: async () => ({}), apiService: { send: async () => { throw new Error('rejected'); } }, updateLocalCollections: async () => writes++ } };
  await assert.rejects(saveCollection(component, { ...root, name: 'B' }, 'user', async (v) => v), /rejected/);
  assert.equal(writes, 0);
});

test('list reset key ignores open-item state, retains search changes', () => {
  assert.equal(enhancements.navigationKey('#/vault?collectionId=A&cipherId=one'), enhancements.navigationKey('#/vault?collectionId=A&cipherId=two'));
  assert.notEqual(enhancements.navigationKey('#/vault?collectionId=A'), enhancements.navigationKey('#/vault?collectionId=A&search=hello'));
});

test('late search callbacks cannot restore a condition cleared by collection navigation', () => {
  const input = { value: 'current' };
  const document = { querySelector: () => input };
  assert.equal(enhancements.searchMatchesInput('current', document), true);
  input.value = '';
  assert.equal(enhancements.searchMatchesInput('current', document), false);
  assert.equal(enhancements.searchMatchesInput('', document), true);
  assert.equal(enhancements.searchMatchesInput('anything', { querySelector: () => null }), false);
});

function searchCipher(id, collectionIds, extra = {}) {
  return { id, collectionIds, organizationId: 'org', type: 1, ...extra };
}

function originalSearchFilter(filter) {
  return (cipher) => (filter.collectionId === undefined ||
    cipher.collectionIds?.includes(filter.collectionId)) &&
    (filter.organizationId === undefined || cipher.organizationId === filter.organizationId) &&
    cipher.otherFiltersMatch !== false;
}

function recursiveSearchFilter(collections, id, filter = {}) {
  return enhancements.collectionSearchFilter({ ...filter, collectionId: id },
    tree(collections.map((c) => ({ ...c }))), originalSearchFilter);
}

function searchComponent(results, checkInput = () => {}, failed = []) {
  return {
    cipherService: { failedToDecryptCiphers$: (userId) => {
      assert.equal(userId, 'search-user');
      return failed;
    } },
    searchService: {
      isSearchable: async (text) => !!text?.trim(),
      searchCiphersBasic: (candidates, text) => {
        checkInput(candidates, text);
        return results;
      },
      searchCiphers: async (userId, organizationId, text, candidates) => {
        assert.equal(userId, 'search-user');
        assert.equal(organizationId, null);
        checkInput(candidates, text);
        return results;
      },
    },
  };
}

test('collection search includes every descendant depth but not siblings, parents or similar prefixes', () => {
  const collections = [collection('parent', 'A'), collection('selected', 'A/B'),
    collection('child', 'A/B/C'), collection('deep', 'A/B/C/D'),
    collection('sibling', 'A/E'), collection('prefix', 'A/BB/C'),
    collection('foreign', 'A/B/C', { organizationId: 'other-org' })];
  const predicate = recursiveSearchFilter(collections, 'selected');
  const ciphers = collections.map((c) => searchCipher(c.id, [c.id], { organizationId: c.organizationId }));
  assert.deepEqual(ciphers.filter(predicate).map((c) => c.id), ['selected', 'child', 'deep']);
  assert.equal(predicate(searchCipher('mismatched-org', ['child'], { organizationId: 'other-org' })), false);
  assert.equal(predicate(searchCipher('personal', ['child'], { organizationId: null })), false);
  assert.equal(predicate(searchCipher('none', null)), false);
  assert.equal(predicate(searchCipher('none', [])), false);
  assert.deepEqual(collections.map((c) => c.name), ['A', 'A/B', 'A/B/C', 'A/B/C/D', 'A/E', 'A/BB/C', 'A/B/C']);
});

test('collection search never infers a grant from parent access or a cipher collection name', () => {
  const predicate = recursiveSearchFilter([collection('parent', 'A'),
    collection('child', 'A/Allowed')], 'parent');
  assert.equal(predicate(searchCipher('parent-item', ['parent'])), true);
  assert.equal(predicate(searchCipher('child-item', ['child'])), true);
  assert.equal(predicate(searchCipher('invisible-child-item', ['invisible-child'], { name: 'A/Secret' })), false);
  assert.equal(predicate(searchCipher('outside', ['sibling'])), false);
});

test('child-only access can search structural ancestors without gaining real ancestor items', () => {
  const nodes = tree([collection('leaf', 'A/B/C')]);
  for (const structural of [nodes[0], nodes[0].children[0]]) {
    const predicate = enhancements.collectionSearchFilter({ collectionId: structural.node.id },
      nodes, originalSearchFilter);
    assert.equal(predicate(searchCipher('visible', ['leaf'])), true);
    assert.equal(predicate(searchCipher('hidden-root', ['actual-A'])), false);
    assert.equal(predicate(searchCipher('hidden-parent', ['actual-B'])), false);
    assert.equal(predicate(searchCipher('virtual', [structural.node.id])), false);
    assert.equal(predicate(searchCipher('hidden-sibling', ['ungranted-leaf'])), false);
  }
});

test('missing, revoked and forged search scopes fail closed instead of searching the whole vault', () => {
  const child = collection('child', 'A/B');
  for (const selected of ['revoked-parent', 'missing', 'vw-ancestor:org:A%2FHidden', 'vw-ancestor:other:A']) {
    assert.equal(recursiveSearchFilter([child], selected)(searchCipher('visible', ['child'])), false);
  }
  assert.equal(enhancements.collectionSearchFilter({ collectionId: 'child' }, undefined,
    originalSearchFilter)(searchCipher('old-snapshot', ['child'])), false);
  const before = recursiveSearchFilter([collection('parent', 'A'), child], 'parent');
  const after = recursiveSearchFilter([collection('parent', 'A')], 'parent');
  assert.equal(before(searchCipher('old-child', ['child'])), true);
  assert.equal(after(searchCipher('old-child', ['child'])), false);
  assert.equal(after(searchCipher('parent-item', ['parent'])), true);
});

test('search scope is rebuilt for each account, permission snapshot and collection move', () => {
  const first = recursiveSearchFilter([collection('root', 'A'), collection('child', 'A/B')], 'root');
  const second = recursiveSearchFilter([collection('root', 'A')], 'root');
  const moved = recursiveSearchFilter([collection('root', 'A'), collection('child', 'Elsewhere/B')], 'root');
  const item = searchCipher('child-item', ['child']);
  assert.equal(first(item), true);
  assert.equal(second(item), false);
  assert.equal(moved(item), false);
  const otherOrg = recursiveSearchFilter([collection('root', 'A', { organizationId: 'other' }),
    collection('child', 'A/B', { organizationId: 'other' })], 'root');
  assert.equal(otherOrg(item), false);
});

test('duplicate paths retain distinct root IDs while exact-path descendants remain searchable', () => {
  const predicate = recursiveSearchFilter([collection('one', 'A/B'), collection('two', 'A/B'),
    collection('child', 'A/B/C')], 'two');
  assert.equal(predicate(searchCipher('one-item', ['one'])), false);
  assert.equal(predicate(searchCipher('two-item', ['two'])), true);
  assert.equal(predicate(searchCipher('child-item', ['child'])), true);
});

test('search hierarchy matches the displayed slash trimming but never case-folds or normalizes paths', () => {
  const collections = [collection('root', '/Café/'), collection('child', '/Café/密码/深层/'),
    collection('case', 'CAFÉ/密码'), collection('unicode', 'Cafe\u0301/密码'),
    collection('similar', 'Café店/密码')];
  const predicate = recursiveSearchFilter(collections, 'root');
  assert.deepEqual(collections.map((c) => searchCipher(c.id, [c.id])).filter(predicate).map((c) => c.id),
    ['root', 'child']);
});

test('failed collection-name decryption permits direct search but cannot invent descendant paths', () => {
  const failed = collection('failed', 'Unknown', { decryptionFailure: true });
  const predicate = recursiveSearchFilter([failed, collection('apparent-child', 'Unknown/Child')], 'failed');
  assert.equal(predicate(searchCipher('direct', ['failed'])), true);
  assert.equal(predicate(searchCipher('not-a-known-descendant', ['apparent-child'])), false);
  const root = recursiveSearchFilter([collection('root', 'A'),
    collection('failed-child', 'A/Unknown', { decryptionFailure: true })], 'root');
  assert.equal(root(searchCipher('failed-child-item', ['failed-child'])), false);
});

test('unassigned and non-collection search preserve the original predicate unchanged', () => {
  for (const collectionId of [undefined, 'unassigned']) {
    const filter = { collectionId, type: 'login', folderId: 'folder' };
    const sentinel = () => 'original-result';
    const predicate = enhancements.collectionSearchFilter(filter, undefined, (received) => {
      assert.equal(received, filter);
      return sentinel;
    });
    assert.equal(predicate, sentinel);
  }
});

test('recursive collection search delegates every other filter to the unmodified upstream factory', () => {
  const filter = { collectionId: 'parent', organizationId: 'org', type: 'favorites',
    folderId: 'folder', organizationIdParamType: 'path' };
  const nodes = tree([collection('parent', 'A'), collection('child', 'A/B')]);
  const predicate = enhancements.collectionSearchFilter(filter, nodes, (received) => {
    assert.deepEqual(received, { ...filter, collectionId: undefined });
    return (cipher) => cipher.otherFiltersMatch;
  });
  assert.equal(predicate(searchCipher('allowed', ['child'], { otherFiltersMatch: true })), true);
  assert.equal(predicate(searchCipher('excluded', ['child'], { otherFiltersMatch: false })), false);
  assert.equal(filter.collectionId, 'parent');
  assert.equal(recursiveSearchFilter([collection('parent', 'A'), collection('child', 'A/B')],
    'parent', { organizationId: 'another-org' })(searchCipher('wrong-org', ['child'])), false);
});

test('admin collection search accepts a flat catalog while remaining inside the authorized cipher feed', async () => {
  const parent = collection('parent', 'Operations');
  const child = collection('child', 'Operations/Production');
  const sibling = collection('sibling', 'Other');
  const authorized = [
    searchCipher('parent-item', ['parent']),
    searchCipher('child-item', ['child']),
    searchCipher('sibling-item', ['sibling']),
  ];
  const component = {
    searchService: {
      isSearchable: async () => true,
      searchCiphersBasic: (candidates, text) => {
        assert.equal(text, 'secret');
        return [...candidates, { ...candidates[1] }, searchCipher('forged', ['child'])];
      },
    },
  };
  const makeFilter = (filter) => (cipher) =>
    (filter.collectionId === undefined || cipher.collectionIds?.includes(filter.collectionId)) &&
    cipher.organizationId === 'org';
  const result = await enhancements.searchOrganizationVaultCiphers(
    component, 'admin-user', 'org', authorized,
    { collectionId: 'parent', organizationId: 'org' }, 'secret', [parent, child, sibling],
    false, makeFilter,
  );
  assert.deepEqual(result.map((cipher) => cipher.id), ['parent-item', 'child-item']);
});

test('admin collection search fails closed when its collection snapshot is unavailable', async () => {
  const component = {
    searchService: {
      isSearchable: async () => true,
      searchCiphersBasic: () => [searchCipher('visible', ['child'])],
    },
  };
  const result = await enhancements.searchOrganizationVaultCiphers(
    component, 'admin-user', 'org', [searchCipher('visible', ['child'])],
    { collectionId: 'parent', organizationId: 'org' }, 'secret', undefined,
    false, () => () => true,
  );
  assert.deepEqual(result, []);
});

test('admin search retains direct browsing without a searchable query and blocks restricted parents', async () => {
  const models = tree([collection('parent', 'A'), collection('child', 'A/B')]);
  const parent = searchCipher('parent-item', ['parent']);
  const child = searchCipher('child-item', ['child']);
  const component = { searchService: {
    searchCiphersBasic: (ciphers) => ciphers,
  } };
  async function search(text, restricted, filter = {}) {
    return enhancements.searchOrganizationVaultCiphers(component, 'user', 'org', [parent, child],
      { collectionId: 'parent', organizationId: 'org', ...filter }, text, models,
      restricted, originalSearchFilter);
  }
  assert.deepEqual(await search('', false), [parent]);
  assert.deepEqual(await search('', true), []);
  assert.deepEqual(await search('match', false), [parent, child]);
  assert.deepEqual(await search('match', true), [child]);
  assert.deepEqual(await search('match', false, { organizationId: 'foreign' }), []);
  assert.deepEqual(await search('match', false, { collectionId: undefined }), [parent, child]);
  assert.deepEqual(await search('match', true, { collectionId: undefined, type: 'all' }), []);
});

test('admin scopes do not index cross-organization records or return stale cipher instances', async () => {
  const root = collection('parent', 'A'), child = collection('child', 'A/B');
  const allowed = searchCipher('allowed', ['child']);
  const foreign = searchCipher('foreign', ['child'], { organizationId: 'foreign' });
  const component = { searchService: {
    searchCiphersBasic: (ciphers) => {
      assert.deepEqual(ciphers, [allowed]);
      return [foreign, { ...allowed }, allowed];
    },
  } };
  const result = await enhancements.searchOrganizationVaultCiphers(
    component, 'user', 'org', [allowed, foreign],
    { collectionId: 'parent', organizationId: 'org' }, 'match', [root, child],
    false, originalSearchFilter);
  assert.deepEqual(result, [allowed]);
});

test('basic and advanced collection searches keep the full authorized input and reject extraneous results', async () => {
  const nodes = tree([collection('parent', 'A'), collection('child', 'A/B'),
    collection('sibling', 'Other')]);
  const parent = searchCipher('parent-item', ['parent']);
  const child = searchCipher('child-item', ['parent', 'child']);
  const sibling = searchCipher('sibling-item', ['sibling']);
  const unauthorized = searchCipher('not-in-authorized-feed', ['child']);
  const all = [parent, child, sibling];
  for (const query of ['demo', '>name:demo']) {
    const component = searchComponent([child, sibling, unauthorized, { ...child }, parent],
      (candidates, text) => {
        assert.deepEqual(candidates, all);
        assert.equal(text, query);
      });
    const result = await enhancements.searchVaultCiphers(component, 'search-user', all,
      { collectionId: 'parent' }, query, nodes, originalSearchFilter, async (value) => value);
    assert.deepEqual(result, [child, parent]);
    assert.equal(result.filter((c) => c.id === child.id).length, 1);
  }
});

test('empty and whitespace queries retain direct-only collection browsing', async () => {
  const nodes = tree([collection('parent', 'A'), collection('child', 'A/B')]);
  const parent = searchCipher('parent-item', ['parent']);
  const child = searchCipher('child-item', ['child']);
  const component = searchComponent([], () => assert.fail('search must not run'));
  for (const query of [undefined, '', '   ']) {
    assert.deepEqual(await enhancements.searchVaultCiphers(component, 'search-user', [parent, child],
      { collectionId: 'parent' }, query, nodes, originalSearchFilter, async (value) => value), [parent]);
  }
});

test('single Latin and CJK characters use basic matching consistently in every vault scope', async () => {
  const models = tree([collection('parent', 'A'), collection('child', 'A/B')]);
  const parent = searchCipher('parent-item', ['parent']);
  const child = searchCipher('child-item', ['child']);
  const all = [parent, child];
  const component = searchComponent([child], (candidates) => assert.deepEqual(candidates, all));
  // The upstream locale-dependent minimum is not used by the unified basic search.
  component.searchService.isSearchable = async () => assert.fail('locale must not decide query scope');
  component.searchService.searchCiphers = async () => assert.fail('basic search must not build an index');
  for (const query of [' x ', ' 密 ']) {
    assert.deepEqual(await enhancements.searchVaultCiphers(component, 'search-user', all,
      { collectionId: 'parent' }, query, models, originalSearchFilter, async (v) => v), [child]);
    assert.deepEqual(await enhancements.searchOrganizationVaultCiphers(component, 'search-user', 'org', all,
      { organizationId: 'org', collectionId: 'parent' }, query, models, false, originalSearchFilter), [child]);
  }
});

test('all-collection queries search organization items while leaving personal items and other filters out', () => {
  const selected = { collectionId: 'all', organizationId: 'org', type: 'login' };
  const predicate = enhancements.collectionSearchFilter(selected, [], (filter) => {
    assert.deepEqual(filter, { ...selected, collectionId: undefined });
    return (cipher) => cipher.organizationId === filter.organizationId && cipher.type === 1;
  });
  const ciphers = [searchCipher('visible', ['leaf']), searchCipher('unassigned', []),
    searchCipher('foreign', ['leaf'], { organizationId: 'other' }),
    searchCipher('personal', [], { organizationId: null }), searchCipher('note', ['leaf'], { type: 2 })];
  assert.deepEqual(ciphers.filter(predicate).map((cipher) => cipher.id), ['visible', 'unassigned']);
  assert.equal(selected.collectionId, 'all');
});

test('collection names use the same trimmed single-character and multi-term rules in both vaults', () => {
  const models = tree([collection('root', 'Café'), collection('child', 'Café/密钥'),
    collection('other', 'Other'), collection('foreign', 'Café/密钥', { organizationId: 'foreign' })]);
  for (const admin of [false, true]) {
    for (const collectionId of [undefined, 'all']) {
      const ids = (text) => enhancements.searchVaultCollections(models,
        { collectionId, organizationId: 'org' }, text, admin).map((c) => c.id);
      assert.deepEqual(ids(' 密 '), ['child']);
      assert.deepEqual(ids('  cafe   密 '), ['child']);
      assert.deepEqual(ids('CAFÉ'), ['root', 'child']);
      assert.deepEqual(ids(' >name:密 '), []);
      assert.deepEqual(ids('missing'), []);
    }
  }
});

test('directory search retains exact subtree, org, missing-selection and noncollection boundaries', () => {
  const models = tree([collection('root', 'A'), collection('child', 'A/Allowed'),
    collection('deep', 'A/Allowed/Deep'), collection('sibling', 'AB/Allowed'),
    collection('foreign', 'A/Allowed', { organizationId: 'foreign' })]);
  for (const admin of [false, true]) {
    const run = (filter, query = 'allowed') =>
      enhancements.searchVaultCollections(models, { collectionId: 'root', ...filter }, query, admin)
        .map((c) => c.id);
    assert.deepEqual(run({}), ['child', 'deep']);
    assert.deepEqual(run({ collectionId: 'missing' }), []);
    assert.deepEqual(run({ organizationId: 'foreign' }), []);
    assert.deepEqual(run({ organizationId: 'unassigned' }), []);
    assert.deepEqual(run({ folderId: 'folder' }), []);
    assert.deepEqual(run({ type: 'login' }), []);
    assert.deepEqual(run({ type: 'trash' }), []);
    assert.deepEqual(run({}, ''), ['child']);
  }
  assert.deepEqual(enhancements.searchVaultCollections(models, {}, ''), []);
  assert.deepEqual(enhancements.searchVaultCollections(models, { organizationId: 'org' }, '', true)
    .map((c) => c.id), ['root', 'vw-ancestor:org:AB']);
  assert.deepEqual(enhancements.searchVaultCollections(models, { organizationId: 'org', type: 'all' }, '', true), []);
});

test('matching collection rows display full paths while preserving IDs and the decrypted source tree', () => {
  const models = tree([collection('one', 'A/Service'), collection('two', 'B/Service')]);
  const before = models.map((node) => node.children[0].node.name);
  const result = enhancements.searchVaultCollections(models, {}, 'service');
  assert.deepEqual(result.map((c) => [c.id, c.name]), [['one', 'A/Service'], ['two', 'B/Service']]);
  assert.deepEqual(models.map((node) => node.children[0].node.name), before);
  assert.equal(result[0].canEdit(), true);
  assert.equal(result[0].externalId, 'external-one');
});

test('single-item search results are deduplicated and never accept stale or forged instances', async () => {
  const nodes = tree([collection('root', 'A')]);
  const item = searchCipher('one', ['root']);
  const component = searchComponent([item, item, { ...item }, searchCipher('forged', ['root'])]);
  for (const text of ['demo', '>name:demo']) {
    assert.deepEqual(await enhancements.searchVaultCiphers(component, 'search-user', [item],
      { collectionId: 'root' }, text, nodes, originalSearchFilter, async (v) => v), [item]);
  }
});

test('search scope presentation keeps queries but only widens scope after an explicit link', () => {
  const selected = enhancements.vaultSearchPresentation(
    '#/vault?organizationId=org&collectionId=child&type=login&search=hello%20world&cipherId=private', 'A/B');
  assert.equal(selected.scope, '范围：A/B（含子集合） · 登录');
  assert.equal(selected.expanded, true);
  assert.equal(selected.href, '#/vault?search=hello+world');
  assert.equal(selected.expandLabel, '搜索全部密码库');
  const admin = enhancements.vaultSearchPresentation(
    '#/organizations/org/vault?collectionId=child&search=demo', 'Child');
  assert.equal(admin.href, '#/organizations/org/vault?search=demo&type=all');
  assert.equal(admin.expandLabel, '搜索整个组织');
  const trash = enhancements.vaultSearchPresentation(
    '#/vault?collectionId=child&type=trash&search=deleted', 'Child');
  assert.equal(trash.href, '#/vault?search=deleted&type=trash');
  assert.equal(enhancements.vaultSearchPresentation('#/vault', '所有密码库').expanded, false);
  assert.match(enhancements.vaultSearchPresentation('#/vault?search=%3Ename%3Ademo').hint, /高级搜索/);
  assert.equal(enhancements.vaultSearchPresentation('#/vault?collectionId=child&search=old', 'Child', 'new').href,
    '#/vault?search=new');
  assert.equal(enhancements.vaultSearchPresentation('#/vault?collectionId=child&search=old', 'Child', '').href,
    '#/vault');
});

test('Safari text inputs participate in the same debounce and navigation clearing guards', () => {
  const input = { value: 'demo' };
  const document = { querySelectorAll: (selector) => {
    assert.ok(selector.includes('bit-search input[name="searchText"]'));
    assert.ok(!selector.includes('type="search"'));
    return [input];
  } };
  assert.equal(enhancements.searchMatchesInput('demo', document), true);
  input.value = '';
  assert.equal(enhancements.searchMatchesInput('demo', document), false);
});

test('authorized failed-decryption rows are retained without accepting rows outside either account feed', async () => {
  const nodes = tree([collection('parent', 'A'), collection('child', 'A/B')]);
  const failed = searchCipher('failed', ['child']);
  const good = searchCipher('good', ['child']);
  const hidden = searchCipher('hidden', ['child']);
  const component = searchComponent([failed, good, hidden], (candidates) => {
    assert.deepEqual(candidates, [failed, good]);
  }, [failed]);
  assert.deepEqual(await enhancements.searchVaultCiphers(component, 'search-user', [good],
    { collectionId: 'parent' }, 'demo', nodes, originalSearchFilter, async (value) => value), [failed, good]);
});

test('permission selector retains missing intermediate ancestors without inventing write targets', () => {
  const root = collection('root', 'A');
  const leaf = collection('leaf', 'A/Hidden/Deep/Leaf');
  const rows = enhancements.descendantRows(root, [leaf]);
  assert.deepEqual(rows.map((r) => [r.name, r.child?.id, r.depth]), [
    ['Hidden', undefined, 0], ['Deep', undefined, 1], ['Leaf', 'leaf', 2],
  ]);
});

test('renaming requires complete visibility and respects protected names', () => {
  const root = collection('root', 'A');
  assert.throws(() => planCollectionUpdate(root, { ...root, name: 'B' }, [root], [], { canViewAllCollections: false }), /不可见子集合/);
  const protectedRoot = { ...root, canEditName: () => false };
  assert.throws(() => planCollectionUpdate(protectedRoot, { ...protectedRoot, name: 'B' }, [protectedRoot], [], {}), /名称不可修改/);
  assert.equal(planCollectionUpdate(root, root, [root], [], { canViewAllCollections: false }).length, 1);
});

test('a collection whose access was revoked is not reinserted by the dialog caller', async () => {
  const root = collection('root', 'A');
  const cached = [];
  const component = { collection: () => root, organization: () => ({}), allCollections$: [root],
    collectionAdminService: { encrypt: async () => ({}), apiService: { send: async () => ({ data: [{ id: 'root', assigned: false }] }) }, updateLocalCollections: async (r) => cached.push(r.assigned) } };
  assert.equal(await saveCollection(component, root, 'user', async (v) => v), undefined);
  assert.deepEqual(cached, [false]);
});

test('clearing a search is deferred until the collection click handler has run', () => {
  const callbacks = {}, timers = [], events = [];
  const input = { value: 'pending search', dispatchEvent: (event) => events.push(event.type) };
  class FakeElement { closest(selector) { return selector.includes('filter-button') ? this : null; } }
  const document = {
    documentElement: {}, addEventListener: (name, callback) => { callbacks[name] = callback; },
    querySelector: () => input,
  };
  enhancements.start({ document, Element: FakeElement,
    MutationObserver: class { observe() {} }, requestAnimationFrame() {}, addEventListener() {},
    setTimeout: (callback) => timers.push(callback), Event: class { constructor(type) { this.type = type; } },
  });
  callbacks.click({ target: new FakeElement() });
  assert.equal(input.value, 'pending search');
  events.push('collection-click');
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(input.value, '');
  assert.deepEqual(events, ['collection-click', 'input']);
});

test('new collections cannot reuse a sibling path but can reuse a leaf elsewhere', () => {
  const existing = [collection('one', 'A/B')];
  const error = (name, organizationId = 'org') =>
    enhancements.collectionPathError(collection(undefined, name, { organizationId }), existing);
  assert.match(error('A/B'), /已有同名集合/);
  assert.equal(error('C/B'), null);
  assert.equal(error('A/B', 'other-org'), null);
  assert.equal(error('A/b'), null);
});

test('blank segments and invisible boundary spaces are rejected without rewriting names', () => {
  for (const name of ['', '   ', '\u3000', '/A', 'A/', 'A//B', 'A/ \u3000/B']) {
    assert.match(enhancements.collectionPathError(collection(undefined, name), []), /不能为空或仅包含空格/);
  }
  for (const name of [' A', 'A ', 'Parent/ B', 'Parent/B\u3000']) {
    assert.match(enhancements.collectionPathError(collection(undefined, name), []), /首尾不能包含空格/);
  }
  const model = collection(undefined, ' Legacy parent /Child');
  assert.equal(enhancements.collectionPathError(model, []), null);
  assert.equal(model.name, ' Legacy parent /Child');
});

test('visually equivalent existing paths are detected without changing their stored names', () => {
  const legacy = collection('legacy', ' A /Cafe\u0301 ');
  assert.match(enhancements.collectionPathError(collection(undefined, 'A/Café'), [legacy]), /同名/);
  assert.equal(legacy.name, ' A /Cafe\u0301 ');
  assert.equal(enhancements.collectionPathError(collection(undefined, 'A/B'),
    [collection('structure', 'A/B', { vwStructuralOnly: true })]), null);
});

test('existing duplicate or whitespace names do not block permission-only edits', () => {
  for (const name of ['A/B', ' Legacy name ']) {
    const root = collection('one', name);
    const duplicate = collection('two', name);
    const updates = planCollectionUpdate(root, { ...root, users: [access('new')] }, [root, duplicate], [], {});
    assert.deepEqual(updates.map((u) => u.model.id), ['one']);
    assert.deepEqual(updates[0].model.users, [access('new')]);
  }
});

test('subtree moves reject normalized destination collisions', () => {
  const root = collection('root', 'A');
  const child = collection('child', 'A/B');
  assert.throws(() => planCollectionUpdate(root, { ...root, name: 'Z' },
    [root, child, collection('occupied', 'Z/ B ')], [], {}), /同名集合/);
});

test('creation rechecks the latest collection list before any create request', async () => {
  const model = collection(undefined, 'A/B');
  let creates = 0;
  const response = { id: 'new-id' };
  const component = { allCollections$: [collection('existing', 'A/B')],
    collectionAdminService: { create: async (saved, user) => {
      creates++;
      assert.equal(saved, model);
      assert.equal(user, 'test-user');
      return response;
    } } };
  const first = async (v) => v;
  await assert.rejects(enhancements.createCollection(component, model, 'test-user', first), /同名/);
  assert.equal(creates, 0);
  component.allCollections$ = [];
  assert.equal(await enhancements.createCollection(component, model, 'test-user', first), response);
  assert.equal(creates, 1);
  await assert.rejects(enhancements.createCollection(component, model, 'test-user',
    async () => { throw new Error('cannot load'); }), /cannot load/);
  assert.equal(creates, 1);
});

test('dialog validation reacts to parent, organization and collection changes and cleans up', () => {
  function control(value) {
    const validators = new Set(), listeners = new Set();
    return { value, validators, listeners, errors: null,
      valueChanges: { subscribe: (next) => {
        listeners.add(next);
        return { unsubscribe: () => listeners.delete(next) };
      } },
      addValidators: (validator) => validators.add(validator),
      removeValidators: (validator) => validators.delete(validator),
      updateValueAndValidity() {
        this.errors = [...validators].reduce((errors, validate) => ({ ...errors, ...validate() }), {});
      },
      setValue(next) {
        this.value = next;
        this.updateValueAndValidity();
        listeners.forEach((listener) => listener(next));
      },
    };
  }
  let collectionObserver, subjectObserver, destroy, stopped = false, subjectsStopped = false;
  const controls = { name: control('B'), parent: control('A'), selectedOrg: control('org') };
  const component = { formGroup: { controls }, collection: () => undefined,
    allCollections$: { subscribe: (observer) => {
      collectionObserver = observer;
      observer.next([collection('existing', 'A/B')]);
      return { unsubscribe: () => { stopped = true; } };
    } }, accessItems$: { subscribe: (observer) => {
      subjectObserver = observer;
      observer.next([]);
      return { unsubscribe: () => { subjectsStopped = true; } };
    } }, destroyRef: { onDestroy: (callback) => { destroy = callback; } } };
  enhancements.registerCollectionDialog(component);
  enhancements.registerCollectionDialog(component);
  assert.equal(controls.name.validators.size, 1);
  assert.match(controls.name.errors.vwCollectionPath.message, /同名/);
  controls.parent.setValue('Other');
  assert.deepEqual(controls.name.errors, {});
  controls.parent.setValue('A');
  assert.match(controls.name.errors.vwCollectionPath.message, /同名/);
  controls.selectedOrg.setValue('other-org');
  assert.deepEqual(controls.name.errors, {});
  controls.selectedOrg.setValue('org');
  collectionObserver.next([]);
  assert.deepEqual(controls.name.errors, {});
  controls.name.setValue('  ');
  assert.match(controls.name.errors.vwCollectionPath.message, /空格/);
  subjectObserver.next([{ id: 'member', type: 2, labelName: 'Test member' }]);
  subjectObserver.error(new Error('member lookup failed'));
  destroy();
  assert.equal(stopped, true);
  assert.equal(subjectsStopped, true);
  assert.equal(controls.name.validators.size, 0);
  assert.equal(controls.parent.listeners.size, 0);
  assert.equal(controls.selectedOrg.listeners.size, 0);
});

test('multi-member grant, subset update, revocation and leaf-only access preserve independent rights', () => {
  const alpha = (hidePasswords) => ({ id: 'alpha', readOnly: true, hidePasswords, manage: false });
  const beta = { id: 'beta', readOnly: false, hidePasswords: false, manage: false };
  let stored = [collection('root', 'Permissions'), collection('branch', 'Permissions/Development'),
    collection('backend', 'Permissions/Development/Backend', { users: [beta] }),
    collection('frontend', 'Permissions/Development/Frontend'), collection('ops', 'Permissions/Operations')];
  const descendants = ['branch', 'backend', 'frontend', 'ops'];
  function save(id, users, selected) {
    const original = stored.find((c) => c.id === id);
    const updates = planCollectionUpdate(original, { ...original, users }, stored, selected, {});
    stored = stored.map((c) => updates.find((u) => u.model.id === c.id)?.model || c);
  }
  const usersFor = (id) => stored.find((c) => c.id === id).users;

  save('root', [alpha(true)], descendants);
  for (const c of stored) assert.ok(c.users.some((u) => u.id === 'alpha' && u.hidePasswords));
  assert.deepEqual(usersFor('backend').find((u) => u.id === 'beta'), beta);

  save('root', [alpha(false)], ['branch', 'backend']);
  for (const id of ['root', 'branch', 'backend']) {
    assert.equal(usersFor(id).find((u) => u.id === 'alpha').hidePasswords, false);
  }
  for (const id of ['frontend', 'ops']) {
    assert.equal(usersFor(id).find((u) => u.id === 'alpha').hidePasswords, true);
  }

  save('root', [], descendants);
  assert.ok(stored.every((c) => c.users.every((u) => u.id !== 'alpha')));
  assert.deepEqual(usersFor('backend'), [beta]);

  save('backend', [beta, alpha(false)], []);
  assert.deepEqual(usersFor('root'), []);
  assert.deepEqual(usersFor('branch'), []);
  assert.deepEqual(usersFor('frontend'), []);
  assert.deepEqual(usersFor('ops'), []);
  assert.deepEqual(usersFor('backend'), [beta, alpha(false)]);
  const visible = tree(stored.filter((c) => c.users.some((u) => u.id === 'alpha')).map((c) => ({ ...c })));
  assert.equal(visible[0].node.vwStructuralOnly, true);
  assert.equal(visible[0].children[0].node.vwStructuralOnly, true);
  assert.equal(visible[0].node.canEdit({ isAdmin: true }), false);
  assert.equal(visible[0].children[0].children[0].node.id, 'backend');
});

test('selection toggles support a global toggle and independently cancel each branch', () => {
  const selected = new Set(['root', 'root/a', 'root/b']);
  assert.deepEqual(enhancements.selectionState(selected, ['root', 'root/a', 'root/b']), { all: true, mixed: false });
  enhancements.toggleSelection(selected, ['root', 'root/a', 'root/b']);
  assert.deepEqual([...selected], []);
  enhancements.toggleSelection(selected, ['root', 'root/a']);
  assert.deepEqual([...selected], ['root', 'root/a']);
  assert.deepEqual(enhancements.selectionState(selected, ['root', 'root/a']), { all: true, mixed: false });
  enhancements.toggleSelection(selected, ['root', 'root/a']);
  assert.deepEqual([...selected], []);
  enhancements.toggleSelection(selected, ['root', 'root/a', 'root/b']);
  enhancements.toggleSelection(selected, ['root', 'root/a']);
  assert.deepEqual([...selected], ['root/b']);
  assert.deepEqual(enhancements.selectionState(selected, ['root', 'root/a', 'root/b']), { all: false, mixed: true });
});

test('partially selected branches and global scopes clear with one click without touching other scopes', () => {
  const ids = ['branch', 'branch/a', 'branch/b', 'branch/c'];
  for (let mask = 0; mask < (1 << ids.length); mask++) {
    const selected = new Set(['unrelated', ...ids.filter((_, i) => mask & (1 << i))]);
    enhancements.toggleSelection(selected, ids);
    assert.deepEqual([...selected].sort(), mask ? ['unrelated'] : ['unrelated', ...ids].sort());
  }
});

test('grant and revoke target only selected descendants, not siblings, prefixes or other organizations', () => {
  const root = collection('root', 'A');
  const all = [root, collection('branch', 'A/B'), collection('deep', 'A/B/C'),
    collection('sibling', 'A/D'), collection('prefix', 'AB/C'),
    collection('foreign', 'A/B', { organizationId: 'foreign' })];
  const grant = planCollectionUpdate(root, { ...root, users: [access('alpha')] }, all, ['branch', 'deep'], {});
  assert.deepEqual(grant.map((u) => u.model.id), ['root', 'branch', 'deep']);
  const saved = all.map((c) => grant.find((u) => u.model.id === c.id)?.model || c);
  const revoke = planCollectionUpdate(saved[0], { ...saved[0], users: [] }, saved, ['deep'], {});
  assert.deepEqual(revoke.map((u) => u.model.id), ['root', 'deep']);
  assert.deepEqual(revoke[1].model.users, []);
  assert.deepEqual(saved[1].users, [access('alpha')]);
  for (const invalid of ['root', 'sibling-from-elsewhere', 'prefix', 'foreign']) {
    assert.throws(() => planCollectionUpdate(saved[0], { ...saved[0], users: [] }, saved, [invalid], {}), /已发生变化/);
  }
});

test('child-only grants can be revoked once after the parent grant was already removed', () => {
  const root = collection('root', 'A', { users: [access('alpha')] });
  const branch = collection('branch', 'A/B', { users: [access('alpha'), access('independent')],
    groups: [access('team'), access('other-team')] });
  const leaf = collection('leaf', 'A/B/C', { users: [access('alpha')], groups: [access('team')] });
  const other = collection('other', 'A/D', { users: [access('alpha')], groups: [access('team')] });
  const stored = [root, branch, leaf, other];
  const parentOnly = planCollectionUpdate(root, { ...root, users: [] }, stored, [], {})[0].model;
  const latest = [parentOnly, branch, leaf, other];
  const result = planCollectionUpdate(parentOnly, parentOnly, latest, ['branch', 'leaf'], {},
    { users: ['alpha'], groups: ['team'] });
  assert.equal(result[0].usersChanged, false);
  assert.equal(result[0].groupsChanged, false);
  assert.deepEqual(result[0].model.users, []);
  assert.deepEqual(result[1].model.users, [access('independent')]);
  assert.deepEqual(result[1].model.groups, [access('other-team')]);
  assert.deepEqual(result[2].model.users, []);
  assert.deepEqual(result[2].model.groups, []);
  assert.equal(result.some((u) => u.model.id === 'other'), false);
  assert.deepEqual(other.users, [access('alpha')]);
  assert.deepEqual(branch.users, [access('alpha'), access('independent')]);
  const after = latest.map((c) => result.find((u) => u.model.id === c.id)?.model || c);
  const again = planCollectionUpdate(parentOnly, parentOnly, after, ['branch', 'leaf'], {},
    { users: ['alpha'], groups: ['team'] });
  assert.deepEqual(again.map((u) => u.model), result.map((u) => u.model));
});

test('explicit child revocations never modify the parent grant and win only within the selected scope', () => {
  const root = collection('root', 'A', { users: [access('alpha')] });
  const child = collection('child', 'A/B', { users: [access('alpha')] });
  const sibling = collection('sibling', 'A/C', { users: [access('alpha')] });
  const result = planCollectionUpdate(root, { ...root, users: [access('alpha', true)] },
    [root, child, sibling], ['child'], {}, { users: ['alpha'] });
  assert.deepEqual(result[0].model.users, [access('alpha', true)]);
  assert.deepEqual(result[1].model.users, []);
  assert.deepEqual(sibling.users, [access('alpha')]);
  assert.throws(() => planCollectionUpdate(root, root, [root, child], [], {},
    { users: ['alpha'] }), /勾选要撤销授权的子集合/);
  assert.throws(() => planCollectionUpdate(root, root,
    [root, { ...child, canEdit: () => false }], ['child'], {}, { users: ['alpha'] }), /没有修改权限/);
});

test('revocation choices include only selected collections and distinguish member and group IDs', () => {
  const selected = collection('selected', 'A/B', { users: [access('same'), access('child-only')],
    groups: [access('same')] });
  const excluded = collection('excluded', 'A/C', { users: [access('excluded')] });
  const candidates = enhancements.revocationCandidates([selected, excluded], ['selected'], [
    { id: 'same', type: 2, listName: 'Member' }, { id: 'same', type: 1, labelName: 'Team' },
    { id: 'child-only', type: 2, labelName: 'Child-only member' },
  ]);
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((c) => c.key).sort(), ['groups:same', 'users:child-only', 'users:same']);
  assert.equal(candidates.find((c) => c.key === 'users:same').label, '成员：Member');
  assert.equal(candidates.find((c) => c.key === 'groups:same').label, '群组：Team');
  assert.deepEqual(enhancements.revocationCandidates([selected, excluded], []), []);
});

test('single-item grants allow only supported member permission modes', () => {
  assert.deepEqual(enhancements.itemGrants(new Map([
    ['alpha', 'view'],
    ['beta', 'view-hidden'],
    ['gamma', 'edit'],
    ['delta', 'edit-hidden'],
  ])), [
    { id: 'alpha', readOnly: true, hidePasswords: false, manage: false },
    { id: 'beta', readOnly: true, hidePasswords: true, manage: false },
    { id: 'gamma', readOnly: false, hidePasswords: false, manage: false },
    { id: 'delta', readOnly: false, hidePasswords: true, manage: false },
  ]);
  assert.throws(() => enhancements.itemGrants(new Map([['alpha', 'manage']])), /不支持/);
});

test('cloning a login drops its deterministic single-item access collection', () => {
  const source = collection('cipher-id', 'A', { collectionIds: ['cipher-id', 'ordinary'] });
  const clone = enhancements.cloneSourceWithoutItemAccess(source);
  assert.deepEqual(clone.collectionIds, ['ordinary']);
  assert.deepEqual(source.collectionIds, ['cipher-id', 'ordinary']);
});

test('single-item access entry supports SDK/legacy logins and excludes ordinary members and personal items', () => {
  const row = { organizations: [{ id: 'org', isAdmin: true }], cipher: { type: 1, organizationId: 'org' } };
  assert.equal(enhancements.canAssignItemAccess(row), true);
  assert.equal(enhancements.canAssignItemAccess({ ...row, cipher: { ...row.cipher, type: { login: {} } } }), true);
  assert.equal(enhancements.canAssignItemAccess({ ...row, cipher: { ...row.cipher, type: { card: {} } } }), false);
  assert.equal(enhancements.canAssignItemAccess({ ...row, cipher: { ...row.cipher, organizationId: null } }), false);
  assert.equal(enhancements.canAssignItemAccess({ ...row, organizations: [{ id: 'org', isAdmin: false }] }), false);
  for (const flag of ['disabled', 'isDeleted', 'isPartial']) {
    assert.equal(enhancements.canAssignItemAccess({ ...row, [flag]: true }), false);
  }
});

test('single-item save sends encrypted grants and merges only its local collection association', async () => {
  const calls = [], cached = [];
  const stored = { collectionIds: ['original'], toCipherData() { return { collectionIds: this.collectionIds }; } };
  const row = {
    cipher: { id: 'cipher-id', organizationId: 'org', name: 'Mock/Login' },
    accountService: { activeAccount$: { id: 'user' } },
    vwCollectionAdminService: {
      encrypt: async (model, userId, edit) => {
        assert.equal(userId, 'user');
        assert.equal(edit, false);
        assert.match(model.name, /^单项授权\/Mock · Login/);
        return { name: 'encrypted-name', users: model.users };
      },
      apiService: { send: async (...args) => {
        calls.push(args);
        return { collection: { id: 'cipher-id', assigned: true }, revisionDate: '2026-01-01T00:00:00Z' };
      } }, updateLocalCollections: async (value) => cached.push(value.id),
    },
    cipherService: { get: async () => stored, upsert: async (value) => cached.push(value.collectionIds) },
  };
  await enhancements.saveItemAccess(row, new Map([['member', 'view-hidden']]), 'user', async (v) => v);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], '/organizations/org/ciphers/cipher-id/item-access');
  assert.equal(calls[0][2].name, 'encrypted-name');
  assert.deepEqual(calls[0][2].users, [{ id: 'member', readOnly: true, hidePasswords: true, manage: false }]);
  assert.deepEqual(cached, ['cipher-id', ['original', 'cipher-id']]);
  assert.equal(stored.revisionDate.toISOString(), '2026-01-01T00:00:00.000Z');
  row.accountService.activeAccount$.id = 'other-user';
  await assert.rejects(enhancements.saveItemAccess(row, new Map(), 'user', async (v) => v), /账号已变化/);
  assert.equal(calls.length, 1);
});

test('cache failures after a committed single-item grant do not invite duplicate writes', async () => {
  const row = { cipher: { id: 'cipher', name: 'Login', organizationId: 'org' },
    accountService: { activeAccount$: { id: 'user' } },
    vwCollectionAdminService: {
      encrypt: async () => ({}),
      apiService: { send: async () => ({ collection: { id: 'cipher' } }) },
      updateLocalCollections: async () => { throw new Error('cache failure'); },
    } };
  const response = await enhancements.saveItemAccess(row, new Map(), 'user', async (v) => v);
  assert.equal(response.needsRefresh, true);
});

test('an empty single-item response removes a stale local reserved association', async () => {
  const requests = [];
  const stored = {
    collectionIds: ['item-id', 'other-collection'],
    toCipherData() { return this; },
  };
  const row = {
    cipher: { id: 'item-id', organizationId: 'org', name: 'Demo login' },
    accountService: { activeAccount$: { id: 'user' } },
    vwCollectionAdminService: {
      encrypt: async () => ({ name: 'encrypted-name', users: [] }),
      apiService: {
        send: async (...args) => {
          requests.push(args);
          return { collection: null, users: [], members: [],
            revisionDate: '2026-11-06T00:00:00.000Z' };
        },
      },
      updateLocalCollections: async () => { throw new Error('must not update a missing collection'); },
    },
    cipherService: {
      get: async () => stored,
      upsert: async () => {},
    },
  };
  const result = await enhancements.saveItemAccess(row, new Map(), 'user', async (v) => v);
  assert.equal(result.collection, null);
  assert.equal(requests.length, 1);
  assert.deepEqual(stored.collectionIds, ['other-collection']);
});

function memberCollection(id, path, extra = {}) {
  return { id, type: 0, listName: path, labelName: path, ...extra };
}

test('member collection tree keeps ancestors, real duplicate IDs and readonly group grants', () => {
  const rows = enhancements.memberCollectionRows([
    memberCollection('leaf', 'A/Missing/Leaf'), memberCollection('root', 'A'),
    memberCollection('duplicate-one', 'B/Shared'), memberCollection('duplicate-two', 'B/Shared'),
    memberCollection('leaf-group', 'A/Missing/Leaf', { readonly: true, viaGroupName: 'Team', readonlyPermission: 'edit' }),
    { id: 'not-a-collection', type: 1, listName: 'Excluded' },
  ]);
  assert.deepEqual(rows.map((r) => [r.path, r.item?.id]), [
    ['A', 'root'], ['A/Missing', undefined], ['A/Missing/Leaf', 'leaf'],
    ['B', undefined], ['B/Shared', 'duplicate-one'], ['B/Shared', 'duplicate-two'],
  ]);
  assert.deepEqual(rows[0].ids, ['leaf', 'root']);
  assert.deepEqual(rows[1].ids, ['leaf']);
  assert.equal(rows[2].inherited[0].viaGroupName, 'Team');
  assert.deepEqual(rows[3].ids, ['duplicate-one', 'duplicate-two']);
  assert.equal(rows[4].primary, true);
  assert.equal(rows[5].primary, false);
  assert.equal(rows[4].duplicate, true);
});

test('member tree search retains context without granting unmatched parents or siblings', () => {
  const items = [memberCollection('root', 'Root'), memberCollection('branch', 'Root/Branch'),
    memberCollection('target', 'Root/Branch/Target'), memberCollection('sibling', 'Root/Branch/Other'),
    memberCollection('prefix', 'Root/BranchBackup/Other'), memberCollection('outside', 'Elsewhere')];
  const rows = enhancements.memberCollectionRows(items, '  target  ');
  assert.deepEqual(rows.map((r) => r.path), ['Root', 'Root/Branch', 'Root/Branch/Target']);
  assert.deepEqual(rows.map((r) => r.matched), [false, false, true]);
  assert.ok(rows.every((r) => r.ids.length === 1 && r.ids[0] === 'target'));
  const branch = enhancements.memberCollectionRows(items).find((r) => r.item?.id === 'branch');
  assert.deepEqual(branch.ids, ['branch', 'target', 'sibling']);
  assert.deepEqual(enhancements.memberCollectionRows(items, 'absent'), []);
});

test('member tree search includes readonly matches but no writable synthetic or inherited IDs', () => {
  const items = [memberCollection('leaf-group', 'Invisible/Leaf', {
    readonly: true, viaGroupName: 'Team', readonlyPermission: 'view',
  }), memberCollection('protected', 'Protected', { readonly: true }),
  memberCollection('vw-ancestor:org:path', 'Synthetic'),
  memberCollection('structural', 'Structure', { vwStructuralOnly: true }),
  memberCollection('empty-group', 'Group', { viaGroupName: '' })];
  const rows = enhancements.memberCollectionRows(items, 'leaf');
  assert.deepEqual(rows.map((r) => r.path), ['Invisible', 'Invisible/Leaf']);
  assert.ok(enhancements.memberCollectionRows(items).every((r) => r.ids.length === 0));
  assert.equal(rows[1].item, undefined);
  assert.equal(rows[1].inherited[0].id, 'leaf-group');
});

test('member scope selection and clearing never change the saved or staged direct grants', () => {
  const values = [{ id: 'parent', type: 0, permission: 'view' }];
  const selected = new Set();
  const branch = enhancements.memberCollectionRows([
    memberCollection('parent', 'A'), memberCollection('child', 'A/B'),
    memberCollection('other', 'AB/C'),
  ])[0];
  enhancements.toggleSelection(selected, branch.ids);
  assert.deepEqual([...selected], ['parent', 'child']);
  enhancements.toggleSelection(selected, branch.ids);
  assert.deepEqual([...selected], []);
  assert.deepEqual(values, [{ id: 'parent', type: 0, permission: 'view' }]);
});

test('member bulk grant and revoke change only exact chosen direct grants and preserve other dimensions', () => {
  const items = [memberCollection('parent', 'A'), memberCollection('child', 'A/B'),
    memberCollection('sibling', 'A/C'), memberCollection('readonly', 'Protected', { readonly: true }),
    memberCollection('group-derived', 'A/B', { readonly: true, viaGroupName: 'Team' })];
  const initial = [{ id: 'sibling', type: 0, permission: 'manage' },
    { id: 'readonly', type: 0, permission: 'view' }, { id: 'group-derived', type: 0, permission: 'edit' },
    { id: 'actual-group', type: 1 }];
  const granted = enhancements.planMemberCollectionAccess(items, initial, ['parent', 'child'], 'viewExceptPass');
  assert.deepEqual(granted.slice(0, initial.length), initial);
  assert.deepEqual(granted.slice(initial.length), [
    { id: 'parent', type: 0, permission: 'viewExceptPass' },
    { id: 'child', type: 0, permission: 'viewExceptPass' },
  ]);
  const revoked = enhancements.planMemberCollectionAccess(items, granted, ['child'], null);
  assert.deepEqual(revoked, [...initial, { id: 'parent', type: 0, permission: 'viewExceptPass' }]);
  assert.deepEqual(enhancements.planMemberCollectionAccess(items, revoked, ['child'], null), revoked);
  assert.equal(initial.length, 4);
});

test('member permission planner rejects structural, inherited, readonly and unknown scopes atomically', () => {
  const items = [memberCollection('allowed', 'A'), memberCollection('readonly', 'B', { readonly: true }),
    memberCollection('inherited', 'C', { viaGroupName: 'Team', readonly: true }),
    memberCollection('vw-ancestor:org:path', 'D')];
  const values = [{ id: 'allowed', type: 0, permission: 'view' }];
  for (const id of ['readonly', 'inherited', 'vw-ancestor:org:path', 'foreign-org-id']) {
    assert.throws(() => enhancements.planMemberCollectionAccess(items, values, ['allowed', id], 'manage'), /无修改权限/);
  }
  assert.throws(() => enhancements.planMemberCollectionAccess(items, values, [], 'view'), /先选择/);
  for (const mode of ['unknown', undefined, '__proto__', 'view-hidden']) {
    assert.throws(() => enhancements.planMemberCollectionAccess(items, values, ['allowed'], mode), /不支持/);
  }
  assert.deepEqual(values, [{ id: 'allowed', type: 0, permission: 'view' }]);
});

test('member planner supports all upstream modes, deduplicates scope and does not implicitly add descendants', () => {
  const items = [memberCollection('parent', 'A'), memberCollection('child', 'A/B')];
  for (const mode of ['view', 'viewExceptPass', 'edit', 'editExceptPass', 'manage']) {
    assert.deepEqual(enhancements.planMemberCollectionAccess(items, [], ['parent', 'parent'], mode),
      [{ id: 'parent', type: 0, permission: mode }]);
  }
});

test('member edits flow through the upstream form once and exclude disabled group-derived rows from submission', () => {
  const items = [memberCollection('one', 'A'), memberCollection('other', 'B'),
    memberCollection('inherited', 'A', { readonly: true, viaGroupName: 'Team' })];
  let raw = [{ id: 'other', type: 0, permission: 'edit' }, { id: 'inherited', type: 0, permission: 'manage' }];
  const notifications = [];
  let touched = 0, writes = 0;
  const array = { getRawValue: () => raw, get value() { return raw.filter((v) => v.id !== 'inherited'); } };
  const component = { disabled: () => false, permissionMode: () => 'edit',
    selectionList: { allItems: items, formArray: array },
    writeValue: (value) => { raw = value; writes++; },
    notifyOnChange: () => (value) => notifications.push(value), handleBlur: () => touched++,
  };
  enhancements.applyMemberCollectionAccess(component, ['one'], 'view');
  assert.equal(writes, 1);
  assert.equal(touched, 1);
  assert.deepEqual(notifications, [[{ id: 'other', type: 0, permission: 'edit' }, { id: 'one', type: 0, permission: 'view' }]]);
  assert.ok(raw.some((v) => v.id === 'inherited' && v.permission === 'manage'));
  enhancements.applyMemberCollectionAccess(component, ['one'], null);
  assert.equal(writes, 2);
  assert.deepEqual(notifications[1], [{ id: 'other', type: 0, permission: 'edit' }]);
  component.disabled = () => true;
  assert.throws(() => enhancements.applyMemberCollectionAccess(component, ['other'], null), /只读/);
  component.disabled = () => false;
  component.permissionMode = () => 'readonly';
  assert.throws(() => enhancements.applyMemberCollectionAccess(component, ['other'], null), /只读/);
  component.permissionMode = () => 'edit';
  component.notifyOnChange = () => null;
  assert.throws(() => enhancements.applyMemberCollectionAccess(component, ['other'], null), /尚未加载/);
  assert.equal(writes, 2);
});

test('member selector hooks register once, skip other form controls and unsubscribe on destruction', () => {
  let subscriptions = 0, unsubscribed = 0, disconnected = 0;
  enhancements.start({ document: { documentElement: {}, addEventListener() {} },
    MutationObserver: class { observe() {} disconnect() { disconnected++; } },
    requestAnimationFrame() {}, addEventListener() {},
  });
  const component = { selectionList: { formArray: { valueChanges: { subscribe: () => {
    subscriptions++;
    return { unsubscribe: () => { unsubscribed++; } };
  } } } } };
  const host = { getAttribute: () => 'access', closest: () => null, classList: { remove() {} } };
  enhancements.registerMemberCollectionSelector(component, host);
  enhancements.registerMemberCollectionSelector(component, host);
  enhancements.registerMemberCollectionSelector({}, { getAttribute: () => 'groups' });
  assert.equal(subscriptions, 1);
  enhancements.unregisterMemberCollectionSelector(component);
  enhancements.unregisterMemberCollectionSelector(component);
  assert.equal(unsubscribed, 1);
  assert.equal(disconnected, 1);
});

test('revoking the last direct grant cannot submit disabled group-derived or protected IDs', () => {
  const items = [memberCollection('direct', 'A'),
    memberCollection('collection-group-synthetic-id', 'A', { readonly: true, viaGroupName: 'Team' }),
    memberCollection('protected', 'Protected', { readonly: true })];
  let raw = [{ id: 'direct', type: 0, permission: 'view' },
    { id: 'collection-group-synthetic-id', type: 0, permission: 'manage' },
    { id: 'protected', type: 0, permission: 'view' }];
  const notifications = [];
  const array = { getRawValue: () => raw,
    get disabled() { return !raw.some((v) => v.id === 'direct'); },
    // Angular disabled arrays expose all their disabled children's values.
    get value() { return this.disabled ? raw : raw.filter((v) => v.id === 'direct'); },
  };
  const component = { disabled: () => false, permissionMode: () => 'edit',
    selectionList: { allItems: items, formArray: array },
    writeValue: (next) => { raw = next; }, notifyOnChange: () => (value) => notifications.push(value),
    handleBlur() {},
  };
  enhancements.applyMemberCollectionAccess(component, ['direct'], null);
  assert.equal(raw.length, 2);
  assert.deepEqual(notifications, [[]]);
});
