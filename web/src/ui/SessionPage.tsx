import { useState } from "react";
import { connectWS } from "../core/signaling";
import { useStore } from "../state/store";
import { encrypt, decrypt } from "../core/crypto";

const CHUNK = 256 * 1024;

export default function Session() {
  const [codeInput, setCodeInput] = useState("");
  const { ws, data, code } = useStore();

  const start = () => {
    const ws = connectWS();
    ws.onopen = () => ws.send(JSON.stringify({ type: "create_session" }));
  };

  const join = () => {
    const ws = connectWS();
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: "join", code: codeInput }));
  };

  const sendFile = async (file: File) => {
    if (!data) return;

    const total = Math.ceil(file.size / CHUNK);

    data.send(JSON.stringify({ type: "metadata", name: file.name, total }));

    for (let i = 0; i < total; i++) {
      const slice = await file
        .slice(i * CHUNK, (i + 1) * CHUNK)
        .arrayBuffer();
      const enc = await encrypt(slice, "secretkey123");
      data.send(JSON.stringify({ type: "chunk", index: i, content: enc }));
    }

    data.send(JSON.stringify({ type: "done" }));
  };

  return (
    <div style={{ padding: 40 }}>
      <h2>GoShare P2P</h2>

      {!code && (
        <>
          <button onClick={start}>Create Session</button>
          <div>
            <input
              placeholder="Code"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
            />
            <button onClick={join}>Join</button>
          </div>
        </>
      )}

      {code && <h3>Code: {code}</h3>}

      {data && (
        <input
          type="file"
          onChange={(e) => e.target.files && sendFile(e.target.files[0])}
        />
      )}
    </div>
  );
}

