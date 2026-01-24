/**
 * Session Management Utility
 * Handles session ID generation, persistence, and browser fingerprinting
 * Production-ready with localStorage, expiration, and cross-tab support
 */

const SESSION_ID_KEY = 'chat_session_id';
const SESSION_CREATED_KEY = 'chat_session_created';
const FINGERPRINT_KEY = 'chat_fingerprint';

export interface SessionInfo {
  sessionId: string;
  fingerprint: string;
  createdAt: number;
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  const random2 = Math.random().toString(36).substring(2, 15);
  return `session-${timestamp}-${random}${random2}`;
}

/**
 * Generate browser fingerprint for user identification
 * Combines multiple browser characteristics to create a unique identifier
 */
function generateBrowserFingerprint(): string {
  if (typeof window === 'undefined') {
    return 'unknown';
  }

  // Type assertion for deviceMemory (not in standard Navigator type but available in some browsers)
  const nav = navigator as any;

  const components: string[] = [
    navigator.userAgent || '',
    navigator.language || '',
    navigator.languages?.join(',') || '',
    `${screen.width}x${screen.height}`,
    `${screen.colorDepth || 24}`,
    new Date().getTimezoneOffset().toString(),
    navigator.platform || '',
    navigator.hardwareConcurrency?.toString() || '',
    nav.deviceMemory?.toString() || '',
  ];

  // Create a hash-like string
  const fingerprint = components.join('|');
  
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < fingerprint.length; i++) {
    const char = fingerprint.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  
  // Convert to base36 string (shorter)
  return Math.abs(hash).toString(36).substring(0, 16);
}

/**
 * Get or create session ID (persistent across tabs using localStorage)
 * Session ID is shared across all tabs for the same domain
 */
export function getOrCreateSessionId(): string {
  if (typeof window === 'undefined') {
    return generateSessionId();
  }

  try {
    // Check if session ID exists in localStorage
    let sessionId = localStorage.getItem(SESSION_ID_KEY);
    const createdAt = localStorage.getItem(SESSION_CREATED_KEY);

    if (sessionId && createdAt) {
      // Check if session is still valid (24 hours)
      const age = Date.now() - parseInt(createdAt, 10);
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours

      if (age < maxAge) {
        // Session is still valid
        return sessionId;
      } else {
        // Session expired - create new one
        console.log('[Session] Session expired, creating new session');
      }
    }

    // Create new session
    sessionId = generateSessionId();
    const now = Date.now();

    localStorage.setItem(SESSION_ID_KEY, sessionId);
    localStorage.setItem(SESSION_CREATED_KEY, now.toString());

    console.log('[Session] Created new session:', sessionId);
    return sessionId;
  } catch (error) {
    // localStorage might be disabled or full
    console.warn('[Session] Failed to access localStorage, using in-memory session:', error);
    return generateSessionId();
  }
}

/**
 * Get or create browser fingerprint (persistent across sessions)
 */
export function getOrCreateFingerprint(): string {
  if (typeof window === 'undefined') {
    return 'unknown';
  }

  try {
    let fingerprint = localStorage.getItem(FINGERPRINT_KEY);

    if (!fingerprint) {
      fingerprint = generateBrowserFingerprint();
      localStorage.setItem(FINGERPRINT_KEY, fingerprint);
      console.log('[Session] Generated new fingerprint:', fingerprint);
    }

    return fingerprint;
  } catch (error) {
    console.warn('[Session] Failed to access localStorage for fingerprint:', error);
    return generateBrowserFingerprint();
  }
}

/**
 * Get complete session info (sessionId + fingerprint)
 */
export function getSessionInfo(): SessionInfo {
  return {
    sessionId: getOrCreateSessionId(),
    fingerprint: getOrCreateFingerprint(),
    createdAt: getSessionCreatedAt(),
  };
}

/**
 * Get session creation timestamp
 */
export function getSessionCreatedAt(): number {
  if (typeof window === 'undefined') {
    return Date.now();
  }

  try {
    const createdAt = localStorage.getItem(SESSION_CREATED_KEY);
    return createdAt ? parseInt(createdAt, 10) : Date.now();
  } catch (error) {
    return Date.now();
  }
}

/**
 * Clear session (logout or reset)
 */
export function clearSession(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.removeItem(SESSION_ID_KEY);
    localStorage.removeItem(SESSION_CREATED_KEY);
    // Keep fingerprint - it's device-specific, not session-specific
    console.log('[Session] Session cleared');
  } catch (error) {
    console.warn('[Session] Failed to clear session:', error);
  }
}

/**
 * Check if session exists and is valid
 */
export function hasValidSession(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const sessionId = localStorage.getItem(SESSION_ID_KEY);
    const createdAt = localStorage.getItem(SESSION_CREATED_KEY);

    if (!sessionId || !createdAt) {
      return false;
    }

    const age = Date.now() - parseInt(createdAt, 10);
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    return age < maxAge;
  } catch (error) {
    return false;
  }
}

/**
 * Refresh session timestamp (update last activity)
 */
export function refreshSession(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const sessionId = localStorage.getItem(SESSION_ID_KEY);
    if (sessionId) {
      // Update creation time to extend session
      localStorage.setItem(SESSION_CREATED_KEY, Date.now().toString());
    }
  } catch (error) {
    console.warn('[Session] Failed to refresh session:', error);
  }
}

