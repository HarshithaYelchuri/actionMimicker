/**
 * Simple WebSocket relay with optional per-room key.
 *
 * Messages (JSON) from clients:
 * - { type: "join", room: "room1", clientId: "abc", roomKey: "optional" }
 * - { type: "event", payload: {...} }  // server relays payload to other clients in same room
 *
 * Server will enforce a roomKey if first join sets it: subsequent joins must match
 * (simple protection to avoid accidental joins). This is NOT a secure auth mechanism.
 *
 * For production: run behind TLS (wss) or implement native TLS and authentication/JWT.
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const app = express();

app.use(express.static('public')); // optional status page if you add one

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map(); // roomName -> { sockets: Set(ws), key: optional string }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (err) { return; }

    if (msg.type === 'join' && typeof msg.room === 'string') {
      const room = msg.room;
      const clientId = msg.clientId || Math.random().toString(36).slice(2,10);
      const providedKey = msg.roomKey;

      if (!rooms.has(room)) {
        rooms.set(room, { sockets: new Set(), key: providedKey || null });
      } else {
        const roomObj = rooms.get(room);
        if (roomObj.key && providedKey !== roomObj.key) {
          // reject join - wrong key
          ws.send(JSON.stringify({ type: 'error', reason: 'room_key_mismatch' }));
          ws.close();
          return;
        }
        // if room has no key but a joining client provides one, we won't retroactively enforce it.
      }

      ws.room = room;
      ws.clientId = clientId;
      rooms.get(room).sockets.add(ws);
      ws.send(JSON.stringify({ type: 'joined', clientId }));
      console.log(`client ${clientId} joined room ${room}`);
      return;
    }

    if (msg.type === 'event' && ws.room) {
      const roomObj = rooms.get(ws.room);
      if (!roomObj) return;
      // attach from client id (server will add from to outgoing message)
      const outgoing = {
        type: 'event',
        from: ws.clientId,
        payload: msg.payload
      };
      const payloadStr = JSON.stringify(outgoing);
      for (const client of roomObj.sockets) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          try { client.send(payloadStr); } catch (e) { /* ignore send errors */ }
        }
      }
    }
  });

  ws.on('close', () => {
    if (ws.room && rooms.has(ws.room)) {
      const roomObj = rooms.get(ws.room);
      roomObj.sockets.delete(ws);
      if (roomObj.sockets.size === 0) rooms.delete(ws.room);
    }
  });
});

// heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sync relay listening on port ${PORT}`);
});