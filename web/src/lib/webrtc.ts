// ===================================
// WEBRTC CONNECTION MANAGER
// Implements dual data channel architecture
// ===================================

import type { RTCSignal } from "../types";
import {
  deriveSharedSecret,
  exportAESKey,
  exportPublicKey,
  generateECDHKeyPair,
  importPublicKey,
} from "./crypto";

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export interface WebRTCCallbacks {
  onControlMessage?: (data: any) => void;
  onDataMessage?: (data: any) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onICECandidate?: (candidate: RTCIceCandidate) => void;
  onError?: (error: Error) => void;
  onKeyExchangeComplete?: (sharedSecret: string) => void; // ✨ NEW
  onChannelOpen?: () => void;
}

export class WebRTCConnection {
  private pc: RTCPeerConnection;
  private controlChannel: RTCDataChannel | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private callbacks: WebRTCCallbacks;
  private isSender: boolean;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000;

  private ecdhKeyPair: CryptoKeyPair | null = null;
  private sharedSecret: CryptoKey | null = null;

  constructor(isSender: boolean, callbacks: WebRTCCallbacks = {}) {
    this.isSender = isSender;
    this.callbacks = callbacks;
    this.pc = this.createPeerConnection();

    // Generate ECDH key pair immediately
    this.initializeKeyExchange();

    if (isSender) {
      this.createDataChannels();
    } else {
      this.setupDataChannelHandlers();
    }
  }

