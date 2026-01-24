# Admin Online Users Integration Guide

This guide explains how to integrate online users tracking into your admin application. The chat widget provides utilities for tracking which users are currently online in real-time.

## Overview

The online users tracking system provides:
- **Real-time updates** via WebSocket when users come online/go offline
- **HTTP API endpoint** for fetching current online users list
- **React hook** (`useOnlineUsers`) for easy integration
- **TypeScript types** for type-safe integration

## Architecture

The system follows a **Gateway → Backend Services** architecture:

```
Admin UI → Gateway → Backend Services
                ├─→ Backend WebSocket Server (presence tracking)
                └─→ Backend API Server (HTTP endpoint)
```

### Data Flow

1. **User connects** → Backend WebSocket Server tracks connection
2. **Backend emits** `user_online` event → Broadcasts to admin rooms
3. **Admin UI receives** event via WebSocket → Updates UI in real-time
4. **Admin requests list** → HTTP API queries online users → Returns list

## Backend Requirements

### Gateway (Proxy/Routing Layer)

**Responsibilities:**
- Route HTTP requests: `GET /api/chat/online-users` → Backend API Server
- Proxy WebSocket connections → Backend WebSocket Server
- Handle admin authentication/authorization (verify admin tokens, API keys)
- Load balancing and rate limiting (optional)

**Configuration needed:**
- Route `/api/chat/online-users` to backend API service
- Proxy WebSocket connections to backend WebSocket server
- Admin authentication middleware/verification

### Backend WebSocket Server

**Responsibilities:**
- Track user connections/disconnections in real-time
- Store online users state in Redis Hash (HSET) with key pattern `online_users:{tenantId}`
- Handle incoming messages and push to Redis Streams for worker processing
- Emit WebSocket events:
  - `user_online` - when user connects (broadcast to admin rooms)
  - `user_offline` - when user disconnects (broadcast to admin rooms)
  - `meta_message_created` - when message is created (broadcast to conversation rooms)
  - `online_users_list` - response to `get_online_users` request
- Join clients to appropriate rooms (tenant, conversation, admin)
- Handle `get_online_users` event from admin clients

**Implementation details:**
- Track connections with: `userId`, `sessionId`, `tenantId`, `connectedAt`, `domain`, `origin`, `url`
- Generate `sessionId` once per socket connection (use `socket.id` or generate UUID and store)
- Remove users from online list on disconnect
- Broadcast presence changes to all admin clients in tenant's admin room
- Handle incoming messages: push to Redis Streams, then broadcast to conversation rooms

**Redis Structure:**
- Use Redis Hash (HSET) to store online users: `online_users:{tenantId}`
- Key pattern: `online_users:{tenantId}`
- Field: `userId` (string)
- Value: JSON string containing `{ sessionId, connectedAt, domain, origin, url }`
- Operations:
  - Add/Update: `HSET online_users:{tenantId} {userId} {JSON.stringify(userData)}`
  - Remove: `HDEL online_users:{tenantId} {userId}`
  - Get all: `HGETALL online_users:{tenantId}` (returns object of userId -> JSON string)
  - Get specific user: `HGET online_users:{tenantId} {userId}`

**Room Management:**
- All users join: `tenant:{tenantId}` (for tenant-wide broadcasts)
- Users join: `conversation:{sessionId}` (for message delivery to specific conversations)
- Admins join: `admin:{tenantId}` (for presence updates)

**Message Handling:**
- Listen for `message` event from clients
- When message received:
  1. Generate `messageId` (UUID)
  2. Get `sessionId` from socket (generated once per connection, stored in Redis)
  3. Get `userId` from socket auth
  4. Push to Redis Stream `meta:webhook_jobs` using XADD:
     ```
     XADD meta:webhook_jobs '*' \
       job_type "webchat_webhook" \
       source "webhook" \
       webhook_type "message" \
       payload '{"messageId":"<uuid>","sessionId":"<from-socket>","userId":"<from-auth>","tenantId":<number>,"siteId":<number>,"domain":"<string>","text":"<string>","senderType":"user","timestamp":"<ISO8601>"}' \
       headers '{"content-type":"application/json","x-webhook-source":"webchat-service"}' \
       timestamp "<ISO8601>"
     ```
  5. Broadcast to conversation room: `io.to('conversation:{sessionId}').emit('meta_message_created', { message: {...} })`

