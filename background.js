// Constants

const STORAGE_KEY = "collections";
const DEFAULT_CONTAINER = "firefox-default";
const NEW_TAB_URL = "about:newtab";
const HEX_COLOR_RE = /^#([A-Fa-f0-9]{3}){1,2}$/;
const DEFAULT_COLOR = "#808080";

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

  link(windowId, collectionId) {
    this.windowMap.set(windowId, collectionId);
  },

  unlink(windowId) {
    this.windowMap.delete(windowId);
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
  },

  unassignTab(tabId) {
    this.tabOwnership.delete(tabId);
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
  },

  getActiveTab(workspaceId) {
    return this.activeTabMap.get(workspaceId) || null;
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
      await browser.browserAction.setIcon({ path: url, windowId });
      await browser.browserAction.setTitle({ title: `Workspaces — ${collection.name}`, windowId });
      await browser.browserAction.setBadgeText({ text: "", windowId });
    } catch (e) {
      console.warn("Indicator.update failed:", e);
    }
  },

  async clear(windowId) {
    const svg = this.TEMPLATE.replace(/\{\{COLOR\}\}/g, DEFAULT_COLOR);
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    try {
      await browser.browserAction.setIcon({ path: url, windowId });
      await browser.browserAction.setTitle({ title: "Workspaces", windowId });
      await browser.browserAction.setBadgeText({ text: "", windowId });
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
        contexts: ["tab"]
      });
    }
  },

  init() {
    browser.menus.onClicked.addListener(async (info, tab) => {
      if (!info.menuItemId.startsWith("move-tab-") || info.menuItemId === "move-tab-root") return;

      const collectionId = info.menuItemId.replace("move-tab-", "");
      const targetWindowId = State.getWindowForCollection(collectionId);

      if (targetWindowId !== null) {
        // Target workspace is open in a window. Move tab there
        try {
          await browser.tabs.move(tab.id, { windowId: targetWindowId, index: -1 });
          await browser.tabs.update(tab.id, { active: true });
        } catch (e) {
          console.error("Failed to move tab:", e);
        }
      } else {
        // Target workspace is closed. Save tab data to its storage
        const collections = await Storage.readAll();
        const col = collections.find(c => c.id === collectionId);
        if (!col) return;
        col.tabs = col.tabs || [];
        col.tabs.push({
          url: tab.url || "",
          title: tab.title || "",
          pinned: !!tab.pinned,
          focused: false,
          cookieStoreId: tab.cookieStoreId || DEFAULT_CONTAINER
        });
        await browser.storage.local.set({ [STORAGE_KEY]: collections });
        try {
          await browser.tabs.remove(tab.id);
        } catch (e) {
          console.error("Failed to remove tab after move:", e);
        }
      }
    });
  }
};

// Tab capture

const Capture = {
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
        this.captureWindow(tab.windowId);
      }
    });

    browser.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
      if (tab && tab.windowId) this.captureWindow(tab.windowId);
    });

    browser.tabs.onMoved.addListener((_tabId, moveInfo) => {
      if (moveInfo.windowId) this.captureWindow(moveInfo.windowId);
    });

    browser.tabs.onAttached.addListener((_tabId, attachInfo) => {
      if (attachInfo.newWindowId) {
        const wsId = State.lookup(attachInfo.newWindowId);
        if (wsId) State.assignTab(_tabId, wsId);
        this.captureWindow(attachInfo.newWindowId);
      }
    });

    browser.tabs.onDetached.addListener((_tabId, detachInfo) => {
      State.unassignTab(_tabId);
      if (detachInfo.oldWindowId) this.captureWindow(detachInfo.oldWindowId);
    });

    browser.tabs.onActivated.addListener(activeInfo => {
      if (activeInfo.windowId) this.captureWindow(activeInfo.windowId);
    });

    browser.tabs.onRemoved.addListener((_tabId, removeInfo) => {
      State.unassignTab(_tabId);
      if (removeInfo.isWindowClosing) return;
      if (removeInfo.windowId) this.captureWindow(removeInfo.windowId);
    });

    if (typeof browser.tabGroups !== "undefined" && browser.tabGroups.onUpdated) {
      browser.tabGroups.onUpdated.addListener(group => {
        if (group.windowId) this.captureWindow(group.windowId);
      });
    }
  }
};

// Restoration engine

const Restore = {
  async switchInWindow(windowId, collection) {
    const currentWsId = State.lookup(windowId);
    if (currentWsId === collection.id) return;

    // Track the outgoing workspace as the previous one for this window
    if (currentWsId) {
      State.previousWorkspaceMap.set(windowId, currentWsId);
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

    State.acquireLock(windowId);
    let freshlyCreated = false;

    try {
      // Phase 1: Show or create target workspace's tabs
      const targetTabIds = State.getTabsForWorkspace(collection.id);

      if (targetTabIds.length > 0) {
        // Target has hidden tabs. Show them
        await browser.tabs.show(targetTabIds);
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
      State.releaseLock(windowId);
      await Capture.captureWindow(windowId);
    }
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

    if (shouldDiscard) {
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

// Message handler

browser.runtime.onMessage.addListener(async (msg, _sender) => {
  switch (msg.type) {
    case "getState": {
      const collections = await Storage.readAll();
      const windowMap = {};
      for (const [wid, cid] of State.windowMap) {
        windowMap[wid] = cid;
      }
      return { collections, windowMap };
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

      State.activeTabMap.delete(msg.collectionId);
      await Storage.delete(msg.collectionId);
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

    case "resyncAfterRestore": {
      await hydrate();
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown message type" };
  }
});

// Keyboard commands

browser.commands.onCommand.addListener(async command => {
  if (command !== "switch-to-previous-workspace") return;

  const win = await browser.windows.getLastFocused();
  const previousWsId = State.previousWorkspaceMap.get(win.id);

  if (!previousWsId) return;

  const collections = await Storage.readAll();
  const target = collections.find(c => c.id === previousWsId);
  if (!target) return;

  await Restore.switchInWindow(win.id, target);
});

// Initialization

let _hydrating = false;

async function hydrate() {
  if (_hydrating) return;
  _hydrating = true;

  try {
    State.reset();

    const collections = await Storage.readAll();
    const windows = await browser.windows.getAll();
    const windowIds = new Set(windows.map(w => w.id));

    // Clear icons on all windows
    for (const win of windows) {
      await Indicator.clear(win.id);
    }

    let changed = false;
    for (const col of collections) {
      if (col.windowId != null) {
        if (windowIds.has(col.windowId)) {
          State.link(col.windowId, col.id);
          const tabs = await browser.tabs.query({ windowId: col.windowId, hidden: false });
          for (const tab of tabs) State.assignTab(tab.id, col.id);
          EventBus.emit("windowLinked", { windowId: col.windowId, collectionId: col.id });
        } else {
          col.windowId = null;
          changed = true;
        }
      }
    }

    if (changed) {
      await browser.storage.local.set({ [STORAGE_KEY]: collections });
    }

    // Clean up orphaned hidden tabs from previous sessions
    for (const win of windows) {
      const hiddenTabs = await browser.tabs.query({ windowId: win.id, hidden: true });
      if (hiddenTabs.length > 0) {
        try { await browser.tabs.remove(hiddenTabs.map(t => t.id)); } catch (e) { /* gone */ }
      }
    }

    await Menus.rebuild();
  } finally {
    _hydrating = false;
  }
}

// Setup one-time listener
Indicator.init();
Menus.init();
Capture.init();

// Hydrate on all three triggers
browser.runtime.onStartup.addListener(hydrate);
browser.runtime.onInstalled.addListener(hydrate);
hydrate();
