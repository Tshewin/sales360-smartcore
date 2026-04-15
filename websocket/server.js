// SmartCore WebSocket Server
// Railway deployment with API key authentication
// Handles real-time events: IntentScore, HotLead, CallState, Transcript

const WebSocket = require('ws');
const http = require('http');

// Environment variables
const PORT = process.env.PORT || 8080;
const WS_API_KEY = process.env.WS_API_KEY || 'sales360-demo-key-2026'; // Change in production

// Create HTTP server for health checks
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'healthy', 
      connections: wss.clients.size,
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Client tracking
const clients = new Map(); // Track clients with metadata

// Connection handler
wss.on('connection', (ws, req) => {
  const clientId = generateClientId();
  
  console.log(`[WebSocket] New connection attempt - ID: ${clientId}`);

  // Wait for authentication message
  let authenticated = false;
  let authTimeout = setTimeout(() => {
    if (!authenticated) {
      console.log(`[WebSocket] Auth timeout for ${clientId}`);
      ws.close(4001, 'Authentication timeout');
    }
  }, 10000); // 10 second auth window

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
            clientType: data.clientType || 'unknown', // 'demo' or 'dashboard'
            connectedAt: new Date().toISOString()
          });

          // Send auth success
          ws.send(JSON.stringify({
            type: 'authSuccess',
            clientId,
            message: 'WebSocket authenticated successfully'
          }));

          console.log(`[WebSocket] Client authenticated - ID: ${clientId}, Type: ${data.clientType}`);
          
          // Broadcast connection event to other clients
          broadcast({
            type: 'clientConnected',
            clientId,
            clientType: data.clientType,
            timestamp: new Date().toISOString()
          }, clientId);

        } else {
          ws.close(4003, 'Invalid API key');
          console.log(`[WebSocket] Auth failed for ${clientId}`);
        }
        return;
      }

      // Handle events from authenticated clients
      handleEvent(data, clientId);

    } catch (error) {
      console.error(`[WebSocket] Message parse error:`, error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    const client = clients.get(clientId);
    if (client) {
      console.log(`[WebSocket] Client disconnected - ID: ${clientId}, Type: ${client.clientType}`);
      clients.delete(clientId);
      
      // Broadcast disconnection
      broadcast({
        type: 'clientDisconnected',
        clientId,
        timestamp: new Date().toISOString()
      }, clientId);
    }
  });

  ws.on('error', (error) => {
    console.error(`[WebSocket] Error for ${clientId}:`, error);
  });
});

// Event handler
function handleEvent(data, senderId) {
  const { type, event, payload } = data;

  if (type !== 'event') return;

  console.log(`[WebSocket] Event received - Type: ${event}, From: ${senderId}`);

  // Validate event types
  const validEvents = ['intentScore', 'hotLead', 'callState', 'transcript'];
  if (!validEvents.includes(event)) {
    console.warn(`[WebSocket] Unknown event type: ${event}`);
    return;
  }

  // Broadcast event to all clients except sender
  broadcast({
    type: 'event',
    event,
    payload,
    timestamp: new Date().toISOString(),
    source: senderId
  }, senderId);
}

// Broadcast function (excludes sender)
function broadcast(message, excludeClientId = null) {
  const messageStr = JSON.stringify(message);
  let broadcastCount = 0;

  clients.forEach((client, clientId) => {
    if (clientId !== excludeClientId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(messageStr);
      broadcastCount++;
    }
  });

  console.log(`[WebSocket] Broadcasted ${message.type || message.event} to ${broadcastCount} clients`);
}

// Utility: Generate unique client ID
function generateClientId() {
  return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Start server
server.listen(PORT, () => {
  console.log(`╔════════════════════════════════════════════╗`);
  console.log(`║   Sales360 SmartCore WebSocket Server     ║`);
  console.log(`╚════════════════════════════════════════════╝`);
  console.log(`✓ HTTP Health Check: http://localhost:${PORT}/health`);
  console.log(`✓ WebSocket Server:  ws://localhost:${PORT}`);
  console.log(`✓ Auth Key Required: ${WS_API_KEY.substring(0, 10)}...`);
  console.log(`✓ Waiting for connections...`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[WebSocket] SIGTERM received, closing server...');
  wss.close(() => {
    server.close(() => {
      console.log('[WebSocket] Server closed');
      process.exit(0);
    });
  });
});
