const SETTINGS_KEY = "csSubSettings";
const DEFAULT_SETTINGS = Object.freeze({
  showPanel: true,
  visualCheck: true,
  autoCheckFriends: false
});

function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    showPanel: source.showPanel !== false,
    visualCheck: source.visualCheck !== false,
    autoCheckFriends: source.autoCheckFriends === true
  };
}

function getStorageArea() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    return chrome.storage.local;
  }
  return null;
}

function loadSettings() {
  const storage = getStorageArea();
  if (!storage) return Promise.resolve({ ...DEFAULT_SETTINGS });

  return new Promise((resolve) => {
    storage.get([SETTINGS_KEY], (result) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        resolve({ ...DEFAULT_SETTINGS });
        return;
      }
      resolve(normalizeSettings(result ? result[SETTINGS_KEY] : null));
    });
  });
}

function saveSettings(settings) {
  const storage = getStorageArea();
  if (!storage) return Promise.resolve(false);

  return new Promise((resolve) => {
    storage.set({ [SETTINGS_KEY]: settings }, () => {
      if (chrome.runtime && chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

function setStatus(text, isError = false) {
  const status = document.getElementById("status");
  if (!status) return;
  status.textContent = text || "";
  status.style.color = isError ? "#ff9ea0" : "#9aa7c0";
}

document.addEventListener("DOMContentLoaded", async () => {
  const fields = {
    showPanel: document.getElementById("showPanel"),
    visualCheck: document.getElementById("visualCheck"),
    autoCheckFriends: document.getElementById("autoCheckFriends")
  };

  let state = await loadSettings();
  fields.showPanel.checked = state.showPanel;
  fields.visualCheck.checked = state.visualCheck;
  fields.autoCheckFriends.checked = state.autoCheckFriends;
  setStatus("\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043d\u044b.");

  const handleChange = async (key, checked) => {
    state = { ...state, [key]: checked };
    const ok = await saveSettings(state);
    setStatus(
      ok ? "\u0421\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e." : "\u041e\u0448\u0438\u0431\u043a\u0430 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u044f.",
      !ok
    );
  };

  for (const [key, node] of Object.entries(fields)) {
    node.addEventListener("change", () => {
      handleChange(key, node.checked);
    });
  }
});
