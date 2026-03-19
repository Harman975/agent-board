import React, { useEffect, useMemo, useState } from 'react';
import { LandingBriefData, SprintState } from '../types';
import { buildBoardModel, type BoardTileModel } from '../presentation';

interface BoardPanelProps {
  sprint: SprintState | null;
  projectName?: string | null;
  focusedIdeaId?: string | null;
}

function compactCopy(value: string, limit = 96): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}...`;
}

function tileSignal(tile: BoardTileModel): { label: string; text: string } {
  if (tile.column === 'needs_input') {
    return {
      label: 'Waiting on',
      text: tile.nextMove,
    };
  }

  if (tile.column === 'ready_to_compare') {
    return {
      label: 'Signal',
      text: tile.latestSignal,
    };
  }

  if (tile.column === 'survives') {
    return {
      label: 'Keep because',
      text: tile.whyAlive,
    };
  }

  return {
    label: 'Next',
    text: tile.nextMove,
  };
}

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

  if (!sprint) {
    return (
      <section className="board-panel">
        <div className="empty-panel">
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

  return (
    <section className={`board-panel ${selectedTile ? 'drawer-open' : ''}`}>
      <div className="board-summary">
        <div className="overview-hero board-hero">
          <p className="section-kicker">Live board</p>
          <h2>{board.headline}</h2>
          <p className="overview-summary">{board.summary}</p>
        </div>

        <div className="board-stat-row">
          {board.stats.map((stat) => (
            <article key={stat.label} className="overview-stat">
              <p className="overview-stat-label">{stat.label}</p>
              <p className="overview-stat-value">{stat.value}</p>
              <p className="overview-stat-note">{stat.note}</p>
            </article>
          ))}
        </div>
      </div>

      <div className="board-shell">
        <div className="board-columns">
          {boardColumns.map((column) => (
            <section key={column.id} className="board-column">
              <div className="board-column-header">
                <div>
                  <p className="board-column-kicker">{column.title}</p>
                  <p className="board-column-description">{column.description}</p>
                </div>
                <span className="board-column-count">
                  {column.tiles.length}
                </span>
              </div>

              <div className="board-column-body">
                {column.tiles.length === 0 ? (
                  <div className="board-empty-column">
                    <p>No routes here right now.</p>
                  </div>
                ) : (
                  column.tiles.map((tile) => {
                    const signal = tileSignal(tile);
                    return (
                      <button
                        key={tile.id}
                        type="button"
                        className={`board-tile tone-${tile.tone} ${selectedTile?.id === tile.id ? 'active' : ''}`}
                        onClick={() => setSelectedId(tile.id)}
                      >
                        <div className="board-tile-header">
                          <p className="board-tile-title">{tile.title}</p>
                          <span className={`status-badge tone-${tile.tone}`}>{tile.status}</span>
                        </div>

                        <p className="board-tile-summary">{compactCopy(tile.summary, 88)}</p>

                        <div className="board-tile-signal">
                          <p className="board-tile-signal-label">{signal.label}</p>
                          <p className="board-tile-signal-text">{compactCopy(signal.text, 92)}</p>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </section>
          ))}
        </div>

        {selectedTile && (
          <RouteDrawer tile={selectedTile} onClose={() => setSelectedId(null)} />
        )}
      </div>

      {discardedColumn && discardedColumn.tiles.length > 0 && (
        <section className="discarded-shelf">
          <div className="discarded-shelf-header">
            <div>
              <p className="section-kicker">Discarded shelf</p>
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
                <span>{tile.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </section>
  );
};

interface RouteDrawerProps {
  tile: BoardTileModel;
  onClose: () => void;
}

const RouteDrawer: React.FC<RouteDrawerProps> = ({ tile, onClose }) => {
  return (
    <aside className="route-drawer" aria-label={`${tile.title} details`}>
      <div className="route-drawer-header">
        <div>
          <p className="section-kicker">Route detail</p>
          <h3>{tile.title}</h3>
          {tile.track && <p className="board-tile-track">{tile.track}</p>}
        </div>
        <button type="button" className="btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="route-drawer-body">
        <div className="route-drawer-callout">
          <span className={`status-badge tone-${tile.tone}`}>{tile.status}</span>
          <p>{tile.summary}</p>
        </div>

        <div className="route-drawer-section">
          <p className="signal-label">Why it is still alive</p>
          <p className="route-drawer-text">{tile.whyAlive}</p>
        </div>

        <div className="route-drawer-section">
          <p className="signal-label">Latest signal</p>
          <p className="route-drawer-text">{tile.latestSignal}</p>
        </div>

        <div className="route-drawer-section">
          <p className="signal-label">What could stop it</p>
          <p className="route-drawer-text">{tile.risk}</p>
        </div>

        <div className="route-drawer-section">
          <p className="signal-label">Next move</p>
          <p className="route-drawer-text">{tile.nextMove}</p>
        </div>

        <div className="signal-grid route-drawer-grid">
          <article className="signal-tile">
            <p className="signal-label">Who is carrying it</p>
            <p className="signal-text">{tile.memberSentence}</p>
          </article>
          {tile.whatItReuses && (
            <article className="signal-tile">
              <p className="signal-label">What it reuses</p>
              <p className="signal-text">{tile.whatItReuses}</p>
            </article>
          )}
          {tile.existingCodeGap && (
            <article className="signal-tile">
              <p className="signal-label">Why the current code is not enough</p>
              <p className="signal-text">{tile.existingCodeGap}</p>
            </article>
          )}
          {tile.evidence && (
            <article className="signal-tile">
              <p className="signal-label">Evidence</p>
              <p className="signal-text">{tile.evidence}</p>
            </article>
          )}
        </div>
      </div>
    </aside>
  );
};
