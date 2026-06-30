// ═══════════════════════════════════════════════════════════
// SALES360 TWILIO SERVICE - PHASE 3C FINAL
// CRITICAL FIX: MANDATORY ZOHO PRE-CALL ENRICHMENT
// All calls now require Zoho context via Deluge function
// ═══════════════════════════════════════════════════════════

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const ElevenLabsService = require('./elevenlabs-dynamic-service');
const StorageService = require('./storage-service');
const ZohoService = require('./zoho-service');

// ✅ CHUKS METHODOLOGY V2: Regional Calibration + Conversational Sales
const ChuksMethodology = require('./CHUKS-METHODOLOGY-V2');
const RegionalCalibration = require('./REGIONAL-CALIBRATION');

// ✅ SALES360 MASTER PROMPT V2: Haiku-Optimised, 674 tokens, 24 rules compressed
const { Sales360MasterPromptV2 } = require('./SALES360-MASTER-PROMPT-V2');

class TwilioService {
  constructor(elevenLabsService = null, zohoService = null) {
    this.accountSid = process.env.TWILIO_ACCOUNT_SID;
    this.authToken = process.env.TWILIO_AUTH_TOKEN;
    this.phoneNumber = process.env.TWILIO_PHONE_NUMBER;
    this.webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
    this.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    
    if (!this.accountSid || !this.authToken || !this.phoneNumber) {
      throw new Error('[Twilio Service] Missing required environment variables');
    }
    
    this.client = twilio(this.accountSid, this.authToken);
    this.activeCalls = new Map();
    
    // ⚡ ASYNC PATTERN: Track responses being generated in background
    this.pendingResponses = new Map();
    
    // ⚡ OPTIMIZATION: Greeting cache (avoid regenerating same audio)
    this.greetingCache = new Map();
    
    // Use provided ElevenLabs service OR create new one
    if (elevenLabsService) {
      console.log('[Twilio Service] ✅ Using provided ElevenLabs service');
      this.elevenLabs = elevenLabsService;
    } else {
      console.log('[Twilio Service] ⚠️  No ElevenLabs service provided, creating new instance');
      this.elevenLabs = new ElevenLabsService();
    }
    
    this.storage = new StorageService();
    
    // Use provided Zoho service OR create new one
    if (zohoService) {
      console.log('[Twilio Service] ✅ Using provided Zoho service');
      this.zoho = zohoService;
    } else {
      console.log('[Twilio Service] ⚠️  No Zoho service provided, creating new instance');
      this.zoho = new ZohoService();
    }

    // ═══════════════════════════════════════════════════════════
    // PRE-CACHED FALLBACK AUDIO (Chuks's cloned voice)
    // NO system voices should EVER reach the prospect
    // ═══════════════════════════════════════════════════════════
    this.fallbackAudioUrls = new Map();
    this.fallbackMessages = {
      'bad_line': "Sorry, the line broke up for a second. Could you say that again?",
      'still_there_1': "Hey, are you still there? I think the line might have dropped for a second.",
      'still_there_2': "Hello? Can you hear me? Just want to make sure we're still connected.",
      'bad_connection_end': "Looks like we've got a bad connection. Let me try you again in a few minutes. Take care!",
      'busy_callback': "No worries at all! I'll give you a call back in about 30 minutes. Have a great day!",
      'natural_signoff': "Sorry about that, let me call you right back. Talk in a moment!",
      'error_recovery': "Apologies, give me one second. Actually, let me call you right back so we get a clean line."
    };
    this._preloadFallbackAudio();
    
    console.log('[Twilio Service] ✅ Initialized with number:', this.phoneNumber);
    console.log('[Twilio Service] Anthropic API Key:', this.anthropicApiKey ? `YES (length: ${this.anthropicApiKey.length})` : '❌ MISSING!');
    console.log('[Twilio Service] ElevenLabs:', this.elevenLabs.isReady() ? '✅ Ready' : '⚠️  Disabled');
    console.log('[Twilio Service] Storage: ✅ Ready (3-tier fallback: R2 → Volume → Direct)');
    console.log('[Twilio Service] Zoho CRM:', this.zoho.isEnabled() ? '✅ Connected' : '⚠️  Disabled');
  }

  // ═══════════════════════════════════════════════════════════
  // FALLBACK AUDIO — Pre-generate with cloned voice
  // Prospect should NEVER hear a system voice or error message
  // ═══════════════════════════════════════════════════════════
  async _preloadFallbackAudio() {
    console.log('[Fallback Audio] 🎯 Pre-generating fallback messages with cloned voice...');
    for (const [key, text] of Object.entries(this.fallbackMessages)) {
      try {
        const region = 'nigeria';
        const audioBuffer = await this.elevenLabs.generateSpeech(text, region);
        if (audioBuffer) {
          const storageResult = await this.storage.smartUpload(audioBuffer, `fallback_${key}`);
          const url = storageResult.url || storageResult;
          this.fallbackAudioUrls.set(key, url);
          console.log(`[Fallback Audio] ✅ Cached: ${key}`);
        }
      } catch (error) {
        console.error(`[Fallback Audio] ⚠️  Failed to cache ${key}:`, error.message);
      }
    }
    console.log(`[Fallback Audio] 📦 ${this.fallbackAudioUrls.size}/${Object.keys(this.fallbackMessages).length} messages cached`);
  }

