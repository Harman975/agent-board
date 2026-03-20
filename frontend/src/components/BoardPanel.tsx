import React, { useEffect, useMemo, useState } from 'react';
import { LandingBriefData, SprintState } from '../types';
import { buildBoardModel, type BoardTileModel } from '../presentation';

interface BoardPanelProps {
  sprint: SprintState | null;
  projectName?: string | null;
  focusedIdeaId?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Map tile tone to a tag pill CSS modifier class. */
function tagPillClass(tone: string): string {
  if (tone === 'in_progress' || tone === 'running') return 'tag-pill-indigo';
  if (tone === 'done' || tone === 'passed') return 'tag-pill-teal';
  if (tone === 'blocked' || tone === 'crashed') return 'tag-pill-error';
  if (tone === 'review') return 'tag-pill-amber';
  return 'tag-pill-neutral';
}

/** Map column / status to a human tag pill label. */
function tagPillLabel(tile: BoardTileModel): string {
  if (tile.column === 'survives') return 'Winning route';
  if (tile.column === 'discarded') return 'Discarded';
  if (tile.column === 'exploring') return 'Hypothesis';
  if (tile.column === 'ready_to_compare') return 'Ready';
  if (tile.column === 'needs_input') return 'Decision needed';
  return tile.status;
}

/** Rough relative time from an ISO date string. */
function relativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.max(0, Math.floor(diff / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const COLUMN_DOTS: Record<string, string> = {
  needs_input: 'var(--blocked)',
  ready_to_compare: 'var(--review)',
  exploring: 'var(--in-progress)',
  survives: 'var(--done)',
  discarded: 'var(--planning)',
};

const EMPTY_COLUMN_MESSAGES: Record<string, { icon: string; text: string }> = {
  needs_input: { icon: 'check_circle', text: 'Nothing blocked right now.' },
  ready_to_compare: { icon: 'hourglass_empty', text: 'No routes ready to compare yet.' },
  exploring: { icon: 'rocket_launch', text: 'No live routes are exploring right now.' },
  survives: { icon: 'emoji_events', text: 'Nothing has earned survival yet.' },
  discarded: { icon: 'inventory_2', text: 'Nothing discarded yet.' },
};

/* ------------------------------------------------------------------ */
/*  BoardPanel                                                         */
/* ------------------------------------------------------------------ */

export const BoardPanel: React.FC<BoardPanelProps> = ({ sprint, projectName, focusedIdeaId }) => {
  const [brief, setBrief] = useState<LandingBriefData | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!sprint) {
      setBrief(null);
      return;
    }

    (async () => {
      try {
        const res = await fetch(`/data/sprint/${encodeURIComponent(sprint.name)}/brief`);
        if (!res.ok) return;
        const data: LandingBriefData = await res.json();
        if (!cancelled) setBrief(data);
      } catch {
        // best effort only
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sprint]);

  useEffect(() => {
    setSelectedId(null);
  }, [sprint?.name]);

  useEffect(() => {
    if (focusedIdeaId) {
      setSelectedId(focusedIdeaId);
    }
  }, [focusedIdeaId]);

  const board = useMemo(() => buildBoardModel(sprint, brief), [sprint, brief]);
  const boardColumns = board.columns.filter((column) => column.id !== 'discarded');
  const discardedColumn = board.columns.find((column) => column.id === 'discarded');
  const allTiles = board.columns.flatMap((column) => column.tiles);
  const selectedTile = allTiles.find((tile) => tile.id === selectedId) ?? null;

  /* --- Empty state ------------------------------------------------------- */

  if (!sprint) {
    return (
      <section className="board-panel">
        <div className="empty-panel">
          <span className="material-symbols-outlined empty-panel-icon">dashboard</span>
          <h2>{projectName ? `No active sprint in ${projectName}` : 'No active sprint'}</h2>
          <p>
            {projectName
              ? 'Start a sprint in this project and the board will organize the active ideas for you.'
              : 'Start a new sprint and the live board will organize the competing routes for you.'}
          </p>
        </div>
      </section>
    );
  }

  /* --- Main board -------------------------------------------------------- */

  return (
    <section className={`board-panel ${selectedTile ? 'drawer-open' : ''}`}>
      {/* ---- Board header ---- */}
      <div className="board-header">
        <div className="board-header-left">
          <p className="board-breadcrumb">
            PROJECTS{projectName ? ` > ${projectName.toUpperCase()}` : ''}
          </p>
          <h2 className="board-title">Judgment Workspace</h2>
          <p className="board-lede">{sprint.goal}</p>
        </div>
        <div className="board-header-actions">
          <button type="button" className="btn-secondary board-filter-btn">
            <span className="material-symbols-outlined btn-icon">filter_list</span>
            Filter
          </button>
          <button type="button" className="btn-gradient board-synthesize-btn">
            <span className="material-symbols-outlined btn-icon">auto_awesome</span>
            Synthesize All
          </button>
        </div>
      </div>

      {/* ---- Kanban columns ---- */}
      <div className="board-shell">
        <div className="board-columns">
          {boardColumns.map((column) => (
            <section key={column.id} className="board-column">
              {/* Column header (dot + uppercase label + count) */}
              <div className="board-column-header">
                <div>
                  <p className="board-column-kicker">
                    <span
                      className="board-column-dot"
                      style={{ background: COLUMN_DOTS[column.id] ?? 'var(--planning)' }}
                    />
                    {column.title} ({column.stage})
                  </p>
                  <p className="board-column-description">{column.description}</p>
                </div>
                <span className="board-column-count">{column.tiles.length}</span>
              </div>

              {/* Column body */}
              <div className="board-column-body">
                {column.tiles.length === 0 ? (
                  <EmptyColumnPlaceholder columnId={column.id} />
                ) : (
                  column.tiles.map((tile) => (
                    <BoardCard
                      key={tile.id}
                      tile={tile}
                      isSurvives={column.id === 'survives'}
                      isActive={selectedTile?.id === tile.id}
                      onClick={() => setSelectedId(tile.id)}
                    />
                  ))
                )}
              </div>
            </section>
          ))}
        </div>

        {/* ---- Route Drawer ---- */}
        {selectedTile && (
          <RouteDrawer
            tile={selectedTile}
            sprintCreatedAt={sprint.createdAt}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>

      {/* ---- Discarded shelf ---- */}
      {discardedColumn && discardedColumn.tiles.length > 0 && (
        <section className="discarded-shelf">
          <div className="discarded-shelf-header">
            <div>
              <p className="section-kicker">
                <span className="material-symbols-outlined kicker-icon">archive</span>
                Discarded shelf
              </p>
              <h3>{discardedColumn.title}</h3>
              <p className="option-section-description">{discardedColumn.description}</p>
            </div>
            <span className="option-section-count">
              {discardedColumn.tiles.length} {discardedColumn.tiles.length === 1 ? 'route' : 'routes'}
            </span>
          </div>

          <div className="discarded-list">
            {discardedColumn.tiles.map((tile) => (
              <button
                key={tile.id}
                type="button"
                className="discarded-chip"
                onClick={() => setSelectedId(tile.id)}
              >
                <span className="material-symbols-outlined chip-icon">close</span>
                <span className="discarded-chip-copy">
                  <span className="discarded-chip-title">{tile.title}</span>
                  <span className="discarded-chip-line">{tile.cardLine}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </section>
  );
};

/* ------------------------------------------------------------------ */
/*  EmptyColumnPlaceholder                                             */
/* ------------------------------------------------------------------ */

const EmptyColumnPlaceholder: React.FC<{ columnId: string }> = ({ columnId }) => {
  const msg = EMPTY_COLUMN_MESSAGES[columnId] ?? { icon: 'inbox', text: 'No routes here right now.' };
  return (
    <div className="board-empty-column">
      <span className="material-symbols-outlined empty-col-icon">{msg.icon}</span>
      <p>{msg.text}</p>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  BoardCard                                                          */
/* ------------------------------------------------------------------ */

interface BoardCardProps {
  tile: BoardTileModel;
  isSurvives: boolean;
  isActive: boolean;
  onClick: () => void;
}

const BoardCard: React.FC<BoardCardProps> = ({ tile, isSurvives, isActive, onClick }) => {
  return (
    <button
      type="button"
      className={`board-tile tone-${tile.tone} ${isActive ? 'active' : ''} ${isSurvives ? 'board-tile-survives' : ''}`}
      onClick={onClick}
    >
      <div className="board-tile-top">
        <span className={`board-tile-tag-pill ${tagPillClass(tile.tone)}`}>
          {tagPillLabel(tile)}
        </span>
        <span className={`board-tile-status-dot tone-${tile.tone}`} />
      </div>

      {tile.track && <p className="board-tile-context">{tile.track}</p>}
      <p className="board-tile-title">{tile.title}</p>
      <p className="board-tile-line">{tile.cardLine}</p>
    </button>
  );
};

/* ------------------------------------------------------------------ */
/*  RouteDrawer (overlay)                                              */
/* ------------------------------------------------------------------ */

interface RouteDrawerProps {
  tile: BoardTileModel;
  sprintCreatedAt: string;
  onClose: () => void;
}

const RouteDrawer: React.FC<RouteDrawerProps> = ({ tile, sprintCreatedAt, onClose }) => {
  return (
    <div className="route-drawer-overlay" onClick={onClose}>
      {/* Close button floating outside the drawer */}
      <button
        type="button"
        className="route-drawer-close-float"
        onClick={onClose}
        aria-label="Close drawer"
      >
        <span className="material-symbols-outlined">close</span>
      </button>

      <aside
        className="route-drawer"
        aria-label={`${tile.title} details`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="route-drawer-header">
          <div>
            <p className="route-drawer-kicker">
              <span className="material-symbols-outlined route-drawer-kicker-icon">{tile.drawerLabel.icon}</span>
              <span>{tile.drawerLabel.label}</span>
            </p>
            <h3 className="route-drawer-title">{tile.title}</h3>
            <div className="route-drawer-meta">
              <span className="route-drawer-meta-item">
                <span className="material-symbols-outlined meta-icon">calendar_today</span>
                Created {relativeTime(sprintCreatedAt)}
              </span>
              <span className="route-drawer-meta-item">
                <span className="material-symbols-outlined meta-icon">group</span>
                {tile.memberSentence}
              </span>
              {tile.track && (
                <span className="route-drawer-meta-item">
                  <span className="material-symbols-outlined meta-icon">category</span>
                  {tile.track} track
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="route-drawer-body">
          <div className="route-drawer-overview">
            <h4 className="route-drawer-section-heading">Detailed Overview</h4>
            <p className="route-drawer-overview-text">{tile.drawerOverview}</p>
          </div>

          {tile.drawerSections.map((section) => (
            <div key={section.id} className="route-drawer-section">
              <h4 className="route-drawer-section-heading">
                <span className="material-symbols-outlined section-heading-icon">{section.icon}</span>
                {section.title}
              </h4>
              <p className="route-drawer-text">{section.body}</p>
            </div>
          ))}

          <div className="route-drawer-agents">
            <h4 className="route-drawer-section-heading">Agent Observations</h4>
            <div className="route-drawer-agent-card">
              <div className="route-drawer-agent-icon">
                <span className="material-symbols-outlined">smart_toy</span>
              </div>
              <div className="route-drawer-agent-copy">
                <p className="route-drawer-agent-quote">"{tile.drawerObservation}"</p>
                <p className="route-drawer-agent-meta">
                  {tile.memberSentence.toUpperCase()} • {relativeTime(sprintCreatedAt)}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="route-drawer-footer">
          <button type="button" className="btn-outline drawer-close-btn" onClick={onClose}>
            <span className="material-symbols-outlined btn-icon">close</span>
            Close
          </button>
        </div>
      </aside>
    </div>
  );
};
