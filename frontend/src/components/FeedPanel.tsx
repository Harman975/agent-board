import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FeedPost } from '../types';

export const FeedPanel: React.FC = () => {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [channelFilter, setChannelFilter] = useState('all');
  const [authorFilter, setAuthorFilter] = useState('all');
  const [threadPost, setThreadPost] = useState<FeedPost | null>(null);
  const [threadReplies, setThreadReplies] = useState<FeedPost[]>([]);

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

  const channels = useMemo(() => {
    const set = new Set(posts.map((p) => p.channel));
    return ['all', ...Array.from(set).sort()];
  }, [posts]);

  const authors = useMemo(() => {
    const set = new Set(posts.map((p) => p.author));
    return ['all', ...Array.from(set).sort()];
  }, [posts]);

  const filtered = useMemo(() => {
    return posts.filter((p) => {
      if (channelFilter !== 'all' && p.channel !== channelFilter) return false;
      if (authorFilter !== 'all' && p.author !== authorFilter) return false;
      return true;
    });
  }, [posts, channelFilter, authorFilter]);

  const openThread = useCallback(async (post: FeedPost) => {
    setThreadPost(post);
    try {
      const res = await fetch(`/api/posts/${post.id}/thread`);
      if (res.ok) {
        const data = await res.json();
        setThreadReplies(Array.isArray(data) ? data : data.posts ?? []);
      }
    } catch {
      setThreadReplies([]);
    }
  }, []);

  const closeThread = useCallback(() => {
    setThreadPost(null);
    setThreadReplies([]);
  }, []);

  if (loading) {
    return <div className="feed-panel"><p className="feed-loading">Loading feed...</p></div>;
  }

  return (
    <div className="feed-panel">
      <div className="feed-filters">
        <label>
          Channel:
          <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}>
            {channels.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>
          Author:
          <select value={authorFilter} onChange={(e) => setAuthorFilter(e.target.value)}>
            {authors.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
      </div>

      {threadPost ? (
        <div className="feed-thread">
          <button className="thread-back" onClick={closeThread}>
            &larr; Back to feed
          </button>
          <div className="feed-post thread-root">
            <div className="post-header">
              <span className="post-author">{threadPost.author}</span>
              <span className="post-channel">{threadPost.channel}</span>
              <time className="post-time">{new Date(threadPost.created_at).toLocaleString()}</time>
            </div>
            <p className="post-content">{threadPost.content}</p>
          </div>
          {threadReplies.map((reply) => (
            <div key={reply.id} className="feed-post thread-reply">
              <div className="post-header">
                <span className="post-author">{reply.author}</span>
                <time className="post-time">{new Date(reply.created_at).toLocaleString()}</time>
              </div>
              <p className="post-content">{reply.content}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="feed-list">
          {filtered.length === 0 && <p className="feed-empty">No posts found</p>}
          {filtered.map((post) => (
            <div
              key={post.id}
              className="feed-post"
              onClick={() => openThread(post)}
              onKeyDown={(e) => { if (e.key === 'Enter') openThread(post); }}
              role="button"
              tabIndex={0}
            >
              <div className="post-header">
                <span className="post-author">{post.author}</span>
                <span className="post-channel">{post.channel}</span>
                <time className="post-time">{new Date(post.created_at).toLocaleString()}</time>
              </div>
              <p className="post-content">{post.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
