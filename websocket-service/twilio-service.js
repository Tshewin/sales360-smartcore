// ═══════════════════════════════════════════════════════════
// SALES360 TWILIO SERVICE - WITH ELEVENLABS VOICE CLONING
// Your actual voice on every AI response!
// ═══════════════════════════════════════════════════════════

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const ElevenLabsService = require('./elevenlabs-dynamic-service');
const StorageService = require('./storage-service');

class TwilioService {
  constructor(elevenLabsService = null) {
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
    
    console.log('[Twilio Service] ✅ Initialized with number:', this.phoneNumber);
    console.log('[Twilio Service] Anthropic API Key:', this.anthropicApiKey ? `YES (length: ${this.anthropicApiKey.length})` : '❌ MISSING!');
    console.log('[Twilio Service] ElevenLabs:', this.elevenLabs.isReady() ? '✅ Ready' : '⚠️  Disabled');
    console.log('[Twilio Service] Storage:', this.storage.isReady() ? '✅ Ready' : '⚠️  Using Data URI');
  }

  // ═══════════════════════════════════════════════════════════
  // MAKE OUTBOUND CALL
  // ═══════════════════════════════════════════════════════════
  async makeCall({ to, prospectName, region, scenario }) {
    try {
      const callData = {
        prospectName,
        region,
        scenario,
        conversationHistory: [],
        startTime: new Date().toISOString(),
        intentScore: this._getStartingScore(scenario)
      };

      const call = await this.client.calls.create({
        url: `${this.webhookBaseUrl}/twilio/voice?prospectName=${encodeURIComponent(prospectName)}&region=${encodeURIComponent(region)}&scenario=${encodeURIComponent(scenario)}`,
        to: to,
        from: this.phoneNumber,
        statusCallback: `${this.webhookBaseUrl}/twilio/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        record: true,
        recordingStatusCallback: `${this.webhookBaseUrl}/twilio/recording`,
        recordingStatusCallbackMethod: 'POST'
      });

      this.activeCalls.set(call.sid, callData);
      
      console.log(`[Twilio Service] 📞 Call initiated: ${call.sid}`);
      console.log(`[Twilio Service]    To: ${to}`);
      console.log(`[Twilio Service]    Region: ${region}`);
      console.log(`[Twilio Service]    Scenario: ${scenario}`);

      return {
        success: true,
        callSid: call.sid,
        status: call.status,
        to: call.to,
        from: this.phoneNumber
      };
    } catch (error) {
      console.error('[Twilio Service] ❌ Error making call:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // GENERATE OPENING GREETING (WITH ELEVENLABS + CACHING!)
  // ═══════════════════════════════════════════════════════════
  async generateGreetingTwiML(prospectName, region, scenario) {
    const startTime = Date.now();
    const twiml = new VoiceResponse();
    const greeting = this._getGreeting(scenario, prospectName, region);
    
    // ⚡ OPTIMIZATION: Check cache first
    const cacheKey = `${scenario}-${region}`;
    
    console.log(`[Twilio Service] 🎤 Generating greeting...`);
    console.log(`[Twilio Service]    Cache key: ${cacheKey}`);
    
    let audioUrl = this.greetingCache.get(cacheKey);
    
    if (audioUrl) {
      console.log(`[Twilio Service] ⚡ Using cached greeting (instant!)`);
      twiml.play(audioUrl);
    } else {
      // Generate new audio with ElevenLabs
      const audioBuffer = await this.elevenLabs.generateAudio(greeting, region, 'Male');
      
      if (audioBuffer) {
        // Upload to storage
        audioUrl = await this.storage.uploadAudio(audioBuffer, 'greeting');
        
        // ⚡ CACHE IT (1 hour TTL)
        this.greetingCache.set(cacheKey, audioUrl);
        setTimeout(() => this.greetingCache.delete(cacheKey), 3600000);
        
        const elapsedTime = Date.now() - startTime;
        console.log(`[Twilio Service] ✅ Greeting generated in ${elapsedTime}ms`);
        twiml.play(audioUrl);
      } else {
        // Fallback to AWS Polly
        console.log('[Twilio Service] ⚠️  Falling back to AWS Polly');
        twiml.say({
          voice: 'Polly.Matthew',
          language: 'en-GB'
        }, greeting);
      }
    }

    // Gather user response (⚡ INCREASED TIMEOUT to 60s)
    const gather = twiml.gather({
      input: 'speech',
      action: `${this.webhookBaseUrl}/twilio/gather`,
      method: 'POST',
      timeout: 60,  // ⚡ INCREASED from default 10s
      speechTimeout: 'auto',
      speechModel: 'phone_call',
      enhanced: true,
      language: 'en-GB'
    });

    gather.pause({ length: 1 });

    return twiml.toString();
  }

  // ═══════════════════════════════════════════════════════════
  // HANDLE USER RESPONSE (WITH ELEVENLABS + OPTIMIZATIONS!)
  // ═══════════════════════════════════════════════════════════
  async handleGather(callSid, speechResult, wsServer) {
    const startTime = Date.now();
    const twiml = new VoiceResponse();
    const callData = this.activeCalls.get(callSid);

    if (!callData) {
      console.error('[Twilio Webhook] ❌ No call data found for:', callSid);
      twiml.say('Sorry, there was an error. Goodbye.');
      twiml.hangup();
      return twiml.toString();
    }

    if (!speechResult || speechResult.trim().length === 0) {
      console.log('[Twilio Webhook] No speech detected, re-prompting...');
      twiml.say({ voice: 'Polly.Matthew' }, 'I didn\'t catch that. Could you please repeat?');
      
      const gather = twiml.gather({
        input: 'speech',
        action: `${this.webhookBaseUrl}/twilio/gather`,
        method: 'POST',
        timeout: 60,
        speechTimeout: 'auto',
        speechModel: 'phone_call',
        enhanced: true,
        language: 'en-GB'
      });
      gather.pause({ length: 1 });
      
      return twiml.toString();
    }

    console.log(`[Twilio Webhook] 🎤 User said: ${speechResult}`);

    // ⚡ OPTIMIZATION: Add "thinking" indicator
    // This makes the silence feel intentional, not like a bug
    twiml.pause({ length: 0.5 });

    // Get AI response from Claude (with timeout)
    const aiResponse = await this._getClaudeResponse(callData, speechResult);
    
    if (!aiResponse) {
      console.error('[Twilio Webhook] No AI response - using fallback');
      twiml.say({ voice: 'Polly.Matthew' }, 'I apologize, I\'m having trouble processing that. Let me try again.');
      
      const gather = twiml.gather({
        input: 'speech',
        action: `${this.webhookBaseUrl}/twilio/gather`,
        method: 'POST',
        timeout: 60,
        speechTimeout: 'auto',
        speechModel: 'phone_call',
        enhanced: true,
        language: 'en-GB'
      });
      gather.pause({ length: 1 });
      
      return twiml.toString();
    }

    console.log(`[Twilio Webhook] 🤖 AI response: ${aiResponse.text.substring(0, 80)}...`);

    // 🔥 BROADCAST INTENTSCORE TO DASHBOARD
    if (wsServer && aiResponse.score !== undefined) {
      const signals = [];
      if (aiResponse.signal) {
        signals.push(aiResponse.signal);
      }
      
      wsServer.broadcast({
        type: 'event',
        event: 'intentScore',
        payload: {
          score: aiResponse.score,
          signals: signals,
          callSid: callSid,
          prospectName: callData.prospectName,
          region: callData.region,
          timestamp: new Date().toISOString()
        }
      });
      
      console.log(`[WebSocket] 📊 Broadcast IntentScore: ${aiResponse.score}`);
    }

    // ⚡ PARALLEL PROCESSING: Start ElevenLabs generation immediately
    const audioPromise = this.elevenLabs.generateAudio(
      aiResponse.text, 
      callData.region, 
      'Male'
    );

    // While audio generates, prepare the rest of TwiML
    const gather = twiml.gather({
      input: 'speech',
      action: `${this.webhookBaseUrl}/twilio/gather`,
      method: 'POST',
      timeout: 60,
      speechTimeout: 'auto',
      speechModel: 'phone_call',
      enhanced: true,
      language: 'en-GB'
    });

    // ⚡ AWAIT audio generation (happens in parallel with above code)
    const audioBuffer = await audioPromise;

    if (audioBuffer) {
      // Upload to storage
      const audioUrl = await this.storage.uploadAudio(audioBuffer, callSid);
      
      const elapsedTime = Date.now() - startTime;
      console.log(`[Twilio Webhook] ✅ Complete response in ${elapsedTime}ms`);
      
      gather.play(audioUrl);
    } else {
      // Fallback to AWS Polly
      console.log('[Twilio Webhook] ⚠️  Falling back to AWS Polly');
      gather.say({
        voice: 'Polly.Matthew',
        language: 'en-GB'
      }, aiResponse.text);
    }

    gather.pause({ length: 1 });

    return twiml.toString();
  }

  // ═══════════════════════════════════════════════════════════
  // GET CLAUDE AI RESPONSE
  // ═══════════════════════════════════════════════════════════
  async _getClaudeResponse(callData, userSpeech) {
    const startTime = Date.now();
    
    try {
      callData.conversationHistory.push({
        role: 'user',
        content: userSpeech
      });

      const systemPrompt = this._getSystemPrompt(callData.scenario, callData.prospectName, callData.region);

      // ⚡ SMART TOKEN ALLOCATION based on context
      const maxTokens = this._getOptimalTokens(callData, userSpeech);

      console.log('[Claude API] 📤 Sending request...');
      console.log(`[Claude API]    Tokens: ${maxTokens} (dynamic)`);

      // Add timeout wrapper (15 seconds max)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: maxTokens,  // ⚡ DYNAMIC based on conversation stage
          temperature: 0.7,
          system: systemPrompt,
          messages: callData.conversationHistory
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Claude API] ❌ Error:', response.status, errorText);
        return null;
      }

      const data = await response.json();
      const elapsedTime = Date.now() - startTime;
      console.log(`[Claude API] ✅ Response received in ${elapsedTime}ms`);

      if (data.content && data.content[0]) {
        const fullText = data.content[0].text || '';
        const jsonMatch = fullText.match(/\{[^{}]*"score"[^{}]*\}/);
        
        let aiText = fullText;
        let scoreData = null;

        if (jsonMatch) {
          try {
            scoreData = JSON.parse(jsonMatch[0]);
            aiText = fullText.replace(jsonMatch[0], '').trim();
          } catch (e) {
            console.warn('[Claude API] Could not parse score JSON');
          }
        }

        callData.conversationHistory.push({
          role: 'assistant',
          content: fullText
        });

        if (scoreData && scoreData.score !== undefined) {
          callData.intentScore = Math.min(100, Math.max(0, parseInt(scoreData.score)));
        }

        return {
          text: aiText,
          score: callData.intentScore,
          signal: scoreData ? scoreData.signal : null,
          signalType: scoreData ? scoreData.signal_type : null
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
      
      return null;
    }
  }

  // ⚡ SMART TOKEN ALLOCATION - Balances speed vs quality
  _getOptimalTokens(callData, userSpeech) {
    const turnCount = callData.conversationHistory.length / 2; // How many exchanges
    const userWordCount = userSpeech.split(' ').length;
    const intentScore = callData.intentScore || 0;

    // RULE 1: First response = keep it short (build rapport quickly)
    if (turnCount <= 1) {
      return 180; // Fast but still professional
    }

    // RULE 2: User gave a long, detailed response = match their energy
    if (userWordCount > 30) {
      return 350; // Detailed response deserved
    }

    // RULE 3: High intent (score 60+) = invest more tokens (they're engaged!)
    if (intentScore >= 60) {
      return 300; // They're interested, give them detail
    }

    // RULE 4: Objection keywords = need detailed response
    const objectionKeywords = ['but', 'however', 'concern', 'worried', 'expensive', 'not sure', 'think about'];
    const hasObjection = objectionKeywords.some(kw => userSpeech.toLowerCase().includes(kw));
    if (hasObjection) {
      return 320; // Handle objections thoroughly
    }

    // RULE 5: Short user responses ("yes", "okay", "go on") = keep it moving
    if (userWordCount < 5) {
      return 150; // Don't over-talk, they're just acknowledging
    }

    // DEFAULT: Balanced response (good for most situations)
    return 220; // Sweet spot: professional but not slow
  }

  // ═══════════════════════════════════════════════════════════
  // HELPER METHODS (same as before)
  // ═══════════════════════════════════════════════════════════
  
  _getStartingScore(scenario) {
    const scores = {
      'broker': 28,
      'trader': 22
    };
    return scores[scenario] || 25;
  }

  _getGreeting(scenario, name, region) {
    if (scenario === 'broker') {
      return `Good afternoon ${name.split(' ')[0]}, this is Sales360 AI. I'm calling following your enquiry about reducing trader churn and improving qualification. Do you have a couple of minutes?`;
    } else {
      return `Hey ${name.split(' ')[0]}! This is Sales360 AI calling. I saw you signed up a couple days back but haven't activated your account yet. What's up with that?`;
    }
  }

  _getSystemPrompt(scenario, name, region) {
    if (scenario === 'broker') {
      return `You are the Sales360 AI Call Agent — the world's most intelligent sales system, built on 15+ years of front-line sales expertise.

You are on a live call with ${name}. They enquired about reducing trader churn and improving trader qualification.

METHODOLOGY: Buyer Persuasion Loop™ — trained on Hormozi, Suby, Cardone, Belfort.
STYLE: Professional, warm, direct. Phone call — be concise. Max 2-3 sentences per turn.
GOAL: Uncover their pain, build urgency, earn a pilot booking.
THEIR PAIN: High trader churn. Poor qualification process means losing good traders to competitors.

After EVERY response, on a NEW LINE append exactly this JSON (no markdown, no extra text):
{"score":<integer>,"delta":<integer>,"signal":"<short label>","signal_type":"<pain|intent|buy|neutral>"}

Score starts at 28. Increase for: admitting pain (+8-12), asking price/ROI (+12-18), urgency/timeline (+15-20), integration questions (+10), team buy-in "we" (+6), follow-up questions (+4-8). Decrease for dismissive short replies (-2 to 0). Max change per turn: 20. Never exceed 100.`;
    } else {
      return `You are a sales representative for HFM (a forex brokerage). You're calling ${name} who signed up 2 days ago but hasn't deposited yet.

CRITICAL: You are calling AS A HUMAN. Never say "AI assistant" or "automated system".

CULTURAL CONTEXT: ${region} — Use appropriate tone for region.

CALL TYPE: Inbound (they filled a form — you have context)

SALES PSYCHOLOGY (Hormozi + Sabri):
- LISTEN FIRST — ask clarifying questions before pitching
- Pre-emptive objection handling
- Social proof
- Micro-commitment: Verify account or try demo (not deposit)

After EVERY response, append JSON:
{"score":<integer>,"delta":<integer>,"signal":"<short label>","signal_type":"<pain|intent|buy|neutral>"}

Start: 22. Increase for: asks about account types (+8), mentions capital (+12), asks about spreads (+10), says "I want to start" (+15), asks about training (+6). Max change: 20.`;
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
      }
    }
  }

  // Alias for call-routes compatibility
  handleStatusUpdate(callSid, status, body) {
    return this.handleStatus(callSid, status);
  }

  // Process user response (wrapper for handleGather)
  async processUserResponse(callSid, speechResult, wsServer) {
    return await this.handleGather(callSid, speechResult, wsServer);
  }

  // Get active calls
  getActiveCalls() {
    const calls = [];
    this.activeCalls.forEach((data, sid) => {
      calls.push({
        sid,
        prospectName: data.prospectName,
        region: data.region,
        scenario: data.scenario,
        intentScore: data.intentScore,
        startTime: data.startTime,
        endTime: data.endTime
      });
    });
    return calls;
  }

  // Get call details
  getCallDetails(callSid) {
    return this.activeCalls.get(callSid);
  }

  // End call
  async endCall(callSid) {
    try {
      await this.client.calls(callSid).update({ status: 'completed' });
      return {
        success: true,
        message: `Call ${callSid} ended`
      };
    } catch (error) {
      console.error('[Twilio] Error ending call:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  handleRecording(callSid, recordingUrl, recordingSid) {
    console.log(`[Twilio] Recording available for call: ${callSid}`);
    console.log(`[Twilio] Recording URL: ${recordingUrl}`);
    console.log(`[Twilio] Recording SID: ${recordingSid}`);
  }
}

module.exports = TwilioService;
