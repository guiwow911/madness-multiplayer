'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const WebSocket = require('ws');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 5;
const PVP_WEAPONS = new Set([
  'glock20', 'beretta', 'deagle', 'mp7', 'mp5',
  'ak74', 'ak74u', 'm16', 'spas12', 'dragonsword'
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.swf': 'application/x-shockwave-flash',
  '.svg': 'image/svg+xml'
};

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function cleanRoom(value, fallback) {
  return String(value || fallback).trim().toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '').slice(0, 20) || fallback;
}

function cleanName(value) {
  return String(value || 'Player').trim()
    .replace(/[|\r\n]/g, '').slice(0, 20) || 'Player';
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://' + (req.headers.host || 'localhost')).pathname;
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  let requested;
  try {
    requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  const filePath = path.resolve(PUBLIC_DIR, '.' + requested);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
});

// One upgrade listener routes each WebSocket path to exactly one server.
// This prevents two WebSocketServer instances from racing on the same
// HTTP server upgrade event and rejecting each other's paths.
const gameWss = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 16 * 1024
});
const signalWss = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 64 * 1024
});

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://' + (req.headers.host || 'localhost')).pathname;
  } catch {
    socket.destroy();
    return;
  }

  const target = pathname === '/ws' ? gameWss
    : pathname === '/signal' ? signalWss
    : null;

  if (!target) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  target.handleUpgrade(req, socket, head, (ws) => {
    target.emit('connection', ws, req);
  });
});

// Game rooms: /ws
const gameRooms = new Map();

function gameRoster(room) {
  return [...room.players.values()].map(({ id, name, role }) => ({ id, name, role }));
}

function broadcastGameRoster(room) {
  const players = gameRoster(room);
  for (const peer of room.players.values()) {
    send(peer.socket, { type: 'roster', players, started: room.started });
  }
}

function leaveGame(peer) {
  if (!peer.room) return;
  const room = peer.room;
  room.players.delete(peer.id);
  peer.room = null;

  for (const other of room.players.values()) {
    send(other.socket, { type: 'leave', id: peer.id });
  }

  if (room.players.size === 0) {
    gameRooms.delete(room.name);
    return;
  }

  if (room.started) {
    room.started = false;
    for (const other of room.players.values()) {
      send(other.socket, {
        type: 'arena-reset',
        reason: 'A player left; the remaining player is now host.'
      });
    }
  }

  const first = room.players.values().next().value;
  if (first) first.role = 'host';
  broadcastGameRoster(room);
}

gameWss.on('connection', (socket) => {
  const peer = {
    id: crypto.randomBytes(5).toString('hex'),
    socket,
    room: null,
    name: 'Player',
    role: 'guest',
    lastStateAt: 0,
    lastHitAt: 0
  };

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'ping') {
      send(socket, { type: 'pong' });
      return;
    }

    if (message.type === 'join') {
      if (peer.room) return;

      const roomName = cleanRoom(message.room, 'LOCAL');
      let room = gameRooms.get(roomName);
      if (!room) {
        room = { name: roomName, players: new Map(), started: false };
        gameRooms.set(roomName, room);
      }

      if (room.players.size >= MAX_PLAYERS) {
        send(socket, { type: 'error', message: '这个房间已满（每房间最多 5 人）。' });
        socket.close(1008, 'Room full');
        return;
      }

      peer.name = cleanName(message.name);
      peer.room = room;
      peer.role = room.players.size === 0 ? 'host' : 'guest';
      room.players.set(peer.id, peer);

      send(socket, {
        type: 'welcome',
        id: peer.id,
        role: peer.role,
        room: room.name
      });
      broadcastGameRoster(room);
      if (room.started) send(socket, { type: 'start', role: peer.role });
      return;
    }

    if (!peer.room) return;
    const room = peer.room;

    if (message.type === 'start') {
      if (peer.role !== 'host') {
        send(socket, { type: 'error', message: '只有房主可以开始。' });
        return;
      }
      if (room.players.size < 2) {
        send(socket, { type: 'error', message: '先让另一位玩家加入同一房间。' });
        return;
      }

      room.started = true;
      for (const player of room.players.values()) {
        send(player.socket, { type: 'start', role: player.role, mode: 'pvp' });
      }
      broadcastGameRoster(room);
      return;
    }

    if (message.type === 'hit' && room.started) {
      const now = Date.now();
      if (now - peer.lastHitAt < 2) return;
      peer.lastHitAt = now;

      const weapon = String(message.weapon || 'glock20').toLowerCase();
      if (!PVP_WEAPONS.has(weapon)) return;

      const packet = {
        type: 'hit',
        weapon,
        head: message.head === 1 || message.head === true
      };
      for (const other of room.players.values()) {
        if (other !== peer) send(other.socket, packet);
      }
      return;
    }

    if (message.type === 'state' && room.started) {
      const now = Date.now();
      if (now - peer.lastStateAt < 10) return;
      peer.lastStateAt = now;

      const state = message.state || {};
      const x = Number(state.x);
      const y = Number(state.y);
      const scale = Number(state.scale);
      const frame = Number(state.frame);
      const clipFrame = Number(state.clipFrame);
      if (![x, y, scale, frame, clipFrame].every(Number.isFinite)) return;

      const primary = String(state.primaryWeapon || '').toLowerCase();
      const secondary = String(state.secondaryWeapon || '').toLowerCase();
      const packet = {
        type: 'state',
        id: peer.id,
        x: Math.max(-2000, Math.min(5000, x)),
        y: Math.max(-2000, Math.min(5000, y)),
        scale: Math.max(-500, Math.min(500, scale)),
        frame: Math.max(1, Math.min(5000, Math.round(frame))),
        clipFrame: Math.max(1, Math.min(5000, Math.round(clipFrame))),
        facing: state.facing === 'left' ? 'left' : 'right',
        status: String(state.status || '').slice(0, 32).replace(/[|\r\n]/g, ''),
        subStatus: String(state.subStatus || '').slice(0, 32).replace(/[|\r\n]/g, ''),
        activeWeapon: Number(state.activeWeapon) === 1 ? 1 : 0,
        primaryWeapon: PVP_WEAPONS.has(primary) ? primary : 'glock20',
        secondaryWeapon: PVP_WEAPONS.has(secondary) ? secondary : 'mp7'
      };

      for (const other of room.players.values()) {
        if (other !== peer) send(other.socket, packet);
      }
    }
  });

  socket.on('close', () => leaveGame(peer));
  socket.on('error', () => leaveGame(peer));
});

