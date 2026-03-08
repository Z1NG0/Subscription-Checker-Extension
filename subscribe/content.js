(function() {

  const PANEL_ID = "cs-sub-panel";
  const BTN_ID = "cs-sub-check-btn";

  let isRunning = false;
  let cancelRequested = false;
  let stats = { premium: 0, lite: 0, none: 0 };
  let runAbortController = null;
  let apiLimiter = null;

  const LOG_LEVEL = 1;
  const LOG_PREFIX = "[CS-SUB]";

  function log(kind, ...args) {
    if (LOG_LEVEL < 1) return;
    const method = kind === "warn" ? "warn" : (kind === "error" ? "error" : "info");
    console[method](LOG_PREFIX, ...args);
  }

  function compactText(text, maxLen = 160) {
    if (!text) return "";
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (clean.length > maxLen) return clean.slice(0, maxLen) + "...";
    return clean;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const id = setTimeout(resolve, ms);
      if (signal) {
        const onAbort = () => {
          clearTimeout(id);
          signal.removeEventListener('abort', onAbort);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async function safeSleep(ms) {
    try {
      await sleep(ms, getRunSignal());
      return true;
    } catch (e) {
      return false;
    }
  }

  function createRateLimiter(options) {
    const opts = options || {};
    const rate = Math.max(0.1, Number(opts.ratePerSecond) || 1);
    const baseInterval = Math.max(1, Math.round(1000 / rate));
    let minInterval = baseInterval;
    const maxInterval = Math.max(baseInterval, Number(opts.maxIntervalMs) || baseInterval);
    const backoffMult = Math.max(1.1, Number(opts.backoffMultiplier) || 1.5);
    const recoveryStep = Math.max(1, Math.round(Number(opts.recoveryStepMs) || 50));
    const recoveryWindowMs = Math.max(1000, Math.round(Number(opts.recoveryWindowMs) || 15000));

    let lastStart = 0;
    let cooldownUntil = 0;
    let last429At = 0;

    async function wait(signal) {
      while (true) {
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const now = Date.now();
        const earliest = Math.max(lastStart + minInterval, cooldownUntil);
        const waitMs = earliest - now;
        if (waitMs <= 0) {
          lastStart = now;
          return;
        }
        await sleep(waitMs, signal);
      }
    }

    function on429(retryAfterMs) {
      last429At = Date.now();
      minInterval = Math.min(maxInterval, Math.round(minInterval * backoffMult + 20));
      if (retryAfterMs) {
        cooldownUntil = Math.max(cooldownUntil, Date.now() + retryAfterMs);
      }
    }

    function onSuccess() {
      if (!last429At) return;
      if (Date.now() - last429At > recoveryWindowMs && minInterval > baseInterval) {
        minInterval = Math.max(baseInterval, minInterval - recoveryStep);
      }
    }

    function reset() {
      minInterval = baseInterval;
      cooldownUntil = 0;
      last429At = 0;
      lastStart = 0;
    }

    return { wait, on429, onSuccess, reset };
  }

  function parseRetryAfter(resp, fallbackMs) {
    try {
      const h = resp && resp.headers ? resp.headers.get('Retry-After') : null;
      const sec = h ? parseInt(h, 10) : NaN;
      if (!isNaN(sec) && sec > 0) return sec * 1000;
    } catch {}
    return fallbackMs || 0;
  }
  function extractProfileKeyFromUrl(url) {
    try {
      const u = new URL(url, window.location.origin);
      const path = u.pathname || "";
      const idMatch = path.match(/\/profiles?\/(\d{17})/i);
      if (idMatch) return idMatch[1];

      let parts = path.split('/').filter(Boolean);
      if (!parts.length) return null;
      if (parts[parts.length - 1].toLowerCase() === 'friends') {
        parts.pop();
      }
      if (!parts.length) return null;
      if (parts.length > 1 && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0])) {
        parts.shift();
      }
      if (!parts.length) return null;

      const markerIndex = parts.findIndex(p => /^(profile|profiles|user|id)$/i.test(p));
      let candidate = null;
      if (markerIndex >= 0 && markerIndex + 1 < parts.length) {
        candidate = parts[markerIndex + 1];
      } else {
        candidate = parts[0];
      }

      if (!candidate) return null;
      try {
        return decodeURIComponent(candidate);
      } catch (e) {
        return candidate;
      }
    } catch (e) {
      return null;
    }
  }

  function normalizeTextKey(value) {
    if (value == null) return '';
    return String(value).trim().toLowerCase();
  }

  function statusPriority(status) {
    if (status === 'PREMIUM') return 2;
    if (status === 'LITE') return 1;
    return 0;
  }

  function mergeStatus(prevStatus, nextStatus) {
    const prev = prevStatus || 'NONE';
    const next = nextStatus || 'NONE';
    return statusPriority(next) > statusPriority(prev) ? next : prev;
  }

  function normalizeGroupToStatus(groupValue) {
    const group = normalizeTextKey(groupValue).toUpperCase();
    if (!group || group === 'NULL' || group === 'NONE') return 'NONE';
    if (group === 'LITE') return 'LITE';
    if (group === 'VIP') return 'PREMIUM';
    if (group === 'PREMIUM') return 'PREMIUM';
    if (['PRO', 'TALENT', 'LEGEND', 'PROSPECT', 'COACH', 'TALENT-ADMIN', 'PRO-SMALL', 'PRO-FULL'].includes(group)) return 'PREMIUM';
    return 'NONE';
  }

  function collectFriendMapsDeep(node, maps, depth) {
    if (!node || typeof node !== 'object') return;
    if (depth > 7) return;

    if (Array.isArray(node)) {
      for (const item of node) {
        collectFriendMapsDeep(item, maps, depth + 1);
      }
      return;
    }

    const keys = Object.keys(node);
    let friendLikeEntries = 0;
    for (const key of keys) {
      if (!/^\d{17}$/.test(key)) continue;
      const value = node[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        friendLikeEntries += 1;
      }
    }

    if (friendLikeEntries > 0) {
      maps.push(node);
    }

    for (const key of keys) {
      collectFriendMapsDeep(node[key], maps, depth + 1);
    }
  }

  function buildFriendsPrivilegeIndex(apiData) {
    const bySteamId = new Map();
    const byName = new Map();
    const maps = [];

    collectFriendMapsDeep(apiData, maps, 0);

    for (const friendsMap of maps) {
      for (const steamid64 of Object.keys(friendsMap)) {
        if (!/^\d{17}$/.test(steamid64)) continue;
        const friend = friendsMap[steamid64];
        if (!friend || typeof friend !== 'object' || Array.isArray(friend)) continue;

        const status = normalizeGroupToStatus(friend.group ?? friend.vip_name ?? friend.vip);
        bySteamId.set(steamid64, mergeStatus(bySteamId.get(steamid64), status));

        const uniqueName = normalizeTextKey(friend.name_unique ?? friend.nameUnique ?? friend.login ?? friend.nickname);
        if (uniqueName) {
          byName.set(uniqueName, mergeStatus(byName.get(uniqueName), status));
        }

        const displayName = normalizeTextKey(friend.name);
        if (displayName) {
          byName.set(displayName, mergeStatus(byName.get(displayName), status));
        }
      }
    }

    return { bySteamId, byName, sourceMaps: maps.length };
  }

  function getOwnerProfileKeyFromCurrentUrl() {
    return extractProfileKeyFromUrl(window.location.href);
  }

  function resetStats() {
    stats.premium = 0;
    stats.lite = 0;
    stats.none = 0;
  }

  function startRunController() {
    if (runAbortController) {
      try { runAbortController.abort(); } catch (e) {}
    }
    runAbortController = new AbortController();
    return runAbortController.signal;
  }

  function stopRunController() {
    if (!runAbortController) return;
    try { runAbortController.abort(); } catch (e) {}
    runAbortController = null;
  }

  function getRunSignal() {
    return runAbortController ? runAbortController.signal : null;
  }
  let buttonsCreated = false;

  function isFriendsPageUrl(url) {
    try {
      const href = url || window.location.href;
      const u = new URL(href, window.location.origin);
      return u.pathname.toLowerCase().includes('/friends');
    } catch (e) {
      return false;
    }
  }

  function removeUi() {
    const panel = document.getElementById(PANEL_ID);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);

    const btn = document.getElementById(BTN_ID);
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);

    buttonsCreated = false;
  }

  function ensureUiForCurrentRoute() {
    injectStyles();

    if (isFriendsPageUrl()) {
      const hasButton = createHeaderButtons();
      if (!hasButton) {
        removeUi();
        return;
      }
      createPanel();
      buttonsCreated = true;
      return;
    }

    if (isRunning) {
      cancelRequested = true;
      stopRunController();
    }

    if (document.getElementById(PANEL_ID) || document.getElementById(BTN_ID)) {
      removeUi();
    }
  }

  function setupFriendsPageUiGuard() {
    if (window.__csSubUiGuardReady) return;
    window.__csSubUiGuardReady = true;

    let uiSyncTimer = null;
    const scheduleSync = (delayMs = 40) => {
      if (uiSyncTimer) clearTimeout(uiSyncTimer);
      uiSyncTimer = setTimeout(() => {
        uiSyncTimer = null;
        ensureUiForCurrentRoute();
      }, delayMs);
    };

    const wrapHistory = (methodName) => {
      const original = history[methodName];
      if (typeof original !== 'function') return;
      history[methodName] = function(...args) {
        const ret = original.apply(this, args);
        scheduleSync(0);
        scheduleSync(180);
        return ret;
      };
    };

    wrapHistory('pushState');
    wrapHistory('replaceState');
    window.addEventListener('popstate', () => scheduleSync(0), true);
    window.addEventListener('hashchange', () => scheduleSync(0), true);

    const observer = new MutationObserver(() => {
      const onFriends = isFriendsPageUrl();
      const hasBtn = !!document.getElementById(BTN_ID);
      const hasPanel = !!document.getElementById(PANEL_ID);
      if (onFriends && (!hasBtn || !hasPanel)) scheduleSync(40);
      if (!onFriends && (hasBtn || hasPanel)) scheduleSync(40);
    });
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }
  function injectStyles() {
    if (document.getElementById('cs-sub-styles')) return;

    const style = document.createElement('style');
    style.id = 'cs-sub-styles';
    style.textContent = `
      /* Background highlight behind the element using a pseudo-element */
      [data-cs-checking="true"] {
        position: relative !important;
        z-index: 0 !important;
        overflow: visible !important;
        border-radius: 8px !important;
      }
      [data-cs-checking="true"]::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 8px;
        background: rgba(0, 200, 255, 0.08);
        box-shadow: 0 0 8px rgba(0, 150, 200, 0.35), 0 0 16px rgba(0, 100, 150, 0.18);
        pointer-events: none;
        z-index: -1;
        transition: opacity 450ms ease, transform 450ms ease;
      }
      /* Fade state */
      .cs-sub-fading::before { opacity: 0 !important; transform: scale(0.985); }

      /* Final privilege border */
      [data-cs-sub="PREMIUM"],
      [data-cs-sub="LITE"] {
        position: relative !important;
        z-index: 0 !important;
        overflow: visible !important;
        border-radius: 8px !important;
      }
      [data-cs-sub="PREMIUM"]::after,
      [data-cs-sub="LITE"]::after {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 8px;
        pointer-events: none;
        transition: opacity 180ms ease;
      }
      [data-cs-sub="PREMIUM"]::after {
        box-shadow: 0 0 0 2px #f0b358, 0 0 14px rgba(240, 179, 88, 0.34);
      }
      [data-cs-sub="LITE"]::after {
        box-shadow: 0 0 0 2px #6080ff, 0 0 14px rgba(96, 128, 255, 0.34);
      }
    `;
    document.head.appendChild(style);
  }
  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      z-index: 9999;
      background: #111;
      color: #7CFF7C;
      font-size: 12px;
      padding: 12px 14px;
      border-radius: 8px;
      font-family: monospace;
      min-width: 280px;
      box-shadow: 0 0 0 1px rgba(255,255,255,.08);
      line-height: 1.6;
      opacity: 0.7;
    `;
    panel.innerHTML = `[CS-SUB] Готов к проверке<br><span style="color:#f0b358">PREMIUM:</span> <span style="color:#ffffff">0</span> | <span style="color:#6080ff">LITE:</span> <span style="color:#ffffff">0</span> | <span style="color:#FF0000">None:</span> <span style="color:#ffffff">0</span>`;
    document.body.appendChild(panel);
  }
  function setCheckButtonVisual(btn, state) {
    if (!btn) return;
    try {
      btn.dataset.csState = state;
      if (state === 'idle') {
        btn.style.background = 'rgba(59, 255, 100, 0.18)';
        btn.style.color = '#b8ffbf';
        btn.style.borderColor = 'rgba(59, 255, 100, 0.35)';
        btn.disabled = false;
      } else if (state === 'busy') {
        btn.style.background = 'rgba(59, 255, 100, 0.12)';
        btn.style.color = '#a6f7ae';
        btn.style.borderColor = 'rgba(59, 255, 100, 0.25)';
        btn.disabled = true;
      } else if (state === 'cancel') {
        btn.style.background = 'rgba(255, 70, 70, 0.18)';
        btn.style.color = '#ffb3b3';
        btn.style.borderColor = 'rgba(255, 70, 70, 0.40)';
        btn.disabled = false;
      }
    } catch (e) { }
  }
  function panelLog(text, stats, totalTimeMs) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    let content = `[CS-SUB] ${text}`;
    if (totalTimeMs !== undefined) {
      const timeSec = (totalTimeMs / 1000).toFixed(1);
      content += ` <span style="color:#999">(${timeSec}s)</span>`;
    }

    if (stats) {
      content += `<br><span style="color:#f0b358">PREMIUM:</span> <span style="color:#ffffff">${stats.premium}</span> |
                  <span style="color:#6080ff">LITE:</span> <span style="color:#ffffff">${stats.lite}</span> |
                  <span style="color:#FF0000">None:</span> <span style="color:#ffffff">${stats.none}</span>`;
    }
    panel.innerHTML = content;
  }
  function createHeaderButtons() {
    const authHeader = document.querySelector("header nav#user");
    const guestNav = document.querySelector('header nav[id*="header-login-btn"]');
    const guestWrapper = document.querySelector("header .login-btn-wrapper");
    const fallbackHeader =
      document.querySelector('header nav[id*="user"]') ||
      document.querySelector("header #socials");
    const header = authHeader || guestWrapper || guestNav || fallbackHeader;
    const existingBtn = document.getElementById(BTN_ID);
    if (existingBtn) return true;
    if (!header) return false;
    if (!document.getElementById(BTN_ID)) {
      const btn = document.createElement("button");
      btn.id = BTN_ID;
      btn.textContent = "Проверить";
      btn.style.cssText = `
        display: flex;
        align-items: center;
        background: rgba(255,255,255,0.08);
        color: #c8ffd0;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        padding: 9px 14px;
        height: 36px;
        cursor: pointer;
        transition: background .15s ease, border-color .15s ease, color .15s ease, box-shadow .15s ease, transform .15s ease;
        margin-right: 8px;
        backdrop-filter: blur(10px) saturate(140%);
        -webkit-backdrop-filter: blur(10px) saturate(140%);
        box-shadow: 0 6px 16px rgba(0,0,0,0.18), inset 0 0 0 1px rgba(255,255,255,0.06);
      `;
      btn.textContent = "Проверить";
      setCheckButtonVisual(btn, 'idle');

      btn.onmouseenter = () => {
        const s = btn.dataset.csState;
        if (s === 'idle') {
          btn.style.background = 'rgba(59, 255, 100, 0.28)';
        } else if (s === 'cancel' || s === 'busy') {
          btn.style.background = 'rgba(255, 70, 70, 0.26)';
        }
      };
      btn.onmouseleave = () => {
        setCheckButtonVisual(btn, btn.dataset.csState || 'idle');
      };
      btn.onclick = async () => {
        if (isRunning) {
          cancelRequested = true;
          stopRunController();
          btn.textContent = "Отмена...";
          setCheckButtonVisual(btn, 'cancel');
          setTimeout(() => {
            if (!isRunning) {
              btn.textContent = "Проверить";
              setCheckButtonVisual(btn, 'idle');
            }
          }, 1000);
          return;
        }
        await checkAllFriends(btn);
      };

      if (guestWrapper) {
        const onlinePlayers = guestWrapper.querySelector(".online-players-wrapper");
        const loginBtn = guestWrapper.querySelector("a.login-btn");
        if (onlinePlayers && onlinePlayers.parentNode === guestWrapper) {
          guestWrapper.insertBefore(btn, onlinePlayers);
        } else if (loginBtn && loginBtn.parentNode === guestWrapper) {
          guestWrapper.insertBefore(btn, loginBtn);
        } else {
          guestWrapper.prepend(btn);
        }
        btn.style.alignSelf = "center";
        btn.style.flexShrink = "0";
      } else if (guestNav) {
        const navWrapper = guestNav.querySelector(".login-btn-wrapper");
        if (navWrapper) {
          const onlinePlayers = navWrapper.querySelector(".online-players-wrapper");
          const loginBtn = navWrapper.querySelector("a.login-btn");
          if (onlinePlayers && onlinePlayers.parentNode === navWrapper) {
            navWrapper.insertBefore(btn, onlinePlayers);
          } else if (loginBtn && loginBtn.parentNode === navWrapper) {
            navWrapper.insertBefore(btn, loginBtn);
          } else {
            navWrapper.prepend(btn);
          }
          btn.style.alignSelf = "center";
          btn.style.flexShrink = "0";
        } else {
          header.prepend(btn);
        }
      } else {
        header.prepend(btn);
      }
    }
    return true;
  }

  async function fetchUserDataViaAPI(profileKey) {
    ensureLimiters();
    const signal = getRunSignal();
    const maxAttempts = 3;
    const idOrNick = String(profileKey || '').trim();
    if (!idOrNick) return null;
    let tries = 0;

    while (tries < maxAttempts) {
      tries += 1;
      if (cancelRequested) return null;
      try {
        if (apiLimiter) await apiLimiter.wait(signal);

        log("info", `API user/data -> ${idOrNick}`);
        const resp = await fetch("https://api.cybershoke.net/user/data", {
          method: "POST",
          headers: {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ steamid64: idOrNick }),
          credentials: "omit",
          mode: "cors",
          signal
        });

        const respText = await resp.text();

        if (resp.status === 429) {
          const retryAfter = parseRetryAfter(resp, 300);
          if (apiLimiter) apiLimiter.on429(retryAfter);
          log("warn", `API user/data <- ${idOrNick} 429 retryAfterMs=${retryAfter}`);
          if (!(await safeSleep(retryAfter || 300))) return null;
          continue;
        }

        if (!resp.ok) {
          const shortBody = compactText(respText);
          log("error", `API user/data <- ${idOrNick} ${resp.status} ${shortBody}`);
          throw new Error(`HTTP ${resp.status} ${shortBody}`);
        }

        let parsed = null;
        try {
          parsed = respText ? JSON.parse(respText) : null;
        } catch (e) {
          log("error", `API user/data <- ${idOrNick} JSON parse error: ${String(e)} body=${compactText(respText)}`);
          throw e;
        }

        if (!parsed) throw new Error("Empty API response");
        if (apiLimiter) apiLimiter.onSuccess();
        return parsed;
      } catch (error) {
        if (error && error.name === 'AbortError') return null;
        if (tries < maxAttempts) {
          const backoff = 300 * (1 + Math.random()) * Math.pow(1.5, tries - 1);
          if (!(await safeSleep(backoff))) return null;
          continue;
        }
        log("error", `API user/data <- ${idOrNick} ERROR ${String(error)}`);
        return null;
      }
    }

    return null;
  }

  function ensureLimiters() {
    if (!apiLimiter) {
      apiLimiter = createRateLimiter({
        ratePerSecond: 3.8,
        maxIntervalMs: 1000,
        backoffMultiplier: 1.1,
        recoveryStepMs: 200,
        recoveryWindowMs: 15000
      });
    }
  }

  function updateStatsForResult(result) {
    if (result === "PREMIUM") stats.premium += 1;
    else if (result === "LITE") stats.lite += 1;
    else stats.none += 1;
  }

  function highlightProfile(block, result) {
    if (!block) return;

    if (result === "PREMIUM") {
      block.dataset.csSub = 'PREMIUM';
    } else if (result === "LITE") {
      block.dataset.csSub = 'LITE';
    } else {
      try { block.removeAttribute('data-cs-sub'); } catch (e) {}
    }
  }

  function markChecking(block) {
    if (!block) return;
    try {
      if (block._cs_fade_timeout) { clearTimeout(block._cs_fade_timeout); block._cs_fade_timeout = null; }
      if (block._cs_fade_timeout2) { clearTimeout(block._cs_fade_timeout2); block._cs_fade_timeout2 = null; }
    } catch (e) {}
    try { block.removeAttribute('data-cs-sub'); } catch (e) {}
    block._cs_pending_result = null;
    block.classList.remove('cs-sub-fading');
    block._cs_check_start = Date.now();
    block.setAttribute('data-cs-checking', 'true');
  }

  function unmarkChecking(block, result) {
    if (!block) return;
    block._cs_pending_result = result || block._cs_pending_result || "NONE";
    const started = block._cs_check_start || 0;
    const elapsed = Date.now() - started;
    const minMs = 500;
    const fadeMs = 300;

    try {
      if (block._cs_fade_timeout) clearTimeout(block._cs_fade_timeout);
      if (block._cs_fade_timeout2) clearTimeout(block._cs_fade_timeout2);
    } catch (e) {}

    const remaining = Math.max(0, minMs - elapsed);
    block._cs_fade_timeout = setTimeout(() => {
      highlightProfile(block, block._cs_pending_result || "NONE");
      block.classList.add('cs-sub-fading');
      block._cs_fade_timeout2 = setTimeout(() => {
        try { block.removeAttribute('data-cs-checking'); } catch (e) {}
        block.classList.remove('cs-sub-fading');
        try { delete block._cs_check_start; } catch (e) {}
        try { delete block._cs_pending_result; } catch (e) {}
        try { clearTimeout(block._cs_fade_timeout); clearTimeout(block._cs_fade_timeout2); } catch (e) {}
        block._cs_fade_timeout = null;
        block._cs_fade_timeout2 = null;
      }, fadeMs);
    }, remaining);
  }

  function getBlockProfileUrl(block) {
    if (!block) return null;
    if (block.tagName === "A" && block.href) return block.href;
    const link = block.querySelector("a.block-profile-friends-f-block-content");
    if (link && link.href) return link.href;
    return null;
  }

  function getLookupKeysForBlock(block) {
    const steamIds = [];
    const names = [];
    const url = getBlockProfileUrl(block);
    if (url) {
      const key = extractProfileKeyFromUrl(url);
      if (key) {
        if (/^\d{17}$/.test(key)) steamIds.push(key);
        else names.push(normalizeTextKey(key));
      }
    }

    const nameEl = block ? block.querySelector('.block-profile-friends-f-block-content-name') : null;
    if (nameEl && nameEl.textContent) {
      const displayName = normalizeTextKey(nameEl.textContent);
      if (displayName) names.push(displayName);
    }

    return {
      steamIds: Array.from(new Set(steamIds)),
      names: Array.from(new Set(names.filter(Boolean)))
    };
  }

  function findStatusForBlock(block, index) {
    if (!index) return "NONE";
    const keys = getLookupKeysForBlock(block);

    for (const steamid64 of keys.steamIds) {
      const bySteam = index.bySteamId.get(steamid64);
      if (bySteam) return bySteam;
    }

    for (const nameKey of keys.names) {
      const byName = index.byName.get(nameKey);
      if (byName) return byName;
    }

    return "NONE";
  }

  async function checkAllFriends(btn) {
    if (!buttonsCreated) {
      const hasButton = createHeaderButtons();
      if (!hasButton) return;
      createPanel();
      buttonsCreated = true;
    }

    if (isRunning) return;

    const ownerProfileKey = getOwnerProfileKeyFromCurrentUrl();
    if (!ownerProfileKey) {
      panelLog("Не удалось извлечь ID/ник из URL страницы друзей", stats);
      return;
    }

    isRunning = true;
    cancelRequested = false;
    resetStats();

    ensureLimiters();
    if (apiLimiter) apiLimiter.reset();
    startRunController();

    const checkBtn = btn || document.getElementById(BTN_ID);
    if (checkBtn) {
      checkBtn.textContent = "Отмена";
      setCheckButtonVisual(checkBtn, 'cancel');
    }

    const startTime = Date.now();

    try {
      const blocks = Array.from(document.querySelectorAll(
        `#block-profile-friends-in-game .block-profile-friends-f-block, #block-profile-friends-online .block-profile-friends-f-block, #block-profile-friends-offline .block-profile-friends-f-block`
      ));
      if (!blocks.length) {
        panelLog("Друзей не найдено", stats);
        return;
      }

      panelLog(`Проверка...`, stats);

      const apiData = await fetchUserDataViaAPI(ownerProfileKey);
      if (cancelRequested) {
        panelLog("Отменено", stats, Date.now() - startTime);
        return;
      }
      if (!apiData) {
        panelLog("API не вернул данные по друзьям", stats, Date.now() - startTime);
        return;
      }

      const index = buildFriendsPrivilegeIndex(apiData);
      log("info", `Найдено карт друзей в ответе: ${index.sourceMaps}`);

      let processed = 0;
      const counted = new Set();

      for (const block of blocks) {
        if (cancelRequested) break;
        markChecking(block);

        const result = findStatusForBlock(block, index);
        unmarkChecking(block, result);

        const keys = getLookupKeysForBlock(block);
        const uniqueKey = keys.steamIds[0]
          ? `s:${keys.steamIds[0]}`
          : (keys.names[0] ? `n:${keys.names[0]}` : `b:${processed}`);
        if (!counted.has(uniqueKey)) {
          counted.add(uniqueKey);
          updateStatsForResult(result);
        }

        processed += 1;
        panelLog(`(${processed}/${blocks.length}) -> ${result}`, stats, Date.now() - startTime);
        await safeSleep(0);
      }

      if (cancelRequested) {
        panelLog("Отменено", stats, Date.now() - startTime);
        return;
      }

      panelLog(`Готово`, stats, Date.now() - startTime);
    } finally {
      cancelRequested = false;
      const finalBtn = document.getElementById(BTN_ID);
      if (finalBtn) {
        finalBtn.textContent = "Проверить";
        setCheckButtonVisual(finalBtn, 'idle');
      }
      stopRunController();
      isRunning = false;
    }
  }
  setupFriendsPageUiGuard();
  setTimeout(() => {
    ensureUiForCurrentRoute();
  }, 500);

})();
