import { create } from "zustand";

type SessionState = {
  ws?: WebSocket;
  peer?: RTCPeerConnection;
  control?: RTCDataChannel;
  data?: RTCDataChannel;

  connected: boolean;
  role?: "sender" | "receiver";
  sessionCode?: string;
  peerId?: string;

  set: (p: Partial<SessionState>) => void;
};

export const useSessionStore = create<SessionState>((set) => ({
  connected: false,
  set: (p) => set(p),
}));