**Example WebSocket server logic (pseudo-code):**
```javascript
// When user connects
socket.on('connect', () => {
  const userId = socket.userId; // from auth
  const tenantId = socket.tenantId;
  const isAdmin = socket.auth.role === 'admin';
  
  // Store user connection in Redis Hash
  const userData = {
    sessionId: socket.id,
    connectedAt: new Date().toISOString(),
    domain: socket.handshake.query.domain,
    origin: socket.handshake.query.origin,
    url: socket.handshake.query.url,
  };
  await redis.hset(
    `online_users:${tenantId}`,
    userId,
    JSON.stringify(userData)
  );
  
  // Join tenant room (for tenant-wide broadcasts)
  socket.join(`tenant:${tenantId}`);
  
  // Join conversation room (for message delivery)
  socket.join(`conversation:${socket.id}`);
  
  // If admin, also join admin room
  if (isAdmin) {
    socket.join(`admin:${tenantId}`);
  }
  
  // Notify admins
  io.to(`admin:${tenantId}`).emit('user_online', {
    userId,
    sessionId: socket.id,
    connectedAt: new Date().toISOString(),
    domain: socket.handshake.query.domain,
    origin: socket.handshake.query.origin,
    url: socket.handshake.query.url,
  });
});

// When user disconnects
socket.on('disconnect', () => {
  const userId = socket.userId;
  const tenantId = socket.tenantId;
  
  // Remove user from Redis Hash
  await redis.hdel(`online_users:${tenantId}`, userId);
  
  // Notify admins
  io.to(`admin:${tenantId}`).emit('user_offline', { userId });
});

// Handle admin request for online users
socket.on('get_online_users', ({ tenantId }) => {
  if (socket.auth.role !== 'admin') return;
  
  // Get all online users from Redis Hash
  const allUsers = await redis.hgetall(`online_users:${tenantId}`);
  const onlineUsers = Object.entries(allUsers).map(([userId, data]) => ({
    userId,
    ...JSON.parse(data),
  }));
  socket.emit('online_users_list', { users: onlineUsers });
});

// Handle incoming messages
socket.on('message', async (data) => {
  const userId = socket.userId;
  const tenantId = socket.tenantId;
  const sessionId = socket.id; // Use socket.id as sessionId (generated once per connection)
  
  // Generate messageId
  const messageId = generateUUID();
  
  // Prepare payload for Redis Stream
  const payload = {
    messageId,
    sessionId,
    userId,
    tenantId: parseInt(tenantId),
    siteId: data.siteId ? parseInt(data.siteId) : null,
    domain: data.domain || '',
    text: data.text,
    senderType: 'user',
    timestamp: new Date().toISOString(),
  };
  
  // Push to Redis Stream for worker processing
  await redis.xadd(
    'meta:webhook_jobs',
    '*',
    'job_type', 'webchat_webhook',
    'source', 'webhook',
    'webhook_type', 'message',
    'payload', JSON.stringify(payload),
    'headers', JSON.stringify({
      'content-type': 'application/json',
      'x-webhook-source': 'webchat-service'
    }),
    'timestamp', new Date().toISOString()
  );
  
  // Broadcast to conversation room (only participants in this conversation)
  io.to(`conversation:${sessionId}`).emit('meta_message_created', {
    message: {
      id: messageId,
      text: data.text,
      sender: 'user',
      timestamp: payload.timestamp,
      sessionId,
      userId,
      tenantId,
    }
  });
});
```

