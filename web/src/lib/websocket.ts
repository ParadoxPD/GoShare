// ===================================
// WEBSOCKET SIGNALING MANAGER - IMPROVED
// Enhanced error handling, connection resilience, and state management
// ===================================

import type { WebSocketMsg, RTCSignal } from "../types";
import { API_CONFIG, CONNECTION_CONFIG } from "./globals";
import { log } from "./utils";
import {
  ConnectionStateMachine,
  type ConnectionState,
} from "./connection-state";
import { eventBus } from "./events";
import { CircuitBreaker, withRetry } from "./retry";

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
  private maxReconnectAttempts: number;
  private baseReconnectDelay: number;
  private currentReconnectDelay: number;
  private isIntentionallyClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private messageQueue: WebSocketMsg[] = [];
  private lastPongTime: number = 0;
  private stateMachine = new ConnectionStateMachine("disconnected");
  private connectBreaker = new CircuitBreaker(8, 30_000);

  constructor(callbacks: WebSocketCallbacks = {}) {
    this.callbacks = callbacks;
    this.url = API_CONFIG.WS_URL;
    this.maxReconnectAttempts = CONNECTION_CONFIG.MAX_RECONNECT_ATTEMPTS;
    this.baseReconnectDelay = CONNECTION_CONFIG.RECONNECT_DELAY;
    this.currentReconnectDelay = this.baseReconnectDelay;
  }

  // ===================================
  // CONNECTION MANAGEMENT
  // ===================================

  private setConnectionState(next: ConnectionState, reason?: string): void {
    if (this.stateMachine.current === next) return;

    try {
      this.stateMachine.transition(next, reason);
      eventBus.emit("connection:ws_state", { state: next, reason });
    } catch (error) {
      log(`Invalid WS state transition to "${next}": ${error}`, "warning");
    }
  }

  async connect(): Promise<void> {
    // Prevent multiple simultaneous connection attempts
    if (
      this.stateMachine.current === "connecting" ||
      this.stateMachine.current === "connected"
    ) {
      log("Connection already in progress or established", "info");
      return Promise.resolve();
    }

    this.setConnectionState("connecting", "connect called");
    this.isIntentionallyClosed = false;

    return this.connectBreaker.execute(async () => {
      await withRetry(
        () =>
          new Promise<void>((resolve, reject) => {
            try {
              log(`Connecting to WebSocket: ${this.url}`, "info");

              const connectionTimeout = setTimeout(() => {
                if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
                  log("WebSocket connection timeout", "error");
                  this.ws.close();
                  reject(new Error("Connection timeout"));
                }
              }, 10000);

              this.ws = new WebSocket(this.url);

              this.ws.onopen = () => {
                clearTimeout(connectionTimeout);
                this.setConnectionState("connected", "socket open");
                this.reconnectAttempts = 0;
                this.currentReconnectDelay = this.baseReconnectDelay;
                this.lastPongTime = Date.now();

                log("WebSocket connected successfully", "success");
                this.callbacks.onOpen?.();
                this.startHeartbeat();
                this.flushMessageQueue();
                resolve();
              };

              this.ws.onclose = (event) => {
                clearTimeout(connectionTimeout);
                this.stopHeartbeat();

                const wasConnected = this.stateMachine.current === "connected";
                if (this.isIntentionallyClosed) {
                  this.setConnectionState(
                    "closed",
                    `intentional close: ${event.code}:${event.reason || "unknown"}`,
                  );
                } else {
                  this.setConnectionState(
                    "disconnected",
                    `closed: ${event.code}:${event.reason || "unknown"}`,
                  );
                }

                log(
                  `WebSocket disconnected - Code: ${event.code}, Reason: ${event.reason || "Unknown"}`,
                  "warning",
                );

                this.callbacks.onClose?.();

                if (!this.isIntentionallyClosed && wasConnected) {
                  this.attemptReconnect();
                }
              };

              this.ws.onerror = (error) => {
                clearTimeout(connectionTimeout);
                log("WebSocket error occurred", "error");
                console.error("WebSocket error details:", error);
                this.callbacks.onError?.(error);
                eventBus.emit("connection:error", {
                  scope: "ws",
                  message: "WebSocket error",
                });

                if (this.stateMachine.current === "connecting") {
                  reject(new Error("WebSocket connection error"));
                }
              };

              this.ws.onmessage = (event) => {
                this.handleMessage(event);
              };
            } catch (error) {
              this.setConnectionState("disconnected", "connect setup failed");
              log(`Failed to create WebSocket: ${error}`, "error");
              reject(error);
            }
          }),
        {
          maxAttempts: 2,
          initialDelayMs: 200,
          maxDelayMs: 1000,
          backoffMultiplier: 2,
        },
      );
    });
  }

  private attemptReconnect(): void {
    if (this.isIntentionallyClosed) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setConnectionState("failed", "max reconnect attempts reached");
      log("❌ Max reconnection attempts reached", "error");
      this.callbacks.onServerError?.(
        "Unable to establish connection. Please refresh the page.",
      );
      return;
    }

    this.setConnectionState("reconnecting", "scheduled reconnect");
    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const jitter = Math.random() * 1000;
    this.currentReconnectDelay = Math.min(
      this.currentReconnectDelay *
        CONNECTION_CONFIG.RECONNECT_BACKOFF_MULTIPLIER +
        jitter,
      CONNECTION_CONFIG.MAX_RECONNECT_DELAY,
    );

    log(
      `🔄 Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${Math.round(this.currentReconnectDelay / 1000)}s`,
      "info",
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        log(`Reconnection failed: ${error}`, "error");
      });
    }, this.currentReconnectDelay);
  }

  disconnect(): void {
    this.isIntentionallyClosed = true;
    this.setConnectionState("closed", "disconnect called");

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();

    if (this.ws) {
      // Use code 1000 for normal closure
      this.ws.close(1000, "Client initiated disconnect");
      this.ws = null;
    }

    this.messageQueue = [];
    log("WebSocket disconnected by client", "info");
  }

  isConnected(): boolean {
    return (
      this.ws !== null &&
      this.ws.readyState === WebSocket.OPEN &&
      this.stateMachine.current === "connected"
    );
  }

  getConnectionState(): ConnectionState {
    return this.stateMachine.current;
  }

  // ===================================
  // HEARTBEAT MECHANISM
  // ===================================

  private startHeartbeat(): void {
    this.stopHeartbeat(); // Clear any existing timers

    this.pingTimer = setInterval(() => {
      if (this.isConnected()) {
        // Check if we've received ANY message recently (not just pong)
        const timeSinceLastMessage = Date.now() - this.lastPongTime;

        // Only worry if we haven't heard ANYTHING in 60 seconds
        if (timeSinceLastMessage > 60000) {
          log("⚠️ No server activity in 60s, reconnecting", "warning");
          this.ws?.close();
          return;
        } // Send ping (as a regular message - backend doesn't have explicit ping/pong)
        try {
          this.ws!.send(
            JSON.stringify({ type: "ping", timestamp: Date.now() }),
          );
        } catch (error) {
          log(`Failed to send ping: ${error}`, "error");
        }
      }
    }, CONNECTION_CONFIG.PING_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  // ===================================
  // MESSAGE HANDLING
  // ===================================

  private handleMessage(event: MessageEvent): void {
    try {
      const data: WebSocketMsg = JSON.parse(event.data);

      // Update pong time on ANY message (server is alive)
      this.lastPongTime = Date.now();

      switch (data.type) {
        case "pong":
          // Backend responded to our ping - connection is alive
          // Already updated lastPongTime above, no need to log
          break;

        case "code":
          log(`✅ Session code: ${data.code}`, "success");
          this.callbacks.onCode?.(data.code, data.fromId);
          break;

        case "joined":
          log(`✅ Joined session: ${data.code}`, "success");
          this.callbacks.onJoined?.(data.code, data.receiverId, data.fromId);
          break;

        case "receiver_joined":
          log(`👥 Receiver joined: ${data.targetId}`, "info");
          this.callbacks.onReceiverJoined?.(data.targetId);
          break;

        case "receiver_count":
          this.callbacks.onReceiverCount?.(data.receivers);
          break;

        case "webrtc_signal":
          log(
            `📡 RTC signal: ${data.signal?.type || "unknown"} from ${data.fromId}`,
            "info",
          );
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
          log(`⚠️ ${data.error}`, "warning");
          this.callbacks.onWarning?.(data.error);
          break;

        case "error":
          log(`❌ Server error: ${data.error}`, "error");
          this.callbacks.onServerError?.(data.error);
          break;

        case "sender_disconnected":
          log("❌ Sender disconnected", "error");
          this.callbacks.onSenderDisconnected?.();
          break;

        default:
          log(`⚠️ Unknown message type: ${(data as any).type}`, "warning");
      }
    } catch (error) {
      log(`Error processing message: ${error}`, "error");
      console.error("Message parse error:", error, "Raw data:", event.data);
    }
  } // ===================================
  // SEND MESSAGES WITH QUEUING
  // ===================================

  send(data: WebSocketMsg): boolean {
    if (!this.isConnected()) {
      log("WebSocket not connected - queuing message", "warning");
      eventBus.emit("connection:error", {
        scope: "ws",
        message: "WebSocket not connected",
      });
      if (data.type === "text_message") {
        eventBus.emit("message:send_failed", {
          messageId: data.messageId,
          reason: "WebSocket not connected",
        });
      }

      // Queue critical messages for retry
      if (this.shouldQueueMessage(data)) {
        this.messageQueue.push(data);
        log(`Message queued (${this.messageQueue.length} in queue)`, "info");
        return true;
      }

      return false;
    }

    try {
      const json = JSON.stringify(data);
      this.ws!.send(json);
      if (data.type === "text_message") {
        eventBus.emit("message:sent", { messageId: data.messageId });
      }
      return true;
    } catch (error) {
      log(`Failed to send message: ${error}`, "error");
      console.error("Send error:", error, "Data:", data);
      eventBus.emit("connection:error", {
        scope: "ws",
        message: "Failed to send WebSocket message",
      });
      if (data.type === "text_message") {
        eventBus.emit("message:send_failed", {
          messageId: data.messageId,
          reason: "send failed",
        });
      }

      // Queue for retry
      if (this.shouldQueueMessage(data)) {
        this.messageQueue.push(data);
        log(
          `Message queued after send failure (${this.messageQueue.length} in queue)`,
          "warning",
        );
        return true;
      }

      return false;
    }
  }

  private shouldQueueMessage(data: WebSocketMsg): boolean {
    // Queue important messages that should survive reconnection
    return (
      data.type === "create_session" ||
      data.type === "join" ||
      data.type === "webrtc_signal" ||
      data.type === "text_message"
    );
  }

  private flushMessageQueue(): void {
    if (this.messageQueue.length === 0) return;

    log(`Flushing ${this.messageQueue.length} queued messages`, "info");

    const queue = [...this.messageQueue];
    this.messageQueue = [];

    queue.forEach((msg) => {
      this.send(msg);
    });
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

  // ===================================
  // DIAGNOSTIC METHODS
  // ===================================

  getStats() {
    return {
      state: this.stateMachine.current,
      connected: this.isConnected(),
      reconnectAttempts: this.reconnectAttempts,
      queuedMessages: this.messageQueue.length,
      timeSinceLastPong: Date.now() - this.lastPongTime,
      url: this.url,
    };
  }
}
