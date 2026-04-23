const COLORS = [
  { name: "Red",    hex: "#ff4f5e" },
  { name: "Orange", hex: "#ff7139" },
  { name: "Yellow", hex: "#ffa436" },
  { name: "Green",  hex: "#00d230" },
  { name: "Aqua",   hex: "#87e3cd" },
  { name: "Blue",   hex: "#0060df" },
  { name: "Purple", hex: "#9059ff" },
  { name: "Pink",   hex: "#ff97e2" }
];

// State

let collections = [];
let currentWindowId = null;
let windowMap = {};
let defaultWorkspace = null;
let formMode = null;    // "new" | "capture" | "edit"
let editingId = null;
let selectedColor = COLORS[5].hex; // blue default
let reorderMode = false;
let deletingId = null;
let dragSourceIndex = null;
let focusedIndex = -1;

// Init

async function init() {
  const win = await browser.windows.getCurrent();
  currentWindowId = win.id;
  await loadState();
  renderColorPicker();

  // Set initial focus to active workspace
  focusedIndex = collections.findIndex(col => getStatus(col) === "active");
  if (focusedIndex === -1 && collections.length > 0) focusedIndex = 0;

  renderList();
  setupEventListeners();
}

async function loadState() {
  const state = await browser.runtime.sendMessage({ type: "getState" });
  collections = state.collections || [];
  windowMap = state.windowMap || {};
  defaultWorkspace = state.defaultWorkspace || null;
}

// Status

function getStatus(col) {
  for (const [wid, cid] of Object.entries(windowMap)) {
    if (cid === col.id) {
      return parseInt(wid) === currentWindowId ? "active" : "open";
    }
  }
  return "closed";
}

// Rendering

function renderList() {
  const list = document.getElementById("collection-list");
  list.innerHTML = "";

  if (reorderMode) {
    list.classList.add("reorder-mode");
  } else {
    list.classList.remove("reorder-mode");
  }

  // Active bar
  let activeCol = null;
  for (const col of collections) {
    if (getStatus(col) === "active") { activeCol = col; break; }
  }
  updateActiveBar(activeCol);

  // Items
  if (collections.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<p>No workspaces yet.</p>";
    list.appendChild(empty);
    return;
  }

  for (let i = 0; i < collections.length; i++) {
    list.appendChild(createItem(collections[i], i));
  }

  // Clamp and apply keyboard focus
  if (collections.length === 0) {
    focusedIndex = -1;
  } else if (focusedIndex >= collections.length) {
    focusedIndex = collections.length - 1;
  }
  updateFocusedItem();
}

function updateFocusedItem() {
  const items = document.querySelectorAll(".collection-item");
  items.forEach((item, i) => {
    item.classList.toggle("focused", i === focusedIndex);
  });
  if (focusedIndex >= 0 && focusedIndex < items.length) {
    items[focusedIndex].scrollIntoView({ block: "nearest" });
  }
}

function createItem(col, index) {
  const status = getStatus(col);

  const item = document.createElement("div");
  item.className = "collection-item";
  item.dataset.index = index;
  item.dataset.id = col.id;

  // Drag handle
  const dragHandle = document.createElement("span");
  dragHandle.className = "drag-handle";
  dragHandle.innerHTML = '<span class="icon icon-drag"></span>';
  item.appendChild(dragHandle);

  // Color dot
  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.style.background = col.color;
  item.appendChild(dot);

  // Name
  const name = document.createElement("span");
  name.className = "item-name";
  name.textContent = col.name;
  item.appendChild(name);

  // Default badge
  if (defaultWorkspace === col.id) {
    const badge = document.createElement("span");
    badge.className = "item-default";
    badge.textContent = "Default";
    item.appendChild(badge);
  }

  // Status
  const statusEl = document.createElement("span");
  statusEl.className = `item-status status-${status}`;
  statusEl.textContent = status === "active" ? "Active" : "";
  item.appendChild(statusEl);

  // Actions
  const actions = document.createElement("div");
  actions.className = "item-actions";

  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.title = "Edit";
  editBtn.innerHTML = '<span class="icon icon-edit"></span>';
  editBtn.addEventListener("click", e => {
    e.stopPropagation();
    showFormView("edit", col);
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "icon-btn";
  deleteBtn.title = "Delete";
  deleteBtn.innerHTML = '<span class="icon icon-delete"></span>';
  deleteBtn.addEventListener("click", e => {
    e.stopPropagation();
    showDeleteModal(col);
  });

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);
  item.appendChild(actions);

  // Click to open
  item.addEventListener("click", () => {
    if (reorderMode) return;
    if (status === "active") return;
    browser.runtime.sendMessage({
      type: "openCollection",
      collectionId: col.id,
      currentWindowId
    });
    window.close();
  });

  // Drag-and-drop in reorder mode
  if (reorderMode) {
    item.setAttribute("draggable", "true");

    item.addEventListener("dragstart", e => {
      dragSourceIndex = index;
      e.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => item.classList.add("dragging"));
    });

    item.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDropIndicators();
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        item.classList.add("drop-above");
      } else {
        item.classList.add("drop-below");
      }
    });

    item.addEventListener("dragleave", () => {
      item.classList.remove("drop-above", "drop-below");
    });

    item.addEventListener("drop", async e => {
      e.preventDefault();
      clearDropIndicators();

      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const isAbove = e.clientY < midY;

      let targetIndex = index;
      if (!isAbove) targetIndex++;
      if (dragSourceIndex < targetIndex) targetIndex--;

      if (dragSourceIndex !== targetIndex && dragSourceIndex !== null) {
        const result = await browser.runtime.sendMessage({
          type: "reorderCollections",
          fromIndex: dragSourceIndex,
          toIndex: targetIndex
        });
        if (result.ok && result.collections) {
          collections = result.collections;
          renderList();
        }
      }
      dragSourceIndex = null;
    });

    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      clearDropIndicators();
      dragSourceIndex = null;
    });
  }

  return item;
}

