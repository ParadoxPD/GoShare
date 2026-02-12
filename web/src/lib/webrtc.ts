// ===================================
// WEBRTC CONNECTION MANAGER - IMPROVED
// Enhanced error handling, state management, and key exchange
// ===================================

import type { RTCSignal } from "../types";
import {
  deriveSharedSecret,
  exportAESKey,
  exportPublicKey,
  generateECDHKeyPair,
  importPublicKey,
} from "./crypto";
import { log } from "./utils";

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
  ],
  iceCandidatePoolSize: 10,
};

export interface WebRTCCallbacks {
  onControlMessage?: (data: any) => void;
  onDataMessage?: (data: any) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onICECandidate?: (candidate: RTCIceCandidate) => void;
  onError?: (error: Error) => void;
  onKeyExchangeComplete?: (sharedSecret: string) => void;
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
  private iceGatheringTimeout: ReturnType<typeof setTimeout> | null = null;
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;

  private ecdhKeyPair: CryptoKeyPair | null = null;
  private sharedSecret: CryptoKey | null = null;
  private sharedSecretString: string | null = null;
  private keyExchangeComplete = false;
  private pendingMessages: any[] = [];

  constructor(isSender: boolean, callbacks: WebRTCCallbacks = {}) {
    this.isSender = isSender;
    this.callbacks = callbacks;
    this.pc = this.createPeerConnection();

    // Generate ECDH key pair immediately
    this.initializeKeyExchange().catch((error) => {
      log(`Failed to initialize key exchange: ${error}`, "error");
      this.callbacks.onError?.(new Error("Key exchange initialization failed"));
    });

    if (isSender) {
      this.createDataChannels();
    } else {
      this.setupDataChannelHandlers();
    }

    // Set connection timeout
    this.setConnectionTimeout();
  }

  private async initializeKeyExchange(): Promise<void> {
    try {
      log("🔐 Generating ECDH key pair...", "info");
      this.ecdhKeyPair = await generateECDHKeyPair();
      log("✅ ECDH key pair generated", "success");
    } catch (error) {
      log(`❌ ECDH key generation failed: ${error}`, "error");
      throw error;
    }
  }

