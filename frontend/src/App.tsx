import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ProjectSummary, SprintState, WSEvent, applyWSEvent, TabId } from './types';
import { WSClient } from './ws';
import { ActionBar } from './components/ActionBar';
import { TabBar } from './components/TabBar';
import { FeedPanel } from './components/FeedPanel';
import { LogsPanel } from './components/LogsPanel';
import { SprintLauncher } from './components/SprintLauncher';
import { Sidebar } from './components/Sidebar';
import { ChatPanel } from './components/ChatPanel';
import { NodeMap } from './components/NodeMap';
import { BoardPanel } from './components/BoardPanel';

export const App: React.FC = () => {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [sprint, setSprint] = useState<SprintState | null>(null);
  const [focusedIdeaId, setFocusedIdeaId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('board');
  const [showLauncher, setShowLauncher] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [advancedMode, setAdvancedMode] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/data/projects');
      if (!res.ok) return;
      const data: ProjectSummary[] = await res.json();
      setProjects(data);
      setSelectedProjectId((prev) => {
        if (prev && data.some((project) => project.id === prev)) {
          return prev;
        }
        return data[0]?.id ?? null;
      });
    } catch {
      // best effort only
    }
  }, []);

  const handleEvent = useCallback((event: WSEvent) => {
    setSprint((prev) => applyWSEvent(prev, event));
    if (event.type !== 'log_line') {
      void fetchProjects();
    }
  }, [fetchProjects]);

  const fetchState = useCallback(async (projectId?: string | null) => {
    try {
      const team = projectId ?? selectedProjectId;
      const query = team ? `?team=${encodeURIComponent(team)}` : '';
      const res = await fetch(`/data/sprint/latest${query}`);
      if (res.ok) {
        const data = await res.json();
        setSprint(data);
        if (!data) {
          setFocusedIdeaId(null);
        }
      }
    } catch {
      // polling failed, will retry
    }
  }, [selectedProjectId]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  useEffect(() => {
    setFocusedIdeaId(null);
  }, [selectedProjectId]);

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
            fetchProjects();
            fetchState();
            pollRef.current = setInterval(() => {
              fetchProjects();
              fetchState();
            }, 5000);
          }
        } else if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
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
  }, [fetchProjects, handleEvent, fetchState]);

  useEffect(() => {
    if (!advancedMode && (activeTab === 'logs' || activeTab === 'architecture')) {
      setActiveTab('board');
    }
  }, [advancedMode, activeTab]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;

  const renderPanel = () => {
    if (showLauncher) {
      return (
        <SprintLauncher
          projectId={selectedProject?.id ?? null}
          projectName={selectedProject?.id === '__general__' ? 'General' : selectedProject?.name}
          onSwitchTab={(tab) => {
            setShowLauncher(false);
            setActiveTab(tab);
            fetchProjects();
            fetchState();
          }}
          onClose={() => setShowLauncher(false)}
        />
      );
    }

    switch (activeTab) {
      case 'board':
        return (
          <BoardPanel
            sprint={sprint}
            projectName={selectedProject?.name ?? null}
            focusedIdeaId={focusedIdeaId}
          />
        );
      case 'timeline':
        return <FeedPanel />;
      case 'logs':
        return <LogsPanel agents={sprint?.agents ?? []} />;
      case 'architecture':
        return <NodeMap />;
    }
  };

  return (
    <div className="app">
      <ActionBar
        sprint={sprint}
        projectName={selectedProject?.name ?? null}
        connected={connected}
        onToggleChat={() => setChatOpen((value) => !value)}
        chatOpen={chatOpen}
        onToggleAdvanced={() => setAdvancedMode((value) => !value)}
        advancedOpen={advancedMode}
      />
      <div className="app-body">
        <Sidebar
          projects={projects}
          selectedProjectId={selectedProjectId}
          sprint={sprint}
          connected={connected}
          onNewSprint={() => setShowLauncher(true)}
          onSelectProject={(projectId) => {
            setShowLauncher(false);
            setActiveTab('board');
            setSprint(null);
            setSelectedProjectId(projectId);
          }}
          onFocusIdea={(ideaId) => {
            setFocusedIdeaId(ideaId);
          }}
          onOpenTab={(tab) => {
            setShowLauncher(false);
            setActiveTab(tab);
          }}
          advancedMode={advancedMode}
        />
        <div className="main-content">
          <TabBar
            activeTab={activeTab}
            onTabChange={(tab) => {
              setShowLauncher(false);
              setActiveTab(tab);
            }}
            advancedMode={advancedMode}
          />
          <main>
            {renderPanel()}
          </main>
        </div>
        <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
      </div>
    </div>
  );
};
