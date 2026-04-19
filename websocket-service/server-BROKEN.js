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

// ═══════════════════════════════════════════════════════════
// WEBSOCKET SERVER (Dashboard Real-time Sync)
// ═══════════════════════════════════════════════════════════

const API_KEY = process.env.WEBSOCKET_API_KEY || '348bfe2c06cfb611c6240a83b8b850f4683908d2eb05d450b01b5a760c3c3dee';
const clients = new Set();

wss.on('connection', (ws, req) => {
  console.log('[WebSocket] New connection attempt');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // API Key authentication
      if (data.type === 'auth') {
        if (data.apiKey === API_KEY) {
          ws.authenticated = true;
          clients.add(ws);
          ws.send(JSON.stringify({ type: 'auth', status: 'success' }));
          console.log('[WebSocket] Client authenticated. Total clients:', clients.size);
        } else {
          ws.send(JSON.stringify({ type: 'auth', status: 'failed', error: 'Invalid API key' }));
          ws.close();
        }
        return;
      }

      // Only process messages from authenticated clients
      if (!ws.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      // Handle ping/pong
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }

      // Broadcast events to all clients (Demo → Dashboard sync)
      broadcast(data);
      
    } catch (error) {
      console.error('[WebSocket] Error processing message:', error);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('[WebSocket] Client disconnected. Total clients:', clients.size);
  });

  ws.on('error', (error) => {
    console.error('[WebSocket] WebSocket error:', error);
    clients.delete(ws);
  });
});

// Broadcast function - send to all authenticated clients
function broadcast(data) {
  const message = JSON.stringify(data);
  let successCount = 0;
  
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.authenticated) {
      try {
        client.send(message);
        successCount++;
      } catch (error) {
        console.error('[WebSocket] Error sending to client:', error);
      }
    }
  });
  
  console.log(`[WebSocket] Broadcast: ${data.type} → ${successCount} clients`);
}

// Expose broadcast to Twilio service
const wsServer = {
  broadcast: broadcast,
  clients: clients
};

// ═══════════════════════════════════════════════════════════
// TWILIO PHONE INTEGRATION
// ═══════════════════════════════════════════════════════════

const setupCallRoutes = require('./call-routes');
const callRoutes = setupCallRoutes(wsServer);

// Mount Twilio routes
app.use('/api', callRoutes);
app.use('/twilio', callRoutes);

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    websocket: {
      active: true,
      clients: clients.size
    },
    twilio: {
      active: true,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER || 'not configured'
    }
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Sales360 SmartCore',
    version: '2.0.0',
    features: ['WebSocket Real-time Sync', 'Twilio Phone Integration'],
    endpoints: {
      websocket: 'wss://<host>',
      health: '/health',
      call: {
        make: 'POST /api/call/make',
        end: 'POST /api/call/end/:callSid',
        active: 'GET /api/call/active',
        details: 'GET /api/call/:callSid'
      },
      webhooks: {
        voice: 'POST /twilio/voice',
        gather: 'POST /twilio/gather',
        status: 'POST /twilio/status',
        recording: 'POST /twilio/recording'
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║   SALES360 SMARTCORE - REAL-TIME ENGINE               ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');
  console.log('[SmartCore] Server started successfully');
  console.log('[SmartCore] Port:', PORT);
  console.log('[SmartCore] WebSocket endpoint ready');
  console.log('[SmartCore] Twilio integration ready');
  console.log('[SmartCore] Health check: /health\n');
  
  // Log Twilio status
  if (process.env.TWILIO_PHONE_NUMBER) {
    console.log('[Twilio Service] Initialized with number:', process.env.TWILIO_PHONE_NUMBER);
    console.log('Twilio: Active ✓\n');
  } else {
    console.log('[Twilio Service] WARNING: TWILIO_PHONE_NUMBER not configured');
    console.log('Twilio: Inactive ✗\n');
  }
});
