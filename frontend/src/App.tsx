import React, { useEffect, useRef, useState, useCallback } from 'react';
import { SprintState, WSEvent, applyWSEvent, TabId } from './types';
import { WSClient } from './ws';
import { ActionBar } from './components/ActionBar';
import { KanbanBoard } from './components/KanbanBoard';
import { TabBar } from './components/TabBar';
import { FeedPanel } from './components/FeedPanel';
import { LogsPanel } from './components/LogsPanel';
import { SprintLauncher } from './components/SprintLauncher';
import { LandingBrief } from './components/LandingBrief';
import { Sidebar } from './components/Sidebar';
import { ChatPanel } from './components/ChatPanel';
import { NodeMap } from './components/NodeMap';

export const App: React.FC = () => {
  const [sprint, setSprint] = useState<SprintState | null>(null);
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('kanban');
  const [showLauncher, setShowLauncher] = useState(false);
  const [showBrief, setShowBrief] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleEvent = useCallback((event: WSEvent) => {
    setSprint((prev) => applyWSEvent(prev, event));
  }, []);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/feed');
      if (res.ok) {
        const data: SprintState = await res.json();
        setSprint(data);
      }
    } catch {
      // polling failed, will retry
    }
  }, []);

  useEffect(() => {
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
          if (!pollRef.current) {
            fetchState();
            pollRef.current = setInterval(fetchState, 5000);
          }
        } else {
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

  const renderPanel = () => {
    if (showLauncher) {
      return (
        <SprintLauncher
          onSwitchTab={(tab) => { setShowLauncher(false); setActiveTab(tab); }}
          onClose={() => setShowLauncher(false)}
        />
      );
    }
    if (showBrief && sprint) {
      return (
        <LandingBrief
          sprintName={sprint.name}
          onClose={() => setShowBrief(false)}
        />
      );
    }
    switch (activeTab) {
      case 'kanban':
        return <KanbanBoard agents={sprint?.agents ?? []} />;
      case 'feed':
        return <FeedPanel />;
      case 'logs':
        return <LogsPanel agents={sprint?.agents ?? []} />;
      case 'architecture':
        return <NodeMap />;
    }
  };

  return (
    <div className="app">
      <ActionBar sprint={sprint} connected={connected} onToggleChat={() => setChatOpen((v) => !v)} chatOpen={chatOpen} />
      <div className="app-body">
        <Sidebar
          sprint={sprint}
          connected={connected}
          onNewSprint={() => setShowLauncher(true)}
          onLand={() => setShowBrief(true)}
        />
        <div className="main-content">
          <TabBar activeTab={activeTab} onTabChange={(tab) => { setShowLauncher(false); setShowBrief(false); setActiveTab(tab); }} />
          <main>
            {renderPanel()}
          </main>
        </div>
        <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
      </div>
    </div>
  );
};
