import { WSEvent } from './types';

export interface WSClientOptions {
  url: string;
  onEvent: (event: WSEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export class WSClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private disposed = false;
  private options: WSClientOptions;

  constructor(options: WSClientOptions) {
    this.options = options;
  }

  connect(): void {
    if (this.disposed) return;

    try {
      this.ws = new WebSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.options.onConnectionChange?.(true);
    };

    this.ws.onmessage = (msg) => {
      try {
        const event: WSEvent = JSON.parse(msg.data as string);
        this.options.onEvent(event);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.options.onConnectionChange?.(false);
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay
    );
  }

  disconnect(): void {
    this.disposed = true;
    this.ws?.close();
  }
}
