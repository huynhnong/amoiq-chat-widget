# Getting Started

## Overview

The Amoiq Chat Widget is a production-ready, embeddable chat widget for customer websites. It provides real-time messaging, session management, and supports both anonymous and logged-in users.

## Features

- ✅ **Production-ready session management** - Tracks users across tabs and browser restarts
- ✅ **Browser fingerprinting** - Identifies same user across devices
- ✅ **Anonymous & logged-in users** - Single endpoint handles both user types
- ✅ **Conversation history** - Automatically loads previous conversations
- ✅ **Real-time messaging** - WebSocket with HTTP API fallback
- ✅ **Retry logic** - Automatic retries with exponential backoff
- ✅ **Error handling** - Graceful degradation and user feedback

## Quick Installation

Add these two script tags to your HTML page (before the closing `</body>` tag):

```html
<script>
  window.ChatWidgetConfig = {
    tenantId: "your-tenant-id",
    position: "bottom-right"
  };
</script>
<script src="https://webchat.amoiq.com/widget.v1.0.0.js" async></script>
```

That's it! The widget will automatically appear on your website.

## Architecture

The widget follows a **Gateway → Backend Services** architecture:

```
Widget → Gateway (API Key Auth) → Backend Services
              ├─→ Backend API Server (HTTP endpoints)
              └─→ Backend WebSocket Server (real-time)
```

**Key Points:**
- ✅ All connections (HTTP and WebSocket) **must** go through Gateway
- ✅ Gateway uses **API key authentication** (Bearer token)
- ✅ Backend generates **JWT tokens** (has `JWT_SECRET`)
- ✅ Widget **never** connects directly to backend services

## Development

```bash
npm install
npm run dev
```

The widget will be available at `http://localhost:3000`. Test the embed page at `http://localhost:3000/embed?tenantId=test`.

## Environment Variables

Create a `.env.local` file:

```env
NEXT_PUBLIC_GATEWAY_URL=https://api-gateway.amoiq.com
NEXT_PUBLIC_GATEWAY_API_KEY=your-api-key-optional
```

**Important:**
- **`NEXT_PUBLIC_GATEWAY_URL`** (Required): Gateway URL - all connections go through gateway
- **`NEXT_PUBLIC_GATEWAY_API_KEY`** (Optional): API key for Gateway authentication
- **Deprecated variables:**
  - `NEXT_PUBLIC_API_URL` - Use `NEXT_PUBLIC_GATEWAY_URL` instead
  - `NEXT_PUBLIC_WS_URL` - Use `NEXT_PUBLIC_GATEWAY_URL` instead
  - `NEXT_PUBLIC_WEBSOCKET_URL` - Use `NEXT_PUBLIC_GATEWAY_URL` instead

## Project Structure

```
amoiq-chat-widget/
├── app/
│   ├── embed/
│   │   ├── page.tsx          # Chat UI component
│   │   └── styles.module.css # Chat styles
│   └── ...
├── lib/
│   ├── api.ts                 # Backend API client
│   ├── ws.ts                  # WebSocket client
│   ├── session.ts             # Session management utility
│   └── tenant.ts              # Tenant resolution
├── public/
│   └── widget.v1.0.0.js       # Widget loader script
└── docs/                      # Documentation
```

## Next Steps

1. **[Embedding Guide](./05-embedding.md)** - Learn how to embed the widget
2. **[Backend Setup](./02-backend-setup.md)** - Set up your backend services
3. **[Session Management](./03-session-management.md)** - Understand session handling
4. **[Admin Integration](./04-admin-integration.md)** - Integrate admin features
5. **[API Reference](./06-api-reference.md)** - Complete API documentation