function clearDropIndicators() {
  document.querySelectorAll(".drop-above, .drop-below").forEach(el => {
    el.classList.remove("drop-above", "drop-below");
  });
}

function updateActiveBar(col) {
  const bar = document.getElementById("active-bar");
  const dot = document.getElementById("active-dot");
  const name = document.getElementById("active-name");

  if (col) {
    bar.classList.remove("unmanaged");
    bar.classList.add("managed");
    bar.style.setProperty("--active-color", col.color);
    dot.style.background = col.color;
    name.textContent = col.name;
  } else {
    bar.classList.add("unmanaged");
    bar.classList.remove("managed");
    bar.style.removeProperty("--active-color");
    dot.style.background = "";
    name.textContent = "No workspace";
  }
}

function renderColorPicker() {
  const picker = document.getElementById("color-picker");
  picker.innerHTML = "";
  for (const c of COLORS) {
    const swatch = document.createElement("button");
    swatch.className = "color-swatch";
    swatch.style.background = c.hex;
    swatch.title = c.name;
    swatch.dataset.color = c.hex;
    if (c.hex === selectedColor) swatch.classList.add("selected");
    swatch.addEventListener("click", () => selectColor(c.hex));
    picker.appendChild(swatch);
  }
}

function selectColor(hex) {
  selectedColor = hex;
  document.querySelectorAll(".color-swatch").forEach(s => {
    s.classList.toggle("selected", s.dataset.color === hex);
  });
}

// View management

function showListView() {
  document.getElementById("list-view").classList.remove("hidden");
  document.getElementById("form-view").classList.add("hidden");
}

function showFormView(mode, col) {
  document.getElementById("list-view").classList.add("hidden");
  document.getElementById("form-view").classList.remove("hidden");

  formMode = mode;
  const titleEl = document.getElementById("form-title");
  const confirmBtn = document.getElementById("btn-confirm");
  const input = document.getElementById("input-name");

  const defaultCheckbox = document.getElementById("input-default");

  if (mode === "edit" && col) {
    editingId = col.id;
    input.value = col.name;
    selectColor(col.color);
    defaultCheckbox.checked = defaultWorkspace === col.id;
    titleEl.textContent = "Edit Workspace";
    confirmBtn.textContent = "Save Changes";
  } else if (mode === "capture") {
    editingId = null;
    input.value = "";
    selectColor(COLORS[5].hex);
    defaultCheckbox.checked = false;
    titleEl.textContent = "Save Window as Workspace";
    confirmBtn.textContent = "Create";
  } else {
    editingId = null;
    input.value = "";
    selectColor(COLORS[5].hex);
    defaultCheckbox.checked = false;
    titleEl.textContent = "New Workspace";
    confirmBtn.textContent = "Create";
  }

  input.focus();
}

function showDeleteModal(col) {
  deletingId = col.id;
  document.getElementById("delete-name").textContent = col.name;
  document.getElementById("delete-modal").classList.remove("hidden");
}

function hideDeleteModal() {
  document.getElementById("delete-modal").classList.add("hidden");
  deletingId = null;
}

// Event listeners

