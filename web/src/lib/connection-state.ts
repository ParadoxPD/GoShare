// ===================================
// CONNECTION STATE MACHINE
// ===================================

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "degraded"
  | "failed"
  | "closed";

export interface StateTransition {
  from: ConnectionState;
  to: ConnectionState;
  timestamp: number;
  reason?: string;
}

const VALID_TRANSITIONS: Record<ConnectionState, ConnectionState[]> = {
  disconnected: ["connecting", "closed"],
  connecting: ["connected", "failed", "reconnecting", "closed"],
  connected: ["disconnected", "degraded", "reconnecting", "failed", "closed"],
  reconnecting: ["connected", "failed", "closed"],
  degraded: ["connected", "disconnected", "reconnecting", "failed", "closed"],
  failed: ["connecting", "disconnected", "reconnecting", "closed"],
  closed: ["connecting"],
};

export class ConnectionStateMachine {
  private state: ConnectionState = "disconnected";
  private history: StateTransition[] = [];

  constructor(initial: ConnectionState = "disconnected") {
    this.state = initial;
  }

  canTransition(to: ConnectionState): boolean {
    return VALID_TRANSITIONS[this.state].includes(to);
  }

  transition(to: ConnectionState, reason?: string): StateTransition {
    const from = this.state;
    if (!this.canTransition(to) && from !== to) {
      throw new Error(`Invalid transition: ${from} -> ${to}`);
    }

    const transition: StateTransition = {
      from,
      to,
      timestamp: Date.now(),
      reason,
    };
    this.state = to;
    this.history.push(transition);

    if (this.history.length > 100) {
      this.history.shift();
    }

    return transition;
  }

  get current(): ConnectionState {
    return this.state;
  }

  getHistory(): StateTransition[] {
    return [...this.history];
  }
}
