# Admin Integration Guide

## Overview

This guide explains how to integrate online users tracking into your admin application. The chat widget provides utilities for tracking which users are currently online in real-time.

## Features

- **Real-time updates** via WebSocket when users come online/go offline
- **HTTP API endpoint** for fetching current online users list
- **React hook** (`useOnlineUsers`) for easy integration
- **TypeScript types** for type-safe integration

## Architecture

```
Widget/Admin UI → Gateway (API Key Auth) → Backend Services
                              ├─→ Backend WebSocket Server (presence tracking via Redis)
                              └─→ Backend API Server (HTTP endpoint)
```

**Key Points:**
- ✅ All connections (HTTP and WebSocket) **must** go through Gateway
- ✅ Gateway uses **API key authentication** (Bearer token)
- ✅ Backend generates **JWT tokens** (has `JWT_SECRET`)
- ✅ Widget **never** connects directly to backend services

## Data Flow

### 1. User Comes Online (Automatic via WebSocket)

```
Widget → Gateway (with API key) → Backend WebSocket Server
  ↓
Backend WebSocket Server:
  - Stores in Redis: HSET online_users:{tenantId} {userId} {userData}
  - Emits 'user_online' event → Broadcasts to admin rooms
  ↓
Admin UI receives event via WebSocket → Updates UI in real-time
```

### 2. Admin Requests List (HTTP API)

```
Admin UI → Gateway: GET /api/chat/online-users (with API key)
  ↓
Gateway verifies API key → Routes to Backend API Server
  ↓
Backend API Server queries Redis: HGETALL online_users:{tenantId}
  ↓
Returns list → Gateway → Admin UI
```

## Backend Requirements

### Gateway Endpoints

1. **`GET /api/chat/online-users`** - Route to Backend
   ```http
   GET /api/chat/online-users?tenantId=xxx
   Authorization: Bearer <api-key>
   ```
   - Gateway: Verifies API key, routes to Backend
   - Backend: Queries Redis, returns list

2. **WebSocket Proxy** - Proxy all WebSocket connections
   - Gateway receives WebSocket connection with API key
   - Gateway verifies API key
   - Gateway proxies connection to Backend WebSocket Server
   - Backend WebSocket Server handles JWT and Redis tracking

### Backend WebSocket Server

**Redis Structure:**
- Key: `online_users:{tenantId}` (Redis Hash)
- Field: `userId` (string)
- Value: JSON string `{ sessionId, connectedAt, domain, origin, url }`
- Operations: `HSET`, `HDEL`, `HGETALL`

**Room Management:**
- `tenant:{tenantId}` - Tenant-wide broadcasts
- `conversation:{sessionId}` - Message delivery
- `admin:{tenantId}` - Presence updates for admins

**Events:**
- `user_online` - Emitted when user comes online
- `user_offline` - Emitted when user goes offline
- `get_online_users` - Request from admin
- `online_users_list` - Response with list

### Backend API Server

**Endpoint: `GET /api/chat/online-users`**
- Queries Redis: `HGETALL online_users:{tenantId}`
- Returns formatted list of online users

## Client-Side Integration

### Using the React Hook (Recommended)

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

### Direct WebSocket Integration

```tsx
import { useEffect, useState } from 'react';
import { ChatWebSocket, OnlineUser } from '@/lib/ws';

function CustomOnlineUsers({ tenantId }: { tenantId: string }) {
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);

  useEffect(() => {
    const websocket = new ChatWebSocket(
      tenantId,
      {
        onConnect: () => {
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

    return () => websocket.disconnect();
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

### API-Only Integration (Polling)

```tsx
import { useEffect, useState } from 'react';
import { ChatAPI, OnlineUser } from '@/lib/api';

function PollingOnlineUsers({ tenantId }: { tenantId: string }) {
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);

  useEffect(() => {
    const api = new ChatAPI(tenantId);

    const fetchUsers = async () => {
      try {
        const users = await api.getOnlineUsers();
        setOnlineUsers(users);
      } catch (error) {
        console.error('Failed to fetch online users:', error);
      }
    };

    fetchUsers();
    const interval = setInterval(fetchUsers, 5000);

    return () => clearInterval(interval);
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

## API Reference

### HTTP Endpoint

**`GET /api/chat/online-users`**

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

### WebSocket Events

**`user_online`** - User comes online
```typescript
{
  userId: string;
  sessionId: string;
  connectedAt: string;
  domain?: string;
  origin?: string;
  url?: string;
}
```

**`user_offline`** - User goes offline
```typescript
{
  userId: string;
}
```

**`get_online_users`** - Request online users list
```typescript
{
  tenantId: string;
}
```

**`online_users_list`** - Response with online users
```typescript
{
  users: OnlineUser[];
}
```

## Troubleshooting

### No real-time updates
- Check WebSocket connection status
- Verify admin authentication
- Check backend WebSocket server is running
- Verify Redis is accessible

### Online users list is empty
- Check Redis connection
- Verify tenantId is correct
- Check users are actually connected
- Verify backend API endpoint is working

### WebSocket disconnects frequently
- Check network stability
- Verify Gateway is proxying correctly
- Check backend WebSocket server health
- Review connection timeout settings

