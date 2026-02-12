// ===================================
// UNIFIED EVENT BUS
// ===================================

import type { ConnectionState } from "./connection-state";

export type AppEventMap = {
  "connection:ws_state": { state: ConnectionState; reason?: string };
  "connection:rtc_state": { state: RTCPeerConnectionState; reason?: string };
  "connection:ready": { websocket: boolean; webrtc: boolean };
  "connection:error": { scope: "ws" | "rtc" | "transfer" | "message"; message: string };
  "message:send_failed": { messageId: string; reason: string };
  "message:sent": { messageId: string };
  "transfer:error": { fileId?: string; fileName?: string; reason: string };
  "transfer:progress": { fileId: string; progress: number; speed?: number };
  "transfer:complete": { fileId: string; fileName?: string };
};

type EventName = keyof AppEventMap;
type Listener<K extends EventName> = (payload: AppEventMap[K]) => void;

class EventBus {
  private listeners = new Map<EventName, Set<(payload: unknown) => void>>();

  on<K extends EventName>(event: K, listener: Listener<K>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    const wrapped = listener as (payload: unknown) => void;
    this.listeners.get(event)?.add(wrapped);

    return () => {
      this.listeners.get(event)?.delete(wrapped);
      if (this.listeners.get(event)?.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  once<K extends EventName>(event: K, listener: Listener<K>): () => void {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  emit<K extends EventName>(event: K, payload: AppEventMap[K]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;

    handlers.forEach((handler) => {
      try {
        handler(payload);
      } catch (error) {
        console.error(`Error handling event "${event}"`, error);
      }
    });
  }

  clear(event?: EventName): void {
    if (event) {
      this.listeners.delete(event);
      return;
    }
    this.listeners.clear();
  }
}

export const eventBus = new EventBus();
