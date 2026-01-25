/**
 * Socket.IO client for real-time chat
 * Connects directly to Socket.IO server using ws_server_url from /webchat/init response
 */

import { io, Socket } from 'socket.io-client';
import { getSessionInfo, refreshSession, getConversationId, setConversationId, getVisitorId, isConversationExpired, clearConversation } from './session';

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
  integration_id?: string;
  site_id?: string;
  expires_in: number;
  closed_at?: string | null; // If present, conversation is closed
}

export class ChatWebSocketNative {
  private tenantId: string | null;
  private integrationId?: string;
  private siteId?: string;
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
  private tokenExpiresAt?: number; // Timestamp when token expires
  private tokenRefreshTimer?: ReturnType<typeof setTimeout>; // Timer for proactive refresh
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
      
      // Check if conversation expired - if so, don't use stored visitorId
      let storedVisitorId: string | undefined = undefined;
      if (!isConversationExpired()) {
        storedVisitorId = visitorId || getVisitorId() || undefined;
      } else {
        // Conversation expired, clear it
        clearConversation();
      }
      
      const payload: any = {
        ...this.websiteInfo,
      };

      // Only add tenantId if available - Gateway will resolve from domain if not provided
      if (this.tenantId) {
        payload.tenantId = this.tenantId;
      }

