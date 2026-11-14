(() => {
  const SIGNAL = 'wss://madness-multiplayer-production.up.railway.app/signal';
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
  let ws = null, id = null, role = null, room = null, name = null;
  const peers = new Map();
  let stateCb = () => {}, messageCb = () => {}, rosterCb = () => {};
  const emitState = (state, info = {}) => stateCb(state, info);
  const sendSignal = (data) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };
  const roster = new Map();

  function emitRoster() {
    rosterCb([...roster.values()]);
  }
  function closePeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    try { peer.channel?.close(); peer.pc?.close(); } catch {}
    peers.delete(peerId);
  }
  function closeAllPeers() {
    for (const peerId of [...peers.keys()]) closePeer(peerId);
  }
  function sendToPeer(peerId, message) {
    const peer = peers.get(peerId);
    if (!peer || peer.channel?.readyState !== 'open') return false;
    peer.channel.send(JSON.stringify(message));
    return true;
  }
  function broadcast(message) {
    let sent = false;
    for (const peerId of peers.keys()) sent = sendToPeer(peerId, message) || sent;
    return sent;
  }
  function bindChannel(peerId, channel) {
    const peer = peers.get(peerId);
    if (!peer) { channel.close(); return; }
    peer.channel = channel;
    channel.onopen = () => {
      peer.open = true;
      emitState('connected', { role, connectedPeers: [...peers.values()].filter(p => p.open).length });
    };
    channel.onclose = () => {
      peer.open = false;
      emitState('signaling', { role });
    };
    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message && message.type === 'state') message.id = peerId;
        messageCb(message);
      } catch {}
    };
  }
  function ensurePeer(remoteId) {
    if (!remoteId || remoteId === id || peers.has(remoteId)) return;
    const initiator = id < remoteId;
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const peer = { pc, channel: null, open: false, pendingCandidates: [] };
    peers.set(remoteId, peer);
    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: 'signal', to: remoteId, data: { candidate: event.candidate } });
    };
    pc.ondatachannel = (event) => bindChannel(remoteId, event.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') emitState('error', { message: '部分玩家的 WebRTC 连接失败。可尝试更换网络；严格 NAT 网络可能需要 TURN 中继。' });
      if (pc.connectionState === 'closed') closePeer(remoteId);
    };
    if (initiator) bindChannel(remoteId, pc.createDataChannel('madness-game', { ordered: true }));
    if (initiator) {
      pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
        sendSignal({ type: 'signal', to: remoteId, data: { description: pc.localDescription } });
      }).catch(() => emitState('error', { message: '创建 WebRTC offer 失败。' }));
    }
  }
  async function handleSignal(message) {
    if (message.type === 'roster') {
      const next = new Map((message.players || []).map(player => [player.id, player]));
      for (const remoteId of peers.keys()) if (!next.has(remoteId)) closePeer(remoteId);
      roster.clear();
      for (const [peerId, player] of next) roster.set(peerId, player);
      emitRoster();
      for (const remoteId of next.keys()) ensurePeer(remoteId);
      return;
    }
    if (message.type !== 'signal' || !message.from) return;
    ensurePeer(message.from);
    const peer = peers.get(message.from);
    if (!peer) return;
    const pc = peer.pc;
    if (message.data?.description) {
      await pc.setRemoteDescription(message.data.description);
      if (message.data.description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({ type: 'signal', to: message.from, data: { description: pc.localDescription } });
      }
      for (const candidate of peer.pendingCandidates.splice(0)) {
        try { await pc.addIceCandidate(candidate); } catch {}
      }
    }
    if (message.data?.candidate) {
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(message.data.candidate); } catch {}
      } else peer.pendingCandidates.push(message.data.candidate);
    }
  }

  window.madnessP2P = {
    connect(roomCode, playerName) {
      room = String(roomCode || 'MADNESS').trim().toUpperCase();
      name = String(playerName || 'Player').trim();
      closeAllPeers();
      roster.clear();
      emitState('signaling');
      return new Promise((resolve, reject) => {
        let settled = false;
        let connectionTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { ws.close(); } catch {}
          const error = new Error('连接 Railway 信令服务器超时（12 秒）。请检查 Railway 部署状态、域名和 /signal WebSocket 路径。');
          emitState('error', { message: error.message });
          reject(error);
        }, 12000);
        ws = new WebSocket(SIGNAL);
        ws.onopen = () => sendSignal({ type: 'join', room, name });
        ws.onmessage = async (event) => {
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === 'welcome') {
            id = message.id;
            role = message.role;
            emitState('solo', { waiting: true, role });
            if (!settled) { settled = true; clearTimeout(connectionTimer); resolve(); }
          } else if (message.type === 'error') {
            emitState('error', { message: message.message || '信令服务器错误。' });
            if (!settled) { settled = true; clearTimeout(connectionTimer); reject(new Error(message.message || '信令服务器错误')); }
          } else {
            try { await handleSignal(message); }
            catch (error) { emitState('error', { message: 'WebRTC 信令处理失败：' + error.message }); }
          }
        };
        ws.onerror = () => {
          emitState('error', { message: '无法连接 Railway 信令服务，请检查服务是否 Online。' });
          if (!settled) { settled = true; clearTimeout(connectionTimer); reject(new Error('无法连接 P2P 信令服务。目标地址：' + SIGNAL)); }
        };
        ws.onclose = (event) => {
          if (!settled) {
            settled = true;
            clearTimeout(connectionTimer);
            reject(new Error('信令连接在完成握手前关闭（代码 ' + event.code + '）：' + (event.reason || '服务器未返回欢迎消息')));
          }
          closeAllPeers();
          roster.clear();
          emitRoster();
          emitState('idle');
        };
      });
    },
    send(message) {
      if (!message || typeof message !== 'object') return false;
      return broadcast(message);
    },
    connected() { return peers.size > 0 && [...peers.values()].every(peer => peer.open); },
    roster() { return [...roster.values()]; },
    connectedCount() { return [...peers.values()].filter(peer => peer.open).length; },
    myId() { return id; },
    role() { return role; },
    disconnect() {
      closeAllPeers();
      roster.clear();
      ws?.close();
      ws = null;
      id = null;
      role = null;
    },
    onState(callback) { stateCb = callback; },
    onMessage(callback) { messageCb = callback; },
    onRoster(callback) { rosterCb = callback; }
  };
})();
