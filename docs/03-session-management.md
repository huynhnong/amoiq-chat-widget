# Session Management Guide

## Overview

The chat widget uses a production-ready session management system that:
- ✅ Tracks users across multiple browser tabs (shared session)
- ✅ Persists sessions across browser restarts (24-hour expiration)
- ✅ Identifies same user across devices using browser fingerprinting
- ✅ Supports both anonymous and logged-in users
- ✅ Maintains conversation history continuity

## Architecture

### Session Identification

**For Anonymous Users:**
- `sessionId`: Generated client-side, stored in localStorage (shared across tabs)
- `fingerprint`: Browser fingerprint for cross-device identification
- Backend stores: `sessionId → { userId, fingerprint, createdAt, lastActivity }`

**For Logged-in Users:**
- `userId`: User ID from your authentication system
- `userInfo`: Optional user information (name, email, phone, etc.)
- Backend uses `userId` as primary identifier

### Session Storage

- **localStorage**: Used for sessionId (shared across all tabs)
- **Session expiration**: 24 hours from creation
- **Auto-refresh**: Session timestamp updated on each message

## Message Payload Structure

### Single Endpoint: `POST /webchat/message`

**Request Payload:**
```json
{
  "text": "Hello, I need help",
  "tenantId": "tenant-123",
  
  // Session identification (always sent)
  "sessionId": "session-789-abc123",
  "fingerprint": "a1b2c3d4e5f6g7h8",
  
  // User identification (optional - determines user type)
  "userId": "user-456",           // If present = logged-in user
  "userInfo": {                   // Optional: Only for logged-in users
    "name": "John Doe",
    "email": "john@example.com",
    "phone": "+1234567890"
  },
  
  // Website context (always sent)
  "domain": "example.com",
  "origin": "https://example.com",
  "url": "https://example.com/page",
  "referrer": "https://google.com",
  "siteId": "site-123"
}
```

## Backend Logic

### User Type Detection

```javascript
// Backend: POST /webchat/message
app.post('/webchat/message', async (req, res) => {
  const { text, tenantId, sessionId, fingerprint, userId, userInfo } = req.body;
  
  let finalUserId;
  let finalSessionId;
  let isAnonymous = false;
  
  if (userId) {
    // Logged-in user
    finalUserId = userId;
    finalSessionId = sessionId || await getOrCreateUserSession(userId, tenantId);
    // Use userInfo if provided, or fetch from database
  } else {
    // Anonymous user
    isAnonymous = true;
    
    if (sessionId) {
      // Check if session exists and is valid
      const session = await redis.get(`session:${sessionId}`);
      
      if (session) {
        const sessionData = JSON.parse(session);
        const sessionAge = Date.now() - sessionData.createdAt;
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        
        if (sessionAge < maxAge) {
          // Session valid - continue conversation
          finalSessionId = sessionId;
          finalUserId = sessionData.userId;
        } else {
          // Session expired - create new but try to link by fingerprint
          finalSessionId = await createNewSession(fingerprint, tenantId);
          finalUserId = await getUserIdByFingerprint(fingerprint, tenantId) || 
                        `anonymous-${finalSessionId}`;
        }
      } else {
        // Session not found - try to find by fingerprint
        const existing = await findSessionByFingerprint(fingerprint, tenantId);
        if (existing && isRecent(existing)) {
          finalSessionId = existing.sessionId;
          finalUserId = existing.userId;
        } else {
          // New user or very old session
          finalSessionId = await createNewSession(fingerprint, tenantId);
          finalUserId = `anonymous-${finalSessionId}`;
        }
      }
    } else {
      // No sessionId - create new
      finalSessionId = await createNewSession(fingerprint, tenantId);
      finalUserId = `anonymous-${finalSessionId}`;
    }
  }
  
  // Store/update session in Redis
  await redis.setex(`session:${finalSessionId}`, 86400, JSON.stringify({
    userId: finalUserId,
    fingerprint,
    tenantId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    isAnonymous
  }));
  
  // Process message...
  const messageId = generateUUID();
  
  // Save to database with sessionId/userId
  await saveMessage({
    messageId,
    sessionId: finalSessionId,
    userId: finalUserId,
    tenantId,
    text,
    timestamp: new Date().toISOString()
  });
  
  res.json({ success: true, messageId, sessionId: finalSessionId });
});
```

## Client-Side Implementation

### Session Management

The widget automatically handles session management:

```typescript
// Session is automatically managed
import { getSessionInfo, refreshSession } from '@/lib/session';

// Get session info (sessionId + fingerprint)
const sessionInfo = getSessionInfo();
// { sessionId: "session-123...", fingerprint: "a1b2c3...", createdAt: 1234567890 }

// Session is automatically refreshed on each message
refreshSession(); // Extends expiration
```

### For Anonymous Users

```typescript
// Widget automatically includes sessionId and fingerprint
const api = new ChatAPI(tenantId, websiteInfo);

// Send message - sessionId and fingerprint automatically included
await api.sendMessage("Hello");
```

### For Logged-in Users

```typescript
// Set user info when user logs in
const api = new ChatAPI(tenantId, websiteInfo);
api.setUser(userId, {
  name: "John Doe",
  email: "john@example.com"
});

// Send message - userId and userInfo automatically included
await api.sendMessage("Hello");
```

## Multiple Tabs Behavior

### Same Session Across Tabs

- **localStorage** is shared across all tabs
- All tabs use the **same sessionId**
- All tabs see the **same conversation**
- Messages sent from any tab appear in all tabs

### Example Flow:

```
Tab 1: Opens chat → Creates sessionId → Stores in localStorage
Tab 2: Opens chat → Reads same sessionId from localStorage → Same conversation
Tab 3: Opens chat → Reads same sessionId from localStorage → Same conversation
```

## Session Persistence

### User Returns After 1 Hour

**Scenario:** User chats, closes browser, returns 1 hour later

**Flow:**
1. User opens chat → Reads sessionId from localStorage
2. Sends message with sessionId + fingerprint
3. Backend checks session in Redis:
   - If session exists and < 24 hours old → Continue same conversation
   - If session expired → Create new session, but link by fingerprint
4. Load conversation history from database by sessionId/userId

### Session Expiration

- **Active session**: Last activity < 24 hours → Continue conversation
- **Expired session**: Last activity > 24 hours → New session, but can link by fingerprint
- **Conversation history**: Always stored in database, retrieved by sessionId/userId

## Browser Fingerprinting

### What It Identifies

The fingerprint combines:
- User agent
- Language settings
- Screen resolution
- Timezone
- Platform
- Hardware info (CPU cores, memory)

### Privacy

- Fingerprint is hashed (not raw data)
- Used only for session linking
- No personal information in fingerprint

## Best Practices

1. **Always send sessionId and fingerprint** - Even for logged-in users (for fallback)
2. **Store conversation history** - In database, keyed by sessionId/userId
3. **Session expiration** - 24 hours is recommended (adjustable)
4. **Load history on mount** - Widget automatically loads conversation history
5. **Handle expired sessions** - Backend should gracefully create new sessions

## Troubleshooting

### Session Lost After Browser Restart

- Check localStorage is enabled
- Verify session expiration (24 hours default)
- Check browser privacy settings

### Different Sessions in Different Tabs

- Ensure using localStorage (not sessionStorage)
- Check for browser extensions blocking localStorage
- Verify same domain/origin

### Conversation History Not Loading

- Verify backend stores messages with sessionId/userId
- Check GET /api/chat/messages endpoint
- Verify sessionId matches between requests

