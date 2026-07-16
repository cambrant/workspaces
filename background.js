// Constants

const STORAGE_KEY = "collections";
const DEFAULT_WS_KEY = "defaultWorkspace";
const DEFAULT_CONTAINER = "firefox-default";
const NEW_TAB_URL = "about:newtab";
const HEX_COLOR_RE = /^#([A-Fa-f0-9]{3}){1,2}$/;
const DEFAULT_COLOR = "#808080";
const KEEP_ALIVE_KEY = "keepAliveCount";
const DEFAULT_KEEP_ALIVE = 10;
const PENDING_SWITCH_KEY = "_pendingSwitch";

// Utility functions

function generateId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 9);
  return `ws-${ts}-${rand}`;
}

function isValidHexColor(color) {
  if (color === "currentColor") return true;
  return HEX_COLOR_RE.test(color);
}

function sanitizeColor(color) {
  return isValidHexColor(color) ? color : DEFAULT_COLOR;
}

function sanitizeUrl(url) {
  if (!url || !url.trim()) return NEW_TAB_URL;
  if (url.startsWith("http") || url.startsWith("file") || url.startsWith("about")) return url;
  return NEW_TAB_URL;
}

function isNewTabUrl(url) {
  return url === "about:newtab" || url === "about:home";
}

// Storage layer

const Storage = {
  async readAll() {
    try {
      const data = await browser.storage.local.get(STORAGE_KEY);
      return data[STORAGE_KEY] || [];
    } catch (e) {
      console.error("Storage.readAll failed:", e);
      return [];
    }
  },

  async upsert(collection) {
    const all = await this.readAll();
    const idx = all.findIndex(c => c.id === collection.id);
    if (idx >= 0) {
      all[idx] = collection;
    } else {
      all.push(collection);
    }
    await browser.storage.local.set({ [STORAGE_KEY]: all });
  },

  async delete(id) {
    const all = await this.readAll();
    const filtered = all.filter(c => c.id !== id);
    await browser.storage.local.set({ [STORAGE_KEY]: filtered });
  },

  async bulkOverwrite(collections) {
    await browser.storage.local.set({ [STORAGE_KEY]: collections });
  },

  // Switch-intent journal. switchInWindow writes an entry (keyed by windowId)
  // before it mutates any tabs and clears it on clean completion. A mid-switch
  // teardown (crash, disable, upgrade) skips the clear, so the entry survives
  // for hydrate() to reconcile. Kept in storage.local — not session — so it
  // outlives a disable/enable cycle that wipes session storage.
  async _getPendingSwitches() {
    try {
      const data = await browser.storage.local.get(PENDING_SWITCH_KEY);
      return data[PENDING_SWITCH_KEY] || {};
    } catch (e) {
      return {};
    }
  },

  async _setPendingSwitch(windowId, from, to) {
    const cur = await this._getPendingSwitches();
    cur[windowId] = { from: from || null, to };
    await browser.storage.local.set({ [PENDING_SWITCH_KEY]: cur });
  },

  async _clearPendingSwitch(windowId) {
    const cur = await this._getPendingSwitches();
    if (windowId in cur) {
      delete cur[windowId];
      await browser.storage.local.set({ [PENDING_SWITCH_KEY]: cur });
    }
  }
};

// Event bus

const EventBus = {
  _listeners: {},

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  },

  emit(event, payload) {
    const listeners = this._listeners[event] || [];
    for (const fn of listeners) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`EventBus error [${event}]:`, e);
      }
    }
  }
};

// Runtime state

const State = {
  windowMap: new Map(),
  lockSet: new Set(),
  tabOwnership: new Map(),
  activeTabMap: new Map(),
  previousWorkspaceMap: new Map(),
  tabRecency: new Map(),
  _recencyTick: 0,

  _persistTimer: null,

  // Trailing-edge debounce: callers hit this on every tab activation and
  // create/remove, and session storage only needs eventual consistency for
  // wake restore.
  _persist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      browser.storage.session.set({
        _state: {
          windowMap: Object.fromEntries(this.windowMap),
          tabOwnership: Object.fromEntries(this.tabOwnership),
          activeTabMap: Object.fromEntries(this.activeTabMap),
          previousWorkspaceMap: Object.fromEntries(this.previousWorkspaceMap),
          tabRecency: Object.fromEntries(this.tabRecency),
          recencyTick: this._recencyTick
        }
      }).catch(() => {});
    }, 250);
  },

  async _loadFromSession() {
    try {
      const { _state } = await browser.storage.session.get("_state");
      if (!_state) return false;
      if (_state.windowMap)
        this.windowMap = new Map(Object.entries(_state.windowMap).map(([k, v]) => [Number(k), v]));
      if (_state.tabOwnership)
        this.tabOwnership = new Map(Object.entries(_state.tabOwnership).map(([k, v]) => [Number(k), v]));
      if (_state.activeTabMap)
        this.activeTabMap = new Map(Object.entries(_state.activeTabMap));
      if (_state.previousWorkspaceMap)
        this.previousWorkspaceMap = new Map(Object.entries(_state.previousWorkspaceMap).map(([k, v]) => [Number(k), v]));
      if (_state.tabRecency)
        this.tabRecency = new Map(Object.entries(_state.tabRecency).map(([k, v]) => [Number(k), v]));
      this._recencyTick = Number(_state.recencyTick) || 0;
      return true;
    } catch (e) {
      return false;
    }
  },

  link(windowId, collectionId) {
    this.windowMap.set(windowId, collectionId);
    this._persist();
  },

  unlink(windowId) {
    this.windowMap.delete(windowId);
    this._persist();
  },

  lookup(windowId) {
    return this.windowMap.get(windowId) || null;
  },

  getWindowForCollection(collectionId) {
    for (const [wid, cid] of this.windowMap) {
      if (cid === collectionId) return wid;
    }
    return null;
  },

  reset() {
    this.windowMap.clear();
    this.tabOwnership.clear();
    this.activeTabMap.clear();
    this.previousWorkspaceMap.clear();
    this.tabRecency.clear();
    this._recencyTick = 0;
  },

  // Bump a tab to the front of the recency order. Called on activation.
  touchTab(tabId) {
    this._recencyTick += 1;
    this.tabRecency.set(tabId, this._recencyTick);
    this._persist();
  },

  getRecency(tabId) {
    return this.tabRecency.get(tabId) || 0;
  },

  acquireLock(windowId) {
    this.lockSet.add(windowId);
  },

  releaseLock(windowId) {
    this.lockSet.delete(windowId);
  },

  isLocked(windowId) {
    return this.lockSet.has(windowId);
  },

  assignTab(tabId, workspaceId) {
    this.tabOwnership.set(tabId, workspaceId);
    this._persist();
  },

  unassignTab(tabId) {
    this.tabOwnership.delete(tabId);
    this.tabRecency.delete(tabId);
    this._persist();
  },

  getTabsForWorkspace(workspaceId) {
    const result = [];
    for (const [tid, wid] of this.tabOwnership) {
      if (wid === workspaceId) result.push(tid);
    }
    return result;
  },

  setActiveTab(workspaceId, tabId) {
    this.activeTabMap.set(workspaceId, tabId);
    this._persist();
  },

  getActiveTab(workspaceId) {
    return this.activeTabMap.get(workspaceId) || null;
  },

  clearActiveTab(workspaceId) {
    this.activeTabMap.delete(workspaceId);
    this._persist();
  },

  setPreviousWorkspace(windowId, workspaceId) {
    this.previousWorkspaceMap.set(windowId, workspaceId);
    this._persist();
  },

  getPreviousWorkspace(windowId) {
    return this.previousWorkspaceMap.get(windowId) || null;
  }
};

