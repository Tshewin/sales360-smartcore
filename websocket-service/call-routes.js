// ═══════════════════════════════════════════════════════════
// SALES360 CALL API ROUTES - WITH REAL AI CONVERSATION + ELEVENLABS
// + DYNAMIC TRADER PROFILING (Phase 3A)
// + AUTO-CALL PIPELINE (Phase 3D) — CRM → Instant AI Call
// ═══════════════════════════════════════════════════════════

const express = require('express');

// ═══════════════════════════════════════════════════════════
// BUSINESS HOURS CONFIG
// ═══════════════════════════════════════════════════════════
const BUSINESS_HOURS = {
  Nigeria:      { start: 9, end: 18, timezone: 'Africa/Lagos' },
  UK:           { start: 9, end: 18, timezone: 'Europe/London' },
  Dubai:        { start: 9, end: 18, timezone: 'Asia/Dubai' },
  'South Africa': { start: 9, end: 18, timezone: 'Africa/Johannesburg' },
};

// IntentScore thresholds per region — below this, don't auto-call
const CALL_THRESHOLDS = {
  Nigeria:        0,   // Call everyone
  UK:             40,  // Only engaged leads
  Dubai:          30,  // Warm leads only
  'South Africa': 0,   // Call everyone (like Nigeria)
  default:        0,
};

// Call delay in ms (5 minutes — feels natural, not robotic)
const CALL_DELAY_MS = 5 * 60 * 1000;

function isBusinessHours(region) {
  const config = BUSINESS_HOURS[region] || BUSINESS_HOURS['Nigeria'];
  const now = new Date();
  const localTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    hour: 'numeric',
    hour12: false,
  }).format(now);
  const hour = parseInt(localTime, 10);
  return hour >= config.start && hour < config.end;
}

