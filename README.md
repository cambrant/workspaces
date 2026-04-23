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

1. The current workspace's tabs are captured to storage, then **hidden** (via `browser.tabs.hide`).
2. If the target workspace has hidden tabs still in memory, they are **shown**. Otherwise, tabs are **recreated** from the stored data.
3. The window-to-workspace link is updated in both `State` and storage.

A per-window lock prevents tab event listeners from capturing intermediate state
during the switch.

When switching to a workspace in an **unmanaged** window (no current workspace),
the existing tabs are **removed** rather than hidden, since there is no
workspace to associate them with.

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
`previousWorkspaceMap`) is persisted to `browser.storage.session` after every
mutation. Session storage survives background script suspension but not browser
restarts. This allows the extension to recover gracefully when Firefox suspends
the background page without going through a full cold-start rebuild.

## Keepalive

An alarm named `keepalive` fires every 24 seconds (`periodInMinutes: 0.4`). The
alarm listener is a no-op. Its sole purpose is to prevent Firefox from
suspending the background script's event page. Without this, Firefox may unload
the background script after a period of inactivity, which would lose the
in-memory `State` if session persistence also fails.

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