// Toolbar indicator

const Indicator = {
  TEMPLATE: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 0 36 32">
    <rect x="0" y="3" width="32" height="26" rx="3" fill="none" stroke="{{COLOR}}" stroke-width="2.5"/>
    <rect x="0" y="3" width="11" height="6" rx="1.5" fill="{{COLOR}}"/>
    <text x="16" y="24" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="bold" font-size="22" fill="{{COLOR}}">{{LETTER}}</text>
  </svg>`,

  async update(windowId, collection) {
    const color = sanitizeColor(collection.color);
    const letter = (collection.name || "").charAt(0).toUpperCase();
    const svg = this.TEMPLATE.replace(/\{\{COLOR\}\}/g, color).replace("{{LETTER}}", letter);
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    try {
      await browser.action.setIcon({ path: url, windowId });
      await browser.action.setTitle({ title: `Workspaces — ${collection.name}`, windowId });
      await browser.action.setBadgeText({ text: "", windowId });
    } catch (e) {
      console.warn("Indicator.update failed:", e);
    }
  },

  async clear(windowId) {
    const svg = this.TEMPLATE.replace(/\{\{COLOR\}\}/g, DEFAULT_COLOR);
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    try {
      await browser.action.setIcon({ path: url, windowId });
      await browser.action.setTitle({ title: "Workspaces", windowId });
      await browser.action.setBadgeText({ text: "", windowId });
    } catch (e) {
      // Window may be gone
    }
  },

  init() {
    EventBus.on("collectionOpened", ({ windowId, collection }) => {
      this.update(windowId, collection);
    });

    EventBus.on("windowLinked", ({ windowId, collectionId }) => {
      Storage.readAll().then(all => {
        const col = all.find(c => c.id === collectionId);
        if (col) this.update(windowId, col);
      });
    });

    EventBus.on("metadataChanged", ({ collection }) => {
      const windowId = State.getWindowForCollection(collection.id);
      if (windowId !== null) this.update(windowId, collection);
    });
  }
};

// Context menus

function colorDotIcon(hex) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="${sanitizeColor(hex)}"/></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

const Menus = {
  async rebuild() {
    await browser.menus.removeAll();

    const collections = await Storage.readAll();

    browser.menus.create({
      id: "move-tab-root",
      title: "Move tab to workspace",
      contexts: ["tab"]
    });

    for (const col of collections) {
      browser.menus.create({
        id: `move-tab-${col.id}`,
        parentId: "move-tab-root",
        title: col.name,
        icons: { "16": colorDotIcon(col.color) },
        contexts: ["tab"]
      });
    }
  },

  init() {
    browser.menus.onClicked.addListener(async (info, tab) => {
      if (!info.menuItemId.startsWith("move-tab-") || info.menuItemId === "move-tab-root") return;
      await hydrated;

      const collectionId = info.menuItemId.replace("move-tab-", "");
      const targetWindowId = State.getWindowForCollection(collectionId);

      // Collect all highlighted tabs if the right-clicked tab is among them;
      // otherwise move only the right-clicked tab.
      let tabs;
      try {
        const highlighted = await browser.tabs.query({ windowId: tab.windowId, highlighted: true });
        if (highlighted.some(t => t.id === tab.id)) {
          tabs = highlighted;
        } else {
          tabs = [tab];
        }
      } catch (e) {
        tabs = [tab];
      }

      const tabIds = tabs.map(t => t.id);

      if (targetWindowId !== null) {
        // Target workspace is open in a window. Lock both windows to suppress
        // per-tab captureWindow calls during the bulk move.
        State.acquireLock(tab.windowId);
        State.acquireLock(targetWindowId);
        try {
          await browser.tabs.move(tabIds, { windowId: targetWindowId, index: -1 });
          for (const id of tabIds) {
            State.assignTab(id, collectionId);
          }
          await browser.tabs.update(tabIds[0], { active: true });
        } catch (e) {
          console.error("Failed to move tabs:", e);
        } finally {
          State.releaseLock(tab.windowId);
          State.releaseLock(targetWindowId);
          Capture.captureWindow(tab.windowId);
          Capture.captureWindow(targetWindowId);
        }
      } else {
        // Check if target workspace has hidden tabs (inactive but present in window)
        const hiddenTabIds = State.getTabsForWorkspace(collectionId);
        if (hiddenTabIds.length > 0) {
          // Target workspace is inactive with hidden tabs. Hide moved tabs and reassign ownership.
          State.acquireLock(tab.windowId);
          try {
            // If the active tab is among those being moved, activate the
            // nearest preceding tab that isn't being moved. Firefox refuses
            // to hide the active tab.
            const movingSet = new Set(tabIds);
            const activeTab = tabs.find(t => t.active);
            if (activeTab) {
              const allTabs = await browser.tabs.query({ windowId: tab.windowId, hidden: false });
              const activeIdx = allTabs.findIndex(t => t.id === activeTab.id);
              let replacement = null;
              for (let i = activeIdx - 1; i >= 0; i--) {
                if (!movingSet.has(allTabs[i].id)) { replacement = allTabs[i]; break; }
              }
              if (!replacement) {
                for (let i = activeIdx + 1; i < allTabs.length; i++) {
                  if (!movingSet.has(allTabs[i].id)) { replacement = allTabs[i]; break; }
                }
              }
              if (replacement) {
                await browser.tabs.update(replacement.id, { active: true });
              }
            }
            for (const id of tabIds) {
              State.assignTab(id, collectionId);
            }
            await Restore.ungroupTabs(tabIds);
            await browser.tabs.hide(tabIds);
            // Move hidden tabs to end so they appear last when target workspace is shown
            await browser.tabs.move(tabIds, { index: -1 });
          } catch (e) {
            console.error("Failed to hide tabs:", e);
          } finally {
            State.releaseLock(tab.windowId);
            Capture.captureWindow(tab.windowId);
          }
        } else {
          // Target workspace is fully closed. Save tab data to its storage
          const collections = await Storage.readAll();
          const col = collections.find(c => c.id === collectionId);
          if (!col) return;
          col.tabs = col.tabs || [];
          for (const t of tabs) {
            col.tabs.push({
              url: t.url || "",
              title: t.title || "",
              pinned: !!t.pinned,
              focused: false,
              cookieStoreId: t.cookieStoreId || DEFAULT_CONTAINER
            });
          }
          await browser.storage.local.set({ [STORAGE_KEY]: collections });
          try {
            await browser.tabs.remove(tabs.map(t => t.id));
          } catch (e) {
            console.error("Failed to remove tabs after move:", e);
          }
        }
      }
    });
  }
};

// Tab capture

const Capture = {
  _timers: new Map(),
  DEBOUNCE_MS: 500,

  // Trailing-edge debounce per window: tab events arrive in bursts and
  // captureWindow does a full read-modify-write of all collections.
  schedule(windowId) {
    if (!windowId) return;
    const existing = this._timers.get(windowId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this._timers.delete(windowId);
      this.captureWindow(windowId).catch(() => {});
    }, this.DEBOUNCE_MS);
    this._timers.set(windowId, t);
  },

  async captureWindow(windowId) {
    if (State.isLocked(windowId)) return;

    const collectionId = State.lookup(windowId);
    if (!collectionId) return;

    try {
      await browser.windows.get(windowId);
    } catch (e) {
      return;
    }

    const tabs = await browser.tabs.query({ windowId, hidden: false });

    let groups = [];
    if (typeof browser.tabGroups !== "undefined") {
      try {
        groups = await browser.tabGroups.query({ windowId });
      } catch (e) {
        // Tab groups API unavailable or failed
      }
    }

    const tabList = tabs.map(tab => ({
      url: tab.url || "",
      title: tab.title || "",
      pinned: !!tab.pinned,
      focused: !!tab.active,
      cookieStoreId: tab.cookieStoreId || DEFAULT_CONTAINER
    }));

    const groupList = [];
    for (const group of groups) {
      const memberIndices = [];
      tabs.forEach((tab, idx) => {
        if (tab.groupId === group.id) memberIndices.push(idx);
      });
      if (memberIndices.length > 0) {
        groupList.push({
          title: group.title || "",
          color: group.color || "grey",
          collapsed: !!group.collapsed,
          tabIndices: memberIndices
        });
      }
    }

    const all = await Storage.readAll();
    const col = all.find(c => c.id === collectionId);
    if (!col) return;

    col.tabs = tabList;
    col.groups = groupList;
    col.windowId = windowId;

    await browser.storage.local.set({ [STORAGE_KEY]: all });
  },

  init() {
    browser.tabs.onCreated.addListener(tab => {
      if (tab.windowId) {
        const wsId = State.lookup(tab.windowId);
        if (wsId && !State.isLocked(tab.windowId)) {
          State.assignTab(tab.id, wsId);
        }
        this.schedule(tab.windowId);
      }
    });

    // Only these properties change what captureWindow stores; ignoring the
    // rest keeps favicon/status/discard churn from hammering storage.
    browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      if (!("url" in changeInfo) && !("title" in changeInfo) &&
          !("pinned" in changeInfo) && !("groupId" in changeInfo)) return;
      if (tab && tab.windowId) this.schedule(tab.windowId);
    });

    browser.tabs.onMoved.addListener((_tabId, moveInfo) => {
      if (moveInfo.windowId) this.schedule(moveInfo.windowId);
    });

    // A locked window means an extension-driven move (workspace switch,
    // context-menu move, adoption) that assigns ownership itself; the
    // automatic reassign here would clobber it.
    browser.tabs.onAttached.addListener((_tabId, attachInfo) => {
      if (!attachInfo.newWindowId) return;
      if (!State.isLocked(attachInfo.newWindowId)) {
        const wsId = State.lookup(attachInfo.newWindowId);
        if (wsId) State.assignTab(_tabId, wsId);
      }
      this.schedule(attachInfo.newWindowId);
    });

    browser.tabs.onDetached.addListener((_tabId, detachInfo) => {
      if (detachInfo.oldWindowId && State.isLocked(detachInfo.oldWindowId)) return;
      State.unassignTab(_tabId);
      if (detachInfo.oldWindowId) this.schedule(detachInfo.oldWindowId);
    });

    browser.tabs.onActivated.addListener(activeInfo => {
      if (activeInfo.tabId) State.touchTab(activeInfo.tabId);
      if (activeInfo.windowId) {
        const wsId = State.lookup(activeInfo.windowId);
        if (wsId) Discarder.schedule(wsId);
        this.schedule(activeInfo.windowId);
      }
    });

    browser.tabs.onRemoved.addListener((_tabId, removeInfo) => {
      State.unassignTab(_tabId);
      if (removeInfo.isWindowClosing) return;
      if (removeInfo.windowId) this.schedule(removeInfo.windowId);
    });

    if (typeof browser.tabGroups !== "undefined" && browser.tabGroups.onUpdated) {
      browser.tabGroups.onUpdated.addListener(group => {
        if (group.windowId) this.schedule(group.windowId);
      });
    }
  }
};

// Selective tab discarding
//
// Each workspace keeps its N most-recently-active tabs loaded (warm) and
// discards the rest to free memory. N defaults to DEFAULT_KEEP_ALIVE and is
// overridable via the KEEP_ALIVE_KEY storage setting. Discarding preserves the
// tab id, so State.tabOwnership stays valid; showing a discarded tab reloads it
// from its URL. This does not prevent Firefox's own memory-pressure unloading;
// it only trims proactively so idle workspaces don't sit fully resident.

const Discarder = {
  _timers: new Map(),

  async getKeepAlive() {
    try {
      const { [KEEP_ALIVE_KEY]: n } = await browser.storage.local.get(KEEP_ALIVE_KEY);
      const parsed = Number(n);
      if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    } catch (e) {
      // fall through to default
    }
    return DEFAULT_KEEP_ALIVE;
  },

  // Discard a workspace's hidden tabs beyond the N most-recently-active warm
  // ones. Only hidden tabs are eligible: visible tabs are the user's business
  // (and Firefox's own unloader). The budget counts warm (non-discarded) tabs
  // only, so N tabs really stay loaded. Pinned tabs and tabs playing audio
  // are never discarded, but warm ones still occupy budget slots since they
  // hold memory either way.
  async enforce(workspaceId) {
    if (!workspaceId) return;
    const keep = await this.getKeepAlive();
    const ownedIds = new Set(State.getTabsForWorkspace(workspaceId));
    if (ownedIds.size === 0) return;

    let hidden;
    try {
      hidden = await browser.tabs.query({ hidden: true });
    } catch (e) {
      return;
    }

    const warm = hidden.filter(t => ownedIds.has(t.id) && !t.discarded);
    if (warm.length <= keep) return;

    const ranked = warm
      .map(t => ({ t, r: State.getRecency(t.id) }))
      .sort((a, b) => b.r - a.r);

    for (const { t } of ranked.slice(keep)) {
      if (t.pinned || t.audible) continue;
      try {
        await browser.tabs.discard(t.id);
      } catch (e) {
        // discard may be refused (e.g. about: pages); ignore
      }
    }
  },

  // Debounced enforce to avoid thrashing on rapid tab flipping.
  schedule(workspaceId) {
    if (!workspaceId) return;
    const existing = this._timers.get(workspaceId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this._timers.delete(workspaceId);
      this.enforce(workspaceId).catch(() => {});
    }, 2000);
    this._timers.set(workspaceId, t);
  }
};

// Hidden-tab janitor
//
// Hidden tabs are invisible in the UI, so anything stranded there leaks
// silently. Every keepalive tick: remove hidden tabs no workspace owns and
// re-trim every workspace with owned tabs to its warm budget. Skipped while
// any window is mid-operation or hydration is running, since both create
// transient hidden/unowned states.

const Janitor = {
  _running: false,

  async sweep() {
    if (this._running) return;
    if (_hydrating) return;
    if (State.lockSet.size > 0) return;
    this._running = true;
    try {
      const hidden = await browser.tabs.query({ hidden: true });

      const unowned = hidden
        .filter(t => !State.tabOwnership.has(t.id))
        .map(t => t.id);
      if (unowned.length > 0) {
        try { await browser.tabs.remove(unowned); } catch (e) { /* gone */ }
      }

      const wsIds = new Set(State.tabOwnership.values());
      for (const wsId of wsIds) {
        await Discarder.enforce(wsId);
      }
    } finally {
      this._running = false;
    }
  }
};

// Restoration engine

const Restore = {
  async switchInWindow(windowId, collection) {
    const currentWsId = State.lookup(windowId);
    if (currentWsId === collection.id) return;

    // If the workspace is already open in another live window, focus that
    // window instead of opening a second copy. Two windows mapped to one
    // workspace corrupts captures and strands the loser's tabs hidden and
    // loaded forever.
    const linkedWindowId = State.getWindowForCollection(collection.id);
    if (linkedWindowId !== null && linkedWindowId !== windowId) {
      try {
        await browser.windows.update(linkedWindowId, { focused: true });
        return;
      } catch (e) {
        State.unlink(linkedWindowId); // stale reference; window is gone
      }
    }

    // Track the outgoing workspace as the previous one for this window
    if (currentWsId) {
      State.setPreviousWorkspace(windowId, currentWsId);
    }

    // Save current workspace state before locking
    if (currentWsId) {
      await Capture.captureWindow(windowId);
      const activeTabs = await browser.tabs.query({ windowId, active: true });
      if (activeTabs.length > 0) {
        State.setActiveTab(currentWsId, activeTabs[0].id);
      }
    }

    // Snapshot current visible tabs before modifications
    const prevVisible = await browser.tabs.query({ windowId, hidden: false });
    const prevVisibleIds = prevVisible.map(t => t.id);

    // Journal the switch intent durably before touching any tabs. If the page
    // is torn down mid-switch (crash, disable, upgrade) the finally block never
    // runs, so this marker survives and hydrate() uses it to disambiguate which
    // workspace the window actually ended up showing — otherwise the ownership
    // rebuild would attribute the new workspace's visible tabs to the old
    // collection and captureWindow would duplicate them across both.
    await Storage._setPendingSwitch(windowId, currentWsId, collection.id);

    State.acquireLock(windowId);
    ContainerEnforcer.setSwitching(true);
    let freshlyCreated = false;

    try {
      // Phase 1: Show or create target workspace's tabs
      const targetTabIds = await this._adoptWorkspaceTabs(windowId, collection.id);

      if (targetTabIds.length > 0) {
        // Target has hidden tabs. Show them
        await browser.tabs.show(targetTabIds);
        if (typeof browser.tabGroups !== "undefined" && browser.tabs.group &&
            collection.groups && collection.groups.length > 0) {
          await this._restoreGroups(windowId, collection.groups, targetTabIds);
        }
        const activeTabId = State.getActiveTab(collection.id);
        if (activeTabId && targetTabIds.includes(activeTabId)) {
          await browser.tabs.update(activeTabId, { active: true });
        } else {
          await browser.tabs.update(targetTabIds[0], { active: true });
        }
      } else {
        // Create from storage
        freshlyCreated = true;
        const createdTabIds = [];
        const tabList = collection.tabs || [];

        for (let i = 0; i < tabList.length; i++) {
          const tabId = await this._createTab(windowId, tabList[i], i);
          if (tabId) {
            State.assignTab(tabId, collection.id);
            createdTabIds.push(tabId);
          }
        }

        if (createdTabIds.length === 0) {
          const tab = await browser.tabs.create({ windowId, active: true });
          State.assignTab(tab.id, collection.id);
        }

        if (typeof browser.tabGroups !== "undefined" && browser.tabs.group &&
            collection.groups && collection.groups.length > 0) {
          await this._restoreGroups(windowId, collection.groups, createdTabIds);
        }
      }

      // Phase 2: Hide or remove previous visible tabs
      if (currentWsId && prevVisibleIds.length > 0) {
        await this.ungroupTabs(prevVisibleIds);
        await browser.tabs.hide(prevVisibleIds);
      } else if (!currentWsId && prevVisibleIds.length > 0) {
        await browser.tabs.remove(prevVisibleIds);
      }

      // Phase 3: Update state
      if (currentWsId) {
        const prev = await Storage.readAll();
        const currentCol = prev.find(c => c.id === currentWsId);
        if (currentCol) {
          currentCol.windowId = null;
          await browser.storage.local.set({ [STORAGE_KEY]: prev });
        }
      }

      State.link(windowId, collection.id);

      const all = await Storage.readAll();
      const col = all.find(c => c.id === collection.id);
      if (col) {
        col.windowId = windowId;
        await browser.storage.local.set({ [STORAGE_KEY]: all });
      }

      EventBus.emit("collectionOpened", { windowId, collection });

    } finally {
      if (freshlyCreated) {
        await new Promise(r => setTimeout(r, 1000));
      }
      ContainerEnforcer.setSwitching(false);
      State.releaseLock(windowId);
      // Switch completed cleanly; drop the recovery marker before capturing.
      await Storage._clearPendingSwitch(windowId);
      await Capture.captureWindow(windowId);
      // Trim the workspace we just left down to its warm set.
      if (currentWsId) Discarder.enforce(currentWsId).catch(() => {});
    }
  },

  async ungroupTabs(tabIds) {
    if (!tabIds.length || typeof browser.tabs.ungroup !== "function") return;
    try {
      await browser.tabs.ungroup(tabIds);
    } catch (e) {
      console.error("Ungrouping tabs failed:", e);
    }
  },

  // Collect the workspace's hidden tabs wherever they live. Tabs stranded in
  // other windows (from a past duplicate-open or crash) are moved into this
  // window, so switching adopts an existing set instead of recreating it from
  // storage — recreation leaks the old set as hidden, loaded orphans.
  async _adoptWorkspaceTabs(windowId, workspaceId) {
    const allHidden = await browser.tabs.query({ hidden: true });
    const owned = allHidden.filter(t => State.tabOwnership.get(t.id) === workspaceId);
    const tabIds = owned.filter(t => t.windowId === windowId).map(t => t.id);
    const foreign = owned.filter(t => t.windowId !== windowId);
    if (foreign.length === 0) return tabIds;

    const foreignWindows = new Set(foreign.map(t => t.windowId));
    for (const wid of foreignWindows) State.acquireLock(wid);
    try {
      const ids = foreign.map(t => t.id);
      await browser.tabs.move(ids, { windowId, index: -1 });
      for (const id of ids) State.assignTab(id, workspaceId);
      tabIds.push(...ids);
    } catch (e) {
      console.error("Adopting workspace tabs failed:", e);
    } finally {
      for (const wid of foreignWindows) State.releaseLock(wid);
    }
    return tabIds;
  },

  async _createTab(windowId, tabData, index) {
    let url = sanitizeUrl(tabData.url);
    const isPinned = !!tabData.pinned;
    const isFocused = !!tabData.focused;
    const cookieStoreId = tabData.cookieStoreId || DEFAULT_CONTAINER;
    const shouldDiscard = !isFocused && !isPinned;

    const props = {
      windowId,
      index,
      active: isFocused,
      pinned: isPinned
    };

    if (isNewTabUrl(url)) {
      // Omit url, let browser open its default page
    } else {
      props.url = url;
    }

    // Restore non-focused, non-pinned tabs unloaded so a freshly-opened
    // workspace only loads its active tab. Firefox rejects `discarded` without
    // a URL, so skip newtab pages (props.url is unset for those).
    if (shouldDiscard && props.url) {
      props.discarded = true;
      props.title = tabData.title || "";
    }

    if (cookieStoreId !== DEFAULT_CONTAINER) {
      props.cookieStoreId = cookieStoreId;
    }

    try {
      const tab = await browser.tabs.create(props);
      return tab.id;
    } catch (e) {
      // Retry without container if that was the problem
      if (cookieStoreId !== DEFAULT_CONTAINER) {
        console.warn("Tab creation with container failed, retrying without:", e);
        delete props.cookieStoreId;
        try {
          const tab = await browser.tabs.create(props);
          return tab.id;
        } catch (e2) {
          console.error("Tab creation retry failed:", e2);
          return null;
        }
      }
      console.error("Tab creation failed:", e);
      return null;
    }
  },

  async _restoreGroups(windowId, groups, createdTabIds) {
    for (const groupDef of groups) {
      const tabIds = groupDef.tabIndices
        .map(idx => createdTabIds[idx])
        .filter(id => id != null);

      if (tabIds.length === 0) continue;

      try {
        const groupId = await browser.tabs.group({
          tabIds,
          createProperties: { windowId }
        });
        await browser.tabGroups.update(groupId, {
          title: groupDef.title || "",
          color: groupDef.color || "grey",
          collapsed: !!groupDef.collapsed
        });
      } catch (e) {
        console.error("Group restoration failed:", e);
      }
    }
  }
};

// Window close handler

browser.windows.onRemoved.addListener(async windowId => {
  await hydrated;
  const collectionId = State.lookup(windowId);
  if (!collectionId) return;

  const all = await Storage.readAll();
  const col = all.find(c => c.id === collectionId);
  if (col) {
    col.windowId = null;
    await browser.storage.local.set({ [STORAGE_KEY]: all });
  }

  State.unlink(windowId);
});

// Reconnect workspace after browser restart

browser.windows.onCreated.addListener(async (win) => {
  await hydrated;
  // Let session restore populate the window with tabs
  await new Promise(r => setTimeout(r, 1000));

  // Skip if already managed (by hydrate or extension-initiated open)
  if (State.lookup(win.id)) return;

  const collections = await Storage.readAll();

  // Try URL matching against saved workspaces
  const visibleTabs = await browser.tabs.query({ windowId: win.id, hidden: false });
  const windowUrls = new Set(visibleTabs.map(t => t.url).filter(u => u && !isNewTabUrl(u)));

  if (windowUrls.size > 0) {
    let bestCol = null;
    let bestScore = 0;

    for (const col of collections) {
      if (State.getWindowForCollection(col.id) !== null) continue;
      const savedUrls = (col.tabs || []).map(t => t.url).filter(u => u && !isNewTabUrl(u));
      if (savedUrls.length === 0) continue;

      const matches = savedUrls.filter(url => windowUrls.has(url)).length;
      const score = matches / savedUrls.length;

      if (score > bestScore) {
        bestScore = score;
        bestCol = col;
      }
    }

    // Re-check and commit the link with no await in between: onCreated fires
    // for every window restored at once, so two handlers can reach here with
    // the same bestCol. A synchronous guard + State.link is atomic against the
    // other handlers, preventing two windows mapping to one workspace (which
    // corrupts captures) or the same collection being claimed twice.
    if (bestCol && bestScore >= 0.5 &&
        State.lookup(win.id) === null &&
        State.getWindowForCollection(bestCol.id) === null) {
      State.link(win.id, bestCol.id);
      const all = await Storage.readAll();
      const col = all.find(c => c.id === bestCol.id);
      if (col) {
        col.windowId = win.id;
        await browser.storage.local.set({ [STORAGE_KEY]: all });
      }
      for (const tab of visibleTabs) {
        State.assignTab(tab.id, bestCol.id);
      }
      EventBus.emit("windowLinked", { windowId: win.id, collectionId: bestCol.id });
      return;
    }
  }

  // No URL match: open default workspace if this looks like a browser restart
  // (no other windows are managed, so this isn't a Cmd+N new window)
  if (State.windowMap.size > 0) return;

  const { [DEFAULT_WS_KEY]: defaultWsId } = await browser.storage.local.get(DEFAULT_WS_KEY);
  if (!defaultWsId) return;

  const defaultCol = collections.find(c => c.id === defaultWsId);
  if (!defaultCol) return;
  if (State.getWindowForCollection(defaultWsId) !== null) return;

  // Only claim a genuinely empty window; a window with real (or still-loading)
  // content that merely failed to match a saved workspace must not be clobbered.
  if (!(await windowLooksEmpty(win.id))) return;

  await Restore.switchInWindow(win.id, defaultCol);
});

// Message handler

browser.runtime.onMessage.addListener(async (msg, _sender) => {
  await hydrated;
  switch (msg.type) {
    case "getState": {
      const collections = await Storage.readAll();
      const windowMap = {};
      for (const [wid, cid] of State.windowMap) {
        windowMap[wid] = cid;
      }
      const { [DEFAULT_WS_KEY]: defaultWorkspace } = await browser.storage.local.get(DEFAULT_WS_KEY);
      let containers = [];
      try {
        containers = await browser.contextualIdentities.query({});
      } catch (e) {
        // Containers not available
      }
      const keepAliveCount = await Discarder.getKeepAlive();
      return { collections, windowMap, defaultWorkspace: defaultWorkspace || null, containers, keepAliveCount };
    }

    case "setKeepAliveCount": {
      const n = Number(msg.count);
      if (!Number.isInteger(n) || n < 0) return { ok: false, error: "Invalid count" };
      await browser.storage.local.set({ [KEEP_ALIVE_KEY]: n });
      // Re-trim every workspace that currently has owned tabs.
      const seen = new Set(State.tabOwnership.values());
      for (const wsId of seen) Discarder.enforce(wsId).catch(() => {});
      return { ok: true, keepAliveCount: n };
    }

    case "createCollection": {
      const id = generateId();
      const collection = {
        id,
        name: msg.name,
        color: sanitizeColor(msg.color),
        tabs: [],
        groups: [],
        windowId: null,
        createdAt: Date.now()
      };

      await Storage.upsert(collection);
      await Menus.rebuild();

      if (msg.capture && msg.windowId) {
        State.link(msg.windowId, id);
        collection.windowId = msg.windowId;
        const visibleTabs = await browser.tabs.query({ windowId: msg.windowId, hidden: false });
        for (const tab of visibleTabs) {
          State.assignTab(tab.id, id);
        }
        EventBus.emit("windowLinked", { windowId: msg.windowId, collectionId: id });
        await Capture.captureWindow(msg.windowId);
      } else {
        await Restore.switchInWindow(msg.windowId, collection);
      }
      return { ok: true };
    }

    case "openCollection": {
      const collections = await Storage.readAll();
      const col = collections.find(c => c.id === msg.collectionId);
      if (!col) return { ok: false, error: "Not found" };

      const existingWindowId = State.getWindowForCollection(msg.collectionId);

      if (existingWindowId !== null) {
        if (existingWindowId === msg.currentWindowId) return { ok: true };
        try {
          await browser.windows.update(existingWindowId, { focused: true });
          return { ok: true };
        } catch (e) {
          // Stale reference. Fall through to switch in current window
        }
      }

      await Restore.switchInWindow(msg.currentWindowId, col);
      return { ok: true };
    }

    case "updateMetadata": {
      const all = await Storage.readAll();
      const col = all.find(c => c.id === msg.collectionId);
      if (!col) return { ok: false };

      if (msg.name !== undefined) col.name = msg.name;
      if (msg.color !== undefined) col.color = sanitizeColor(msg.color);
      if (msg.defaultContainer !== undefined) {
        col.defaultContainer = msg.defaultContainer || null;
      }

      await browser.storage.local.set({ [STORAGE_KEY]: all });
      EventBus.emit("metadataChanged", { collection: col });
      await Menus.rebuild();
      return { ok: true };
    }

    case "deleteCollection": {
      const all = await Storage.readAll();
      const col = all.find(c => c.id === msg.collectionId);
      if (!col) return { ok: false };

      const windowId = State.getWindowForCollection(msg.collectionId);
      const ownedTabIds = State.getTabsForWorkspace(msg.collectionId);

      if (windowId !== null) {
        // Active workspace. Unlink, leave visible tabs unmanaged
        State.unlink(windowId);
        await Indicator.clear(windowId);
        for (const tabId of ownedTabIds) State.unassignTab(tabId);
      } else if (ownedTabIds.length > 0) {
        // Inactive workspace. Remove its hidden tabs
        for (const tabId of ownedTabIds) State.unassignTab(tabId);
        try { await browser.tabs.remove(ownedTabIds); } catch (e) { /* gone */ }
      }

      State.clearActiveTab(msg.collectionId);
      await Storage.delete(msg.collectionId);

      // Clear default if this was the default workspace
      const { [DEFAULT_WS_KEY]: defaultWsId } = await browser.storage.local.get(DEFAULT_WS_KEY);
      if (defaultWsId === msg.collectionId) {
        await browser.storage.local.remove(DEFAULT_WS_KEY);
      }

      await Menus.rebuild();
      return { ok: true };
    }

    case "reorderCollections": {
      const all = await Storage.readAll();
      const { fromIndex, toIndex } = msg;
      if (fromIndex < 0 || fromIndex >= all.length || toIndex < 0 || toIndex >= all.length) {
        return { ok: false };
      }
      const [item] = all.splice(fromIndex, 1);
      all.splice(toIndex, 0, item);
      await browser.storage.local.set({ [STORAGE_KEY]: all });
      await Menus.rebuild();
      return { ok: true, collections: all };
    }

    case "setDefaultWorkspace": {
      if (msg.collectionId) {
        await browser.storage.local.set({ [DEFAULT_WS_KEY]: msg.collectionId });
      } else {
        await browser.storage.local.remove(DEFAULT_WS_KEY);
      }
      return { ok: true };
    }

    case "resyncAfterRestore": {
      // A restore replaces every collection with fresh ids, so all in-memory
      // and session state now references deleted workspaces. Wipe both and the
      // switch journal, then rehydrate cold — otherwise tab ownership keeps
      // pointing at phantom workspace ids that the Janitor never reaps.
      State.reset();
      try { await browser.storage.session.remove("_state"); } catch (e) { /* ignore */ }
      await browser.storage.local.remove(PENDING_SWITCH_KEY);
      await hydrate();
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown message type" };
  }
});

// Keyboard commands

browser.commands.onCommand.addListener(async command => {
  await hydrated;
  if (command === "switch-to-previous-workspace") {
    const win = await browser.windows.getLastFocused();
    const previousWsId = State.getPreviousWorkspace(win.id);
    if (!previousWsId) return;

    const collections = await Storage.readAll();
    const target = collections.find(c => c.id === previousWsId);
    if (!target) return;

    await Restore.switchInWindow(win.id, target);
    return;
  }

  const match = command.match(/^switch-to-workspace-(\d+)$/);
  if (match) {
    const index = parseInt(match[1], 10) - 1;
    const collections = await Storage.readAll();
    if (index < 0 || index >= collections.length) return;

    const win = await browser.windows.getLastFocused();
    await Restore.switchInWindow(win.id, collections[index]);
  }
});

// Container enforcement

const ContainerEnforcer = {
  _switching: false,
  _pending: new Map(),

  setSwitching(val) {
    this._switching = val;
  },

  async _redirect(tabId, props, wsId) {
    try {
      const newTab = await browser.tabs.create(props);
      State.assignTab(newTab.id, wsId);
      await browser.tabs.remove(tabId);
    } catch (e) {
      console.warn("ContainerEnforcer: redirect failed:", e);
    }
  },

  init() {
    browser.tabs.onCreated.addListener(async tab => {
      if (this._switching) return;
      if (State.isLocked(tab.windowId)) return;

      const wsId = State.lookup(tab.windowId);
      if (!wsId) return;

      const collections = await Storage.readAll();
      const col = collections.find(c => c.id === wsId);
      if (!col || !col.defaultContainer) return;

      // Only redirect tabs in the default (no-container) context.
      // If the user explicitly chose a container, respect that.
      if (tab.cookieStoreId !== DEFAULT_CONTAINER) return;

      const url = tab.url || "";

      // about:blank means a pending navigation (e.g. middle-click bookmark).
      // Defer until onUpdated provides the real URL.
      if (url === "" || url === "about:blank") {
        this._pending.set(tab.id, {
          windowId: tab.windowId,
          index: tab.index,
          active: tab.active,
          pinned: !!tab.pinned,
          wsId,
          cookieStoreId: col.defaultContainer
        });
        return;
      }

      const props = {
        windowId: tab.windowId,
        index: tab.index,
        active: tab.active,
        cookieStoreId: col.defaultContainer
      };

      if (!isNewTabUrl(url)) {
        props.url = url;
      }
      if (tab.pinned) {
        props.pinned = true;
      }

      await this._redirect(tab.id, props, wsId);
    });

    browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      const pending = this._pending.get(tabId);
      if (!pending) return;
      if (!changeInfo.url || changeInfo.url === "about:blank") return;

      this._pending.delete(tabId);

      const props = {
        windowId: pending.windowId,
        index: tab.index,
        active: tab.active,
        cookieStoreId: pending.cookieStoreId
      };

      if (!isNewTabUrl(changeInfo.url)) {
        props.url = changeInfo.url;
      }
      if (pending.pinned) {
        props.pinned = true;
      }

      await this._redirect(tabId, props, pending.wsId);
    });

    browser.tabs.onRemoved.addListener(tabId => {
      this._pending.delete(tabId);
    });
  }
};

// Initialization

let _hydrating = false;
let _startupPending = false;

// A window is "empty" when none of its visible tabs point at real content —
// only new-tab / blank placeholders. Used to gate auto-open of the default
// workspace so it never removes a window's real (or still-restoring) tabs.
async function windowLooksEmpty(windowId) {
  try {
    const vis = await browser.tabs.query({ windowId, hidden: false });
    return !vis.some(t => t.url && t.url !== "about:blank" && !isNewTabUrl(t.url));
  } catch (e) {
    return false;
  }
}

// Recover from a switch that a mid-operation teardown left half-applied. The
// journal (see Storage._setPendingSwitch) names the window plus its `from` and
// `to` workspaces, but not how far the switch got. We resolve that by scoring
// the window's actual visible-tab URLs against each candidate's saved tabs:
// whichever it matches is the workspace it truly shows. We then repoint the
// window to that workspace in both State.windowMap and storage, detaching the
// other candidate — so the subsequent ownership rebuild attributes the visible
// tabs correctly instead of duplicating them into the wrong collection.
//
// Mutates `collections` in place; returns true if anything changed. Windows no
// longer present (e.g. after a browser restart, which mints new window Ids and
// leaves the stale journal keys unmatched) are skipped and their entries
// dropped when the journal is cleared below.
async function reconcileInterruptedSwitches(collections, windowIds) {
  const pending = await Storage._getPendingSwitches();
  const keys = Object.keys(pending);
  if (keys.length === 0) return false;

  let changed = false;
  for (const key of keys) {
    const windowId = Number(key);
    if (!windowIds.has(windowId)) continue;

    const { from, to } = pending[key];

    let visible;
    try {
      visible = await browser.tabs.query({ windowId, hidden: false });
    } catch (e) {
      continue;
    }
    const urls = new Set(visible.map(t => t.url).filter(u => u && !isNewTabUrl(u)));

    const score = wsId => {
      if (!wsId) return 0;
      const col = collections.find(c => c.id === wsId);
      if (!col) return 0;
      const saved = (col.tabs || []).map(t => t.url).filter(u => u && !isNewTabUrl(u));
      if (saved.length === 0) return 0;
      return saved.filter(u => urls.has(u)).length / saved.length;
    };

    const toScore = score(to);
    const fromScore = score(from);

    // Pick the workspace the window is actually showing. Ties favour `to` (the
    // intended target). Require a real match; if neither matches, leave the
    // window unlinked so a stale capture can't clobber either collection.
    let winner = null;
    if (toScore >= 0.5 && toScore >= fromScore) winner = to;
    else if (fromScore >= 0.5) winner = from;

    // Detach both candidates from this window first.
    for (const wsId of [from, to]) {
      if (!wsId) continue;
      const col = collections.find(c => c.id === wsId);
      if (col && col.windowId === windowId) {
        col.windowId = null;
        changed = true;
      }
      if (State.windowMap.get(windowId) === wsId) {
        State.windowMap.delete(windowId);
        changed = true;
      }
    }

    if (winner) {
      const col = collections.find(c => c.id === winner);
      if (col) {
        col.windowId = windowId;
        State.windowMap.set(windowId, winner);
        EventBus.emit("windowLinked", { windowId, collectionId: winner });
        changed = true;
      }
    }
  }

  await browser.storage.local.remove(PENDING_SWITCH_KEY);
  return changed;
}

async function hydrate() {
  if (_hydrating) return;
  _hydrating = true;

  try {
    // Try restoring in-memory state from session storage (survives suspension)
    const hadSession = await State._loadFromSession();

    const collections = await Storage.readAll();
    const windows = await browser.windows.getAll();
    const windowIds = new Set(windows.map(w => w.id));

    // Clear icons on all windows
    for (const win of windows) {
      await Indicator.clear(win.id);
    }

    // Rebuild windowMap from storage (authoritative source for window linkage)
    State.windowMap.clear();
    let changed = false;
    for (const col of collections) {
      if (col.windowId != null) {
        if (windowIds.has(col.windowId)) {
          State.windowMap.set(col.windowId, col.id);
          EventBus.emit("windowLinked", { windowId: col.windowId, collectionId: col.id });
        } else {
          col.windowId = null;
          changed = true;
        }
      }
    }

    // Reconcile any switch a mid-operation teardown left half-applied, before
    // deriving ownership from windowMap — this may repoint a window from the old
    // collection to the new one (or back) based on what tabs are really visible,
    // so the rebuild below can't misattribute them and duplicate across both.
    const reconcileChanged = await reconcileInterruptedSwitches(collections, windowIds);

    if (changed || reconcileChanged) {
      await browser.storage.local.set({ [STORAGE_KEY]: collections });
    }

    // Rebuild tabOwnership: visible tabs derive from windowMap
    const freshOwnership = new Map();
    for (const [windowId, collectionId] of State.windowMap) {
      const visibleTabs = await browser.tabs.query({ windowId, hidden: false });
      for (const tab of visibleTabs) {
        freshOwnership.set(tab.id, collectionId);
      }
    }

    if (hadSession) {
      // Warm wake: restore hidden-tab ownership from session data
      for (const [tabId, wsId] of State.tabOwnership) {
        if (!freshOwnership.has(tabId)) {
          try {
            await browser.tabs.get(tabId);
            freshOwnership.set(tabId, wsId);
          } catch (e) {
            // Tab no longer exists
          }
        }
      }
      State.tabOwnership = freshOwnership;

      // Prune stale window entries from previousWorkspaceMap
      for (const [wid] of State.previousWorkspaceMap) {
        if (!windowIds.has(wid)) State.previousWorkspaceMap.delete(wid);
      }

      // Prune stale workspace entries from activeTabMap
      const collectionIds = new Set(collections.map(c => c.id));
      for (const [wsId] of State.activeTabMap) {
        if (!collectionIds.has(wsId)) State.activeTabMap.delete(wsId);
      }
    } else {
      // Cold start: no session data available
      State.tabOwnership = freshOwnership;
      State.activeTabMap.clear();
      State.previousWorkspaceMap.clear();

      // Clean orphaned hidden tabs only on cold start. Ownership was just
      // rebuilt from visible tabs, so any hidden tab is unowned here; removing
      // them stops a later workspace open from recreating its tabs from storage
      // alongside a stale hidden copy (which duplicates them). Tabs the browser
      // restores after this pass are caught by the Janitor's unowned sweep.
      for (const win of windows) {
        const hiddenTabs = await browser.tabs.query({ windowId: win.id, hidden: true });
        const orphans = hiddenTabs.filter(t => !State.tabOwnership.has(t.id)).map(t => t.id);
        if (orphans.length > 0) {
          try { await browser.tabs.remove(orphans); } catch (e) { /* gone */ }
        }
      }

      // Re-link windows to workspaces by matching tab URLs from session restore
      const unlinkedWindows = windows.filter(w => !State.windowMap.has(w.id));
      const unlinkedCollections = collections.filter(c => State.getWindowForCollection(c.id) === null);
      let matched = false;

      for (const win of unlinkedWindows) {
        const visibleTabs = await browser.tabs.query({ windowId: win.id, hidden: false });
        const windowUrls = new Set(visibleTabs.map(t => t.url).filter(u => u && !isNewTabUrl(u)));
        if (windowUrls.size === 0) continue;

        let bestCol = null;
        let bestScore = 0;

        for (const col of unlinkedCollections) {
          if (State.getWindowForCollection(col.id) !== null) continue;
          const savedUrls = (col.tabs || []).map(t => t.url).filter(u => u && !isNewTabUrl(u));
          if (savedUrls.length === 0) continue;

          const matches = savedUrls.filter(url => windowUrls.has(url)).length;
          const score = matches / savedUrls.length;

          if (score > bestScore) {
            bestScore = score;
            bestCol = col;
          }
        }

        if (bestCol && bestScore >= 0.5) {
          State.link(win.id, bestCol.id);
          bestCol.windowId = win.id;
          matched = true;

          for (const tab of visibleTabs) {
            State.assignTab(tab.id, bestCol.id);
          }

          EventBus.emit("windowLinked", { windowId: win.id, collectionId: bestCol.id });
        }
      }

      if (matched) {
        await browser.storage.local.set({ [STORAGE_KEY]: collections });
      }
    }

    State._persist();
    await Menus.rebuild();

    // Trim every workspace with owned tabs down to its warm set on wake.
    const ownedWorkspaces = new Set(State.tabOwnership.values());
    for (const wsId of ownedWorkspaces) {
      await Discarder.enforce(wsId).catch(() => {});
    }

    // First-install setup: create default workspace from current window
    const { _setupDone } = await browser.storage.local.get("_setupDone");
    if (!_setupDone) {
      await browser.storage.local.set({ _setupDone: true });

      const win = windows.find(w => w.focused) || windows[0];
      if (win) {
        const tabs = await browser.tabs.query({ windowId: win.id, hidden: false });
        const tabList = tabs.map(tab => ({
          url: tab.url || "",
          title: tab.title || "",
          pinned: !!tab.pinned,
          focused: !!tab.active,
          cookieStoreId: tab.cookieStoreId || DEFAULT_CONTAINER
        }));

        const id = generateId();
        const collection = {
          id,
          name: "Default",
          color: "#0060df",
          tabs: tabList,
          groups: [],
          windowId: win.id,
          createdAt: Date.now()
        };

        await Storage.upsert(collection);
        await browser.storage.local.set({ [DEFAULT_WS_KEY]: id });

        State.link(win.id, id);
        for (const tab of tabs) {
          State.assignTab(tab.id, id);
        }
        State._persist();

        EventBus.emit("windowLinked", { windowId: win.id, collectionId: id });
        await Menus.rebuild();
      }
    } else if (!_startupPending) {
      // Auto-open default workspace in an empty unlinked window. Skipped during
      // browser startup: session restore is still materializing windows, so the
      // windows.onCreated handler (which waits for each window to settle) opens
      // the default there instead. Only genuinely empty windows are eligible, so
      // an unmatched or still-loading restored window is never clobbered.
      const { [DEFAULT_WS_KEY]: defaultWsId } = await browser.storage.local.get(DEFAULT_WS_KEY);
      if (defaultWsId) {
        const defaultCol = collections.find(c => c.id === defaultWsId);
        if (defaultCol && State.getWindowForCollection(defaultWsId) === null) {
          const unlinkedWindows = windows.filter(w => !State.lookup(w.id));
          for (const w of unlinkedWindows) {
            if (await windowLooksEmpty(w.id)) {
              await Restore.switchInWindow(w.id, defaultCol);
              break;
            }
          }
        }
      }
    }
  } finally {
    _hydrating = false;
  }
}

// Setup one-time listener
Indicator.init();
Menus.init();
Capture.init();
ContainerEnforcer.init();

// Hydrate on all three triggers. Handlers gate on the initial hydration so a
// hotkey or message arriving right after an event-page restart can't run
// against empty state (which would recreate whole workspaces as duplicates).
// onStartup fires only on browser start (not extension reload). Flag it so the
// initial hydrate defers default-open to the settle-aware windows.onCreated
// handler instead of racing session restore.
browser.runtime.onStartup.addListener(() => { _startupPending = true; return hydrate(); });
browser.runtime.onInstalled.addListener(() => hydrate());
const hydrated = hydrate().catch(e => console.error("Initial hydrate failed:", e));

// Alarm keepalive: prevents event page suspension; doubles as the janitor tick
browser.alarms.create("keepalive", { periodInMinutes: 0.4 });
browser.alarms.onAlarm.addListener(async () => {
  await hydrated;
  Janitor.sweep().catch(() => {});
});
