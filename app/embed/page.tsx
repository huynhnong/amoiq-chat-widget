'use client';

import { useEffect, useState, useRef } from 'react';
import { getTenantId } from '@/lib/tenant';
import { ChatAPI } from '@/lib/api';
import { ChatWebSocket } from '@/lib/ws';
import styles from './styles.module.css';

// Force dynamic rendering - no caching
export const dynamic = 'force-dynamic';

export default function EmbedPage() {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [wsError, setWsError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<ChatWebSocket | null>(null);
  const apiRef = useRef<ChatAPI | null>(null);

  /**
   * Get website info from parent window or detect from current context
   */
  const getWebsiteInfo = (): { domain?: string; origin?: string; url?: string; referrer?: string; siteId?: string } => {
    // Try to get from parent window (if embedded in iframe)
    if (window.parent && window.parent !== window) {
      try {
        const parentOrigin = window.parent.location.origin;
        const parentHostname = window.parent.location.hostname;
        return {
          domain: parentHostname,
          origin: parentOrigin,
          url: window.parent.location.href,
          referrer: document.referrer || '',
        };
      } catch (e) {
        // Cross-origin iframe - can't access parent, use URL params or postMessage
        console.log('[Widget] Cross-origin iframe, using URL params for website info');
      }
    }

    // Get from URL params (passed from widget loader)
    const params = new URLSearchParams(window.location.search);
    const siteId = params.get('siteId');
    const domain = params.get('domain');
    const origin = params.get('origin');
    const url = params.get('url');
    const referrer = params.get('referrer');

    if (domain || origin || url) {
      return {
        domain: domain || undefined,
        origin: origin || undefined,
        url: url || undefined,
        referrer: referrer || undefined,
        siteId: siteId || undefined,
      };
    }

    // Fallback: detect from current window (for direct access)
    if (typeof window !== 'undefined') {
      return {
        domain: window.location.hostname,
        origin: window.location.origin,
        url: window.location.href,
        referrer: document.referrer || '',
      };
    }

    return {};
  };

  useEffect(() => {
    // Get tenant ID from URL params (support both 'tenantId' and 'tenant')
    const params = new URLSearchParams(window.location.search);
    const tid = params.get('tenantId') || params.get('tenant');
    
    if (!tid) {
      console.error('Missing tenantId or tenant parameter');
      setIsLoading(false);
      return;
    }

    setTenantId(tid);
    
    // Get website info
    const websiteInfo = getWebsiteInfo();
    console.log('[Widget] Website info:', websiteInfo);
    
    // Initialize API client with website info
    apiRef.current = new ChatAPI(tid, websiteInfo);
    
    // Initialize WebSocket with website info
    wsRef.current = new ChatWebSocket(tid, {
      onMessage: (message) => {
        setMessages((prev) => {
          // If message has an ID, try to update existing message (for delivery status)
          if (message.id) {
            const existingIndex = prev.findIndex((m) => m.id === message.id);
            if (existingIndex >= 0) {
              // Update existing message (mark as delivered)
              const updated = [...prev];
              updated[existingIndex] = {
                ...updated[existingIndex],
                ...message,
                deliveryStatus: 'delivered' as const,
              };
              return updated;
            }
          }

          // Try to match by text content and sender (for user messages that need status update)
          if (message.sender === 'user' && message.text) {
            const pendingUserMessage = prev.find(
              (m) => 
                m.sender === 'user' && 
                m.text === message.text && 
                m.deliveryStatus === 'pending' &&
                // Match messages within last 30 seconds
                Math.abs(new Date(m.timestamp).getTime() - new Date(message.timestamp || Date.now()).getTime()) < 30000
            );
            
            if (pendingUserMessage) {
              // Update the pending message with the real ID and mark as delivered
              return prev.map((m) => 
                m.id === pendingUserMessage.id
                  ? { ...message, deliveryStatus: 'delivered' as const }
                  : m
              );
            }
          }

          // New message from server (agent/bot response or unmatched user message)
          return [...prev, { ...message, deliveryStatus: 'delivered' as const }];
        });
      },
      onConnect: () => {
        setIsConnected(true);
        setIsLoading(false);
        setWsError(null);
      },
      onDisconnect: () => {
        setIsConnected(false);
      },
      onError: (error) => {
        console.error('WebSocket error:', error);
        setWsError(error.message || 'WebSocket connection failed');
        setIsLoading(false);
        // Allow input even if WebSocket fails - will use HTTP API fallback
        setIsConnected(false);
      },
    });

    // Load initial messages
    apiRef.current.getMessages().then((initialMessages) => {
      setMessages(initialMessages);
    }).catch((error) => {
      console.error('Failed to load messages:', error);
      setIsLoading(false);
    });

    return () => {
      wsRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    // Auto-scroll to bottom when new messages arrive
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!inputValue.trim() || !apiRef.current) return;

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
      // Always use HTTP POST to gateway (goes through Redis Stream → Worker)
      const response = await apiRef.current.sendMessage(messageText);
      if (!response.success) {
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
      } else {
        // Keep temp message, will be updated when WebSocket receives confirmation
        // Status remains 'pending' until meta_message_created event
      }
    } catch (error) {
      console.error('Failed to send message:', error);
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

  if (!tenantId) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>Invalid configuration</div>
      </div>
    );
  }

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
          messages.map((message) => (
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
          ))
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

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'bot' | 'agent';
  timestamp: string;
  deliveryStatus?: 'pending' | 'delivered' | 'failed';
}

