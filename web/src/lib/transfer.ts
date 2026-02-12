// ===================================
// FILE TRANSFER PROTOCOL
// BitTorrent-style implementation over WebRTC
// ===================================

import type {
  ControlMsg,
  DataChunk,
  FileOfferMsg,
  FileAcceptMsg,
  AckMsg,
  SenderState,
  ReceiverState,
} from "../types";
import {
  encryptChunk,
  decryptChunk,
  calculateFileSHA256,
  calculateChunksSHA256,
} from "./crypto";
import { putChunk, getChunk, getExistingChunks, deleteFileChunks } from "./db";
import { WebRTCConnection } from "./webrtc";
import { log } from "./utils";

// ===================================
// CONSTANTS
// ===================================

const CHUNK_SIZE = 256 * 1024; // 256KB for WebRTC
const WINDOW_SIZE = 128; // Sliding window size
const RESEND_TIMEOUT = 2000; // 2 seconds
const HEARTBEAT_INTERVAL = 3000; // 3 seconds
const HEARTBEAT_TIMEOUT = 10000; // 10 seconds
const ACK_BATCH_DELAY = 50; // 50ms batching window

// ===================================
// TRANSFER MANAGER
// ===================================

export class TransferManager {
  private connection: WebRTCConnection | null = null;
  private encryptionKey: string;
  private senders = new Map<string, SenderState>();
  private receivers = new Map<string, ReceiverState>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private ackBatches = new Map<string, number[]>();
  private ackTimer: NodeJS.Timeout | null = null;

  constructor(encryptionKey: string) {
    this.encryptionKey = encryptionKey;
  }

  setConnection(connection: WebRTCConnection): void {
    this.connection = connection;
    this.startHeartbeat();
  }

  // ===================================
  // SENDER: START FILE TRANSFER
  // ===================================

  async sendFile(
    file: File,
    callbacks?: {
      onProgress?: (progress: number, speed: number) => void;
      onComplete?: () => void;
      onError?: (error: string) => void;
    },
  ): Promise<string | null> {
    if (!this.connection || !this.connection.isConnected()) {
      callbacks?.onError?.("Not connected");
      return null;
    }

    const fileId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Calculate file hash for integrity verification
    log(`Calculating SHA-256 for ${file.name}...`, "info");
    const sha256 = await calculateFileSHA256(file);

    const state: SenderState = {
      file,
      fileId,
      sent: new Set(),
      acked: new Set(),
      totalChunks,
      windowSize: WINDOW_SIZE,
      lastHeartbeat: Date.now(),
      resendTimers: new Map(),
      startTime: Date.now(),
      pausedChunks: new Set(),
      ...callbacks,
    };

    this.senders.set(fileId, state);

    // Send file offer via control channel
    const offer: FileOfferMsg = {
      t: "file_offer",
      fileId,
      name: file.name,
      size: file.size,
      totalChunks,
      chunkSize: CHUNK_SIZE,
      sha256,
    };

    const sent = this.connection.sendControl(offer);
    if (!sent) {
      callbacks?.onError?.("Failed to send file offer");
      this.senders.delete(fileId);
      return null;
    }

    log(`Sent file offer: ${file.name} (${totalChunks} chunks)`, "success");
    return fileId;
  }

  // ===================================
  // SENDER: PUMP CHUNKS
  // ===================================

