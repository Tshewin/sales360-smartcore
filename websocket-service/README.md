# Sales360 WebSocket Server

Real-time communication layer for Sales360 Demo ↔ Dashboard sync.

## Overview

This is a **standalone Node.js WebSocket service** that runs separately from the main Python FastAPI SmartCore backend.

**Purpose:**
- Real-time IntentScore updates
- Hot Lead alerts (score ≥ 75)
- Call state synchronization
- Live transcript streaming

## Architecture

```
Demo (Vercel) → WebSocket Server (Railway) → Dashboard (Vercel)
                        ↕
                Python SmartCore (Railway)
```

## Deployment

### Railway Configuration

1. **Create New Service:**
   - Railway Dashboard → New Service
   - Connect to `sales360-smartcore` repo
   - Set root directory: `websocket-service`

2. **Environment Variables:**
   ```
   WS_API_KEY=<your-secure-random-key>
   ```

3. **Auto-Deploy:**
   - Railway will detect `package.json`
   - Run `npm install`
   - Start with `npm start`

### Health Check

Once deployed, verify at:
```
https://your-websocket-url.railway.app/health
```

Expected response:
```json
{
  "status": "healthy",
  "service": "websocket-server",
  "connections": 0,
  "uptime": 123.45,
  "timestamp": "2026-04-15T..."
}
```

## Local Development

```bash
# Install dependencies
npm install

# Set environment variable
export WS_API_KEY=your-test-key

# Start server
npm start
```

Server runs on `http://localhost:8080`

## Events

### Client → Server

**Authentication:**
```json
{
  "type": "auth",
  "apiKey": "your-api-key",
  "clientType": "demo" | "dashboard"
}
```

**Emit Event:**
```json
{
  "type": "event",
  "event": "intentScore" | "hotLead" | "callState" | "transcript",
  "payload": { ... }
}
```

### Server → Client

**Auth Success:**
```json
{
  "type": "authSuccess",
  "clientId": "client_...",
  "message": "WebSocket authenticated successfully"
}
```

**Event Broadcast:**
```json
{
  "type": "event",
  "event": "intentScore",
  "payload": { "score": 82, "signals": [...] },
  "timestamp": "...",
  "source": "client_..."
}
```

## Security

- API key authentication required
- 10-second auth timeout
- Connection logging with timestamps
- Invalid message handling

## Monitoring

- Health check endpoint: `/health`
- Connection count tracking
- Heartbeat logging every 60s
- Graceful shutdown on SIGTERM

---

**Built by:** Chuks Obiri + Claude  
**For:** Sales360 AI Real-Time Revenue System  
**Version:** 1.0.0
