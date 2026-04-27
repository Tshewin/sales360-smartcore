// ═══════════════════════════════════════════════════════════
// SALES360 TWILIO SERVICE - WITH ELEVENLABS VOICE CLONING
// + DYNAMIC TRADER PROFILING (Phase 3A)
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
  // MAKE OUTBOUND CALL (UPDATED FOR TRADER PROFILING)
  // ═══════════════════════════════════════════════════════════
  async makeCall({ to, prospectName, region, scenario, callType, traderProfile }) {
    try {
      // Support both old and new API
      const actualCallType = callType || scenario || 'broker';
      const actualRegion = region || (traderProfile ? traderProfile.region : 'UK');
      
      const callData = {
        prospectName,
        region: actualRegion,
        scenario: actualCallType,
        traderProfile: traderProfile || null, // NEW: Store trader profile
        conversationHistory: [],
        startTime: new Date().toISOString(),
        intentScore: this._getStartingScore(actualCallType, traderProfile)
      };

      console.log(`[Twilio Service] 📞 Initiating call to ${prospectName}`);
      if (traderProfile) {
        console.log(`[Twilio Service] 👤 Trader Profile:`, JSON.stringify(traderProfile, null, 2));
      }

      // Build webhook URL with all parameters
      const webhookParams = new URLSearchParams({
        prospectName,
        region: actualRegion,
        scenario: actualCallType
      });
      
      // If trader profile exists, add it
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

      this.activeCalls.set(call.sid, callData);
      
      console.log(`[Twilio Service] ✅ Call initiated: ${call.sid}`);
      console.log(`[Twilio Service]    To: ${to}`);
      console.log(`[Twilio Service]    Type: ${actualCallType}`);
      console.log(`[Twilio Service]    Region: ${actualRegion}`);

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
  // GENERATE OPENING GREETING (WITH ELEVENLABS + DYNAMIC PROFILING!)
  // ═══════════════════════════════════════════════════════════
  async generateGreetingTwiML(prospectName, region, scenario, traderProfile = null) {
    const startTime = Date.now();
    const twiml = new VoiceResponse();
    
    // Use dynamic greeting if trader profile exists
    const greeting = traderProfile 
      ? this._getDynamicGreeting(prospectName, traderProfile)
      : this._getGreeting(scenario, prospectName, region);
    
    // ⚡ OPTIMIZATION: Check cache first
    const cacheKey = traderProfile 
      ? `${traderProfile.leadType}-${traderProfile.age}-${traderProfile.region}`
      : `${scenario}-${region}`;
    
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
    twiml.pause({ length: 0.5 });

    // Get AI response from Claude (with dynamic profiling)
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
        signals.push({
          type: aiResponse.signalType || 'neutral',
          label: aiResponse.signal,
          delta: aiResponse.delta || 0
        });
      }

      wsServer.broadcast({
        type: 'callUpdate',
        callSid,
        intentScore: aiResponse.score,
        signals,
        transcript: {
          role: 'assistant',
          text: aiResponse.text
        }
      });
    }

    // Generate audio with ElevenLabs
    const audioBuffer = await this.elevenLabs.generateAudio(
      aiResponse.text, 
      callData.region, 
      'Male'
    );

    if (audioBuffer) {
      const audioUrl = await this.storage.uploadAudio(audioBuffer, 'response');
      const elapsedTime = Date.now() - startTime;
      console.log(`[Twilio Service] ✅ Full response generated in ${elapsedTime}ms`);
      
      twiml.play(audioUrl);
    } else {
      console.log('[Twilio Service] ⚠️  Falling back to AWS Polly for response');
      twiml.say({
        voice: 'Polly.Matthew',
        language: 'en-GB'
      }, aiResponse.text);
    }

    // Continue gathering
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

  // ═══════════════════════════════════════════════════════════
  // GET CLAUDE RESPONSE (WITH DYNAMIC PROMPTING!)
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

      // ⚡ BUILD DYNAMIC SYSTEM PROMPT
      const systemPrompt = callData.traderProfile
        ? this._buildDynamicPrompt(callData.prospectName, callData.scenario, callData.traderProfile)
        : this._getSystemPrompt(callData.scenario, callData.prospectName, callData.region);

      console.log(`[Claude API] 📤 Sending request (turn ${callData.conversationHistory.length / 2})`);
      console.log(`[Claude API] 📊 Current IntentScore: ${callData.intentScore}`);
      if (callData.traderProfile) {
        console.log(`[Claude API] 👤 Profile: ${callData.traderProfile.age}yo ${callData.traderProfile.region} ${callData.traderProfile.experience}`);
      }

      const maxTokens = this._getOptimalTokens(callData, userSpeech);
      console.log(`[Claude API] 🎯 Using ${maxTokens} tokens for this response`);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
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
          signalType: scoreData ? scoreData.signal_type : null,
          delta: scoreData ? scoreData.delta : null
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
    const turnCount = callData.conversationHistory.length / 2;
    const userWordCount = userSpeech.split(' ').length;
    const intentScore = callData.intentScore || 0;

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
  // DYNAMIC PROMPT BUILDER (NEW FOR PHASE 3A)
  // ═══════════════════════════════════════════════════════════
  _buildDynamicPrompt(prospectName, callType, traderProfile) {
    const { age, gender, region, product, experience, leadType, communicationStyle } = traderProfile;

    // Cultural context
    let culturalContext = '';
    if (region === 'Nigeria') {
      if (age < 30) {
        culturalContext = `CULTURAL CONTEXT: Nigeria — Young demographic (22-30). Use friendly, relatable tone. "Bro" energy is fine. WhatsApp-first culture. Casual but respectful.`;
      } else if (age > 45) {
        culturalContext = `CULTURAL CONTEXT: Nigeria — MATURE demographic (46+). Use respectful elder address: "Sir", "Chief" (if title known). Patience is key. Build trust slowly. Very respectful tone.`;
      } else {
        culturalContext = `CULTURAL CONTEXT: Nigeria — Mid demographic (31-45). Professional but warm. WhatsApp-first culture. Balanced approach.`;
      }
    } else if (region === 'United Kingdom' || region === 'UK') {
      culturalContext = `CULTURAL CONTEXT: UK — Professional, clear communication. ${age > 40 ? 'Senior professional' : 'Mid-career professional'}. GDPR-compliant. Email-first culture.`;
    } else if (region === 'Dubai' || region === 'UAE') {
      culturalContext = `CULTURAL CONTEXT: Dubai — Fast-paced, prestige-focused. Respect wealth and status. DIFC-compliant. Time is money — be efficient.`;
    } else if (region === 'South Africa') {
      culturalContext = `CULTURAL CONTEXT: South Africa — Direct, honest communication. Values results over fluff.`;
    }

    // Starting score logic
    let startScore = 20;
    if (leadType === 'inbound_hot') startScore = 38;
    else if (leadType === 'inbound_warm') startScore = 28;
    else if (leadType === 'outbound_targeted') startScore = 23;
    else if (leadType === 'outbound_cold') startScore = 15;
    else if (leadType === 'retention') startScore = 20;

    if (experience === 'advanced') startScore += 7;
    else if (experience === 'beginner') startScore -= 2;

    // Opening hook
    const timeOfDay = new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening';
    let opening = '';
    
    if (leadType === 'inbound_warm') {
      opening = `Good ${timeOfDay}, ${prospectName}! This is the AI assistant from HFM. I'm following up on your recent inquiry about ${product}. Do you have a couple of minutes?`;
    } else if (leadType === 'inbound_hot') {
      opening = `Good ${timeOfDay}, ${prospectName}! This is the AI assistant from HFM. I noticed you signed up but haven't completed your first trade yet. What's holding you back?`;
    } else if (leadType === 'outbound_cold' && age > 45) {
      opening = `Good ${timeOfDay}, ${gender === 'Male' ? 'Sir' : 'Madam'}. This is the AI assistant from HFM. Am I speaking with ${prospectName}?`;
    } else {
      opening = `Hi ${prospectName}! This is the AI assistant from HFM. Quick question: are you currently trading forex, or is it something you've been curious about?`;
    }

    return `You are ${age > 45 && region === 'Nigeria' ? 'a senior sales representative' : 'an AI sales assistant'} for a forex brokerage. You're calling ${prospectName} (${age}, ${region}).

${culturalContext}

CALL TYPE: ${leadType.replace('_', ' ').toUpperCase()}
EXPERIENCE: ${experience}
COMMUNICATION STYLE: ${communicationStyle || 'balanced'}

BREVITY RULES:
- ONE idea per turn maximum
- Aim for 1-2 sentences (15-25 words max)
- Use contractions naturally
- Match prospect's energy

SALES PSYCHOLOGY:
- LISTEN FIRST — ask clarifying questions
- ${leadType === 'retention' ? 'Empathy + solutions' : 'Pre-emptive objection handling'}
- ${experience === 'beginner' ? 'Education focus' : experience === 'advanced' ? 'Performance focus' : 'Value-driven approach'}

After EVERY response, append JSON:
{"score":<integer>,"delta":<integer>,"signal":"<short label>","signal_type":"<pain|intent|buy|neutral>"}

Start: ${startScore}. Max change: 20. Never exceed 100.

OPENING LINE (use exactly this):
"${opening}"`;
  }

  // ═══════════════════════════════════════════════════════════
  // HELPER METHODS (LEGACY + NEW)
  // ═══════════════════════════════════════════════════════════
  
  _getStartingScore(scenario, traderProfile) {
    if (traderProfile) {
      // Dynamic scoring based on lead type
      const { leadType, experience } = traderProfile;
      let score = 20;
      
      if (leadType === 'inbound_hot') score = 38;
      else if (leadType === 'inbound_warm') score = 28;
      else if (leadType === 'outbound_targeted') score = 23;
      else if (leadType === 'outbound_cold') score = 15;
      else if (leadType === 'retention') score = 20;
      
      if (experience === 'advanced') score += 7;
      else if (experience === 'beginner') score -= 2;
      
      return score;
    }
    
    // Legacy scoring
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

  _getDynamicGreeting(name, traderProfile) {
    const { age, region, leadType, product } = traderProfile;
    const firstName = name.split(' ')[0];
    const timeOfDay = new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening';
    
    if (leadType === 'inbound_warm') {
      return `Good ${timeOfDay}, ${firstName}! This is the AI assistant from HFM. I'm following up on your recent inquiry about ${product}. Do you have a couple of minutes?`;
    } else if (leadType === 'inbound_hot') {
      return `Good ${timeOfDay}, ${firstName}! This is the AI assistant from HFM. I noticed you signed up but haven't completed your first trade yet. What's holding you back?`;
    } else if (leadType === 'outbound_cold' && age > 45) {
      return `Good ${timeOfDay}, ${traderProfile.gender === 'Male' ? 'Sir' : 'Madam'}. This is the AI assistant from HFM. Am I speaking with ${name}?`;
    } else {
      return `Hi ${firstName}! This is the AI assistant from HFM. Quick question: are you trading right now, or is it something you've been thinking about?`;
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

  handleStatusUpdate(callSid, status, body) {
    return this.handleStatus(callSid, status);
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
        scenario: data.scenario,
        intentScore: data.intentScore,
        startTime: data.startTime,
        endTime: data.endTime
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
