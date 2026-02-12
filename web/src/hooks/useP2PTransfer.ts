// ===================================
// USE P2P TRANSFER HOOK
// Integrates WebRTC + Transfer Protocol + WebSocket
// ===================================

import { useEffect, useRef, useState } from "react";
import { WebSocketManager } from "../lib/websocket";
import { WebRTCConnection } from "../lib/webrtc";
import { TransferManager } from "../lib/transfer";
import type { Role, FileTransfer, Message } from "../types";
import { encryptText, decryptText } from "../lib/crypto";
import { getConnectionId, log, downloadBlob } from "../lib/utils";

export interface UseP2PTransferOptions {
  encryptionKey: string;
  role?: Role;
}

export function useP2PTransfer({ encryptionKey, role }: UseP2PTransferOptions) {
  // ===================================
  // STATE
  // ===================================

  const [sessionCode, setSessionCode] = useState<string | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [peerId, setPeerId] = useState<string | null>(null);
  const [receiverCount, setReceiverCount] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [webrtcConnected, setWebrtcConnected] = useState(false);
  const [transfers, setTransfers] = useState<Map<string, FileTransfer>>(
    new Map(),
  );
  const [messages, setMessages] = useState<Message[]>([]);

  // ===================================
  // REFS
  // ===================================

  const wsManager = useRef<WebSocketManager | null>(null);
  const rtcConnection = useRef<WebRTCConnection | null>(null);
  const transferManager = useRef<TransferManager | null>(null);

  // ===================================
  // INITIALIZE
  // ===================================

  useEffect(() => {
    // Initialize transfer manager
    transferManager.current = new TransferManager(encryptionKey);

    // Initialize WebSocket
    wsManager.current = new WebSocketManager({
      onOpen: () => {
        setWsConnected(true);
        log("WebSocket connected", "success");
      },

      onClose: () => {
        setWsConnected(false);
        log("WebSocket disconnected", "warning");
      },

      onCode: (code, fromId) => {
        setSessionCode(code);
        setMyId(fromId);
      },

      onJoined: (code, receiverId, fromId) => {
        setSessionCode(code);
        setMyId(receiverId);
        if (fromId) {
          setPeerId(fromId);
          // Receiver initiates WebRTC with sender
          if (role === "receiver") {
            setupWebRTC(false);
          }
        }
      },

      onReceiverJoined: (targetId) => {
        setPeerId(targetId);
        // Sender initiates WebRTC with receiver
        if (role === "sender") {
          setupWebRTC(true);
        }
      },

      onReceiverCount: (count) => {
        setReceiverCount(count);
      },

      onWebRTCSignal: async (signal, fromId, targetId) => {
        if (!rtcConnection.current) return;

        try {
          if (signal.type === "offer" && signal.sdp) {
            await rtcConnection.current.handleOffer(signal.sdp);
            const answer = await rtcConnection.current.createAnswer();

            wsManager.current?.sendWebRTCSignal(
              { type: "answer", sdp: answer },
              sessionCode!,
              myId!,
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
          const decrypted = await decryptText(text, encryptionKey);

          const message: Message = {
            id: messageId,
            text: decrypted,
            timestamp,
            sent: false,
            senderName,
          };

          setMessages((prev) => [...prev, message]);
        } catch (error) {
          log("Failed to decrypt message", "error");
        }
      },

      onTextAck: (messageId, receivers) => {
        log(`Message delivered to ${receivers} receiver(s)`, "success");
      },

      onWarning: (message) => {
        log(message, "warning");
      },

      onServerError: (message) => {
        log(message, "error");
      },

      onSenderDisconnected: () => {
        log("Sender disconnected", "error");
        setWebrtcConnected(false);
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
  }, [encryptionKey, role]);

  // ===================================
  // SETUP WEBRTC
  // ===================================

  const setupWebRTC = async (isSender: boolean) => {
    if (rtcConnection.current) {
      rtcConnection.current.close();
    }

    rtcConnection.current = new WebRTCConnection(isSender, {
      onControlMessage: (data) => {
        transferManager.current?.handleControlMessage(data);
      },

      onDataMessage: (data) => {
        transferManager.current?.handleReceivedChunk(data);
      },

      onConnectionStateChange: (state) => {
        setWebrtcConnected(state === "connected");

        if (state === "connected") {
          log("WebRTC connected", "success");
          transferManager.current?.setConnection(rtcConnection.current!);
        }
      },

      onICECandidate: (candidate) => {
        if (sessionCode && myId && peerId) {
          wsManager.current?.sendWebRTCSignal(
            { type: "ice", candidate },
            sessionCode,
            myId,
            peerId,
          );
        }
      },

      onError: (error) => {
        log(`WebRTC error: ${error.message}`, "error");
      },
    });

    // Create and send offer/answer
    if (isSender && sessionCode && myId && peerId) {
      try {
        const offer = await rtcConnection.current.createOffer();

        wsManager.current?.sendWebRTCSignal(
          { type: "offer", sdp: offer },
          sessionCode,
          myId,
          peerId,
        );
      } catch (error) {
        log(`Failed to create offer: ${error}`, "error");
      }
    }
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

  const sendFile = async (file: File) => {
    if (!transferManager.current || !webrtcConnected) {
      log("Not ready to send files", "warning");
      return;
    }

    const fileId = await transferManager.current.sendFile(file, {
      onProgress: (progress, speed) => {
        setTransfers((prev) => {
          const updated = new Map(prev);
          const existing = updated.get(fileId!) || {
            id: fileId!,
            name: file.name,
            size: file.size,
            totalChunks: Math.ceil(file.size / (256 * 1024)),
            progress: 0,
            speed: 0,
            status: "transferring" as const,
          };

          updated.set(fileId!, {
            ...existing,
            progress,
            speed,
            status: "transferring" as const,
          });

          return updated;
        });
      },

      onComplete: () => {
        setTransfers((prev) => {
          const updated = new Map(prev);
          const existing = updated.get(fileId!);

          if (existing) {
            updated.set(fileId!, {
              ...existing,
              progress: 100,
              status: "complete" as const,
            });
          }

          return updated;
        });

        log(`File sent: ${file.name}`, "success");
      },

      onError: (error) => {
        setTransfers((prev) => {
          const updated = new Map(prev);
          const existing = updated.get(fileId!);

          if (existing) {
            updated.set(fileId!, {
              ...existing,
              status: "error" as const,
              error,
            });
          }

          return updated;
        });

        log(`Transfer error: ${error}`, "error");
      },
    });

    if (fileId) {
      setTransfers((prev) => {
        const updated = new Map(prev);
        updated.set(fileId, {
          id: fileId,
          name: file.name,
          size: file.size,
          totalChunks: Math.ceil(file.size / (256 * 1024)),
          progress: 0,
          speed: 0,
          status: "pending" as const,
        });
        return updated;
      });
    }
  };

  const sendTextMessage = async (text: string, senderName: string) => {
    if (!sessionCode) return;

    try {
      const encrypted = await encryptText(text, encryptionKey);
      const messageId = crypto.randomUUID();

      const success = wsManager.current?.sendTextMessage(
        encrypted,
        sessionCode,
        messageId,
        senderName,
      );

      if (success) {
        const message: Message = {
          id: messageId,
          text,
          timestamp: Date.now(),
          sent: true,
          senderName: "You",
        };

        setMessages((prev) => [...prev, message]);
        log("Message sent", "success");
      }
    } catch (error) {
      log("Failed to send message", "error");
    }
  };

  // Handle incoming file offers (receiver side)
  useEffect(() => {
    if (!transferManager.current || role !== "receiver") return;

    const handleFileOffer = (offer: any) => {
      if (offer.t !== "file_offer") return;

      const fileId = offer.fileId;

      setTransfers((prev) => {
        const updated = new Map(prev);
        updated.set(fileId, {
          id: fileId,
          name: offer.name,
          size: offer.size,
          totalChunks: offer.totalChunks,
          progress: 0,
          speed: 0,
          status: "transferring" as const,
        });
        return updated;
      });

      transferManager.current?.setupReceiver(offer, {
        onProgress: (progress) => {
          setTransfers((prev) => {
            const updated = new Map(prev);
            const existing = updated.get(fileId);

            if (existing) {
              updated.set(fileId, {
                ...existing,
                progress,
              });
            }

            return updated;
          });
        },

        onComplete: (blob) => {
          downloadBlob(blob, offer.name);

          setTransfers((prev) => {
            const updated = new Map(prev);
            const existing = updated.get(fileId);

            if (existing) {
              updated.set(fileId, {
                ...existing,
                progress: 100,
                status: "complete" as const,
              });
            }

            return updated;
          });

          log(`File received: ${offer.name}`, "success");
        },

        onError: (error) => {
          setTransfers((prev) => {
            const updated = new Map(prev);
            const existing = updated.get(fileId);

            if (existing) {
              updated.set(fileId, {
                ...existing,
                status: "error" as const,
                error,
              });
            }

            return updated;
          });

          log(`Transfer error: ${error}`, "error");
        },
      });
    };

    // Listen for file offers via control messages
    // This is a simplified version - in production you'd have a proper event system
    if (rtcConnection.current) {
      const originalHandler = rtcConnection.current;
      // Store original callbacks and wrap them
    }
  }, [role, transferManager.current, rtcConnection.current]);

  return {
    // Connection state
    wsConnected,
    webrtcConnected,
    sessionCode,
    myId,
    receiverCount,

    // Data
    transfers: Array.from(transfers.values()),
    messages,

    // Actions
    createSession,
    joinSession,
    sendFile,
    sendTextMessage,
  };
}
