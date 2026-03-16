import React, { useEffect, useRef, useState, useCallback } from 'react';
import { SprintState, WSEvent, applyWSEvent } from './types';
import { WSClient } from './ws';
import { ActionBar } from './components/ActionBar';
import { KanbanBoard } from './components/KanbanBoard';

export const App: React.FC = () => {
  const [sprint, setSprint] = useState<SprintState | null>(null);
  const [connected, setConnected] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleEvent = useCallback((event: WSEvent) => {
    setSprint((prev) => applyWSEvent(prev, event));
  }, []);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/data/sprint/latest');
      if (res.ok) {
        const data = await res.json();
        if (data) setSprint(data);
      }
    } catch {
      // polling failed, will retry
    }
  }, []);

  useEffect(() => {
    // Fetch initial state via REST (WebSocket will also send initial_state)
    fetchState();

    const wsUrl =
      (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
      window.location.host +
      '/ws';

    const client = new WSClient({
      url: wsUrl,
      onEvent: handleEvent,
      onConnectionChange: (isConnected) => {
        setConnected(isConnected);
        if (!isConnected) {
          // Start polling fallback
          if (!pollRef.current) {
            fetchState();
            pollRef.current = setInterval(fetchState, 5000);
          }
        } else {
          // Stop polling when WebSocket reconnects
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      },
    });

    client.connect();

    return () => {
      client.disconnect();
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, [handleEvent, fetchState]);

  return (
    <div className="app">
      <ActionBar sprint={sprint} connected={connected} />
      <main>
        <KanbanBoard agents={sprint?.agents ?? []} sprintName={sprint?.name} />
      </main>
    </div>
  );
};
