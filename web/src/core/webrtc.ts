import { useSessionStore } from "../state/sessionStore";

export async function createPeer(isSender: boolean) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  const store = useSessionStore.getState();
  const set = store.set;

  let control: RTCDataChannel;
  let data: RTCDataChannel;

  if (isSender) {
    control = pc.createDataChannel("control", { ordered: true });
    data = pc.createDataChannel("data", {
      ordered: false,
      maxRetransmits: 0,
    });

    setupChannels(control, data);
  } else {
    pc.ondatachannel = (e) => {
      if (e.channel.label === "control") control = e.channel;
      if (e.channel.label === "data") data = e.channel;
      setupChannels(control, data);
    };
  }

  // ICE candidates → send to peer
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      store.ws?.send(
        JSON.stringify({
          type: "webrtc_signal",
          signal: { candidate: e.candidate },
          targetId: store.peerId,
        }),
      );
    }
  };

  set({ peer: pc });
  return pc;
}

function setupChannels(control: RTCDataChannel, data: RTCDataChannel) {
  const set = useSessionStore.getState().set;

  control.onopen = () => {
    console.log("control open");
    set({ control });
  };

  data.onopen = () => {
    console.log("data open");
    set({ data, connected: true });
  };
}

// ─────────────────────────────────────────────
// OFFER / ANSWER HANDLERS
// ─────────────────────────────────────────────

export async function createOffer(targetId: string) {
  const store = useSessionStore.getState();
  const pc = store.peer!;
  const ws = store.ws!;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  ws.send(
    JSON.stringify({
      type: "webrtc_signal",
      signal: { sdp: offer },
      targetId,
    }),
  );
}

export async function handleSignal(msg: any) {
  const store = useSessionStore.getState();
  const pc = store.peer!;

  if (msg.signal.sdp) {
    const desc = new RTCSessionDescription(msg.signal.sdp);

    if (desc.type === "offer") {
      await pc.setRemoteDescription(desc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      store.ws?.send(
        JSON.stringify({
          type: "webrtc_signal",
          signal: { sdp: answer },
          targetId: msg.fromId,
        }),
      );
    }

    if (desc.type === "answer") {
      await pc.setRemoteDescription(desc);
    }
  }

  if (msg.signal.candidate) {
    await pc.addIceCandidate(msg.signal.candidate);
  }
}
