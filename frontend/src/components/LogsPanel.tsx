import React, { useEffect, useRef, useState } from 'react';
import { AgentTile } from '../types';

interface LogsPanelProps {
  agents: AgentTile[];
}

export const LogsPanel: React.FC<LogsPanelProps> = ({ agents }) => {
  const [selectedHandle, setSelectedHandle] = useState<string>('');
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (logEndRef.current && typeof logEndRef.current.scrollIntoView === 'function') {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines]);

  // Fetch initial logs and subscribe to WS
  useEffect(() => {
    if (!selectedHandle) {
      setLines([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLines([]);

    // Fetch existing logs
    (async () => {
      try {
        const res = await fetch(`/data/logs/${encodeURIComponent(selectedHandle)}?lines=50`);
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            const logLines: string[] = Array.isArray(data.log) ? data.log : (data.log ?? '').split('\n');
            setLines(logLines);
          }
        }
      } catch {
        // fetch failed
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    // Subscribe to live logs via WebSocket
    const wsUrl =
      (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
      window.location.host +
      '/ws';

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ subscribe_logs: selectedHandle }));
      };

      ws.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data as string);
          if (event.type === 'log_line' && event.data?.handle === selectedHandle) {
            if (!cancelled) {
              setLines((prev) => [...prev, event.data.line as string]);
            }
          }
        } catch {
          // ignore malformed
        }
      };

      ws.onerror = () => ws.close();
    } catch {
      // WS connection failed
    }

    return () => {
      cancelled = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [selectedHandle]);

  return (
    <div className="logs-panel">
      <div className="logs-header">
        <label>
          Agent:
          <select
            value={selectedHandle}
            onChange={(e) => setSelectedHandle(e.target.value)}
            aria-label="Select agent"
          >
            <option value="">Select an agent...</option>
            {agents.map((a) => (
              <option key={a.handle} value={a.handle}>{a.handle}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="logs-terminal" role="log" aria-label="Agent logs">
        {loading && <p className="logs-loading">Loading logs...</p>}
        {!loading && !selectedHandle && (
          <p className="logs-placeholder">Select an agent to view logs</p>
        )}
        {lines.map((line, i) => (
          <pre key={i} className="log-line">{line}</pre>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  );
};
