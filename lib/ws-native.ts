/**
 * Socket.IO client for real-time chat
 * Connects directly to Socket.IO server using ws_server_url from /webchat/init response
 */

import { io, Socket } from 'socket.io-client';
import { getSessionInfo, refreshSession } from './session';

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

export interface UserInfo {
  name?: string;
  email?: string;
  phone?: string;
  [key: string]: any;
}

export interface ConversationInitResponse {
  conversation_id: string;
  visitor_id: string;
  ws_token: string;
  ws_server_url: string;
  tenant_id: string;
  expires_in: number;
}

export class ChatWebSocketNative {
  private tenantId: string | null;
  private socket: Socket | null = null;
  private callbacks: WebSocketCallbacks;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private shouldReconnect = true;
  private websiteInfo: WebsiteInfo;
  private isAdmin: boolean;
  private userId?: string;
  private userInfo?: UserInfo;
  private conversationId?: string;
  private visitorId?: string;
  private wsToken?: string;
  private wsServerUrl?: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private gatewayUrl: string;

  constructor(
    tenantId: string | null,
    callbacks: WebSocketCallbacks = {},
    websiteInfo?: WebsiteInfo,
    isAdmin: boolean = false,
    userId?: string,
    userInfo?: UserInfo
  ) {
    this.tenantId = tenantId || null;
    this.callbacks = callbacks;
    
    // Use provided websiteInfo if it has domain/origin, otherwise try to get from URL params
    // Don't use fallback getWebsiteInfo() if we're on webchat domain (would return wrong domain)
    if (websiteInfo && (websiteInfo.domain || websiteInfo.origin)) {
      this.websiteInfo = websiteInfo;
    } else {
      // Try to get from URL params (widget loader should pass these)
      const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
      const domain = params?.get('domain');
      const origin = params?.get('origin');
      
      if (domain || origin) {
        this.websiteInfo = {
          domain: domain || undefined,
          origin: origin || undefined,
          url: params?.get('url') || undefined,
          referrer: params?.get('referrer') || undefined,
          siteId: params?.get('siteId') || undefined,
        };
        console.log('[Socket.IO] Using website info from URL params:', this.websiteInfo);
      } else {
        // Last resort: use provided websiteInfo even if empty, or getWebsiteInfo() if not on webchat domain
        const fallback = this.getWebsiteInfo();
        if (fallback.domain && !fallback.domain.includes('webchat')) {
          this.websiteInfo = fallback;
        } else {
          // On webchat domain without URL params - this shouldn't happen in production
          this.websiteInfo = websiteInfo || {};
          console.warn('[Socket.IO] ⚠️ No domain info available. Widget loader should pass domain via URL params.');
        }
      }
    }
    
    this.isAdmin = isAdmin;
    this.userId = userId;
    this.userInfo = userInfo;
    
    // Get Gateway URL for /webchat/init endpoint
    this.gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL || process.env.NEXT_PUBLIC_API_URL || 'https://api-gateway-dfcflow.fly.dev';
  }

  /**
   * Auto-detect website information from browser
   * Note: This should rarely be called since websiteInfo is passed from embed page
   * This is only a fallback if websiteInfo wasn't provided
   */
  private getWebsiteInfo(): WebsiteInfo {
    if (typeof window !== 'undefined') {
      const hostname = window.location.hostname;
      // Don't use webchat.amoiq.com as domain - this means we're in iframe without proper info
      if (hostname === 'webchat.amoiq.com' || hostname.includes('webchat')) {
        console.warn('[Socket.IO] ⚠️ Widget is on webchat domain but no websiteInfo provided. This should not happen in production.');
        return {};
      }
      return {
        domain: hostname,
        origin: window.location.origin,
        url: window.location.href,
        referrer: document.referrer || '',
      };
    }
    return {};
  }