### Backend API Server

**Responsibilities:**
- Implement HTTP endpoint: `GET /api/chat/online-users`
- Query online users from storage (Redis, in-memory store, or database)
- Return formatted list of online users
- Support tenant-scoped queries via `X-Tenant-ID` header or query params

**Endpoint specification:**
- **URL**: `GET /api/chat/online-users?tenantId=xxx`
- **Headers**: 
  - `X-Tenant-ID: <tenantId>` (required)
  - `Authorization: Bearer <token>` (required for admin)
- **Response**: 
  ```json
  {
    "users": [
      {
        "userId": "user-123",
        "sessionId": "session-456",
        "connectedAt": "2024-01-15T10:30:00.000Z",
        "domain": "example.com",
        "origin": "https://example.com",
        "url": "https://example.com/page"
      }
    ]
  }
  ```

## Installation

### Option 1: Copy Utilities to Your Admin App

Copy these files to your admin application:
- `lib/ws.ts` - WebSocket client with presence support
- `lib/api.ts` - API client with `getOnlineUsers()` method
- `lib/hooks/useOnlineUsers.ts` - React hook

### Option 2: Install as Package (if published)

```bash
npm install @amoiq/chat-widget
```

## API Reference

### TypeScript Interfaces

#### `OnlineUser`
```typescript
interface OnlineUser {
  userId: string;
  sessionId?: string;
  connectedAt: string;
  domain?: string;
  origin?: string;
  url?: string;
}
```

#### `WebSocketCallbacks`
```typescript
interface WebSocketCallbacks {
  onMessage?: (message: any) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  onUserOnline?: (user: OnlineUser) => void;
  onUserOffline?: (userId: string) => void;
  onOnlineUsersList?: (users: OnlineUser[]) => void;
}
```

### WebSocket Events

#### Client → Server Events

**`get_online_users`**
- **Description**: Request list of online users (admin only)
- **Payload**: 
  ```typescript
  {
    tenantId: string;
  }
  ```

#### Server → Client Events

**`user_online`**
- **Description**: Emitted when a user comes online
- **Payload**: `OnlineUser` object

**`user_offline`**
- **Description**: Emitted when a user goes offline
- **Payload**: 
  ```typescript
  {
    userId: string;
  }
  ```
  Or just the `userId` string

**`online_users_list`**
- **Description**: Response to `get_online_users` request
- **Payload**: 
  ```typescript
  {
    users: OnlineUser[];
  }
  ```

### HTTP API Endpoints

#### `GET /api/chat/online-users`

**Description**: Get list of online users for a tenant

**Query Parameters:**
- `tenantId` (required): Tenant ID to query

**Headers:**
- `X-Tenant-ID`: Tenant ID (alternative to query param)
- `Authorization`: Bearer token (required for admin)

**Response:**
```json
{
  "users": [
    {
      "userId": "user-123",
      "sessionId": "session-456",
      "connectedAt": "2024-01-15T10:30:00.000Z",
      "domain": "example.com",
      "origin": "https://example.com",
      "url": "https://example.com/page"
    }
  ]
}
```

**Error Responses:**
- `401 Unauthorized`: Missing or invalid authentication
- `403 Forbidden`: Not authorized as admin
- `404 Not Found`: Tenant not found
- `500 Internal Server Error`: Server error

## Usage Examples

### 1. Using the React Hook (Recommended)

The easiest way to integrate online users tracking is using the `useOnlineUsers` hook:

