```text
Sync Input Browser Extension — improved standby MVP
--------------------------------------------------

What this version adds:
- Robust element selectors (id, data attributes, generated CSS selectors).
- Sends element metadata (text snippet, normalized center coordinates) for heuristic matching.
- Mirrors clicks by finding and clicking the same element on peers.
- Tries to open tabs on peers when links/new tabs are opened (captures link clicks, window.open).
- Works across the open internet via a central WebSocket relay server (use wss:// or reverse proxy for production).
- Requires explicit consent: all participants install the extension and join the same room.

Limitations:
- Browser-page-level interactions only. Cannot move OS cursor or control other apps.
- Best results when pages are similar. Heuristics try to match when DOMs differ.
- For production: use TLS (wss://), auth tokens, rate limiting, and consider WebRTC for P2P.

Quick dev setup:
1) Start the server:
   - cd server
   - npm install
   - node server.js

2) Load the extension into Chrome:
   - chrome://extensions -> Developer mode -> Load unpacked -> select "extension" folder

3) Connect on each laptop:
   - Open extension popup -> enter ws://<server-host>:3000 (or wss://...) and same room ID -> Connect

4) Use:
   - Move mouse, type in inputs, click buttons, open links -> peers in same room see the actions (page-level).
```