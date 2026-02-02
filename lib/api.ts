/**
 * Backend API client
 * Handles HTTP requests to the chat API
 * Production-ready with session management and user identification
 */

import { getSessionInfo, refreshSession, getConversationId, clearConversation, getSenderName } from './session';

const API_BASE_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || process.env.NEXT_PUBLIC_API_URL || 'https://api-gateway-dfcflow.fly.dev';

export interface Message {
  id: string;
  text: string;
  sender: 'user' | 'bot' | 'agent';
  timestamp: string;
  deliveryStatus?: 'pending' | 'delivered' | 'failed';
}

export interface SendMessageResponse {
  success: boolean;
  message?: Message;
  error?: string;
  conversationClosed?: boolean; // Indicates if conversation was closed and retried
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
  [key: string]: any; // Allow additional user properties
}

export interface AttachmentItem {
  type: 'image' | 'video' | 'audio' | 'document';
  payload: { url: string; filename?: string; content_type?: string; size?: number };
}

export interface SendMessageOptions {
  userId?: string; // For logged-in users
  userInfo?: UserInfo; // User information for logged-in users
  temp_id?: string; // Client-generated temp id for optimistic message replacement
  attachments?: { items: AttachmentItem[] }; // Optional file attachments (URLs from upload)
}

export interface OnlineUser {
  userId: string;
  sessionId?: string;
  connectedAt: string;
  domain?: string;
  origin?: string;
  url?: string;
}

export interface PresenceSessionResponse {
  tenant_id: string;
  site_id: string;
  session_id: string;
  ws_token: string;
  websocket_url: string;
}

export class ChatAPI {
  private tenantId: string | null;
  private baseUrl: string;
  private websiteInfo: WebsiteInfo;
  private userId?: string; // For logged-in users
  private userInfo?: UserInfo; // User information

