// ===================================
// GLOBAL STATE MANAGEMENT (ZUSTAND)
// ===================================

import { create } from "zustand";
import type {
  FileTransfer,
  Message,
  Role,
  Tab,
  ConnectionStatus,
} from "../types";

interface AppState {
  // ===================================
  // CONNECTION STATE
  // ===================================
  role: Role | null;
  sessionCode: string | null;
  myId: string | null;
  peerId: string | null;
  receiverCount: number;
  connectionStatus: ConnectionStatus;
  encryptionKey: string;

  // ===================================
  // FILE TRANSFER STATE
  // ===================================
  selectedFiles: File[];
  transfers: Map<string, FileTransfer>;

  // ===================================
  // MESSAGE STATE
  // ===================================
  messages: Message[];

  // ===================================
  // UI STATE
  // ===================================
  currentTab: Tab;
  showQRScanner: boolean;
  notifications: Array<{
    id: string;
    message: string;
    type: "success" | "error" | "warning" | "info";
    timestamp: number;
  }>;

  // ===================================
  // ACTIONS - CONNECTION
  // ===================================
  setRole: (role: Role) => void;
  setSessionCode: (code: string | null) => void;
  setMyId: (id: string | null) => void;
  setPeerId: (id: string | null) => void;
  setReceiverCount: (count: number) => void;
  setConnectionStatus: (status: Partial<ConnectionStatus>) => void;
  setEncryptionKey: (key: string) => void;

  // ===================================
  // ACTIONS - FILES
  // ===================================
  setSelectedFiles: (files: File[]) => void;
  addFile: (file: File) => void;
  removeFile: (index: number) => void;
  clearFiles: () => void;
  addTransfer: (transfer: FileTransfer) => void;
  updateTransfer: (id: string, update: Partial<FileTransfer>) => void;
  removeTransfer: (id: string) => void;
  clearTransfers: () => void;

  // ===================================
  // ACTIONS - MESSAGES
  // ===================================
  addMessage: (message: Message) => void;
  clearMessages: () => void;

  // ===================================
  // ACTIONS - UI
  // ===================================
  setCurrentTab: (tab: Tab) => void;
  setShowQRScanner: (show: boolean) => void;
  addNotification: (
    message: string,
    type: "success" | "error" | "warning" | "info",
  ) => void;
  removeNotification: (id: string) => void;
  clearNotifications: () => void;

  // ===================================
  // ACTIONS - RESET
  // ===================================
  reset: () => void;
}

const initialState = {
  role: null,
  sessionCode: null,
  myId: null,
  peerId: null,
  receiverCount: 0,
  connectionStatus: {
    websocket: false,
    webrtc: false,
  },
  encryptionKey: "",
  selectedFiles: [],
  transfers: new Map<string, FileTransfer>(),
  messages: [],
  currentTab: "files" as Tab,
  showQRScanner: false,
  notifications: [],
};

export const useStore = create<AppState>((set, get) => ({
  ...initialState,

  // ===================================
  // CONNECTION ACTIONS
  // ===================================

  setRole: (role) => set({ role }),

  setSessionCode: (sessionCode) => set({ sessionCode }),

  setMyId: (myId) => set({ myId }),

  setPeerId: (peerId) => set({ peerId }),

  setReceiverCount: (receiverCount) => set({ receiverCount }),

  setConnectionStatus: (status) =>
    set((state) => ({
      connectionStatus: { ...state.connectionStatus, ...status },
    })),

  setEncryptionKey: (encryptionKey) => set({ encryptionKey }),

  // ===================================
  // FILE ACTIONS
  // ===================================

  setSelectedFiles: (selectedFiles) => set({ selectedFiles }),

  addFile: (file) =>
    set((state) => ({
      selectedFiles: [...state.selectedFiles, file],
    })),

  removeFile: (index) =>
    set((state) => ({
      selectedFiles: state.selectedFiles.filter((_, i) => i !== index),
    })),

  clearFiles: () => set({ selectedFiles: [] }),

  addTransfer: (transfer) =>
    set((state) => {
      const transfers = new Map(state.transfers);
      transfers.set(transfer.id, transfer);
      return { transfers };
    }),

  updateTransfer: (id, update) =>
    set((state) => {
      const transfers = new Map(state.transfers);
      const existing = transfers.get(id);
      if (existing) {
        transfers.set(id, { ...existing, ...update });
      }
      return { transfers };
    }),

  removeTransfer: (id) =>
    set((state) => {
      const transfers = new Map(state.transfers);
      transfers.delete(id);
      return { transfers };
    }),

  clearTransfers: () => set({ transfers: new Map() }),

  // ===================================
  // MESSAGE ACTIONS
  // ===================================

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),

  clearMessages: () => set({ messages: [] }),

  // ===================================
  // UI ACTIONS
  // ===================================

  setCurrentTab: (currentTab) => set({ currentTab }),

  setShowQRScanner: (showQRScanner) => set({ showQRScanner }),

  addNotification: (message, type) =>
    set((state) => ({
      notifications: [
        ...state.notifications,
        {
          id: crypto.randomUUID(),
          message,
          type,
          timestamp: Date.now(),
        },
      ],
    })),

  removeNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),

  clearNotifications: () => set({ notifications: [] }),

  // ===================================
  // RESET
  // ===================================

  reset: () => set(initialState),
}));

// ===================================
// SELECTORS (for optimized access)
// ===================================

export const selectIsConnected = (state: AppState) =>
  state.connectionStatus.websocket && state.connectionStatus.webrtc;

export const selectCanSendFiles = (state: AppState) =>
  state.role === "sender" &&
  state.selectedFiles.length > 0 &&
  state.connectionStatus.webrtc;

export const selectActiveTransfers = (state: AppState) =>
  Array.from(state.transfers.values()).filter(
    (t) => t.status === "transferring" || t.status === "pending",
  );

export const selectCompletedTransfers = (state: AppState) =>
  Array.from(state.transfers.values()).filter((t) => t.status === "complete");

export const selectFailedTransfers = (state: AppState) =>
  Array.from(state.transfers.values()).filter((t) => t.status === "error");
