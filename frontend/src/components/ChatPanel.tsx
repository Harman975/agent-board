import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ChatMessage } from '../types';

interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ open, onClose }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const wsUrl =
      (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
      window.location.host +
      '/ws';

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string);
        if (event.type === 'chat-token') {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              return [
                ...prev.slice(0, -1),
                { ...last, content: last.content + event.data.token },
              ];
            }
            return [...prev, { role: 'assistant', content: event.data.token }];
          });
        } else if (event.type === 'chat-done') {
          setStreaming(false);
        }
      } catch {
        // ignore malformed messages
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [open]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;

    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    setInput('');
    setStreaming(true);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ type: 'chat-send', data: { message: trimmed } })
      );
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!open) return null;

  return (
    <aside className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">Chat</span>
        <button className="chat-close" onClick={onClose} aria-label="Close chat">
          &times;
        </button>
      </div>
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">Send a message to start chatting.</div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message chat-message-${msg.role}`}>
            <span className="chat-role">{msg.role === 'user' ? 'You' : 'Claude'}</span>
            <div className="chat-content">{msg.content}</div>
          </div>
        ))}
        {streaming && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="chat-message chat-message-assistant">
            <span className="chat-role">Claude</span>
            <div className="chat-loading">
              <span className="chat-dot" />
              <span className="chat-dot" />
              <span className="chat-dot" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-area">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={2}
          disabled={streaming}
        />
        <button
          className="btn-primary chat-send"
          onClick={handleSend}
          disabled={!input.trim() || streaming}
        >
          Send
        </button>
      </div>
    </aside>
  );
};
