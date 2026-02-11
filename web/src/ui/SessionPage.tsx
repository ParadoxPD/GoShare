import { useState } from "react";
import { useSessionStore } from "../state/sessionStore";
import { createWebSocket } from "../core/signaling";
import { createPeer } from "../core/webrtc";

export default function SessionPage() {
  const [code, setCode] = useState("");
  const set = useSessionStore((s) => s.set);
  const connected = useSessionStore((s) => s.connected);

  const startSender = async () => {
    const ws = createWebSocket(() => {
      ws.send(JSON.stringify({ type: "create_session" }));
    });

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === "code") {
        set({ sessionCode: msg.code, ws, role: "sender" });
        await createPeer(true);
      }

      if (msg.type === "webrtc_signal" || msg.type === "receiver_joined") {
        // handled in signaling.ts
      }
    };
  };

  const join = async () => {
    const ws = createWebSocket(() => {
      ws.send(JSON.stringify({ type: "join", code }));
    });

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === "joined") {
        set({ ws, role: "receiver", peerId: msg.fromId });
        await createPeer(false);
      }

      if (msg.type === "webrtc_signal") {
        // handled in signaling.ts
      }
    };
  };

  return (
    <div style={{ padding: 40 }}>
      <h2>P2P Session</h2>

      <button onClick={startSender}>Create Session</button>

      <div style={{ marginTop: 20 }}>
        <input
          placeholder="Enter code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button onClick={join}>Join</button>
      </div>

      {connected && <h3>✅ WebRTC Connected</h3>}
    </div>
  );
}