// P2P signaling rooms: /signal
const signalRooms = new Map();

function signalRoster(room) {
  return [...room.players.values()].map(({ id, name, role }) => ({ id, name, role }));
}

function broadcastSignalRoster(room) {
  const players = signalRoster(room);
  for (const peer of room.players.values()) {
    send(peer.socket, { type: 'roster', players });
  }
}

function leaveSignal(peer) {
  if (!peer.room) return;
  const room = peer.room;
  room.players.delete(peer.id);
  peer.room = null;

  if (room.players.size === 0) {
    signalRooms.delete(room.name);
    return;
  }

  if (![...room.players.values()].some((player) => player.role === 'host')) {
    const first = room.players.values().next().value;
    if (first) first.role = 'host';
  }
  broadcastSignalRoster(room);
}

signalWss.on('connection', (socket) => {
  const peer = {
    id: crypto.randomBytes(8).toString('hex'),
    socket,
    room: null,
    name: 'Player',
    role: 'guest'
  };

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'join') {
      if (peer.room) return;

      const roomName = cleanRoom(message.room, 'MADNESS');
      let room = signalRooms.get(roomName);
      if (!room) {
        room = { name: roomName, players: new Map() };
        signalRooms.set(roomName, room);
      }

      if (room.players.size >= MAX_PLAYERS) {
        send(socket, { type: 'error', message: '房间已满，每个房间最多 5 人。' });
        socket.close(1008, 'Room full');
        return;
      }

      peer.name = cleanName(message.name);
      peer.room = room;
      peer.role = room.players.size === 0 ? 'host' : 'guest';
      room.players.set(peer.id, peer);

      send(socket, {
        type: 'welcome',
        id: peer.id,
        role: peer.role,
        room: room.name
      });
      broadcastSignalRoster(room);
      return;
    }

    if (!peer.room) return;
    if (message.type === 'signal') {
      const target = peer.room.players.get(String(message.to || ''));
      if (!target || target === peer || !message.data || typeof message.data !== 'object') return;
      send(target.socket, {
        type: 'signal',
        from: peer.id,
        data: message.data
      });
    }
  });

  socket.on('close', () => leaveSignal(peer));
  socket.on('error', () => leaveSignal(peer));
});

// Heartbeat for game sockets.
const heartbeat = setInterval(() => {
  for (const socket of gameWss.clients) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 15000);
heartbeat.unref();

gameWss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });
});

server.listen(PORT, HOST, () => {
  console.log('网页服务已启动: http://localhost:' + PORT);
  console.log('游戏 WebSocket: /ws');
  console.log('P2P 信令 WebSocket: /signal');
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const info of entries || []) {
      if (info.family === 'IPv4' && !info.internal) {
        console.log('  http://' + info.address + ':' + PORT + ' (' + name + ')');
      }
    }
  }
});

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of gameWss.clients) socket.close(1001, 'Server stopped');
  for (const socket of signalWss.clients) socket.close(1001, 'Server stopped');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
