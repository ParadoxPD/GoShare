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
    // Initialize transfer manager
    transferManager.current = new TransferManager(store.encryptionKey);

    // Initialize WebSocket
    wsManager.current = new WebSocketManager({
      onOpen: () => {
        store.setConnectionStatus({ websocket: true });
        store.addNotification("Connected to server", "success");
      },

      onClose: () => {
        store.setConnectionStatus({ websocket: false });
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

      onWebRTCSignal: async (signal, fromId, targetId) => {
        if (!rtcConnection.current) return;

        try {
          if (signal.type === "offer" && signal.sdp) {
            await rtcConnection.current.handleOffer(signal.sdp);
            const answer = await rtcConnection.current.createAnswer();

            wsManager.current?.sendWebRTCSignal(
              { type: "answer", sdp: answer },
              store.sessionCode!,
              store.myId!,
              fromId,
            );
          } else if (signal.type === "answer" && signal.sdp) {
            await rtcConnection.current.handleAnswer(signal.sdp);
          } else if (signal.type === "ice" && signal.candidate) {
            await rtcConnection.current.addICECandidate(signal.candidate);
          }
        } catch (error) {
          log(`WebRTC signal error: ${error}`, "error");
        }
      },

      onTextMessage: async (text, messageId, senderName, timestamp) => {
        try {
          const decrypted = await decryptText(text, store.encryptionKey);

          store.addMessage({
            id: messageId,
            text: decrypted,
            timestamp,
            sent: false,
            senderName,
          });

          store.addNotification("New message received", "info");
        } catch (error) {
          log("Failed to decrypt message", "error");
          store.addNotification("Failed to decrypt message", "error");
        }
      },

      onTextAck: (messageId, receivers) => {
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
      },
    });

    // Connect WebSocket
    wsManager.current.connect();

    // Cleanup
    return () => {
      wsManager.current?.disconnect();
      rtcConnection.current?.close();
      transferManager.current?.cleanup();
    };
  }, [store.encryptionKey]);

  // ===================================
  // SETUP WEBRTC
  // ===================================

  const setupWebRTC = async (isSender: boolean) => {
    if (rtcConnection.current) {
      rtcConnection.current.close();
    }

    rtcConnection.current = new WebRTCConnection(isSender, {
      onChannelOpen: () => {
        rtcConnection.current?.exchangeKeys();
      },
      onConnectionStateChange: (state) => {
        store.setConnectionStatus({ webrtc: state === "connected" });

        if (state === "connected") {
          store.addNotification("WebRTC connected", "success");
        } else if (state === "failed") {
          store.addNotification("WebRTC connection failed", "error");
        }
      },

      // ✨ NEW: Handle completed key exchange
      onKeyExchangeComplete: (sharedSecret) => {
        console.log("🔐 Shared encryption key established");
        store.setEncryptionKey(sharedSecret);

        // Now set connection for transfer manager
        transferManager.current?.setConnection(rtcConnection.current!);

        store.addNotification("Secure connection established", "success");
      },

      onControlMessage: (data) => {
        // Handle file offers on receiver side
        if (data.t === "file_offer" && store.role === "receiver") {
          handleFileOffer(data as FileOfferMsg);
        }

        // Pass to transfer manager
        transferManager.current?.handleControlMessage(data);
      },

      onDataMessage: (data) => {
        transferManager.current?.handleReceivedChunk(data);
      },

      onICECandidate: (candidate) => {
        if (store.sessionCode && store.myId && store.peerId) {
          wsManager.current?.sendWebRTCSignal(
            { type: "ice", candidate },
            store.sessionCode,
            store.myId,
            store.peerId,
          );
        }
      },

      onError: (error) => {
        log(`WebRTC error: ${error.message}`, "error");
        store.addNotification(`WebRTC error: ${error.message}`, "error");
      },
    });

    // Create and send offer (sender only)
    if (isSender && store.sessionCode && store.myId && store.peerId) {
      try {
        const offer = await rtcConnection.current.createOffer();

        wsManager.current?.sendWebRTCSignal(
          { type: "offer", sdp: offer },
          store.sessionCode,
          store.myId,
          store.peerId,
        );
      } catch (error) {
        log(`Failed to create offer: ${error}`, "error");
      }
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

    if (store.selectedFiles.length === 0) {
      store.addNotification("No files selected", "warning");
      return;
    }

    for (const file of store.selectedFiles) {
      const fileId = await transferManager.current.sendFile(file, {
        onProgress: (progress, speed) => {
          store.updateTransfer(fileId!, {
            progress,
            speed,
            status: "transferring",
          });
        },

        onComplete: () => {
          store.updateTransfer(fileId!, {
            progress: 100,
            status: "complete",
          });

          store.addNotification(`Sent: ${file.name}`, "success");
        },

        onError: (error) => {
          store.updateTransfer(fileId!, {
            status: "error",
            error,
          });

          store.addNotification(`Transfer error: ${error}`, "error");
        },
      });

      if (fileId) {
        store.addTransfer({
          id: fileId,
          name: file.name,
          size: file.size,
          totalChunks: Math.ceil(file.size / (256 * 1024)),
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
    if (!store.sessionCode) {
      store.addNotification("No active session", "warning");
      return;
    }

    try {
      const encrypted = await encryptText(text, store.encryptionKey);
      const messageId = crypto.randomUUID();
      const senderName = store.role === "sender" ? "Sender" : "Receiver";

      const success = wsManager.current?.sendTextMessage(
        encrypted,
        store.sessionCode,
        messageId,
        senderName,
      );

      if (success) {
        store.addMessage({
          id: messageId,
          text,
          timestamp: Date.now(),
          sent: true,
          senderName: "You",
        });

        store.addNotification("Message sent", "success");
      }
    } catch (error) {
      log("Failed to send message", "error");
      store.addNotification("Failed to send message", "error");
    }
  };

  return {
    createSession,
    joinSession,
    sendFiles,
    sendTextMessage,
  };
}
