import { handleSignal } from "./webrtc";

export function createWebSocket(onReady: () => void) {
  const ws = new WebSocket(`ws://${location.host}/ws`);

  ws.onopen = onReady;

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "webrtc_signal") {
      await handleSignal(msg);
    }

    if (msg.type === "receiver_joined") {
      // sender must create offer for this receiver
      const { createOffer } = await import("./webrtc");
      createOffer(msg.targetId);
    }
  };

  return ws;
}
