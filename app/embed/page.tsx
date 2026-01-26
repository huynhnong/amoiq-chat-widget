'use client';

import { useEffect, useState, useRef } from 'react';
import { getTenantId } from '@/lib/tenant';
import { ChatAPI, UserInfo } from '@/lib/api';
import { ChatWebSocketNative } from '@/lib/ws-native';
import { getSessionInfo, hasValidSession, getVisitorId, isConversationExpired, clearConversation, getSenderName, setSenderName } from '@/lib/session';
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
function saveMessagesToStorage(messages: Message[], lastUserMessageAt?: number): void {
  if (typeof window === 'undefined') return;
  try {
    // Find the last user message timestamp if not provided
    let lastUserMsgTime = lastUserMessageAt;
    if (lastUserMsgTime === undefined) {
      const userMessages = messages.filter(m => m.sender === 'user');
      if (userMessages.length > 0) {
        const lastUserMsg = userMessages[userMessages.length - 1];
        lastUserMsgTime = lastUserMsg.timestamp ? new Date(lastUserMsg.timestamp).getTime() : Date.now();
      }
    }
    
    const data = {
      version: MESSAGES_STORAGE_VERSION,
      messages,
      savedAt: Date.now(),
      lastUserMessageAt: lastUserMsgTime || null,
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
    // Check if data is valid and not too old (1 hour)
    if (data && data.messages && Array.isArray(data.messages)) {
      const age = Date.now() - (data.savedAt || 0);
      const maxAge = 60 * 60 * 1000; // 1 hour
      
      if (age >= maxAge) {
        // Messages too old, clear them
        localStorage.removeItem(MESSAGES_STORAGE_KEY);
        return [];
      }
      
      // Check if 5 minutes have passed since last user message
      if (data.lastUserMessageAt) {
        const timeSinceLastUserMessage = Date.now() - data.lastUserMessageAt;
        const fiveMinutes = 5 * 60 * 1000; // 5 minutes
        
        if (timeSinceLastUserMessage >= fiveMinutes) {
          // 5 minutes passed since last user message, clear messages
          console.log('[Widget] 5 minutes passed since last user message, clearing chat history');
          localStorage.removeItem(MESSAGES_STORAGE_KEY);
          return [];
        }
      }
      
      return data.messages;
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
  const [presenceSession, setPresenceSession] = useState<{ session_id: string; ws_token: string; websocket_url: string } | null>(null);
  const [chatState, setChatState] = useState<'closed' | 'name_prompt' | 'active'>('closed');
  const [senderName, setSenderNameState] = useState<string | null>(null);
  const [conversationClosed, setConversationClosed] = useState(false);
  const [nameInputValue, setNameInputValue] = useState('');
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
    
    // Check if sender name exists
    const storedSenderName = getSenderName();
    if (storedSenderName) {
      setSenderNameState(storedSenderName);
    }
    
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
    
    // Initialize presence session on page load
    initializePresenceSession();
    
    // Only load history if session/conversation is still valid
    if (!sessionExpired && !conversationExpired) {
      loadConversationHistory();
    }
    
    // Listen for chat open message from parent (when user clicks chat bubble)
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'amoiq-widget-open') {
        console.log('[Widget] Chat bubble clicked');
        handleChatBubbleClick();
      }
    };

    window.addEventListener('message', handleMessage);
    
    return () => {
      window.removeEventListener('message', handleMessage);
      wsRef.current?.disconnect();
    };
  }, [isInitialized]);

  // Initialize presence session on page load
  const initializePresenceSession = async () => {
    if (!apiRef.current) return;
    
    try {
      console.log('[Widget] Initializing presence session...');
      const presenceResponse = await apiRef.current.createPresenceSession();
      
      if (!presenceResponse) {
        console.error('[Widget] Failed to create presence session');
        return;
      }
      
      console.log('[Widget] Presence session created:', {
        session_id: presenceResponse.session_id,
        tenant_id: presenceResponse.tenant_id,
        site_id: presenceResponse.site_id,
      });
      
      setPresenceSession({
        session_id: presenceResponse.session_id,
        ws_token: presenceResponse.ws_token,
        websocket_url: presenceResponse.websocket_url,
      });
      
      // Connect to presence WebSocket
      if (wsRef.current) {
        await wsRef.current.connectPresence(
          presenceResponse.ws_token,
          presenceResponse.websocket_url,
          presenceResponse.session_id
        );
      } else {
        // Create WebSocket client for presence
        const websiteInfo = getWebsiteInfo();
        const { userId, userInfo } = getUserInfo();
        const params = new URLSearchParams(window.location.search);
        const tid = params.get('tenantId') || params.get('tenant');
        
        wsRef.current = new ChatWebSocketNative(tid, {
          onConnect: () => {
            console.log('[Widget] Presence WebSocket connected');
            setIsConnected(true);
          },
          onDisconnect: () => {
            setIsConnected(false);
          },
          onError: (error) => {
            console.error('[Widget] Presence WebSocket error:', error);
            setWsError(error.message || 'WebSocket connection failed');
          },
          onConversationCreated: (conversationId) => {
            console.log('[Widget] Conversation created via WebSocket:', conversationId);
            // Conversation was created by backend, update state
            setChatState('active');
          },
          onConversationClosed: () => {
            console.log('[Widget] Conversation closed due to inactivity');
            setConversationClosed(true);
            addSystemMessage('This conversation has been closed due to inactivity. You can start a new conversation at any time.');
          },
        }, websiteInfo, false, userId, userInfo);
        
        await wsRef.current.connectPresence(
          presenceResponse.ws_token,
          presenceResponse.websocket_url,
          presenceResponse.session_id
        );
      }
    } catch (error) {
      console.error('[Widget] Error initializing presence session:', error);
    }
  };

  // Handle chat bubble click
  const handleChatBubbleClick = async () => {
    if (!apiRef.current || !presenceSession) {
      console.warn('[Widget] Cannot open chat: presence session not initialized');
      return;
    }
    
    try {
      // Call /webchat/open endpoint
      const opened = await apiRef.current.openChat(presenceSession.session_id);
      if (!opened) {
        console.error('[Widget] Failed to open chat');
        return;
      }
      
      // Show welcome message asking for name
      if (!senderName) {
        setChatState('name_prompt');
        addSystemMessage('Welcome! Please enter your name to start chatting.');
      } else {
        // Already have name, proceed to conversation initialization
        await initializeConversation();
      }
    } catch (error) {
      console.error('[Widget] Error handling chat bubble click:', error);
    }
  };

  // Handle name submission
  const handleNameSubmit = async () => {
    const name = nameInputValue.trim();
    if (!name) return;
    
    // Store sender name
    setSenderName(name);
    setSenderNameState(name);
    setNameInputValue('');
    
    // Show personalized greeting
    addSystemMessage(`Hi ${name}, how can I help you today?`);
    
    // Initialize conversation
    await initializeConversation();
  };

  // Initialize conversation after name entry
  const initializeConversation = async () => {
    if (!apiRef.current || !wsRef.current) {
      console.warn('[Widget] Cannot initialize conversation: API or WebSocket not available');
      return;
    }
    
    setIsLoading(true);
    setChatState('active');
    
    try {
      // Call /webchat/init to create/get conversation
      const storedVisitorId = getVisitorId();
      console.log('[Widget] Initializing conversation...', storedVisitorId ? `(continuing with visitorId: ${storedVisitorId})` : '(new conversation)');
      
      const initResult = await apiRef.current.initializeConversation(storedVisitorId || undefined);
      
      if (!initResult) {
        throw new Error('Failed to initialize conversation');
      }
      
      // Check if conversation was closed
      if (initResult.closed_at) {
        console.log('[Widget] Previous conversation was closed, notifying user');
        addSystemMessage('The previous conversation has been closed. Starting a new conversation.');
        setConversationClosed(false); // Reset closed state
      }
      
      // Switch to conversation room if WebSocket is connected
      if (wsRef.current && wsRef.current.isConnected() && initResult.conversation_id) {
        console.log('[Widget] Switching to conversation room:', initResult.conversation_id);
        wsRef.current.switchToConversationRoom(initResult.conversation_id);
      }
      
      setIsLoading(false);
    } catch (error) {
      console.error('[Widget] Failed to initialize conversation:', error);
      setWsError(error instanceof Error ? error.message : 'Failed to initialize conversation');
      setIsLoading(false);
    }
  };

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
            
            // Map messageId/message_id to id if present (server sends messageId or message_id, we expect id)
            // Priority: message_id (from message:new) > messageId (from meta_message_created) > id
            if (message.message_id && !normalizedMessage.id) {
              normalizedMessage.id = message.message_id;
            } else if (message.messageId && !normalizedMessage.id) {
              normalizedMessage.id = message.messageId;
            }
            
            // Priority: sender_type > sender > default
            if (message.sender_type) {
              normalizedMessage.sender = message.sender_type === 'user' ? 'user' : (message.sender_type === 'agent' ? 'agent' : 'bot');
            } else if (message.sender) {
              // If sender is a UUID (user ID), infer it's a user message
              const senderStr = String(message.sender);
              if (senderStr.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
                normalizedMessage.sender = 'user';
              } else if (['user', 'bot', 'agent', 'system'].includes(senderStr)) {
                normalizedMessage.sender = senderStr as 'user' | 'bot' | 'agent' | 'system';
              } else {
                normalizedMessage.sender = message.sender;
              }
            }
            
            // Ensure sender is one of the valid types
            if (!normalizedMessage.sender || !['user', 'bot', 'agent', 'system'].includes(normalizedMessage.sender)) {
              // Try to infer from other fields
              if ((message as any).userId || (message as any).user_id || (message as any).visitor_id || (message as any).sender) {
                // If sender is a UUID or we have user identifiers, it's a user message
                const senderStr = String((message as any).sender || '');
                if (senderStr.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
                  normalizedMessage.sender = 'user';
                } else {
                  normalizedMessage.sender = 'user'; // Likely a user message if it has userId
                }
              } else {
                normalizedMessage.sender = 'bot'; // Default to bot if unknown
              }
            }
            
            // Store original sender_type for matching
            if (message.sender_type && !normalizedMessage.sender_type) {
              (normalizedMessage as any).sender_type = message.sender_type;
            }
            
            // STEP 1: Check if message with same ID already exists (simple deduplication by ID)
            // Also check message_id field (message:new events use message_id as the actual message ID)
            // message:new events have: id (event ID), message_id (actual message ID)
            // meta_message_created events have: messageId (actual message ID)
            const messageId = normalizedMessage.id || (message as any).messageId || (message as any).message_id;
            if (messageId) {
              const existingById = prev.find((m) => {
                // Check if any existing message has the same ID
                if (m.id === messageId) return true;
                // Check if existing message has message_id that matches
                if ((m as any).message_id === messageId) return true;
                // Check if new message has message_id that matches existing message id
                if ((message as any).message_id && m.id === (message as any).message_id) return true;
                return false;
              });
              if (existingById) {
                // Message with this ID already exists - just update it (don't add duplicate)
                console.log('[Widget] Message with ID already exists, skipping duplicate:', messageId);
                return prev; // Don't add duplicate, just return existing messages
              }
            }

            // STEP 2: If message has a real ID (not temp) and we have a pending message with same text
            // This handles the case: optimistic message (temp ID) → server echo (real ID)
            if (normalizedMessage.id && 
                normalizedMessage.id.startsWith('temp-') === false && 
                normalizedMessage.text) {
              const messageTime = new Date(normalizedMessage.timestamp || Date.now()).getTime();
              
              // Find pending message with same text (the optimistic one we added)
              // Also match by sender to ensure we're replacing the right message
              const pendingMessage = prev.find(
                (m) => 
                  m.text === normalizedMessage.text && 
                  m.deliveryStatus === 'pending' &&
                  m.sender === normalizedMessage.sender &&
                  // Match within last 60 seconds
                  Math.abs(new Date(m.timestamp).getTime() - messageTime) < 60000
              );
              
              if (pendingMessage) {
                // Replace the pending message with the real one from server
                console.log('[Widget] Replacing pending message with server message:', normalizedMessage.text, 'ID:', normalizedMessage.id);
                return prev.map((m) => 
                  m.id === pendingMessage.id
                    ? { 
                        ...normalizedMessage,
                        sender: m.sender || normalizedMessage.sender, // Preserve original sender
                        deliveryStatus: 'delivered' as const,
                        timestamp: m.timestamp // Keep original timestamp
                      }
                    : m
                );
              }
            }

            // STEP 3: Check for duplicates by text and sender (within 10 seconds)
            // BUT: Skip this check if message has a real ID (not temp) - it should replace pending or be new
            // This catches duplicates that don't have IDs or are from other sources
            if (normalizedMessage.text && 
                (!normalizedMessage.id || normalizedMessage.id.startsWith('temp-'))) {
              const messageTime = new Date(normalizedMessage.timestamp || Date.now()).getTime();
              const duplicate = prev.find(
                (m) => 
                  m.text === normalizedMessage.text &&
                  m.sender === normalizedMessage.sender &&
                  // Don't match pending messages - those should be replaced by STEP 2
                  m.deliveryStatus !== 'pending' &&
                  Math.abs(new Date(m.timestamp).getTime() - messageTime) < 10000
              );
              
              if (duplicate) {
                // Duplicate found - skip adding it
                console.log('[Widget] Duplicate message detected by text, skipping:', normalizedMessage.text);
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
          // Save merged messages to localStorage (preserve lastUserMessageAt if exists)
          const userMessages = allMessages.filter(m => m.sender === 'user');
          let lastUserMessageAt: number | undefined;
          if (userMessages.length > 0) {
            const lastUserMsg = userMessages[userMessages.length - 1];
            lastUserMessageAt = lastUserMsg.timestamp ? new Date(lastUserMsg.timestamp).getTime() : undefined;
          }
          saveMessagesToStorage(allMessages, lastUserMessageAt);
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
      // Find the last user message timestamp
      const userMessages = messages.filter(m => m.sender === 'user');
      let lastUserMessageAt: number | undefined;
      if (userMessages.length > 0) {
        const lastUserMsg = userMessages[userMessages.length - 1];
        lastUserMessageAt = lastUserMsg.timestamp ? new Date(lastUserMsg.timestamp).getTime() : undefined;
      }
      saveMessagesToStorage(messages, lastUserMessageAt);
    }
  }, [messages]);

  // Periodic check to clear messages after 5 minutes of inactivity
  useEffect(() => {
    const checkAndClearMessages = () => {
      if (typeof window === 'undefined') return;
      
      try {
        const stored = localStorage.getItem(MESSAGES_STORAGE_KEY);
        if (!stored) return;
        
        const data = JSON.parse(stored);
        if (data && data.lastUserMessageAt) {
          const timeSinceLastUserMessage = Date.now() - data.lastUserMessageAt;
          const fiveMinutes = 5 * 60 * 1000; // 5 minutes
          
          if (timeSinceLastUserMessage >= fiveMinutes) {
            // 5 minutes passed since last user message, clear messages
            console.log('[Widget] 5 minutes passed since last user message, clearing chat history');
            localStorage.removeItem(MESSAGES_STORAGE_KEY);
            setMessages([]);
          }
        }
      } catch (error) {
        console.warn('[Widget] Failed to check message timeout:', error);
      }
    };

    // Check immediately
    checkAndClearMessages();
    
    // Then check every minute
    const interval = setInterval(checkAndClearMessages, 60 * 1000);
    
    return () => clearInterval(interval);
  }, []);

  const handleSend = async () => {
    if (!inputValue.trim()) return;

    // If conversation is closed, sending a message will auto-reopen it
    if (conversationClosed) {
      setConversationClosed(false);
      addSystemMessage('Reopening conversation...');
    }

    // If we're in name prompt state, treat input as name
    if (chatState === 'name_prompt') {
      setNameInputValue(inputValue.trim());
      handleNameSubmit();
      return;
    }

    // Initialize conversation if not already active
    if (chatState === 'closed' && senderName) {
      await initializeConversation();
      // Wait a bit for conversation to initialize
      await new Promise(resolve => setTimeout(resolve, 500));
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
    setMessages((prev) => {
      const updated = [...prev, userMessage];
      // Save immediately with the new last user message timestamp
      saveMessagesToStorage(updated, Date.now());
      return updated;
    });

    try {
      // Prefer HTTP API for consistency and reliability
      if (apiRef.current) {
        console.log('[Widget] Sending message via HTTP API');
        const response = await apiRef.current.sendMessage(messageText);
        
        // Check if conversation was closed and retried
        if (response.conversationClosed) {
          addSystemMessage('The previous conversation has been closed. Starting a new conversation.');
          setConversationClosed(false);
        }
        
        if (!response.success) {
          // Check if error is about closed conversation
          if (response.error && (response.error.toLowerCase().includes('closed') || response.error.includes('410'))) {
            addSystemMessage('The previous conversation has been closed. Starting a new conversation.');
            setConversationClosed(false);
          }
          throw new Error(response.error || 'Failed to send message');
        }

        // If API returns a message with ID, update the temp message
        // Keep as 'pending' - will be marked 'delivered' when WebSocket receives meta_message_created event
        if (response.message && response.message.id) {
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== tempId);
            return [...filtered, {
              ...response.message!,
              deliveryStatus: 'pending' as const, // Still pending until WebSocket confirms
            }];
          });
        }
        // Message remains as 'pending' - WebSocket will update to 'delivered' when meta_message_created is received
      } else if (wsRef.current && (isConnected || wsRef.current.isConnected())) {
        // Fallback to WebSocket if HTTP API is not available
        console.warn('[Widget] HTTP API not available, using WebSocket fallback');
        await wsRef.current.sendMessage(messageText);
        // Message will be updated when WebSocket receives meta_message_created event
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
        {chatState === 'name_prompt' ? (
          <>
            <input
              type="text"
              value={nameInputValue}
              onChange={(e) => setNameInputValue(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleNameSubmit();
                }
              }}
              placeholder="Enter your name..."
              className={styles.input}
              disabled={isLoading}
              autoFocus
            />
            <button
              onClick={handleNameSubmit}
              disabled={!nameInputValue.trim() || isLoading}
              className={styles.sendButton}
              aria-label="Submit name"
            >
              →
            </button>
          </>
        ) : (
          <>
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
              placeholder={conversationClosed ? "Type a message to reopen conversation..." : "Type a message..."}
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
          </>
        )}
      </div>
    </div>
  );
}

