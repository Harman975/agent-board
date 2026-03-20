import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  ProjectArchiveData,
  ProjectCollaboratorsData,
  ProjectSettingsData,
  ProjectSummary,
  SprintState,
  WSEvent,
  applyWSEvent,
  TabId,
} from './types';
import { WSClient } from './ws';
import { ActionBar } from './components/ActionBar';
import { FeedPanel } from './components/FeedPanel';
import { LogsPanel } from './components/LogsPanel';
import { SprintLauncher } from './components/SprintLauncher';
import { Sidebar } from './components/Sidebar';
import { ChatPanel } from './components/ChatPanel';
import { NodeMap } from './components/NodeMap';
import { BoardPanel } from './components/BoardPanel';
import { ProjectsPanel } from './components/ProjectsPanel';
import { CollaboratorsPanel } from './components/CollaboratorsPanel';
import { ArchivePanel } from './components/ArchivePanel';
import { SettingsPanel } from './components/SettingsPanel';

export const App: React.FC = () => {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [sprint, setSprint] = useState<SprintState | null>(null);
  const [collaborators, setCollaborators] = useState<ProjectCollaboratorsData | null>(null);
  const [archive, setArchive] = useState<ProjectArchiveData | null>(null);
  const [settings, setSettings] = useState<ProjectSettingsData | null>(null);
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

  const fetchProjectPanels = useCallback(async (projectId?: string | null) => {
    const id = projectId ?? selectedProjectId;
    if (!id) {
      setCollaborators(null);
      setArchive(null);
      setSettings(null);
      return;
    }

    try {
      const [collabRes, archiveRes, settingsRes] = await Promise.all([
        fetch(`/data/projects/${encodeURIComponent(id)}/collaborators`),
        fetch(`/data/projects/${encodeURIComponent(id)}/archive`),
        fetch(`/data/projects/${encodeURIComponent(id)}/settings`),
      ]);

      if (collabRes.ok) setCollaborators(await collabRes.json());
      if (archiveRes.ok) setArchive(await archiveRes.json());
      if (settingsRes.ok) setSettings(await settingsRes.json());
    } catch {
      // best effort only
    }
  }, [selectedProjectId]);

  const handleEvent = useCallback((event: WSEvent) => {
    setSprint((prev) => applyWSEvent(prev, event));
    if (event.type !== 'log_line') {
      void fetchProjects();
      void fetchProjectPanels();
    }
  }, [fetchProjectPanels, fetchProjects]);

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
    fetchProjectPanels();
  }, [fetchProjectPanels]);

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
            fetchProjectPanels();
            pollRef.current = setInterval(() => {
              fetchProjects();
              fetchState();
              fetchProjectPanels();
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
  }, [fetchProjectPanels, fetchProjects, handleEvent, fetchState]);

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
            fetchProjectPanels();
          }}
          onClose={() => setShowLauncher(false)}
        />
      );
    }

    switch (activeTab) {
      case 'projects':
        return (
          <ProjectsPanel
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelectProject={(projectId) => {
              setSelectedProjectId(projectId);
              setActiveTab('board');
              setShowLauncher(false);
            }}
          />
        );
      case 'board':
        return (
          <BoardPanel
            sprint={sprint}
            projectName={selectedProject?.name ?? null}
            focusedIdeaId={focusedIdeaId}
          />
        );
      case 'collaborators':
        return <CollaboratorsPanel data={collaborators} />;
      case 'archive':
        return <ArchivePanel data={archive} />;
      case 'settings':
        return <SettingsPanel data={settings} />;
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
        activeTab={activeTab}
        onTabChange={(tab) => {
          setShowLauncher(false);
          setActiveTab(tab);
        }}
        onToggleChat={() => setChatOpen((value) => !value)}
        chatOpen={chatOpen}
        onToggleAdvanced={() => setAdvancedMode((value) => !value)}
        advancedOpen={advancedMode}
      />
      <div className="app-body">
        <Sidebar
          projects={projects}
          selectedProjectId={selectedProjectId}
          activeTab={activeTab}
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
          <main>
            {renderPanel()}
          </main>
        </div>
        <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
      </div>
    </div>
  );
};
