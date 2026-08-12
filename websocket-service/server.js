/**
 * Sales360 SmartCore Server
 * WebSocket + Twilio Integration + ElevenLabs Voice Cloning + Zoho CRM
 * ADR-002 Week 2 — Realtime Pipeline
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

// IMPORT STORAGE SERVICE FIRST
const StorageService = require('./storage-service');

// IMPORT AUDIO ROUTES
const { setupAudioRoutes, startCleanupTask } = require('./audio-routes-FALLBACK');

const app = express();
const server = http.createServer(app);

// Dashboard WebSocket — noServer:true so it does NOT auto-grab all upgrades
const wss = new WebSocket.Server({ noServer: true });

// Manual upgrade handler — skips /twilio/media (handled by prependListener below)
server.on('upgrade', function(request, socket, head) {
  var parsedUrl = require('url').parse(request.url);
  if (parsedUrl.pathname !== '/twilio/media') {
    wss.handleUpgrade(request, socket, head, function(ws) {
      wss.emit('connection', ws, request);
    });
  }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CREATE STORAGE SERVICE
const storageService = new StorageService();

// SETUP AUDIO ROUTES
setupAudioRoutes(app, storageService);

// START CLEANUP TASK
startCleanupTask(storageService);

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
  console.log('[WebSocket] Broadcast: ' + data.type + ' to ' + successCount + ' clients');
}

const wsServer = { broadcast: broadcast, clients: clients };

// ELEVENLABS
const ElevenLabsService = require('./elevenlabs-dynamic-service');
const elevenLabsService = new ElevenLabsService();
console.log('[ElevenLabs] Service initialized');
console.log('[ElevenLabs] Default voice (Chuks): ' + (process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'lJd1hi6nFFWkrcDH9i3a'));
console.log('[ElevenLabs] Audio storage: ' + (process.env.AUDIO_STORAGE_PROVIDER || 'datauri'));

// ZOHO
const ZohoService = require('./zoho-service');
const zohoService = new ZohoService();

// TWILIO
const TwilioService = require('./twilio-service');
const twilioService = new TwilioService(elevenLabsService, zohoService);
console.log('[Twilio Service] Using ElevenLabs for voice synthesis');

// CALL ROUTES
const setupCallRoutes = require('./call-routes');
const callRoutes = setupCallRoutes(wsServer, twilioService, elevenLabsService);
app.use(callRoutes);
console.log('[Setup] Call routes mounted with ElevenLabs voice');

// ZOHO ENDPOINTS
app.get('/api/zoho/test', async (req, res) => {
  if (!zohoService.isEnabled()) {
    return res.status(503).json({ success: false, zoho_enabled: false, message: 'Zoho CRM integration is disabled (missing credentials)' });
  }
  try {
    const token = await zohoService.getAccessToken();
    res.json({ success: true, zoho_enabled: true, token_acquired: !!token, message: 'Zoho CRM integration active' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/zoho/lead/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const leadData = await zohoService.fetchLeadForCall(leadId);
    if (!leadData) return res.status(404).json({ success: false, error: 'Lead not found or Zoho integration disabled' });
    res.json({ success: true, lead: leadData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/zoho/update-score', async (req, res) => {
  try {
    const { leadId, score, signal, signalType } = req.body;
    if (!leadId || score === undefined) return res.status(400).json({ success: false, error: 'Missing required fields: leadId, score' });
    const success = await zohoService.updateIntentScore(leadId, score, signal, signalType);
    res.json({ success, message: success ? 'IntentScore updated in Zoho' : 'Update failed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// HEALTH
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    websocket: { active: true, clients: clients.size },
    twilio: { active: true, phoneNumber: process.env.TWILIO_PHONE_NUMBER || 'not configured' },
    elevenlabs: { active: !!process.env.ELEVENLABS_API_KEY, voiceId: process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'lJd1hi6nFFWkrcDH9i3a', storageProvider: process.env.AUDIO_STORAGE_PROVIDER || 'datauri' },
    zoho: { active: zohoService.isEnabled(), apiDomain: process.env.ZOHO_API_DOMAIN || 'not set' },
    storage: { provider: process.env.AUDIO_STORAGE_PROVIDER || 'not set', r2AccountId: process.env.R2_ACCOUNT_ID ? 'set' : 'NOT SET', r2AccessKey: process.env.R2_ACCESS_KEY_ID ? 'set' : 'NOT SET', r2SecretKey: process.env.R2_SECRET_ACCESS_KEY ? 'set' : 'NOT SET', r2BucketName: process.env.R2_BUCKET_NAME || 'not set', r2PublicUrl: process.env.R2_PUBLIC_URL || 'not set' }
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Sales360 SmartCore',
    version: '2.2.0-realtime',
    features: ['WebSocket Real-time Sync', 'Twilio Phone Integration', 'ElevenLabs Voice Cloning (Chuks)', 'Zoho CRM Integration', 'ADR-002 Realtime Pipeline'],
    endpoints: {
      websocket: 'wss://<host>',
      health: '/health',
      call: { make: 'POST /api/call/make', end: 'POST /api/call/end/:callSid', active: 'GET /api/call/active', details: 'GET /api/call/:callSid' },
      webhooks: { voice: 'POST /twilio/voice', gather: 'POST /twilio/gather', status: 'POST /twilio/status', recording: 'POST /twilio/recording' },
      zoho: { test: 'GET /api/zoho/test', fetchLead: 'GET /api/zoho/lead/:leadId', updateScore: 'POST /api/zoho/update-score' },
      realtime: { stream: 'WS /twilio/media', test: 'POST /twilio/media-test', status: 'GET /twilio/media-status' }
    }
  });
});

const PORT = process.env.PORT || 8080;

// ADR-002 WEEK 2 — attach BEFORE server.listen
const { attachMediaStreamRoutes } = require('./src/realtime/media-stream-routes');

var REALTIME_SYSTEM_PROMPT = process.env.REALTIME_SYSTEM_PROMPT || 'You are Sales360 AI, the world\'s most intelligent sales agent. You are on a live phone call. Keep responses to 2-3 SHORT sentences. Be warm, direct, conversational. Never mention you are an AI unless asked. Qualify the prospect and book a meeting.';

var REALTIME_OPENING = process.env.REALTIME_OPENING || 'Good afternoon, this is Sales360 AI calling. Do you have a couple of minutes?';

attachMediaStreamRoutes(server, app, {
  echoMode: false,
  systemPrompt: REALTIME_SYSTEM_PROMPT,
  openingLine: REALTIME_OPENING,
});

server.listen(PORT, () => {
  console.log('\n========================================');
  console.log('  SALES360 SMARTCORE - REAL-TIME ENGINE');
  console.log('========================================\n');
  console.log('[SmartCore] Server started successfully');
  console.log('[SmartCore] Port:', PORT);
  console.log('[SmartCore] WebSocket endpoint ready');
  console.log('[SmartCore] Twilio integration ready');
  console.log('[SmartCore] Zoho CRM:', zohoService.isEnabled() ? 'Connected' : 'Disabled');
  console.log('[SmartCore] Health check: /health\n');
  if (process.env.TWILIO_PHONE_NUMBER) {
    console.log('[Twilio Service] Initialized with number:', process.env.TWILIO_PHONE_NUMBER);
    console.log('Twilio: Active\n');
  } else {
    console.log('[Twilio Service] WARNING: TWILIO_PHONE_NUMBER not configured');
    console.log('Twilio: Inactive\n');
  }
});