      if (storedVisitorId) {
        payload.visitorId = storedVisitorId;
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
      
      // Check if conversation is closed
      if (data.closed_at) {
        console.log('[Socket.IO] Conversation is closed (closed_at:', data.closed_at, '), clearing stored conversation data');
        // Clear stored conversation data since it's closed
        clearConversation();
        // Don't store the closed conversation's IDs - user should start a new conversation
        // But we still need the token and connection info for the new conversation
      }
      
      this.conversationId = data.conversation_id;
      this.visitorId = data.visitor_id;
      this.wsToken = data.ws_token;
      this.wsServerUrl = data.ws_server_url;
      
      // Store expiration timestamp (expires_in is in seconds)
      const expiresInMs = (data.expires_in || 900) * 1000; // Default 15 minutes (900s) if not provided
      this.tokenExpiresAt = Date.now() + expiresInMs;
      
      // Only store conversation ID and visitor ID if conversation is NOT closed
      if (!data.closed_at) {
        setConversationId(data.conversation_id, data.visitor_id);
      } else {
        // Conversation is closed - don't persist it, user will get a new one on next message
        console.log('[Socket.IO] Not storing closed conversation IDs - new conversation will be created on next message');
      }
      
      // Schedule proactive token refresh (refresh at 80% of expiration time)
      this.scheduleTokenRefresh(expiresInMs * 0.8);
      // Extract additional fields from Gateway response
      if (data.integration_id) {
        this.integrationId = data.integration_id;
      }
      if (data.site_id) {
        this.siteId = data.site_id;
      }
      // Extract tenant_id from response (Gateway should return it)
      const receivedTenantId = data.tenant_id;
      
      // Also try to extract tenant_id, integration_id, site_id from JWT token payload (fallback)
      let tokenTenantId: string | null = null;
      let tokenIntegrationId: string | null = null;
      let tokenSiteId: string | null = null;
      if (this.wsToken) {
        try {
          const base64Url = this.wsToken.split('.')[1];
          const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
          const jsonPayload = decodeURIComponent(atob(base64).split('').map((c) => {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          }).join(''));
          const tokenPayload = JSON.parse(jsonPayload);
          // Check for tenant_id in token (could be tenant_id, tenantId, or tenant_id)
          tokenTenantId = tokenPayload.tenant_id || tokenPayload.tenantId || tokenPayload.tenant_id || null;
          // Check for integration_id in token
          tokenIntegrationId = tokenPayload.integration_id || tokenPayload.integrationId || null;
          // Check for site_id in token
          tokenSiteId = tokenPayload.site_id || tokenPayload.siteId || null;
        } catch (e) {
          console.warn('[Socket.IO] DEBUG - Could not extract fields from token:', e);
        }
      }
      
      // Validate tenant_id - reject placeholder values
      const placeholderValues = ['your-tenant-id', 'tenant-id', 'your_tenant_id', 'tenant_id', ''];
      
      // Priority: 1) Gateway response, 2) JWT token payload, 3) constructor value
      let finalTenantId: string | null = null;
      let finalIntegrationId: string | null = null;
      let finalSiteId: string | null = null;
      
      if (receivedTenantId && !placeholderValues.includes(String(receivedTenantId).toLowerCase())) {
        finalTenantId = receivedTenantId;
      } else if (tokenTenantId && !placeholderValues.includes(String(tokenTenantId).toLowerCase())) {
        finalTenantId = tokenTenantId;
        console.log('[Socket.IO] Using tenant_id from JWT token payload');
      } else if (this.tenantId && !placeholderValues.includes(String(this.tenantId).toLowerCase())) {
        finalTenantId = this.tenantId;
        console.log('[Socket.IO] Using tenant_id from constructor');
      }
      
      // Extract integration_id: Gateway response > JWT token
      if (data.integration_id && !placeholderValues.includes(String(data.integration_id).toLowerCase())) {
        finalIntegrationId = data.integration_id;
      } else if (tokenIntegrationId && !placeholderValues.includes(String(tokenIntegrationId).toLowerCase())) {
        finalIntegrationId = tokenIntegrationId;
        console.log('[Socket.IO] Using integration_id from JWT token payload');
      }
      
      // Extract site_id: Gateway response > JWT token
      if (data.site_id && !placeholderValues.includes(String(data.site_id).toLowerCase())) {
        finalSiteId = data.site_id;
      } else if (tokenSiteId && !placeholderValues.includes(String(tokenSiteId).toLowerCase())) {
        finalSiteId = tokenSiteId;
        console.log('[Socket.IO] Using site_id from JWT token payload');
      }
      
      if (receivedTenantId && placeholderValues.includes(String(receivedTenantId).toLowerCase())) {
        console.error('[Socket.IO] ERROR - Gateway returned placeholder tenant_id:', receivedTenantId);
        console.error('[Socket.IO] Gateway should return actual tenant_id, not a placeholder');
      } else if (!receivedTenantId) {
        console.warn('[Socket.IO] WARNING - Gateway did not return tenant_id in response body');
      }
      
      this.tenantId = finalTenantId;
      this.integrationId = finalIntegrationId || this.integrationId;
      this.siteId = finalSiteId || this.siteId;
      
      // Log where tenantId came from
      console.log('[Socket.IO] DEBUG - Field extraction summary:', {
        tenantId: {
          from_gateway_response: receivedTenantId,
          from_jwt_token: tokenTenantId,
          from_constructor: this.tenantId !== finalTenantId ? this.tenantId : null,
          final: this.tenantId,
        },
        integrationId: {
          from_gateway_response: data.integration_id,
          from_jwt_token: tokenIntegrationId,
          final: this.integrationId,
        },
        siteId: {
          from_gateway_response: data.site_id,
          from_jwt_token: tokenSiteId,
          final: this.siteId,
        },
        full_response: data,  // Show full Gateway response
      });

      // Debug logging - show tenantId details
      console.log('[Socket.IO] Conversation initialized:', {
        conversation_id: this.conversationId,
        visitor_id: this.visitorId,
        tenant_id: this.tenantId,
        tenant_id_type: typeof this.tenantId,
        tenant_id_value: this.tenantId,
        integration_id: this.integrationId,
        site_id: this.siteId,
        ws_server_url: this.wsServerUrl,
        expires_in: data.expires_in,
      });
      console.log('[Socket.IO] DEBUG - Init response data:', {
        conversation_id: data.conversation_id,
        visitor_id: data.visitor_id,
        tenant_id: data.tenant_id,
        tenant_id_type: typeof data.tenant_id,
        tenant_id_raw: data.tenant_id,
        integration_id: data.integration_id,
        integration_id_type: typeof data.integration_id,
        site_id: data.site_id,
        site_id_type: typeof data.site_id,
        has_ws_token: !!data.ws_token,
        has_ws_server_url: !!data.ws_server_url,
        expires_in: data.expires_in,
        full_response: data,  // Full response for debugging - check if tenant_id, integration_id, site_id are here
        response_keys: Object.keys(data),  // Show all keys in response
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
      console.log('[Socket.IO] Disconnecting existing socket before reconnecting...');
      this.socket.removeAllListeners(); // Remove all listeners to prevent duplicates
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
      console.log('[Socket.IO] DEBUG - Setting up event listeners...');

      // Set up event listeners BEFORE connection is established
      // This ensures listeners are ready when connection happens
      
      // DEBUG: Listen to ALL events to see what's actually being received
      this.socket.onAny((eventName: string, ...args: any[]) => {
        console.log('[Socket.IO] 🔍 DEBUG - Received ANY event:', {
          eventName,
          argsCount: args.length,
          firstArg: args[0],
          firstArgType: typeof args[0],
          firstArgKeys: args[0] && typeof args[0] === 'object' ? Object.keys(args[0]) : 'N/A',
        });
      });
      
      // Handle incoming messages
      this.socket.on('message', (data: any) => {
        console.log('[Socket.IO] Message received:', data);
        this.handleMessage(data);
      });

      // Handle meta_message_created events (from backend when messages are saved to DB)
      // This is how admin/agent messages are delivered to frontend
      this.socket.on('meta_message_created', (data: any) => {
        console.log('[Socket.IO] ✅ meta_message_created event received:', data);
        console.log('[Socket.IO] DEBUG - Event data structure:', {
          has_message: !!data.message,
          has_data: !!data,
          data_keys: data ? Object.keys(data) : [],
          data_type: typeof data,
          is_array: Array.isArray(data),
        });
        // Extract message from data.message or use data directly
        const message = data.message || data;
        console.log('[Socket.IO] DEBUG - Extracted message:', message);
        console.log('[Socket.IO] DEBUG - Calling handleMessage with:', message);
        this.handleMessage(message);
      });

      // Handle AI event created events (optional, for AI responses)
      this.socket.on('ai_event_created', (data: any) => {
        console.log('[Socket.IO] AI event created:', data);
        // Extract message from data.message or use data directly
        const message = data.message || data;
        this.handleMessage(message);
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

      // Connection established
      this.socket.on('connect', () => {
        console.log('[Socket.IO] ✅ Connected successfully');
        console.log('[Socket.IO] DEBUG - Connection details:', {
          id: this.socket?.id,
          connected: this.socket?.connected,
          transport: this.socket?.io?.engine?.transport?.name,
        });
        this.reconnectAttempts = 0;
        
        // Join conversation room
        if (this.conversationId && this.socket) {
          console.log('[Socket.IO] Joining conversation room:', this.conversationId);
          this.socket.emit('join:conversation', { conversationId: this.conversationId });
        } else {
          console.warn('[Socket.IO] WARNING - Cannot join conversation room:', {
            has_conversation_id: !!this.conversationId,
            has_socket: !!this.socket,
          });
        }
        
        this.callbacks.onConnect?.();
      });

      // Listen for joined event from server (confirmation of room join)
      this.socket.on('joined', (data: { conversation_id: string; room: string }) => {
        console.log('[Socket.IO] ✅ Joined conversation room:', {
          conversation_id: data.conversation_id,
          room: data.room,
        });
        console.log('[Socket.IO] DEBUG - Room join confirmed. Socket is now listening for events in room:', data.room);
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

        // Check if token might be expired
        const isTokenExpired = this.isTokenExpired();
        const isAuthError = reason === 'io server disconnect' || 
                           reason.includes('auth') || 
                           reason.includes('token') ||
                           reason.includes('unauthorized');

        // Attempt reconnection if needed (Socket.IO handles this automatically, but we can re-initialize if token expired)
        if (this.shouldReconnect && (isAuthError || isTokenExpired)) {
          // Server disconnected us or token expired, need to re-authenticate
          console.log('[Socket.IO] Token expired or auth error, re-initializing...', {
            reason,
            isTokenExpired,
            isAuthError,
          });
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
    console.log('[Socket.IO] handleMessage called with:', data);
    console.log('[Socket.IO] DEBUG - Message structure:', {
      has_type: !!data?.type,
      type_value: data?.type,
      has_message: !!data?.message,
      has_callbacks: !!this.callbacks.onMessage,
      data_keys: data ? Object.keys(data) : [],
    });
    
    // Handle different message types
    if (data.type === 'message' || data.message) {
      const message = data.message || data;
      console.log('[Socket.IO] Calling onMessage callback with:', message);
      this.callbacks.onMessage?.(message);
    } else {
      // Default: treat as message
      console.log('[Socket.IO] Calling onMessage callback with data directly:', data);
      this.callbacks.onMessage?.(data);
    }
    
    console.log('[Socket.IO] handleMessage completed');
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

    // tenantId is REQUIRED by the server - throw error if not available or if it's a placeholder
    const placeholderValues = ['your-tenant-id', 'tenant-id', 'your_tenant_id', 'tenant_id', ''];
    const isPlaceholder = this.tenantId && placeholderValues.includes(String(this.tenantId).toLowerCase());
    
    if (!this.tenantId || isPlaceholder) {
      const error = new Error(
        isPlaceholder 
          ? `tenantId is a placeholder value ("${this.tenantId}"). Gateway must return actual tenant_id in /webchat/init response.`
          : 'tenantId is required but not available. Make sure initialize() was called successfully and Gateway returned tenant_id.'
      );
      console.error('[Socket.IO] ERROR - Invalid tenantId:', {
        tenantId: this.tenantId,
        is_placeholder: isPlaceholder,
        conversation_id: this.conversationId,
        visitor_id: this.visitorId,
        has_ws_token: !!this.wsToken,
        has_ws_server_url: !!this.wsServerUrl,
      });
      throw error;
    }

    // integration_id is REQUIRED by the server - throw error if not available
    if (!this.integrationId) {
      const error = new Error(
        'integration_id is required but not available. Gateway must return integration_id in /webchat/init response or include it in JWT token payload.'
      );
      console.error('[Socket.IO] ERROR - Missing integration_id:', {
        tenantId: this.tenantId,
        integrationId: this.integrationId,
        siteId: this.siteId,
        conversation_id: this.conversationId,
        visitor_id: this.visitorId,
        has_ws_token: !!this.wsToken,
        has_ws_server_url: !!this.wsServerUrl,
      });
      throw error;
    }

    // Prepare message payload according to Gateway plan
    // Server might expect tenant_id (snake_case) or tenantId (camelCase) - send both to be safe
    const message: any = {
      type: 'message',
      text,
      tenantId: this.tenantId,  // camelCase
      tenant_id: this.tenantId,  // snake_case (server might expect this)
      conversation_id: this.conversationId,
      visitor_id: this.visitorId,
      timestamp: new Date().toISOString(),
      sessionId: sessionInfo.sessionId,
      fingerprint: sessionInfo.fingerprint,
      ...this.websiteInfo,
    };

    // Add integration_id and site_id if available (from Gateway response)
    if (this.integrationId) {
      message.integration_id = this.integrationId;
      message.integrationId = this.integrationId;  // Send both formats
    }
    if (this.siteId) {
      message.site_id = this.siteId;
      message.siteId = this.siteId;  // Send both formats
    }

    if (this.userId) {
      message.userId = this.userId;
      if (this.userInfo) {
        message.userInfo = this.userInfo;
      }
    }

    // Debug logging - show complete message payload
    console.log('[Socket.IO] DEBUG - Complete message payload being sent:', message);
    console.log('[Socket.IO] DEBUG - Message payload details:', {
      type: message.type,
      text: message.text,
      tenantId: message.tenantId,
      tenantId_type: typeof message.tenantId,
      tenant_id: message.tenant_id,
      tenant_id_type: typeof message.tenant_id,
      integration_id: message.integration_id,
      integrationId: message.integrationId,
      site_id: message.site_id,
      siteId: message.siteId,
      conversation_id: message.conversation_id,
      visitor_id: message.visitor_id,
      sessionId: message.sessionId,
      fingerprint: message.fingerprint,
      timestamp: message.timestamp,
      domain: message.domain,
      origin: message.origin,
      url: message.url,
      referrer: message.referrer,
      siteId_from_websiteInfo: message.siteId,
      userId: message.userId,
      userInfo: message.userInfo,
    });
    console.log('[Socket.IO] DEBUG - Full payload JSON:', JSON.stringify(message, null, 2));

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
   * Schedule proactive token refresh before expiration
   */
  private scheduleTokenRefresh(refreshInMs: number): void {
    // Clear existing timer
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    // Don't schedule if refresh time is too short (< 1 minute)
    if (refreshInMs < 60000) {
      console.warn('[Socket.IO] Token expires too soon, skipping proactive refresh');
      return;
    }

    console.log(`[Socket.IO] Token refresh scheduled in ${Math.round(refreshInMs / 1000)}s`);

    this.tokenRefreshTimer = setTimeout(async () => {
      if (this.socket && this.socket.connected) {
        console.log('[Socket.IO] Proactively refreshing token before expiration...');
        try {
          // Re-initialize to get new token
          const result = await this.initialize(this.visitorId);
          if (result && this.socket) {
            // Disconnect old connection and reconnect with new token
            const wasConnected = this.socket.connected;
            this.socket.disconnect();
            
            if (wasConnected) {
              // Reconnect with new token
              this.connect();
            }
          }
        } catch (error) {
          console.error('[Socket.IO] Failed to refresh token:', error);
          // Token refresh failed - let Socket.IO handle reconnection
        }
      }
    }, refreshInMs);
  }

  /**
   * Check if JWT token is expired or about to expire
   */
  isTokenExpired(): boolean {
    if (!this.tokenExpiresAt) {
      return true; // No token = expired
    }
    // Consider expired if less than 1 minute remaining
    return Date.now() >= (this.tokenExpiresAt - 60000);
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

    // Clear token refresh timer
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
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