  _playFallback(twiml, messageKey) {
    const cachedUrl = this.fallbackAudioUrls.get(messageKey);
    if (cachedUrl) {
      twiml.play(cachedUrl);
    } else {
      const text = this.fallbackMessages[messageKey] || "Sorry, give me one moment.";
      twiml.say({ voice: 'Polly.Matthew-Neural', language: 'en-GB' }, text);
      console.log(`[Fallback Audio] ⚠️  Polly fallback for: ${messageKey}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ✅ UPDATED: MAKE OUTBOUND CALL WITH MANDATORY ZOHO ENRICHMENT
  // ChatGPT Requirement: Pre-call Deluge fetch is MANDATORY
  // Only defaults to B2B/corporate when Zoho fetch FAILS
  // ═══════════════════════════════════════════════════════════
  async makeCall({ to, prospectName, region, scenario, callType, traderProfile, leadId }) {
    try {
      const actualCallType = callType || scenario || 'broker';
      const actualRegion = region || (traderProfile ? traderProfile.region : 'UK');
      
      // ═══════════════════════════════════════════════════════════
      // ✅ MANDATORY ZOHO PRE-CALL ENRICHMENT (ChatGPT requirement)
      // This is no longer optional - we MUST fetch before proceeding
      // ═══════════════════════════════════════════════════════════
      let zohoLead = null;
      let leadType = null;
      let callContext = null;
      
      if (!leadId) {
        console.error('[Twilio Service] ❌ CRITICAL: No leadId provided - cannot make call without Zoho context');
        throw new Error('leadId is required for all calls');
      }
      
      if (!this.zoho.isEnabled()) {
        console.error('[Twilio Service] ❌ CRITICAL: Zoho integration disabled - cannot make calls');
        throw new Error('Zoho CRM integration is required for calls');
      }
      
      // ✅ STEP 1: Mandatory Zoho enrichment via Deluge function
      console.log(`[Twilio Service] 🔍 MANDATORY PRE-CALL ENRICHMENT for leadId: ${leadId}`);
      zohoLead = await this.zoho.enrichLeadBeforeCall(leadId);
      
      // ✅ STEP 2: Determine call context based on Zoho data
      if (zohoLead) {
        // SUCCESS: Use real Zoho data
        leadType = zohoLead.leadType || 'B2B';
        
        // ✅ BUYER CONTEXT DETECTION (for B2C calls)
        let buyerContext = 'n/a';  // Default for B2B
        
        if (leadType === 'B2C') {
          // Solo trader: No company OR individual-focused (personal trading)
          // Corporate trader: Has company (trading on behalf of organization)
          buyerContext = (!zohoLead.company || zohoLead.company.trim() === '') 
            ? 'solo' 
            : 'corporate';
        }
        
        callContext = {
          leadType: leadType,
          buyerContext: buyerContext,
          intentScore: zohoLead.intentScore,
          behaviourScore: zohoLead.behaviourScore,
          stage: zohoLead.stage,
          fullName: zohoLead.fullName,
          company: zohoLead.company || 'Unknown',
          country: zohoLead.country || '',
          region: zohoLead.country ? this._mapCountryToRegion(zohoLead.country) : actualRegion,
          currentChallenges: zohoLead.currentChallenges || '',
          budgetReadiness: zohoLead.budgetReadiness || '',
          daysSinceLastTouch: zohoLead.daysSinceLastTouch || 0
        };
        
        console.log(`[Twilio Service] ✅ ZOHO ENRICHMENT SUCCESS`);
        console.log(`[Twilio Service] 📊 Lead Type: ${callContext.leadType}`);
        console.log(`[Twilio Service] 📊 Buyer Context: ${callContext.buyerContext}`);
        console.log(`[Twilio Service] 📊 IntentScore: ${callContext.intentScore}`);
        console.log(`[Twilio Service] 📊 Stage: ${callContext.stage}`);
        
      } else {
        // FAILURE: Zoho fetch failed - default to B2B/corporate
        console.warn(`[Twilio Service] ⚠️  ZOHO ENRICHMENT FAILED - Defaulting to B2B/corporate`);
        console.warn(`[Twilio Service] ⚠️  This should ONLY happen if Zoho API is down or lead doesn't exist`);
        
        leadType = 'B2B';
        
        callContext = {
          leadType: 'B2B',
          buyerContext: 'corporate',
          intentScore: 0,
          behaviourScore: 0,
          stage: 'Cold',
          fullName: prospectName || 'Unknown',
          company: 'Unknown',
          country: '',
          region: actualRegion,
          currentChallenges: '',
          budgetReadiness: '',
          daysSinceLastTouch: 0
        };
      }
      
      // ✅ STEP 3: Select Claude prompt based on Lead_Type
      console.log(`[Twilio Service] 🎯 Prompt Selection:`);
      console.log(`[Twilio Service]     Lead Type: ${callContext.leadType}`);
      console.log(`[Twilio Service]     Prompt Branch: ${callContext.leadType === 'B2C' ? 'B2C trader/end-user' : 'B2B client acquisition'}`);
      
      // Build call data object
      const callData = {
        prospectName: callContext.fullName,
        region: callContext.region,
        scenario: actualCallType,
        traderProfile: traderProfile || null,
        zohoLead: zohoLead || null,
        leadId: leadId,
        
        // ✅ B2B/B2C CLASSIFICATION (from Zoho)
        leadType: callContext.leadType,
        buyerContext: callContext.buyerContext,
        callType: actualCallType,
        
        conversationHistory: [],
        startTime: new Date().toISOString(),
        intentScore: callContext.intentScore,
        
        // Engagement tracking
        engagementSignals: {
          call_answered: false,
          meaningful_conversation: false,
          asked_questions: false,
          pricing_discussed: false,
          demo_requested: false,
          callback_requested: false,
          objection_detected: false,
          decision_maker_confirmed: false
        },
        
        detectedPainPoints: [],
        objections: [],
        buyingSignals: [],
        
        // ═══════════════════════════════════════════════════════════
        // P1: CONVERSATION STATE TRACKING
        // Both ChatGPT and Gemini recommended this as the #1 fix
        // Eliminates repetitive questions by explicitly tracking what's known
        // ═══════════════════════════════════════════════════════════
        conversationState: {
          known_facts: {},        // { goal: 'financial freedom', experience: 'beginner', ... }
          asked_topics: [],       // ['goal', 'experience', 'timeline']
          prospect_energy: 'unknown', // 'talkative', 'brief', 'hostile', 'engaged'
          turns_since_last_question: 0,
          last_user_word_count: 0
        },

        // CALL COMPLETION SYSTEM
        silenceRetries: 0,        // Consecutive "no speech detected" counter (max 2 before ending)
        maxSilenceRetries: 2,     // How many times to retry on silence
        turnCount: 0,             // Total conversation turns
        retryCount: callContext.retryCount || 0,  // How many times this lead has been called
        callbackRequested: false,  // Prospect asked to be called back
        callbackTime: null,        // When to call back
        
        // Score tracking
        intentScoreStart: callContext.intentScore,
        intentScorePeak: callContext.intentScore,
        behaviourScoreStart: callContext.behaviourScore,
        behaviourScore: callContext.behaviourScore,
        behaviourScoreDelta: 0
      };

      console.log(`[Twilio Service] 📞 Initiating call to ${callContext.fullName} (${callContext.leadType})`);
      
      // Build webhook URL
      const webhookParams = new URLSearchParams({
        prospectName: callContext.fullName,
        region: callContext.region,
        scenario: actualCallType
      });
      
      if (traderProfile) {
        webhookParams.append('traderProfile', JSON.stringify(traderProfile));
      }

      const call = await this.client.calls.create({
        url: `${this.webhookBaseUrl}/twilio/voice?${webhookParams.toString()}`,
        to: to,
        from: this.phoneNumber,
        statusCallback: `${this.webhookBaseUrl}/twilio/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        record: true,
        recordingStatusCallback: `${this.webhookBaseUrl}/twilio/recording`,
        recordingStatusCallbackMethod: 'POST'
      });

      // Store callSid immediately (for error tracking)
      callData.callSid = call.sid;
      this.activeCalls.set(call.sid, callData);
      
      console.log(`[Twilio Service] ✅ Call initiated: ${call.sid}`);
      console.log(`[Twilio Service]    To: ${to}`);
      console.log(`[Twilio Service]    Type: ${actualCallType}`);
      console.log(`[Twilio Service]    Region: ${callContext.region}`);

      return {
        success: true,
        callSid: call.sid,
        status: call.status,
        to: call.to,
        from: this.phoneNumber,
        leadType: callContext.leadType,
        buyerContext: callContext.buyerContext
      };
    } catch (error) {
      console.error('[Twilio Service] ❌ Error making call:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ✅ Helper to map country to region
  _mapCountryToRegion(country) {
    const c = country.toLowerCase();
    
    if (c.includes('nigeria')) return 'Nigeria';
    if (c.includes('united kingdom') || c === 'uk') return 'UK';
    if (c.includes('dubai') || c.includes('uae')) return 'Dubai';
    if (c.includes('south africa')) return 'South Africa';
    
    return country;
  }

  // ═══════════════════════════════════════════════════════════
  // GENERATE OPENING GREETING (WITH ELEVENLABS + DYNAMIC PROFILING!)
  // ═══════════════════════════════════════════════════════════
  async generateGreetingTwiML(prospectName, region, scenario, traderProfile = null) {
    const startTime = Date.now();
    const twiml = new VoiceResponse();
    
    // Use dynamic greeting if trader profile exists
    const greeting = traderProfile 
      ? this._getDynamicGreeting(prospectName, traderProfile)
      : this._getGreeting(scenario, prospectName, region);
    
    // ⚡ OPTIMIZATION: Cache key includes region + leadType so each market gets own greeting
    // This prevents stale "AI assistant" greetings being served to Nigerian prospects
    const leadType = traderProfile?.leadType || 'default';
    const cacheKey = `${prospectName}-${region}-${scenario}-${leadType}`;
    
    if (this.greetingCache.has(cacheKey)) {
      console.log(`[Twilio Service] ⚡ Using cached greeting for: ${prospectName}`);
      const cachedUrl = this.greetingCache.get(cacheKey);
      twiml.play(cachedUrl);
    } else {
      console.log(`[Twilio Service] 🎤 Generating greeting: "${greeting}"`);
      
      // Generate audio with ElevenLabs
      const audioBuffer = await this.elevenLabs.generateAudio(greeting, region, 'Male');
      
      if (audioBuffer) {
        // Upload to storage
        const storageResult = await this.storage.uploadAudio(audioBuffer, 'greeting');
        
        // ✅ NEW STORAGE SERVICE: Extract URL from response object
        const audioUrl = storageResult.url || storageResult;
        
        // Cache for future use (expires after 1 hour)
        this.greetingCache.set(cacheKey, audioUrl);
        setTimeout(() => this.greetingCache.delete(cacheKey), 3600000);
        
        const elapsedTime = Date.now() - startTime;
        console.log(`[Twilio Service] ✅ Greeting generated in ${elapsedTime}ms`);
        console.log(`[Twilio Service] 🎵 Audio URL: ${audioUrl}`);
        
        twiml.play(audioUrl);
      } else {
        console.log(`[Twilio Service] ⚠️  Falling back to AWS Polly for greeting`);
        twiml.say({
          voice: 'Polly.Matthew',
          language: 'en-GB'
        }, greeting);
      }
    }

    // Continue with speech gathering — tuned for Nigerian/African English cadence
    // speechTimeout: 3 = wait 3 seconds of silence before treating speech as complete
    //   WHY NOT 'auto': Twilio's auto detection cuts off mid-sentence for Nigerian English
    //   WHY NOT 1: Too aggressive, fragments like "right now I" get submitted incomplete
    //   WHY 3: Matches natural pause length in Nigerian conversational speech
    // timeout: 15 = wait up to 15s for prospect to start speaking after AI finishes
    const gather = twiml.gather({
      input: 'speech',
      action: `${this.webhookBaseUrl}/twilio/gather`,
      method: 'POST',
      timeout: 15,
      speechTimeout: 3,              // ✅ FIX: Explicit 3s silence threshold (was 'auto')
      speechModel: 'phone_call',
      enhanced: true,
      language: 'en-GB'
    });
    gather.pause({ length: 1 });

    return twiml.toString();
  }

  // ═══════════════════════════════════════════════════════════
  // ASYNC PATTERN: Generate response in background (NO WAITING!)
  // ═══════════════════════════════════════════════════════════
  async generateResponseAsync(callSid, speechResult, wsServer) {
    const startTime = Date.now();
    
    try {
      console.log(`[Twilio Async] 🔄 Generating response for ${callSid}...`);
      
      const callData = this.activeCalls.get(callSid);
      if (!callData) {
        throw new Error('Call data not found');
      }

      // Get AI response from Claude
      const aiResponse = await this._getClaudeResponse(callData, speechResult);
      
      if (!aiResponse) {
        throw new Error('No AI response received');
      }

      console.log(`[Twilio Async] 🤖 AI response: ${aiResponse.text.substring(0, 80)}...`);

      // Broadcast AI transcript to dashboard IMMEDIATELY (no waiting for scoring)
      if (wsServer) {
        wsServer.broadcast({
          type: 'callUpdate',
          callSid,
          transcript: {
            speaker: 'ai',
            message: aiResponse.text,
            timestamp: Date.now()
          }
        });
      }

      // P2: Fire async scoring to Haiku — NON-BLOCKING
      // Prospect never waits on this. Score updates arrive on dashboard async.
      this._scoreConversationAsync(callData, speechResult, aiResponse.text, wsServer)
        .catch(err => console.error('[Scoring] Background scoring failed:', err.message));

      // Generate audio with ElevenLabs
      const audioBuffer = await this.elevenLabs.generateAudio(
        aiResponse.text, 
        callData.region, 
        'Male'
      );

      if (!audioBuffer) {
        throw new Error('Audio generation failed');
      }

      // ✅ NEW STORAGE SERVICE: Extract URL from response object
      const storageResult = await this.storage.uploadAudio(audioBuffer, 'response');
      const audioUrl = storageResult.url || storageResult;
      
      const elapsedTime = Date.now() - startTime;
      console.log(`[Twilio Async] ✅ Response ready in ${elapsedTime}ms`);
      console.log(`[Twilio Async] 🎵 Audio URL: ${audioUrl}`);
      
      // Store the ready response
      this.pendingResponses.set(callSid, {
        audioUrl,
        text: aiResponse.text,
        score: aiResponse.score,
        timestamp: Date.now(),
        success: true
      });
      
    } catch (error) {
      console.error(`[Twilio Async] ❌ Error generating response:`, error);
      
      // ═══════════════════════════════════════════════════════════
      // TIMEOUT/ERROR FALLBACK — Play natural recovery instead of silence
      // The prospect should hear "sorry, bad connection" NOT dead air
      // ═══════════════════════════════════════════════════════════
      const fallbackUrl = this.fallbackAudioUrls.get('error_recovery');
      
      this.pendingResponses.set(callSid, {
        error: error.message,
        timestamp: Date.now(),
        success: false,
        audioUrl: fallbackUrl || null,  // Wait endpoint can play this instead of silence
        fallbackMessage: this.fallbackMessages['error_recovery']  // Text fallback if no cached audio
      });

      // Track that this call had a timeout — affects retry logic
      const callData_err = this.activeCalls.get(callSid);
      if (callData_err) {
        callData_err.callEndReason = 'ai_timeout';
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // HANDLE GATHER - Process user speech and generate AI response
  // ═══════════════════════════════════════════════════════════
  async handleGather(callSid, speechResult, wsServer) {
    const twiml = new VoiceResponse();

    const callData = this.activeCalls.get(callSid);
    if (!callData) {
      console.error('[Twilio Webhook] Call data not found for:', callSid);
      this._playFallback(twiml, 'error_recovery');
      twiml.hangup();
      return twiml.toString();
    }

    // Handle empty or silence speech — SMART RETRY before giving up
    if (!speechResult || speechResult.trim() === '') {
      const callData_silence = this.activeCalls.get(callSid);
      const silenceCount = callData_silence ? (callData_silence.silenceRetries || 0) : 0;
      
      if (silenceCount >= (callData_silence?.maxSilenceRetries || 2)) {
        // Max retries exhausted — end call gracefully
        console.log(`[Twilio] 🔇 Max silence retries (${silenceCount}) reached — ending call`);
        this._playFallback(twiml, 'bad_connection_end');
        twiml.hangup();
        
        if (callData_silence) {
          callData_silence.callEndReason = 'silence_timeout';
        }
        return twiml.toString();
      }

      // Increment silence counter
      if (callData_silence) {
        callData_silence.silenceRetries = silenceCount + 1;
      }

      // Natural re-engagement messages (varies by retry count)
      const reEngageMessages = [
        "Hey, are you still there? I think the line might have dropped for a second.",
        "Hello? Can you hear me? Just want to make sure we're still connected."
      ];
      const message = reEngageMessages[silenceCount] || reEngageMessages[0];
      
      console.log(`[Twilio] 🔇 No speech detected — retry ${silenceCount + 1}/${callData_silence?.maxSilenceRetries || 2}`);
      
      const fallbackKey = silenceCount === 0 ? 'still_there_1' : 'still_there_2';
      this._playFallback(twiml, fallbackKey);
      
      const gather = twiml.gather({
        input: 'speech',
        action: `${this.webhookBaseUrl}/twilio/gather`,
        method: 'POST',
        timeout: 10,
        speechTimeout: 3,
        speechModel: 'phone_call',
        enhanced: true,
        language: 'en-GB'
      });
      gather.pause({ length: 1 });
      
      return twiml.toString();
    }

    // Reset silence counter on successful speech
    const callData_reset = this.activeCalls.get(callSid);
    if (callData_reset) {
      callData_reset.silenceRetries = 0;
      callData_reset.turnCount = (callData_reset.turnCount || 0) + 1;
    }

    console.log(`[Twilio Webhook] 🎤 User said: ${speechResult}`);

    // ✅ Broadcast USER speech to dashboard immediately
    // Dashboard LiveTranscriptFeed.jsx expects: { speaker: 'prospect', message: '...' }
    if (wsServer) {
      wsServer.broadcast({
        type: 'callUpdate',
        callSid,
        transcript: {
          speaker: 'prospect',
          message: speechResult,
          timestamp: Date.now()
        }
      });
    }

    // ═══════════════════════════════════════════════════════════
    // P3: APPLICATION-LAYER INTERCEPTS
    // Handle edge cases in Node.js BEFORE hitting expensive Claude API
    // ═══════════════════════════════════════════════════════════
    const words = speechResult.trim().split(/\s+/);
    const wordCount = words.length;
    const lowerSpeech = speechResult.toLowerCase();

    // P3a: "I'm busy / call me later" — instant sign-off, $0 LLM cost
    const busyPatterns = ['busy', 'driving', 'call back', 'call me back', 'call later', 
      'not a good time', 'in a meeting', 'call me later', 'ring me back', 'ring back'];
    const isBusy = busyPatterns.some(p => lowerSpeech.includes(p));
    
    if (isBusy && wordCount < 15) {
      console.log(`[Twilio] 🏃 Busy intercept triggered: "${speechResult}"`);
      const callData = this.activeCalls.get(callSid);
      if (callData) {
        callData.engagementSignals.callback_requested = true;
        callData.callbackRequested = true;
        callData.callEndReason = 'prospect_busy';
      }
      this._playFallback(twiml, 'busy_callback');
      twiml.hangup();
      return twiml.toString();
    }

    // P3b: Garbled/nonsensical speech — short gibberish that makes no sense
    // Only intercept very short fragments (1-2 words) that are clearly garbled
    if (wordCount <= 2 && speechResult.length < 10) {
      const commonShortPhrases = ['yes', 'no', 'yeah', 'ok', 'okay', 'sure', 'hello', 'hi',
        'what', 'why', 'how', 'please', 'thanks', 'right', 'go ahead', 'continue', 'huh',
        'sorry', 'pardon', 'repeat', 'hmm', 'true', 'exactly', 'correct'];
      const isRecognisable = commonShortPhrases.some(p => lowerSpeech.includes(p));
      
      if (!isRecognisable) {
        console.log(`[Twilio] 🔇 Garbled speech intercepted: "${speechResult}"`);
        this._playFallback(twiml, 'bad_line');
        const gather = twiml.gather({
          input: 'speech',
          action: `${this.webhookBaseUrl}/twilio/gather`,
          method: 'POST',
          timeout: 15,
          speechTimeout: 3,
          speechModel: 'phone_call',
          enhanced: true,
          language: 'en-GB'
        });
        gather.pause({ length: 1 });
        return twiml.toString();
      }
    }

    // P4: Update pacing state for dynamic prompt modifier
    const callData_pacing = this.activeCalls.get(callSid);
    if (callData_pacing && callData_pacing.conversationState) {
      callData_pacing.conversationState.last_user_word_count = wordCount;
      if (wordCount < 5) {
        callData_pacing.conversationState.prospect_energy = 'brief';
      } else if (wordCount > 30) {
        callData_pacing.conversationState.prospect_energy = 'talkative';
      } else {
        callData_pacing.conversationState.prospect_energy = 'engaged';
      }
    }

    // ⚡ ASYNC PATTERN: Start generating response in BACKGROUND (don't await!)
    this.generateResponseAsync(callSid, speechResult, wsServer);
    
    // Return IMMEDIATELY with redirect to wait endpoint
    console.log(`[Twilio Webhook] ⚡ Redirecting to wait endpoint (async mode)`);
    twiml.redirect({
      method: 'POST'
    }, `${this.webhookBaseUrl}/twilio/wait/${callSid}`);

    return twiml.toString(); // Returns in <500ms!
  }


  // ═══════════════════════════════════════════════════════════
  // GET CLAUDE RESPONSE — SPEECH TEXT ONLY (scoring decoupled)
  // P2: Sonnet generates ONLY spoken text. No JSON. No scoring.
  // Scoring fires asynchronously to Haiku after response is ready.
  // ═══════════════════════════════════════════════════════════
  async _getClaudeResponse(callData, userSpeech) {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      callData.conversationHistory.push({
        role: 'user',
        content: userSpeech
      });

      // BUILD DYNAMIC SYSTEM PROMPT + STATE HEADER + PACING
      const basePrompt = this._selectPromptByLeadType(callData);
      const stateHeader = this._buildStateHeader(callData);
      const pacingMod = this._buildPacingModifier(callData);
      const systemPrompt = `${basePrompt}\n\n${stateHeader}\n\n${pacingMod}`;

      console.log(`[Claude API] 📤 Sending request (turn ${callData.conversationHistory.length / 2})`);
      console.log(`[Claude API] 🎯 Lead Type: ${callData.leadType} | Call Type: ${callData.callType}`);
      console.log(`[Claude API] 📊 Current IntentScore: ${callData.intentScore}`);

      const maxTokens = this._getOptimalTokens(callData, userSpeech);
      console.log(`[Claude API] 🎯 Using ${maxTokens} tokens for this response`);
      
      const modelToUse = 'claude-sonnet-4-6';
      console.log(`[Claude API] 📊 Model: ${modelToUse}`);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: modelToUse,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: callData.conversationHistory
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const error = await response.text();
        console.error('[Claude API] ❌ API Error:', error);
        return null;
      }

      const data = await response.json();
      const elapsedTime = Date.now() - startTime;
      console.log(`[Claude API] ✅ Response received in ${elapsedTime}ms`);

      if (data.content && data.content[0]) {
        const aiText = (data.content[0].text || '').trim();
        
        // RESPONSE MONITORING
        const wordCount = aiText.split(/\s+/).filter(w => w).length;
        const endsWithQuestion = /\?['"]*\s*$/.test(aiText.trim());
        console.log(`[Claude API] ✅ Response: ${wordCount} words${endsWithQuestion ? ', ends with question' : ''}`);

        // Save to conversation history (pure text, no JSON ever)
        callData.conversationHistory.push({
          role: 'assistant',
          content: aiText
        });

        // P1: Update conversation state with what we learned this turn
        this._updateConversationState(callData, userSpeech, aiText);

        return {
          text: aiText,
          score: callData.intentScore
        };
      }

      return null;
    } catch (error) {
      const elapsedTime = Date.now() - startTime;
      
      if (error.name === 'AbortError') {
        console.error(`[Claude API] ⏱️ Timeout after ${elapsedTime}ms`);
      } else {
        console.error(`[Claude API] ❌ Exception after ${elapsedTime}ms:`, error.message);
      }
      
      clearTimeout(timeout);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // P1: BUILD STATE HEADER — Injected into prompt every turn
  // Tells Sonnet exactly what's been covered so it NEVER repeats
  // ═══════════════════════════════════════════════════════════
  _buildStateHeader(callData) {
    const state = callData.conversationState;
    if (!state) return '';

    const facts = state.known_facts || {};
    const factLines = Object.entries(facts)
      .map(([key, val]) => `- ${key}: ${val}`)
      .join('\n');
    
    const askedLines = (state.asked_topics || [])
      .map(t => `- ${t}`)
      .join('\n');

    return `═══════════════════════════════════════════
CURRENT CALL STATE (DO NOT DISCOVER THESE AGAIN)
═══════════════════════════════════════════
KNOWN FACTS:
${factLines || '- Nothing confirmed yet (first turn)'}

TOPICS ALREADY ASKED ABOUT:
${askedLines || '- None yet'}

DO NOT re-ask about any known fact. Build on what you know. Advance the conversation forward.`;
  }

  // ═══════════════════════════════════════════════════════════
  // P4: BUILD PACING MODIFIER — Adapts response style to prospect
  // ═══════════════════════════════════════════════════════════
  _buildPacingModifier(callData) {
    const state = callData.conversationState;
    if (!state) return '';

    const wc = state.last_user_word_count || 0;
    const energy = state.prospect_energy || 'unknown';

    if (energy === 'brief' || wc < 5) {
      return `[PACING: Prospect is giving short answers. Use a brief hook or statement, not open-ended questions. Keep your response under 15 words. Match their energy.]`;
    } else if (energy === 'talkative' || wc > 30) {
      return `[PACING: Prospect is highly engaged and talking. Use active listening ("Right", "Exactly", "I hear you"), validate their point, then ask ONE focused follow-up.]`;
    } else if (energy === 'hostile') {
      return `[PACING: Prospect sounds frustrated or hostile. Acknowledge their frustration immediately. Apologise if needed. Skip to the most actionable next step.]`;
    }
    return '';
  }

  // ═══════════════════════════════════════════════════════════
  // P1: UPDATE CONVERSATION STATE — Track what we've learned
  // ═══════════════════════════════════════════════════════════
  _updateConversationState(callData, userSpeech, aiText) {
    const state = callData.conversationState;
    if (!state) return;

    const lower = userSpeech.toLowerCase();

    // Track known facts based on keywords in user speech
    const factPatterns = [
      { keys: ['financial freedom', 'make money', 'extra income', 'passive income', 'side income'], fact: 'goal', value: 'financial freedom / extra income' },
      { keys: ['beginner', 'just starting', 'new to', 'never traded', 'don\'t know how'], fact: 'experience', value: 'beginner' },
      { keys: ['been trading', 'already trade', 'some experience', 'traded before'], fact: 'experience', value: 'has some experience' },
      { keys: ['busy', 'work', 'no time', 'demanding job'], fact: 'constraint', value: 'busy with work / limited time' },
      { keys: ['scared', 'afraid', 'lose money', 'risky', 'scam'], fact: 'fear', value: 'fears losing money / trust concerns' },
      { keys: ['burned', 'bad experience', 'lost money before', 'other broker'], fact: 'past_experience', value: 'bad experience with previous broker' },
      { keys: ['whatsapp', 'email', 'call me'], fact: 'preferred_channel', value: lower.includes('whatsapp') ? 'WhatsApp' : lower.includes('email') ? 'Email' : 'Phone' },
      { keys: ['200', '500', '1000', '5000', 'thousand', 'hundred'], fact: 'capital_mentioned', value: userSpeech.match(/[\$\u00a3\u20a6]?\d[\d,]*/)?.[0] || 'amount mentioned' },
      { keys: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'tomorrow', 'next week', 'weekend'], fact: 'timeline', value: userSpeech.match(/monday|tuesday|wednesday|thursday|friday|tomorrow|next week|weekend/i)?.[0] || 'time mentioned' },
    ];

    for (const pattern of factPatterns) {
      if (pattern.keys.some(k => lower.includes(k))) {
        state.known_facts[pattern.fact] = pattern.value;
      }
    }

    // Track what AI asked about (from AI's response)
    const aiLower = aiText.toLowerCase();
    const topicPatterns = [
      { keys: ['what.*goal', 'what.*want', 'what.*looking for', 'what.*hoping'], topic: 'goals' },
      { keys: ['experience', 'traded before', 'how long'], topic: 'experience' },
      { keys: ['what.*stop', 'what.*holding', 'what.*blocking', 'what.*prevent'], topic: 'obstacles' },
      { keys: ['how much', 'capital', 'invest', 'deposit', 'start with'], topic: 'capital' },
      { keys: ['when.*start', 'timeline', 'thursday.*friday', 'this week'], topic: 'timeline' },
      { keys: ['whatsapp.*email', 'best.*reach', 'best.*number'], topic: 'contact_preference' },
    ];

    for (const pattern of topicPatterns) {
      if (pattern.keys.some(k => new RegExp(k, 'i').test(aiLower))) {
        if (!state.asked_topics.includes(pattern.topic)) {
          state.asked_topics.push(pattern.topic);
        }
      }
    }

    // Detect hostile/frustrated energy
    const hostilePatterns = ['boring', 'bored', 'waste', 'annoying', 'stop asking', 'same question', 'already told you', 'said that'];
    if (hostilePatterns.some(p => lower.includes(p))) {
      state.prospect_energy = 'hostile';
    }

    console.log(`[State] Updated — Known: ${Object.keys(state.known_facts).length} facts, Asked: ${state.asked_topics.length} topics, Energy: ${state.prospect_energy}`);
  }

  // ═══════════════════════════════════════════════════════════
  // P2: ASYNC SCORING — Fires Haiku in background, non-blocking
  // Prospect never waits on analytics
  // ═══════════════════════════════════════════════════════════
  async _scoreConversationAsync(callData, userSpeech, aiText, wsServer) {
    try {
      const state = callData.conversationState || {};
      const knownFacts = JSON.stringify(state.known_facts || {});
      
      const scoringPrompt = `You are a sales call scoring engine. Calculate the new IntentScore after this exchange.

CURRENT SCORE: ${callData.intentScore}
PROSPECT FACTS: ${knownFacts}

SCORING GUIDE (how much to ADD or SUBTRACT from current score):
- Prospect shows curiosity or asks follow-up: add 4 to 8 points
- Prospect admits a problem or shares personal situation: add 8 to 12 points  
- Prospect asks about process or how it works: add 10 to 15 points
- Prospect mentions money or capital amounts: add 12 to 18 points
- Prospect asks about next steps or is ready to proceed: add 15 to 20 points
- Prospect is dismissive or hostile: subtract 2 to 5 points
- Prospect gives neutral one-word answer: add 0 points

CRITICAL RULES:
1. Calculate the FINAL score yourself. Example: if current score is 4 and you add 8, output 12. NOT "4+8".
2. The "score" field must be a single integer. NOT a formula. NOT an expression. Just one number.
3. Score must be between 0 and 100.
4. Output ONLY valid JSON. Nothing else. No explanation.

FORMAT (output exactly this, replacing values with actual numbers):
{"score":12,"delta":8,"signal":"admits_pain","signal_type":"pain"}`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 80,
          system: scoringPrompt,
          messages: [
            { role: 'user', content: `Prospect: "${userSpeech}"\nSales rep: "${aiText}"\n\nReturn the JSON score now.` }
          ]
        })
      });

      if (!response.ok) {
        console.error('[Scoring] ❌ Haiku scoring API error');
        return;
      }

      const data = await response.json();
      if (!data.content || !data.content[0]) return;

      const scoreText = data.content[0].text || '';
      const jsonMatch = scoreText.match(/\{[^{}]*"score"[^{}]*\}/);
      
      if (jsonMatch) {
        const scoreData = JSON.parse(jsonMatch[0]);
        const newScore = Math.min(100, Math.max(0, parseInt(scoreData.score)));
        const oldScore = callData.intentScore;
        callData.intentScore = newScore;

        console.log(`[Scoring] ✅ Haiku scored: ${oldScore} → ${newScore} (${scoreData.signal})`);

        // Track peak
        if (newScore > callData.intentScorePeak) {
          callData.intentScorePeak = newScore;
        }

        // Track engagement
        if (callData.conversationHistory.length > 1) {
          callData.engagementSignals.call_answered = true;
          callData.engagementSignals.meaningful_conversation = true;
        }

        if (scoreData.signal) {
          const signal = scoreData.signal.toLowerCase();
          if (callData.leadType === 'B2B') {
            this._extractB2BSignals(signal, callData);
          } else {
            this._extractB2CSignals(signal, callData);
          }
          if (signal.includes('question')) {
            callData.engagementSignals.asked_questions = true;
          }
        }

        // Broadcast score update to dashboard
        if (wsServer) {
          const signals = [];
          if (scoreData.signal) {
            signals.push({
              type: scoreData.signal_type || 'neutral',
              label: scoreData.signal,
              delta: scoreData.delta || 0
            });
          }
          wsServer.broadcast({
            type: 'callUpdate',
            callSid: callData.callSid,
            intentScore: newScore,
            signals
          });
        }

        // Update Zoho
        if (callData.leadId && this.zoho.isEnabled()) {
          this.zoho.updateIntentScore(callData.leadId, newScore, 0)
            .catch(err => console.error('[Scoring] Zoho update failed:', err.message));
        }
      }
    } catch (error) {
      console.error('[Scoring] ❌ Async scoring error:', error.message);
    }
  }

  // ⚡ SMART TOKEN ALLOCATION
  _getOptimalTokens(callData, userSpeech) {
    const turnCount = callData.conversationHistory.length / 2;
    const userWordCount = userSpeech.split(' ').length;
    const intentScore = callData.intentScore || 0;

    // ✅ B2C: SONNET NEEDS MORE ROOM FOR NATURAL CONVERSATION
    // WHY: 25-word ceiling removed. Sonnet generates 2-3 natural sentences (~40-60 words)
    // plus JSON scoring block (~30 tokens). These limits prevent rambling while allowing flow.
    if (callData.leadType === 'B2C') {
      if (intentScore < 30) return 150;  // Cold: 2-3 sentences, no JSON needed
      if (intentScore < 60) return 180;  // Warm: Slightly longer for rapport
      if (intentScore < 75) return 220;  // Hot: Objection handling needs room
      return 180;  // SQL: Clean close + logistics
    }

    // B2B: Allow longer responses (existing logic)
    if (turnCount <= 1) return 180;
    if (userWordCount > 30) return 350;
    if (intentScore >= 60) return 300;

    const objectionKeywords = ['but', 'however', 'concern', 'worried', 'expensive', 'not sure', 'think about'];
    const hasObjection = objectionKeywords.some(kw => userSpeech.toLowerCase().includes(kw));
    if (hasObjection) return 320;

    if (userWordCount < 5) return 150;

    return 220;
  }

  // ═══════════════════════════════════════════════════════════
  // PROMPT SELECTOR - LEAD_TYPE FIRST (CHATGPT ALIGNED)
  // ═══════════════════════════════════════════════════════════
  _selectPromptByLeadType(callData) {
    const { leadType, callType, prospectName, region, traderProfile, zohoLead } = callData;
    
    if (leadType === 'B2B') {
      console.log('[Twilio] 🎯 Using B2B prompt (Sales360 client acquisition)');
      return this._buildB2BPrompt(callData);
    } else if (leadType === 'B2C') {
      // SALES360 MASTER PROMPT V3 — Sonnet-Powered
      console.log('[Twilio] 🎯 Using SALES360 MASTER PROMPT V3 (Sonnet-Powered)');

      const regionMap = {
        'Nigeria': 'nigeria',
        'United Kingdom': 'uk',
        'UK': 'uk',
        'Dubai': 'uae',
        'UAE': 'uae',
        'South Africa': 'nigeria'
      };
      const mappedRegion = regionMap[region] || 'nigeria';

      console.log(`[Twilio] 🌍 Region: ${region} → ${mappedRegion}`);
      console.log(`[Twilio] 📊 IntentScore: ${callData.intentScore || 0} | Stage: ${zohoLead?.stage || 'Cold'}`);

      return Sales360MasterPromptV2.buildPrompt({
        region: mappedRegion,
        brokerName: zohoLead?.brokerName || 'HFM',
        name: prospectName,
        age: traderProfile?.age || 30,
        city: zohoLead?.city || region,
        callType: callType || 'Outbound Follow-up',
        intentScore: callData.intentScore || 0,
        source: zohoLead?.leadSource || '',
        product: zohoLead?.interestedServices?.join(', ') || 'FX Trading',
        experience: traderProfile?.experience || 'Beginner',
        pain: zohoLead?.currentChallenges || '',
        capital: zohoLead?.budgetReadiness || '',
        lastAction: zohoLead?.lastTouchAt || '',
        market: 'FX Brokerage'
      });
    } else {
      console.warn('[Twilio] ⚠️ Unknown Lead_Type, defaulting to B2B prompt');
      return this._buildB2BPrompt(callData);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // B2B PROMPT (Sales360 Direct Client Acquisition)
  // ═══════════════════════════════════════════════════════════
  _buildB2BPrompt(callData) {
    const { prospectName, callType, zohoLead } = callData;
    
    let buyerContext = 'corporate';
    let contextReason = 'default';
    
    if (zohoLead) {
      const businessSize = (zohoLead.businessSize || '').toLowerCase();
      const company = (zohoLead.company || '').toLowerCase();
      const prospectNameLower = prospectName.toLowerCase();
      const monthlyLeads = zohoLead.monthlyLeadsVolume || 0;
      
      if (businessSize.includes('solo') || businessSize.includes('individual')) {
        buyerContext = 'solo';
        contextReason = 'business_size_solo';
      }
      else if (company === '' || !zohoLead.company) {
        buyerContext = 'solo';
        contextReason = 'company_empty';
      }
      else if (company === prospectNameLower || company.includes(prospectNameLower.split(' ')[0])) {
        buyerContext = 'solo';
        contextReason = 'company_matches_name';
      }
      else if (monthlyLeads < 50 && (businessSize === '' || company.length < 5)) {
        buyerContext = 'solo';
        contextReason = 'low_volume_no_company_signals';
      }
      
      console.log(`[Twilio] 🎯 B2B Context: ${buyerContext.toUpperCase()} (Reason: ${contextReason})`);
    } else {
      console.log(`[Twilio] 🎯 B2B Context: CORPORATE (No Zoho data - defaulting to corporate)`);
    }
    
    callData.buyerContext = buyerContext;
    
    const isSolo = (buyerContext === 'solo');
    
    let prompt = `You are a Sales360 AI Sales Agent calling ${prospectName}, a potential B2B client.

CRITICAL: This is a B2B SALES CALL. You are selling Sales360's AI calling system.

${isSolo ? 
`CONTEXT: SOLO PRACTITIONER / INDIVIDUAL BUYER
${prospectName} appears to be an individual running their own operation, not part of a large corporate team. Adjust your pitch accordingly:
- Focus on AUTOMATION (do more with less)
- Emphasize TIME SAVINGS (get your life back)
- Highlight EASE OF USE (no technical team needed)
- Position as COMPETITIVE ADVANTAGE (compete with bigger players)` 
: 
`CONTEXT: CORPORATE / TEAM BUYER
${prospectName} is part of a larger organization with a team. Focus on:
- TEAM EFFICIENCY (scale without headcount)
- REVENUE IMPACT (ROI, pipeline velocity)
- INTEGRATION (fits existing CRM/tech stack)
- ENTERPRISE VALUE (compliance, reporting, analytics)`}

After EVERY response, append JSON:
{"score":<integer>,"delta":<integer>,"signal":"<short label>","signal_type":"<pain|intent|buy|neutral>"}

Start: ${zohoLead ? zohoLead.intentScore : 28}. Max change: 20.`;

    return prompt;
  }

  // ═══════════════════════════════════════════════════════════
  // B2C PROMPT (Legacy - kept for compatibility)
  // ═══════════════════════════════════════════════════════════
  _buildB2CPrompt(prospectName, callType, region, zohoLead) {
    return `You are an AI sales assistant for a forex brokerage calling ${prospectName}.
    
After EVERY response, append JSON:
{"score":<integer>,"delta":<integer>,"signal":"<short label>","signal_type":"<pain|intent|buy|neutral>"}

Start: ${zohoLead ? zohoLead.intentScore : 22}. Max change: 20.`;
  }

  // ═══════════════════════════════════════════════════════════
  // DYNAMIC B2C PROMPT (Trader profiling)
  // ═══════════════════════════════════════════════════════════
  _buildDynamicPrompt(prospectName, callType, traderProfile, zohoLead) {
    const { age, gender, region, product, experience, leadType, communicationStyle } = traderProfile;
    
    let crmContext = '';
    if (zohoLead) {
      crmContext = `CRM CONTEXT: IntentScore: ${zohoLead.intentScore}. Last touch: ${zohoLead.lastTouchAt || 'none'}.`;
    }
    
    let culturalContext = '';
    if (region === 'Nigeria') {
      if (age > 45) {
        culturalContext = `CULTURAL CONTEXT: Nigeria — MATURE demographic (46+). Use respectful elder address: "Sir", "Chief". Patient, trust-building approach.`;
      } else {
        culturalContext = `CULTURAL CONTEXT: Nigeria — Mid demographic. Professional but warm. WhatsApp-first culture.`;
      }
    } else if (region === 'United Kingdom' || region === 'UK') {
      culturalContext = `CULTURAL CONTEXT: UK — Professional, clear communication. GDPR-compliant.`;
    } else if (region === 'Dubai' || region === 'UAE') {
      culturalContext = `CULTURAL CONTEXT: Dubai — Fast-paced, prestige-focused. Time is money.`;
    }

    let startScore = 20;
    if (leadType === 'inbound_hot') startScore = 38;
    else if (leadType === 'inbound_warm') startScore = 28;
    else if (leadType === 'outbound_targeted') startScore = 23;
    else if (leadType === 'outbound_cold') startScore = 15;

    if (experience === 'advanced') startScore += 7;
    else if (experience === 'beginner') startScore -= 2;

    const timeOfDay = new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening';
    let opening = '';
    
    if (leadType === 'inbound_warm') {
      opening = `Good ${timeOfDay}, ${prospectName}! This is the AI assistant from HFM. I'm following up on your inquiry about ${product}. Do you have a moment?`;
    } else {
      opening = `Hi ${prospectName}! This is the AI assistant from HFM. Are you trading right now, or is it something you've been curious about?`;
    }

    return `You are an AI sales assistant for a forex brokerage calling ${prospectName} (${age}, ${region}).

${culturalContext}
${crmContext}

CALL TYPE: ${leadType}
EXPERIENCE: ${experience}

After EVERY response, append JSON:
{"score":<integer>,"delta":<integer>,"signal":"<short label>","signal_type":"<pain|intent|buy|neutral>"}

Start: ${startScore}. Max change: 20.

OPENING: "${opening}"`;
  }

  // ═══════════════════════════════════════════════════════════
  // HELPER METHODS
  // ═══════════════════════════════════════════════════════════
  
  _getStartingScore(scenario, traderProfile, zohoLead) {
    if (zohoLead && zohoLead.intentScore > 0) {
      return zohoLead.intentScore;
    }
    
    if (traderProfile) {
      const { leadType, experience } = traderProfile;
      let score = 20;
      
      if (leadType === 'inbound_hot') score = 38;
      else if (leadType === 'inbound_warm') score = 28;
      else if (leadType === 'outbound_cold') score = 15;
      
      if (experience === 'advanced') score += 7;
      else if (experience === 'beginner') score -= 2;
      
      return score;
    }
    
    const scores = { 'broker': 28, 'trader': 22 };
    return scores[scenario] || 25;
  }

  _getGreeting(scenario, name, region) {
    // ✅ FIX: Skip honorifics (Mr. Mrs. Dr. Chief etc.)
    const HONORIFICS = ['Mr.','Mrs.','Ms.','Miss','Dr.','Prof.','Chief','Alhaji','Alhaja','Sir'];
    const nameParts = name.trim().split(' ');
    const firstName = HONORIFICS.includes(nameParts[0]) 
      ? (nameParts[1] || nameParts[0]) 
      : nameParts[0];
    const normalizedRegion = (region || '').toLowerCase();

    if (scenario === 'broker') {
      // B2B — always professional, no AI mention
      return `Good afternoon ${firstName}, this is Samuel from Sales360. I'm calling following your enquiry about reducing trader churn. Do you have a moment?`;
    }

    // B2C — region-aware, never mention AI for Nigeria/UAE
    if (normalizedRegion.includes('nigeria')) {
      return `Hey ${firstName}! This is Emeka from HFM. I saw you signed up with us but haven't activated your account yet. What's up with that?`;
    } else if (normalizedRegion.includes('dubai') || normalizedRegion.includes('uae')) {
      return `Good afternoon ${firstName}, this is Omar from HFM. I'm calling about your recent registration with us. Is now a good time for a quick chat?`;
    } else {
      // UK and others — transparent about being AI assistant
      return `Hi ${firstName}, this is James, the AI assistant from HFM. I'm following up on your recent signup. Is now a good time for a quick chat?`;
    }
  }

  _getDynamicGreeting(name, traderProfile) {
    const { age, region, leadType, gender } = traderProfile;
    const HONORIFICS = ['Mr.','Mrs.','Ms.','Miss','Dr.','Prof.','Chief','Alhaji','Alhaja','Sir'];
    const _nameParts = name.trim().split(' ');
    const firstName = HONORIFICS.includes(_nameParts[0]) 
      ? (_nameParts[1] || _nameParts[0]) 
      : _nameParts[0];
    const timeOfDay = new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening';
    const normalizedRegion = (region || '').toLowerCase();

    // ═══════════════════════════════════════════════════
    // NIGERIA — Never mention AI. Warm, human, peer-level
    // ═══════════════════════════════════════════════════
    if (normalizedRegion.includes('nigeria')) {
      if (age > 45) {
        // Senior Nigerian — respectful, formal opener
        return `Good ${timeOfDay}. Am I speaking with ${name}?`;
      } else if (leadType === 'inbound_warm' || leadType === 'Warm Lead') {
        // Young warm Nigerian — casual, energetic
        return `Hey ${firstName}! This is Emeka from HFM. I saw you signed up with us couple days back — what's been going on?`;
      } else {
        // Young cold Nigerian — friendly cold opener
        return `Hey ${firstName}, this is Emeka from HFM. How you doing today, bro?`;
      }
    }

    // ═══════════════════════════════════════════════════
    // UAE/DUBAI — Never mention AI. Premium, confident
    // ═══════════════════════════════════════════════════
    if (normalizedRegion.includes('dubai') || normalizedRegion.includes('uae')) {
      return `Good ${timeOfDay} ${firstName}, this is Omar from HFM. I'm calling regarding your account with us. Do you have two minutes?`;
    }

    // ═══════════════════════════════════════════════════
    // UK — Transparent AI mention is fine. Professional.
    // ═══════════════════════════════════════════════════
    if (leadType === 'inbound_warm' || leadType === 'Warm Lead') {
      return `Good ${timeOfDay} ${firstName}, this is James, the AI assistant from HFM. I'm following up on your recent enquiry. Is now a good time?`;
    } else if (age > 45) {
      return `Good ${timeOfDay}. Am I speaking with ${name}?`;
    } else {
      return `Hi ${firstName}, this is James from HFM. Are you free for a quick chat about your trading goals?`;
    }
  }

  getCallData(callSid) {
    return this.activeCalls.get(callSid);
  }

  handleStatus(callSid, status) {
    console.log(`[Twilio Service] Call ${callSid} status: ${status}`);
    
    if (status === 'completed') {
      const callData = this.activeCalls.get(callSid);
      if (callData) {
        callData.endTime = new Date().toISOString();
        const duration = Math.floor((new Date(callData.endTime) - new Date(callData.startTime)) / 1000);
        console.log(`[Twilio] Call ended. Duration: ${duration}s`);
        
        // ═══════════════════════════════════════════════════════════
        // CALL COMPLETION SYSTEM — Auto-retry dropped/incomplete calls
        // ═══════════════════════════════════════════════════════════
        const turnCount = callData.turnCount || 0;
        const retryCount = callData.retryCount || 0;
        const maxRetries = 2;
        const isIncomplete = duration < 90 && turnCount < 3;
        const wasBusy = callData.callbackRequested === true;
        const wasSilenceTimeout = callData.callEndReason === 'silence_timeout';
        const wasAiTimeout = callData.callEndReason === 'ai_timeout';

        if ((isIncomplete || wasBusy || wasSilenceTimeout || wasAiTimeout) && retryCount < maxRetries) {
          const retryDelayMs = wasBusy ? 30 * 60 * 1000 : 15 * 60 * 1000;
          const retryDelayMins = Math.round(retryDelayMs / 60000);
          const reason = wasBusy ? 'prospect_busy' : wasSilenceTimeout ? 'silence_timeout' : wasAiTimeout ? 'ai_timeout' : 'incomplete_call';
          
          console.log(`[Call Completion] 🔄 Scheduling retry #${retryCount + 1} in ${retryDelayMins} mins`);
          console.log(`[Call Completion]    Reason: ${reason}`);
          console.log(`[Call Completion]    Duration: ${duration}s, Turns: ${turnCount}, Retries: ${retryCount}/${maxRetries}`);

          this._scheduleRetryCall(callData, retryDelayMs, retryCount + 1);
        } else if (retryCount >= maxRetries) {
          console.log(`[Call Completion] ❌ Max retries (${maxRetries}) reached for ${callData.prospectName}. No more attempts.`);
        }

        if (callData.leadId && this.zoho.isEnabled()) {
          console.log(`[Twilio] Building post-call payload for lead: ${callData.leadId}`);
          
          let callOutcome = 'needs_nurture';
          if (callData.engagementSignals.demo_requested) callOutcome = 'demo_requested';
          else if (callData.intentScore >= 75) callOutcome = 'qualified_for_sales';
          else if (callData.intentScore >= 30) callOutcome = 'interested';
          
          const postCallPayload = {
            lead_id: callData.leadId,
            lead_type: callData.leadType,
            call_type: callData.callType,
            buyer_context: callData.buyerContext || 'corporate',
            call_id: callSid,
            call_timestamp: callData.startTime,
            call_duration_seconds: duration,
            last_agent: "Claude_AI_Call_Agent",
            last_touch_channel: "AI Call",
            call_status: 'answered',
            call_outcome: callOutcome,
            last_outcome: callOutcome,
            intent_score_start: callData.intentScoreStart,
            intent_score_final: callData.intentScore,
            intent_score_peak: callData.intentScorePeak,
            behaviour_score_start: callData.behaviourScoreStart,
            behaviour_score_final: callData.behaviourScore,
            behaviour_score_delta: callData.behaviourScoreDelta,
            engagement_signals: callData.engagementSignals,
            detected_pain_points: callData.detectedPainPoints,
            objections: callData.objections,
            buying_signals: callData.buyingSignals
          };
          
          this.zoho.triggerSmartCore(postCallPayload)
            .then(success => {
              if (success) console.log(`[Twilio] ✅ SmartCore triggered`);
            })
            .catch(err => console.error(`[Twilio] ❌ SmartCore error:`, err.message));
        }
      }
    }
  }

  handleStatusUpdate(callSid, status, body) {
    return this.handleStatus(callSid, status);
  }

  // ═══════════════════════════════════════════════════════════
  // CALL COMPLETION — Schedule retry call after delay
  // Handles: dropped calls, silence timeouts, busy prospects
  // ═══════════════════════════════════════════════════════════
  _scheduleRetryCall(originalCallData, delayMs, retryNumber) {
    const { leadId, prospectName, region, leadType } = originalCallData;
    const phone = originalCallData.zohoLead?.phone || null;
    
    if (!phone || !leadId) {
      console.error('[Call Completion] ❌ Cannot schedule retry — missing phone or leadId');
      return;
    }

    setTimeout(async () => {
      try {
        console.log(`[Call Completion] 📞 Firing retry #${retryNumber} for ${prospectName} (${phone})`);
        
        // Re-initiate the call with retry count passed through
        await this.initiateCall({
          leadId,
          phone,
          name: prospectName,
          region,
          leadType,
          intentScore: originalCallData.intentScore || 0,
          retryCount: retryNumber
        });
        
        console.log(`[Call Completion] ✅ Retry #${retryNumber} initiated for ${prospectName}`);
      } catch (error) {
        console.error(`[Call Completion] ❌ Retry #${retryNumber} failed for ${prospectName}:`, error.message);
      }
    }, delayMs);
    
    console.log(`[Call Completion] ⏰ Timer set: ${prospectName} will be called in ${Math.round(delayMs / 60000)} minutes`);
  }

  async processUserResponse(callSid, speechResult, wsServer) {
    return await this.handleGather(callSid, speechResult, wsServer);
  }

  getActiveCalls() {
    const calls = [];
    this.activeCalls.forEach((data, sid) => {
      calls.push({
        sid,
        prospectName: data.prospectName,
        region: data.region,
        intentScore: data.intentScore,
        startTime: data.startTime
      });
    });
    return calls;
  }

  getCallDetails(callSid) {
    return this.activeCalls.get(callSid);
  }

  async endCall(callSid) {
    try {
      await this.client.calls(callSid).update({ status: 'completed' });
      return { success: true, message: `Call ${callSid} ended` };
    } catch (error) {
      console.error('[Twilio] Error ending call:', error);
      return { success: false, error: error.message };
    }
  }

  handleRecording(callSid, recordingUrl, recordingSid) {
    console.log(`[Twilio] Recording available for: ${callSid}`);
    console.log(`[Twilio] URL: ${recordingUrl}`);
  }

  // ═══════════════════════════════════════════════════════════
  // B2B SIGNAL DETECTION
  // ═══════════════════════════════════════════════════════════
  _extractB2BSignals(signal, callData) {
    const b2bPainPoints = {
      'revenue leak': 'revenue_leakage_pain',
      'follow': 'lead_follow_up_failure',
      'manual call': 'manual_calling_bottleneck',
      'inconsistent': 'inconsistent_sales_process'
    };
    
    for (const [keyword, painPoint] of Object.entries(b2bPainPoints)) {
      if (signal.includes(keyword) && !callData.detectedPainPoints.includes(painPoint)) {
        callData.detectedPainPoints.push(painPoint);
        break;
      }
    }
    
    if (signal.includes('demo') || signal.includes('pilot')) {
      if (!callData.buyingSignals.includes('demo_requested')) callData.buyingSignals.push('demo_requested');
      callData.engagementSignals.demo_requested = true;
    }
    if (signal.includes('price') || signal.includes('cost') || signal.includes('roi')) {
      if (!callData.buyingSignals.includes('pricing_discussed')) callData.buyingSignals.push('pricing_discussed');
      callData.engagementSignals.pricing_discussed = true;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // B2C SIGNAL DETECTION
  // ═══════════════════════════════════════════════════════════
  _extractB2CSignals(signal, callData) {
    const b2cNeeds = {
      'account setup': 'account_setup_interest',
      'trading': 'trading_interest',
      'spread': 'spreads_or_fees_question',
      'deposit': 'funding_question'
    };
    
    for (const [keyword, need] of Object.entries(b2cNeeds)) {
      if (signal.includes(keyword) && !callData.detectedPainPoints.includes(need)) {
        callData.detectedPainPoints.push(need);
        break;
      }
    }
    
    if (signal.includes('open account') || signal.includes('sign up')) {
      if (!callData.buyingSignals.includes('wants_to_open_account')) callData.buyingSignals.push('wants_to_open_account');
    }
    if (signal.includes('callback')) {
      if (!callData.buyingSignals.includes('requested_callback')) callData.buyingSignals.push('requested_callback');
      callData.engagementSignals.callback_requested = true;
    }
  }
}

module.exports = TwilioService;
