/* Vaultwarden web-vault extensions for the pinned upstream release. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.VaultwardenEnhancements = api;
    api.start(root);
  }
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";

  const structuralPrefix = "vw-ancestor:";
  const dialogs = new Map();
  const memberSelectors = new Map();
  const scrollHosts = new Set();
  const cipherRows = new Map();
  let itemDialog;
  let win;
  let scheduled = false;
  let layout;
  let memberSelectorId = 0;

  function copy(model) {
    return Object.assign(Object.create(Object.getPrototypeOf(model)), model);
  }

  function isDescendant(child, parent) {
    return child.organizationId === parent.organizationId && child.id !== parent.id &&
      child.name.startsWith(parent.name + "/");
  }

  function permission(entry) {
    return { id: entry.id, readOnly: !!entry.readOnly,
      hidePasswords: !!entry.hidePasswords, manage: !!entry.manage };
  }

  function accessDelta(before = [], after = []) {
    const previous = new Map(before.map((e) => [e.id, permission(e)]));
    const next = new Map(after.map((e) => [e.id, permission(e)]));
    return {
      remove: [...previous.keys()].filter((id) => !next.has(id)),
      set: [...next.values()].filter((entry) =>
        JSON.stringify(previous.get(entry.id)) !== JSON.stringify(entry)),
    };
  }

  function applyDelta(entries = [], delta) {
    const access = new Map(entries.map((e) => [e.id, { ...e }]));
    for (const id of delta.remove) access.delete(id);
    for (const entry of delta.set) access.set(entry.id, { ...entry });
    return [...access.values()];
  }

  function changed(delta) { return delta.remove.length > 0 || delta.set.length > 0; }

  function selectionState(selected, ids) {
    const count = ids.filter((id) => selected.has(id)).length;
    return { all: ids.length > 0 && count === ids.length, mixed: count > 0 && count < ids.length };
  }

  function toggleSelection(selected, ids) {
    const status = selectionState(selected, ids);
    const remove = status.all || status.mixed;
    for (const id of ids) {
      if (remove) selected.delete(id);
      else selected.add(id);
    }
  }

  const memberPermissions = {
    view: "查看项目", viewExceptPass: "查看项目，隐藏密码",
    edit: "编辑项目", editExceptPass: "编辑项目，隐藏密码", manage: "管理集合",
  };

  function editableMemberCollection(item) {
    return item.type === 0 && !item.readonly && item.viaGroupName == null && !item.vwStructuralOnly &&
      typeof item.id === "string" && !item.id.startsWith(structuralPrefix);
  }

  function memberCollectionRows(items, query = "") {
    const roots = new Map();
    const search = query.trim().normalize("NFC").toLocaleLowerCase();
    for (const item of items.filter((i) => i.type === 0)) {
      const path = item.listName ?? item.labelName ?? "";
      const parts = path.split("/");
      let children = roots;
      let node;
      for (let depth = 0; depth < parts.length; depth++) {
        const name = parts[depth];
        if (!children.has(name)) {
          children.set(name, { name, path: parts.slice(0, depth + 1).join("/"),
            depth, children: new Map(), items: [], inherited: [], ids: [] });
        }
        node = children.get(name);
        if (editableMemberCollection(item) && path.normalize("NFC").toLocaleLowerCase().includes(search)) {
          node.ids.push(item.id);
        }
        children = node.children;
      }
      if (item.viaGroupName != null) node.inherited.push(item);
      else node.items.push(item);
    }
    const rows = [];
    function visit(nodes) {
      for (const node of [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))) {
        const matched = node.path.normalize("NFC").toLocaleLowerCase().includes(search);
        // Keep matching readonly rows and their ancestors without making them write targets.
        const children = [];
        const previous = rows.length;
        for (const item of node.items.length ? node.items : [undefined]) {
          children.push({ ...node, item, matched, primary: children.length === 0,
            duplicate: node.items.length > 1 });
        }
        rows.push(...children);
        visit(node.children);
        if (search && !matched && rows.length === previous + children.length) rows.splice(previous);
      }
    }
    visit(roots);
    return rows;
  }

  function planMemberCollectionAccess(items, values, ids, mode) {
    if (mode !== null && !Object.hasOwn(memberPermissions, mode)) {
      throw new Error("不支持的集合权限级别。");
    }
    const selected = new Set(ids);
    if (!selected.size) throw new Error("请先选择要调整的集合。");
    const allowed = new Set(items.filter(editableMemberCollection).map((i) => i.id));
    if ([...selected].some((id) => !allowed.has(id))) {
      throw new Error("部分集合不存在或无修改权限，请重新选择。");
    }
    const next = values.filter((v) => v.type !== 0 || !selected.has(v.id)).map((v) => ({ ...v }));
    if (mode !== null) {
      for (const id of selected) next.push({ id, type: 0, permission: mode });
    }
    return next;
  }

  function applyMemberCollectionAccess(component, ids, mode) {
    if (component.disabled() || component.permissionMode() !== "edit") {
      throw new Error("当前集合权限为只读，无法修改。");
    }
    const notify = component.notifyOnChange();
    if (!notify) throw new Error("集合权限尚未加载完成，请稍后重试。");
    const next = planMemberCollectionAccess(component.selectionList.allItems,
      component.selectionList.formArray.getRawValue(), ids, mode);
    // Reuse the upstream CVA: disabled group-derived rows stay out of the submitted direct grants.
    component.writeValue(next);
    const array = component.selectionList.formArray;
    notify(array.disabled ? [] : array.value);
    component.handleBlur();
  }

  function registerMemberCollectionSelector(component, host) {
    if (memberSelectors.has(component) || host.getAttribute("formcontrolname") !== "access") return;
    const state = { component, host, selected: new Set(), collapsed: new Set(), query: "" };
    memberSelectors.set(component, state);
    state.subscription = component.selectionList.formArray.valueChanges.subscribe(schedule);
    if (win) {
      state.observer = new win.MutationObserver(schedule);
      state.observer.observe(host.closest("form") ?? host, {
        attributes: true, subtree: true, attributeFilter: ["disabled", "aria-busy"],
      });
    }
    schedule();
  }

  function unregisterMemberCollectionSelector(component) {
    const state = memberSelectors.get(component);
    state?.subscription.unsubscribe();
    state?.observer?.disconnect();
    state?.panel?.remove();
    state?.host.classList.remove("vw-member-collections");
    memberSelectors.delete(component);
  }

  function revocationCandidates(collections, selectedIds, subjects = []) {
    const selected = new Set(selectedIds);
    const candidates = new Map();
    for (const collection of collections.filter((c) => selected.has(c.id))) {
      for (const [dimension, type, title] of [["users", 2, "成员"], ["groups", 1, "群组"]]) {
        for (const grant of collection[dimension] || []) {
          const key = dimension + ":" + grant.id;
          const subject = subjects.find((s) => s.type === type && s.id === grant.id);
          const name = subject?.listName || subject?.labelName || grant.id;
          candidates.set(key, { key, dimension, id: grant.id, label: title + "：" + name });
        }
      }
    }
    return [...candidates.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
  }

  function collectionPathKey(name) {
    return name.split("/").map((part) => part.trim().normalize("NFC")).join("/");
  }

  function collectionPathError(edited, collections, original) {
    // Existing ambiguous names must not prevent unrelated permission edits.
    if (original && original.name === edited.name &&
        original.organizationId === edited.organizationId) return null;
    const parts = typeof edited.name === "string" ? edited.name.split("/") : [];
    if (!parts.length || parts.some((part) => !part.trim())) {
      return "集合名称的每一级都不能为空或仅包含空格。";
    }
    const name = parts[parts.length - 1];
    if (name !== name.trim()) return "集合名称首尾不能包含空格，请去除后重试。";
    const key = collectionPathKey(edited.name);
    if (collections.some((c) => !c.vwStructuralOnly && c.id !== original?.id &&
        c.organizationId === edited.organizationId && collectionPathKey(c.name) === key)) {
      return "当前位置已有同名集合，请更换名称或上级集合。";
    }
    return null;
  }

  function planCollectionUpdate(original, edited, collections, selectedIds, organization, revoke = {}) {
    if (!original || original.vwStructuralOnly || edited.id !== original.id ||
        edited.organizationId !== original.organizationId) {
      throw new Error("无法更新此集合，请刷新页面后重试。");
    }
    const descendants = collections.filter((c) => isDescendant(c, original));
    const renamed = original.name !== edited.name;
    if (renamed && organization?.canViewAllCollections === false) {
      throw new Error("无法确认不可见子集合的结构，请由可查看组织全部集合的管理员修改名称或上级集合。");
    }
    if (renamed && !original.canEditName(organization)) {
      throw new Error("此集合的名称不可修改。");
    }
    const pathError = collectionPathError(edited, collections, original);
    if (pathError) throw new Error(pathError);
    if (renamed && edited.name.startsWith(original.name + "/")) {
      throw new Error("不能将集合移动到它自己的子集合中。");
    }
    if (renamed && collections.some((c) => c.id !== original.id &&
        c.organizationId === original.organizationId && c.name === original.name)) {
      throw new Error("存在重名的集合路径，请先消除重名后再修改结构。");
    }
    const users = accessDelta(original.users, edited.users);
    const groups = accessDelta(original.groups, edited.groups);
    const selected = new Set(selectedIds);
    if ([...selected].some((id) => !descendants.some((c) => c.id === id))) {
      throw new Error("选中的子集合已发生变化，请重新打开编辑窗口。");
    }
    if (!selected.size && ((revoke.users?.length || 0) + (revoke.groups?.length || 0))) {
      throw new Error("请勾选要撤销授权的子集合，或取消已安排的撤销操作。");
    }
    function descendantDelta(delta, ids = []) {
      const remove = new Set([...delta.remove, ...ids]);
      return { remove: [...remove], set: delta.set.filter((grant) => !remove.has(grant.id)) };
    }
    const descendantUsers = descendantDelta(users, revoke.users);
    const descendantGroups = descendantDelta(groups, revoke.groups);
    const updates = [{ model: copy(edited), usersChanged: changed(users), groupsChanged: changed(groups) }];
    for (const child of descendants) {
      const accessChanged = selected.has(child.id) && (changed(descendantUsers) || changed(descendantGroups));
      if (!renamed && !accessChanged) continue;
      if (child.vwStructuralOnly || !child.canEdit(organization) ||
          (renamed && !child.canEditName(organization))) {
        throw new Error("部分子集合没有修改权限，无法保存。请联系管理员调整权限。");
      }
      const model = copy(child);
      if (renamed) model.name = edited.name + child.name.slice(original.name.length);
      if (accessChanged) {
        model.users = applyDelta(child.users, descendantUsers);
        model.groups = applyDelta(child.groups, descendantGroups);
      }
      updates.push({ model, usersChanged: accessChanged && changed(descendantUsers),
        groupsChanged: accessChanged && changed(descendantGroups) });
    }
    if (renamed) {
      const affected = new Set(updates.map((u) => u.model.id));
      const occupied = new Set(collections.filter((c) =>
        c.organizationId === original.organizationId && !affected.has(c.id))
        .map((c) => collectionPathKey(c.name)));
      const planned = new Set();
      for (const { model } of updates) {
        const key = collectionPathKey(model.name);
        if (occupied.has(key) || planned.has(key)) {
          throw new Error("目标位置已有同名集合，请更换名称或上级集合。");
        }
        planned.add(key);
      }
    }
    return updates;
  }

  // Missing ancestors carry no data access and never enter the encrypted collection store.
  function structuralCollection(source, path, name) {
    const node = copy(source);
    Object.assign(node, {
      id: structuralPrefix + encodeURIComponent(source.organizationId) + ":" + encodeURIComponent(path),
      fullName: path, name, defaultUserCollectionEmail: undefined,
      assigned: false, manage: false, readOnly: true, hidePasswords: true,
      unmanaged: false, users: [], groups: [], externalId: undefined, hideOptions: true, vwStructuralOnly: true,
    });
    for (const method of ["canEdit", "canEditName", "canDelete", "canViewCollectionInfo",
      "canEditItems", "canEditUserAccess", "canEditGroupAccess"]) node[method] = () => false;
    node.encrypt = node.toSdkCollectionView = () => { throw new Error("结构节点不可保存。"); };
    return node;
  }

  function nestedCollectionTraverse(tree, index, parts, model, parent, delimiter, makeNode) {
    let branch = tree;
    let ancestor = parent;
    for (let depth = index; depth < parts.length; depth++) {
      const path = parts.slice(0, depth + 1).join(delimiter);
      const name = parts[depth];
      const last = depth === parts.length - 1;
      let found = branch.find((n) => n.node.organizationId === model.organizationId &&
        (n.node.fullName === path || n.node.name === name));
      if (last) {
        if (found?.node.vwStructuralOnly) {
          model.fullName = path;
          model.name = name;
          found.node = model;
        } else {
          model.fullName = path;
          branch.push(makeNode(model, ancestor, name));
        }
        return;
      }
      if (!found) {
        found = makeNode(structuralCollection(model, path, name), ancestor, name);
        branch.push(found);
      }
      ancestor = found;
      branch = found.children;
    }
  }

  function navigationKey(hash) {
    const [path, query = ""] = hash.split("?");
    const params = new URLSearchParams(query);
    return path + "?" + ["collectionId", "sharedFolderId", "folderId", "organizationId",
      "vaultId", "type", "search"].map((key) => key + "=" + (params.get(key) || "")).join("&");
  }

  function searchMatchesInput(value, document = win?.document) {
    const input = document?.querySelector('app-vault-filter input[type="search"]');
    return !!input && input.value === (value ?? "");
  }

  function collectionSearchFilter(filter, collectionTree, makeFilter) {
    if (filter.collectionId === undefined || filter.collectionId === "all" ||
        filter.collectionId === "unassigned") return makeFilter(filter);

    const collections = [];
    const pending = [...(collectionTree ?? [])];
    while (pending.length) {
      const node = pending.pop();
      collections.push(node.node);
      pending.push(...node.children);
    }
    const matches = collections.filter((c) => c.id === filter.collectionId);
    // A missing/revoked selection must never fall back to searching the entire vault.
    if (matches.length !== 1 || !matches[0].organizationId) return () => false;
    const selected = matches[0];
    const path = selected.decryptionFailure ? undefined : selected.fullName;
    const ids = new Set(collections.filter((c) =>
      !c.vwStructuralOnly && typeof c.id === "string" && !c.id.startsWith(structuralPrefix) &&
      c.organizationId === selected.organizationId &&
      (c.id === selected.id || (!c.decryptionFailure && typeof path === "string" &&
        path.length > 0 && c.fullName?.startsWith(path + "/")))).map((c) => c.id));
    const otherFilters = makeFilter({ ...filter, collectionId: undefined });
    return (cipher) => cipher.organizationId === selected.organizationId &&
      Array.isArray(cipher.collectionIds) && cipher.collectionIds.some((id) => ids.has(id)) &&
      otherFilters(cipher);
  }

  async function searchVaultCiphers(component, userId, ciphers, filter, text, collectionTree,
    makeFilter, firstValueFrom) {
    const failed = await firstValueFrom(component.cipherService.failedToDecryptCiphers$(userId)) ?? [];
    const all = [...failed, ...ciphers];
    if (!await component.searchService.isSearchable(text)) return all.filter(makeFilter(filter));

    const predicate = collectionSearchFilter(filter, collectionTree, makeFilter);
    // Keep the complete authorized snapshot as input: the upstream advanced-search index is
    // cached per account, not per collection. Subset indexing could leave other scopes stale.
    const candidates = new Set(all);
    const results = await component.searchService.searchCiphers(userId, null, text, all);
    return results.filter((cipher) => candidates.has(cipher) && predicate(cipher));
  }

  function descendantRows(original, descendants) {
    const rows = new Map();
    const duplicates = [];
    for (const child of descendants) {
      const parts = child.name.slice(original.name.length + 1).split("/");
      for (let depth = 0; depth < parts.length; depth++) {
        const relative = parts.slice(0, depth + 1).join("/");
        const path = original.name + "/" + relative;
        let row = rows.get(path);
        if (!row) {
          row = { path, relative, depth, name: parts[depth], child: undefined };
          rows.set(path, row);
        }
        if (depth === parts.length - 1) {
          if (row.child) duplicates.push({ ...row, child });
          else row.child = child;
        }
      }
    }
    return [...rows.values(), ...duplicates].sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  }

  function registerScrollHost(host) { scrollHosts.add(host); schedule(); }
  function unregisterScrollHost(host) {
    if (host.vwScrollRef && host.service.scrollableRef() === host.vwScrollRef) {
      host.service.scrollableRef.set(host.ref);
    }
    scrollHosts.delete(host);
  }

  function updateLayout() {
    const vault = win.document.querySelector("main#main-content app-vault");
    const row = vault && [...vault.children].find((e) => e.classList.contains("tw-flex-row"));
    if (!row || row.children.length !== 2) {
      if (layout) {
        layout.main.classList.remove("vw-vault-layout");
        layout = undefined;
      }
      for (const host of scrollHosts) {
        if (host.vwScrollRef && host.service.scrollableRef() === host.vwScrollRef) {
          host.service.scrollableRef.set(host.ref);
          host.vwScrollRef = undefined;
        }
      }
      return;
    }
    const main = vault.closest("main");
    const [filters, results] = row.children;
    if (!layout || layout.results !== results) {
      main.classList.add("vw-vault-layout");
      vault.classList.add("vw-vault");
      row.classList.add("vw-vault-panes");
      filters.classList.add("vw-filter-pane");
      results.classList.add("vw-results-pane");
      for (const [pane, label] of [[filters, "密码库筛选"], [results, "密码库列表"]]) {
        pane.setAttribute("role", "region");
        pane.setAttribute("aria-label", label);
        pane.setAttribute("tabindex", "0");
      }
      main.scrollTop = 0;
      layout = { main, filters, results, key: undefined };
    }
    for (const host of scrollHosts) {
      if (host.ref.nativeElement !== main) continue;
      if (!host.vwScrollRef || host.vwScrollRef.nativeElement !== results) {
        host.vwScrollRef = { nativeElement: results };
        host.service.scrollableRef.set(host.vwScrollRef);
        win.requestAnimationFrame(() => win.dispatchEvent(new Event("resize")));
      }
    }
    const key = navigationKey(win.location.hash);
    if (layout.key !== key) {
      layout.key = key;
      results.scrollTop = 0;
      results.dispatchEvent(new Event("scroll"));
    }
  }

  function element(tag, className, text) {
    const node = win.document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function memberSelectorBusy(state) {
    const form = state.host.closest("form");
    return state.component.disabled() || state.component.permissionMode() !== "edit" ||
      !!form && [...form.querySelectorAll("button")].some((b) => b.type === "submit" && b.disabled);
  }

  function memberPermissionSelect(label, includeNone = false) {
    const select = element("select", "vw-member-permission");
    select.setAttribute("aria-label", label);
    for (const [value, title] of [
      ...(includeNone ? [["", "未直接授权"]] : []), ...Object.entries(memberPermissions),
    ]) {
      const option = element("option", "", title);
      option.value = value;
      select.append(option);
    }
    return select;
  }

  function memberCollectionAction(state, ids, mode) {
    if (memberSelectorBusy(state)) return;
    try {
      applyMemberCollectionAccess(state.component, ids, mode);
      state.status.textContent = mode === null ?
        `已暂存 ${ids.length} 项直接授权移除，点击底部“保存”生效。` :
        `已暂存 ${ids.length} 项“${memberPermissions[mode]}”，点击底部“保存”生效。`;
      state.status.setAttribute("role", "status");
    } catch (error) {
      state.status.textContent = error.message || "无法调整集合权限，请重新打开窗口。";
      state.status.setAttribute("role", "alert");
    }
    schedule();
  }

  function createMemberCollectionPanel(state) {
    const panel = element("fieldset", "vw-member-collection-panel");
    panel.append(element("legend", "", "按层级管理集合权限"),
      element("p", "vw-access-hint",
        "勾选用于批量操作，已有授权见每行权限；最后点击底部“保存”生效。群组及组织权限不变。"));
    const searchLabel = element("label", "vw-member-collection-search", "搜索集合（含完整路径）");
    const search = element("input", "vw-item-search");
    search.type = "search";
    search.placeholder = "输入集合名称或路径";
    search.id = `vw-member-collection-search-${++memberSelectorId}`;
    searchLabel.htmlFor = search.id;
    search.addEventListener("input", () => {
      state.query = search.value;
      state.selected.clear();
      schedule();
    });
    searchLabel.append(search);
    panel.append(searchLabel, element("p", "vw-access-hint",
      "筛选仅操作匹配项；换词清空选择，保留暂存修改。"));
    const controls = element("div", "vw-access-controls");
    const toggle = element("button", "vw-access-button", "全选集合");
    toggle.type = "button";
    toggle.addEventListener("click", () => { toggleSelection(state.selected, state.ids); schedule(); });
    const fold = element("button", "vw-access-button", "折叠全部");
    fold.type = "button";
    fold.addEventListener("click", () => {
      if (state.collapsed.size) state.collapsed.clear();
      else for (const row of state.rows.filter((r) => r.children.size)) state.collapsed.add(row.path);
      schedule();
    });
    const count = element("span", "vw-access-count");
    count.setAttribute("aria-live", "polite");
    controls.append(toggle, fold, count);
    const actions = element("div", "vw-member-bulk-actions");
    const permissionLabel = element("label", "", "批量权限");
    const permission = memberPermissionSelect("批量设置集合权限");
    permission.value = "view";
    permissionLabel.append(permission);
    const apply = element("button", "vw-member-apply", "应用到所选集合");
    apply.type = "button";
    apply.addEventListener("click", () => memberCollectionAction(state, [...state.selected], permission.value));
    const remove = element("button", "vw-access-button", "移除所选直接授权");
    remove.type = "button";
    remove.addEventListener("click", () => memberCollectionAction(state, [...state.selected], null));
    actions.append(permissionLabel, apply, remove);
    const status = element("p", "vw-member-selection-status vw-access-hint",
      "取消选择不会撤销暂存修改；关闭窗口可放弃。");
    status.setAttribute("role", "status");
    const tree = element("div", "vw-member-collection-tree");
    tree.setAttribute("role", "group");
    tree.setAttribute("aria-label", "成员集合权限树");
    const empty = element("p", "vw-access-hint", "没有匹配的集合。");
    panel.append(controls, actions, status, tree, empty);
    Object.assign(state, { panel, search, toggle, fold, count, permission, apply, remove, tree, empty, status });
    state.host.append(panel);
    state.host.classList.add("vw-member-collections");
  }

  function renderMemberCollectionSelector(state) {
    if (!state.host.isConnected || !state.host.closest("app-edit-member-dialog")) return;
    if (!state.panel) createMemberCollectionPanel(state);
    const items = state.component.selectionList.allItems;
    const key = JSON.stringify([state.query, items.map((i) => [i.id, i.type, i.listName, i.labelName,
      i.readonly, i.readonlyPermission, i.viaGroupName, i.vwStructuralOnly])]);
    if (state.treeKey !== key) {
      state.treeKey = key;
      state.rows = memberCollectionRows(items, state.query);
      state.ids = [...new Set(state.rows.flatMap((r) => r.ids))];
      const allowed = new Set(state.ids);
      state.selected = new Set([...state.selected].filter((id) => allowed.has(id)));
      state.views = [];
      const nodes = [];
      for (const row of state.rows) {
        const node = element("div", "vw-member-collection-row");
        node.style.setProperty("--vw-depth", Math.min(row.depth, 12));
        const heading = element("div", "vw-member-collection-name");
        const check = element("input");
        check.type = "checkbox";
        check.setAttribute("aria-label", `选择集合 ${row.path}${row.duplicate && row.item ? ` [${row.item.id}]` : ""}`);
        check.addEventListener("change", () => {
          if (!row.item) return;
          if (check.checked) state.selected.add(row.item.id);
          else state.selected.delete(row.item.id);
          schedule();
        });
        const fold = element("button", "vw-member-expand");
        fold.type = "button";
        fold.addEventListener("click", () => {
          if (state.collapsed.has(row.path)) state.collapsed.delete(row.path);
          else state.collapsed.add(row.path);
          schedule();
        });
        const name = element("span", "", row.name || "（空名称）");
        name.title = row.path;
        heading.append(check, fold, name);
        if (row.duplicate && row.item) heading.append(element("small", "vw-access-hint", `[${row.item.id.slice(0, 8)}]`));
        if (!row.item) heading.append(element("small", "vw-access-hint", row.inherited.length ? "群组授权" : "上级结构"));
        node.append(heading);
        let select;
        if (row.item && editableMemberCollection(row.item)) {
          select = memberPermissionSelect(`${row.path}${row.duplicate ? ` [${row.item.id}]` : ""} 的直接权限`, true);
          select.addEventListener("change", () => memberCollectionAction(state, [row.item.id], select.value || null));
          node.append(select);
        } else {
          node.append(element("span", "vw-member-readonly vw-access-hint", row.item ?
            (memberPermissions[row.item.readonlyPermission] || "不可修改") : "无直接授权"));
        }
        let branch;
        if (row.primary && (row.children.size || row.duplicate)) {
          branch = element("button", "vw-access-button", "全选分支");
          branch.type = "button";
          branch.addEventListener("click", () => { toggleSelection(state.selected, row.ids); schedule(); });
          node.append(branch);
        }
        if (row.primary && row.inherited.length) {
          const inherited = element("div", "vw-member-inherited vw-access-hint");
          for (const grant of row.inherited) inherited.append(element("span", "",
            `群组 ${grant.viaGroupName}：${memberPermissions[grant.readonlyPermission] || "已有权限"}`));
          node.append(inherited);
        }
        state.views.push({ row, node, check, fold, select, branch });
        nodes.push(node);
      }
      state.tree.replaceChildren(...nodes);
    }
    const busy = memberSelectorBusy(state);
    const setDisabled = (control, disabled) => { if (control.disabled !== disabled) control.disabled = disabled; };
    const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
    const values = new Map(state.component.selectionList.formArray.getRawValue()
      .filter((v) => v.type === 0).map((v) => [v.id, v.permission]));
    const scope = selectionState(state.selected, state.ids);
    setText(state.toggle, scope.all || scope.mixed ? "取消选择" : state.query.trim() ? "全选筛选结果" : "全选集合");
    if (state.toggle.getAttribute("aria-pressed") !== String(scope.all || scope.mixed)) {
      state.toggle.setAttribute("aria-pressed", String(scope.all || scope.mixed));
    }
    setText(state.fold, state.collapsed.size ? "展开全部" : "折叠全部");
    const directCount = items.filter((i) => editableMemberCollection(i) && values.has(i.id)).length;
    setText(state.count, `已选 ${state.selected.size} / ${state.ids.length} · 直接授权 ${directCount} 项`);
    setDisabled(state.search, busy);
    setDisabled(state.toggle, busy || !state.ids.length);
    setDisabled(state.fold, !!state.query.trim() || !state.rows.some((r) => r.children.size));
    setDisabled(state.permission, busy);
    setDisabled(state.apply, busy || !state.selected.size);
    setDisabled(state.remove, busy || !state.selected.size);
    state.empty.hidden = state.rows.length > 0;
    for (const view of state.views) {
      const { row, node, check, fold, select, branch } = view;
      const ancestors = row.path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));
      node.hidden = !state.query.trim() && ancestors.some((path) => state.collapsed.has(path));
      check.checked = !!row.item && state.selected.has(row.item.id);
      setDisabled(check, busy || !row.matched || !row.item || !editableMemberCollection(row.item));
      fold.hidden = !row.primary || !row.children.size;
      setDisabled(fold, !!state.query.trim());
      const expanded = !state.collapsed.has(row.path) || !!state.query.trim();
      setText(fold, expanded ? "−" : "+");
      fold.setAttribute("aria-label", `${expanded ? "折叠" : "展开"}集合 ${row.path}`);
      fold.setAttribute("aria-expanded", String(expanded));
      if (select) {
        select.value = values.get(row.item.id) ?? "";
        setDisabled(select, busy || !row.matched);
      }
      if (branch) {
        const status = selectionState(state.selected, row.ids);
        setText(branch, status.all || status.mixed ? "取消分支" : "全选分支");
        branch.setAttribute("aria-label", `${status.all || status.mixed ? "取消选择分支" : "全选分支"} ${row.path}`);
        setDisabled(branch, busy || !row.ids.length);
      }
    }
  }

  function registerCollectionDialog(component) {
    if (dialogs.has(component)) return;
    const state = { component, selected: new Set(), collections: undefined,
      subjects: [], revocations: new Map() };
    dialogs.set(component, state);
    const { name, parent, selectedOrg } = component.formGroup.controls;
    const validator = () => {
      const fullName = parent.value ? `${parent.value}/${name.value ?? ""}` : name.value;
      const message = collectionPathError({ name: fullName, organizationId: selectedOrg.value },
        state.collections || [], component.collection());
      return message ? { vwCollectionPath: { message } } : null;
    };
    name.addValidators(validator);
    const revalidate = () => name.updateValueAndValidity();
    const pathSubscriptions = [parent, selectedOrg].map((control) =>
      control.valueChanges.subscribe(revalidate));
    const subscription = component.allCollections$.subscribe({
      next: (collections) => { state.collections = collections; revalidate(); schedule(); },
      error: () => { state.error = true; schedule(); },
    });
    const subjectSubscription = component.accessItems$?.subscribe({
      next: (subjects) => { state.subjects = subjects; state.refreshRevocations?.(); },
      error: () => { state.subjects = []; state.refreshRevocations?.(); },
    });
    component.destroyRef.onDestroy(() => {
      subscription.unsubscribe();
      subjectSubscription?.unsubscribe();
      pathSubscriptions.forEach((s) => s.unsubscribe());
      name.removeValidators(validator);
      state.panel?.remove();
      state.note?.remove();
      dialogs.delete(component);
    });
    schedule();
  }

  function renderDialog(state) {
    const component = state.component;
    const original = component.collection();
    if (!component.editMode || component.dialogReadonly || !original) return;
    const host = [...win.document.querySelectorAll("app-collection-dialog")].find((e) =>
      !e.vwDialog || e.vwDialog === component);
    if (!host) return;
    host.vwDialog = component;
    const descendants = (state.collections || []).filter((c) => isDescendant(c, original))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    const nameInput = host.querySelector('input[formcontrolname="name"]');
    if (descendants.length && nameInput && !state.note?.isConnected) {
      state.note = element("p", "vw-rename-note",
        "修改名称或上级集合时，将同步保留全部子集合结构和登录项关联。");
      nameInput.closest("bit-form-field").after(state.note);
    }
    const access = host.querySelector("bit-access-selector");
    if (!access || state.panel?.isConnected) return;
    if (state.collections && !descendants.length) return;
    const panel = element("fieldset", "vw-descendant-access");
    panel.append(element("legend", "", "同时应用到子集合"));
    panel.append(element("p", "vw-access-hint",
      "勾选仅决定本次调整范围，不代表已有授权；取消勾选不会撤销已保存的权限。下方成员表的权限变更仅同步到勾选项，其他授权保持不变。"));
    if (!state.collections) {
      const status = element("p", "", state.error ? "子集合加载失败，请重新打开窗口。" : "正在加载子集合…");
      status.dataset.vwLoad = "true";
      panel.append(status);
      if (state.error) panel.setAttribute("role", "alert");
      access.before(panel);
      state.panel = panel;
      return;
    }
    const organization = component.organization();
    const selectable = descendants.filter((c) => c.canEdit(organization));
    const controls = element("div", "vw-access-controls");
    const count = element("span", "vw-access-count");
    count.setAttribute("aria-live", "polite");
    const checkboxes = new Map();
    const toggles = [];
    function updateCount() {
      state.saveError = undefined;
      count.textContent = `已选 ${state.selected.size} / ${selectable.length}`;
      for (const [id, input] of checkboxes) input.checked = state.selected.has(id);
      for (const toggle of toggles) {
        const status = selectionState(state.selected, toggle.ids);
        const active = status.all || status.mixed;
        toggle.button.textContent = active ? toggle.clear : toggle.select;
        toggle.button.setAttribute("aria-label", active ? toggle.clearLabel : toggle.selectLabel);
        toggle.button.setAttribute("aria-pressed", status.mixed ? "mixed" : String(status.all));
      }
      state.refreshRevocations?.();
    }
    function addToggle(parent, ids, select, clear, selectLabel = select, clearLabel = clear) {
      const button = element("button", "vw-access-button", select);
      button.type = "button";
      button.disabled = ids.length === 0;
      button.addEventListener("click", () => {
        toggleSelection(state.selected, ids);
        updateCount();
      });
      toggles.push({ button, ids, select, clear, selectLabel, clearLabel });
      parent.append(button);
    }
    addToggle(controls, selectable.map((c) => c.id), "全选子集合", "取消选择");
    controls.append(count);
    panel.append(controls);
    const tree = element("div", "vw-access-tree");
    tree.setAttribute("role", "group");
    tree.setAttribute("aria-label", "选择子集合");
    for (const entry of descendantRows(original, descendants)) {
      const { child, relative, depth, path, name } = entry;
      const row = element("div", "vw-access-row");
      row.style.setProperty("--vw-depth", Math.min(depth, 10));
      const label = element("label", "");
      label.title = path;
      const input = element("input");
      input.type = "checkbox";
      input.disabled = !child || !child.canEdit(organization);
      input.checked = !!child && state.selected.has(child.id);
      input.addEventListener("change", () => {
        if (!child) return;
        if (input.checked) state.selected.add(child.id);
        else state.selected.delete(child.id);
        updateCount();
      });
      if (child) checkboxes.set(child.id, input);
      label.append(input, element("span", "", name));
      row.append(label);
      const nested = selectable.filter((c) => c.name.startsWith(path + "/"));
      if (nested.length) {
        const ids = [...(!input.disabled ? [child.id] : []), ...nested.map((c) => c.id)];
        addToggle(row, ids, "全选此分支", "取消此分支",
          `全选分支 ${relative}`, `取消全选分支 ${relative}`);
      }
      if (input.disabled) row.append(element("span", "vw-access-hint", child ? "无管理权限" : "上级结构"));
      tree.append(row);
    }
    panel.append(tree);
    const revokePanel = element("div", "vw-descendant-revoke");
    revokePanel.append(element("h3", "", "仅撤销所选子集合授权"),
      element("p", "vw-access-hint",
        "父集合中已移除的成员或群组，也可在这里一次回收子集合授权。父集合、未勾选分支和其他成员的权限不变；组织级或其他来源的权限仍然有效。"));
    const revokeLabel = element("label", "", "要撤销的成员或群组");
    const revokeSelect = element("select");
    revokeSelect.setAttribute("aria-label", "要撤销的子集合成员或群组");
    revokeLabel.append(revokeSelect);
    const revokeButton = element("button", "vw-access-button", "安排撤销");
    revokeButton.type = "button";
    const revokeControls = element("div", "vw-revoke-controls");
    revokeControls.append(revokeLabel, revokeButton);
    const pending = element("ul", "vw-pending-revocations");
    const revokeStatus = element("p", "vw-access-hint");
    revokeStatus.setAttribute("role", "status");
    revokePanel.append(revokeControls, pending, revokeStatus);
    panel.append(revokePanel);
    state.refreshRevocations = () => {
      const previous = revokeSelect.value;
      const candidates = revocationCandidates(selectable, state.selected, state.subjects);
      const placeholder = element("option", "", candidates.length ? "-- 选择要撤销的授权 --" :
        state.selected.size ? "所选子集合没有直接授权" : "请先勾选子集合");
      placeholder.value = "";
      revokeSelect.replaceChildren(placeholder);
      for (const candidate of candidates) {
        if (state.revocations.has(candidate.key)) continue;
        const option = element("option", "", candidate.label);
        option.value = candidate.key;
        revokeSelect.append(option);
      }
      if ([...revokeSelect.options].some((o) => o.value === previous)) revokeSelect.value = previous;
      revokeSelect.disabled = !!state.saving || !candidates.length;
      revokeButton.disabled = !!state.saving || !revokeSelect.value;
      pending.replaceChildren();
      for (const [key, candidate] of state.revocations) {
        const row = element("li", "");
        const cancel = element("button", "vw-access-button", "取消此次撤销");
        cancel.type = "button";
        cancel.disabled = !!state.saving;
        cancel.setAttribute("aria-label", "取消此次撤销：" + candidate.label);
        cancel.addEventListener("click", () => {
          state.saveError = undefined;
          state.revocations.delete(key);
          state.refreshRevocations();
        });
        row.append(element("span", "", candidate.label), cancel);
        pending.append(row);
      }
      revokeStatus.setAttribute("role", state.saveError ? "alert" : "status");
      revokeStatus.textContent = state.saveError || (state.revocations.size ? state.selected.size ?
        `已安排撤销 ${state.revocations.size} 项授权，将随“保存”仅应用到 ${state.selected.size} 个勾选子集合。` :
        "请勾选要撤销授权的子集合，或取消已安排的撤销操作；当前不会提交。" :
        "此处不自动保存；选择授权并安排撤销后，点击窗口底部的“保存”一次生效。");
    };
    revokeSelect.addEventListener("change", () => { revokeButton.disabled = !revokeSelect.value || !!state.saving; });
    revokeButton.addEventListener("click", () => {
      if (state.saving) return;
      const candidate = revocationCandidates(selectable, state.selected, state.subjects)
        .find((c) => c.key === revokeSelect.value);
      if (!candidate) return;
      state.saveError = undefined;
      state.revocations.set(candidate.key, candidate);
      state.refreshRevocations();
    });
    access.before(panel);
    state.panel = panel;
    updateCount();
  }

  async function saveCollection(component, edited, userId, firstValueFrom) {
    const state = dialogs.get(component);
    const selected = [...state?.selected || []];
    const revocations = [...state?.revocations.values() || []];
    const controls = [...state?.panel?.querySelectorAll("input, button, select") || []];
    const disabled = controls.map((input) => input.disabled);
    if (state) { state.saving = true; state.saveError = undefined; }
    controls.forEach((input) => { input.disabled = true; });
    try {
      const collections = await firstValueFrom(component.allCollections$);
      const updates = planCollectionUpdate(component.collection(), edited, collections,
        selected, component.organization(), {
          users: revocations.filter((r) => r.dimension === "users").map((r) => r.id),
          groups: revocations.filter((r) => r.dimension === "groups").map((r) => r.id),
        });
      const service = component.collectionAdminService;
      const requests = await Promise.all(updates.map(async (update) => {
        const request = await service.encrypt(update.model, userId, true);
        if (!update.usersChanged) delete request.users;
        if (!update.groupsChanged) delete request.groups;
        return { ...request, id: update.model.id };
      }));
      const response = await service.apiService.send("POST",
        `/organizations/${edited.organizationId}/collections/bulk-update`,
        { collections: requests }, true, true);
      for (const collection of response.data) {
        await service.updateLocalCollections(collection, userId);
      }
      const saved = response.data.find((c) => c.id === edited.id);
      // Callers upsert a returned collection again; omit one the user can no longer access.
      return saved?.assigned ? saved : undefined;
    } catch (error) {
      if (state) state.saveError = error.message || "无法保存权限，请检查所选范围后重试。";
      throw error;
    } finally {
      if (state) state.saving = false;
      controls.forEach((input, index) => { input.disabled = disabled[index]; });
      state?.refreshRevocations?.();
    }
  }

  async function createCollection(component, model, userId, firstValueFrom) {
    const collections = await firstValueFrom(component.allCollections$);
    const message = collectionPathError(model, collections);
    if (message) throw new Error(message);
    return component.collectionAdminService.create(model, userId);
  }

  function canAssignItemAccess(row) {
    const organization = row.organizations?.find((org) => String(org.id) === String(row.cipher?.organizationId));
    const login = row.cipher?.type === 1 || Object.prototype.hasOwnProperty.call(row.cipher?.type || {}, "login");
    return !!organization?.isAdmin && !!row.cipher?.organizationId && login &&
      !row.isDeleted && !row.isPartial && !row.disabled;
  }

  function cloneSourceWithoutItemAccess(cipher) {
    const cloned = copy(cipher);
    cloned.collectionIds = (cipher.collectionIds || []).filter((id) => id !== cipher.id);
    return cloned;
  }

  function registerCipherRow(row, firstValueFrom) {
    cipherRows.set(row, { firstValueFrom });
    schedule();
  }

  function unregisterCipherRow(row) {
    const state = cipherRows.get(row);
    state?.button?.remove();
    cipherRows.delete(row);
    if (itemDialog?.row === row && !itemDialog.saving) itemDialog.close();
  }

  function renderCipherRows() {
    for (const [row, state] of cipherRows) {
      if (!canAssignItemAccess(row)) {
        state.button?.remove();
        state.button = undefined;
        continue;
      }
      if (state.button?.isConnected && state.cipherId === row.cipher.id) continue;
      state.button?.remove();
      const title = win.document.getElementById("cipher-btn-" + row.cipher.id);
      const actions = title?.closest("tr")?.querySelector("td:last-child > span");
      if (!actions) continue;
      const button = element("button", "vw-access-button vw-item-access-trigger", "单项权限");
      button.type = "button";
      button.setAttribute("aria-label", `分配单项权限：${row.cipher.name}`);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        openItemAccess(row, state.firstValueFrom);
      });
      actions.prepend(button);
      state.button = button;
      state.cipherId = row.cipher.id;
    }
  }

  function itemPermission(entry) {
    return (entry.readOnly ? "view" : "edit") + (entry.hidePasswords ? "-hidden" : "");
  }

  function itemGrants(selections) {
    return [...selections].map(([id, mode]) => {
      if (!["view", "view-hidden", "edit", "edit-hidden"].includes(mode)) {
        throw new Error("不支持的单项权限级别。");
      }
      return { id, readOnly: mode.startsWith("view"), hidePasswords: mode.endsWith("-hidden"), manage: false };
    });
  }

  async function saveItemAccess(row, selections, userId, firstValueFrom) {
    const service = row.vwCollectionAdminService;
    const cipher = row.cipher;
    const model = { organizationId: cipher.organizationId,
      name: `单项授权/${cipher.name.replaceAll("/", " · ")} [${String(cipher.id).slice(0, 8)}]`,
      users: itemGrants(selections), groups: [] };
    const request = await service.encrypt(model, userId, false);
    const account = await firstValueFrom(row.accountService.activeAccount$);
    if (account?.id !== userId) throw new Error("当前账号已变化，请重新打开单项权限窗口。");
    const response = await service.apiService.send("PUT",
      `/organizations/${cipher.organizationId}/ciphers/${cipher.id}/item-access`,
      { name: request.name, users: request.users }, true, true);
    // The server has committed. Do not let a cache failure look like a rejected permission write.
    try {
      if (response.collection) await service.updateLocalCollections(response.collection, userId);
      const stored = await row.cipherService.get(cipher.id, userId);
      if (stored) {
        const collectionIds = new Set(stored.collectionIds || []);
        if (response.collection) collectionIds.add(response.collection.id);
        else collectionIds.delete(cipher.id);
        stored.collectionIds = [...collectionIds];
        stored.revisionDate = new Date(response.revisionDate);
        await row.cipherService.upsert(stored.toCipherData(), userId);
      }
    } catch (_) {
      return { ...response, needsRefresh: true };
    }
    return response;
  }

  async function openItemAccess(row, firstValueFrom) {
    if (!canAssignItemAccess(row) || itemDialog) return;
    const dialog = element("dialog", "vw-item-access-dialog");
    const form = element("form");
    const heading = element("h2", "", "分配单项权限");
    heading.id = "vw-item-access-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const header = element("header");
    header.append(heading, element("p", "vw-access-hint", row.cipher.name));
    const body = element("div", "vw-item-access-body");
    body.append(element("p", "vw-item-access-notice",
      "仅为此登录项增加成员权限，不改变原集合归属，也不会开放集合中的其他项目。已有组织、集合或群组权限继续有效；移除这里的授权不能降低其他来源的访问权限。"));
    const status = element("p", "vw-item-access-status", "正在加载成员和单项权限…");
    status.setAttribute("role", "status");
    body.append(status);
    const footer = element("footer");
    const save = element("button", "vw-item-save", "保存单项权限");
    save.type = "submit";
    save.disabled = true;
    const cancel = element("button", "vw-item-cancel", "取消");
    cancel.type = "button";
    footer.append(save, cancel);
    form.append(header, body, footer);
    dialog.append(form);
    win.document.body.append(dialog);
    const previousFocus = win.document.activeElement;
    let saving = false;
    const context = { row, get saving() { return saving; }, close() {
      dialog.close();
      dialog.remove();
      if (itemDialog === context) itemDialog = undefined;
      if (previousFocus?.isConnected) previousFocus.focus();
    } };
    itemDialog = context;
    cancel.addEventListener("click", () => { if (!saving) context.close(); });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!saving) context.close(); });
    dialog.showModal();
    const selections = new Map();
    let userId;
    try {
      const account = await firstValueFrom(row.accountService.activeAccount$);
      if (!account) throw new Error("请先登录后再分配权限。");
      userId = account.id;
      const response = await row.vwCollectionAdminService.apiService.send("GET",
        `/organizations/${row.cipher.organizationId}/ciphers/${row.cipher.id}/item-access`, null, true, true);
      if (!dialog.isConnected) return;
      for (const grant of response.users) selections.set(grant.id, itemPermission(grant));
      const searchLabel = element("label", "", "搜索成员");
      const search = element("input", "vw-item-search");
      search.type = "search";
      search.id = "vw-item-member-search";
      searchLabel.htmlFor = search.id;
      const list = element("div", "vw-item-members");
      list.setAttribute("role", "group");
      list.setAttribute("aria-label", "登录项授权成员");
      const memberRows = [];
      const members = response.members.filter((m) => !m.fullAccess && m.type !== 0 && m.type !== 1);
      for (const member of members) {
        const line = element("div", "vw-item-member");
        const label = element("label");
        const check = element("input");
        check.type = "checkbox";
        check.checked = selections.has(member.id);
        check.disabled = member.status !== 2 && !check.checked;
        const identity = member.name ? `${member.name} (${member.email})` : member.email;
        check.setAttribute("aria-label", `授权给 ${identity}`);
        label.append(check, element("span", "", identity + (member.status !== 2 ? "（未确认或已撤销）" : "")));
        const select = element("select");
        select.setAttribute("aria-label", `${identity} 的单项权限`);
        for (const [value, title] of [["view", "查看项目"], ["view-hidden", "查看项目，隐藏密码"],
          ["edit", "编辑项目"], ["edit-hidden", "编辑项目，隐藏密码"]]) {
          const option = element("option", "", title);
          option.value = value;
          select.append(option);
        }
        select.value = selections.get(member.id) || "view";
        select.disabled = !check.checked;
        check.addEventListener("change", () => {
          if (check.checked) selections.set(member.id, select.value);
          else selections.delete(member.id);
          select.disabled = !check.checked;
          status.textContent = `单项授权 ${selections.size} 人。组织管理员的既有权限不受此设置影响。`;
        });
        select.addEventListener("change", () => selections.set(member.id, select.value));
        line.append(label, select);
        list.append(line);
        memberRows.push({ line, identity: identity.toLocaleLowerCase() });
      }
      search.addEventListener("input", () => {
        const query = search.value.trim().toLocaleLowerCase();
        for (const entry of memberRows) entry.line.hidden = !entry.identity.includes(query);
      });
      body.append(searchLabel, search, list);
      if (!members.length) body.append(element("p", "", "组织中没有可单独授权的普通成员，请先邀请并确认成员加入。"));
      status.textContent = `单项授权 ${selections.size} 人。组织管理员的既有权限不受此设置影响。`;
      save.disabled = false;
    } catch (error) {
      if (dialog.isConnected) {
        status.textContent = "加载失败：" + (error.message || "请关闭窗口后重试。");
        status.setAttribute("role", "alert");
      }
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (saving || save.disabled || !userId) return;
      saving = true;
      const controls = [...body.querySelectorAll("input, select")];
      const disabledBeforeSave = controls.map((input) => input.disabled);
      controls.forEach((input) => { input.disabled = true; });
      save.disabled = cancel.disabled = true;
      status.textContent = "正在保存单项权限…";
      try {
        const response = await saveItemAccess(row, selections, userId, firstValueFrom);
        if (!dialog.isConnected) return;
        saving = false;
        cancel.disabled = false;
        cancel.textContent = "完成";
        status.textContent = response.needsRefresh ? "权限已保存，请刷新页面同步本机缓存。" : "单项权限已保存。";
        cancel.focus();
      } catch (error) {
        if (!dialog.isConnected) return;
        saving = false;
        controls.forEach((input, index) => { input.disabled = disabledBeforeSave[index]; });
        save.disabled = cancel.disabled = false;
        status.textContent = "保存失败：" + (error.message || "请稍后重试。");
        status.setAttribute("role", "alert");
      }
    });
  }

  function schedule() {
    if (!win || scheduled) return;
    scheduled = true;
    win.requestAnimationFrame(() => {
      scheduled = false;
      updateLayout();
      renderCipherRows();
      for (const state of memberSelectors.values()) renderMemberCollectionSelector(state);
      for (const state of dialogs.values()) {
        if (state.panel && !state.collections && !state.error) continue;
        if (state.panel && state.error && !state.collections) {
          const status = state.panel.querySelector("[data-vw-load]");
          const message = "子集合加载失败，请重新打开窗口。";
          if (status && status.textContent !== message) {
            status.textContent = message;
            state.panel.setAttribute("role", "alert");
          }
        }
        if (state.panel && state.collections && !state.panel.querySelector(".vw-access-tree")) {
          state.panel.remove();
          state.panel = undefined;
        }
        renderDialog(state);
      }
    });
  }

  function start(windowObject) {
    win = windowObject;
    new win.MutationObserver(schedule).observe(win.document.documentElement, { childList: true, subtree: true });
    win.document.addEventListener("click", (event) => {
      const target = event.target instanceof win.Element ? event.target : event.target?.parentElement;
      if (!target?.closest('app-vault-filter .filter-button, .vw-results-pane tr[appvaultcollectionrow] button[bitlink]')) return;
      // Let RouterLink handle this click before a form update can recreate its row.
      win.setTimeout(() => {
        const input = win.document.querySelector('app-vault-filter input[type="search"]');
        if (!input?.value) return;
        input.value = "";
        input.dispatchEvent(new win.Event("input", { bubbles: true }));
      }, 0);
    }, true);
    win.addEventListener("hashchange", schedule);
    win.addEventListener("resize", schedule);
    schedule();
  }

  return { start, registerScrollHost, unregisterScrollHost, registerCollectionDialog,
    saveCollection, createCollection, collectionPathError, nestedCollectionTraverse,
    planCollectionUpdate, accessDelta, applyDelta, isDescendant, navigationKey,
    searchMatchesInput, collectionSearchFilter, searchVaultCiphers,
    descendantRows, selectionState, toggleSelection, revocationCandidates,
    cloneSourceWithoutItemAccess, itemGrants, saveItemAccess,
    memberCollectionRows, planMemberCollectionAccess, applyMemberCollectionAccess,
    registerMemberCollectionSelector, unregisterMemberCollectionSelector,
    registerCipherRow, unregisterCipherRow, canAssignItemAccess };
});
