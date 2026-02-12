const isDev = import.meta.env.MODE === "development";

export const API_CONFIG = {
  // FIXED: Changed port from 4001 to 4000 to match backend default
  // Use the explicit IP to avoid the IPv6/IPv4 localhost confusion
  WS_URL: isDev
    ? "ws://127.0.0.1:4000/ws"
    : "wss://your-production-domain.com/ws",
  BASE_URL: isDev
    ? "http://127.0.0.1:4000"
    : "https://your-production-domain.com",
};

// Add connection health check utilities
export const CONNECTION_CONFIG = {
  PING_INTERVAL: 30000, // 30 seconds
  PING_TIMEOUT: 10000, // 10 seconds
  MAX_RECONNECT_ATTEMPTS: 10,
  RECONNECT_DELAY: 2000, // 2 seconds
  RECONNECT_BACKOFF_MULTIPLIER: 1.5,
  MAX_RECONNECT_DELAY: 30000, // 30 seconds max
};
