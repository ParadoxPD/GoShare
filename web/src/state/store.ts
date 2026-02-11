import { create } from "zustand";

type Store = {
  ws?: WebSocket;
  pc?: RTCPeerConnection;
  control?: RTCDataChannel;
  data?: RTCDataChannel;

  role?: "sender" | "receiver";
  code?: string;
  peerId?: string;

  set: (v: Partial<Store>) => void;
};

export const useStore = create<Store>((set) => ({
  set: (v) => set(v),
}));
