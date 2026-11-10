# Vault scrolling, collection management and item access

The enhanced web client fixes the current vault layout and collection workflows.
It uses the existing encrypted collection format and preserves collection IDs and
item associations.

For Chinese usage instructions and permission cautions, see
[FEATURE_GUIDE.md](FEATURE_GUIDE.md). For local setup, see
[DEVELOPMENT.md](DEVELOPMENT.md).

## Behavior

- The filter tree and results list scroll independently. The filter title and
  search field stay pinned at the top of the left pane while its collection tree
  scrolls. The results pane is also the Angular CDK virtual list's scroll host,
  so large vaults continue rendering rows as they scroll. Selecting a filter
  resets only the results scroll position.
- The Admin Console organization vault uses the same independent panes and keeps
  its filter title and search field visible while the collection tree scrolls.
  Its collection search includes descendant paths only after intersecting the
  current organization cipher snapshot; the admin collection catalog cannot grant
  a cipher that the account cannot already read.
- Admin Console member and group tables use the CDK viewport as their own scroll
  host. Their search/header controls and the member status filter remain visible
  while rows scroll. Switching organization or management pages clears stale list
  searches, while changing only the search text does not clear the active query.
- Selecting a collection, folder, organization or item type clears the previous
  text search. Following a collection from search results also clears it. A
  pending search debounce cannot restore text cleared by navigation.
- A searchable query inside a collection includes that collection and its
  descendants at every depth, intersected with the current account's authorized
  cipher snapshot. The scope comes only from that account's decrypted collection
  tree, never from the admin catalog or a new server-side search. Empty or
  non-searchable queries retain direct-only browsing. All other upstream filter
  conditions still apply. Structural parents include accessible descendants
  without granting access to the real parents; path-segment and organization
  boundaries prevent sibling, similar-prefix and cross-organization matches.
  Missing selections fail closed. Collection/cipher updates recompute the scope,
  switchMap discards superseded asynchronous results, and an active-account
  guard clears results when the view's original account is no longer active.
  No collection scope is cached between accounts or queries. Both basic and
  advanced search retain the complete authorized input snapshot, avoiding a
  stale per-account advanced-search index after switching collection scopes;
  returned results are intersected with the same snapshot before scope filtering.
- The collection access tab has a descendant tree. Select all, select a branch,
  clear the selection or choose individual descendants. Only access changes made
  in the current edit propagate to selected descendants. Unrelated member and
  group grants remain intact. A partially selected branch or global scope clears
  with one click; it does not first expand to a full selection. A node's checkbox
  selects that collection only; its branch button includes the descendants.
- Descendant checkboxes are the scope of the current edit, not a display of
  saved access. Unchecking a scope does not revoke a saved grant. No descendants
  are selected by default when a dialog is reopened, and unchanged parent grants
  are not silently copied into the selected descendants.
- The descendant panel also has an explicit member/group revocation control.
  It lists direct grants in the selected descendants, including a member already
  removed from the parent. Queue a revocation and save once to remove only that
  subject's grants in the selected descendants. The parent, unselected branches,
  and other subjects remain unchanged. An individual queued action or the whole
  dialog can be cancelled without writing anything. A queued revocation with an
  empty scope is blocked with an inline error; correcting the scope retains the
  queued action. The scope controls are frozen while the request is pending.
- Missing parent paths appear as structural nodes, allowing a user with access
  only to descendants to browse the complete hierarchy. These nodes grant no
  access, have no edit/delete actions, and cannot be saved as real collections.
- The member editor's Collections tab replaces the flat selector with an
  expandable, searchable hierarchy. It supports individual, branch and global
  operation scopes, bulk permission changes, bulk direct-grant removal and
  per-row permission edits. Group-derived access is shown separately and stays
  readonly. Scope selection is distinct from saved access, and partial scopes
  clear with one click. Search preserves ancestor context but only matching
  editable collections can be targeted; changing the query clears the scope
  without discarding staged edits. All changes flow through the existing member
  form and require its final Save; closing the dialog discards unsaved edits.
- Renaming or moving a collection rewrites the path prefix of its descendants,
  retaining every collection ID, external ID, independent access grant and item
  association. Self-nesting, collisions and uneditable descendants reject the
  whole edit. A user without visibility of all organization collections must ask
  an administrator to rename or move a collection: encrypted paths prevent the
  client from safely discovering invisible descendants.