function setupEventListeners() {
  // New button
  document.getElementById("btn-new").addEventListener("click", () => {
    showFormView("new");
  });

  // Options toggle
  document.getElementById("btn-options").addEventListener("click", e => {
    e.stopPropagation();
    document.getElementById("options-dropdown").classList.toggle("hidden");
  });

  // Close dropdown on outside click
  document.addEventListener("click", () => {
    document.getElementById("options-dropdown").classList.add("hidden");
  });

  // Option: Capture
  document.getElementById("opt-capture").addEventListener("click", () => {
    document.getElementById("options-dropdown").classList.add("hidden");
    showFormView("capture");
  });

  // Option: Export
  document.getElementById("opt-export").addEventListener("click", async () => {
    document.getElementById("options-dropdown").classList.add("hidden");
    await exportData();
  });

  // Option: Restore
  document.getElementById("opt-restore").addEventListener("click", () => {
    document.getElementById("options-dropdown").classList.add("hidden");
    browser.tabs.create({ url: browser.runtime.getURL("restore/restore.html") });
    window.close();
  });

  // Form: Cancel
  document.getElementById("btn-cancel").addEventListener("click", () => {
    showListView();
  });

  // Form: Confirm
  document.getElementById("btn-confirm").addEventListener("click", handleFormSubmit);

  // Form: Enter/Escape on input
  document.getElementById("input-name").addEventListener("keydown", e => {
    if (e.key === "Enter") handleFormSubmit();
    if (e.key === "Escape") showListView();
  });

  // Delete modal: Cancel
  document.getElementById("btn-delete-cancel").addEventListener("click", hideDeleteModal);

  // Delete modal: Confirm
  document.getElementById("btn-delete-confirm").addEventListener("click", async () => {
    if (!deletingId) return;
    await browser.runtime.sendMessage({ type: "deleteCollection", collectionId: deletingId });
    hideDeleteModal();
    await loadState();
    renderList();
  });

  // Keyboard navigation in list view
  document.addEventListener("keydown", e => {
    const listView = document.getElementById("list-view");
    const deleteModal = document.getElementById("delete-modal");

    if (listView.classList.contains("hidden")) return;
    if (!deleteModal.classList.contains("hidden")) return;
    if (reorderMode) return;

    const itemCount = collections.length;
    if (itemCount === 0) return;

    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      focusedIndex = (focusedIndex + 1) % itemCount;
      updateFocusedItem();
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      focusedIndex = (focusedIndex - 1 + itemCount) % itemCount;
      updateFocusedItem();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (focusedIndex >= 0 && focusedIndex < itemCount) {
        const col = collections[focusedIndex];
        if (getStatus(col) === "active") {
          window.close();
        } else {
          browser.runtime.sendMessage({
            type: "openCollection",
            collectionId: col.id,
            currentWindowId
          });
          window.close();
        }
      }
    }
  });

  // Reorder toggle
  document.getElementById("btn-reorder").addEventListener("click", () => {
    reorderMode = !reorderMode;
    const icon = document.getElementById("reorder-icon");
    if (reorderMode) {
      icon.className = "icon icon-check";
    } else {
      icon.className = "icon icon-move";
    }
    renderList();
  });
}

async function handleFormSubmit() {
  const name = document.getElementById("input-name").value.trim();
  if (!name) {
    document.getElementById("input-name").focus();
    return;
  }

  const isDefault = document.getElementById("input-default").checked;

  if (formMode === "edit" && editingId) {
    await browser.runtime.sendMessage({
      type: "updateMetadata",
      collectionId: editingId,
      name,
      color: selectedColor
    });

    // Update default workspace setting
    if (isDefault) {
      await browser.runtime.sendMessage({ type: "setDefaultWorkspace", collectionId: editingId });
    } else if (defaultWorkspace === editingId) {
      await browser.runtime.sendMessage({ type: "setDefaultWorkspace", collectionId: null });
    }

    showListView();
    await loadState();
    renderList();
  } else if (formMode === "capture") {
    await browser.runtime.sendMessage({
      type: "createCollection",
      name,
      color: selectedColor,
      capture: true,
      windowId: currentWindowId
    });
    window.close();
  } else {
    await browser.runtime.sendMessage({
      type: "createCollection",
      name,
      color: selectedColor,
      capture: false,
      windowId: currentWindowId
    });
    window.close();
  }
}

// Export

async function exportData() {
  const data = await browser.storage.local.get("collections");
  const colls = data.collections || [];
  const json = JSON.stringify(colls, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `backup-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Start

document.addEventListener("DOMContentLoaded", init);
