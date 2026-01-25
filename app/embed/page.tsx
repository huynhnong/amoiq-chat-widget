'use client';

import { useEffect, useState, useRef } from 'react';
import { getTenantId } from '@/lib/tenant';
import { ChatAPI, UserInfo } from '@/lib/api';
import { ChatWebSocketNative } from '@/lib/ws-native';
import { getSessionInfo, hasValidSession, getVisitorId, isConversationExpired, clearConversation } from '@/lib/session';
import styles from './styles.module.css';

// Force dynamic rendering - no caching
export const dynamic = 'force-dynamic';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'bot' | 'agent' | 'system';
  timestamp: string;
  deliveryStatus?: 'pending' | 'delivered' | 'failed';
}

const MESSAGES_STORAGE_KEY = 'chat_messages';
const MESSAGES_STORAGE_VERSION = '1';

// Save messages to localStorage
function saveMessagesToStorage(messages: Message[]): void {
  if (typeof window === 'undefined') return;
  try {
    const data = {
      version: MESSAGES_STORAGE_VERSION,
      messages,
      savedAt: Date.now(),
    };
    localStorage.setItem(MESSAGES_STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    console.warn('[Widget] Failed to save messages to localStorage:', error);
  }
}

// Load messages from localStorage
function loadMessagesFromStorage(): Message[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(MESSAGES_STORAGE_KEY);
    if (!stored) return [];
    
    const data = JSON.parse(stored);
    // Check if data is valid and not too old (24 hours)
    if (data && data.messages && Array.isArray(data.messages)) {
      const age = Date.now() - (data.savedAt || 0);
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      
      if (age < maxAge) {
        return data.messages;
      } else {
        // Messages too old, clear them
        localStorage.removeItem(MESSAGES_STORAGE_KEY);
        return [];
      }
    }
    return [];
  } catch (error) {
    console.warn('[Widget] Failed to load messages from localStorage:', error);
    return [];
  }
}

// Clear messages from localStorage
function clearMessagesFromStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(MESSAGES_STORAGE_KEY);
  } catch (error) {
    console.warn('[Widget] Failed to clear messages from localStorage:', error);
  }
}

