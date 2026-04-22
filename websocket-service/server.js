/**
 * Sales360 SmartCore Server
 * WebSocket + Twilio Integration + ElevenLabs Voice Cloning
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const API_KEY = process.env.WEBSOCKET_API_KEY || '348bfe2c06cfb611c6240a83b8b850f4683908d2eb05d450b01b5a760c3c3dee';
const clients = new Set();

wss.on('connection', (ws, req) => {
  console.log('[WebSocket] New connection attempt');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

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

      if (!ws.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }

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
  
  console.log(`[WebSocket] Broadcast: ${data.type} to ${successCount} clients`);
}

const wsServer = {
  broadcast: broadcast,
  clients: clients
};

// ══════════════════════════════════════════════════════════
// PHASE 2A: ELEVENLABS VOICE CLONING INTEGRATION
// ══════════════════════════════════════════════════════════

// Initialize ElevenLabs service FIRST
const ElevenLabsService = require('./elevenlabs-dynamic-service');
const elevenLabsService = new ElevenLabsService();

console.log('[ElevenLabs] ✅ Service initialized');
console.log(`[ElevenLabs] Default voice (Chuks): ${process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'lJd1hi6nFFWkrcDH9i3a'}`);
console.log(`[ElevenLabs] Audio storage: ${process.env.AUDIO_STORAGE_PROVIDER || 'datauri'}`);

// Initialize Twilio service with ElevenLabs
const TwilioService = require('./twilio-service');
const twilioService = new TwilioService(elevenLabsService);

console.log('[Twilio Service] Using ElevenLabs for voice synthesis');

// Load call routes with updated services
const setupCallRoutes = require('./call-routes');
const callRoutes = setupCallRoutes(wsServer, twilioService, elevenLabsService);

app.use(callRoutes);

console.log('[Setup] Call routes mounted with ElevenLabs voice');

// ══════════════════════════════════════════════════════════

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
    },
    elevenlabs: {
      active: !!process.env.ELEVENLABS_API_KEY,
      voiceId: process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'lJd1hi6nFFWkrcDH9i3a',
      storageProvider: process.env.AUDIO_STORAGE_PROVIDER || 'datauri'
    },
    storage: {
      provider: process.env.AUDIO_STORAGE_PROVIDER || 'not set',
      r2AccountId: process.env.R2_ACCOUNT_ID ? 'set' : 'NOT SET',
      r2AccessKey: process.env.R2_ACCESS_KEY_ID ? 'set' : 'NOT SET',
      r2SecretKey: process.env.R2_SECRET_ACCESS_KEY ? 'set' : 'NOT SET',
      r2BucketName: process.env.R2_BUCKET_NAME || 'not set',
      r2PublicUrl: process.env.R2_PUBLIC_URL || 'not set'
    }
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Sales360 SmartCore',
    version: '2.1.0-elevenlabs',
    features: [
      'WebSocket Real-time Sync', 
      'Twilio Phone Integration',
      'ElevenLabs Voice Cloning (Chuks)'
    ],
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

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log('\n========================================');
  console.log('  SALES360 SMARTCORE - REAL-TIME ENGINE');
  console.log('========================================\n');
  console.log('[SmartCore] Server started successfully');
  console.log('[SmartCore] Port:', PORT);
  console.log('[SmartCore] WebSocket endpoint ready');
  console.log('[SmartCore] Twilio integration ready');
  console.log('[SmartCore] Health check: /health\n');
  
  if (process.env.TWILIO_PHONE_NUMBER) {
    console.log('[Twilio Service] Initialized with number:', process.env.TWILIO_PHONE_NUMBER);
    console.log('Twilio: Active\n');
  } else {
    console.log('[Twilio Service] WARNING: TWILIO_PHONE_NUMBER not configured');
    console.log('Twilio: Inactive\n');
  }
});
