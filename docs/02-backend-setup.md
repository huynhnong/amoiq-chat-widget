# Backend Setup Guide

## Overview

The chat widget is a **frontend-only** component. To work properly, it requires backend services that handle authentication, message storage, and real-time communication.

## Required Services

### 1. API Gateway (Required)

**Purpose:** Authentication, routing, and security layer

**Responsibilities:**
- **API Key Authentication**: Verify API key (Bearer token) for all connections
- **Route HTTP requests**: Routes requests to Backend API Server
- **Proxy WebSocket connections**: Proxies WebSocket connections to Backend WebSocket Server
- **Rate limiting**: Optional protection against abuse
- **Load balancing**: Optional distribution across backend instances

**Important:** Gateway does NOT generate JWT tokens. Backend services handle JWT generation.

**Required Endpoints:**

1. **`POST /api/chat/anonymous-token`** - Route to Backend (Backend generates JWT)
   ```http
   POST /api/chat/anonymous-token
   Authorization: Bearer <api-key>
   Content-Type: application/json
   
   { "tenantId": "tenant-123" }
   ```
   - Gateway: Verifies API key, routes to Backend
   - Backend: Generates JWT token, returns to Gateway
   - Response: `{ "token": "eyJ...", "expiresIn": 3600 }`

2. **`GET /api/chat/online-users`** - Route to Backend (Backend queries Redis)
   ```http
   GET /api/chat/online-users?tenantId=xxx
   Authorization: Bearer <api-key>
   ```
   - Gateway: Verifies API key, routes to Backend
   - Backend: Queries Redis, returns list

3. **WebSocket Proxy** - Proxy all WebSocket connections
   - Gateway receives WebSocket connection with API key
   - Gateway verifies API key
   - Gateway proxies connection to Backend WebSocket Server
   - Backend WebSocket Server handles JWT and Redis tracking

**Gateway Implementation Example:**

```javascript
// Gateway API key authentication middleware
const API_KEY = process.env.GATEWAY_API_KEY;

// HTTP requests
app.use('/api/chat', (req, res, next) => {
  const apiKey = req.headers.authorization?.replace('Bearer ', '');
  
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  // Route to Backend API Server
  proxyToBackend(req, res);
});

// WebSocket connections
io.use((socket, next) => {
  const apiKey = socket.handshake.auth.apiKey || 
                 socket.handshake.headers.authorization?.replace('Bearer ', '');
  
  if (!apiKey || apiKey !== API_KEY) {
    return next(new Error('Invalid API key'));
  }
  
  // Proxy to Backend WebSocket Server
  next();
});
```

### 2. Backend API Server (Required)

**Purpose:** Send/receive messages, manage conversations, handle sessions

**Responsibilities:**
- **JWT Generation**: Generate JWT tokens for anonymous users (has `JWT_SECRET`)
- **HTTP Endpoints**: Implement message and history endpoints
- **Session Management**: Handle sessionId and fingerprint for anonymous users
- **User Identification**: Determine user type based on payload (userId presence)
- **Redis Queries**: Query online users from Redis

**Required Endpoints:**

1. **`POST /webchat/message`** - Send a message (single endpoint for both anonymous and logged-in users)
   
   **Request:**
   ```json
   {
     "text": "Hello, I need help",
     "tenantId": "tenant-123",
     "sessionId": "session-789-abc123",    // Always sent
     "fingerprint": "a1b2c3d4e5f6g7h8",     // Always sent
     "userId": "user-456",                  // Optional: If present = logged-in user
     "userInfo": {                          // Optional: Only for logged-in users
       "name": "John Doe",
       "email": "john@example.com"
     },
     "domain": "example.com",
     "origin": "https://example.com",
     "url": "https://example.com/page",
     "referrer": "https://google.com",
     "siteId": "site-123"
   }
   ```
   
   **Backend Logic:**
   - If `userId` present → Logged-in user
   - If no `userId` → Anonymous user (uses sessionId + fingerprint)
   - Store session in Redis: `session:{sessionId}`
   - Save message to database
   
   **Response:**
   ```json
   {
     "success": true,
     "messageId": "msg-123",
     "sessionId": "session-789-abc123"
   }
   ```

