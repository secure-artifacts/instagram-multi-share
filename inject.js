/**
 * inject.js - 运行在 MAIN world（页面上下文）
 * 功能：拦截 getDisplayMedia，管理 WebRTC 流中继
 */
(function () {
  'use strict';

  const PREFIX = 'MMS_';
  const log = (...args) => console.log('[MMS-inject]', ...args);

  // ---- 状态 ----
  let role = null;            // 'source' | 'receiver' | null
  let capturedStream = null;  // 源标签页捕获的 MediaStream
  let receivedStream = null;  // 接收标签页通过 WebRTC 收到的 MediaStream
  const deliveredStreams = new Set();
  const peerConnections = new Map(); // remoteTabId -> RTCPeerConnection
  const iceCandidateBuffers = new Map(); // remoteTabId -> candidates[]

  // ---- 保存原始 API ----
  const _getDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(
    navigator.mediaDevices
  );

  // ---- 重写 getDisplayMedia ----
  navigator.mediaDevices.getDisplayMedia = async function (constraints) {
    // 接收端：返回 WebRTC 收到的流（如果流还没到，等最多 15 秒）
    if (role === 'receiver') {
      if (!receivedStream || !receivedStream.active) {
        log('接收端：WebRTC 流尚未到达，等待中...');
        await new Promise((resolve) => {
          let elapsed = 0;
          const interval = setInterval(() => {
            elapsed += 200;
            if ((receivedStream && receivedStream.active) || elapsed >= 15000) {
              clearInterval(interval);
              resolve();
            }
          }, 200);
        });
      }

      if (receivedStream && receivedStream.active) {
        log('接收端：✅ 返回 WebRTC 流，跳过选择弹窗');
        // 直接返回原始流（不 clone），这样 STOP_SHARING 停止 track 后 Messenger 能立即感知
        log('receiver share consumed, tracks=', receivedStream.getTracks().map((t) => `${t.kind}:${t.readyState}`));
        post('RECEIVER_SHARE_CONSUMED');
        return makeDeliveredClone(receivedStream);
      }

      log('接收端：❌ WebRTC 流超时，调用原始 API');
      log('receiver share timeout, role=', role);
      post('RECEIVER_SHARE_TIMEOUT');
      return _getDisplayMedia(constraints);
    }

    // 源端：正常弹窗选择，然后缓存流
    if (role === 'source') {
      log('源端：弹窗选择共享窗口');
      const stream = await _getDisplayMedia(constraints);
      log('source getDisplayMedia resolved, tracks=', stream.getTracks().map((t) => `${t.kind}:${t.readyState}`));
      capturedStream = stream;

      // 监听流结束（仅当 role 仍为 source 时才通知，防止手动 STOP_SHARING 后的延迟事件）
      stream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (role !== 'source') {
            log('源流 ended 事件到达，但 role 已非 source，忽略');
            return;
          }
          log('源流已自然结束');
          post('SOURCE_STREAM_ENDED');
        });
      });

      post('SOURCE_STREAM_READY');
      post('SOURCE_SHARE_CONSUMED');
      return makeDeliveredClone(stream);
    }

    // 未激活状态：正常调用
    return _getDisplayMedia(constraints);
  };

  // ---- WebRTC ----
  function createPC(remoteTabId) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    peerConnections.set(remoteTabId, pc);
    iceCandidateBuffers.set(remoteTabId, []);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        post('SIGNAL_OUT', {
          targetTabId: remoteTabId,
          signal: { type: 'candidate', candidate: e.candidate.toJSON() },
        });
      }
    };

    pc.ontrack = (e) => {
      log('收到远端视频轨道');
      receivedStream = e.streams[0] || new MediaStream([e.track]);
      log('receiver ontrack assigned stream, remoteTabId=', remoteTabId, 'tracks=', receivedStream.getTracks().map((t) => `${t.kind}:${t.readyState}`));
      post('RECEIVER_STREAM_READY');
    };

    pc.onconnectionstatechange = () => {
      log(`与 tab ${remoteTabId} 连接状态: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        post('CONNECTION_FAILED', { remoteTabId });
        // 接收端：源断开后主动停止流，让 Messenger 感知到共享结束
        if (role === 'receiver' && receivedStream) {
          log('接收端：源连接断开，主动停止接收流');
          receivedStream.getTracks().forEach((t) => t.stop());
        }
      }
    };

    return pc;
  }

  async function flushIceCandidates(remoteTabId) {
    const pc = peerConnections.get(remoteTabId);
    const buf = iceCandidateBuffers.get(remoteTabId);
    if (!pc || !buf) return;
    for (const c of buf) {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    }
    iceCandidateBuffers.set(remoteTabId, []);
  }

  // ---- 消息处理 ----
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data?.type?.startsWith(PREFIX)) return;
    const type = e.data.type.slice(PREFIX.length);
    const data = e.data.data || {};

    switch (type) {
      case 'SET_ROLE':
        role = data.role;
        log('角色设置为:', role);
        break;

      case 'CREATE_OFFER': {
        const { targetTabId } = data;
        log(`创建 offer → tab ${targetTabId}`);
        const pc = createPC(targetTabId);
        if (capturedStream) {
          capturedStream.getTracks().forEach((t) => pc.addTrack(t, capturedStream));
        } else {
          log('⚠️ capturedStream 为空！');
        }
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        post('SIGNAL_OUT', {
          targetTabId,
          signal: { type: 'offer', sdp: pc.localDescription.sdp },
        });
        break;
      }

      case 'HANDLE_SIGNAL': {
        const { fromTabId, signal } = data;

        if (signal.type === 'offer') {
          log(`收到 offer ← tab ${fromTabId}`);
          const pc = createPC(fromTabId);
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
          await flushIceCandidates(fromTabId);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          post('SIGNAL_OUT', {
            targetTabId: fromTabId,
            signal: { type: 'answer', sdp: pc.localDescription.sdp },
          });
        } else if (signal.type === 'answer') {
          log(`收到 answer ← tab ${fromTabId}`);
          const pc = peerConnections.get(fromTabId);
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
            await flushIceCandidates(fromTabId);
          }
        } else if (signal.type === 'candidate') {
          const pc = peerConnections.get(fromTabId);
          if (pc && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } else {
            const buf = iceCandidateBuffers.get(fromTabId) || [];
            buf.push(signal.candidate);
            iceCandidateBuffers.set(fromTabId, buf);
          }
        }
        break;
      }

      case 'STOP_SHARING': {
        // 停止所有 stream tracks，Messenger 会自动检测到流结束并停止共享
        if (capturedStream) {
          capturedStream.getTracks().forEach((t) => { log('停止源 track:', t.kind); t.stop(); });
        }
        if (receivedStream) {
          receivedStream.getTracks().forEach((t) => { log('停止接收 track:', t.kind); t.stop(); });
        }
        stopDeliveredStreams();
        peerConnections.forEach((pc) => pc.close());
        peerConnections.clear();
        iceCandidateBuffers.clear();
        capturedStream = null;
        receivedStream = null;
        role = null;
        log('已清理，所有流和 WebRTC 连接已关闭');
        break;
      }
    }
  });

  // ---- 工具函数 ----
  function makeDeliveredClone(stream) {
    const clone = stream.clone();
    deliveredStreams.add(clone);
    clone.addEventListener('inactive', () => deliveredStreams.delete(clone), { once: true });
    clone.getTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (clone.getTracks().every((t) => t.readyState === 'ended')) {
          deliveredStreams.delete(clone);
        }
      }, { once: true });
    });
    return clone;
  }

  function stopDeliveredStreams() {
    deliveredStreams.forEach((stream) => {
      try {
        stream.getTracks().forEach((t) => {
          log('stop delivered track:', t.kind);
          t.stop();
        });
      } catch (e) {
        log('stop delivered stream failed:', e.message);
      }
    });
    deliveredStreams.clear();
  }

  function post(type, data) {
    window.postMessage({ type: PREFIX + type, data }, '*');
  }

  log('已加载');
})();
