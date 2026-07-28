# Workspaces

A Firefox extension that organizes browsing into named, persistent collections
of tabs. Each workspace maps to a browser window; switching workspaces hides the
current tabs and shows (or recreates) the target workspace's tabs in the same
window.

## How it works

A **workspace** (internally called a "collection") is a named group of tabs with
a color. Workspaces are stored in `browser.storage.local` as an array under the
key `collections`. Each entry tracks the tab URLs, titles, pinned state,
container assignments, and tab group structure.

At runtime, the background script maintains an in-memory `State` object that
tracks:

- **windowMap**: which window ID is linked to which workspace ID.
- **tabOwnership**: which tab ID belongs to which workspace (including hidden tabs from inactive workspaces).
- **activeTabMap**: the last-active tab for each workspace, so switching back restores focus.
- **previousWorkspaceMap**: the previously active workspace per window, for the quick-switch shortcut.

### Switching workspaces

When a workspace is opened in a window (`Restore.switchInWindow`):

1. The current workspace's tabs are captured to storage, then **hidden** (via `browser.tabs.hide`). Afterwards the workspace is trimmed to its warm set (see [Selective tab discarding](#selective-tab-discarding)).
2. If the target workspace has hidden tabs still in memory, they are **shown**. Otherwise, tabs are **recreated** from the stored data — recreated tabs open **discarded** (unloaded) except the focused one, so a freshly opened workspace only loads its active tab.
3. The window-to-workspace link is updated in both `State` and storage.

When tab groups are available, group definitions are saved with each workspace,
but only the active workspace's visible tabs stay grouped in Firefox. Inactive
workspace tabs are ungrouped before being hidden so their group headers do not
linger in the browser's tab list.

A per-window lock prevents tab event listeners from capturing intermediate state
during the switch.

When switching to a workspace in an **unmanaged** window (no current workspace),
the existing tabs are **removed** rather than hidden, since there is no
workspace to associate them with. Before removal, any tabs with real content
(not new-tab / blank placeholders) are captured into a new `Recovered <date>`
workspace so nothing is silently lost.

### Tab capture

Every tab event (create, update, move, attach, detach, activate, remove, group
change) triggers a capture of the affected window's visible tabs to storage.
This keeps the stored state continuously up to date. Captures are skipped for
locked windows (mid-switch) and unlinked windows (no workspace).

### Context menus

A "Move tab to workspace" context menu is built from the current workspace list.
If the target workspace is open in another window, the tab is moved there. If
the target is closed, the tab's data is appended to the stored workspace and the
tab is closed.

### Toolbar indicator

The toolbar icon updates per-window to show the workspace's color and first
letter. Unlinked windows show a grey default icon.

## Startup and initialization

`hydrate()` is the central initialization function. It runs on three triggers:

- `browser.runtime.onStartup`: browser launch.
- `browser.runtime.onInstalled`: extension install, update, or browser update.
- A bare `hydrate()` call at script load. Catches edge cases where neither event fires (e.g., background script reload during development).

### Hydration steps

1. **Session restore**: attempts to load `State` from `browser.storage.session`. If found, this is a **warm wake** (the background script was suspended but the browser session is intact). If not, it's a **cold start**.
2. **Rebuild windowMap**: iterates stored collections and re-links any that have a `windowId` matching a currently open window. Stale `windowId` references (windows that no longer exist) are cleared.
3. **Rebuild tabOwnership**: visible tabs in linked windows are assigned to their workspace. On warm wake, hidden-tab ownership is restored from session data (verified against live tabs). On cold start, hidden-tab ownership is lost, so orphaned hidden tabs are removed.

   When a window is matched to a workspace by URL on cold start (in `hydrate` and in `windows.onCreated`), only the visible tabs whose URLs belong to that workspace are claimed. Firefox does not reliably preserve `tabs.hide()` state across a browser restart, so an inactive workspace's tabs can reappear **visible** in the active window; any such tab whose URL matches a *different* saved workspace is removed rather than assigned, so it is not captured into — and duplicated across — the matched workspace. Cold-start ownership is lost anyway, so these tabs are recreated from storage on the next switch to their workspace. Tabs that match no saved workspace (genuinely user-opened) are left untouched.
4. **Prune stale state** (warm wake only): removes entries from `previousWorkspaceMap` and `activeTabMap` that reference closed windows or deleted workspaces.
5. **Rebuild context menus**.

### First install

On the very first run (detected via the `_setupDone` flag in storage), hydrate
creates a **Default** workspace that inherits all tabs from the focused window.
This workspace is also set as the default workspace. The `_setupDone` flag
persists across restarts but is cleared on uninstall, so reinstalling
re-triggers the first-install flow.

### Default workspace auto-open

On subsequent startups, if a default workspace is configured and it is not
already open in any window, it is automatically opened in the first unlinked
window. A workspace can be marked as default via the "Open on browser startup"
checkbox in the edit form.

## Session persistence

In-memory state (`windowMap`, `tabOwnership`, `activeTabMap`,
`previousWorkspaceMap`, `tabRecency`) is persisted to `browser.storage.session`
after every mutation. Session storage survives background script suspension but not browser
restarts. This allows the extension to recover gracefully when Firefox suspends
the background page without going through a full cold-start rebuild.

## Selective tab discarding

Tabs persist until explicitly closed, but they do not all stay resident in
memory. Each workspace keeps its **N most-recently-active tabs loaded** (default
10, set via **Settings** in the popup — stored under the `keepAliveCount`
storage key) and **discards** the rest via
`browser.tabs.discard`. Discarding preserves the tab id — `State.tabOwnership`
stays valid and showing a discarded tab reloads it from its URL — so nothing is
lost, only unloaded.

Recency is tracked in `State.tabRecency`, a monotonically increasing counter
bumped on `tabs.onActivated` and persisted to session storage. Active, pinned,
and already-discarded tabs are never discarded.

Trimming (`Discarder.enforce`) runs:

- after leaving a workspace during a switch (on the outgoing workspace),
- debounced ~2s after activating a tab (on that tab's workspace),
- once per workspace on `hydrate()`,
- on every workspace when `keepAliveCount` changes.

This is **proactive trimming on top of** Firefox's own memory-pressure tab
unloading — not a replacement for it, and it does not prevent Firefox from
unloading warm-set tabs under pressure. It only guarantees idle workspaces don't
sit fully resident.

## Keepalive

An alarm named `keepalive` fires every 24 seconds (`periodInMinutes: 0.4`). Its
primary purpose is to prevent Firefox from suspending the background script's
event page — without it Firefox may unload the background script after a period
of inactivity, which would lose the in-memory `State` if session persistence
also fails. The alarm listener doubles as the janitor tick: each fire runs
`Janitor.sweep()` (skipped while hydrating or any window is mid-operation) to
reap unowned hidden tabs and re-trim each workspace to its warm set.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+,` | Switch to the previous workspace in the current window |

## Permissions

| Permission | Reason |
|---|---|
| `tabs` | Query, create, move, hide, show, and remove tabs |
| `tabHide` | Hide tabs belonging to inactive workspaces |
| `storage` | Persist workspace data and runtime state |
| `activeTab` | Access the active tab's properties |
| `menus` | "Move tab to workspace" context menu |
| `contextualIdentities` | Preserve Firefox container assignments on tabs |
| `cookies` | Required alongside `contextualIdentities` |
| `alarms` | Keepalive alarm to prevent background script suspension |

## Building

```
make
```

Produces `workspaces.xpi`, a zip of all source files ready to load in Firefox
via `about:debugging`
