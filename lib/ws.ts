/**
 * Socket.io client for real-time chat
 * Handles connection, message sending, and event callbacks
 */

import { io, Socket } from 'socket.io-client';

export interface OnlineUser {
  userId: string;
  sessionId?: string;
  connectedAt: string;
  domain?: string;
  origin?: string;
  url?: string;
}

export interface WebSocketCallbacks {
  onMessage?: (message: any) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  onUserOnline?: (user: OnlineUser) => void;
  onUserOffline?: (userId: string) => void;
  onOnlineUsersList?: (users: OnlineUser[]) => void;
}

export interface WebsiteInfo {
  domain?: string;
  origin?: string;
  url?: string;
  referrer?: string;
  siteId?: string;
}

export class ChatWebSocket {
  private tenantId: string;
  private socket: Socket | null = null;
  private callbacks: WebSocketCallbacks;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private shouldReconnect = true;
  private wsUrl: string;
  private websiteInfo: WebsiteInfo;
  private isAdmin: boolean;

  constructor(tenantId: string, callbacks: WebSocketCallbacks = {}, websiteInfo?: WebsiteInfo, isAdmin: boolean = false) {
    this.tenantId = tenantId;
    this.callbacks = callbacks;
    this.websiteInfo = websiteInfo || this.getWebsiteInfo();
    this.isAdmin = isAdmin;
    
    // Determine WebSocket URL
    const wsUrl = process.env.NEXT_PUBLIC_WEBSOCKET_URL || process.env.NEXT_PUBLIC_WS_URL;
    
    if (wsUrl) {
      // Socket.io works with http/https URLs, it handles the protocol
      this.wsUrl = wsUrl.replace(/^wss?:/, 'https:').replace(/^ws:/, 'http:');
    } else {
      // Default fallback - use gateway URL if available, otherwise default
      const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL || process.env.NEXT_PUBLIC_API_URL;
      this.wsUrl = gatewayUrl ? gatewayUrl.replace(/^https?:/, 'https:') : 'https://api-gateway-dfcflow.fly.dev';
    }
    
    this.connect();
  }

  /**
   * Auto-detect website information from browser
   */
  private getWebsiteInfo(): WebsiteInfo {
    if (typeof window !== 'undefined') {
      return {
        domain: window.location.hostname,
        origin: window.location.origin,
        url: window.location.href,
        referrer: document.referrer || '',
      };
    }
    return {};
  }

  private connect() {
    try {
      console.log('[Socket.io] Connecting to:', this.wsUrl, 'with tenantId:', this.tenantId);
      
      // Get API key from environment for authentication
      const apiKey = process.env.NEXT_PUBLIC_GATEWAY_API_KEY || process.env.NEXT_PUBLIC_API_KEY;
      
      this.socket = io(this.wsUrl, {
        transports: ['websocket', 'polling'],
        query: {
          tenantId: this.tenantId,
          ...(this.isAdmin && { role: 'admin' }),
        },
        auth: {
          token: apiKey,
          ...(this.isAdmin && { role: 'admin' }),
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

      // Listen for presence events (online users tracking)
      this.socket.on('user_online', (data: any) => {
        console.log('[Socket.io] User online:', data);
        if (data.userId) {
          this.callbacks.onUserOnline?.({
            userId: data.userId,
            sessionId: data.sessionId,
            connectedAt: data.connectedAt || new Date().toISOString(),
            domain: data.domain,
            origin: data.origin,
            url: data.url,
          });
        }
      });

      this.socket.on('user_offline', (data: any) => {
        console.log('[Socket.io] User offline:', data);
        const userId = typeof data === 'string' ? data : data?.userId;
        if (userId) {
          this.callbacks.onUserOffline?.(userId);
        }
      });

      this.socket.on('online_users_list', (data: any) => {
        console.log('[Socket.io] Online users list received:', data);
        const users = data.users || data || [];
        this.callbacks.onOnlineUsersList?.(users);
      });

      // Join conversation room if needed
      this.socket.on('connect', () => {
        // You might need to join a room based on your server's requirements
        // this.socket?.emit('join', { tenantId: this.tenantId });
        
        // If admin, request initial online users list
        if (this.isAdmin) {
          this.requestOnlineUsers();
        }
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
      ...this.websiteInfo, // Include domain, origin, url, referrer, siteId
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

  /**
   * Request list of online users from server
   * Only works for admin connections
   */
  requestOnlineUsers(): void {
    if (!this.socket || !this.socket.connected) {
      console.warn('[Socket.io] Cannot request online users: not connected');
      return;
    }

    this.socket.emit('get_online_users', {
      tenantId: this.tenantId,
    });
  }
}
