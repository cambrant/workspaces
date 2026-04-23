const STORAGE_KEY = "collections";
const HEX_COLOR_RE = /^#([A-Fa-f0-9]{3}){1,2}$/;

let pendingCollections = null;

// Utility

function generateId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 9);
  return `ws-${ts}-${rand}`;
}

function isValidHexColor(color) {
  if (color === "currentColor") return true;
  return HEX_COLOR_RE.test(color);
}

// File handling

function setupDropZone() {
  const zone = document.getElementById("drop-zone");

  zone.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.addEventListener("change", () => {
      if (input.files.length) handleFile(input.files[0]);
    });
    input.click();
  });

  zone.addEventListener("dragover", e => {
    e.preventDefault();
    zone.classList.add("dragover");
  });

  zone.addEventListener("dragleave", () => {
    zone.classList.remove("dragover");
  });

  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("dragover");
    if (e.dataTransfer.files.length) {
      handleFile(e.dataTransfer.files[0]);
    }
  });
}

async function handleFile(file) {
  hideStatus();

  let text;
  try {
    text = await file.text();
  } catch (e) {
    showError("Failed to read file.");
    return;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    showError("Invalid JSON file.");
    return;
  }

  // Accept either {workspaces: [...]} / {collections: [...]} or a bare array
  let collections;
  if (Array.isArray(data)) {
    collections = data;
  } else if (data && Array.isArray(data.workspaces)) {
    collections = data.workspaces;
  } else if (data && Array.isArray(data.collections)) {
    collections = data.collections;
  } else {
    showError("Unrecognized format: expected an array of collections.");
    return;
  }

  // Validate
  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    if (col.color && col.color !== "currentColor" && !isValidHexColor(col.color)) {
      showError(`Invalid color "${col.color}" in collection ${i + 1}.`);
      return;
    }
    if (col.tabs !== undefined && !Array.isArray(col.tabs)) {
      showError(`Invalid tab list in collection "${col.name || i + 1}".`);
      return;
    }
  }

  // Process
  pendingCollections = collections.map(col => ({
    ...col,
    id: col.id || generateId(),
    windowId: null,
    tabs: col.tabs || [],
    groups: col.groups || []
  }));

  // Show confirmation
  document.getElementById("import-count").textContent = pendingCollections.length;
  document.getElementById("confirm-modal").classList.remove("hidden");
}

// Restore

async function performRestore() {
  if (!pendingCollections) return;

  document.getElementById("confirm-modal").classList.add("hidden");

  try {
    await browser.storage.local.set({ [STORAGE_KEY]: pendingCollections });
    await browser.runtime.sendMessage({ type: "resyncAfterRestore" });

    showSuccess(`Restored ${pendingCollections.length} workspaces. This tab will close in 5 seconds...`);
    pendingCollections = null;

    let countdown = 5;
    const interval = setInterval(() => {
      countdown--;
      if (countdown <= 0) {
        clearInterval(interval);
        browser.tabs.getCurrent().then(tab => {
          if (tab) browser.tabs.remove(tab.id);
        });
      } else {
        showSuccess(`Restored successfully. This tab will close in ${countdown} seconds...`);
      }
    }, 1000);
  } catch (e) {
    showError("Restore failed: " + e.message);
  }
}

// Status

function showError(msg) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = "status status-error";
  el.classList.remove("hidden");
}

function showSuccess(msg) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = "status status-success";
  el.classList.remove("hidden");
}

function hideStatus() {
  document.getElementById("status").classList.add("hidden");
}

// Event listeners

function setupListeners() {
  document.getElementById("btn-close").addEventListener("click", () => {
    browser.tabs.getCurrent().then(tab => {
      if (tab) browser.tabs.remove(tab.id);
    });
  });

  document.getElementById("btn-modal-cancel").addEventListener("click", () => {
    document.getElementById("confirm-modal").classList.add("hidden");
    pendingCollections = null;
  });

  document.getElementById("btn-modal-confirm").addEventListener("click", performRestore);
}

// Start

document.addEventListener("DOMContentLoaded", () => {
  setupDropZone();
  setupListeners();
});
