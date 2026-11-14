(() => {
  const SIGNAL = 'wss://broker.madness-project.net/ws';
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
  let ws, pc, channel, id, role, room, name, stateCb = () => {}, messageCb = () => {}, rosterCb = () => {}, remoteId;
  const sendSignal = (data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const emitState = (s, info = {}) => stateCb(s, info);
  function closePeer() { try { channel?.close(); pc?.close(); } catch {} channel = pc = null; }
  function setupPeer(initiator) {
    closePeer(); pc = new RTCPeerConnection({ iceServers: ICE });
    pc.onicecandidate = e => { if (e.candidate) sendSignal({ type: 'signal', to: remoteId, data: { candidate: e.candidate } }); };
    pc.ondatachannel = e => bindChannel(e.channel);
    if (initiator) bindChannel(pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 }));
    pc.onconnectionstatechange = () => { if (pc?.connectionState === 'connected') emitState('connected', { role }); else if (['failed','closed'].includes(pc?.connectionState)) emitState('error', { message: 'P2P 直连失败；请确认双方网络允许 WebRTC。' }); };
  }
  function bindChannel(ch) {
    channel = ch; ch.onopen = () => emitState('connected', { role });
    ch.onmessage = e => { try { const m = JSON.parse(e.data); if (m.type === 'roster') rosterCb(m.players); else messageCb(m); } catch {} };
  }
  async function signaling(m) {
    if (m.type === 'paired') {
      remoteId = m.peer.id; role = m.role; id = m.id; setupPeer(role === 'host');
      if (role === 'host') { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); sendSignal({ type:'signal', to:remoteId, data:{ description:pc.localDescription } }); }
      emitState('signaling', { role });
    } else if (m.type === 'signal' && m.from === remoteId) {
      if (m.data.description) { await pc.setRemoteDescription(m.data.description); if (m.data.description.type === 'offer') { const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); sendSignal({ type:'signal', to:remoteId, data:{ description:pc.localDescription } }); } }
      if (m.data.candidate) try { await pc.addIceCandidate(m.data.candidate); } catch {}
    } else if (m.type === 'error') emitState('error', { message:m.message });
  }
  window.madnessP2P = {
    connect(r, n) { room = String(r || 'LOCAL').toUpperCase(); name = String(n || 'Player'); emitState('signaling'); return new Promise((resolve,reject) => {
      ws = new WebSocket(SIGNAL); ws.onopen = () => sendSignal({ type:'join', room, name });
      ws.onmessage = e => { let m; try { m=JSON.parse(e.data); } catch { return; } if (m.type==='welcome') { id=m.id; role=m.role; emitState('solo',{waiting:true,role}); resolve(); } else signaling(m).catch(reject); };
      ws.onerror = () => { emitState('error',{message:'无法连接 P2P 信令服务。'}); reject(new Error('无法连接 P2P 信令服务')); };
      ws.onclose = () => emitState('idle');
    }); },
    send(m) { if (channel?.readyState !== 'open') return false; channel.send(JSON.stringify(m)); return true; },
    connected() { return channel?.readyState === 'open'; }, myId() { return id; }, role() { return role; },
    disconnect() { closePeer(); ws?.close(); ws=null; }, onState(cb) { stateCb=cb; }, onMessage(cb) { messageCb=cb; }, onRoster(cb) { rosterCb=cb; }
  };
})();
