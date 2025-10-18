```text
Sync Input — Standby MVP

This repo contains:
- server/: simple Node.js WebSocket relay
- extension/: Chrome extension (Manifest V3) that syncs cursor overlay, clicks, typing, and opening tabs across consenting browsers in the same room.

Quick dev run (local):
1) Server
   - cd server
   - npm install
   - node server.js
   - default port: 3000

2) Chrome extension
   - chrome://extensions -> Developer mode -> Load unpacked -> select the "extension" folder
   - In the extension popup enter ws://<server-host>:3000 and a room id, click Connect

Important security notes
- Use TLS (wss://) and authentication for any public deployment.
- Enforce explicit consent: every participant must install and join the room.
- Consider replacing the relay with peer-to-peer WebRTC + TURN for performance & privacy.
```