```tsx
import { useOnlineUsers } from '@/lib/hooks/useOnlineUsers';

function AdminDashboard({ tenantId }: { tenantId: string }) {
  const { onlineUsers, isLoading, error, refresh, isConnected } = useOnlineUsers(tenantId);

  return (
    <div>
      <h2>Online Users</h2>
      <div>
        Status: {isConnected ? 'Real-time' : 'Polling'}
        <button onClick={refresh}>Refresh</button>
      </div>
      
      {error && <div>Error: {error.message}</div>}
      
      {isLoading ? (
        <div>Loading...</div>
      ) : (
        <div>
          <p>{onlineUsers.length} users online</p>
          <ul>
            {onlineUsers.map(user => (
              <li key={user.userId}>
                {user.userId} - {user.domain}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

**Hook Options:**
```typescript
interface UseOnlineUsersOptions {
  enableWebSocket?: boolean;  // Default: true
  pollingInterval?: number;   // Default: 5000ms (when WebSocket disabled)
  autoRefresh?: boolean;      // Default: true
}
```

**Example with options:**
```tsx
const { onlineUsers } = useOnlineUsers(tenantId, {
  enableWebSocket: true,      // Use WebSocket for real-time updates
  pollingInterval: 10000,     // Fallback polling interval
  autoRefresh: true,          // Auto-fetch on mount
});
```

### 2. Direct WebSocket Integration

For more control, you can use the `ChatWebSocket` class directly:

```tsx
import { useEffect, useState } from 'react';
import { ChatWebSocket, OnlineUser } from '@/lib/ws';

function CustomOnlineUsers({ tenantId }: { tenantId: string }) {
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [ws, setWs] = useState<ChatWebSocket | null>(null);

  useEffect(() => {
    const websocket = new ChatWebSocket(
      tenantId,
      {
        onConnect: () => {
          console.log('Connected as admin');
          websocket.requestOnlineUsers();
        },
        onUserOnline: (user) => {
          setOnlineUsers(prev => {
            const exists = prev.find(u => u.userId === user.userId);
            if (exists) {
              return prev.map(u => u.userId === user.userId ? user : u);
            }
            return [...prev, user];
          });
        },
        onUserOffline: (userId) => {
          setOnlineUsers(prev => prev.filter(u => u.userId !== userId));
        },
        onOnlineUsersList: (users) => {
          setOnlineUsers(users);
        },
      },
      undefined,
      true // isAdmin = true
    );

    setWs(websocket);

    return () => {
      websocket.disconnect();
    };
  }, [tenantId]);

  return (
    <div>
      <h2>Online Users ({onlineUsers.length})</h2>
      <ul>
        {onlineUsers.map(user => (
          <li key={user.userId}>{user.userId}</li>
        ))}
      </ul>
    </div>
  );
}
```

### 3. API-Only Integration (Polling)

If you prefer to use only HTTP API without WebSocket:

```tsx
import { useEffect, useState } from 'react';
import { ChatAPI, OnlineUser } from '@/lib/api';

