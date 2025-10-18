// Robust background service worker with reconnect & safe tab messaging
let ws = null;
let clientId = null;
let currentRoom = null;
let serverUrl = null;
let roomKey = null;

let reconnectDelay = 1000; // start 1s
const RECONNECT_MAX = 30000; // max 30s
let reconnectTimer = null;
const OUTGOING_QUEUE = [];

// safe console wrapper
function log(...args) { console.log('[bg]', ...args); }

function safeSendToTabs(message) {
  // forward events to content scripts; ignore tabs without content script
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (!t.id) continue;
      chrome.tabs.sendMessage(t.id, message, () => {
        if (chrome.runtime.lastError) {
          // Most likely the tab doesn't have the content script active — ignore
          // Uncomment the next line for debug: log('sendMessage error (ignored):', chrome.runtime.lastError.message);
        }
      });
    }
  });
}

function flushQueue() {
  while (OUTGOING_QUEUE.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
    const payload = OUTGOING_QUEUE.shift();
    try { ws.send(JSON.stringify({ type: 'event', payload })); } catch (e) { /* if it fails, push back and break */ OUTGOING_QUEUE.unshift(payload); break; }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(RECONNECT_MAX, reconnectDelay * 1.8);
    log('reconnecting, delay now', reconnectDelay);
    connect();
  }, reconnectDelay);
}

function connect() {
  chrome.storage.local.get(['serverUrl', 'roomId', 'roomKey'], (res) => {
    if (!res.serverUrl || !res.roomId) {
      log('serverUrl or roomId not set');
      return;
    }
    serverUrl = res.serverUrl;
    currentRoom = res.roomId;
    roomKey = res.roomKey || null;

    // Close existing socket first
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }

    try {
      ws = new WebSocket(serverUrl);
    } catch (err) {
      log('ws construction error', err);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      reconnectDelay = 1000; // reset backoff on success
      log('ws open, joining', currentRoom);
      clientId = Math.random().toString(36).slice(2, 10);
      try {
        ws.send(JSON.stringify({ type: 'join', room: currentRoom, clientId, roomKey }));
      } catch (err) { log('send join err', err); }
      flushQueue();
    });

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'joined') {
          log('joined as', msg.clientId);
          clientId = msg.clientId;
          return;
        }
        if (msg.type === 'error') {
          console.warn('server error', msg.reason);
          return;
        }
        if (msg.type === 'event') {
          const from = msg.from;
          const payload = msg.payload || {};
          // If payload instructs to open a new tab, create the tab here (background)
          if (payload && payload.type === 'open_tab' && payload.url) {
            try { chrome.tabs.create({ url: payload.url }, () => {}); } catch (err) { log('failed to create tab', err); }
          }
          // Forward to content scripts safely
          safeSendToTabs({ type: 'sync-event', from, payload });
        }
      } catch (e) { log('msg parse err', e); }
    });

    ws.addEventListener('error', (e) => {
      log('ws error', e);
      // Allow close handler to schedule reconnect
    });

    ws.addEventListener('close', () => {
      log('ws closed');
      scheduleReconnect();
    });
  });
}

// handle outgoing messages from content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'connect') { 
    // manual connect from popup
    connect();
    sendResponse({ok:true});
    return;
  }
  if (msg && msg.type === 'outgoing') {
    // queue if not open
    const payload = msg.payload;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'event', payload }));
      } catch (err) {
        // fallback to queue
        OUTGOING_QUEUE.push(payload);
      }
    } else {
      OUTGOING_QUEUE.push(payload);
      // optionally trigger connect if ws is null
      if (!ws) connect();
    }
    sendResponse({ok:true});
    return;
  }
});

// ensure we attempt to connect when service worker starts
connect();