  private async initializeKeyExchange(): Promise<void> {
    this.ecdhKeyPair = await generateECDHKeyPair();
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    // ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.callbacks.onICECandidate?.(event.candidate);
      }
    };

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
      console.log("WebRTC connection state:", pc.connectionState);
      this.callbacks.onConnectionStateChange?.(pc.connectionState);

      if (pc.connectionState === "failed") {
        this.handleConnectionFailure();
      }

      if (pc.connectionState === "connected") {
        this.reconnectAttempts = 0;
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("ICE connection state:", pc.iceConnectionState);
    };

    return pc;
  }

  private createDataChannels(): void {
    // CONTROL CHANNEL: Reliable, ordered
    // For: metadata, ACKs, resume, heartbeats
    this.controlChannel = this.pc.createDataChannel("control", {
      ordered: true,
      maxRetransmits: 3,
    });

    // DATA CHANNEL: Unreliable, unordered
    // For: raw file chunks (we implement reliability at chunk layer)
    this.dataChannel = this.pc.createDataChannel("data", {
      ordered: false,
      maxRetransmits: 0,
    });

    this.setupControlChannel(this.controlChannel);
    this.setupDataChannel(this.dataChannel);
  }

  private setupDataChannelHandlers(): void {
    // Receiver waits for sender to create channels
    this.pc.ondatachannel = (event) => {
      const channel = event.channel;

      if (channel.label === "control") {
        this.controlChannel = channel;
        this.setupControlChannel(channel);
      } else if (channel.label === "data") {
        this.dataChannel = channel;
        this.setupDataChannel(channel);
      }
    };
  }

  private setupControlChannel(channel: RTCDataChannel): void {
    channel.onopen = () => {
      console.log("✅ Control channel opened");
      this.callbacks.onChannelOpen?.();
    };

    channel.onclose = () => {
      console.log("⚠️ Control channel closed");
    };

    channel.onerror = (error) => {
      console.error("❌ Control channel error:", error);
      this.callbacks.onError?.(new Error("Control channel error"));
    };

    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle key exchange messages
        if (data.t === "ecdh_public_key") {
          this.handlePeerPublicKey(data.publicKey);
          return;
        }

        this.callbacks.onControlMessage?.(data);
      } catch (error) {
        console.error("Failed to parse control message:", error);
      }
    };
  }

  async exchangeKeys(): Promise<void> {
    if (!this.ecdhKeyPair) {
      throw new Error("ECDH key pair not initialized");
    }

    // Export and send our public key
    const publicKeyBase64 = await exportPublicKey(this.ecdhKeyPair.publicKey);

    this.sendControl({
      t: "ecdh_public_key",
      publicKey: publicKeyBase64,
    });

    console.log("✨ Sent ECDH public key to peer");
  }

  private async handlePeerPublicKey(publicKeyBase64: string): Promise<void> {
    if (!this.ecdhKeyPair) {
      console.error("ECDH key pair not initialized");
      return;
    }

    try {
      console.log("✨ Received peer's ECDH public key");

      // Import peer's public key
      const peerPublicKey = await importPublicKey(publicKeyBase64);

      // Derive shared secret
      this.sharedSecret = await deriveSharedSecret(
        this.ecdhKeyPair.privateKey,
        peerPublicKey,
      );

      // Export as string for use in encryption
      const sharedSecretString = await exportAESKey(this.sharedSecret);

      console.log("✅ ECDH key exchange complete");

      // Notify application
      this.callbacks.onKeyExchangeComplete?.(sharedSecretString);

      // Send our public key if we haven't yet (receiver case)
      if (!this.isSender) {
        await this.exchangeKeys();
      }
    } catch (error) {
      console.error("❌ Key exchange failed:", error);
      this.callbacks.onError?.(new Error("Key exchange failed"));
    }
  }

  getSharedSecret(): string | null {
    return this.sharedSecret ? exportAESKey(this.sharedSecret) : null;
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    channel.onopen = () => {
      console.log("✅ Data channel opened");
    };

    channel.onclose = () => {
      console.log("⚠️ Data channel closed");
    };

    channel.onerror = (error) => {
      console.error("❌ Data channel error:", error);
    };

    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.callbacks.onDataMessage?.(data);
      } catch (error) {
        console.error("Failed to parse data message:", error);
      }
    };
  }

  // ===================================
  // PUBLIC API
  // ===================================

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async addICECandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error("Error adding ICE candidate:", error);
    }
  }

  sendControl(data: any): boolean {
    if (!this.controlChannel || this.controlChannel.readyState !== "open") {
      console.warn("Control channel not ready");
      return false;
    }

    try {
      this.controlChannel.send(JSON.stringify(data));
      return true;
    } catch (error) {
      console.error("Failed to send control message:", error);
      return false;
    }
  }

  sendData(data: any): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      console.warn("Data channel not ready");
      return false;
    }

    try {
      this.dataChannel.send(JSON.stringify(data));
      return true;
    } catch (error) {
      console.error("Failed to send data message:", error);
      return false;
    }
  }

  isConnected(): boolean {
    return (
      this.pc.connectionState === "connected" &&
      this.controlChannel?.readyState === "open" &&
      this.dataChannel?.readyState === "open"
    );
  }

  getConnectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  getBufferedAmount(): number {
    return (
      (this.dataChannel?.bufferedAmount || 0) +
      (this.controlChannel?.bufferedAmount || 0)
    );
  }

  private async handleConnectionFailure(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached");
      this.callbacks.onError?.(
        new Error("Connection failed after multiple attempts"),
      );
      return;
    }

    this.reconnectAttempts++;
    console.log(
      `Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`,
    );

    await new Promise((resolve) => setTimeout(resolve, this.reconnectDelay));

    // Close old connection
    this.close();

    // Create new connection
    this.pc = this.createPeerConnection();

    if (this.isSender) {
      this.createDataChannels();
    } else {
      this.setupDataChannelHandlers();
    }
  }

  close(): void {
    this.controlChannel?.close();
    this.dataChannel?.close();
    this.pc.close();
  }
}

// ===================================
// SIGNALING HELPERS
// ===================================

export async function handleWebRTCSignal(
  connection: WebRTCConnection,
  signal: RTCSignal,
  isSender: boolean,
): Promise<RTCSessionDescriptionInit | null> {
  try {
    if (signal.type === "offer" && signal.sdp) {
      await connection.handleOffer(signal.sdp);
      return await connection.createAnswer();
    } else if (signal.type === "answer" && signal.sdp) {
      await connection.handleAnswer(signal.sdp);
      return null;
    } else if (signal.type === "ice" && signal.candidate) {
      await connection.addICECandidate(signal.candidate);
      return null;
    }
  } catch (error) {
    console.error("Error handling WebRTC signal:", error);
    throw error;
  }

  return null;
}
