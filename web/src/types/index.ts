// ===================================
// CONTROL CHANNEL MESSAGE TYPES
// ===================================

export type ControlMsg =
  | FileOfferMsg
  | FileAcceptMsg
  | AckMsg
  | PingMsg
  | PongMsg
  | ResumeMsg
  | SlowDownMsg
  | CorruptChunksMsg;

export interface FileOfferMsg {
  t: "file_offer";
  fileId: string;
  name: string;
  size: number;
  totalChunks: number;
  chunkSize: number;
  sha256?: string;
}

export interface FileAcceptMsg {
  t: "file_accept";
  fileId: string;
  have: number[]; // Resume support - chunks already received
}

export interface AckMsg {
  t: "ack";
  fileId: string;
  received: number[];
}

export interface PingMsg {
  t: "ping";
  timestamp: number;
}

export interface PongMsg {
  t: "pong";
  timestamp: number;
}

export interface ResumeMsg {
  t: "resume";
  fileId: string;
}

export interface SlowDownMsg {
  t: "slow_down";
  fileId: string;
  window: number;
}

export interface CorruptChunksMsg {
  t: "corrupt_chunks";
  fileId: string;
  chunks: number[];
}

// ===================================
// DATA CHANNEL MESSAGE TYPES
// ===================================

export interface DataChunk {
  fileId: string;
  index: number;
  payload: string; // encrypted base64
  aad: string; // Additional Authenticated Data: file_id || chunk_index
}

// ===================================
// WEBSOCKET MESSAGE TYPES
// ===================================

export type WebSocketMsg =
  | { type: "create_session" }
  | { type: "join"; code: string; receiverId: string }
  | { type: "code"; code: string; fromId: string }
  | { type: "joined"; code: string; receiverId: string; fromId?: string }
  | { type: "receiver_joined"; targetId: string }
  | { type: "receiver_count"; receivers: number }
  | {
      type: "webrtc_signal";
      code: string;
      fromId: string;
      targetId: string;
      signal: RTCSignal;
    }
  | {
      type: "text_message";
      code: string;
      text: string;
      messageId: string;
      senderName: string;
      timestamp?: number;
    }
  | { type: "text_ack"; messageId: string; receivers: number }
  | { type: "error"; error: string }
  | { type: "warning"; error: string }
  | { type: "sender_disconnected" };

export interface RTCSignal {
  type?: "offer" | "answer" | "ice";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

// ===================================
// APPLICATION STATE TYPES
// ===================================

export interface FileTransfer {
  id: string;
  name: string;
  size: number;
  totalChunks: number;
  chunkSize: number;
  progress: number;
  speed: number;
  status: "pending" | "transferring" | "complete" | "error" | "paused";
  error?: string;
  startTime?: number;
  endTime?: number;
}

export interface Message {
  id: string;
  text: string;
  timestamp: number;
  sent: boolean;
  senderName: string;
}

export interface SenderState {
  file: File;
  fileId: string;
  sent: Set<number>;
  acked: Set<number>;
  totalChunks: number;
  windowSize: number;
  lastHeartbeat: number;
  resendTimers: Map<number, NodeJS.Timeout>;
  onProgress?: (progress: number, speed: number) => void;
  onComplete?: () => void;
  onError?: (error: string) => void;
  startTime: number;
  pausedChunks: Set<number>;
}

export interface ReceiverState {
  fileId: string;
  name: string;
  size: number;
  totalChunks: number;
  bitmap: Set<number>; // Received chunks
  chunks: Map<number, ArrayBuffer>;
  onProgress?: (progress: number) => void;
  onComplete?: (blob: Blob) => void;
  onError?: (error: string) => void;
  sha256?: string;
}

export type ConnectionStatus = {
  websocket: boolean;
  webrtc: boolean;
};

export type Role = "sender" | "receiver";

export type Tab = "files" | "messages";
