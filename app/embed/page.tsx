'use client';

import { useEffect, useState, useRef } from 'react';
import { getTenantId } from '@/lib/tenant';
import { ChatAPI, UserInfo } from '@/lib/api';
import { ChatWebSocketNative } from '@/lib/ws-native';
import { getSessionInfo, hasValidSession, getVisitorId, isConversationExpired, clearConversation, getSenderName, setSenderName, getConversationId } from '@/lib/session';
import { UploadService } from '@/lib/upload-service';
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

// Check if 5 minutes have passed since last user message
function shouldShowClearButton(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = localStorage.getItem(MESSAGES_STORAGE_KEY);
    if (!stored) return false;
    
    const data = JSON.parse(stored);
    if (data && data.lastUserMessageAt) {
      const timeSinceLastUserMessage = Date.now() - data.lastUserMessageAt;
      const fiveMinutes = 5 * 60 * 1000; // 5 minutes
      return timeSinceLastUserMessage >= fiveMinutes;
    }
    return false;
  } catch (error) {
    console.warn('[Widget] Failed to check clear button status:', error);
    return false;
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
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showClearButton, setShowClearButton] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
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
          return websiteInfo;
        }
      } catch (_e) {}
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
          return websiteInfo;
        }
      } catch (_e) {
        // Cross-origin iframe - can't access parent
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

  /**
   * Create message handler callback for WebSocket
   * This handles incoming messages, normalizes them, and updates the message state
   */
  const createMessageHandler = () => {
    return (message: any) => {
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
        
        // Map message_text to text if present (WebSocket sends message_text, we expect text)
        if (message.message_text && !normalizedMessage.text) {
          normalizedMessage.text = message.message_text;
        } else if (!normalizedMessage.text && message.text) {
          normalizedMessage.text = message.text;
        }
        
        // Map temp_id / client_temp_id for optimistic message replacement (server echoes client temp_id in meta_message_created)
        const tempIdFromServer = (message as any).temp_id ?? (message as any).client_temp_id;
        if (tempIdFromServer) {
          (normalizedMessage as any).temp_id = tempIdFromServer;
        }
        
        // Priority: sender_type > sender > default
        // Backend uses: "user" (customer/widget), "human" (admin/agent), "ai" (bot)
        // Normalize to: "user", "agent", "bot"
        if (message.sender_type) {
          normalizedMessage.sender = message.sender_type === 'user' 
            ? 'user' 
            : (message.sender_type === 'human' || message.sender_type === 'agent' 
              ? 'agent' 
              : (message.sender_type === 'ai' ? 'bot' : 'bot'));
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
        
        // Notify parent (bubble) of new incoming message so it can show alert dot
        // Only for messages from agent/bot/system — not user's own messages
        const isIncoming = normalizedMessage.sender === 'agent' || normalizedMessage.sender === 'bot' || normalizedMessage.sender === 'system';
        if (isIncoming && typeof window !== 'undefined' && window.parent) {
          try {
            window.parent.postMessage({ type: 'amoiq-widget-new-message' }, '*');
          } catch (_) { /* cross-origin safe */ }
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
            return prev; // Don't add duplicate
          }
        }

        // STEP 1.5: Deduplicate admin/bot messages that arrive twice (message:new fast, then meta_message_created slow)
        // Both admin ('human'→'agent') and bot ('ai'→'bot') messages come from outside the widget
        // They both arrive via: 1) message:new (fast WebSocket), 2) meta_message_created (slow, after DB write)
        // This ONLY runs for non-user messages to avoid interfering with user pending message flow
        // User messages go through STEP 2 (pending message replacement) instead
        // Backend sender types: "user" (customer/widget), "human" (admin/agent), "ai" (bot)
        // After normalization: "user" stays "user", "human" becomes "agent", "ai" becomes "bot"
        if (normalizedMessage.text && 
            normalizedMessage.sender && 
            normalizedMessage.sender !== 'user' &&  // Catches both 'agent' (admin) and 'bot' (AI) messages
            normalizedMessage.timestamp) {
          const messageTime = new Date(normalizedMessage.timestamp).getTime();
          const duplicateByContent = prev.find((m) => {
            // Match by text and sender (must be same sender type: both 'agent' or both 'bot')
            if (m.text !== normalizedMessage.text || m.sender !== normalizedMessage.sender) {
              return false;
            }
            // Match within last 60 seconds (messages can arrive with delays due to backend processing, network latency, worker queue)
            // Increased from 10 seconds to handle cases where message:new and meta_message_created arrive >10 seconds apart
            const timeDiff = Math.abs(new Date(m.timestamp).getTime() - messageTime);
            const isWithinWindow = timeDiff < 60000;
            return isWithinWindow;
          });
          
          if (duplicateByContent) {
            return prev; // Skip duplicate
          }
        }

        // STEP 2: Replace optimistic message with server echo (real ID)
        // 2a) Primary: match by temp_id (server broadcasts real id + client's temp_id)
        const serverTempId = (normalizedMessage as any).temp_id;
        if (serverTempId && normalizedMessage.id && normalizedMessage.id.startsWith('temp-') === false) {
          const pendingByTempId = prev.find((m) => m.id === serverTempId);
          if (pendingByTempId) {
            return prev.map((m) =>
              m.id === serverTempId
                ? {
                    ...normalizedMessage,
                    sender: m.sender || normalizedMessage.sender,
                    deliveryStatus: 'delivered' as const,
                    timestamp: m.timestamp,
                  }
                : m
            );
          }
        }

        // 2b) Fallback: match by text + sender + time (for broadcasts without temp_id or older backends)
        if (normalizedMessage.id &&
            normalizedMessage.id.startsWith('temp-') === false &&
            normalizedMessage.text) {
          const messageTime = new Date(normalizedMessage.timestamp || Date.now()).getTime();
          const pendingMessage = prev.find(
            (m) =>
              m.text === normalizedMessage.text &&
              m.deliveryStatus === 'pending' &&
              m.sender === normalizedMessage.sender &&
              Math.abs(new Date(m.timestamp).getTime() - messageTime) < 60000
          );
          if (pendingMessage) {
            return prev.map((m) =>
              m.id === pendingMessage.id
                ? {
                    ...normalizedMessage,
                    sender: m.sender || normalizedMessage.sender,
                    deliveryStatus: 'delivered' as const,
                    timestamp: m.timestamp,
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
            return prev;
          }
        }

        // New message from server (agent/bot response or unmatched user message)
        return [...prev, { ...normalizedMessage, deliveryStatus: 'delivered' as const }];
      });
    };
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
        setMessages(cachedMessages);
        // Check if clear button should be shown
        setShowClearButton(shouldShowClearButton());
      }
    }
    
    
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
      const presenceResponse = await apiRef.current.createPresenceSession();
      
      if (!presenceResponse) {
        console.error('[Widget] Failed to create presence session');
        return;
      }
      
      
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
            setIsConnected(true);
          },
          onDisconnect: () => {
            setIsConnected(false);
          },
          onError: (error) => {
            console.error('[Widget] Presence WebSocket error:', error);
            setWsError(error.message || 'WebSocket connection failed');
          },
          onConversationCreated: async (conversationId) => {
            // Conversation was created by backend, update state
            setChatState('active');
            
            // Load message history after conversation is created
            if (apiRef.current) {
              try {
                const history = await apiRef.current.getConversationMessages(conversationId);
                if (history && history.length > 0) {
                  const historyMessages: Message[] = history.map((msg: any) => ({
                    id: msg.id,
                    text: msg.message_text || msg.text,
                    sender: (msg.sender_type === 'user' ? 'user' : (msg.sender_type === 'agent' ? 'agent' : 'bot')) as 'user' | 'bot' | 'agent' | 'system',
                    timestamp: msg.created_at || msg.timestamp,
                    deliveryStatus: 'delivered' as const
                  }));
                  setMessages(historyMessages);
                }
              } catch (error) {
                console.warn('[Widget] Failed to load message history:', error);
              }
            }
          },
          onConversationClosed: () => {
            setConversationClosed(true);
            addSystemMessage('This conversation has been closed due to inactivity. You can start a new conversation at any time.');
          },
          onMessage: createMessageHandler(),
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
    // Wait for presence session if it's still initializing
    if (!presenceSession) {
      // Wait up to 5 seconds for presence session
      let attempts = 0;
      while (!presenceSession && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      if (!presenceSession) {
        console.error('[Widget] Cannot open chat: presence session initialization timeout');
        return;
      }
    }
    
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
      // Call /webchat/init with sessionId (session-first flow)
      // Init returns session_id, visitor_id, ws_token - NOT conversation_id
      // conversation_id comes later from conversation:created event on session room
      const storedVisitorId = getVisitorId();
      const sessionId = presenceSession?.session_id;
      
      const initResult = await apiRef.current.initializeConversation(storedVisitorId || undefined, sessionId);
      
      if (!initResult) {
        throw new Error('Failed to initialize session');
      }
      
      // Check if previous conversation was closed
      if (initResult.closed_at) {
        addSystemMessage('The previous conversation has been closed. Starting a new conversation.');
        setConversationClosed(false); // Reset closed state
      }
      
      // Session-first flow: reconnect WebSocket with init's ws_token and join session room
      // conversation_id will come from conversation:created event
      if (wsRef.current) {
        // Disconnect existing presence connection and reconnect with init's token
        await wsRef.current.connectPresence(
          initResult.ws_token,
          initResult.ws_server_url,
          initResult.session_id
        );
        // Now in session room, waiting for conversation:created event
        // Message history will be loaded when onConversationCreated callback fires
      }
      
      setIsLoading(false);
    } catch (error) {
      console.error('[Widget] Failed to initialize session:', error);
      setWsError(error instanceof Error ? error.message : 'Failed to initialize session');
      setIsLoading(false);
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
      const history = await apiRef.current.getMessages();
      
      if (history.length > 0) {
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

  // Periodic check to show clear button after 5 minutes of inactivity
  useEffect(() => {
    const checkClearButton = () => {
      const shouldShow = shouldShowClearButton();
      setShowClearButton(shouldShow);
    };

    // Check immediately
    checkClearButton();
    
    // Then check every minute
    const interval = setInterval(checkClearButton, 60 * 1000);
    
    return () => clearInterval(interval);
  }, [messages]);

  // Lock widget width on iOS when keyboard opens; only recalc when keyboard is closed
  useEffect(() => {
    if (typeof window === 'undefined' || !containerRef.current) return;
    let baseWidth = window.innerWidth;
    const applyWidth = () => {
      const target = containerRef.current;
      if (target) target.style.width = `${baseWidth}px`;
    };
    const handleViewportChange = () => {
      const vv = window.visualViewport;
      const isKeyboard = vv ? vv.height < window.innerHeight : false;
      if (!isKeyboard) {
        baseWidth = window.innerWidth;
        applyWidth();
      }
    };
    applyWidth();
    window.addEventListener('resize', handleViewportChange);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewportChange);
      window.visualViewport.addEventListener('scroll', handleViewportChange);
    }
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleViewportChange);
        window.visualViewport.removeEventListener('scroll', handleViewportChange);
      }
    };
  }, [isLoading]);

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
      // Hide clear button when user sends a new message
      setShowClearButton(false);
      return updated;
    });

    try {
      // Prefer HTTP API for consistency and reliability
      if (apiRef.current) {
        const response = await apiRef.current.sendMessage(messageText, { temp_id: tempId });
        
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
        
        // 🔍 IMPORTANT: After sending via HTTP API, ensure WebSocket is in conversation room
        // The HTTP API might have created/updated a conversation, so we need to join the conversation room
        // to receive meta_message_created events
        // Check for conversation_id in response message or use stored one
        const conversationId = (response.message as { conversation_id?: string } | undefined)?.conversation_id || getConversationId();
        
        if (conversationId && wsRef.current) {
          if (wsRef.current.isConnected()) {
            // Switch to conversation room to receive meta_message_created events
            wsRef.current.switchToConversationRoom(conversationId);
          } else {
            console.warn('[Widget] WebSocket not connected, cannot join conversation room:', conversationId);
          }
        } else {
          console.warn('[Widget] No conversation ID available after sending message', {
            hasResponseMessage: !!response.message,
            hasConversationIdInMessage: !!(response.message as { conversation_id?: string } | undefined)?.conversation_id,
            storedConversationId: getConversationId(),
          });
        }
        
        // Message remains as 'pending' - WebSocket will update to 'delivered' when meta_message_created is received
      } else if (wsRef.current && (isConnected || wsRef.current.isConnected())) {
        // Fallback to WebSocket if HTTP API is not available
        console.warn('[Widget] HTTP API not available, using WebSocket fallback');
        await wsRef.current.sendMessage(messageText, tempId);
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

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const conversationId = getConversationId();
    if (!conversationId) {
      alert('Send a message first to attach files.');
      return;
    }
    if (!apiRef.current) return;
    setIsUploading(true);
    try {
      const baseUrl = process.env.NEXT_PUBLIC_GATEWAY_URL || process.env.NEXT_PUBLIC_API_URL || 'https://api-gateway-dfcflow.fly.dev';
      const uploadService = new UploadService(baseUrl, () => ({
        'Content-Type': 'application/json',
        ...(process.env.NEXT_PUBLIC_GATEWAY_API_KEY || process.env.NEXT_PUBLIC_API_KEY
          ? { Authorization: `Bearer ${process.env.NEXT_PUBLIC_GATEWAY_API_KEY || process.env.NEXT_PUBLIC_API_KEY}` }
          : {}),
      }));
      const result = await uploadService.uploadFile(conversationId, file);
      const type = (file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'document') as 'image' | 'video' | 'audio' | 'document';
      const tempId = `temp-${Date.now()}`;
      const userMessage: Message = {
        id: tempId,
        text: `[Attachment: ${result.filename}]`,
        sender: 'user',
        timestamp: new Date().toISOString(),
        deliveryStatus: 'pending',
      };
      setMessages((prev) => [...prev, userMessage]);
      const response = await apiRef.current.sendMessage('', {
        temp_id: tempId,
        attachments: {
          items: [{ type, payload: { url: result.publicUrl, filename: result.filename, content_type: result.contentType, size: result.size } }],
        },
      });
      if (!response.success) throw new Error(response.error);
    } catch (err) {
      console.error('[Widget] File upload failed:', err);
      alert(err instanceof Error ? err.message : 'Failed to upload file.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleClose = () => {
    // Notify parent window to close widget
    if (window.parent) {
      window.parent.postMessage({ type: 'amoiq-widget-close' }, '*');
    }
  };

  const handleClearHistory = () => {
    clearMessagesFromStorage();
    setMessages([]);
    setShowClearButton(false);
  };

  if (isLoading) {
    return (
      <div ref={containerRef} className={styles.container}>
        <div className={styles.loading}>Connecting...</div>
      </div>
    );
  }

  // tenantId is optional - Gateway will resolve from domain
  // No need to block rendering if tenantId is missing - Gateway will handle it

  return (
    <div ref={containerRef} className={styles.container}>
      <div className={styles.header}>
        <h3 className={styles.title}>Chat Support</h3>
        {showClearButton && messages.length > 0 && (
          <button 
            className={styles.clearButton} 
            onClick={handleClearHistory} 
            aria-label="Clear chat history"
            title="Clear chat history"
          >
            Clear History
          </button>
        )}
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
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*,audio/*,.pdf"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
              aria-hidden
            />
            {getConversationId() && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading || isUploading}
                className={styles.attachButton}
                aria-label="Attach file"
                title="Attach image, video, audio, or PDF"
              >
                {isUploading ? '…' : '📎'}
              </button>
            )}
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

