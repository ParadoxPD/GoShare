// ===================================
// WEBSOCKET SIGNALING MANAGER
// Stateless signaling for peer discovery and WebRTC setup
// ===================================

import type { WebSocketMsg, RTCSignal } from "../types";
import { log } from "./utils";

export interface WebSocketCallbacks {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  onCode?: (code: string, fromId: string) => void;
  onJoined?: (code: string, receiverId: string, fromId?: string) => void;
  onReceiverJoined?: (targetId: string) => void;
  onReceiverCount?: (count: number) => void;
  onWebRTCSignal?: (
    signal: RTCSignal,
    fromId: string,
    targetId: string,
  ) => void;
  onTextMessage?: (
    text: string,
    messageId: string,
    senderName: string,
    timestamp: number,
  ) => void;
  onTextAck?: (messageId: string, receivers: number) => void;
  onWarning?: (message: string) => void;
  onServerError?: (message: string) => void;
  onSenderDisconnected?: () => void;
}

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private callbacks: WebSocketCallbacks;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 3000;
  private isIntentionallyClosed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(callbacks: WebSocketCallbacks = {}) {
    this.callbacks = callbacks;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.url = `${protocol}//${window.location.host}/ws`;
  }

  // ===================================
  // CONNECTION MANAGEMENT
  // ===================================

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.isIntentionallyClosed = false;
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          log("WebSocket connected", "success");
          this.reconnectAttempts = 0;
          this.callbacks.onOpen?.();
          resolve();
        };

        this.ws.onclose = () => {
          log("WebSocket disconnected", "warning");
          this.callbacks.onClose?.();

          if (!this.isIntentionallyClosed) {
            this.attemptReconnect();
          }
        };

        this.ws.onerror = (error) => {
          log("WebSocket error", "error");
          this.callbacks.onError?.(error);
          reject(error);
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private attemptReconnect(): void {
    if (this.isIntentionallyClosed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log("Max reconnection attempts reached", "error");
      return;
    }

    this.reconnectAttempts++;
    log(
      `Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
      "info",
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        log(`Reconnection failed: ${error}`, "error");
      });
    }, this.reconnectDelay);
  }

  disconnect(): void {
    this.isIntentionallyClosed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ===================================
  // MESSAGE HANDLING
  // ===================================

  private handleMessage(event: MessageEvent): void {
    try {
      const data: WebSocketMsg = JSON.parse(event.data);

      switch (data.type) {
        case "code":
          log(`Session code: ${data.code}`, "success");
          this.callbacks.onCode?.(data.code, data.fromId);
          break;

        case "joined":
          log(`Joined session: ${data.code}`, "success");
          this.callbacks.onJoined?.(data.code, data.receiverId, data.fromId);
          break;

        case "receiver_joined":
          log(`Receiver joined: ${data.targetId}`, "info");
          this.callbacks.onReceiverJoined?.(data.targetId);
          break;

        case "receiver_count":
          this.callbacks.onReceiverCount?.(data.receivers);
          break;

        case "webrtc_signal":
          this.callbacks.onWebRTCSignal?.(
            data.signal,
            data.fromId,
            data.targetId,
          );
          break;

        case "text_message":
          this.callbacks.onTextMessage?.(
            data.text,
            data.messageId,
            data.senderName,
            data.timestamp || Date.now(),
          );
          break;

        case "text_ack":
          this.callbacks.onTextAck?.(data.messageId, data.receivers);
          break;

        case "warning":
          log(data.error, "warning");
          this.callbacks.onWarning?.(data.error);
          break;

        case "error":
          log(data.error, "error");
          this.callbacks.onServerError?.(data.error);
          break;

        case "sender_disconnected":
          log("Sender disconnected", "error");
          this.callbacks.onSenderDisconnected?.();
          break;
      }
    } catch (error) {
      log(`Error processing message: ${error}`, "error");
    }
  }

  // ===================================
  // SEND MESSAGES
  // ===================================

  send(data: WebSocketMsg): boolean {
    if (!this.isConnected()) {
      log("Cannot send - WebSocket not connected", "warning");
      return false;
    }

    try {
      this.ws!.send(JSON.stringify(data));
      return true;
    } catch (error) {
      log(`Failed to send message: ${error}`, "error");
      return false;
    }
  }

  createSession(): boolean {
    return this.send({ type: "create_session" });
  }

  joinSession(code: string, receiverId: string): boolean {
    return this.send({
      type: "join",
      code,
      receiverId,
    });
  }

  sendWebRTCSignal(
    signal: RTCSignal,
    code: string,
    fromId: string,
    targetId: string,
  ): boolean {
    return this.send({
      type: "webrtc_signal",
      code,
      fromId,
      targetId,
      signal,
    });
  }

  sendTextMessage(
    text: string,
    code: string,
    messageId: string,
    senderName: string,
  ): boolean {
    return this.send({
      type: "text_message",
      code,
      text,
      messageId,
      senderName,
    });
  }
}
