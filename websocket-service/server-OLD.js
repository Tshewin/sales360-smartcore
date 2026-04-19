// Sales360 WebSocket Server
// Standalone Node.js service for real-time Demo <-> Dashboard sync
// Deploy separately from Python FastAPI SmartCore

const WebSocket = require('ws');
const http = require('http');

// Environment variables
const PORT = process.env.PORT || 8080;
const WS_API_KEY = process.env.WS_API_KEY || 'sales360-demo-key-2026';

console.log('╔════════════════════════════════════════════╗');
console.log('║   Sales360 WebSocket Server v1.0          ║');
console.log('╚════════════════════════════════════════════╝');
console.log(`Starting on port ${PORT}...`);

// Create HTTP server for health checks
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'healthy', 
      service: 'websocket-server',
      connections: wss.clients.size,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'Sales360 WebSocket Server',
      version: '1.0.0',
      status: 'running',
      endpoints: {
        health: '/health',
        websocket: 'ws://' + req.headers.host
      }
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Client tracking
const clients = new Map();

// Connection handler
wss.on('connection', (ws, req) => {
  const clientId = generateClientId();
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  
  console.log(`[${new Date().toISOString()}] New connection - ID: ${clientId}, IP: ${clientIp}`);

  // Authentication state
  let authenticated = false;
  let authTimeout = setTimeout(() => {
    if (!authenticated) {
      console.log(`[${new Date().toISOString()}] Auth timeout - ${clientId}`);
      ws.close(4001, 'Authentication timeout');
    }
  }, 10000); // 10 second auth window

  // Message handler
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Handle authentication
      if (!authenticated) {
        if (data.type === 'auth' && data.apiKey === WS_API_KEY) {
          authenticated = true;
          clearTimeout(authTimeout);
          
          // Store client metadata
          clients.set(clientId, {
            ws,
            clientType: data.clientType || 'unknown',
            connectedAt: new Date().toISOString(),
            lastActivity: new Date().toISOString()
          });

          // Send auth success
          ws.send(JSON.stringify({
            type: 'authSuccess',
            clientId,
            message: 'WebSocket authenticated successfully',
            timestamp: new Date().toISOString()
          }));

          console.log(`[${new Date().toISOString()}] ✓ Auth success - ${clientId} (${data.clientType})`);
          
          // Broadcast connection event
          broadcast({
            type: 'clientConnected',
            clientId,
            clientType: data.clientType,
            timestamp: new Date().toISOString()
          }, clientId);

        } else {
          ws.close(4003, 'Invalid API key');
          console.log(`[${new Date().toISOString()}] ✗ Auth failed - ${clientId}`);
        }
        return;
      }

      // Update last activity
      const client = clients.get(clientId);
      if (client) {
        client.lastActivity = new Date().toISOString();
      }

      // Handle events from authenticated clients
      handleEvent(data, clientId);

    } catch (error) {
      console.error(`[${new Date().toISOString()}] Message parse error:`, error.message);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format',
        timestamp: new Date().toISOString()
      }));
    }
  });

  // Close handler
  ws.on('close', (code, reason) => {
    clearTimeout(authTimeout);
    const client = clients.get(clientId);
    if (client) {
      console.log(`[${new Date().toISOString()}] Disconnect - ${clientId} (${client.clientType}) - Code: ${code}`);
      clients.delete(clientId);
      
      // Broadcast disconnection
      broadcast({
        type: 'clientDisconnected',
        clientId,
        timestamp: new Date().toISOString()
      }, clientId);
    }
  });

  // Error handler
  ws.on('error', (error) => {
    console.error(`[${new Date().toISOString()}] WebSocket error - ${clientId}:`, error.message);
  });
});

// Event handler
function handleEvent(data, senderId) {
  const { type, event, payload } = data;

  if (type !== 'event') return;

  // Validate event types
  const validEvents = ['intentScore', 'hotLead', 'callState', 'transcript'];
  if (!validEvents.includes(event)) {
    console.warn(`[${new Date().toISOString()}] Unknown event: ${event}`);
    return;
  }

  console.log(`[${new Date().toISOString()}] Event: ${event} from ${senderId}`);

  // Broadcast event to all clients except sender
  broadcast({
    type: 'event',
    event,
    payload,
    timestamp: new Date().toISOString(),
    source: senderId
  }, senderId);
}

// Broadcast function
function broadcast(message, excludeClientId = null) {
  const messageStr = JSON.stringify(message);
  let broadcastCount = 0;

  clients.forEach((client, clientId) => {
    if (clientId !== excludeClientId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(messageStr);
      broadcastCount++;
    }
  });

  if (broadcastCount > 0) {
    console.log(`[${new Date().toISOString()}] Broadcast: ${message.event || message.type} → ${broadcastCount} clients`);
  }
}

// Utility: Generate unique client ID
function generateClientId() {
  return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Start server
server.listen(PORT, () => {
  console.log('');
  console.log('✓ Server started successfully');
  console.log(`✓ HTTP Health: http://localhost:${PORT}/health`);
  console.log(`✓ WebSocket:   ws://localhost:${PORT}`);
  console.log(`✓ Auth:        API key required`);
  console.log('✓ Waiting for connections...');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[WebSocket] SIGTERM received, closing server...');
  wss.close(() => {
    server.close(() => {
      console.log('[WebSocket] Server closed gracefully');
      process.exit(0);
    });
  });
});

// Heartbeat to keep Railway from sleeping (optional)
setInterval(() => {
  const activeConnections = Array.from(clients.values()).filter(
    c => c.ws.readyState === WebSocket.OPEN
  ).length;
  
  if (activeConnections > 0) {
    console.log(`[${new Date().toISOString()}] Heartbeat: ${activeConnections} active connections`);
  }
}, 60000); // Every 60 seconds
