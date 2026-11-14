(() => {
  const $ = (id) => document.getElementById(id);
  const queue = [];
  let socket = null;          // 局域网 WebSocket（仅 local 模式）
  let p2p = null;             // window.madnessP2P
  let mode = 'p2p';
  let currentId = null;
  let role = null;
  let started = false;
  let rxPackets = 0;
  let rxWindowAt = Date.now();
  let player;
  const peers = new Map();    // id -> {id,name,role}
  let pingTimer = null, pingPending = false, pingSentAt = 0;

  window.madnessPoll = function () {
    if (!queue.length) return '';
    return queue.splice(0, 64).join('\n');
  };

  window.madnessSendState = function (x, y, scale, frame, facing, status, subStatus, clipFrame, activeWeapon, primaryWeapon, secondaryWeapon) {
    if (!started) return;
    if (mode === 'p2p') {
      if (p2p) p2p.send({ type: 'state', state: { x, y, scale, frame, facing, status, subStatus, clipFrame, activeWeapon, primaryWeapon, secondaryWeapon } });
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'state', state: { x, y, scale, frame, facing, status, subStatus, clipFrame, activeWeapon, primaryWeapon, secondaryWeapon } }));
  };

  window.madnessSendPvpHit = function (weapon, head) {
    if (!started) return;
    if (mode === 'p2p') { if (p2p) p2p.send({ type: 'hit', weapon, head: head ? 1 : 0 }); return; }
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'hit', weapon, head: head ? 1 : 0 }));
  };

  function pushToSwf(message) {
    if (queue.length >= 600) {
      const stateAt = queue.findIndex((item) => item.startsWith('STATE|'));
      if (stateAt >= 0) queue.splice(stateAt, 1);
      else queue.shift();
    }
    queue.push(message);
  }

  function setStatus(text, kind = '') {
    $('lobbyStatus').textContent = text;
    $('lobbyStatus').className = `lobby-status ${kind}`;
  }

  function setConnection(online, text, error = false) {
    $('connectionDot').className = `dot ${online ? 'online' : error ? 'error' : ''}`;
    $('connectionText').textContent = text;
  }

  function updateRoster(players = []) {
    const me = players.find((peer) => peer.id === currentId);
    if (me) role = me.role;
    $('playerCount').textContent = `${players.length} / 5`;
    $('playerList').replaceChildren();
    if (!players.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '等待连接房间…';
      $('playerList').appendChild(empty);
    }
    for (const peer of players) {
      const row = document.createElement('div');
      row.className = 'player-row';
      const icon = document.createElement('span');
      icon.className = 'player-icon';
      icon.textContent = peer.role === 'host' ? 'H' : 'P';
      const name = document.createElement('span');
      name.textContent = peer.name;
      const label = document.createElement('span');
      label.className = 'role';
      label.textContent = peer.id === currentId ? '你 · ' + (peer.role === 'host' ? '房主' : '玩家') : peer.role === 'host' ? '房主' : '玩家';
      row.append(icon, name, label);
      $('playerList').appendChild(row);
    }
    const canStart = role === 'host' && players.length >= 2 && !started && connected();
    $('startButton').disabled = !canStart;
    $('startButton').textContent = started ? '已进入竞技场' : role === 'host' ? players.length >= 2 ? '开始多人竞技场' : '等待玩家加入（至少 2 人）' : '等待房主开始';
  }

  function connected() {
    if (mode === 'p2p') return !!(p2p && p2p.connected());
    return !!(socket && socket.readyState === WebSocket.OPEN && currentId);
  }

  function closeSocket() {
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
  }

  function applyStart(startRole) {
    started = true;
    $('primaryWeapon').disabled = true;
    $('secondaryWeapon').disabled = true;
    pushToSwf(`PVP|${$('primaryWeapon').value}|${$('secondaryWeapon').value}`);
    pushToSwf(`START|${startRole === 'host' ? '1' : '0'}`);
    $('reloadButton').hidden = false;
    $('startButton').disabled = true;
    $('startButton').textContent = '已进入竞技场';
    setStatus('PVP 单挑已开局：本地载入所选武器，命中事件与动作同步。', 'good');
  }

  function onGameMessage(event) {
    let message;
    if (typeof event === 'string') { try { message = JSON.parse(event); } catch (e) { return; } }
    else if (event && event.data) { try { message = JSON.parse(event.data); } catch (e) { return; } }
    else message = event;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'welcome') {
      currentId = message.id;
      role = message.role;
      $('roomInput').disabled = true;
      $('nameInput').disabled = true;
      setConnection(true, `已连接 · ${message.room} · ${role === 'host' ? '房主' : '玩家'}`);
      setStatus('连接成功；邀请朋友使用相同房间码加入，最多支持 5 人。', 'good');
    } else if (message.type === 'roster') {
      updateRoster(message.players || []);
      if (message.started && !started) setStatus('竞技场已启动。', 'good');
    } else if (message.type === 'start') {
      applyStart(message.role === 'host' ? 'host' : 'guest');
    } else if (message.type === 'ping') {
      if (mode === 'p2p') { if (p2p) p2p.send({ type: 'pong' }); }
      else if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'pong' }));
    } else if (message.type === 'pong') {
      if (pingPending) {
        pingPending = false;
        $('p2pLatency').textContent = `${Date.now() - pingSentAt} ms`;
      }
    } else if (message.type === 'state') {
      rxPackets++;
      const s = message;
      pushToSwf(`STATE|${s.id}|${s.x}|${s.y}|${s.scale}|${s.frame}|${s.facing}|${s.status || ''}|${s.subStatus || ''}|${s.clipFrame}|${s.activeWeapon}|${s.primaryWeapon}|${s.secondaryWeapon}`);
    } else if (message.type === 'hit') {
      pushToSwf(`HIT|${message.weapon}|${message.head ? '1' : '0'}`);
    } else if (message.type === 'leave') {
      pushToSwf(`LEAVE|${message.id}`);
      setStatus('另一位玩家已离开房间。', 'bad');
    } else if (message.type === 'arena-reset') {
      started = false;
      $('primaryWeapon').disabled = false;
      $('secondaryWeapon').disabled = false;
      $('reloadButton').hidden = true;
      setStatus(message.reason || '房间已重置。', 'bad');
    } else if (message.type === 'error') {
      setStatus(message.message || '连接错误。', 'bad');
      setConnection(false, '房间连接错误', true);
    }
  }

  function connectRoom() {
    mode = $('modeSelect').value || 'p2p';
    const room = $('roomInput').value || 'LOCAL';
    const name = $('nameInput').value || 'Player';
    closeSocket();
    if (mode === 'p2p' && p2p) p2p.disconnect();
    currentId = null; role = null; started = false; peers.clear();
    $('reloadButton').hidden = true;
    $('startButton').disabled = true;
    $('startButton').textContent = '连接中…';
    updateRoster([]);
    if (mode === 'p2p') {
      $('roomInput').disabled = false;
      $('nameInput').disabled = false;
      $('primaryWeapon').disabled = false;
      $('secondaryWeapon').disabled = false;
      $('copyRoomButton').hidden = false;
      $('p2pPanel').hidden = false;
      setConnection(false, 'P2P 信令连接中…');
      setStatus('正在通过公共信令服务器寻找同一房间码的玩家…');
      p2p.connect(room, name).catch((e) => {
        setStatus('P2P 连接失败：' + (e && e.message || e), 'bad');
        setConnection(false, 'P2P 连接失败', true);
      });
      return;
    }
    // local 模式
    $('copyRoomButton').hidden = true;
    $('p2pPanel').hidden = true;
    $('roomInput').disabled = false;
    $('nameInput').disabled = false;
    $('primaryWeapon').disabled = false;
    $('secondaryWeapon').disabled = false;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const endpoint = `${scheme}//${location.host}/ws`;
    setConnection(false, `连接 ${endpoint}`);
    setStatus('正在建立局域网连接…');
    socket = new WebSocket(endpoint);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'join', room, name }));
    });
    socket.addEventListener('message', onGameMessage);
    socket.addEventListener('close', () => {
      setConnection(false, '已断开', true);
      setStatus('WebSocket 已关闭；点击“连接 / 重连”再试。', 'bad');
      updateRoster([]);
    });
    socket.addEventListener('error', () => {
      setConnection(false, '无法连接本地服务器', true);
      setStatus('连不上服务器。请先运行 start.ps1，再刷新页面。', 'bad');
    });
  }

  function setupP2P() {
    p2p = window.madnessP2P;
    if (!p2p) { setStatus('P2P 模块加载失败，请刷新页面重试。', 'bad'); return; }
    p2p.onState((s, info) => {
      const txt = { idle: '未连接', signaling: '正在配对…', solo: '已开房，等待玩家', connected: '已直连', error: '出错' }[s] || s;
      const detail = s === 'connected' ? ` · 你是${(info.role || role) === 'host' ? '房主' : '玩家'}` : (s === 'solo' || s === 'signaling') && info && info.waiting ? ' · 等待对方输入相同房间码' : '';
      $('p2pState').textContent = txt + detail;
      if (s === 'error' && info && info.message) {
        setStatus(info.message, 'bad');
        setConnection(false, 'P2P 出错', true);
      }
      if (s === 'connected') {
        if (p2p.myId()) currentId = p2p.myId();
        role = p2p.role();
        setConnection(true, 'P2P Mesh 已连接（游戏数据点对点传输）');
        $('roomInput').disabled = true;
        $('nameInput').disabled = true;
        setStatus('P2P Mesh 已建立；房主可在至少 2 人加入后开始。', 'good');
        startPing();
      } else {
        stopPing();
      }
    });
    p2p.onMessage((m) => onGameMessage(m));
    p2p.onRoster((players) => updateRoster(players));
  }

  function startPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (!connected() || pingPending) return;
      pingPending = true;
      pingSentAt = Date.now();
      let ok;
      if (mode === 'p2p') ok = p2p.send({ type: 'ping' });
      else ok = !!(socket && socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'ping' })), true);
      if (!ok) pingPending = false;
      else setTimeout(() => { if (pingPending && connected()) { pingPending = false; $('p2pLatency').textContent = '超时'; } }, 3000);
    }, 4000);
  }
  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    pingPending = false;
    if (mode === 'p2p') $('p2pLatency').textContent = '-';
  }

  $('connectButton').addEventListener('click', connectRoom);
  $('modeSelect').addEventListener('change', () => {
    if (mode === 'p2p') { $('copyRoomButton').hidden = false; $('p2pPanel').hidden = false; }
    else { $('copyRoomButton').hidden = true; $('p2pPanel').hidden = true; }
    setStatus('已切换联机方式，点击“连接 / 重连”生效。');
    setConnection(false, '未连接');
  });
  $('copyRoomButton').addEventListener('click', () => {
    const code = $('roomInput').value || 'LOCAL';
    const invite = `暴力迪吧 P2P 联机邀请：打开 ${location.origin}${location.pathname}，房间码填：${code}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(invite).then(() => setStatus('邀请已复制：粘贴发给朋友即可。', 'good'));
    } else {
      window.prompt('复制以下内容发给朋友：', invite);
      setStatus('已弹出邀请文本。', 'good');
    }
  });
  $('startButton').addEventListener('click', () => {
    if (role !== 'host' || !connected()) return;
    if (mode === 'p2p') {
      if (p2p) p2p.send({ type: 'start', mode: 'pvp' });
      applyStart('host');
      return;
    }
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'start', mode: 'pvp' }));
  });
  $('reloadButton').addEventListener('click', () => location.reload());
  $('nameInput').value = `Player${String(Date.now()).slice(-6)}`;
  $('p2pPanel').hidden = false;

  // 兼容旧服务器消息（server.js 走 /ws）
  const originalOnMessage = onGameMessage;
  window.__onGameMessage = originalOnMessage;

  setInterval(() => {
    const now = Date.now();
    const elapsed = Math.max(1, now - rxWindowAt);
    $('packetRate').textContent = `${Math.round(rxPackets * 1000 / elapsed)} pkt/s`;
    rxPackets = 0;
    rxWindowAt = now;
  }, 1000);

  window.RufflePlayer = window.RufflePlayer || {};
  window.addEventListener('DOMContentLoaded', async () => {
    try {
      const ruffle = window.RufflePlayer.newest();
      player = ruffle.createPlayer();
      player.style.width = '100%';
      player.style.height = '100%';
      $('ruffleContainer').appendChild(player);
      await player.ruffle().load({ url: '/game.swf', autoplay: 'on', allowScriptAccess: true, frameRate: 60, letterbox: 'on' });
      $('fpsLabel').textContent = 'Ruffle · 60 FPS';
    } catch (error) {
      console.error(error);
      $('fpsLabel').textContent = 'Ruffle / SWF 加载失败';
      setStatus(`游戏加载失败：${error.message || error}`, 'bad');
    }
  }, { once: true });

  setupP2P();
  connectRoom();
})();