  constructor(tenantId: string | null, websiteInfo?: WebsiteInfo, userId?: string, userInfo?: UserInfo) {
    this.tenantId = tenantId || null;
    this.baseUrl = API_BASE_URL;
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
      } else {
        // Last resort: use provided websiteInfo even if empty, or getWebsiteInfo() if not on webchat domain
        const fallback = this.getWebsiteInfo();
        if (fallback.domain && !fallback.domain.includes('webchat')) {
          this.websiteInfo = fallback;
        } else {
          // On webchat domain without URL params - this shouldn't happen in production
          this.websiteInfo = websiteInfo || {};
          console.warn('[ChatAPI] ⚠️ No domain info available. Widget loader should pass domain via URL params.');
        }
      }
    }
    this.userId = userId;
    this.userInfo = userInfo;
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
        console.warn('[ChatAPI] ⚠️ Widget is on webchat domain but no websiteInfo provided. This should not happen in production.');
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
   * Get API headers with tenant authentication
   * Note: Gateway extracts domain from X-Website-Origin header (or Origin/Referer fallback) and sets X-Tenant-ID itself
   * We send Authorization header with API key and custom headers with parent domain info
   */
  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    // Add API key if available (from env or config)
    // Gateway validates API key, extracts domain from X-Website-Origin header (or Origin/Referer fallback),
    // queries webchat_integration table for domain → gets tenant_id,
    // then sets X-Tenant-ID header before forwarding to backend
    const apiKey = process.env.NEXT_PUBLIC_GATEWAY_API_KEY || process.env.NEXT_PUBLIC_API_KEY;
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
    // Browser automatically sends Origin/Referer headers (from iframe domain), but Gateway should use X-Website-Origin first

    return headers;
  }

  /**
   * Fetch messages for the current conversation
   * Loads conversation history based on sessionId or userId
   */
  async getMessages(): Promise<Message[]> {
    try {
      const sessionInfo = getSessionInfo();
      
      // Build query params with session info
      const params = new URLSearchParams({
        sessionId: sessionInfo.sessionId,
      });

      // Only add tenantId if available - Gateway will resolve from domain if not provided
      if (this.tenantId) {
        params.append('tenantId', this.tenantId);
      }

      // Add userId if logged in
      if (this.userId) {
        params.append('userId', this.userId);
      }

      // Use /webchat/messages endpoint (consistent with /webchat/message and /webchat/init)
      // Keep domain info in headers (X-Website-Origin/X-Website-Domain) - Gateway handlers read from headers
      const response = await fetch(`${this.baseUrl}/webchat/messages?${params.toString()}`, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch messages: ${response.statusText}`);
      }

      const data = await response.json();
      return data.messages || [];
    } catch (error) {
      console.error('[ChatAPI] Error fetching messages:', error);
      return [];
    }
  }

  /**
   * Get messages for a specific conversation
   * Uses the /webchat/messages endpoint with conversationId parameter
   */
  async getConversationMessages(conversationId: string): Promise<any[]> {
    try {
      const response = await fetch(
        `${this.baseUrl}/webchat/messages?conversationId=${conversationId}`,
        {
          method: 'GET',
          headers: this.getHeaders(),
        }
      );
      
      if (!response.ok) {
        console.error('[API] Failed to fetch messages:', response.statusText);
        return [];
      }
      
      const data = await response.json();
      // API returns array directly, not wrapped in {messages: []}
      return Array.isArray(data) ? data : (data.messages || []);
    } catch (error) {
      console.error('[API] Error fetching messages:', error);
      return [];
    }
  }

  /**
   * Send a message
   * Supports both anonymous and logged-in users
   * Backend determines user type based on payload (userId presence)
   */
  async sendMessage(text: string, options?: SendMessageOptions): Promise<SendMessageResponse> {
    try {
      // Get session info (sessionId + fingerprint)
      const sessionInfo = getSessionInfo();
      
      // Refresh session to extend expiration
      refreshSession();

      // Prepare message payload
      const payload: any = {
        text,
        sessionId: sessionInfo.sessionId,
        fingerprint: sessionInfo.fingerprint,
        ...this.websiteInfo, // Include domain, origin, url, referrer, siteId
      };

      // Add conversation_id if available (to continue existing conversation)
      const conversationId = getConversationId();
      if (conversationId) {
        payload.conversation_id = conversationId;
      }

      // Only add tenantId if available - Gateway will resolve from domain if not provided
      if (this.tenantId) {
        payload.tenantId = this.tenantId;
      }

      // Add user identification if logged in
      const userId = options?.userId || this.userId;
      const userInfo = options?.userInfo || this.userInfo;

      if (userId) {
        // Logged-in user
        payload.userId = userId;
        if (userInfo) {
          payload.userInfo = userInfo;
        }
      }
      // If no userId, backend treats as anonymous user (uses sessionId + fingerprint)

      // Add sender_name if available (from welcome message)
      const senderName = getSenderName();
      if (senderName) {
        payload.sender_name = senderName;
      }

      // Add temp_id for optimistic message replacement (server echoes in meta_message_created)
      if (options?.temp_id) {
        payload.temp_id = options.temp_id;
      }

      // Add attachments if provided (URLs from upload service)
      if (options?.attachments?.items?.length) {
        payload.attachments = options.attachments;
      }

      // Retry logic for production
      let lastError: Error | null = null;
      const maxRetries = 3;
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const response = await fetch(`${this.baseUrl}/webchat/message`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            const errorText = await response.text().catch(() => response.statusText);
            
            // Check if error is about closed conversation
            const isClosedConversation = errorText.toLowerCase().includes('closed') || 
                                         errorText.toLowerCase().includes('conversation closed') ||
                                         response.status === 410; // 410 Gone often used for closed resources
            
            if (isClosedConversation && conversationId) {
              // Conversation is closed - clear stored conversation data
              clearConversation();
              
              // Retry without conversation_id to create a new conversation
              if (attempt < maxRetries - 1) {
                delete payload.conversation_id;
                const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
                await new Promise(resolve => setTimeout(resolve, delay));
                // Mark that we're retrying due to closed conversation
                payload._retryDueToClosed = true;
                continue;
              }
            }
            
            // Don't retry on client errors (4xx)
            if (response.status >= 400 && response.status < 500) {
              throw new Error(`Failed to send message: ${response.status} ${response.statusText} - ${errorText}`);
            }
            
            // Retry on server errors (5xx)
            throw new Error(`Server error: ${response.status} ${response.statusText}`);
          }

          const data = await response.json();
          
          // Check if response indicates conversation is closed
          const wasClosed = data.closed_at || data.conversation_closed;
          if (wasClosed) {
            clearConversation();
          }
          
          // Check if we retried due to closed conversation
          const retriedDueToClosed = payload._retryDueToClosed === true;
          
          // Update sessionId if backend returns a new one
          if (data.sessionId && data.sessionId !== sessionInfo.sessionId) {
            if (typeof window !== 'undefined') {
              try {
                localStorage.setItem('chat_session_id', data.sessionId);
              } catch (e) {
                console.warn('[ChatAPI] Failed to update sessionId:', e);
              }
            }
          }

          return {
            success: true,
            message: data.message,
            conversationClosed: wasClosed || retriedDueToClosed,
          };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error('Unknown error');
          
          // Don't retry on last attempt
          if (attempt < maxRetries - 1) {
            // Exponential backoff
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
      }

      // All retries failed
      throw lastError || new Error('Failed to send message after retries');
    } catch (error) {
      console.error('[ChatAPI] Error sending message:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Include more details for network errors
      if (error instanceof TypeError && error.message.includes('fetch')) {
        return {
          success: false,
          error: `Network error: ${errorMessage}. Check if the API endpoint is accessible.`,
        };
      }
      
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Initialize a new conversation session
   */
  async initializeSession(): Promise<{ sessionId: string } | null> {
    try {
      const payload: any = {};
      // Only add tenantId if available
      if (this.tenantId) {
        payload.tenantId = this.tenantId;
      }

      const response = await fetch(`${this.baseUrl}/api/chat/session`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Failed to initialize session: ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Error initializing session:', error);
      return null;
    }
  }

  /**
   * Initialize conversation and get JWT token for WebSocket connection
   * This is the new flow per Gateway plan: POST /webchat/init
   */
  async initializeConversation(visitorId?: string, sessionId?: string): Promise<{
    session_id: string;
    visitor_id: string;
    ws_token: string;
    ws_server_url: string;
    tenant_id: string;
    integration_id?: string;
    site_id?: string;
    expires_in: number;
    closed_at?: string | null;
  } | null> {
    try {
      const sessionInfo = getSessionInfo();
      
      // Prepare payload according to Gateway plan
      const payload: any = {
        ...this.websiteInfo, // domain, origin, url, siteId
      };

      // Only add tenantId if available - Gateway will resolve from domain if not provided
      if (this.tenantId) {
        payload.tenantId = this.tenantId;
      }

      // Add sessionId when available (session-first flow)
      // Priority: passed sessionId > sessionInfo.sessionId
      const effectiveSessionId = sessionId || sessionInfo.sessionId;
      if (effectiveSessionId) {
        payload.sessionId = effectiveSessionId;
      }

      // Add visitorId if provided (for returning users)
      if (visitorId) {
        payload.visitorId = visitorId;
      }

      // Add user identification if logged in
      if (this.userId) {
        payload.userId = this.userId;
        if (this.userInfo) {
          payload.userInfo = this.userInfo;
        }
      }

      const response = await fetch(`${this.baseUrl}/webchat/init`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`Failed to initialize conversation: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[ChatAPI] Error initializing conversation:', error);
      return null;
    }
  }

  /**
   * Create presence session (called on page load)
   * Initializes presence layer for online/offline tracking, idle timers, retargeting, AI greeting triggers
   */
  async createPresenceSession(): Promise<PresenceSessionResponse | null> {
    try {
      const sessionInfo = getSessionInfo();
      
      // Prepare payload with origin domain, user id, user name, email, user info
      const payload: any = {
        ...this.websiteInfo, // domain, origin, url, referrer, siteId
        sessionId: sessionInfo.sessionId,
        fingerprint: sessionInfo.fingerprint,
      };

      // Only add tenantId if available - Gateway will resolve from domain if not provided
      if (this.tenantId) {
        payload.tenantId = this.tenantId;
      }

      // Add user identification if logged in
      if (this.userId) {
        payload.userId = this.userId;
        if (this.userInfo) {
          payload.userInfo = this.userInfo;
          // Extract name and email from userInfo if available
          if (this.userInfo.name) {
            payload.userName = this.userInfo.name;
          }
          if (this.userInfo.email) {
            payload.email = this.userInfo.email;
          }
        }
      }

      const response = await fetch(`${this.baseUrl}/webchat/session`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`Failed to create presence session: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[ChatAPI] Error creating presence session:', error);
      return null;
    }
  }

  /**
   * Open chat (called when user clicks chat bubble)
   * Updates presence status to "bubble click"
   */
  async openChat(sessionId: string): Promise<boolean> {
    try {
      const payload: any = {
        sessionId,
        ...this.websiteInfo, // domain, origin, url, referrer, siteId
      };

      // Only add tenantId if available - Gateway will resolve from domain if not provided
      if (this.tenantId) {
        payload.tenantId = this.tenantId;
      }

      const response = await fetch(`${this.baseUrl}/webchat/open`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`Failed to open chat: ${response.status} ${response.statusText} - ${errorText}`);
      }

      return true;
    } catch (error) {
      console.error('[ChatAPI] Error opening chat:', error);
      return false;
    }
  }

  /**
   * Get list of online users for the tenant
   * Requires admin authentication
   * Gateway endpoint: GET /api/webchat/online-users → Forwards to Backend GET /v1/webchat/online-users
   */
  async getOnlineUsers(): Promise<OnlineUser[]> {
    try {
      const params = new URLSearchParams();
      // Only add tenantId if available
      if (this.tenantId) {
        params.append('tenantId', this.tenantId);
      }

      const response = await fetch(`${this.baseUrl}/api/webchat/online-users?${params.toString()}`, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch online users: ${response.statusText}`);
      }

      const data = await response.json();
      return data.users || [];
    } catch (error) {
      console.error('Error fetching online users:', error);
      return [];
    }
  }
}

