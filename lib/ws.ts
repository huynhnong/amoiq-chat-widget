/**
 * Socket.io client for real-time chat
 * Handles connection, message sending, and event callbacks
 */

import { io, Socket } from 'socket.io-client';

export interface WebSocketCallbacks {
  onMessage?: (message: any) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

export class ChatWebSocket {
  private tenantId: string;
  private socket: Socket | null = null;
  private callbacks: WebSocketCallbacks;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private shouldReconnect = true;
  private wsUrl: string;

  constructor(tenantId: string, callbacks: WebSocketCallbacks = {}) {
    this.tenantId = tenantId;
    this.callbacks = callbacks;
    
    // Determine WebSocket URL
    const wsUrl = process.env.NEXT_PUBLIC_WEBSOCKET_URL || process.env.NEXT_PUBLIC_WS_URL;
    
    if (wsUrl) {
      // Socket.io works with http/https URLs, it handles the protocol
      this.wsUrl = wsUrl.replace(/^wss?:/, 'https:').replace(/^ws:/, 'http:');
    } else {
      // Default fallback
      this.wsUrl = 'https://api.amoiq.com';
    }
    
    this.connect();
  }

  private connect() {
    try {
      console.log('[Socket.io] Connecting to:', this.wsUrl, 'with tenantId:', this.tenantId);
      
      this.socket = io(this.wsUrl, {
        transports: ['websocket', 'polling'],
        query: {
          tenantId: this.tenantId,
        },
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });

      this.socket.on('connect', () => {
        console.log('[Socket.io] ✅ Connected successfully');
        this.reconnectAttempts = 0;
        this.callbacks.onConnect?.();
      });

      this.socket.on('disconnect', (reason) => {
        console.log('[Socket.io] Disconnected:', reason);
        this.callbacks.onDisconnect?.();
      });

      this.socket.on('connect_error', (error) => {
        console.error('[Socket.io] ❌ Connection error:', error.message);
        this.callbacks.onError?.(new Error(`Socket.io connection error: ${error.message}`));
      });

      // Listen for message events from server
      this.socket.on('meta_message_created', (data: any) => {
        console.log('[Socket.io] Message received:', data);
        if (data.message) {
          this.callbacks.onMessage?.(data.message);
        } else {
          this.callbacks.onMessage?.(data);
        }
      });

      // Listen for other broadcast events
      this.socket.on('ai_event_created', (data: any) => {
        console.log('[Socket.io] AI event received:', data);
        if (data.message) {
          this.callbacks.onMessage?.(data.message);
        }
      });

      // Join conversation room if needed
      this.socket.on('connect', () => {
        // You might need to join a room based on your server's requirements
        // this.socket?.emit('join', { tenantId: this.tenantId });
      });

    } catch (error) {
      console.error('[Socket.io] Error creating connection:', error);
      this.callbacks.onError?.(error as Error);
    }
  }

  /**
   * Send a message through Socket.io
   */
  async sendMessage(text: string): Promise<void> {
    if (!this.socket || !this.socket.connected) {
      throw new Error('Socket.io is not connected');
    }

    const message = {
      type: 'message',
      text,
      tenantId: this.tenantId,
      timestamp: new Date().toISOString(),
    };

    // Emit message event - adjust event name based on your server
    this.socket.emit('message', message);
  }

  /**
   * Disconnect Socket.io
   */
  disconnect() {
    this.shouldReconnect = false;
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * Check if Socket.io is connected
   */
  isConnected(): boolean {
    return this.socket?.connected || false;
  }
}
