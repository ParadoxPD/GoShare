// ===================================
// INTEGRATED P2P HOOK
// Connects Zustand store with P2P transfer logic
// ===================================

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { WebSocketManager } from "../lib/websocket";
import { WebRTCConnection } from "../lib/webrtc";
import { TransferManager } from "../lib/transfer";
import { encryptText, decryptText } from "../lib/crypto";
import { getConnectionId, log, downloadBlob } from "../lib/utils";
import { eventBus } from "../lib/events";
import type { FileOfferMsg } from "../types";

export function useP2PIntegration() {
  const store = useStore();
  const wsManager = useRef<WebSocketManager | null>(null);
  const rtcConnection = useRef<WebRTCConnection | null>(null);
  const transferManager = useRef<TransferManager | null>(null);

  // ===================================
  // INITIALIZE
  // ===================================

  useEffect(() => {
    const unsubscribers: Array<() => void> = [];

    unsubscribers.push(
      eventBus.on("connection:ws_state", ({ state }) => {
        store.setConnectionStatus({ websocket: state === "connected" });
        store.setWsState(state);
      }),
    );

    unsubscribers.push(
      eventBus.on("connection:rtc_state", ({ state }) => {
        store.setConnectionStatus({ webrtc: state === "connected" });
        store.setRtcState(state);
      }),
    );

    unsubscribers.push(
      eventBus.on("connection:error", ({ scope, message }) => {
        log(`${scope.toUpperCase()} error: ${message}`, "error");
      }),
    );

    // Initialize transfer manager
    transferManager.current = new TransferManager(useStore.getState().encryptionKey);

    // Initialize WebSocket
    wsManager.current = new WebSocketManager({
      onOpen: () => {
        store.setConnectionStatus({ websocket: true });
        store.setWsState("connected");
        store.addNotification("Connected to server", "success");
      },

      onClose: () => {
        store.setConnectionStatus({ websocket: false });
        store.setWsState("disconnected");
      },

      onCode: (code, fromId) => {
        store.setSessionCode(code);
        store.setMyId(fromId);
      },

      onJoined: (code, receiverId, fromId) => {
        store.setSessionCode(code);
        store.setMyId(receiverId);
        if (fromId) {
          store.setPeerId(fromId);
          setupWebRTC(false);
        }
        store.addNotification("Joined session successfully", "success");
      },

      onReceiverJoined: (targetId) => {
        store.setPeerId(targetId);
        setupWebRTC(true);
      },

      onReceiverCount: (count) => {
        store.setReceiverCount(count);
      },

      onWebRTCSignal: async (signal, fromId, _targetId) => {
        log(`📨 Received WebRTC signal: ${signal.type} from ${fromId}`, "info");

        if (!rtcConnection.current) {
          log("⚠️ Received signal but WebRTC not initialized", "warning");
          return;
        }

        try {
          if (signal.type === "offer" && signal.sdp) {
            log("📥 Processing offer...", "info");
            await rtcConnection.current.handleOffer(signal.sdp);
            const answer = await rtcConnection.current.createAnswer();
            log("📝 Created answer", "success");
            const currentState = useStore.getState();
            const { sessionCode, myId } = currentState;

            if (!sessionCode || !myId) {
              log("Cannot send answer - missing session state", "warning");
              return;
            }

            const sent = wsManager.current?.sendWebRTCSignal(
              { type: "answer", sdp: answer },
              sessionCode,
              myId,
              fromId,
            );

            if (sent) {
              log("✅ Answer sent successfully", "success");
            } else {
              log("⚠️ Answer queued", "warning");
            }
          } else if (signal.type === "answer" && signal.sdp) {
            log("📥 Processing answer...", "info");
            await rtcConnection.current.handleAnswer(signal.sdp);
            log("✅ Answer processed", "success");
          } else if (signal.type === "ice" && signal.candidate) {
            log(
              `📥 Adding ICE candidate (${signal.candidate.candidate})`,
              "info",
            );
            await rtcConnection.current.addICECandidate(signal.candidate);
          }
        } catch (error) {
          log(`❌ WebRTC signal error: ${error}`, "error");
          console.error("Signal processing error:", error, "Signal:", signal);
        }
      },

      onTextMessage: async (text, messageId, senderName, timestamp) => {
        try {
          const currentState = useStore.getState();
          const decrypted = await decryptText(text, currentState.encryptionKey);

          currentState.addMessage({
            id: messageId,
            text: decrypted,
            timestamp,
            sent: false,
            senderName,
          });

          currentState.addNotification("New message received", "info");
        } catch (error) {
          log("Failed to decrypt message", "error");
          useStore
            .getState()
            .addNotification("Failed to decrypt message", "error");
        }
      },

      onTextAck: (_messageId, receivers) => {
        log(`Message delivered to ${receivers} receiver(s)`, "success");
      },

      onWarning: (message) => {
        store.addNotification(message, "warning");
      },

      onServerError: (message) => {
        store.addNotification(message, "error");
      },

      onSenderDisconnected: () => {
        store.addNotification("Sender disconnected", "error");
        store.setConnectionStatus({ webrtc: false });
        store.setRtcState("disconnected");
      },
    });

    // Connect WebSocket
    wsManager.current.connect().catch((err) => {
      console.error("Failed to establish WebSocket connection:", err);
    });

    // Cleanup
    return () => {
      log("🧹 Cleaning up P2P integration", "info");
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      wsManager.current?.disconnect();
      rtcConnection.current?.close();
      transferManager.current?.cleanup();

      // Clear refs
      wsManager.current = null;
      rtcConnection.current = null;
      transferManager.current = null;
    };
  }, []);

  // ===================================
  // SETUP WEBRTC
  // ===================================

  const setupWebRTC = async (isSender: boolean) => {
    if (rtcConnection.current) {
      log("🔄 Closing existing WebRTC connection", "warning");
      rtcConnection.current.close();
    }

    log(`🚀 Setting up WebRTC as ${isSender ? "SENDER" : "RECEIVER"}`, "info");
    const currentState = useStore.getState();
    log(
      `📋 Store state - sessionCode: ${currentState.sessionCode}, myId: ${currentState.myId}, peerId: ${currentState.peerId}`,
      "info",
    );

    rtcConnection.current = new WebRTCConnection(isSender, {
      onChannelOpen: () => {
        log("✅ Data channel opened, starting key exchange", "success");
        rtcConnection.current?.exchangeKeys();
      },

      onConnectionStateChange: (state) => {
        log(`🔌 WebRTC state: ${state}`, "info");
        store.setConnectionStatus({ webrtc: state === "connected" });

        if (state === "connected") {
          store.addNotification("WebRTC connected", "success");
        } else if (state === "failed") {
          store.addNotification("WebRTC connection failed", "error");
        }
      },

      onKeyExchangeComplete: (sharedSecret) => {
        log("🔐 Shared encryption key established", "success");
        store.setEncryptionKey(sharedSecret);
        transferManager.current?.setEncryptionKey(sharedSecret);
        transferManager.current?.setConnection(rtcConnection.current!);
        store.addNotification("Secure connection established", "success");
      },

      onControlMessage: (data) => {
        if (data.t === "file_offer" && useStore.getState().role === "receiver") {
          handleFileOffer(data as FileOfferMsg);
        }
        transferManager.current?.handleControlMessage(data);
      },

      onDataMessage: (data) => {
        transferManager.current?.handleReceivedChunk(data);
      },

      onICECandidate: (candidate) => {
        const currentState = useStore.getState();
        const { sessionCode, myId, peerId } = currentState;

        if (!sessionCode || !myId || !peerId) {
          log("⚠️ Cannot send ICE candidate - missing session info", "warning");
          log(
            `  sessionCode: ${sessionCode}, myId: ${myId}, peerId: ${peerId}`,
            "warning",
          );
          return;
        }

        log(`📤 Sending ICE candidate: ${candidate.type || "unknown"}`, "info");
        const sent = wsManager.current?.sendWebRTCSignal(
          { type: "ice", candidate },
          sessionCode,
          myId,
          peerId,
        );

        if (!sent) {
          log("❌ Failed to send ICE candidate", "error");
        }
      },

      onError: (error) => {
        const friendlyMessages: Record<string, string> = {
          "Connection timeout":
            "Connection timed out. Check your internet connection.",
          "Connection failed": "Failed to connect. Try refreshing the page.",
          "Key exchange failed":
            "Security setup failed. Please restart the session.",
        };

        const message = friendlyMessages[error.message] || error.message;
        log(`WebRTC error: ${message}`, "error");
        store.addNotification(message, "error");
      },
    });

    // Create and send offer (sender only)
    if (isSender) {
      const currentState = useStore.getState();
      const { sessionCode, myId, peerId } = currentState;
      if (!sessionCode || !myId || !peerId) {
        log("❌ Cannot create offer - missing session info", "error");
        log(
          `  sessionCode: ${sessionCode}, myId: ${myId}, peerId: ${peerId}`,
          "error",
        );
        return;
      }

      try {
        log("📝 Creating WebRTC offer...", "info");
        const offer = await rtcConnection.current.createOffer();

        log(`📤 Sending offer to ${peerId}`, "info");
        const sent = wsManager.current?.sendWebRTCSignal(
          { type: "offer", sdp: offer },
          sessionCode,
          myId,
          peerId,
        );

        if (sent) {
          log("✅ Offer sent successfully", "success");
        } else {
          log("❌ Failed to send offer", "error");
          throw new Error("Failed to send WebRTC offer");
        }
      } catch (error) {
        log(`Failed to create/send offer: ${error}`, "error");
        store.addNotification("Failed to establish connection", "error");
      }
    } else {
      log("📥 Waiting for offer from sender...", "info");
    }
  };
  // ===================================
  // HANDLE FILE OFFER (RECEIVER)
  // ===================================

  const handleFileOffer = (offer: FileOfferMsg) => {
    const fileId = offer.fileId;

    // Add to transfers
    store.addTransfer({
      id: fileId,
      name: offer.name,
      size: offer.size,
      totalChunks: offer.totalChunks,
      chunkSize: offer.chunkSize,
      progress: 0,
      speed: 0,
      status: "transferring",
    });

    // Setup receiver
    transferManager.current?.setupReceiver(offer, {
      onProgress: (progress) => {
        store.updateTransfer(fileId, { progress });
      },

      onComplete: (blob) => {
        downloadBlob(blob, offer.name);

        store.updateTransfer(fileId, {
          progress: 100,
          status: "complete",
        });

        store.addNotification(`Received: ${offer.name}`, "success");
      },

      onError: (error) => {
        store.updateTransfer(fileId, {
          status: "error",
          error,
        });

        store.addNotification(`Transfer error: ${error}`, "error");
      },
    });
  };

  // ===================================
  // PUBLIC API
  // ===================================

  const createSession = () => {
    wsManager.current?.createSession();
  };

  const joinSession = (code: string) => {
    const connectionId = getConnectionId();
    wsManager.current?.joinSession(code, connectionId);
  };

  const sendFiles = async () => {
    if (!transferManager.current || !store.connectionStatus.webrtc) {
      store.addNotification("Not ready to send files", "warning");
      return;
    }
    if (!rtcConnection.current?.isConnected()) {
      store.setConnectionStatus({ webrtc: false });
      store.addNotification(
        "Peer connection is not active. Reconnect before sending files.",
        "warning",
      );
      return;
    }

    if (store.selectedFiles.length === 0) {
      store.addNotification("No files selected", "warning");
      return;
    }

    for (const file of store.selectedFiles) {
      let fileId: string | null = null;

      fileId = await transferManager.current.sendFile(file, {
        onProgress: (progress, speed) => {
          if (!fileId) return;

          eventBus.emit("transfer:progress", { fileId, progress, speed });
          store.updateTransfer(fileId, {
            progress,
            speed,
            status: "transferring",
          });
        },

        onComplete: () => {
          if (!fileId) return;

          eventBus.emit("transfer:complete", { fileId, fileName: file.name });
          store.updateTransfer(fileId, {
            progress: 100,
            status: "complete",
          });

          store.addNotification(`Sent: ${file.name}`, "success");
        },

        onError: (error) => {
          eventBus.emit("transfer:error", {
            fileId: fileId || undefined,
            fileName: file.name,
            reason: error,
          });

          if (fileId) {
            store.updateTransfer(fileId, {
              status: "error",
              error,
            });
          }

          store.addNotification(`Transfer error: ${error}`, "error");
        },
      });

      if (fileId) {
        store.addTransfer({
          id: fileId,
          name: file.name,
          size: file.size,
          totalChunks: Math.ceil(file.size / (16 * 1024)),
          chunkSize: 16 * 1024,
          progress: 0,
          speed: 0,
          status: "pending",
        });
      }
    }

    // Clear selected files after sending
    store.clearFiles();
  };

  const sendTextMessage = async (text: string) => {
    const currentState = useStore.getState();

    if (!currentState.sessionCode) {
      store.addNotification("No active session", "warning");
      return;
    }
    if (!wsManager.current?.isConnected()) {
      store.setConnectionStatus({ websocket: false });
      store.addNotification("Not connected to signaling server", "error");
      return;
    }

    try {
      const encrypted = await encryptText(text, currentState.encryptionKey);
      const messageId = crypto.randomUUID();
      const senderName = currentState.role === "sender" ? "Sender" : "Receiver";

      const success = wsManager.current.sendTextMessage(
        encrypted,
        currentState.sessionCode,
        messageId,
        senderName,
      );

      if (success) {
        currentState.addMessage({
          id: messageId,
          text,
          timestamp: Date.now(),
          sent: true,
          senderName: "You",
        });

        currentState.addNotification("Message sent", "success");
      } else {
        currentState.addNotification("Message queued. Waiting for connection.", "warning");
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown message send error";
      log(`Failed to send message: ${message}`, "error");
      store.addNotification(`Failed to send message: ${message}`, "error");
    }
  };

  return {
    createSession,
    joinSession,
    sendFiles,
    sendTextMessage,
  };
}
