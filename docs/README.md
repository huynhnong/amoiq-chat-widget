# Amoiq Chat Widget Documentation

Complete documentation for the Amoiq Chat Widget system.

## Documentation Index

### 1. [Getting Started](./01-getting-started.md)
- Quick installation
- Features overview
- Architecture
- Development setup
- Environment variables

### 2. [Backend Setup](./02-backend-setup.md)
- Required services (Gateway, API Server, WebSocket Server)
- Gateway implementation
- Backend API endpoints
- WebSocket server setup
- Redis configuration
- Deployment checklist

### 3. [Session Management](./03-session-management.md)
- Session identification (anonymous vs logged-in)
- Browser fingerprinting
- Multiple tabs behavior
- Session persistence
- Conversation continuity
- Best practices

### 4. [Admin Integration](./04-admin-integration.md)
- Online users tracking
- Real-time updates
- React hook usage
- WebSocket integration
- API-only polling
- Troubleshooting

### 5. [Embedding Guide](./05-embedding.md)
- Quick start
- Configuration options
- Integration examples (React, WordPress, Shopify, etc.)
- Testing
- Troubleshooting

### 6. [API Reference](./06-api-reference.md)
- Complete API documentation
- HTTP endpoints
- WebSocket events
- Error responses
- Rate limiting
- Best practices

### 7. [System Flow Diagrams](./SYSTEM_FLOW.md)
- Complete system flow diagram
- Authentication flow sequence
- Session management flow
- Message flow comparison (HTTP vs WebSocket)
- Architecture overview

## Quick Links

- **Installation**: [Getting Started](./01-getting-started.md#quick-installation)
- **Backend Setup**: [Backend Setup Guide](./02-backend-setup.md)
- **Session Management**: [Session Management](./03-session-management.md)
- **Admin Features**: [Admin Integration](./04-admin-integration.md)
- **Embedding**: [Embedding Guide](./05-embedding.md)
- **API Docs**: [API Reference](./06-api-reference.md)

## Architecture Overview

```
Widget → Gateway (API Key Auth) → Backend Services
              ├─→ Backend API Server (HTTP endpoints)
              └─→ Backend WebSocket Server (real-time)
```

**Key Points:**
- ✅ All connections go through Gateway
- ✅ Gateway uses API key authentication
- ✅ Backend generates JWT tokens
- ✅ Session management with localStorage
- ✅ Supports anonymous and logged-in users

## Support

For issues or questions:
1. Check the relevant documentation section
2. Review [Troubleshooting](./05-embedding.md#troubleshooting) guides
3. Check [API Reference](./06-api-reference.md) for endpoint details