2. **`GET /api/chat/messages`** - Fetch conversation history
   ```http
   GET /api/chat/messages?tenantId=xxx&sessionId=xxx&userId=xxx
   Authorization: Bearer <jwt-token>
   ```
   - Returns messages for the sessionId or userId
   - Supports both anonymous and logged-in users

3. **`POST /api/chat/anonymous-token`** - Generate JWT token for anonymous users
   ```http
   POST /api/chat/anonymous-token
   Authorization: Bearer <api-key>
   Content-Type: application/json
   
   { "tenantId": "tenant-123" }
   ```
   - Backend generates JWT using `JWT_SECRET`
   - Returns: `{ "token": "eyJ...", "expiresIn": 3600 }`

4. **`GET /api/chat/online-users`** - Get list of online users
   ```http
   GET /api/chat/online-users?tenantId=xxx
   Authorization: Bearer <jwt-token>
   ```
   - Queries Redis: `HGETALL online_users:{tenantId}`
   - Returns formatted list of online users

### 3. Backend WebSocket Server (Required for real-time)

**Purpose:** Real-time message delivery and presence tracking

**Responsibilities:**
- **WebSocket Connections**: Handle real-time connections from Gateway
- **JWT Verification**: Verify JWT tokens (has `JWT_SECRET`)
- **Presence Tracking**: Track online/offline users in Redis
- **Message Broadcasting**: Broadcast messages to conversation rooms
- **Redis Integration**: Store online users and session data

**Connection Flow:**
```
Widget → Gateway (with API key) → Backend WebSocket Server (with JWT)
```

**Redis Structure:**
- **Online Users**: `online_users:{tenantId}` (Redis Hash)
  - Field: `userId`
  - Value: JSON string `{ sessionId, connectedAt, domain, origin, url }`
  - Operations: `HSET`, `HDEL`, `HGETALL`

- **Sessions**: `session:{sessionId}` (Redis String, 24h TTL)
  - Value: JSON string `{ userId, fingerprint, tenantId, createdAt, lastActivity }`

**Room Management:**
- `tenant:{tenantId}` - Tenant-wide broadcasts
- `conversation:{sessionId}` - Message delivery to specific conversations
- `admin:{tenantId}` - Presence updates for admins

**Message Handling:**
1. Receive `message` event from client
2. Generate `messageId` (UUID)
3. Get `sessionId` from socket or payload
4. Get `userId` from socket auth or payload
5. Push to Redis Stream `meta:webhook_jobs` using XADD
6. Broadcast to conversation room: `io.to('conversation:{sessionId}').emit('meta_message_created', { message: {...} })`

## Environment Variables

### Gateway
```env
GATEWAY_API_KEY=your-api-key
BACKEND_API_URL=http://backend-api:3000
BACKEND_WS_URL=ws://backend-ws:3001
```

### Backend API Server
```env
JWT_SECRET=your-jwt-secret
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://...
```

### Backend WebSocket Server
```env
JWT_SECRET=your-jwt-secret
REDIS_URL=redis://localhost:6379
```

## Deployment Checklist

1. ✅ **Gateway** - API key authentication, routing, WebSocket proxy
2. ✅ **Backend API Server** - JWT generation, HTTP endpoints, session management
3. ✅ **Backend WebSocket Server** - Real-time connections, presence tracking
4. ✅ **Redis** - Online users and session storage
5. ✅ **Database** - Message storage
6. ✅ **Environment Variables** - Set in Vercel for widget

## Next Steps

- **[Session Management](./03-session-management.md)** - Understand session handling
- **[Admin Integration](./04-admin-integration.md)** - Integrate admin features
- **[API Reference](./06-api-reference.md)** - Complete API documentation