  private async pumpChunks(fileId: string): Promise<void> {
    const state = this.senders.get(fileId);
    if (!state || !this.connection) return;

    // Calculate progress
    const progress = state.acked.size / state.totalChunks;
    const elapsed = (Date.now() - state.startTime) / 1000;
    const speed = elapsed > 0 ? (state.acked.size * CHUNK_SIZE) / elapsed : 0;

    state.onProgress?.(progress * 100, speed);

    // Check if complete
    if (state.acked.size >= state.totalChunks) {
      log(`Transfer complete: ${state.file.name}`, "success");
      state.onComplete?.();
      this.cleanupSender(fileId);
      return;
    }

    // Check backpressure (buffered data in WebRTC)
    const buffered = this.connection.getBufferedAmount();
    if (buffered > 16 * 1024 * 1024) {
      // 16MB threshold
      log(`Backpressure detected (${buffered} bytes buffered)`, "warning");
      setTimeout(() => this.pumpChunks(fileId), 100);
      return;
    }

    // Send chunks within sliding window
    const inFlight = state.sent.size - state.acked.size;
    const canSend = state.windowSize - inFlight;

    for (let i = 0; i < canSend && state.sent.size < state.totalChunks; i++) {
      const nextChunk = this.findNextChunk(state);
      if (nextChunk === null) break;

      await this.sendChunk(fileId, nextChunk);
      state.sent.add(nextChunk);

      // Set resend timer
      const timer = setTimeout(() => {
        if (!state.acked.has(nextChunk)) {
          log(`Resending chunk ${nextChunk} for ${state.file.name}`, "warning");
          state.sent.delete(nextChunk);
          this.pumpChunks(fileId);
        }
      }, RESEND_TIMEOUT);

      state.resendTimers.set(nextChunk, timer);
    }
  }

  private findNextChunk(state: SenderState): number | null {
    for (let i = 0; i < state.totalChunks; i++) {
      if (!state.sent.has(i) && !state.pausedChunks.has(i)) {
        return i;
      }
    }
    return null;
  }

  private async sendChunk(fileId: string, index: number): Promise<void> {
    const state = this.senders.get(fileId);
    if (!state || !this.connection) return;

    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, state.file.size);
    const slice = state.file.slice(start, end);
    const buffer = await slice.arrayBuffer();

    // Encrypt with AAD (prevents chunk swapping)
    const aad = `${fileId}:${index}`;
    const encrypted = await encryptChunk(buffer, this.encryptionKey, aad);

    const chunk: DataChunk = {
      fileId,
      index,
      payload: encrypted,
      aad,
    };