function PollingOnlineUsers({ tenantId }: { tenantId: string }) {
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const api = new ChatAPI(tenantId);

    const fetchUsers = async () => {
      try {
        const users = await api.getOnlineUsers();
        setOnlineUsers(users);
      } catch (error) {
        console.error('Failed to fetch online users:', error);
      } finally {
        setIsLoading(false);
      }
    };

    // Initial fetch
    fetchUsers();

    // Poll every 5 seconds
    const interval = setInterval(fetchUsers, 5000);

    return () => clearInterval(interval);
  }, [tenantId]);

  return (
    <div>
      {isLoading ? (
        <div>Loading...</div>
      ) : (
        <div>
          <p>{onlineUsers.length} users online</p>
          <ul>
            {onlineUsers.map(user => (
              <li key={user.userId}>{user.userId}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

Or use the hook with WebSocket disabled:

```tsx
const { onlineUsers } = useOnlineUsers(tenantId, {
  enableWebSocket: false,
  pollingInterval: 5000,
});
```

## Integration Guide

### Step 1: Environment Variables

Set up environment variables in your admin application:

```env
NEXT_PUBLIC_GATEWAY_URL=https://api-gateway-dfcflow.fly.dev
NEXT_PUBLIC_WEBSOCKET_URL=wss://api-gateway-dfcflow.fly.dev
NEXT_PUBLIC_GATEWAY_API_KEY=your-admin-api-key
```

### Step 2: Install Dependencies

If copying files, ensure you have the required dependencies:

```bash
npm install socket.io-client
```

### Step 3: Copy Utilities

Copy the following files to your admin app:
- `lib/ws.ts`
- `lib/api.ts`
- `lib/hooks/useOnlineUsers.ts` (if using React)

### Step 4: Use in Your Admin UI

Import and use the hook or utilities in your admin components:

```tsx
import { useOnlineUsers } from '@/lib/hooks/useOnlineUsers';

export default function AdminPage() {
  const tenantId = 'your-tenant-id'; // Get from auth/context
  const { onlineUsers, isLoading } = useOnlineUsers(tenantId);

  // Render your admin UI with online users
  return (
    <div>
      {/* Your admin UI */}
    </div>
  );
}
```

## Authentication Requirements

### Admin Authentication

The system requires admin-level authentication:

1. **WebSocket**: Pass admin role in connection:
   ```typescript
   new ChatWebSocket(tenantId, callbacks, websiteInfo, true); // isAdmin = true
   ```

2. **HTTP API**: Include admin token in headers:
   ```typescript
   headers: {
     'Authorization': 'Bearer <admin-token>',
     'X-Tenant-ID': tenantId
   }
   ```

### Token Management

- Admin tokens should be obtained through your authentication system
- Tokens should be scoped to specific tenants
- Gateway should verify admin role before allowing access

## Error Handling

### WebSocket Connection Failures

The hook automatically falls back to API polling if WebSocket fails:

```tsx
const { onlineUsers, isConnected } = useOnlineUsers(tenantId);

// isConnected will be false if WebSocket failed
// Hook will automatically use polling as fallback
```

### API Errors

Handle errors gracefully:

```tsx
const { onlineUsers, error } = useOnlineUsers(tenantId);

if (error) {
  return (
    <div>
      <p>Error loading online users: {error.message}</p>
      <button onClick={refresh}>Retry</button>
    </div>
  );
}
```

### Network Issues

The hook handles:
- Connection timeouts
- Network failures
- Automatic reconnection (WebSocket)
- Fallback to polling

## Best Practices

1. **Use the Hook**: Prefer `useOnlineUsers` hook for React applications - it handles all edge cases

2. **Error Boundaries**: Wrap components using the hook in error boundaries

3. **Loading States**: Always show loading states during initial fetch

4. **Real-time Updates**: Use WebSocket for real-time updates (default behavior)

5. **Polling Fallback**: The hook automatically falls back to polling if WebSocket fails

6. **Cleanup**: The hook handles cleanup automatically, but ensure you clean up if using direct WebSocket

7. **Tenant Scoping**: Always pass the correct tenantId - users are scoped per tenant

8. **Performance**: For large numbers of online users, consider pagination or virtualization

## Troubleshooting

### No Online Users Showing

1. Check backend WebSocket server is tracking connections
2. Verify admin authentication is working
3. Check browser console for errors
4. Verify tenantId is correct

### WebSocket Not Connecting

1. Check `NEXT_PUBLIC_WEBSOCKET_URL` is set correctly
2. Verify gateway is proxying WebSocket connections
3. Check admin authentication token is valid
4. Hook will fallback to polling automatically

### Events Not Received

1. Verify backend is emitting `user_online`/`user_offline` events
2. Check admin client is joined to admin room
3. Verify tenantId matches between client and server
4. Check WebSocket connection status

### API Returns Empty Array

1. Verify backend API endpoint is implemented
2. Check online users are being stored (Redis/memory/database)
3. Verify tenantId in request matches stored data
4. Check admin authentication is working

## Example Reference

See `lib/components/OnlineUsersExample.tsx` for a complete reference implementation.

## Support

For issues or questions:
1. Check this documentation
2. Review the example component
3. Check backend implementation matches requirements
4. Verify environment variables are set correctly