function getNextBusinessHourMs(region) {
  const config = BUSINESS_HOURS[region] || BUSINESS_HOURS['Nigeria'];
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    hour: 'numeric', minute: 'numeric',
    hour12: false,
  });
  const [hourStr, minStr] = formatter.format(now).split(':');
  const hour = parseInt(hourStr, 10);
  const min  = parseInt(minStr, 10);

  // Minutes until 9am today or tomorrow
  let minsUntilOpen;
  if (hour < config.start) {
    minsUntilOpen = (config.start - hour) * 60 - min;
  } else {
    // Past business hours — schedule for 9am tomorrow
    minsUntilOpen = (24 - hour + config.start) * 60 - min;
  }
  return minsUntilOpen * 60 * 1000;
}

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

  // Make outbound call (UPDATED FOR TRADER PROFILING + MANDATORY ZOHO ENRICHMENT)
  router.post('/api/call/make', async (req, res) => {
    try {
      const { to, prospectName, region, scenario, callType, traderProfile, leadId } = req.body;
      // ✅ CRITICAL FIX: Extract leadId from request body

      if (!to || !prospectName) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, prospectName'
        });
      }

      // ✅ CRITICAL FIX: Validate leadId is present
      if (!leadId || !leadId.trim()) {
        return res.status(400).json({
          success: false,
          error: 'Missing required field: leadId (Zoho CRM Lead ID is mandatory for all calls)'
        });
      }

      console.log('[Call API] /call/make request received');
      console.log('[Call API] Payload:', JSON.stringify(req.body, null, 2));
      console.log('[Call API] ✅ leadId received:', leadId);

      // Support both old and new API formats
      const result = await twilioService.makeCall({
        to,
        prospectName: prospectName || 'there',
        region: region || (traderProfile ? traderProfile.region : 'UK'),
        scenario: scenario || callType || 'broker',
        callType: callType || scenario || 'broker',
        traderProfile: traderProfile || null,
        leadId: leadId.trim() // ✅ CRITICAL FIX: Pass leadId to Twilio service
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
  // TWILIO WEBHOOKS (UPDATED FOR TRADER PROFILING)
  // ═══════════════════════════════════════════════════════════

  // Voice webhook - Initial call connection
  router.post('/twilio/voice', async (req, res) => {
    try {
      const { prospectName, region, scenario, traderProfile, CallSid } = req.query;
      
      console.log('[Twilio Webhook] Voice - Call connected:', CallSid);
      
      // Parse trader profile if it exists (passed as JSON string)
      let parsedTraderProfile = null;
      if (traderProfile) {
        try {
          parsedTraderProfile = JSON.parse(traderProfile);
          console.log('[Twilio Webhook] Trader profile detected:', parsedTraderProfile);
        } catch (e) {
          console.warn('[Twilio Webhook] Could not parse traderProfile:', e.message);
        }
      }
      
      const twiml = await twilioService.generateGreetingTwiML(
        prospectName || 'there',
        region || 'UK',
        scenario || 'broker',
        parsedTraderProfile
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

  // ⚡ ASYNC PATTERN: Wait endpoint - polls for response readiness
  router.post('/twilio/wait/:callSid', async (req, res) => {
    try {
      const { callSid } = req.params;
      const VoiceResponse = require('twilio').twiml.VoiceResponse;
      const twiml = new VoiceResponse();
      
      // Check if response is ready
      const pendingResponse = twilioService.pendingResponses.get(callSid);
      
      if (pendingResponse && pendingResponse.success && pendingResponse.audioUrl) {
        // ✅ Response ready! Play it
        console.log(`[Twilio Wait] ✅ Response ready for ${callSid}`);
        console.log(`[Twilio Wait] 📤 Returning audio URL: ${pendingResponse.audioUrl}`);
        
        // ✅ FIX: Create gather FIRST, then add play and pause INSIDE it
        const gather = twiml.gather({
          input: 'speech',
          action: `${process.env.WEBHOOK_BASE_URL}/twilio/gather`,
          method: 'POST',
          timeout: 60,
          speechTimeout: 'auto',
          speechModel: 'phone_call',
          enhanced: true,
          language: 'en-GB'
        });
        
        // ✅ FIX: Play audio INSIDE the gather (so call doesn't end)
        gather.play(pendingResponse.audioUrl);
        gather.pause({ length: 1 });
        
        // ✅ FIX: Add fallback if no speech detected (prevents hangup)
        twiml.redirect({
          method: 'POST'
        }, `${process.env.WEBHOOK_BASE_URL}/twilio/gather`);
        
        // Clean up
        twilioService.pendingResponses.delete(callSid);
        
      } else if (pendingResponse && !pendingResponse.success) {
        // ❌ Error occurred
        console.error(`[Twilio Wait] ❌ Error for ${callSid}:`, pendingResponse.error);
        twiml.say("I apologize, I'm having trouble right now. Let me try again.");
        
        const gather = twiml.gather({
          input: 'speech',
          action: `${process.env.WEBHOOK_BASE_URL}/twilio/gather`,
          method: 'POST',
          timeout: 60,
          speechTimeout: 'auto',
          speechModel: 'phone_call',
          enhanced: true,
          language: 'en-GB'
        });
        gather.pause({ length: 1 });
        
        twilioService.pendingResponses.delete(callSid);
        
      } else {
        // ⏳ Still generating - keep waiting
        console.log(`[Twilio Wait] ⏳ Still generating for ${callSid}...`);
        twiml.pause({ length: 2 }); // Wait 2 seconds
        twiml.redirect({
          method: 'POST'
        }, `${process.env.WEBHOOK_BASE_URL}/twilio/wait/${callSid}`);
      }
      
      res.type('text/xml');
      res.send(twiml.toString());
      
    } catch (error) {
      console.error('[Twilio Wait] Error:', error);
      const VoiceResponse = require('twilio').twiml.VoiceResponse;
      const twiml = new VoiceResponse();
      twiml.say("I apologize, there was an error. Please try again.");
      twiml.hangup();
      res.type('text/xml');
      res.send(twiml.toString());
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

  // ═══════════════════════════════════════════════════════════
  // AUTO-CALL PIPELINE — Zoho Webhook Receiver
  // Zoho fires this when a new lead is created in CRM
  // ═══════════════════════════════════════════════════════════

  router.post('/zoho/webhook/new-lead', async (req, res) => {
    try {
      console.log('[Auto-Call] 📥 Zoho webhook received — new lead');
      console.log('[Auto-Call] 📦 Body:', JSON.stringify(req.body));
      console.log('[Auto-Call] 🔗 Query:', JSON.stringify(req.query));
      console.log('[Auto-Call] 📋 Content-Type:', req.headers['content-type']);

      // ── Zoho sends module parameters in different places:
      // Sometimes body, sometimes query string, sometimes nested
      const body  = req.body  || {};
      const query = req.query || {};

      // Merge all sources — query string takes priority over body
      const params = { ...body, ...query };

      const leadId      = params.leadId      || params.id           || params.Lead_Id    || '';
      const phone       = params.phone       || params.Phone         || params.Mobile     || '';
      const name        = params.name        || params.Lead_Name     || params.Full_Name  || '';
      const region      = params.region      || params.Country       || 'Nigeria';
      const leadType    = params.leadType    || params.Lead_Type     || 'B2C';
      const intentScore = params.intentScore || params.SmartScore_intent1 || 0;

      // ── Last resort: try parsing raw body manually if all else empty ──
      if (!leadId && !phone && req.rawBody) {
        try {
          const rawParams = new URLSearchParams(req.rawBody);
          const leadIdRaw = rawParams.get('leadId') || rawParams.get('id') || '';
          const phoneRaw  = rawParams.get('phone')  || rawParams.get('Phone') || '';
          if (leadIdRaw) Object.assign(params, { leadId: leadIdRaw });
          if (phoneRaw)  Object.assign(params, { phone: phoneRaw });
          console.log('[Auto-Call] 📦 Raw params parsed:', Object.fromEntries(rawParams));
        } catch(e) {
          console.warn('[Auto-Call] Could not parse raw body:', e.message);
        }
      }

      // ── Validate ──────────────────────────────────────────
      if (!leadId || !phone) {
        console.warn('[Auto-Call] ⚠️  Missing leadId or phone — skipping');
        return res.status(400).json({ success: false, error: 'leadId and phone required' });
      }

      // ── B2B leads — never auto-call ────────────────────────
      if (leadType === 'B2B' || leadType === 'broker') {
        console.log(`[Auto-Call] ⏭️  B2B lead ${leadId} — skipping auto-call (manual outreach only)`);
        return res.json({ success: true, action: 'skipped', reason: 'B2B lead — manual outreach required' });
      }

      // ── IntentScore threshold check ─────────────────────────
      const threshold = CALL_THRESHOLDS[region] ?? CALL_THRESHOLDS.default;
      const score = intentScore || 0;
      if (score < threshold) {
        console.log(`[Auto-Call] ⏭️  Score ${score} below threshold ${threshold} for ${region} — skipping`);
        return res.json({ success: true, action: 'skipped', reason: `Score ${score} below ${region} threshold (${threshold})` });
      }

      // ── Acknowledge Zoho immediately ───────────────────────
      res.json({ success: true, action: 'queued', leadId });

      // ── Business hours check ───────────────────────────────
      const inHours = isBusinessHours(region || 'Nigeria');
      const delayMs = inHours
        ? CALL_DELAY_MS                       // 5 min delay during business hours
        : getNextBusinessHourMs(region);       // Queue until 9am

      if (!inHours) {
        console.log(`[Auto-Call] 🌙 Outside business hours for ${region} — queued for ${Math.round(delayMs/60000)} mins`);
      } else {
        console.log(`[Auto-Call] ✅ Business hours confirmed for ${region} — calling in 5 mins`);
      }

      // ── Schedule the call ──────────────────────────────────
      setTimeout(async () => {
        try {
          console.log(`[Auto-Call] 📞 Firing AI call for lead ${leadId} (${name})`);

          const result = await twilioService.makeCall({
            to:           phone,
            prospectName: name || 'there',
            region:       region || 'Nigeria',
            callType:     'trader',
            scenario:     'trader',
            leadId:       leadId,
          });

          if (result.success) {
            console.log(`[Auto-Call] ✅ Call initiated — SID: ${result.callSid}`);
          } else {
            console.error(`[Auto-Call] ❌ Call failed:`, result.error);
          }
        } catch (err) {
          console.error(`[Auto-Call] ❌ Scheduled call error:`, err.message);
        }
      }, delayMs);

    } catch (error) {
      console.error('[Auto-Call] ❌ Webhook error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // LEAD SEARCH — For CallTestingCenter Lead Search UI
  // ═══════════════════════════════════════════════════════════

  router.get('/zoho/leads/search', async (req, res) => {
    try {
      const { q, per_page = 8 } = req.query;

      if (!q || q.length < 2) {
        return res.json({ leads: [] });
      }

      // Get ZohoService instance from twilioService if available
      const zohoService = twilioService?.zohoService;
      if (!zohoService || !zohoService.isEnabled()) {
        return res.json({ leads: [], message: 'Zoho integration not enabled' });
      }

      const token = await zohoService.getAccessToken();
      if (!token) {
        return res.status(500).json({ leads: [], error: 'Could not get Zoho token' });
      }

      // Search Zoho CRM leads by name or email
      const searchUrl = `${zohoService.apiDomain}/crm/v2/Leads/search?criteria=(Full_Name:contains:${encodeURIComponent(q)})&per_page=${per_page}&fields=id,Full_Name,Phone,Email,Country,SmartScore_intent1,Lead_Type,Interested_Services`;

      const response = await fetch(searchUrl, {
        headers: { 'Authorization': `Zoho-oauthtoken ${token}` }
      });

      if (!response.ok) {
        const err = await response.text();
        console.error('[Lead Search] Zoho error:', err);
        return res.json({ leads: [] });
      }

      const data = await response.json();
      const leads = (data.data || []).map(lead => ({
        id:           lead.id,
        name:         lead.Full_Name || '',
        phone:        lead.Phone || '',
        email:        lead.Email || '',
        country:      lead.Country || '',
        intent_score: lead.SmartScore_intent1 || 0,
        lead_type:    lead.Lead_Type || 'B2C',
        product:      lead.Interested_Services || 'FX',
      }));

      console.log(`[Lead Search] Found ${leads.length} results for "${q}"`);
      res.json({ leads });

    } catch (error) {
      console.error('[Lead Search] Error:', error.message);
      res.status(500).json({ leads: [], error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // LEAD LIST — For Dashboard pipeline view
  // ═══════════════════════════════════════════════════════════

  router.get('/zoho/leads', async (req, res) => {
    try {
      const { view, per_page = 50 } = req.query;
      const zohoService = twilioService?.zohoService;

      if (!zohoService || !zohoService.isEnabled()) {
        return res.json({ leads: [] });
      }

      const token = await zohoService.getAccessToken();
      if (!token) return res.status(500).json({ leads: [] });

      const url = `${zohoService.apiDomain}/crm/v2/Leads?per_page=${per_page}&fields=id,Full_Name,Company,Phone,Country,SmartScore_intent1,SmartStage,Lead_Type`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Zoho-oauthtoken ${token}` }
      });

      if (!response.ok) return res.json({ leads: [] });

      const data = await response.json();
      const leads = (data.data || []).map(lead => ({
        id:      lead.id,
        name:    lead.Full_Name || '',
        company: lead.Company || '',
        phone:   lead.Phone || '',
        country: lead.Country || '',
        score:   lead.SmartScore_intent1 || 0,
        intent:  lead.SmartScore_intent1 || 0,
        stage:   lead.SmartStage || 'Cold',
      }));

      res.json({ leads });
    } catch (error) {
      console.error('[Leads] Error:', error.message);
      res.status(500).json({ leads: [] });
    }
  });

  return router;
}

module.exports = setupCallRoutes;