    this.connection.sendData(chunk);
  }

  // ===================================
  // RECEIVER: SETUP
  // ===================================

  setupReceiver(
    offer: FileOfferMsg,
    callbacks?: {
      onProgress?: (progress: number) => void;
      onComplete?: (blob: Blob) => void;
      onError?: (error: string) => void;
    },
  ): void {
    const state: ReceiverState = {
      fileId: offer.fileId,
      name: offer.name,
      size: offer.size,
      totalChunks: offer.totalChunks,
      bitmap: new Set(),
      chunks: new Map(),
      sha256: offer.sha256,
      ...callbacks,
    };

    this.receivers.set(offer.fileId, state);
    log(`Receiving: ${offer.name} (${offer.totalChunks} chunks)`, "info");

    // Check for existing chunks in IndexedDB (resume support)
    this.checkExistingChunks(offer.fileId, offer.totalChunks);
  }

  private async checkExistingChunks(
    fileId: string,
    totalChunks: number,
  ): Promise<void> {
    const state = this.receivers.get(fileId);
    if (!state || !this.connection) return;

    const existing = await getExistingChunks(fileId, totalChunks);

    if (existing.length > 0) {
      log(`Found ${existing.length} existing chunks, resuming...`, "success");

      // Load chunks from IndexedDB
      for (const index of existing) {
        const chunk = await getChunk(fileId, index);
        if (chunk) {
          state.bitmap.add(index);
          state.chunks.set(index, chunk);
        }
      }
    }

    // Send file_accept with resume info
    const accept: FileAcceptMsg = {
      t: "file_accept",
      fileId,
      have: Array.from(state.bitmap),
    };

    this.connection.sendControl(accept);

    // Update progress
    const progress = (state.bitmap.size / state.totalChunks) * 100;
    state.onProgress?.(progress);
  }

  // ===================================
  // RECEIVER: HANDLE CHUNK
  // ===================================

  async handleReceivedChunk(chunk: DataChunk): Promise<void> {
    const state = this.receivers.get(chunk.fileId);
    if (!state) {
      log(`Received chunk for unknown file: ${chunk.fileId}`, "warning");
      return;
    }

    // Ignore if already received
    if (state.bitmap.has(chunk.index)) {
      return;
    }

    // Ignore if index is out of bounds
    if (chunk.index >= state.totalChunks) {
      log(`Invalid chunk index: ${chunk.index}`, "warning");
      return;
    }

    try {
      // Decrypt chunk with AAD verification
      const decrypted = await decryptChunk(
        chunk.payload,
        this.encryptionKey,
        chunk.aad,
      );

      // Store in IndexedDB for resume capability
      await putChunk(chunk.fileId, chunk.index, decrypted);

      // Update state
      state.bitmap.add(chunk.index);
      state.chunks.set(chunk.index, decrypted);

      // Send ACK (batched)
      this.queueAck(chunk.fileId, chunk.index);

      // Update progress
      const progress = (state.bitmap.size / state.totalChunks) * 100;
      state.onProgress?.(progress);

      // Check if complete
      if (state.bitmap.size === state.totalChunks) {
        await this.assembleFile(chunk.fileId);
      }
    } catch (error) {
      log(`Error processing chunk ${chunk.index}: ${error}`, "error");
      state.onError?.(`Failed to process chunk ${chunk.index}`);
    }
  }

  // ===================================
  // RECEIVER: ASSEMBLE FILE
  // ===================================

  private async assembleFile(fileId: string): Promise<void> {
    const state = this.receivers.get(fileId);
    if (!state) return;

    log(`Assembling file: ${state.name}`, "info");

    try {
      // Assemble chunks in order
      const orderedChunks: ArrayBuffer[] = [];
      for (let i = 0; i < state.totalChunks; i++) {
        const chunk = state.chunks.get(i);
        if (!chunk) {
          throw new Error(`Missing chunk ${i}`);
        }
        orderedChunks.push(chunk);
      }

      const blob = new Blob(orderedChunks);

      // Verify integrity if hash provided
      if (state.sha256) {
        log("Verifying file integrity...", "info");
        const calculatedHash = await calculateChunksSHA256(orderedChunks);

        if (calculatedHash !== state.sha256) {
          throw new Error("File integrity check failed - hash mismatch");
        }

        log("✅ File integrity verified", "success");
      }

      state.onComplete?.(blob);

      // Cleanup IndexedDB
      await deleteFileChunks(fileId);
      this.receivers.delete(fileId);

      log(`✅ File received: ${state.name}`, "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Assembly failed";
      log(`❌ ${message}`, "error");
      state.onError?.(message);
    }
  }

  // ===================================
  // CONTROL MESSAGE HANDLERS
  // ===================================

  handleControlMessage(msg: ControlMsg): void {
    switch (msg.t) {
      case "file_accept":
        this.handleFileAccept(msg);
        break;
      case "ack":
        this.handleAck(msg);
        break;
      case "ping":
        this.handlePing(msg);
        break;
      case "pong":
        this.handlePong(msg);
        break;
      case "slow_down":
        this.handleSlowDown(msg);
        break;
      case "resume":
        this.handleResume(msg);
        break;
      case "corrupt_chunks":
        this.handleCorruptChunks(msg);
        break;
    }
  }

  private handleFileAccept(msg: FileAcceptMsg): void {
    const state = this.senders.get(msg.fileId);
    if (!state) return;

    // Mark chunks as acked if receiver already has them
    msg.have.forEach((index) => {
      state.acked.add(index);

      // Clear any pending resend timer
      const timer = state.resendTimers.get(index);
      if (timer) {
        clearTimeout(timer);
        state.resendTimers.delete(index);
      }
    });

    if (msg.have.length > 0) {
      log(
        `Receiver already has ${msg.have.length} chunks, resuming...`,
        "info",
      );
    }

    // Start pumping chunks
    this.pumpChunks(msg.fileId);
  }

  private handleAck(msg: AckMsg): void {
    const state = this.senders.get(msg.fileId);
    if (!state) return;

    msg.received.forEach((index) => {
      state.acked.add(index);

      // Clear resend timer
      const timer = state.resendTimers.get(index);
      if (timer) {
        clearTimeout(timer);
        state.resendTimers.delete(index);
      }
    });

    // Continue pumping
    this.pumpChunks(msg.fileId);
  }

  private handlePing(msg: { t: "ping"; timestamp: number }): void {
    if (!this.connection) return;

    // Respond with pong
    this.connection.sendControl({
      t: "pong",
      timestamp: msg.timestamp,
    });
  }

  private handlePong(msg: { t: "pong"; timestamp: number }): void {
    // Update last heartbeat time for all active transfers
    this.senders.forEach((state) => {
      state.lastHeartbeat = Date.now();
    });
  }

  private handleSlowDown(msg: {
    t: "slow_down";
    fileId: string;
    window: number;
  }): void {
    const state = this.senders.get(msg.fileId);
    if (!state) return;

    state.windowSize = Math.max(16, msg.window);
    log(`Reducing window size to ${state.windowSize}`, "warning");
  }

  private handleResume(msg: { t: "resume"; fileId: string }): void {
    // Receiver wants to resume - restart pumping
    if (msg.fileId) {
      this.pumpChunks(msg.fileId);
    } else {
      // Resume all transfers
      this.senders.forEach((_, fileId) => {
        this.pumpChunks(fileId);
      });
    }
  }

  private handleCorruptChunks(msg: {
    t: "corrupt_chunks";
    fileId: string;
    chunks: number[];
  }): void {
    const state = this.senders.get(msg.fileId);
    if (!state) return;

    log(`Resending ${msg.chunks.length} corrupted chunks`, "warning");

    // Mark chunks as not sent so they'll be resent
    msg.chunks.forEach((index) => {
      state.sent.delete(index);
      state.acked.delete(index);
    });

    this.pumpChunks(msg.fileId);
  }

  // ===================================
  // ACK BATCHING
  // ===================================

  private queueAck(fileId: string, chunkIndex: number): void {
    const batch = this.ackBatches.get(fileId) || [];
    batch.push(chunkIndex);
    this.ackBatches.set(fileId, batch);

    // Debounce sending
    if (this.ackTimer) clearTimeout(this.ackTimer);

    this.ackTimer = setTimeout(() => {
      this.flushAcks();
    }, ACK_BATCH_DELAY);
  }

  private flushAcks(): void {
    if (!this.connection) return;

    this.ackBatches.forEach((chunks, fileId) => {
      const ack: AckMsg = {
        t: "ack",
        fileId,
        received: chunks,
      };

      this.connection!.sendControl(ack);
    });

    this.ackBatches.clear();
    this.ackTimer = null;
  }

  // ===================================
  // HEARTBEAT
  // ===================================

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      if (!this.connection || !this.connection.isConnected()) return;

      // Send ping
      this.connection.sendControl({
        t: "ping",
        timestamp: Date.now(),
      });

      // Check for stale connections
      const now = Date.now();
      this.senders.forEach((state, fileId) => {
        if (now - state.lastHeartbeat > HEARTBEAT_TIMEOUT) {
          log(`Connection stale for ${state.file.name}`, "warning");

          // Pause sending
          state.sent.forEach((index) => {
            if (!state.acked.has(index)) {
              state.pausedChunks.add(index);
            }
          });
        }
      });
    }, HEARTBEAT_INTERVAL);
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // ===================================
  // CLEANUP
  // ===================================

  private cleanupSender(fileId: string): void {
    const state = this.senders.get(fileId);
    if (!state) return;

    // Clear all resend timers
    state.resendTimers.forEach((timer) => clearTimeout(timer));
    state.resendTimers.clear();

    this.senders.delete(fileId);
  }

  cleanup(): void {
    this.stopHeartbeat();

    // Clear all resend timers
    this.senders.forEach((state) => {
      state.resendTimers.forEach((timer) => clearTimeout(timer));
    });

    // Clear ACK timer
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
    }

    this.senders.clear();
    this.receivers.clear();
    this.ackBatches.clear();
  }
}
