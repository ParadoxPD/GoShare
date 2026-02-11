import { useStore } from "../state/store";
import { handleControl, handleData } from "./transfer";

export async function initPeer(isSender: boolean) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  const set = useStore.getState().set;
  const ws = useStore.getState().ws!;

  let control: RTCDataChannel;
  let data: RTCDataChannel;

  if (isSender) {
    control = pc.createDataChannel("control");
    data = pc.createDataChannel("data", { ordered: false, maxRetransmits: 0 });
    setup(control, data);
  } else {
    pc.ondatachannel = (e) => {
      if (e.channel.label === "control") control = e.channel;
      if (e.channel.label === "data") data = e.channel;
      setup(control, data);
    };
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(
        JSON.stringify({
          type: "webrtc_signal",
          signal: { candidate: e.candidate },
          targetId: useStore.getState().peerId,
        }),
      );
    }
  };

  set({ pc });
  return pc;
}

function setup(control: RTCDataChannel, data: RTCDataChannel) {
  const set = useStore.getState().set;

  control.onopen = () => set({ control });
  data.onopen = () => control.send(JSON.stringify({ t: "resume" }));

  control.onmessage = (e) => {
    handleControl(JSON.parse(e.data));
  };

  data.onmessage = (e) => {
    handleData(JSON.parse(e.data));
  };
}
