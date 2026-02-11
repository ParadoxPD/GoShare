import { encrypt, decrypt } from "./crypto";
import { useStore } from "../state/store";

import { putChunk, getChunk } from "./db";

const WINDOW = 128;
const CHUNK = 256 * 1024;

type SenderState = {
  file: File;
  sent: Set<number>;
  acked: Set<number>;
};

type ReceiverState = {
  chunks: Map<number, ArrayBuffer>;
  total: number;
  name: string;
};

const senders = new Map<string, SenderState>();
const receivers = new Map<string, ReceiverState>();

// ─────────────────────────────
// SENDER
// ─────────────────────────────
export async function sendFile(file: File) {
  const fileId = crypto.randomUUID();
  const total = Math.ceil(file.size / CHUNK);

  senders.set(fileId, {
    file,
    sent: new Set(),
    acked: new Set(),
  });

  control().send(
    JSON.stringify({
      t: "file_offer",
      fileId,
      name: file.name,
      size: file.size,
      total,
    }),
  );

  pump(fileId);
}

async function pump(fileId: string) {
  const state = senders.get(fileId)!;
  const total = Math.ceil(state.file.size / CHUNK);

  while (state.acked.size < total) {
    if (state.sent.size - state.acked.size > WINDOW) {
      await delay(10);
      continue;
    }

    const next = [...Array(total).keys()].find((i) => !state.sent.has(i));
    if (next === undefined) break;

    state.sent.add(next);
    sendChunk(fileId, next);
  }
}

async function sendChunk(fileId: string, index: number) {
  const state = senders.get(fileId)!;
  const start = index * CHUNK;
  const buf = await state.file.slice(start, start + CHUNK).arrayBuffer();
  const enc = await encrypt(buf, "secretkey123");

  data().send(JSON.stringify({ fileId, index, payload: enc }));
}

// ─────────────────────────────
// RECEIVER
// ─────────────────────────────
export async function handleControl(msg: any) {
  if (msg.t === "file_offer") {
    const have: number[] = [];

    for (let i = 0; i < msg.total; i++) {
      const exists = await getChunk(msg.fileId, i);
      if (exists) have.push(i);
    }

    receivers.set(msg.fileId, {
      chunks: new Map(),
      total: msg.total,
      name: msg.name,
    });

    control().send(
      JSON.stringify({
        t: "file_accept",
        fileId: msg.fileId,
        have,
      }),
    );
  }

  if (msg.t === "file_accept") {
    const s = senders.get(msg.fileId);
    msg.have.forEach((i: number) => s?.acked.add(i));
    pump(msg.fileId);
  }

  if (msg.t === "resume") {
    senders.forEach((_, fileId) => pump(fileId));
  }

  if (msg.t === "ack") {
    const s = senders.get(msg.fileId);
    msg.received.forEach((i: number) => s?.acked.add(i));
  }
}

export async function handleData(msg: any) {
  const r = receivers.get(msg.fileId);
  if (!r) return;

  const buf = await decrypt(msg.payload, "secretkey123");

  await putChunk(msg.fileId, msg.index, buf);
  r.chunks.set(msg.index, buf);

  control().send(
    JSON.stringify({
      t: "ack",
      fileId: msg.fileId,
      received: [msg.index],
    }),
  );

  if (r.chunks.size === r.total) assemble(msg.fileId);
}

function assemble(fileId: string) {
  const r = receivers.get(fileId)!;
  const ordered = [...Array(r.total).keys()].map((i) => r.chunks.get(i)!);

  const blob = new Blob(ordered);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = r.name;
  a.click();
}

// helpers
function control() {
  return useStore.getState().control!;
}
function data() {
  return useStore.getState().data!;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
