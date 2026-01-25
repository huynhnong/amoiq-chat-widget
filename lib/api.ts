/**
 * Backend API client
 * Handles HTTP requests to the chat API
 * Production-ready with session management and user identification
 */

import { getSessionInfo, refreshSession } from './session';

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

export interface SendMessageOptions {
  userId?: string; // For logged-in users
  userInfo?: UserInfo; // User information for logged-in users
}

export interface OnlineUser {
  userId: string;
  sessionId?: string;
  connectedAt: string;
  domain?: string;
  origin?: string;
  url?: string;
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
        console.log('[ChatAPI] Using website info from URL params:', this.websiteInfo);
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
            
            // Don't retry on client errors (4xx)
            if (response.status >= 400 && response.status < 500) {
              throw new Error(`Failed to send message: ${response.status} ${response.statusText} - ${errorText}`);
            }
            
            // Retry on server errors (5xx)
            throw new Error(`Server error: ${response.status} ${response.statusText}`);
          }

          const data = await response.json();
          
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
  async initializeConversation(visitorId?: string): Promise<{
    conversation_id: string;
    visitor_id: string;
    ws_token: string;
    expires_in: number;
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