  /**
   * Initialize conversation and get JWT token and Socket.IO server URL
   * Must be called before connect()
   */
  async initialize(visitorId?: string): Promise<ConversationInitResponse | null> {
    try {
      const sessionInfo = getSessionInfo();
      
      const payload: any = {
        ...this.websiteInfo,
      };

      // Only add tenantId if available - Gateway will resolve from domain if not provided
      if (this.tenantId) {
        payload.tenantId = this.tenantId;
      }

      if (visitorId) {
        payload.visitorId = visitorId;
      }

      if (this.userId) {
        payload.userId = this.userId;
        if (this.userInfo) {
          payload.userInfo = this.userInfo;
        }
      }

      const apiKey = process.env.NEXT_PUBLIC_GATEWAY_API_KEY || process.env.NEXT_PUBLIC_API_KEY;
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };

      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      // Send parent domain in custom headers for Gateway to use
      // Since widget runs in iframe (webchat.amoiq.com), Origin header will be from iframe domain
      // We need to send the actual parent website domain so Gateway can look it up
      if (this.websiteInfo?.origin) {
        headers['X-Website-Origin'] = this.websiteInfo.origin;
      }
      if (this.websiteInfo?.domain) {
        headers['X-Website-Domain'] = this.websiteInfo.domain;
      }

      // DO NOT send X-Tenant-ID header - Gateway will set it based on domain lookup
      // Gateway should check X-Website-Origin first, then fallback to Origin/Referer

      const response = await fetch(`${this.gatewayUrl}/webchat/init`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`Failed to initialize conversation: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data: ConversationInitResponse = await response.json();
      
      this.conversationId = data.conversation_id;
      this.visitorId = data.visitor_id;
      this.wsToken = data.ws_token;
      this.wsServerUrl = data.ws_server_url;
      // Extract tenant_id from response (Gateway should return it)
      this.tenantId = data.tenant_id || this.tenantId;

      // Debug logging
      console.log('[Socket.IO] Conversation initialized:', {
        conversation_id: this.conversationId,
        visitor_id: this.visitorId,
        tenant_id: this.tenantId,
        ws_server_url: this.wsServerUrl,
        expires_in: data.expires_in,
      });
      console.log('[Socket.IO] DEBUG - Init response data:', {
        conversation_id: data.conversation_id,
        visitor_id: data.visitor_id,
        tenant_id: data.tenant_id,
        has_ws_token: !!data.ws_token,
        has_ws_server_url: !!data.ws_server_url,
        expires_in: data.expires_in,
      });
      // Decode JWT token to see payload (without verification)
      let tokenPayload: any = null;
      if (this.wsToken) {
        try {
          const base64Url = this.wsToken.split('.')[1];
          const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
          const jsonPayload = decodeURIComponent(atob(base64).split('').map((c) => {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          }).join(''));
          tokenPayload = JSON.parse(jsonPayload);
        } catch (e) {
          console.warn('[Socket.IO] DEBUG - Could not decode token:', e);
        }
      }
      
      console.log('[Socket.IO] DEBUG - Token received:', {
        token_length: this.wsToken?.length || 0,
        token_preview: this.wsToken ? `${this.wsToken.substring(0, 20)}...${this.wsToken.substring(this.wsToken.length - 20)}` : 'null',
        token_full: this.wsToken, // Full token for debugging (remove in production)
        token_payload: tokenPayload, // Decoded JWT payload
      });
      console.log('[Socket.IO] DEBUG - Server URL:', this.wsServerUrl);

      return data;
    } catch (error) {
      console.error('[Socket.IO] Error initializing conversation:', error);
      this.callbacks.onError?.(error instanceof Error ? error : new Error('Failed to initialize conversation'));
      return null;
    }
  }

  /**
   * Connect to Socket.IO server with JWT token
   * Must call initialize() first
   */
  connect(): void {
    // Ensure we're in the browser (not SSR)
    if (typeof window === 'undefined') {
      console.warn('[Socket.IO] Cannot connect: Socket.IO is only available in the browser');
      return;
    }

    if (!this.wsToken || !this.wsServerUrl) {
      console.error('[Socket.IO] Cannot connect: no JWT token or server URL. Call initialize() first.');
      this.callbacks.onError?.(new Error('No JWT token or server URL. Call initialize() first.'));
      return;
    }

    if (this.socket && this.socket.connected) {
      console.log('[Socket.IO] Already connected');
      return;
    }

    // Disconnect existing socket if it exists but is not connected
    if (this.socket && !this.socket.connected) {
      this.socket.disconnect();
      this.socket = null;
    }

    try {
      // Connect to Socket.IO server using ws_server_url with token in auth object
      console.log('[Socket.IO] Connecting to:', this.wsServerUrl.replace(/\/\/.*@/, '//***@')); // Hide credentials in log
      
      // Decode JWT token to see payload (without verification)
      let tokenPayload: any = null;
      if (this.wsToken) {
        try {
          const base64Url = this.wsToken.split('.')[1];
          const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
          const jsonPayload = decodeURIComponent(atob(base64).split('').map((c) => {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          }).join(''));
          tokenPayload = JSON.parse(jsonPayload);
        } catch (e) {
          console.warn('[Socket.IO] DEBUG - Could not decode token:', e);
        }
      }
      
      // Debug logging - what we're sending
      console.log('[Socket.IO] DEBUG - Connection config:', {
        ws_server_url: this.wsServerUrl,
        has_token: !!this.wsToken,
        token_length: this.wsToken?.length || 0,
        token_preview: this.wsToken ? `${this.wsToken.substring(0, 20)}...${this.wsToken.substring(this.wsToken.length - 20)}` : 'null',
        token_payload: tokenPayload, // Decoded JWT payload - check role, anonymous, user_id
        auth_object: { token: this.wsToken ? '***' : undefined },
        query_param: { token: this.wsToken ? '***' : undefined },
        authorization_header: this.wsToken ? 'Bearer ***' : undefined,
      });
      
      this.socket = io(this.wsServerUrl, {
        auth: {
          token: this.wsToken,
        },
        query: {
          token: this.wsToken,  // Fallback: socket.handshake.query?.token
        },
        extraHeaders: {
          'Authorization': `Bearer ${this.wsToken}`,  // Fallback: socket.handshake.headers?.authorization
        },
        transports: ['websocket', 'polling'], // Allow fallback to polling if websocket fails
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });
      
      console.log('[Socket.IO] DEBUG - Socket.IO client created, waiting for connection...');

      // Connection established
      this.socket.on('connect', () => {
        console.log('[Socket.IO] ✅ Connected successfully');
        console.log('[Socket.IO] DEBUG - Connection details:', {
          id: this.socket?.id,
          connected: this.socket?.connected,
          transport: this.socket?.io?.engine?.transport?.name,
        });
        this.reconnectAttempts = 0;
        this.callbacks.onConnect?.();
      });

      // Handle incoming messages
      this.socket.on('message', (data: any) => {
        console.log('[Socket.IO] Message received:', data);
        this.handleMessage(data);
      });

      // Handle presence events
      this.socket.on('user_online', (data: OnlineUser) => {
        console.log('[Socket.IO] User online:', data);
        this.callbacks.onUserOnline?.(data);
      });

      this.socket.on('user_offline', (data: { userId: string } | string) => {
        const userId = typeof data === 'string' ? data : data.userId;
        console.log('[Socket.IO] User offline:', userId);
        this.callbacks.onUserOffline?.(userId);
      });

      this.socket.on('online_users_list', (data: { users?: OnlineUser[] } | OnlineUser[]) => {
        const users = Array.isArray(data) ? data : (data.users || []);
        console.log('[Socket.IO] Online users list:', users);
        this.callbacks.onOnlineUsersList?.(users);
      });

      // Handle connection errors
      this.socket.on('connect_error', (error: Error) => {
        console.error('[Socket.IO] ❌ Connection error:', error);
        console.error('[Socket.IO] DEBUG - Connection error details:', {
          message: error.message,
          name: error.name,
          stack: error.stack,
          socket_id: this.socket?.id,
          socket_connected: this.socket?.connected,
        });
        this.reconnectAttempts++;
        this.callbacks.onError?.(error);
      });

      // Handle disconnection
      this.socket.on('disconnect', (reason: string) => {
        console.log('[Socket.IO] Disconnected:', reason);
        console.log('[Socket.IO] DEBUG - Disconnect details:', {
          reason: reason,
          socket_id: this.socket?.id,
          reconnect_attempts: this.reconnectAttempts,
        });
        this.callbacks.onDisconnect?.();

        // Attempt reconnection if needed (Socket.IO handles this automatically, but we can re-initialize if token expired)
        if (this.shouldReconnect && reason === 'io server disconnect') {
          // Server disconnected us, might need to re-authenticate
          console.log('[Socket.IO] Server disconnected, re-initializing...');
          this.initialize(this.visitorId).then(() => {
            if (this.wsToken && this.wsServerUrl) {
              this.connect();
            }
          });
        }
      });

      // Handle general errors
      this.socket.on('error', (error: Error) => {
        console.error('[Socket.IO] ❌ Socket error:', error);
        this.callbacks.onError?.(error);
      });
    } catch (error) {
      console.error('[Socket.IO] Error creating connection:', error);
      this.callbacks.onError?.(error as Error);
    }
  }

  /**
   * Handle incoming messages from Socket.IO
   */
  private handleMessage(data: any): void {
    // Handle different message types
    if (data.type === 'message' || data.message) {
      const message = data.message || data;
      this.callbacks.onMessage?.(message);
    } else {
      // Default: treat as message
      this.callbacks.onMessage?.(data);
    }
  }

  /**
   * Send a message through Socket.IO
   * Message is pushed to Redis stream chat_incoming
   */
  async sendMessage(text: string): Promise<void> {
    if (typeof window === 'undefined') {
      throw new Error('Socket.IO is only available in the browser');
    }

    if (!this.socket || !this.socket.connected) {
      throw new Error('Socket.IO is not connected');
    }

    const sessionInfo = getSessionInfo();
    refreshSession();

    // tenantId is REQUIRED by the server - throw error if not available
    if (!this.tenantId) {
      const error = new Error('tenantId is required but not available. Make sure initialize() was called successfully and Gateway returned tenant_id.');
      console.error('[Socket.IO] ERROR - Missing tenantId:', {
        conversation_id: this.conversationId,
        visitor_id: this.visitorId,
        has_ws_token: !!this.wsToken,
        has_ws_server_url: !!this.wsServerUrl,
      });
      throw error;
    }

    // Prepare message payload according to Gateway plan
    const message: any = {
      type: 'message',
      text,
      tenantId: this.tenantId,  // REQUIRED by server
      conversation_id: this.conversationId,
      visitor_id: this.visitorId,
      timestamp: new Date().toISOString(),
      sessionId: sessionInfo.sessionId,
      fingerprint: sessionInfo.fingerprint,
      ...this.websiteInfo,
    };

    if (this.userId) {
      message.userId = this.userId;
      if (this.userInfo) {
        message.userInfo = this.userInfo;
      }
    }

    // Debug logging - show full message payload
    console.log('[Socket.IO] DEBUG - Sending message payload:', {
      type: message.type,
      text: message.text,
      tenantId: message.tenantId,
      conversation_id: message.conversation_id,
      visitor_id: message.visitor_id,
      sessionId: message.sessionId,
      fingerprint: message.fingerprint,
      timestamp: message.timestamp,
      websiteInfo: this.websiteInfo,
      userId: this.userId,
      full_payload: message,  // Full payload for debugging
    });

    try {
      this.socket.emit('message', message);
      console.log('[Socket.IO] Message sent successfully:', { 
        text, 
        conversation_id: this.conversationId,
        tenantId: this.tenantId,
      });
    } catch (error) {
      console.error('[Socket.IO] Error sending message:', error);
      console.error('[Socket.IO] DEBUG - Failed message payload:', message);
      throw error;
    }
  }

  /**
   * Request list of online users (admin only)
   */
  requestOnlineUsers(): void {
    if (typeof window === 'undefined') {
      console.warn('[Socket.IO] Cannot request online users: Socket.IO is only available in the browser');
      return;
    }

    if (!this.socket || !this.socket.connected) {
      console.warn('[Socket.IO] Cannot request online users: not connected');
      return;
    }

    if (!this.isAdmin) {
      console.warn('[Socket.IO] Cannot request online users: not admin');
      return;
    }

    const payload: any = {
      type: 'get_online_users',
    };
    // Only add tenantId if available
    if (this.tenantId) {
      payload.tenantId = this.tenantId;
    }
    this.socket.emit('get_online_users', payload);
  }

  /**
   * Disconnect Socket.IO connection
   */
  disconnect(): void {
    this.shouldReconnect = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * Check if Socket.IO is connected
   */
  isConnected(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    return this.socket?.connected ?? false;
  }

  /**
   * Set user information (for logged-in users)
   */
  setUser(userId: string, userInfo?: UserInfo): void {
    this.userId = userId;
    this.userInfo = userInfo;
  }

  /**
   * Clear user information (logout)
   */
  clearUser(): void {
    this.userId = undefined;
    this.userInfo = undefined;
  }
}
