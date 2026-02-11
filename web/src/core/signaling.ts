import { initPeer } from "./webrtc";
import { useStore } from "../state/store";

export function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  const set = useStore.getState().set;

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "code") {
      set({ code: msg.code });
      await initPeer(true);
    }

    if (msg.type === "joined") {
      set({ peerId: msg.fromId });
      await initPeer(false);
    }

    if (msg.type === "receiver_joined") {
      const pc = useStore.getState().pc!;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      ws.send(
        JSON.stringify({
          type: "webrtc_signal",
          signal: { sdp: offer },
          targetId: msg.targetId,
        }),
      );
    }

    if (msg.type === "webrtc_signal") {
      const pc = useStore.getState().pc!;
      if (msg.signal.sdp) {
        const desc = new RTCSessionDescription(msg.signal.sdp);
        if (desc.type === "offer") {
          await pc.setRemoteDescription(desc);
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          ws.send(
            JSON.stringify({
              type: "webrtc_signal",
              signal: { sdp: ans },
              targetId: msg.fromId,
            }),
          );
        } else {
          await pc.setRemoteDescription(desc);
        }
      }

      if (msg.signal.candidate) {
        await pc.addIceCandidate(msg.signal.candidate);
      }
    }
  };

  set({ ws });
  return ws;
}
