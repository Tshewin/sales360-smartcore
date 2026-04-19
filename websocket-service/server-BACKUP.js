/**
 * Sales360 SmartCore - WebSocket + Twilio Server
 * Handles real-time Dashboard sync + Phone calls
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// WebSocket API key (for Dashboard authentication)
const WS_API_KEY = process.env.WS_API_KEY || '348bfe2c06cfb611c6240a83b8b850f4683908d2eb05d450b01b5a760c3c3dee';

// Store connected clients
const clients = new Map();

// ═══════════════════════════════════════════════════
// WEBSOCKET SERVER (existing Demo sync)
// ═══════════════════════════════════════════════════

wss.on('connection', (ws) => {
  let clientId = null;
  let clientType = null;
  let authenticated = false;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Handle authentication
      if (data.type === 'auth') {
        if (data.apiKey !== WS_API_KEY) {
          ws.send(JSON.stringify({ type: 'authFailed', reason: 'Invalid API key' }));
          ws.close();
          return;
        }

        authenticated = true;
        clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        clientType = data.clientType || 'unknown';

        clients.set(clientId, { ws, type: clientType, connectedAt: new Date() });

        ws.send(JSON.stringify({ type: 'authSuccess', clientId, clientType }));
        console.log(`✓ Auth success - ${clientType} (${clientId})`);

        // Broadcast client connection
        broadcast({
          type: 'clientConnected',
          clientId,
          clientType,
          timestamp: new Date().toISOString()
        }, clientId);

        return;
      }

      // Reject unauthenticated messages
      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      // Handle events from Demo
      if (data.type === 'event') {
        console.log(`Event: ${data.event} from ${clientId}`);
        
        // Broadcast to all clients (especially Dashboard)
        broadcast({
          type: 'event',
          event: data.event,
          payload: data.payload,
          timestamp: new Date().toISOString()
        }, clientId);
      }

    } catch (error) {
      console.error('WebSocket error:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    if (clientId) {
      console.log(`Disconnect - ${clientType} (${clientId}) - Code: 1006`);
      clients.delete(clientId);
      
      // Broadcast disconnection
      broadcast({
        type: 'clientDisconnected',
        clientId,
        clientType,
        timestamp: new Date().toISOString()
      });
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Broadcast to all connected clients except sender
function broadcast(message, excludeClientId = null) {
  const messageStr = JSON.stringify(message);
  let sentCount = 0;

  clients.forEach((client, id) => {
    if (id !== excludeClientId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(messageStr);
      sentCount++;
    }
  });

  if (sentCount > 0) {
    console.log(`Broadcast: ${message.type || message.event} → ${sentCount} clients`);
  }
}

// Heartbeat to keep connections alive
setInterval(() => {
  const activeCount = clients.size;
  if (activeCount > 0) {
    console.log(`Heartbeat: ${activeCount} active connections`);
  }
}, 30000);

// ═══════════════════════════════════════════════════
// TWILIO CALL ROUTES (NEW)
// ═══════════════════════════════════════════════════

const callRoutes = require('./call-routes');

// Mount call routes
app.use('/api/call', callRoutes);
app.use('/twilio', callRoutes); // Twilio webhooks

// ═══════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    service: 'Sales360 SmartCore',
    status: 'running',
    websocket: 'active',
    twilio: 'active',
    clients: clients.size,
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    connections: {
      websocket: clients.size,
      active: Array.from(clients.values()).map(c => c.type)
    }
  });
});

// ═══════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║                                                    ║
║           Sales360 SmartCore Server                ║
║                                                    ║
║  WebSocket: wss://successful-strength...railway.app║
║  HTTP: Port ${PORT}                                  ║
║  Twilio: Active                                    ║
║                                                    ║
╚════════════════════════════════════════════════════╝
  `);
  
  console.log('[SmartCore] Server started successfully');
  console.log('[SmartCore] WebSocket endpoint ready');
  console.log('[SmartCore] Twilio integration ready');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SmartCore] SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('[SmartCore] Server closed');
    process.exit(0);
  });
});
