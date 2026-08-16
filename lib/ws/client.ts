'use client';
// Browser-side hook the dashboard uses to subscribe to the worker's live
// events, with reconnect/backoff. Pure client code - never imports lib/db.ts
// or anything server-only.
import { useEffect, useRef, useState } from 'react';

export interface WorkerMessage {
  event: string;
  payload: unknown;
}

export function useWorkerSocket(port: number, onMessage: (msg: WorkerMessage) => void) {
  const [connected, setConnected] = useState(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(`ws://127.0.0.1:${port}`);

      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) reconnectTimer = setTimeout(connect, 2000);
      };
      socket.onerror = () => socket?.close();
      socket.onmessage = (ev) => {
        try {
          onMessageRef.current(JSON.parse(ev.data));
        } catch {
          // ignore malformed frames
        }
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [port]);

  return { connected };
}
