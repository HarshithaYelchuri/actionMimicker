document.addEventListener('DOMContentLoaded', () => {
  const serverInput = document.getElementById('server');
  const roomInput = document.getElementById('room');
  const roomKeyInput = document.getElementById('roomKey');
  const status = document.getElementById('status');
  const btn = document.getElementById('connect');

  chrome.storage.local.get(['serverUrl', 'roomId', 'roomKey'], (res) => {
    if (res.serverUrl) serverInput.value = res.serverUrl;
    if (res.roomId) roomInput.value = res.roomId;
    if (res.roomKey) roomKeyInput.value = res.roomKey;
  });

  btn.onclick = () => {
    const serverUrl = serverInput.value.trim();
    const roomId = roomInput.value.trim();
    const roomKey = roomKeyInput.value.trim() || null;
    if (!serverUrl || !roomId) { status.textContent = 'Enter server URL and room ID'; return; }
    chrome.storage.local.set({ serverUrl, roomId, roomKey }, () => {
      status.textContent = 'Saved. Connecting...';
      chrome.runtime.sendMessage({ type: 'connect' }, () => {});
      setTimeout(() => status.textContent = 'Connected (check console for errors)', 1000);
    });
  };
});