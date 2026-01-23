/**
 * Backend API client
 * Handles HTTP requests to the chat API
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || process.env.NEXT_PUBLIC_API_URL || 'https://api-gateway-dfcflow.fly.dev';

export interface Message {
  id: string;
  text: string;
  sender: 'user' | 'bot' | 'agent';
  timestamp: string;
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

export class ChatAPI {
  private tenantId: string;
  private baseUrl: string;
  private websiteInfo: WebsiteInfo;

  constructor(tenantId: string, websiteInfo?: WebsiteInfo) {
    this.tenantId = tenantId;
    this.baseUrl = API_BASE_URL;
    this.websiteInfo = websiteInfo || this.getWebsiteInfo();
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

  /**
   * Get API headers with tenant authentication
   */
  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    // Add tenant ID to headers
    headers['X-Tenant-ID'] = this.tenantId;

    // Add API key if available (from env or config)
    const apiKey = process.env.NEXT_PUBLIC_GATEWAY_API_KEY || process.env.NEXT_PUBLIC_API_KEY;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    return headers;
  }

  /**
   * Fetch messages for the current conversation
   */
  async getMessages(): Promise<Message[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/chat/messages`, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch messages: ${response.statusText}`);
      }

      const data = await response.json();
      return data.messages || [];
    } catch (error) {
      console.error('Error fetching messages:', error);
      return [];
    }
  }

  /**
   * Send a message
   */
  async sendMessage(text: string): Promise<SendMessageResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/webchat/message`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          text,
          tenantId: this.tenantId,
          ...this.websiteInfo, // Include domain, origin, url, referrer, siteId
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        success: true,
        message: data.message,
      };
    } catch (error) {
      console.error('Error sending message:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Initialize a new conversation session
   */
  async initializeSession(): Promise<{ sessionId: string } | null> {
    try {
      const response = await fetch(`${this.baseUrl}/api/chat/session`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          tenantId: this.tenantId,
        }),
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
}