- Creating a collection checks for an existing visible collection at the same
  organization/path. Blank path segments and leading/trailing whitespace in a
  new leaf name are rejected with an inline form error. Duplicate comparisons
  trim each segment and normalize Unicode to NFC, without rewriting stored names.
  The same leaf name remains valid under different parents or in different
  organizations. Permission-only edits to legacy duplicate/whitespace names
  remain possible. Renames also check normalized destination collisions.
- Organization-wide grants still apply. Individual collection permissions cannot
  lower an owner's, administrator's or full-access member's organization access.
- Organization owners and administrators can assign access to one login item from
  its row. The available modes are view, view with the password hidden, edit, and
  edit with the password hidden. This grant is additive: it does not expose the
  item's other collections or their items, and removing it cannot lower access
  inherited from an organization, collection, or group.
- Single-item access is stored in a deterministic, system-managed collection
  whose ID equals the cipher ID and whose external ID starts with
  `vaultwarden:item-access:`. The collection contains exactly that login item;
  the original collection IDs, encrypted item data, and existing access rows are
  retained. The normal collection update, bulk access, clone, and import paths
  cannot repurpose this reserved collection. Imports sanitize a copied reserved
  marker on new collections and reject attempts to target an existing reserved
  collection.

These behaviors apply to this enhanced web client. Other Bitwarden clients use
existing APIs and do not acquire automatic subtree renaming from this change.
Duplicate checks use the collections visible to the current user; encrypted names
cannot be compared by the server. They do not enforce global uniqueness across
hidden collections, concurrent clients or imports, and do not merge existing
duplicates.

## Preparing the web client

This repository contains a downloaded upstream web-vault release, not its Angular
source tree. Readable extensions live in `web-vault-custom/enhancements.js` and
`enhancements.css`; exact bundle hooks live in `tools/web_vault_patches.py`.

Supported upstream bundle: **2026.10.1**, SHA-256
`5defb27621655bc05a54d042e32ce21d66dadd337b3bc60bc0cb49c234e441d1`.
The Admin Console organization-vault search hook also pins and rewrites lazy
chunk `397.140f77b7f5a3e6236b43.js`; preparation updates the main bundle's
Webpack filename map so the patched chunk is loaded with a new cache-busting hash.
Preparation refuses an unsupported or modified original bundle and requires each
hook to match exactly once. An upstream upgrade requires reviewing and adapting
the hooks. The original bundle is retained. Generated JavaScript and styles use
content hashes to avoid immutable-cache problems.

After building the updated SQLite backend, prepare the product enhancements:

```bash
python3 tools/prepare_web_vault.py
```

For the local HTTPS environment on port 8001, use:

```bash
bash tools/dev.sh web
bash tools/dev.sh run --offline
```

The local helper additionally enables the existing `Never` session timeout and
session-backed auto-unlock only on HTTPS loopback origins using port 8001.
Reload the web client after preparation. Restore the upstream client with
`python3 tools/prepare_web_vault.py --restore` or
`bash tools/dev.sh web --restore`.

## Atomic update API

`POST /api/organizations/<organization-id>/collections/bulk-update` accepts:

```json
{
  "collections": [
    {
      "id": "existing-collection-uuid",
      "name": "encrypted-name",
      "externalId": null,
      "users": [
        { "id": "organization-membership-uuid", "readOnly": true,
          "hidePasswords": false, "manage": false }
      ]
    }
  ]
}
```

`name: null` preserves a protected name. Omitting `users` or `groups` preserves
that access dimension; supplying an array replaces it. The frontend merges the
current edit's access delta into each selected descendant before encryption.
`externalId` is the existing/current value, or null to clear it.

All IDs must be unique, every collection must belong to the organization and be
manageable by the caller, and each supplied member/group must belong to that
organization. All collection and access writes run inside one database
transaction. The transaction only updates existing collections. It never creates
collections or rewrites `ciphers_collections`. Organization user revisions update
in the same transaction, including members whose access is removed. Successful
updates produce collection audit events and return assigned flags for cache
updates. Unauthorized or invalid requests fail before any persistent change.
After the commit, all organization members, including removed assignees, receive
a vault-sync notification. Connected clients can drop revoked items without
logging in again or manually refreshing. Offline clients still need to reconnect
and sync; already decrypted or copied secrets cannot be recalled. Other access
sources, including group, organization-wide and single-item grants, still apply.

