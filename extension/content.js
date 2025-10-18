/**
 * Content script for Action Mimicker — modal-suppression update
 *
 * - Temporarily overrides window.alert/confirm/prompt during incoming remote events
 *   so modal dialogs (alert/confirm/prompt) do not block unattended remote clients.
 * - Restores originals after a short timeout.
 * - All other behaviors unchanged: resilient messaging, cursor, input, robust click synthesis,
 *   dedupe of incoming events, and loop protection.
 *
 * Paste this file into extension/content.js, reload the extension in chrome://extensions,
 * then reload pages in both profiles and test.
 */

(() => {
  // ---------------------------
  // Helpers: dedupe storage & event id generation
  // (same as before)
  // ---------------------------
  const recentEventIds = new Map();    // eventId -> timestamp
  const recentDescriptorHashes = new Map(); // hash -> timestamp
  const DEDUPE_WINDOW_MS = 3000; // ignore duplicates within this window

  function pruneOldDedupe() {
    const now = Date.now();
    for (const [k, t] of recentEventIds) {
      if (now - t > DEDUPE_WINDOW_MS) recentEventIds.delete(k);
    }
    for (const [k, t] of recentDescriptorHashes) {
      if (now - t > DEDUPE_WINDOW_MS) recentDescriptorHashes.delete(k);
    }
  }
  setInterval(pruneOldDedupe, 2000);

  function generateEventId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function descriptorHash(desc) {
    if (!desc) return null;
    try {
      const h = `${desc.selector||''}|${desc.tag||''}|${String(desc.centerX||'')},${String(desc.centerY||'')}`;
      return h;
    } catch (e) {
      return null;
    }
  }

  // ---------------------------
  // Helper: resilient messaging to background
  // ---------------------------
  function sendToBg(payload, retries = 6, delay = 150) {
    try {
      chrome.runtime.sendMessage({ type: 'outgoing', payload }, (resp) => {
        if (chrome.runtime.lastError) {
          if (retries > 0) {
            setTimeout(() => sendToBg(payload, retries - 1, Math.round(delay * 1.5)), delay);
          } else {
            console.debug('[content] sendToBg failed after retries:', chrome.runtime.lastError.message);
          }
        }
      });
    } catch (e) {
      if (retries > 0) setTimeout(() => sendToBg(payload, retries - 1, Math.round(delay * 1.5)), delay);
    }
  }

  // ---------------------------
  // Cursor overlay container and helpers
  // ---------------------------
  const cursorContainer = (() => {
    try {
      const container = document.createElement('div');
      container.style.position = 'fixed';
      container.style.left = '0';
      container.style.top = '0';
      container.style.width = '100%';
      container.style.height = '100%';
      container.style.pointerEvents = 'none';
      container.style.zIndex = '2147483647';
      document.documentElement.appendChild(container);
      return container;
    } catch (e) {
      console.warn('[content] failed to create cursor container', e);
      return null;
    }
  })();

  const peers = new Map(); // peerId -> { el: DOMElement }

  function makeCursorEl(peerId) {
    const el = document.createElement('div');
    el.className = 'synced-cursor';
    el.style.position = 'absolute';
    el.style.width = '12px';
    el.style.height = '12px';
    el.style.background = 'rgba(0,150,255,0.95)';
    el.style.borderRadius = '50%';
    el.style.transform = 'translate(-50%, -50%)';
    el.style.pointerEvents = 'none';
    el.style.transition = 'transform 0.04s linear';
    el.dataset.peer = peerId;
    if (cursorContainer) cursorContainer.appendChild(el);
    return el;
  }

  // ---------------------------
  // Normalization utilities
  // ---------------------------
  function normalizePoint(clientX, clientY) {
    return {
      x: clientX / Math.max(window.innerWidth, 1),
      y: clientY / Math.max(window.innerHeight, 1),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      url: location.href
    };
  }

  // ---------------------------
  // Selector generation
  // ---------------------------
  function generateSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) {
      try { return `#${CSS.escape(el.id)}`; } catch (e) { return `#${el.id}`; }
    }
    if (el.dataset && el.dataset.syncId) {
      try { return `[data-sync-id="${CSS.escape(el.dataset.syncId)}"]`; } catch (e) { return `[data-sync-id="${el.dataset.syncId}"]`; }
    }

    const parts = [];
    let cur = el;
    let tries = 0;
    while (cur && cur.nodeType === 1 && cur !== document.body && tries < 12) {
      let part = cur.tagName.toLowerCase();
      if (cur.className) {
        const classes = String(cur.className).trim().split(/\s+/).filter(Boolean);
        if (classes.length) {
          part += '.' + classes.slice(0, 2).map(c => {
            try { return CSS.escape(c); } catch (e) { return c; }
          }).join('.');
        }
      }
      const parent = cur.parentNode;
      if (parent && parent.children) {
        const idx = Array.prototype.indexOf.call(parent.children, cur) + 1;
        part += `:nth-child(${idx})`;
      }
      parts.unshift(part);
      cur = cur.parentElement;
      tries++;
    }
    return parts.join(' > ');
  }

  // ---------------------------
  // Descriptor matching heuristics
  // ---------------------------
  function findElementForDescriptor(desc) {
    if (!desc) return null;

    if (desc.selector) {
      try {
        const found = document.querySelector(desc.selector);
        if (found) return found;
      } catch (err) { /* ignore invalid selector */ }
    }

    if (desc.tag && desc.text && desc.text.trim()) {
      try {
        const candidates = Array.from(document.getElementsByTagName(desc.tag));
        const textSnippet = desc.text.trim().slice(0, 40).toLowerCase();
        for (const c of candidates) {
          const t = (c.innerText || c.textContent || '').trim().slice(0, 40).toLowerCase();
          if (t === textSnippet) return c;
        }
      } catch (e) { /* ignore */ }
    }

    if (typeof desc.centerX === 'number' && typeof desc.centerY === 'number') {
      try {
        const all = Array.from(document.querySelectorAll(desc.tag || '*')).slice(0, 500);
        let best = null;
        let bestDist = Infinity;
        for (const el of all) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const centerX = (rect.left + rect.right) / 2;
          const centerY = (rect.top + rect.bottom) / 2;
          const nx = centerX / Math.max(window.innerWidth, 1);
          const ny = centerY / Math.max(window.innerHeight, 1);
          const dx = nx - desc.centerX;
          const dy = ny - desc.centerY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < bestDist) {
            bestDist = dist;
            best = el;
          }
        }
        if (best && bestDist < 0.22) return best;
      } catch (e) { /* ignore */ }
    }

    return null;
  }

  // ---------------------------
  // Event capture: mouse move (throttled)
  // ---------------------------
  let queuedMouse = null;
  let sendingMouse = false;
  window.addEventListener('mousemove', (e) => {
    queuedMouse = normalizePoint(e.clientX, e.clientY);
    if (!sendingMouse) {
      sendingMouse = true;
      requestAnimationFrame(() => {
        if (queuedMouse) {
          sendToBg({ type: 'mouse', data: queuedMouse });
          queuedMouse = null;
        }
        sendingMouse = false;
      });
    }
  }, { passive: true });

  // ---------------------------
  // Click capture (user-only, adds eventId)
  // ---------------------------
  function buildElementDescriptor(el) {
    if (!el || el.nodeType !== 1) return null;
    const selector = generateSelector(el);
    const tag = el.tagName ? el.tagName.toLowerCase() : null;
    const text = (el.innerText || el.textContent || '').trim().slice(0, 200);
    const rect = el.getBoundingClientRect();
    const centerX = ((rect.left + rect.right) / 2) / Math.max(window.innerWidth, 1);
    const centerY = ((rect.top + rect.bottom) / 2) / Math.max(window.innerHeight, 1);
    return {
      selector,
      tag,
      text,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      centerX,
      centerY,
      pageUrl: location.href,
      viewport: { w: window.innerWidth, h: window.innerHeight }
    };
  }

  window.addEventListener('click', (e) => {
    if (!e.isTrusted) return;

    const target = e.target;
    if (!(target instanceof Element)) return;

    if (target.dataset && target.dataset.__synced_ignore === '1') {
      try { delete target.dataset.__synced_ignore; } catch (err) {}
      return;
    }

    const desc = buildElementDescriptor(target);
    const payload = { element: desc, mouse: normalizePoint(e.clientX, e.clientY) };
    payload.eventId = generateEventId();
    sendToBg({ type: 'click', data: payload });

    const anchor = target.closest && target.closest('a[href]');
    const isNewTab = anchor && (anchor.target === '_blank' || e.ctrlKey || e.metaKey || e.button === 1);
    if (isNewTab && anchor && anchor.href) {
      sendToBg({ type: 'open_tab', data: { url: anchor.href, eventId: generateEventId() } });
    }
  }, true);

  // Also capture auxclick for middle-clicks
  window.addEventListener('auxclick', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest && target.closest('a[href]');
    if (anchor && anchor.href) {
      const shouldOpen = (e.button === 1) || e.ctrlKey || e.metaKey;
      if (shouldOpen) {
        sendToBg({ type: 'open_tab', data: { url: anchor.href, eventId: generateEventId() } });
      }
    }
  }, true);

  // ---------------------------
  // Input capture
  // ---------------------------
  function onInputEvent(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) {
      const selector = generateSelector(target);
      const val = (target.isContentEditable) ? target.innerText : target.value;
      const sel = {};
      if ('selectionStart' in target && 'selectionEnd' in target) {
        sel.start = target.selectionStart;
        sel.end = target.selectionEnd;
      } else {
        sel.start = sel.end = null;
      }
      const rect = target.getBoundingClientRect();
      const centerX = ((rect.left + rect.right) / 2) / Math.max(window.innerWidth, 1);
      const centerY = ((rect.top + rect.bottom) / 2) / Math.max(window.innerHeight, 1);
      const payload = { selector, value: val, selection: sel, tag: tag.toLowerCase(), centerX, centerY, eventId: generateEventId() };
      sendToBg({ type: 'input', data: payload });
    }
  }
  window.addEventListener('input', onInputEvent, true);

  // ---------------------------
  // History / navigation hooks
  // ---------------------------
  function broadcastNavigation(url) {
    sendToBg({ type: 'navigate', data: { url, eventId: generateEventId() } });
  }
  (function() {
    const push = history.pushState;
    const replace = history.replaceState;
    history.pushState = function() {
      const res = push.apply(this, arguments);
      try { broadcastNavigation(location.href); } catch (e) {}
      return res;
    };
    history.replaceState = function() {
      const res = replace.apply(this, arguments);
      try { broadcastNavigation(location.href); } catch (e) {}
      return res;
    };
    window.addEventListener('popstate', () => { broadcastNavigation(location.href); });
    window.addEventListener('hashchange', () => { broadcastNavigation(location.href); });
  })();

  // Wrap window.open to detect programmatic opens
  (function() {
    const origOpen = window.open;
    window.open = function(url, name, specs) {
      try { sendToBg({ type: 'open_tab', data: { url: String(url), eventId: generateEventId() } }); } catch (e) {}
      return origOpen.apply(this, arguments);
    };
  })();

  // ---------------------------
  // Modal suppression helpers (NEW)
  // - overrideModals() temporarily replaces alert/confirm/prompt with non-blocking versions
  // - restoreModals() restores originals
  // - showToast() displays a short non-modal message
  // ---------------------------
  let _origAlert = null;
  let _origConfirm = null;
  let _origPrompt = null;
  let _modalOverrideCount = 0; // allow nested overrides

  function showToast(msg, timeout = 1500) {
    try {
      const id = '__sync_toast';
      let existing = document.getElementById(id);
      if (!existing) {
        existing = document.createElement('div');
        existing.id = id;
        Object.assign(existing.style, {
          position: 'fixed',
          right: '12px',
          top: '12px',
          background: 'rgba(11,116,218,0.95)',
          color: '#fff',
          padding: '6px 10px',
          borderRadius: '6px',
          zIndex: 2147483650,
          fontSize: '13px',
          pointerEvents: 'none',
        });
        document.documentElement.appendChild(existing);
      }
      existing.textContent = String(msg);
      existing.style.opacity = '1';
      setTimeout(() => {
        try { existing.style.transition = 'opacity 400ms'; existing.style.opacity = '0'; } catch (e) {}
        setTimeout(() => { try { existing.remove(); } catch (e) {} }, 500);
      }, timeout);
    } catch (e) {
      /* ignore to avoid breaking page */
      console.debug('[content] showToast failed', e);
    }
  }

  function overrideModals() {
    try {
      _modalOverrideCount++;
      if (_modalOverrideCount > 1) return; // already overridden
      _origAlert = window.alert;
      _origConfirm = window.confirm;
      _origPrompt = window.prompt;

      window.alert = function(msg) { showToast('Alert: ' + String(msg)); };
      window.confirm = function(msg) { showToast('Confirm: ' + String(msg)); return true; };
      window.prompt = function(msg, def) { showToast('Prompt: ' + String(msg)); return def || ''; };
    } catch (e) {
      console.debug('[content] overrideModals failed', e);
    }
  }

  function restoreModals() {
    try {
      _modalOverrideCount = Math.max(0, _modalOverrideCount - 1);
      if (_modalOverrideCount > 0) return;
      if (_origAlert) window.alert = _origAlert;
      if (_origConfirm) window.confirm = _origConfirm;
      if (_origPrompt) window.prompt = _origPrompt;
      _origAlert = _origConfirm = _origPrompt = null;
    } catch (e) {
      console.debug('[content] restoreModals failed', e);
    }
  }

  // ---------------------------
  // Robust click synth helper (hover -> focus -> down -> small delay -> up/click)
  // ---------------------------
  function synthesizeClickOnElement(el, delayMs = 40) {
    try {
      const rect = el.getBoundingClientRect();
      const clientX = Math.round(rect.left + rect.width / 2);
      const clientY = Math.round(rect.top + rect.height / 2);
      const baseOpts = { bubbles: true, cancelable: true, view: window, clientX, clientY };

      try {
        el.dispatchEvent(new PointerEvent('pointerover', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, baseOpts)));
        el.dispatchEvent(new MouseEvent('mouseover', baseOpts));
      } catch (e) {}

      try { el.focus && el.focus(); } catch (e) {}

      try {
        el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, baseOpts)));
        el.dispatchEvent(new MouseEvent('mousedown', baseOpts));
      } catch (e) {}

      setTimeout(() => {
        try {
          el.dispatchEvent(new MouseEvent('mouseup', baseOpts));
          el.dispatchEvent(new MouseEvent('click', baseOpts));
        } catch (e) {}
        try { el.click && el.click(); } catch (e) {}
      }, delayMs);

      return true;
    } catch (err) {
      console.warn('[content] synthesizeClickOnElement error', err);
      try { el.click && el.click(); } catch (e) {}
      return false;
    }
  }

  // ---------------------------
  // Incoming events from background (with dedupe)
  // ---------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'sync-event') return;
    const from = msg.from || 'peer';
    const payload = msg.payload || {};

    const incomingEventId = payload && payload.eventId;
    if (incomingEventId) {
      if (recentEventIds.has(incomingEventId)) {
        console.log('[content] ignored duplicate eventId', incomingEventId);
        return;
      } else {
        recentEventIds.set(incomingEventId, Date.now());
      }
    }

    if (payload.type === 'click' && payload.data && payload.data.element) {
      const h = descriptorHash(payload.data.element);
      if (h && recentDescriptorHashes.has(h)) {
        console.log('[content] ignored duplicate descriptor hash', h);
        return;
      } else if (h) {
        recentDescriptorHashes.set(h, Date.now());
      }
    }

    if (!peers.has(from)) peers.set(from, { el: makeCursorEl(from) });
    const peer = peers.get(from);

    if (payload.type === 'mouse') {
      if (payload.data && payload.data.url !== location.href) {
        peer.el.style.display = 'none';
        return;
      }
      const pd = payload.data || {};
      peer.el.style.display = '';
      const x = (pd.x * window.innerWidth) + ((pd.scrollX || 0) - window.scrollX);
      const y = (pd.y * window.innerHeight) + ((pd.scrollY || 0) - window.scrollY);
      peer.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    } else if (payload.type === 'click') {
      console.log('[content] incoming click payload:', payload);
      const desc = payload.data && payload.data.element;
      const el = desc ? findElementForDescriptor(desc) : null;

      if (el) {
        console.log('[content] matched element for click:', el, 'descriptor:', desc);

        // Mark element briefly so our capture ignores the synthetic click
        try { if (el.dataset) el.dataset.__synced_ignore = '1'; } catch (e) {}
        setTimeout(() => { try { if (el.dataset) delete el.dataset.__synced_ignore; } catch (e) {} }, 1000);

        // Temporarily override modal dialogs so alert/confirm/prompt won't block remote
        overrideModals();
        setTimeout(restoreModals, 1600); // restore after 1.6s (should be enough for handlers)

        // Synthesize robust click (hover, focus, down -> delay -> up & click)
        const ok = synthesizeClickOnElement(el, 40); // 40ms delay for reliability
        console.log('[content] synthesizeClickOnElement ->', ok);
      } else {
        console.warn('[content] could not find element for click descriptor:', desc);
        if (payload.data && payload.data.mouse) {
          const m = payload.data.mouse;
          const x = Math.round((m.x * window.innerWidth) + ((m.scrollX || 0) - window.scrollX));
          const y = Math.round((m.y * window.innerHeight) + ((m.scrollY || 0) - window.scrollY));
          const target = document.elementFromPoint(x - window.scrollX, y - window.scrollY);
          console.log('[content] fallback elementFromPoint target:', target);
          if (target) {
            try {
              if (target.dataset) target.dataset.__synced_ignore = '1';
              setTimeout(() => { try { if (target.dataset) delete target.dataset.__synced_ignore; } catch (e) {} }, 1000);

              // override modals for fallback click as well
              overrideModals();
              setTimeout(restoreModals, 1600);

              target.click();
              console.log('[content] fallback clicked elementFromPoint');
            } catch (e) {
              console.warn('[content] fallback click failed', e);
            }
          }
        }
      }
    } else if (payload.type === 'input') {
      const selector = payload.data && payload.data.selector;
      const val = payload.data && payload.data.value;
      const sel = payload.data && payload.data.selection || {};
      const tag = payload.data && payload.data.tag;
      let el = null;
      if (selector) {
        try { el = document.querySelector(selector); } catch (e) {}
      }
      if (!el && typeof payload.data.centerX === 'number') {
        const comp = { tag, centerX: payload.data.centerX, centerY: payload.data.centerY };
        el = findElementForDescriptor(comp);
      }
      if (el) {
        try {
          if (el.isContentEditable) {
            el.innerText = val;
          } else if ('value' in el) {
            el.value = val;
          }
          if (el.setSelectionRange && sel.start != null && sel.end != null) {
            try { el.setSelectionRange(sel.start, sel.end); } catch (err) {}
          }
          try {
            const ev = new Event('input', { bubbles: true });
            el.dispatchEvent(ev);
          } catch (err) {}
        } catch (err) {
          console.warn('[content] input apply error', err);
        }
      }
    } else if (payload.type === 'open_tab') {
      // no-op in content script; background handles tab creation
    } else if (payload.type === 'navigate') {
      const url = payload.data && payload.data.url;
      if (url && url !== location.href) {
        try { window.location.href = url; } catch (e) {}
      }
    }
  });

  // End of content script IIFE
})();