/**
 * Native WebSocket client for real-time chat
 * Implements Gateway plan: JWT token authentication, Redis pub/sub
 * Replaces Socket.io with native WebSocket
 */

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
  expires_in: number;
}

export class ChatWebSocketNative {
  private tenantId: string | null;
  private ws: WebSocket | null = null;
  private callbacks: WebSocketCallbacks;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private shouldReconnect = true;
  private wsUrl: string;
  private websiteInfo: WebsiteInfo;
  private isAdmin: boolean;
  private userId?: string;
  private userInfo?: UserInfo;
  private conversationId?: string;
  private visitorId?: string;
  private wsToken?: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
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
        console.log('[WebSocket Native] Using website info from URL params:', this.websiteInfo);
      } else {
        // Last resort: use provided websiteInfo even if empty, or getWebsiteInfo() if not on webchat domain
        const fallback = this.getWebsiteInfo();
        if (fallback.domain && !fallback.domain.includes('webchat')) {
          this.websiteInfo = fallback;
        } else {
          // On webchat domain without URL params - this shouldn't happen in production
          this.websiteInfo = websiteInfo || {};
          console.warn('[WebSocket Native] ⚠️ No domain info available. Widget loader should pass domain via URL params.');
        }
      }
    }
    
    this.isAdmin = isAdmin;
    this.userId = userId;
    this.userInfo = userInfo;
    
    // Get Gateway URL
    this.gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL || process.env.NEXT_PUBLIC_API_URL || 'https://api-gateway-dfcflow.fly.dev';
    
    // Convert HTTP/HTTPS to WS/WSS
    this.wsUrl = this.gatewayUrl.replace(/^https?:/, (match) => match === 'https:' ? 'wss:' : 'ws:');
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
        console.warn('[WebSocket Native] ⚠️ Widget is on webchat domain but no websiteInfo provided. This should not happen in production.');
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
   * Initialize conversation and get JWT token
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

      console.log('[WebSocket Native] Conversation initialized:', {
        conversation_id: this.conversationId,
        visitor_id: this.visitorId,
        expires_in: data.expires_in,
      });

      return data;
    } catch (error) {
      console.error('[WebSocket Native] Error initializing conversation:', error);
      this.callbacks.onError?.(error instanceof Error ? error : new Error('Failed to initialize conversation'));
      return null;
    }
  }

  /**
   * Connect to WebSocket with JWT token
   * Must call initialize() first
   */
  connect(): void {
    // Ensure we're in the browser (not SSR)
    if (typeof window === 'undefined') {
      console.warn('[WebSocket Native] Cannot connect: WebSocket is only available in the browser');
      return;
    }

    if (!this.wsToken) {
      console.error('[WebSocket Native] Cannot connect: no JWT token. Call initialize() first.');
      this.callbacks.onError?.(new Error('No JWT token. Call initialize() first.'));
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      console.log('[WebSocket Native] Already connected or connecting');
      return;
    }

    try {
      // Connect with JWT token in query parameter
      const wsUrlWithToken = `${this.wsUrl}/ws?token=${encodeURIComponent(this.wsToken)}`;
      console.log('[WebSocket Native] Connecting to:', wsUrlWithToken.replace(this.wsToken, '***'));

      this.ws = new WebSocket(wsUrlWithToken);

      this.ws.onopen = () => {
        console.log('[WebSocket Native] ✅ Connected successfully');
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.callbacks.onConnect?.();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (error) {
          console.error('[WebSocket Native] Error parsing message:', error, event.data);
        }
      };

      this.ws.onerror = (error) => {
        console.error('[WebSocket Native] ❌ WebSocket error:', error);
        this.callbacks.onError?.(new Error('WebSocket connection error'));
      };

      this.ws.onclose = (event) => {
        console.log('[WebSocket Native] Disconnected:', event.code, event.reason);
        this.stopHeartbeat();
        this.callbacks.onDisconnect?.();

        // Attempt reconnection if needed
        if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);
          console.log(`[WebSocket Native] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          
          this.reconnectTimer = setTimeout(() => {
            // Re-initialize if token might be expired
            if (this.reconnectAttempts > 2) {
              this.initialize(this.visitorId).then(() => {
                this.connect();
              });
            } else {
              this.connect();
            }
          }, delay);
        }
      };
    } catch (error) {
      console.error('[WebSocket Native] Error creating connection:', error);
      this.callbacks.onError?.(error as Error);
    }
  }

  /**
   * Handle incoming messages from WebSocket
   */
  private handleMessage(data: any): void {
    console.log('[WebSocket Native] Message received:', data);

    // Handle different message types
    if (data.type === 'message' || data.message) {
      const message = data.message || data;
      this.callbacks.onMessage?.(message);
    } else if (data.type === 'user_online') {
      this.callbacks.onUserOnline?.(data);
    } else if (data.type === 'user_offline') {
      this.callbacks.onUserOffline?.(data.userId || data);
    } else if (data.type === 'online_users_list') {
      this.callbacks.onOnlineUsersList?.(data.users || data);
    } else {
      // Default: treat as message
      this.callbacks.onMessage?.(data);
    }
  }

  /**
   * Send a message through WebSocket
   * Message is pushed to Redis stream chat_incoming
   */
  async sendMessage(text: string): Promise<void> {
    if (typeof window === 'undefined') {
      throw new Error('WebSocket is only available in the browser');
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    const sessionInfo = getSessionInfo();
    refreshSession();

    // Prepare message payload according to Gateway plan
    const message: any = {
      type: 'message',
      text,
      conversation_id: this.conversationId,
      visitor_id: this.visitorId,
      timestamp: new Date().toISOString(),
      sessionId: sessionInfo.sessionId,
      fingerprint: sessionInfo.fingerprint,
      ...this.websiteInfo,
    };

    // Only add tenant_id if available
    if (this.tenantId) {
      message.tenant_id = this.tenantId;
    }

    if (this.userId) {
      message.userId = this.userId;
      if (this.userInfo) {
        message.userInfo = this.userInfo;
      }
    }

    try {
      this.ws.send(JSON.stringify(message));
      console.log('[WebSocket Native] Message sent:', { text, conversation_id: this.conversationId });
    } catch (error) {
      console.error('[WebSocket Native] Error sending message:', error);
      throw error;
    }
  }

  /**
   * Request list of online users (admin only)
   */
  requestOnlineUsers(): void {
    if (typeof window === 'undefined') {
      console.warn('[WebSocket Native] Cannot request online users: WebSocket is only available in the browser');
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[WebSocket Native] Cannot request online users: not connected');
      return;
    }

    if (!this.isAdmin) {
      console.warn('[WebSocket Native] Cannot request online users: not admin');
      return;
    }

    const payload: any = {
      type: 'get_online_users',
    };
    // Only add tenantId if available
    if (this.tenantId) {
      payload.tenantId = this.tenantId;
    }
    this.ws.send(JSON.stringify(payload));
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        } catch (error) {
          console.error('[WebSocket Native] Heartbeat error:', error);
        }
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  /**
   * Disconnect WebSocket
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    return this.ws?.readyState === WebSocket.OPEN;
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

