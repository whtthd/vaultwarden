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
    nestedCollectionTraverse(nodes, 0, model.name.split('/'), model, undefined, '/', treeNode);
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
  class FakeElement { closest() { return this; } }
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
  const legacy = collection('legacy', ' A /Caf\u0065\u0301 ');
  assert.match(enhancements.collectionPathError(collection(undefined, 'A/Caf\u00e9'), [legacy]), /同名/);
  assert.equal(legacy.name, ' A /Caf\u0065\u0301 ');
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
