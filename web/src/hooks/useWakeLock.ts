import { useEffect, useRef } from "react";
import { log } from "../lib/utils";

/**
 * Hook to request wake lock on mobile devices
 * Prevents screen from turning off during file transfers
 */
export function useWakeLock() {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const requestWakeLock = async () => {
    if (!("wakeLock" in navigator)) {
      log("Wake Lock API not supported", "warning");
      return;
    }

    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
      log("Wake lock activated", "success");

      wakeLockRef.current.addEventListener("release", () => {
        log("Wake lock released", "info");
      });
    } catch (error) {
      log(`Wake lock error: ${error}`, "warning");
    }
  };

  const releaseWakeLock = () => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release();
      wakeLockRef.current = null;
    }
  };

  useEffect(() => {
    // Request wake lock on mount
    requestWakeLock();

    // Handle visibility change
    const handleVisibilityChange = () => {
      if (document.hidden) {
        log("App backgrounded - maintaining connection", "info");
      } else {
        log("App foregrounded", "info");
        // Re-request wake lock if it was released
        if (!wakeLockRef.current) {
          requestWakeLock();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Cleanup
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      releaseWakeLock();
    };
  }, []);

  return {
    requestWakeLock,
    releaseWakeLock,
  };
}
