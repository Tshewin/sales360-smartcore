// ═══════════════════════════════════════════════════════════
// SALES360 CALL API ROUTES - WITH REAL AI CONVERSATION + ELEVENLABS
// ═══════════════════════════════════════════════════════════

const express = require('express');

function setupCallRoutes(wsServer, twilioService, elevenLabsService) {
  const router = express.Router();

  // Validate that services were passed correctly
  if (!twilioService) {
    console.error('[Call Routes] ERROR: twilioService not provided!');
    throw new Error('TwilioService is required');
  }

  if (!elevenLabsService) {
    console.log('[Call Routes] WARNING: elevenLabsService not provided, voice synthesis may fall back to AWS Polly');
  } else {
    console.log('[Call Routes] ✅ ElevenLabs service connected');
  }

  // ═══════════════════════════════════════════════════════════
  // API ROUTES
  // ═══════════════════════════════════════════════════════════

  // Make outbound call
  router.post('/api/call/make', async (req, res) => {
    try {
      const { to, prospectName, region, scenario } = req.body;

      if (!to || !prospectName) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, prospectName'
        });
      }

      const result = await twilioService.makeCall({
        to,
        prospectName: prospectName || 'there',
        region: region || 'UK',
        scenario: scenario || 'broker'
      });

      res.json(result);
    } catch (error) {
      console.error('[Call API] Error in /call/make:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // End call
  router.post('/api/call/end/:callSid', async (req, res) => {
    try {
      const { callSid } = req.params;
      const result = await twilioService.endCall(callSid);
      res.json(result);
    } catch (error) {
      console.error('[Call API] Error in /call/end:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Get active calls
  router.get('/api/call/active', (req, res) => {
    try {
      const calls = twilioService.getActiveCalls();
      res.json({ success: true, calls });
    } catch (error) {
      console.error('[Call API] Error in /call/active:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Get call details
  router.get('/api/call/:callSid', (req, res) => {
    try {
      const { callSid } = req.params;
      const call = twilioService.getCallDetails(callSid);
      
      if (!call) {
        return res.status(404).json({
          success: false,
          error: 'Call not found'
        });
      }

      res.json({ success: true, call });
    } catch (error) {
      console.error('[Call API] Error in /call/:callSid:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // TWILIO WEBHOOKS
  // ═══════════════════════════════════════════════════════════

  // Voice webhook - Initial call connection
  router.post('/twilio/voice', async (req, res) => {
    try {
      const { prospectName, region, scenario, CallSid } = req.query;
      
      console.log('[Twilio Webhook] Voice - Call connected:', CallSid);
      
      const twiml = await twilioService.generateGreetingTwiML(
        prospectName || 'there',
        region || 'UK',
        scenario || 'broker'
      );
      
      res.type('text/xml');
      res.send(twiml);
    } catch (error) {
      console.error('[Twilio Webhook] Error in /twilio/voice:', error);
      res.status(500).send('Error processing voice webhook');
    }
  });

  // Gather webhook - Process user speech and generate AI response
  router.post('/twilio/gather', async (req, res) => {
    try {
      const { SpeechResult, CallSid } = req.body;
      
      if (!SpeechResult || SpeechResult.trim() === '') {
        console.log('[Twilio Webhook] Gather - No speech detected');
        
        // Prompt user to speak
        const VoiceResponse = require('twilio').twiml.VoiceResponse;
        const twiml = new VoiceResponse();
        
        twiml.say({
          voice: 'Polly.Matthew',
          language: 'en-GB'
        }, "I didn't catch that. Could you please repeat?");
        
        const gather = twiml.gather({
          input: 'speech',
          action: `${process.env.WEBHOOK_BASE_URL}/twilio/gather`,
          method: 'POST',
          speechTimeout: 'auto',
          speechModel: 'phone_call',
          enhanced: true,
          language: 'en-GB'
        });
        
        gather.pause({ length: 1 });
        
        res.type('text/xml');
        res.send(twiml.toString());
        return;
      }

      console.log('[Twilio Webhook] Gather - Processing speech from call:', CallSid);
      
      // Generate AI response with real Claude conversation
      const twiml = await twilioService.processUserResponse(CallSid, SpeechResult, wsServer);
      
      res.type('text/xml');
      res.send(twiml);
    } catch (error) {
      console.error('[Twilio Webhook] Error in /twilio/gather:', error);
      res.status(500).send('Error processing gather webhook');
    }
  });

  // Status webhook - Track call status
  router.post('/twilio/status', (req, res) => {
    try {
      const { CallSid, CallStatus } = req.body;
      
      twilioService.handleStatusUpdate(CallSid, CallStatus, req.body);
      
      // Broadcast call status to Dashboard
      if (wsServer) {
        wsServer.broadcast({
          type: 'callState',
          state: CallStatus,
          callSid: CallSid,
          timestamp: new Date().toISOString()
        });
      }
      
      res.sendStatus(200);
    } catch (error) {
      console.error('[Twilio Webhook] Error in /twilio/status:', error);
      res.status(500).send('Error processing status webhook');
    }
  });

  // Recording webhook - Handle call recordings
  router.post('/twilio/recording', (req, res) => {
    try {
      const { CallSid, RecordingUrl, RecordingSid } = req.body;
      
      twilioService.handleRecording(CallSid, RecordingUrl, RecordingSid);
      
      res.sendStatus(200);
    } catch (error) {
      console.error('[Twilio Webhook] Error in /twilio/recording:', error);
      res.status(500).send('Error processing recording webhook');
    }
  });

  return router;
}

module.exports = setupCallRoutes;