export default function EmbedPage() {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false); // Start as false - only show loading when initializing
  const [wsError, setWsError] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<ChatWebSocketNative | null>(null);
  const apiRef = useRef<ChatAPI | null>(null);

  /**
   * Get website info from parent window or detect from current context
   * Priority: URL params (from widget loader) > document.referrer > parent window > current window (but never use webchat.amoiq.com)
   */
  const getWebsiteInfo = (): { domain?: string; origin?: string; url?: string; referrer?: string; siteId?: string } => {
    // Get from URL params FIRST (passed from widget loader - most reliable for cross-origin iframes)
    const params = new URLSearchParams(window.location.search);
    const siteId = params.get('siteId');
    const domain = params.get('domain');
    const origin = params.get('origin');
    const url = params.get('url');
    const referrer = params.get('referrer');

    // URL params are the primary source (widget loader sets these from parent page)
    if (domain || origin || url) {
      const websiteInfo = {
        domain: domain || undefined,
        origin: origin || undefined,
        url: url || undefined,
        referrer: referrer || undefined,
        siteId: siteId || undefined,
      };
      console.log('[Widget] Using website info from URL params:', websiteInfo);
      return websiteInfo;
    }

    // Fallback 1: Try to extract domain from document.referrer (parent page that loaded the iframe)
    if (typeof document !== 'undefined' && document.referrer) {
      try {
        const referrerUrl = new URL(document.referrer);
        const referrerHostname = referrerUrl.hostname;
        const referrerOrigin = referrerUrl.origin;
        
        // Don't use if it's the widget domain itself
        if (referrerHostname !== 'webchat.amoiq.com' && !referrerHostname.includes('webchat')) {
          const websiteInfo = {
            domain: referrerHostname,
            origin: referrerOrigin,
            url: document.referrer,
            referrer: document.referrer,
            siteId: siteId || undefined,
          };
          console.log('[Widget] Using website info from document.referrer:', websiteInfo);
          return websiteInfo;
        }
      } catch (e) {
        console.log('[Widget] Could not parse document.referrer:', e);
      }
    }

    // Fallback 2: Try to get from parent window (if same-origin iframe)
    if (window.parent && window.parent !== window) {
      try {
        const parentOrigin = window.parent.location.origin;
        const parentHostname = window.parent.location.hostname;
        // Don't use if it's the widget domain itself
        if (parentHostname !== 'webchat.amoiq.com' && !parentHostname.includes('webchat')) {
          const websiteInfo = {
            domain: parentHostname,
            origin: parentOrigin,
            url: window.parent.location.href,
            referrer: document.referrer || '',
            siteId: siteId || undefined,
          };
          console.log('[Widget] Using website info from parent window:', websiteInfo);
          return websiteInfo;
        }
      } catch (e) {
        // Cross-origin iframe - can't access parent
        console.log('[Widget] Cross-origin iframe, cannot access parent window');
      }
    }

    // Fallback 3: detect from current window (for direct access/testing)
    // BUT: Never use webchat.amoiq.com - this means URL params weren't passed
    if (typeof window !== 'undefined') {
      const currentHostname = window.location.hostname;
      // If we're on webchat.amoiq.com and no URL params, something is wrong
      if (currentHostname === 'webchat.amoiq.com' || currentHostname.includes('webchat')) {
        console.error('[Widget] ❌ ERROR: Widget is on webchat domain but no URL params found. Widget loader should pass domain/origin via URL params.');
        console.error('[Widget] This means the widget is being accessed directly or widget loader is not working correctly.');
        // Still return empty - Gateway will handle missing domain
        return {};
      }
      
      const websiteInfo = {
        domain: currentHostname,
        origin: window.location.origin,
        url: window.location.href,
        referrer: document.referrer || '',
        siteId: siteId || undefined,
      };
      console.log('[Widget] Using website info from current window (fallback):', websiteInfo);
      return websiteInfo;
    }

    console.error('[Widget] ❌ Could not determine website info - no domain available');
    return {};
  };

  /**
   * Get user info from URL params or parent window
   * Supports logged-in users with userId and userInfo
   */
  const getUserInfo = (): { userId?: string; userInfo?: UserInfo } => {
    const params = new URLSearchParams(window.location.search);
    
    // Try to get from URL params
    const userId = params.get('userId');
    const userName = params.get('userName');
    const userEmail = params.get('userEmail');
    const userPhone = params.get('userPhone');
    
    if (userId) {
      const userInfo: UserInfo = {};
      if (userName) userInfo.name = userName;
      if (userEmail) userInfo.email = userEmail;
      if (userPhone) userInfo.phone = userPhone;
      
      return { userId, userInfo: Object.keys(userInfo).length > 0 ? userInfo : undefined };
    }
    
    // Try to get from parent window (if embedded)
    if (window.parent && window.parent !== window) {
      try {
        const parentConfig = (window.parent as any).ChatWidgetConfig;
        if (parentConfig?.userId) {
          return {
            userId: parentConfig.userId,
            userInfo: parentConfig.userInfo,
          };
        }
      } catch (e) {
        // Cross-origin - can't access
      }
    }
    
    return {};
  };

  useEffect(() => {
    // Get tenant ID from URL params (support both 'tenantId' and 'tenant')
    // tenantId is optional - Gateway will resolve it from domain if not provided
    const params = new URLSearchParams(window.location.search);
    const tid = params.get('tenantId') || params.get('tenant');
    
    setTenantId(tid);
    
    // Get website info
    const websiteInfo = getWebsiteInfo();
    const urlParams = new URLSearchParams(window.location.search);
    console.log('[Widget] Website info:', websiteInfo);
    console.log('[Widget] URL params:', urlParams.toString());
    console.log('[Widget] URL param domain:', urlParams.get('domain'));
    console.log('[Widget] URL param origin:', urlParams.get('origin'));
    console.log('[Widget] Current window hostname:', typeof window !== 'undefined' ? window.location.hostname : 'N/A');
    
    // Validate that we have proper domain info (not webchat.amoiq.com)
    if (websiteInfo.domain === 'webchat.amoiq.com' || websiteInfo.origin?.includes('webchat.amoiq.com')) {
      console.error('[Widget] ❌ ERROR: Website info contains webchat.amoiq.com domain!');
      console.error('[Widget] This means URL params were not passed correctly by widget loader.');
      console.error('[Widget] Expected: domain from parent website (e.g., amoiq.com)');
      console.error('[Widget] Got:', websiteInfo);
      console.error('[Widget] URL params check:', {
        hasDomain: !!urlParams.get('domain'),
        hasOrigin: !!urlParams.get('origin'),
        domain: urlParams.get('domain'),
        origin: urlParams.get('origin'),
      });
    } else if (websiteInfo.domain || websiteInfo.origin) {
      console.log('[Widget] ✅ Valid domain detected:', websiteInfo.domain || websiteInfo.origin);
    } else {
      console.warn('[Widget] ⚠️ No domain info available - Gateway may not be able to identify tenant');
    }
    
    // Get user info (for logged-in users)
    const { userId, userInfo } = getUserInfo();
    const sessionInfo = getSessionInfo();
    
    // Check if session or conversation expired
    const sessionExpired = !hasValidSession();
    const conversationExpired = isConversationExpired();
    
    if (sessionExpired || conversationExpired) {
      console.log('[Widget] Session or conversation expired, clearing data');
      // Clear conversation data
      if (conversationExpired) {
        clearConversation();
      }
      // Clear messages from UI and storage (start fresh)
      clearMessagesFromStorage();
      setMessages([]);
    } else {
      // Load messages from localStorage immediately (for instant display on refresh)
      const cachedMessages = loadMessagesFromStorage();
      if (cachedMessages.length > 0) {
        console.log(`[Widget] Loaded ${cachedMessages.length} messages from cache`);
        setMessages(cachedMessages);
      }
    }
    
    console.log('[Widget] Session info:', {
      sessionId: sessionInfo.sessionId,
      fingerprint: sessionInfo.fingerprint,
      hasValidSession: hasValidSession(),
      userId: userId || 'anonymous',
      conversationExpired,
      sessionExpired,
    });
    
    // Initialize API client with website info and user info
    // Pass tenantId (can be null) - Gateway will resolve from domain if not provided
    apiRef.current = new ChatAPI(tid, websiteInfo, userId, userInfo);
    
    // Only load history if session/conversation is still valid
    if (!sessionExpired && !conversationExpired) {
      loadConversationHistory();
    }
    
    // Listen for chat open message from parent (when user clicks chat bubble)
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'amoiq-widget-open' && !isInitialized && !wsRef.current) {
        console.log('[Widget] Chat opened, initializing WebSocket...');
        initializeWebSocket();
      }
    };

    window.addEventListener('message', handleMessage);
    
    return () => {
      window.removeEventListener('message', handleMessage);
      wsRef.current?.disconnect();
    };
  }, [isInitialized]);

  // Initialize WebSocket only when needed (lazy initialization)
  const initializeWebSocket = async () => {
    if (isInitialized || wsRef.current) {
      return; // Already initialized
    }
    
    setIsLoading(true);
    setIsInitialized(true);
    
    try {
      // Get website info and user info again (in case they changed)
      const websiteInfo = getWebsiteInfo();
      const { userId, userInfo } = getUserInfo();
      const params = new URLSearchParams(window.location.search);
      const tid = params.get('tenantId') || params.get('tenant');
      
      // Create a promise that resolves when WebSocket connects
      let resolveConnect: (() => void) | null = null;
      const connectPromise = new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });
      
      // Create WebSocket client
      // Pass tenantId (can be null) - Gateway will resolve from domain if not provided
      wsRef.current = new ChatWebSocketNative(tid, {
        onMessage: (message) => {
          setMessages((prev) => {
            // Normalize message format - ensure sender type is consistent
            // Handle different server formats (sender_type, sender, etc.)
            let normalizedMessage = { ...message };
            if (message.sender_type) {
              normalizedMessage.sender = message.sender_type === 'user' ? 'user' : (message.sender_type === 'agent' ? 'agent' : 'bot');
            }
            // Ensure sender is one of the valid types
            if (!normalizedMessage.sender || !['user', 'bot', 'agent', 'system'].includes(normalizedMessage.sender)) {
              normalizedMessage.sender = 'bot'; // Default to bot if unknown
            }
            
            // If message has an ID, try to update existing message (for delivery status)
            if (normalizedMessage.id) {
              const existingIndex = prev.findIndex((m) => m.id === normalizedMessage.id);
              if (existingIndex >= 0) {
                // Update existing message (mark as delivered)
                const updated = [...prev];
                updated[existingIndex] = {
                  ...updated[existingIndex],
                  ...normalizedMessage,
                  deliveryStatus: 'delivered' as const,
                };
                return updated;
              }
            }

            // Try to match by text content and sender (for user messages that need status update)
            // Check both 'user' sender and also match by text if it's a user message (regardless of sender type from server)
            if (normalizedMessage.text) {
              const messageTime = new Date(normalizedMessage.timestamp || Date.now()).getTime();
              
              // First, try to find a pending user message with matching text
              const pendingUserMessage = prev.find(
                (m) => 
                  m.sender === 'user' && 
                  m.text === normalizedMessage.text && 
                  m.deliveryStatus === 'pending' &&
                  // Match messages within last 30 seconds
                  Math.abs(new Date(m.timestamp).getTime() - messageTime) < 30000
              );
              
              if (pendingUserMessage) {
                // Update the pending message with the real ID and mark as delivered
                // Preserve the sender as 'user' (don't let server change it)
                return prev.map((m) => 
                  m.id === pendingUserMessage.id
                    ? { 
                        ...normalizedMessage, 
                        sender: 'user' as const, // Ensure it stays as user message
                        deliveryStatus: 'delivered' as const 
                      }
                    : m
                );
              }
              
              // Also check if this exact message already exists (prevent duplicates)
              // Match by text and timestamp (within 5 seconds) - more lenient to catch duplicates
              const duplicateMessage = prev.find(
                (m) => 
                  m.text === normalizedMessage.text &&
                  // Check if same sender OR if one is user and the other might be from server
                  (m.sender === normalizedMessage.sender || 
                   (m.sender === 'user' && normalizedMessage.sender === 'user')) &&
                  Math.abs(new Date(m.timestamp).getTime() - messageTime) < 5000
              );
              
              if (duplicateMessage) {
                // Message already exists, just update it if needed (maybe update ID if we have a real one)
                console.log('[Widget] Duplicate message detected, skipping:', normalizedMessage.text);
                // If we have a real ID and the duplicate has a temp ID, update it
                if (normalizedMessage.id && normalizedMessage.id.startsWith('temp-') === false && duplicateMessage.id.startsWith('temp-')) {
                  return prev.map((m) => 
                    m.id === duplicateMessage.id
                      ? { ...normalizedMessage, deliveryStatus: 'delivered' as const }
                      : m
                  );
                }
                return prev;
              }
            }

            // New message from server (agent/bot response or unmatched user message)
            return [...prev, { ...normalizedMessage, deliveryStatus: 'delivered' as const }];
          });
        },
        onConnect: () => {
          console.log('[Widget] WebSocket connected successfully');
          setIsConnected(true);
          setIsLoading(false);
          setWsError(null);
          
          // Resolve the connection promise
          if (resolveConnect) {
            resolveConnect();
          }
          
          // Load conversation history after connection
          loadConversationHistory();
        },
        onDisconnect: () => {
          setIsConnected(false);
        },
        onError: (error) => {
          console.error('WebSocket error:', error);
          setWsError(error.message || 'WebSocket connection failed');
          setIsLoading(false);
          setIsConnected(false);
        },
      }, websiteInfo, false, userId, userInfo);

      // Step 1: Initialize conversation and get JWT token
      // Get stored visitorId to continue existing conversation (if not expired)
      const storedVisitorId = getVisitorId();
      console.log('[Widget] Initializing conversation...', storedVisitorId ? `(continuing with visitorId: ${storedVisitorId})` : '(new conversation)');
      const initResult = await wsRef.current.initialize(storedVisitorId || undefined);
      
      if (!initResult) {
        throw new Error('Failed to initialize conversation');
      }

      // Check if conversation was closed
      if (initResult.closed_at) {
        console.log('[Widget] Previous conversation was closed, notifying user');
        addSystemMessage('The previous conversation has been closed. Starting a new conversation.');
      }

      // Step 2: Connect WebSocket with JWT token
      console.log('[Widget] Connecting WebSocket...');
      wsRef.current.connect();
      
      // Wait for connection to be established (with timeout)
      try {
        await Promise.race([
          connectPromise,
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000)
          )
        ]);
        console.log('[Widget] WebSocket connection established and ready');
      } catch (error) {
        console.warn('[Widget] WebSocket connection timeout or error:', error);
        // Don't throw - allow fallback to HTTP API
        // Connection might still succeed later, just not immediately
      }
    } catch (error) {
      console.error('[Widget] Failed to initialize WebSocket:', error);
      setWsError(error instanceof Error ? error.message : 'WebSocket initialization failed');
      setIsLoading(false);
      setIsConnected(false);
      setIsInitialized(false); // Allow retry
    }
  };

  // Helper function to add system message
  const addSystemMessage = (text: string) => {
    const systemMessage: Message = {
      id: `system-${Date.now()}`,
      text,
      sender: 'system',
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, systemMessage]);
  };

  // Load conversation history
  const loadConversationHistory = async () => {
    if (!apiRef.current) return;
    
    try {
      console.log('[Widget] Loading conversation history from API...');
      const history = await apiRef.current.getMessages();
      
      if (history.length > 0) {
        console.log(`[Widget] Loaded ${history.length} messages from API`);
        // Merge with existing messages (from cache) to avoid duplicates
        setMessages((prev) => {
          const existingIds = new Set(prev.map(m => m.id));
          const newMessages = history.filter(m => !existingIds.has(m.id));
          // Sort by timestamp
          const allMessages = [...prev, ...newMessages].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );
          // Save merged messages to localStorage
          saveMessagesToStorage(allMessages);
          return allMessages;
        });
      } else {
        console.log('[Widget] No conversation history found from API');
        // If we have cached messages but API returns empty, keep cached messages
        // (API might not have synced yet, or messages are still being processed)
      }
    } catch (error) {
      console.error('[Widget] Failed to load conversation history:', error);
      // Don't block UI - continue with cached messages if available
    }
  };

  useEffect(() => {
    // Auto-scroll to bottom when new messages arrive
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Save messages to localStorage whenever they change
  useEffect(() => {
    if (messages.length > 0) {
      saveMessagesToStorage(messages);
    }
  }, [messages]);

  const handleSend = async () => {
    if (!inputValue.trim()) return;

    // Initialize WebSocket if not already initialized (lazy initialization)
    if (!isInitialized && !wsRef.current) {
      await initializeWebSocket();
      // initializeWebSocket now waits for connection, so we don't need extra delay
    }

    const messageText = inputValue.trim();
    setInputValue('');

    const tempId = `temp-${Date.now()}`;
    const now = new Date().toISOString();

    // Optimistically add user message with pending status
    const userMessage: Message = {
      id: tempId,
      text: messageText,
      sender: 'user',
      timestamp: now,
      deliveryStatus: 'pending',
    };
    setMessages((prev) => [...prev, userMessage]);

    try {
      // Prefer WebSocket (pushes directly to Redis Stream)
      // Check both the state and the method to be sure
      if (wsRef.current && (isConnected || wsRef.current.isConnected())) {
        console.log('[Widget] Sending message via WebSocket');
        await wsRef.current.sendMessage(messageText);
        // Message will be updated when WebSocket receives meta_message_created event
      } else if (apiRef.current) {
        // Fallback to HTTP API if WebSocket is not connected
        console.warn('[Widget] WebSocket not connected, using HTTP API fallback');
        console.log('[Widget] WebSocket status:', {
          exists: !!wsRef.current,
          isConnectedState: isConnected,
          isConnectedMethod: wsRef.current?.isConnected(),
        });
        const response = await apiRef.current.sendMessage(messageText);
        
        // Check if conversation was closed and retried
        if (response.conversationClosed) {
          addSystemMessage('The previous conversation has been closed. Starting a new conversation.');
        }
        
        if (!response.success) {
          // Check if error is about closed conversation
          if (response.error && (response.error.toLowerCase().includes('closed') || response.error.includes('410'))) {
            addSystemMessage('The previous conversation has been closed. Starting a new conversation.');
          }
          throw new Error(response.error || 'Failed to send message');
        }

        // If API returns a message with ID, update the temp message
        if (response.message && response.message.id) {
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== tempId);
            return [...filtered, {
              ...response.message!,
              deliveryStatus: 'pending' as const, // Still pending until WebSocket confirms
            }];
          });
        }
      } else {
        throw new Error('No connection available. Please try again.');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Widget] Failed to send message:', errorMessage, error);
      
      // Check if error is about missing integration_id
      if (errorMessage.includes('integration_id')) {
        setWsError('integration_id is required. Please check Gateway configuration.');
      }
      
      // Update message status to failed
      setMessages((prev) => {
        return prev.map((m) => 
          m.id === tempId ? { ...m, deliveryStatus: 'failed' as const } : m
        );
      });
    }
  };

  const handleClose = () => {
    // Notify parent window to close widget
    if (window.parent) {
      window.parent.postMessage({ type: 'amoiq-widget-close' }, '*');
    }
  };

  if (isLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Connecting...</div>
      </div>
    );
  }

  // tenantId is optional - Gateway will resolve from domain
  // No need to block rendering if tenantId is missing - Gateway will handle it

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h3 className={styles.title}>Chat Support</h3>
        <button className={styles.closeButton} onClick={handleClose} aria-label="Close">
          ×
        </button>
        <div className={styles.status}>
          {isConnected ? (
            <span className={styles.statusConnected}>● Online</span>
          ) : wsError ? (
            <span className={styles.statusDisconnected} title={wsError}>● Offline (API only)</span>
          ) : (
            <span className={styles.statusDisconnected}>● Offline</span>
          )}
        </div>
      </div>

      <div className={styles.messages}>
        {messages.length === 0 ? (
          <div className={styles.emptyState}>
            <p>Start a conversation</p>
          </div>
        ) : (
          messages.map((message) => {
            // System messages (e.g., conversation closed notifications)
            if (message.sender === 'system') {
              return (
                <div key={message.id} className={styles.messageSystem}>
                  <div className={styles.messageSystemContent}>{message.text}</div>
                </div>
              );
            }
            
            // Regular messages
            return (
              <div
                key={message.id}
                className={`${styles.message} ${
                  message.sender === 'user' ? styles.messageUser : styles.messageBot
                }`}
              >
                <div className={styles.messageContent}>{message.text}</div>
                <div className={styles.messageMeta}>
                  <div className={styles.messageTime}>
                    {new Date(message.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                  {message.sender === 'user' && message.deliveryStatus && (
                    <div className={styles.messageStatus}>
                      {message.deliveryStatus === 'pending' && '⏳'}
                      {message.deliveryStatus === 'delivered' && '✓'}
                      {message.deliveryStatus === 'failed' && '✗'}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className={styles.inputContainer}>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyPress={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Type a message..."
          className={styles.input}
          disabled={isLoading}
        />
        <button
          onClick={handleSend}
          disabled={!inputValue.trim() || isLoading}
          className={styles.sendButton}
          aria-label="Send message"
        >
          →
        </button>
      </div>
    </div>
  );
}

