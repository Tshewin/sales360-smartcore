/**
 * Sales360 - Twilio Call Routes
 * API endpoints for call management and Twilio webhooks
 */

const express = require('express');
const router = express.Router();
const twilioService = require('./twilio-service');

// Base URL for webhooks (set from environment or detect from request)
const getWebhookBaseUrl = (req) => {
  return process.env.WEBHOOK_BASE_URL || `${req.protocol}://${req.get('host')}`;
};

/**
 * POST /api/call/make
 * Initiate outbound call from Dashboard
 * 
 * Body: {
 *   to: "+1234567890",
 *   prospectName: "John Doe",
 *   region: "US",
 *   scenario: "broker"
 * }
 */
router.post('/make', async (req, res) => {
  try {
    const { to, prospectName, region, scenario } = req.body;
    
    if (!to) {
      return res.status(400).json({ error: 'Phone number (to) is required' });
    }
    
    const webhookBaseUrl = getWebhookBaseUrl(req);
    
    const result = await twilioService.makeCall(to, {
      prospectName,
      region,
      scenario
    }, webhookBaseUrl);
    
    res.json(result);
    
  } catch (error) {
    console.error('[Call API] Error making call:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/call/end/:callSid
 * End active call
 */
router.post('/end/:callSid', async (req, res) => {
  try {
    const { callSid } = req.params;
    const result = await twilioService.endCall(callSid);
    res.json(result);
  } catch (error) {
    console.error('[Call API] Error ending call:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/call/active
 * Get all active calls
 */
router.get('/active', (req, res) => {
  try {
    const activeCalls = twilioService.getAllActiveCalls();
    res.json({ calls: activeCalls });
  } catch (error) {
    console.error('[Call API] Error fetching active calls:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/call/:callSid
 * Get specific call data
 */
router.get('/:callSid', (req, res) => {
  try {
    const { callSid } = req.params;
    const callData = twilioService.getCallData(callSid);
    
    if (!callData) {
      return res.status(404).json({ error: 'Call not found' });
    }
    
    res.json(callData);
  } catch (error) {
    console.error('[Call API] Error fetching call:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════
// TWILIO WEBHOOKS (called by Twilio, not by Dashboard)
// ═══════════════════════════════════════════════════

/**
 * POST /twilio/voice
 * Called when call connects - return TwiML greeting
 */
router.post('/voice', (req, res) => {
  try {
    const callSid = req.body.CallSid;
    console.log('[Twilio Webhook] Voice - Call connected:', callSid);
    
    const twiml = twilioService.generateGreetingTwiML(callSid);
    
    res.type('text/xml');
    res.send(twiml);
    
  } catch (error) {
    console.error('[Twilio Webhook] Error in voice:', error);
    res.type('text/xml');
    res.send(twilioService.generateErrorTwiML());
  }
});

/**
 * POST /twilio/gather
 * Called when user speaks - process response and continue conversation
 */
router.post('/gather', async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const speechResult = req.body.SpeechResult || '';
    
    console.log('[Twilio Webhook] Gather - User said:', speechResult);
    
    const twiml = await twilioService.processUserResponse(callSid, speechResult);
    
    res.type('text/xml');
    res.send(twiml);
    
  } catch (error) {
    console.error('[Twilio Webhook] Error in gather:', error);
    res.type('text/xml');
    res.send(twilioService.generateErrorTwiML());
  }
});

/**
 * POST /twilio/status
 * Called on call status changes (initiated, ringing, answered, completed)
 */
router.post('/status', (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const status = req.body.CallStatus;
    
    const result = twilioService.handleStatusUpdate(callSid, status, req.body);
    
    // TODO: Broadcast to WebSocket Dashboard
    console.log('[Twilio Webhook] Status update:', result);
    
    res.sendStatus(200);
    
  } catch (error) {
    console.error('[Twilio Webhook] Error in status:', error);
    res.sendStatus(500);
  }
});

/**
 * POST /twilio/recording
 * Called when call recording is available
 */
router.post('/recording', (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const recordingUrl = req.body.RecordingUrl;
    const recordingSid = req.body.RecordingSid;
    
    twilioService.handleRecording(callSid, recordingUrl, recordingSid);
    
    console.log('[Twilio Webhook] Recording available:', recordingUrl);
    
    res.sendStatus(200);
    
  } catch (error) {
    console.error('[Twilio Webhook] Error in recording:', error);
    res.sendStatus(500);
  }
});

module.exports = router;