  private createPeerConnection(): RTCPeerConnection {
    let pc: RTCPeerConnection;

    try {
      pc = new RTCPeerConnection(RTC_CONFIG);
      log("✅ PeerConnection created", "success");
    } catch (error) {
      log(`❌ Failed to create PeerConnection: ${error}`, "error");
      throw error;
    }

    // ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        log(`📡 ICE candidate: ${event.candidate.type}`, "info");
        this.callbacks.onICECandidate?.(event.candidate);
      }
    };

    // ICE gathering state
    pc.onicegatheringstatechange = () => {
      log(`ICE gathering state: ${pc.iceGatheringState}`, "info");

      if (pc.iceGatheringState === "complete") {
        if (this.iceGatheringTimeout) {
          clearTimeout(this.iceGatheringTimeout);
          this.iceGatheringTimeout = null;
        }
      }
    };

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
      log(`🔌 WebRTC connection state: ${pc.connectionState}`, "info");
      this.callbacks.onConnectionStateChange?.(pc.connectionState);

      switch (pc.connectionState) {
        case "connected":
          this.reconnectAttempts = 0;
          if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
          }
          log("✅ WebRTC connected successfully", "success");
          break;

        case "disconnected":
          log("⚠️ WebRTC disconnected", "warning");
          // Don't immediately fail - might reconnect
          break;

        case "failed":
          log("❌ WebRTC connection failed", "error");
          this.handleConnectionFailure();
          break;

        case "closed":
          log("🔌 WebRTC connection closed", "info");
          break;
      }
    };

    // ICE connection state
    pc.oniceconnectionstatechange = () => {
      log(`❄️ ICE connection state: ${pc.iceConnectionState}`, "info");

      if (pc.iceConnectionState === "failed") {
        log("❌ ICE connection failed - attempting ICE restart", "error");
        this.restartICE();
      }
    };

    // Track events for debugging
    pc.onnegotiationneeded = () => {
      log("🤝 Negotiation needed", "info");
    };

    pc.onsignalingstatechange = () => {
      log(`📶 Signaling state: ${pc.signalingState}`, "info");
    };

    return pc;
  }

  private setConnectionTimeout(): void {
    // Set a timeout for the entire connection process
    this.connectionTimeout = setTimeout(() => {
      if (this.pc.connectionState !== "connected") {
        log("⏱️ WebRTC connection timeout", "error");
        this.callbacks.onError?.(new Error("Connection timeout"));
        this.handleConnectionFailure();
      }
    }, 30000); // 30 seconds
  }

  private createDataChannels(): void {
    try {
      // CONTROL CHANNEL: Reliable, ordered
      this.controlChannel = this.pc.createDataChannel("control", {
        ordered: true,
        maxRetransmits: 3,
      });

      // DATA CHANNEL: Unreliable, unordered for performance
      this.dataChannel = this.pc.createDataChannel("data", {
        ordered: false,
        maxRetransmits: 0,
      });

      this.setupControlChannel(this.controlChannel);
      this.setupDataChannel(this.dataChannel);

      log("✅ Data channels created (sender)", "success");
    } catch (error) {
      log(`❌ Failed to create data channels: ${error}`, "error");
      this.callbacks.onError?.(new Error("Data channel creation failed"));
    }
  }

  private setupDataChannelHandlers(): void {
    this.pc.ondatachannel = (event) => {
      const channel = event.channel;
      log(`📨 Received data channel: ${channel.label}`, "info");

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
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      log("✅ Control channel opened", "success");
      this.callbacks.onChannelOpen?.();

      // Send any pending messages
      this.flushPendingMessages();
    };

    channel.onclose = () => {
      log("⚠️ Control channel closed", "warning");
    };

    channel.onerror = (error) => {
      log(`❌ Control channel error: ${error}`, "error");
      console.error("Control channel error details:", error);
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
        log(`Failed to parse control message: ${error}`, "error");
        console.error("Control message error:", error, "Data:", event.data);
      }
    };
  }

  async exchangeKeys(): Promise<void> {
    if (!this.ecdhKeyPair) {
      log("⚠️ ECDH key pair not ready, waiting...", "warning");

      // Wait for key pair to be ready
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (this.ecdhKeyPair) break;
      }

      if (!this.ecdhKeyPair) {
        throw new Error("ECDH key pair initialization timeout");
      }
    }

    try {
      const publicKeyBase64 = await exportPublicKey(this.ecdhKeyPair.publicKey);

      const sent = this.sendControl({
        t: "ecdh_public_key",
        publicKey: publicKeyBase64,
      });

      if (sent) {
        log("✨ Sent ECDH public key to peer", "success");
      } else {
        log("⚠️ Failed to send ECDH public key - queuing", "warning");
        // It will be sent when channel opens
      }
    } catch (error) {
      log(`❌ Failed to exchange keys: ${error}`, "error");
      throw error;
    }
  }

  private async handlePeerPublicKey(publicKeyBase64: string): Promise<void> {
    if (!this.ecdhKeyPair) {
      log("❌ ECDH key pair not initialized", "error");
      return;
    }

    try {
      log("✨ Received peer's ECDH public key", "info");

      const peerPublicKey = await importPublicKey(publicKeyBase64);
      this.sharedSecret = await deriveSharedSecret(
        this.ecdhKeyPair.privateKey,
        peerPublicKey,
      );

      this.sharedSecretString = await exportAESKey(this.sharedSecret);
      this.keyExchangeComplete = true;

      log("✅ ECDH key exchange complete", "success");

      // Notify application
      this.callbacks.onKeyExchangeComplete?.(this.sharedSecretString);

      // Receiver sends their public key in response
      if (!this.isSender) {
        await this.exchangeKeys();
      }
    } catch (error) {
      log(`❌ Key exchange failed: ${error}`, "error");
      console.error("Key exchange error details:", error);
      this.callbacks.onError?.(new Error("Key exchange failed"));
    }
  }

  getSharedSecret(): string | null {
    return this.sharedSecretString;
  }

  isKeyExchangeComplete(): boolean {
    return this.keyExchangeComplete;
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      log("✅ Data channel opened", "success");
    };

    channel.onclose = () => {
      log("⚠️ Data channel closed", "warning");
    };

    channel.onerror = (error) => {
      log(`❌ Data channel error: ${error}`, "error");
      console.error("Data channel error details:", error);
    };

    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.callbacks.onDataMessage?.(data);
      } catch (error) {
        log(`Failed to parse data message: ${error}`, "error");
        console.error("Data message error:", error);
      }
    };

    // Monitor buffer
    channel.onbufferedamountlow = () => {
      log("📉 Data channel buffer low", "info");
    };
  }

  // ===================================
  // PUBLIC API
  // ===================================

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    try {
      const offer = await this.pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });

      await this.pc.setLocalDescription(offer);
      log("✅ Created and set local offer", "success");

      // Set timeout for ICE gathering
      this.setICEGatheringTimeout();

      return offer;
    } catch (error) {
      log(`❌ Failed to create offer: ${error}`, "error");
      throw error;
    }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    try {
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      log("✅ Created and set local answer", "success");

      // Set timeout for ICE gathering
      this.setICEGatheringTimeout();

      return answer;
    } catch (error) {
      log(`❌ Failed to create answer: ${error}`, "error");
      throw error;
    }
  }

  private setICEGatheringTimeout(): void {
    this.iceGatheringTimeout = setTimeout(() => {
      if (this.pc.iceGatheringState !== "complete") {
        log("⏱️ ICE gathering timeout - proceeding anyway", "warning");
      }
    }, 5000); // 5 seconds
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      log("✅ Set remote offer", "success");
    } catch (error) {
      log(`❌ Failed to handle offer: ${error}`, "error");
      throw error;
    }
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      log("✅ Set remote answer", "success");
    } catch (error) {
      log(`❌ Failed to handle answer: ${error}`, "error");
      throw error;
    }
  }

  async addICECandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      log("✅ Added ICE candidate", "success");
    } catch (error) {
      // ICE candidates can fail to add sometimes - log but don't throw
      log(`⚠️ Failed to add ICE candidate: ${error}`, "warning");
      console.warn("ICE candidate error:", error);
    }
  }

  sendControl(data: any): boolean {
    if (!this.controlChannel || this.controlChannel.readyState !== "open") {
      log("⚠️ Control channel not ready - queueing message", "warning");
      this.pendingMessages.push({ channel: "control", data });
      return false;
    }

    try {
      this.controlChannel.send(JSON.stringify(data));
      return true;
    } catch (error) {
      log(`❌ Failed to send control message: ${error}`, "error");
      console.error("Control send error:", error, "Data:", data);
      return false;
    }
  }

  sendData(data: any): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      log("⚠️ Data channel not ready", "warning");
      return false;
    }

    try {
      this.dataChannel.send(JSON.stringify(data));
      return true;
    } catch (error) {
      log(`❌ Failed to send data message: ${error}`, "error");
      console.error("Data send error:", error);
      return false;
    }
  }

  private flushPendingMessages(): void {
    if (this.pendingMessages.length === 0) return;

    log(`📤 Flushing ${this.pendingMessages.length} pending messages`, "info");

    const messages = [...this.pendingMessages];
    this.pendingMessages = [];

    messages.forEach(({ channel, data }) => {
      if (channel === "control") {
        this.sendControl(data);
      } else {
        this.sendData(data);
      }
    });
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
      log("❌ Max WebRTC reconnection attempts reached", "error");
      this.callbacks.onError?.(
        new Error("Connection failed after multiple attempts"),
      );
      return;
    }

    this.reconnectAttempts++;
    log(
      `🔄 WebRTC reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`,
      "info",
    );

    // Try ICE restart first
    await this.restartICE();
  }

  private async restartICE(): Promise<void> {
    if (this.pc.connectionState === "closed") {
      log("Cannot restart ICE - connection closed", "warning");
      return;
    }

    try {
      log("🔄 Attempting ICE restart...", "info");

      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);

      // Notify via callback that we need to send new offer
      log("✅ ICE restart initiated", "success");
    } catch (error) {
      log(`❌ ICE restart failed: ${error}`, "error");
    }
  }

  close(): void {
    log("🔌 Closing WebRTC connection", "info");

    if (this.iceGatheringTimeout) {
      clearTimeout(this.iceGatheringTimeout);
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }

    this.controlChannel?.close();
    this.dataChannel?.close();
    this.pc.close();

    this.keyExchangeComplete = false;
    this.sharedSecret = null;
    this.sharedSecretString = null;
    this.pendingMessages = [];
  }

  // ===================================
  // DIAGNOSTIC METHODS
  // ===================================

  getStats() {
    return {
      connectionState: this.pc.connectionState,
      iceConnectionState: this.pc.iceConnectionState,
      iceGatheringState: this.pc.iceGatheringState,
      signalingState: this.pc.signalingState,
      controlChannelState: this.controlChannel?.readyState || "none",
      dataChannelState: this.dataChannel?.readyState || "none",
      bufferedAmount: this.getBufferedAmount(),
      keyExchangeComplete: this.keyExchangeComplete,
      pendingMessages: this.pendingMessages.length,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}
