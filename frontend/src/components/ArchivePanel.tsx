import React from 'react';
import { ProjectArchiveData } from '../types';

function formatDate(value: string | null): string {
  if (!value) return 'Still open';
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface ArchivePanelProps {
  data: ProjectArchiveData | null;
}

export const ArchivePanel: React.FC<ArchivePanelProps> = ({ data }) => {
  if (!data) {
    return (
      <section className="screen-panel">
        <div className="empty-panel">
          <span className="material-symbols-outlined empty-panel-icon">inventory_2</span>
          <h2>No archive yet</h2>
          <p>Once this project closes a few cycles, the archive will show what survived and what was learned.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="screen-panel">
      <div className="screen-header screen-header-row">
        <div>
          <p className="section-kicker">Archive</p>
          <h2>Vault archive</h2>
          <p className="screen-summary">
            Review the finished cycles for {data.project.name} and keep the historical signal in one place.
          </p>
        </div>
        <div className="screen-actions">
          <button type="button" className="btn-secondary">Filter</button>
          <button type="button" className="btn-secondary">Export data</button>
        </div>
      </div>

      <div className="archive-layout">
        <div className="archive-featured">
          <p className="projects-status-pill">{data.featured?.statusLabel ?? 'No archived cycles yet'}</p>
          <h3>{data.featured?.goal ?? 'Archive will fill as projects close'}</h3>
          <p>
            {data.featured
              ? `The most recent archived sprint was ${data.featured.name}.`
              : 'Close a few cycles and this surface will become your retrospective memory.'}
          </p>
          {data.featured && (
            <div className="archive-featured-meta">
              <div>
                <span>Started</span>
                <strong>{formatDate(data.featured.createdAt)}</strong>
              </div>
              <div>
                <span>Archived</span>
                <strong>{formatDate(data.featured.finishedAt)}</strong>
              </div>
              <div>
                <span>Status</span>
                <strong>{data.featured.statusLabel}</strong>
              </div>
            </div>
          )}
        </div>

        <div className="archive-stats">
          <article className="screen-card stat-card">
            <p className="stat-card-label">Success rate</p>
            <h3>{data.stats.successRate.toFixed(1)}%</h3>
            <p className="screen-note">Completed cycles compared with failed ones.</p>
          </article>
          <article className="screen-card stat-card dark">
            <p className="stat-card-label">Archived cycles</p>
            <h3>{data.stats.archivedCount}</h3>
            <p className="screen-note">Completed: {data.stats.completedCount} · Failed: {data.stats.failedCount}</p>
          </article>
        </div>
      </div>

      <section className="screen-section">
        <div className="screen-section-heading">
          <h3>Historical records</h3>
          <span className="screen-count-pill">{data.records.length} total</span>
        </div>
        {data.records.length === 0 ? (
          <p className="screen-empty">This project has not archived any sprints yet.</p>
        ) : (
          <div className="data-table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sprint</th>
                  <th>Status</th>
                  <th>Archived</th>
                </tr>
              </thead>
              <tbody>
                {data.records.map((record) => (
                  <tr key={record.name}>
                    <td>
                      <p>{record.goal}</p>
                      <span>{record.name}</span>
                    </td>
                    <td>
                      <span className="projects-status-pill subdued">{record.statusLabel}</span>
                    </td>
                    <td>{formatDate(record.finishedAt ?? record.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
};
