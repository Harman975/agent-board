import React, { useEffect, useState } from 'react';
import { FeedPost } from '../types';
import { buildTimelineEntries } from '../presentation';

export const FeedPanel: React.FC = () => {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/feed?limit=100');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setPosts(Array.isArray(data) ? data : data.posts ?? []);
        }
      } catch {
        // fetch failed
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div className="feed-panel"><p className="feed-loading">Loading timeline...</p></div>;
  }

  const entries = buildTimelineEntries(posts);

  return (
    <section className="feed-panel">
      <div className="timeline-header">
        <p className="section-kicker">Timeline</p>
        <h2>What the sprint has learned so far</h2>
        <p className="timeline-summary">
          A concise narrative of the sprint so you can follow the signal without reading raw system output.
        </p>
      </div>

      <div className="timeline-list">
        {entries.length === 0 && <p className="feed-empty">No learning updates yet.</p>}
        {entries.map((entry) => (
          <article key={entry.id} className="timeline-item">
            <div className="timeline-meta">
              <span className="status-badge timeline-badge">{entry.label}</span>
              <span className="timeline-actor">{entry.actor}</span>
              <span className="timeline-time">{entry.time}</span>
            </div>
            <p className="timeline-text">{entry.sentence}</p>
          </article>
        ))}
      </div>
    </section>
  );
};
