/**
 * Sales360 SmartCore Server
 * WebSocket + Twilio Integration + ElevenLabs Voice Cloning + Zoho CRM
 * ADR-002 Week 2 — Realtime Pipeline
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { parse } = require('url');

const StorageService = require('./storage-service');
const { setupAudioRoutes, startCleanupTask } = require('./audio-routes-FALLBACK');

const app = express();
const server = http.createServer(app);

// Dashboard WebSocket — noServer:true
const wss = new WebSocket.Server({ noServer: true });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const storageService = new StorageService();
setupAudioRoutes(app, storageService);
startCleanupTask(storageService);

const API_KEY = process.env.WEBSOCKET_API_KEY || '348bfe2c06cfb611c6240a83b8b850f4683908d2eb05d450b01b5a760c3c3dee';
const clients = new Set();

wss.on('connection', function(ws, req) {
  console.log('[WebSocket] New connection attempt');

  ws.on('message', function(message) {
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

  ws.on('close', function() {
    clients.delete(ws);
    console.log('[WebSocket] Client disconnected. Total clients:', clients.size);
  });

  ws.on('error', function(error) {
    console.error('[WebSocket] WebSocket error:', error);
    clients.delete(ws);
  });
});

function broadcast(data) {
  const message = JSON.stringify(data);
  let successCount = 0;
  clients.forEach(function(client) {
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

// ElevenLabs
const ElevenLabsService = require('./elevenlabs-dynamic-service');
const elevenLabsService = new ElevenLabsService();
console.log('[ElevenLabs] Service initialized');

// Zoho
const ZohoService = require('./zoho-service');
const zohoService = new ZohoService();

// Twilio
const TwilioService = require('./twilio-service');
const twilioService = new TwilioService(elevenLabsService, zohoService);
console.log('[Twilio Service] Using ElevenLabs for voice synthesis');

// Call routes
const setupCallRoutes = require('./call-routes');
const callRoutes = setupCallRoutes(wsServer, twilioService, elevenLabsService);
app.use(callRoutes);
console.log('[Setup] Call routes mounted with ElevenLabs voice');

// Zoho endpoints
app.get('/api/zoho/test', async function(req, res) {
  if (!zohoService.isEnabled()) {
    return res.status(503).json({ success: false, zoho_enabled: false, message: 'Zoho CRM integration is disabled' });
  }
  try {
    const token = await zohoService.getAccessToken();
    res.json({ success: true, zoho_enabled: true, token_acquired: !!token, message: 'Zoho CRM integration active' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/zoho/lead/:leadId', async function(req, res) {
  try {
    const { leadId } = req.params;
    const leadData = await zohoService.fetchLeadForCall(leadId);
    if (!leadData) return res.status(404).json({ success: false, error: 'Lead not found' });
    res.json({ success: true, lead: leadData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/zoho/update-score', async function(req, res) {
  try {
    const { leadId, score, signal, signalType } = req.body;
    if (!leadId || score === undefined) return res.status(400).json({ success: false, error: 'Missing leadId or score' });
    const success = await zohoService.updateIntentScore(leadId, score, signal, signalType);
    res.json({ success: success, message: success ? 'IntentScore updated' : 'Update failed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', function(req, res) {
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

app.get('/', function(req, res) {
  res.json({
    service: 'Sales360 SmartCore',
    version: '2.2.0-realtime',
    features: ['WebSocket Real-time Sync', 'Twilio Phone Integration', 'ElevenLabs Voice Cloning', 'Zoho CRM Integration', 'ADR-002 Realtime Pipeline']
  });
});

const PORT = process.env.PORT || 8080;

// ADR-002 Week 2 — attach realtime routes
const { attachMediaStreamRoutes, mediaWss, activeSessions } = require('./src/realtime/media-stream-routes');
const { Sales360MasterPromptV2 } = require('./SALES360-MASTER-PROMPT-V2');

// ─── Per-call session store ────────────────────────────────────────────────
// Maps callSid → { systemPrompt, openingLine, leadData }
// Set BEFORE Twilio connects the WebSocket so the handler picks it up
var callSessionStore = {};

// ─── Default lead data for /twilio/media-test ─────────────────────────────
var defaultLeadData = {
  name:        'there',
  region:      'nigeria',
  brokerName:  'Sales360',
  intentScore: 0,
  source:      'inbound enquiry',
  product:     null,
  experience:  null,
  pain:        null,
  capital:     null,
  lastAction:  null
};

// Default prompt for test calls
var DEFAULT_SYSTEM_PROMPT = process.env.REALTIME_SYSTEM_PROMPT ||
  Sales360MasterPromptV2.buildPrompt(defaultLeadData);

var DEFAULT_OPENING = process.env.REALTIME_OPENING ||
  'Hello, this is Sales360 calling. Is this a good time for a quick 2-minute conversation?';

// ─── /twilio/media-live — Zoho-enriched production endpoint ───────────────
// Called by Twilio when a lead call starts (via Zoho Deluge or manual trigger)
// Expects ?leadId=XXX in query string
app.post('/twilio/media-live', async function(req, res) {
  var host   = req.headers.host || 'localhost';
  var wsUrl  = 'wss://' + host + '/twilio/media';
  var leadId = req.query.leadId || req.body.leadId || null;
  var callSid = req.body.CallSid || null;

  console.log('[MediaLive] Incoming call — CallSid=' + callSid + ' leadId=' + leadId);

  var systemPrompt = DEFAULT_SYSTEM_PROMPT;
  var openingLine  = DEFAULT_OPENING;
  var leadData     = defaultLeadData;

  // Enrich from Zoho if leadId provided
  if (leadId && zohoService.isEnabled()) {
    try {
      console.log('[MediaLive] Enriching lead from Zoho: ' + leadId);
      var enriched = await zohoService.enrichLeadBeforeCall(leadId);

      if (enriched) {
        // Map Zoho lead data to prompt format
        leadData = {
          name:        enriched.fullName ? enriched.fullName.split(' ')[0] : 'there',
          region:      _mapRegion(enriched.country),
          brokerName:  enriched.company || 'Sales360',
          intentScore: enriched.intentScore || 0,
          source:      enriched.leadSource || 'inbound enquiry',
          product:     enriched.interestedServices || null,
          experience:  null,
          pain:        enriched.currentChallenges || null,
          capital:     null,
          lastAction:  enriched.lastOutcome || null,
          industry:    enriched.industryType || null,
          leadType:    enriched.leadType || 'B2B',
        };

        systemPrompt = Sales360MasterPromptV2.buildPrompt(leadData);

        // Personalise opening with prospect's first name
        var firstName = leadData.name !== 'there' ? ', ' + leadData.name : '';
        openingLine = 'Hello' + firstName + ', this is Sales360 calling. Is this a good time for a quick 2-minute conversation?';

        console.log('[MediaLive] Prompt built for: ' + enriched.fullName + ' | Region: ' + leadData.region + ' | Score: ' + leadData.intentScore);
      } else {
        console.warn('[MediaLive] Zoho enrichment returned null — using defaults');
      }
    } catch (err) {
      console.error('[MediaLive] Zoho enrichment error:', err.message, '— using defaults');
    }
  } else {
    console.log('[MediaLive] No leadId or Zoho disabled — using default prompt');
  }

  // Store session data keyed by CallSid for the WebSocket handler
  if (callSid) {
    callSessionStore[callSid] = { systemPrompt, openingLine, leadData, leadId };
    // Clean up after 5 minutes
    setTimeout(function() { delete callSessionStore[callSid]; }, 300000);
  }

  // Return TwiML
  var twiml = '<?xml version="1.0" encoding="UTF-8"?>';
  twiml += '<Response>';
  twiml += '<Connect>';
  twiml += '<Stream url="' + wsUrl + '" />';
  twiml += '</Connect>';
  twiml += '</Response>';
  res.type('text/xml').send(twiml);
});

// ─── GET version for browser testing ──────────────────────────────────────
app.get('/twilio/media-live', async function(req, res) {
  var host   = req.headers.host || 'localhost';
  var wsUrl  = 'wss://' + host + '/twilio/media';
  var twiml  = '<?xml version="1.0" encoding="UTF-8"?>';
  twiml += '<Response>';
  twiml += '<Connect>';
  twiml += '<Stream url="' + wsUrl + '" />';
  twiml += '</Connect>';
  twiml += '</Response>';
  res.type('text/xml').send(twiml);
});

// ─── Helper: map country string to region key ──────────────────────────────
function _mapRegion(country) {
  if (!country) return 'nigeria';
  var c = country.toLowerCase();
  if (c.includes('nigeria'))                      return 'nigeria';
  if (c.includes('united kingdom') || c === 'uk') return 'uk';
  if (c.includes('united arab') || c.includes('dubai') || c.includes('uae')) return 'uae';
  if (c.includes('ghana'))                        return 'ghana';
  if (c.includes('kenya'))                        return 'kenya';
  if (c.includes('south africa'))                 return 'south_africa';
  return 'nigeria';  // default
}

// ─── Export session store so media-stream-routes can read it ──────────────
global.callSessionStore = callSessionStore;

attachMediaStreamRoutes(server, app, {
  echoMode:     false,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  openingLine:  DEFAULT_OPENING,
  sessionStore: callSessionStore,
});

// SINGLE upgrade handler — routes to correct WSS based on path
server.on('upgrade', function(request, socket, head) {
  var pathname = parse(request.url).pathname;
  if (pathname === '/twilio/media') {
    // Media stream — handled by mediaWss
    mediaWss.handleUpgrade(request, socket, head, function(ws) {
      mediaWss.emit('connection', ws, request);
    });
  } else {
    // Dashboard WebSocket
    wss.handleUpgrade(request, socket, head, function(ws) {
      wss.emit('connection', ws, request);
    });
  }
});

server.listen(PORT, function() {
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