## Single-item access API

Owners and administrators can read or replace the direct grants for one
organization login:

```text
GET /api/organizations/<organization-id>/ciphers/<cipher-id>/item-access
PUT /api/organizations/<organization-id>/ciphers/<cipher-id>/item-access
```

The `PUT` body contains an encrypted collection name and a list of confirmed
organization membership IDs with `readOnly` and `hidePasswords` flags. `manage`
is rejected for this endpoint. The server verifies that the target is a
non-deleted organization login, the memberships belong to the same organization,
and the deterministic reserved collection is bound to exactly that cipher. The
collection and its user access rows are written in one transaction, revisions
are bumped for organization members, and a vault sync notification is sent.
The response includes the direct grants, eligible members, the reserved
collection details and the target revision date so the web client can update its
encrypted cache without replacing the source item's other associations.
Saving an item with no direct grants does not create an empty reserved
collection when one did not already exist.

## Verification

```bash
bash tools/dev.sh test --offline
bash tools/dev.sh clippy --offline --all-targets -- -D warnings
bash tools/dev.sh fmt
node --test web-vault-custom/enhancements.test.cjs
python3 tools/test_prepare_web_vault.py
```

The SQLite tests cover ID and association preservation, permission writes,
parent/child revocation without removing independent member or group grants,
idempotent access writes, rollback after an invalid later operation, and
foreign-organization records.
Frontend tests cover path boundaries, collisions, protected names, complete
visibility, access deltas, structural ancestors, revoked access, stale search
callbacks, all partial-selection states, child-only member/group revocations,
typed revocation choices, item permission modes, cloning and one
encrypted batch with local cache updates. Creation tests cover
sibling duplicates, organization/parent separation, whitespace, Unicode-equivalent
paths, legacy permission edits, fresh pre-create validation and validator cleanup.
Member-editor tests cover hierarchy and duplicate IDs, missing ancestors,
readonly/group-derived rows, filtered operation boundaries, all permission modes,
independent grant preservation, selection clearing, CVA notifications and
subscription cleanup.
Recursive-search tests cover deep descendants, structural parents, exact path
and organization boundaries, duplicate paths, Unicode/case-sensitive hierarchy,
unauthorized candidates, multi-collection membership, failed name decryption,
revoked/missing scopes, account isolation, unchanged non-collection filters and
direct-only browsing without a searchable query. Basic and advanced queries use
the same authorized candidate set; forged or stale search results are rejected.
Preparation tests
cover every pinned hook, both collection terminology modes, idempotence, resource
cache busting, reactive descendant-search wiring, upgrade from the earlier local
patch and exact restoration.

### Parent/Child Permission Regression

Run live checks only against an isolated database containing fake accounts and
items. Give each node a distinct dummy login, include an unselected sibling and
a similar-prefix path, and keep an independent grant for a second member.
Compare the actual access rows and each member's sync results, not just the
checkboxes or the save toast.

| Scenario | Expected result |
| --- | --- |
| Grant only the parent | Its login is visible; descendant logins are not. |
| Select a branch | Only its exact path boundary is included, not similar-prefix or sibling paths. |
| Clear a partly selected branch or scope | One click clears it, without changing other branches or saved grants. |
| Cancel the dialog or a queued revocation | No access writes; reopening has no residual selections or tasks. |
| Revoke the parent and all selected descendants | One save removes all targeted grants and preserves independent grants. |
| Parent grant was removed in an earlier edit | Explicit descendant revocation removes remaining grants in one save without re-granting the parent. |
| Queue a revocation, then clear its scope | Save is blocked, no writes occur, and the task survives scope correction. |
| Ordinary member submits a bulk grant | Request is denied, with no partial changes. |
| Limited manager targets a parent or sibling they do not manage | Whole request is denied, even when it also includes a manageable leaf. |
| Invalid or duplicate collection/member IDs, or another organization route | Request is denied, with no persistent changes. |
| Change access while the member remains logged in | On a stable notification connection, the list updates without re-login or manual refresh. |

Also check group-derived and organization-wide grants when evaluating effective
access. The automated model and planner tests do not replace multi-group browser,
concurrency, offline-revocation or external-client compatibility testing. Keep
execution records, screenshots and account details outside the repository; the
local `docs/UX_REVIEW.md` is ignored.
