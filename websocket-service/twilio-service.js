// ═══════════════════════════════════════════════════════════
// SALES360 TWILIO SERVICE - WITH ELEVENLABS VOICE CLONING
// + DYNAMIC TRADER PROFILING (Phase 3A)
// ═══════════════════════════════════════════════════════════

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const ElevenLabsService = require('./elevenlabs-dynamic-service');
const StorageService = require('./storage-service');
const ZohoService = require('./zoho-service');

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
    
    console.log('[Twilio Service] ✅ Initialized with number:', this.phoneNumber);
    console.log('[Twilio Service] Anthropic API Key:', this.anthropicApiKey ? `YES (length: ${this.anthropicApiKey.length})` : '❌ MISSING!');
    console.log('[Twilio Service] ElevenLabs:', this.elevenLabs.isReady() ? '✅ Ready' : '⚠️  Disabled');
    console.log('[Twilio Service] Storage:', this.storage.isReady() ? '✅ Ready' : '⚠️  Using Data URI');
    console.log('[Twilio Service] Zoho CRM:', this.zoho.isEnabled() ? '✅ Connected' : '⚠️  Disabled');
  }

  // ═══════════════════════════════════════════════════════════
  // MAKE OUTBOUND CALL (UPDATED FOR TRADER PROFILING)
  // ═══════════════════════════════════════════════════════════
  async makeCall({ to, prospectName, region, scenario, callType, traderProfile, leadId }) {
    try {
      // Support both old and new API
      const actualCallType = callType || scenario || 'broker';
      const actualRegion = region || (traderProfile ? traderProfile.region : 'UK');
      
      // ═══════════════════════════════════════════════════════════
      // ZOHO PRE-CALL FETCH (if leadId provided)
      // ═══════════════════════════════════════════════════════════
      let zohoLead = null;
      let leadType = 'B2B';  // ✅ DEFAULT TO B2B (Sales360's primary ICP: brokers, exchanges, agencies)
      
      if (leadId && this.zoho.isEnabled()) {
        console.log(`[Twilio Service] 📥 Fetching lead from Zoho: ${leadId}`);
        zohoLead = await this.zoho.fetchLeadForCall(leadId);
        
        if (zohoLead) {
          console.log(`[Twilio Service] ✅ Zoho lead fetched: ${zohoLead.fullName}`);
          console.log(`[Twilio Service] 📊 Lead Type: ${zohoLead.leadType || 'B2B (default)'}`);
          console.log(`[Twilio Service] 📊 Current IntentScore: ${zohoLead.intentScore}`);
          console.log(`[Twilio Service] 🎯 Stage: ${zohoLead.stage}`);
          
          // ✅ CRITICAL: Get Lead_Type for B2B/B2C branching
          // DEFAULT TO B2B if missing/empty (Sales360's primary ICP)
          leadType = zohoLead.leadType || 'B2B';
          
          // ✅ SAFEGUARD: Check for empty string and log warning
          if (!leadType || leadType.trim() === '') {
            console.warn(`[Twilio Service] ⚠️ LEAD_TYPE_MISSING for ${leadId} → Defaulted to B2B`);
            leadType = 'B2B';
          }
          
          // Enrich traderProfile with Zoho data if missing
          if (!traderProfile && zohoLead.region) {
            traderProfile = {
              age: 30, // Default
              gender: 'Male', // Default
              region: zohoLead.region,
              product: 'FX Trading', // Default
              experience: 'intermediate', // Default
              leadType: zohoLead.intentScore > 30 ? 'inbound_warm' : 'outbound_cold',
              communicationStyle: 'balanced'
            };
            console.log(`[Twilio Service] 🔄 Generated trader profile from Zoho data`);
          }
        }
      }
      
      const callData = {
        prospectName,
        region: actualRegion,
        scenario: actualCallType,
        traderProfile: traderProfile || null,
        zohoLead: zohoLead || null,
        leadId: leadId || null,
        
        // ✅ B2B/B2C CLASSIFICATION (ChatGPT aligned)
        leadType: leadType,  // B2B or B2C
        callType: actualCallType,  // broker, trader, etc.
        
        conversationHistory: [],
        startTime: new Date().toISOString(),
        intentScore: this._getStartingScore(actualCallType, traderProfile, zohoLead),
        
        // ✅ CHATGPT POST-CALL PAYLOAD: Track engagement signals
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
        
        // ✅ CHATGPT POST-CALL PAYLOAD: Track detected signals (B2B vs B2C specific)
        detectedPainPoints: [],
        objections: [],
        buyingSignals: [],
        
        // ✅ Track score progression
        intentScoreStart: this._getStartingScore(actualCallType, traderProfile, zohoLead),
        intentScorePeak: this._getStartingScore(actualCallType, traderProfile, zohoLead),
        behaviourScoreStart: zohoLead ? (zohoLead.behaviourScore || 0) : 0,
        behaviourScore: zohoLead ? (zohoLead.behaviourScore || 0) : 0,  // ✅ Current behaviour score (tracked locally)
        behaviourScoreDelta: 0
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
      // ✅ CHATGPT RULE: Lead_Type is PRIMARY branching variable
      // Hierarchy: Lead_Type → callType → traderProfile (enrichment only)
      const systemPrompt = this._selectPromptByLeadType(callData);

      console.log(`[Claude API] 📤 Sending request (turn ${callData.conversationHistory.length / 2})`);
      console.log(`[Claude API] 🎯 Lead Type: ${callData.leadType} | Call Type: ${callData.callType}`);
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
          
          // ✅ Track peak score
          if (callData.intentScore > callData.intentScorePeak) {
            callData.intentScorePeak = callData.intentScore;
          }
          
          // ✅ CHATGPT PAYLOAD: Track engagement signals based on conversation
          if (callData.conversationHistory.length > 1) {
            callData.engagementSignals.call_answered = true;
            callData.engagementSignals.meaningful_conversation = true;
          }
          
          // ✅ CHATGPT PAYLOAD: Extract signals from Claude's response
          if (scoreData.signal) {
            const signal = scoreData.signal.toLowerCase();
            
            // ✅ B2B/B2C SIGNAL DETECTION (ChatGPT aligned)
            if (callData.leadType === 'B2B') {
              this._extractB2BSignals(signal, callData);
            } else {
              this._extractB2CSignals(signal, callData);
            }
            
            // Common signals (both B2B and B2C)
            if (signal.includes('question')) {
              callData.engagementSignals.asked_questions = true;
            }
          }
          
          // ═══════════════════════════════════════════════════════════
          // ZOHO REAL-TIME SCORE UPDATE (if lead ID exists)
          // Updates SmartScore_Intent1 + SmartScore_Behaviour
          // ═══════════════════════════════════════════════════════════
          if (callData.leadId && this.zoho.isEnabled()) {
            // Calculate behaviour delta based on engagement signals
            let behaviourDelta = 0;
            
            // Engagement signals (per ChatGPT execution guide)
            if (scoreData.signal_type === 'engagement') {
              behaviourDelta = 3; // Prospect engaged (asked question, showed interest)
              callData.behaviourScoreDelta += 3;
              // ✅ RELIABILITY FIX 3: Cap BehaviourScore between 0 and 100
              callData.behaviourScore = Math.max(0, Math.min(100, callData.behaviourScore + 3));
            } else if (scoreData.signal_type === 'positive') {
              behaviourDelta = 5; // Strong positive signal
              callData.behaviourScoreDelta += 5;
              // ✅ RELIABILITY FIX 3: Cap BehaviourScore between 0 and 100
              callData.behaviourScore = Math.max(0, Math.min(100, callData.behaviourScore + 5));
            } else if (callData.conversationHistory.length > 2) {
              behaviourDelta = 1; // Call is progressing (minimal engagement)
              callData.behaviourScoreDelta += 1;
              // ✅ RELIABILITY FIX 3: Cap BehaviourScore between 0 and 100
              callData.behaviourScore = Math.max(0, Math.min(100, callData.behaviourScore + 1));
            }
            
            // ✅ OPTION B (45% OPTIMIZATION): Update IntentScore LIVE for dashboard visibility
            // BehaviourScore tracked locally, updated at call end
            // REASON: Prospects need to SEE the AI working in real-time!
            this.zoho.updateIntentScore(
              callData.leadId,
              callData.intentScore,
              0  // Behaviour tracked locally (no GET needed)
            ).catch(err => {
              // ✅ CHATGPT ENHANCEMENT: Detailed logging for fire-and-forget failures
              console.error('[Twilio] Zoho live IntentScore update failed:', {
                leadId: callData.leadId,
                intentScore: callData.intentScore,
                callSid: callData.callSid || 'unknown',
                error: err.message
              });
            });
          }
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
  // PROMPT SELECTOR - LEAD_TYPE FIRST (CHATGPT ALIGNED)
  // Hierarchy: Lead_Type → callType → traderProfile (enrichment)
  // ═══════════════════════════════════════════════════════════
  _selectPromptByLeadType(callData) {
    const { leadType, callType, prospectName, region, traderProfile, zohoLead } = callData;
    
    // ✅ PRIMARY BRANCHING: Lead_Type determines conversation mode
    if (leadType === 'B2B') {
      console.log('[Twilio] 🎯 Using B2B prompt (Sales360 client acquisition)');
      return this._buildB2BPrompt(callData);  // ✅ Pass full callData object
    } else if (leadType === 'B2C') {
      console.log('[Twilio] 🎯 Using B2C prompt (client end-user sales)');
      // traderProfile enriches B2C prompt (optional)
      return traderProfile 
        ? this._buildDynamicPrompt(prospectName, callType, traderProfile, zohoLead)
        : this._buildB2CPrompt(prospectName, callType, region, zohoLead);
    } else {
      // Fallback to B2B (default)
      console.warn('[Twilio] ⚠️ Unknown Lead_Type, defaulting to B2B prompt');
      return this._buildB2BPrompt(callData);  // ✅ Pass full callData object
    }
  }

  // ═══════════════════════════════════════════════════════════
  // B2B PROMPT (Sales360 Direct Client Acquisition)
  // Focus: Revenue leakage, sales efficiency, CRM intelligence, ROI
  // Context-aware: Detects corporate vs solo and adjusts naturally
  // ═══════════════════════════════════════════════════════════
  _buildB2BPrompt(callData) {
    const { prospectName, callType, zohoLead } = callData;
    
    // ✅ CHATGPT APPROVED: Corporate vs Solo detection
    let buyerContext = 'corporate'; // Default to corporate (Sales360's primary ICP)
    let contextReason = 'default';
    
    if (zohoLead) {
      const businessSize = (zohoLead.businessSize || '').toLowerCase();
      const company = (zohoLead.company || '').toLowerCase();
      const prospectNameLower = prospectName.toLowerCase();
      const monthlyLeads = zohoLead.monthlyLeadsVolume || 0;
      
      // ✅ CHATGPT RULE: Solo detection with explicit conditions
      // 1. Business_Size explicitly contains "solo" or "individual"
      if (businessSize.includes('solo') || businessSize.includes('individual')) {
        buyerContext = 'solo';
        contextReason = 'business_size_solo';
      }
      // 2. Company field is empty
      else if (company === '' || !zohoLead.company) {
        buyerContext = 'solo';
        contextReason = 'company_empty';
      }
      // 3. Company name closely matches Full_Name
      else if (company === prospectNameLower || company.includes(prospectNameLower.split(' ')[0])) {
        buyerContext = 'solo';
        contextReason = 'company_matches_name';
      }
      // 4. Monthly_Leads_No < 50 AND no strong company/team indicators
      else if (monthlyLeads < 50 && (businessSize === '' || company.length < 5)) {
        buyerContext = 'solo';
        contextReason = 'low_volume_no_company_signals';
      }
      
      console.log(`[Twilio] 🎯 B2B Context: ${buyerContext.toUpperCase()} (Reason: ${contextReason})`);
    } else {
      console.log(`[Twilio] 🎯 B2B Context: CORPORATE (No Zoho data - defaulting to corporate)`);
    }
    
    // ✅ CHATGPT FIX: Store on callData object (not global this._currentBuyerContext)
    // Prevents race conditions during concurrent calls
    callData.buyerContext = buyerContext;
    
    const isSolo = (buyerContext === 'solo');
    
    let prompt = `You are a Sales360 AI Sales Agent calling ${prospectName}, a potential B2B client.

CRITICAL: This is a B2B SALES CALL. You are selling Sales360's AI calling system.

${isSolo ? 
`CONTEXT: SOLO PRACTITIONER / INDIVIDUAL BUYER
This person is buying Sales360 for PERSONAL use (not a team).

LANGUAGE RULES:
- Use "YOU" not "your team"
- Say "How many prospects do YOU call?" not "How many leads does your team handle?"
- Focus on PERSONAL productivity, not team efficiency
- Reference "your time" not "your SDRs' time"
- ROI = personal time savings and income growth

FOCUS AREAS (Solo context):
- Personal sales bottleneck (how much time YOU spend on manual calling)
- Missed follow-ups (leads that fall through because YOU can't call fast enough)
- Your personal close rate and conversion
- Your daily sales workload
- Freeing up YOUR time for high-value activities
- Personal productivity gains
- Income growth potential` 
: 
`CONTEXT: CORPORATE / TEAM BUYER
This is a company or team buying Sales360.

LANGUAGE RULES:
- Reference team, managers, sales directors
- Say "How many SDRs on your team?" not "How many prospects do YOU call?"
- Focus on TEAM efficiency and manager visibility
- Reference "your sales team" and "your reps"
- ROI = team scale and operational leverage

FOCUS AREAS (Corporate context):
- Revenue leakage (how many leads fall through the cracks?)
- Lead response delays across the team
- Team inefficiency (manual calling bottleneck)
- Inconsistent sales process (different reps, different results)
- CRM chaos (managers can't see what's happening)
- Sales team efficiency (low connect rates, poor qualification)
- Scaling sales operations
- Manager visibility and control`}

METHODOLOGY: Buyer Persuasion Loop™ (Hormozi, Sabri, Cardone, Belfort)
TONE: Strategic, ROI-driven, consultative
GOAL: Uncover pain → Build urgency → Earn demo/pilot booking

STRUCTURE:
1. Permission (respect their time)
2. Context (reference any prior interaction)
3. Discovery (ask about their current challenges)
4. Pain amplification (help them quantify the cost)
5. Solution positioning (how Sales360 solves it)
6. Call to action (book demo, schedule pilot)

STYLE:
- Professional but warm
- Max 2-3 sentences per turn (this is a phone call)
- Ask ONE question at a time
- Listen > Talk (70/30 rule)
- Reference specific numbers/metrics when possible`;

    // ✅ Inject Zoho CRM context if available
    if (zohoLead) {
      prompt += `\n\nCRM CONTEXT:`;
      prompt += `\n- Last contact: ${zohoLead.lastTouchAt ? new Date(zohoLead.lastTouchAt).toLocaleDateString() : 'First contact'}`;
      if (zohoLead.lastTouchChannel) prompt += `\n- Last channel: ${zohoLead.lastTouchChannel}`;
      if (zohoLead.lastOutcome) prompt += `\n- Last outcome: ${zohoLead.lastOutcome}`;
      if (zohoLead.currentChallenges) prompt += `\n- Known challenges: ${zohoLead.currentChallenges}`;
      if (zohoLead.industryType) prompt += `\n- Industry: ${zohoLead.industryType}`;
      if (zohoLead.interestedServices) prompt += `\n- Interested in: ${zohoLead.interestedServices}`;
      if (!isSolo && zohoLead.monthlyLeadsVolume) prompt += `\n- Monthly lead volume: ${zohoLead.monthlyLeadsVolume}`;
      prompt += `\n\nReference this context naturally in your conversation.`;
    }

    prompt += `\n\nAfter EVERY response, append this JSON on a NEW LINE (no markdown, no extra text):
{"score":<0-100>,"delta":<-20 to +20>,"signal":"<short label>","signal_type":"<pain|intent|buy|neutral>"}

Start score at current IntentScore. Increase for: pain admission (+8-12), pricing questions (+12-18), urgency (+15-20), integration questions (+10), team buy-in (+6). Max change: 20 per turn.`;

    return prompt;
  }

  // ═══════════════════════════════════════════════════════════
  // B2C PROMPT (Client End-User Sales Call)
  // Focus: Full sales conversation, qualification, onboarding
  // ═══════════════════════════════════════════════════════════
  _buildB2CPrompt(prospectName, callType, region, zohoLead) {
    let prompt = `You are an AI Sales Agent calling ${prospectName}, a potential trader/end-user.

CRITICAL: This is a B2C END-USER SALES CALL. You are demonstrating how Sales360's AI handles client-end-user conversations.

FOCUS AREAS:
- Full sales conversation (not support-only)
- Lead qualification (experience, capital, intent)
- Objection handling (trust, fees, complexity)
- Product explanation (trading platform, spreads, features)
- Account opening interest
- Callback booking
- Onboarding assistance
- Human handover when needed

TONE: Conversational, supportive, consultative
GOAL: Qualify → Address objections → Convert to account opening or callback

STRUCTURE:
1. Friendly introduction
2. Understand their interest/experience
3. Address questions/concerns
4. Explain value proposition
5. Guide to next step (register, callback, demo)

STYLE:
- Warm and approachable (${region} market)
- Max 2-3 sentences per turn
- Ask ONE question at a time
- Build trust first, sell second`;

    // ✅ Inject Zoho CRM context if available
    if (zohoLead) {
      prompt += `\n\nCRM CONTEXT:`;
      prompt += `\n- Last contact: ${zohoLead.lastTouchAt ? new Date(zohoLead.lastTouchAt).toLocaleDateString() : 'First contact'}`;
      if (zohoLead.lastOutcome) prompt += `\n- Last outcome: ${zohoLead.lastOutcome}`;
      prompt += `\n\nReference this context naturally.`;
    }

    prompt += `\n\nAfter EVERY response, append this JSON on a NEW LINE:
{"score":<0-100>,"delta":<-20 to +20>,"signal":"<short label>","signal_type":"<pain|intent|buy|neutral>"}

Start score at current IntentScore. Increase for: account interest (+10-15), deposit questions (+12), platform questions (+8), verification readiness (+15). Max change: 20 per turn.`;

    return prompt;
  }

  // ═══════════════════════════════════════════════════════════
  // DYNAMIC PROMPT BUILDER (B2C with traderProfile enrichment)
  // ═══════════════════════════════════════════════════════════
  _buildDynamicPrompt(prospectName, callType, traderProfile, zohoLead) {
    const { age, gender, region, product, experience, leadType, communicationStyle } = traderProfile;

    // ═══════════════════════════════════════════════════════════
    // ZOHO CRM CONTEXT (if available)
    // Uses correct field names per ChatGPT alignment
    // ═══════════════════════════════════════════════════════════
    let crmContext = '';
    if (zohoLead) {
      const lastTouchDays = zohoLead.lastTouchAt 
        ? Math.floor((Date.now() - new Date(zohoLead.lastTouchAt).getTime()) / (1000 * 60 * 60 * 24))
        : null;
      
      crmContext = `
CRM CONTEXT (Reference naturally in conversation):
- Last Contact: ${lastTouchDays ? `${lastTouchDays} days ago` : 'First contact'}
- Previous Channel: ${zohoLead.lastTouchChannel || 'None'}
- Current Stage: ${zohoLead.stage}
- Intent Score: ${zohoLead.intentScore}/100
- Behaviour Score: ${zohoLead.behaviourScore}/100
- Challenges Mentioned: ${zohoLead.currentChallenges || 'Not specified'}
- Budget Status: ${zohoLead.budgetReadiness || 'Unknown'}
${zohoLead.lastOutcome === 'replied' ? '- IMPORTANT: Prospect previously replied positively — follow up on that!' : ''}
${zohoLead.nextAgent ? '- SmartCore Next Action: ' + zohoLead.nextAgent : ''}
`;
    }

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
${crmContext}

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
  
  _getStartingScore(scenario, traderProfile, zohoLead) {
    // If Zoho lead exists and has a score, use it as baseline
    if (zohoLead && zohoLead.intentScore > 0) {
      console.log(`[Twilio Service] 📊 Using Zoho IntentScore as baseline: ${zohoLead.intentScore}`);
      return zohoLead.intentScore;
    }
    
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
        
        // ═══════════════════════════════════════════════════════════
        // BUILD CHATGPT POST-CALL PAYLOAD (B2B/B2C ALIGNED)
        // ═══════════════════════════════════════════════════════════
        if (callData.leadId && this.zoho.isEnabled()) {
          console.log(`[Twilio] Building post-call payload for lead: ${callData.leadId}`);
          
          // Determine call status and outcome
          let callStatus = 'answered';  // If we got here, call was answered
          let callOutcome = 'needs_nurture';
          
          if (callData.engagementSignals.demo_requested) callOutcome = 'demo_requested';
          else if (callData.engagementSignals.pricing_discussed) callOutcome = 'pricing_requested';
          else if (callData.engagementSignals.callback_requested) callOutcome = 'callback_requested';
          else if (callData.intentScore >= 75) callOutcome = 'qualified_for_sales';
          else if (callData.intentScore >= 30) callOutcome = 'interested';
          else callOutcome = 'not_interested';
          
          // Determine recommended next action
          let recommendedNextAction = 'smartcore_decide';
          if (callData.engagementSignals.demo_requested) recommendedNextAction = 'book_demo';
          else if (callData.engagementSignals.callback_requested) recommendedNextAction = 'sales_callback';
          else if (callData.intentScore >= 75) recommendedNextAction = 'sales_callback';
          else if (callData.intentScore >= 60) recommendedNextAction = 'send_proposal';
          else if (callData.intentScore < 30) recommendedNextAction = 'nurture';
          
          // Build call summary
          const callSummary = this._generateCallSummary(callData);
          
          // ✅ CHATGPT-ALIGNED PAYLOAD STRUCTURE
          const postCallPayload = {
            lead_id: callData.leadId,
            lead_type: callData.leadType,  // B2B or B2C
            call_type: callData.callType,   // broker, trader, etc.
            buyer_context: callData.buyerContext || 'corporate',  // ✅ CHATGPT: Solo vs Corporate (from callData)
            call_id: callSid,
            call_timestamp: callData.startTime,
            call_duration_seconds: duration,
            
            last_agent: "Claude_AI_Call_Agent",
            last_touch_channel: "AI Call",
            
            call_status: callStatus,
            call_outcome: callOutcome,
            last_outcome: callOutcome,  // Same as call_outcome initially
            
            intent_score_start: callData.intentScoreStart,
            intent_score_final: callData.intentScore,
            intent_score_peak: callData.intentScorePeak,
            behaviour_score_start: callData.behaviourScoreStart,  // ✅ OPTIMIZATION: Track behaviour score progression
            behaviour_score_final: callData.behaviourScore,  // ✅ OPTIMIZATION: Final behaviour score (locally tracked)
            behaviour_score_delta: callData.behaviourScoreDelta,
            
            engagement_signals: callData.engagementSignals,
            detected_pain_points: callData.detectedPainPoints,
            objections: callData.objections,
            buying_signals: callData.buyingSignals,
            
            recommended_next_action: recommendedNextAction,
            call_summary: callSummary,
            
            transcript_url: '',  // TODO: Add transcript storage
            agent_notes: `Call completed. Peak score: ${callData.intentScorePeak}. ${callData.objections.length > 0 ? 'Objections: ' + callData.objections.join(', ') : ''}`
          };
          
          console.log(`[Twilio] Post-call payload:`, JSON.stringify(postCallPayload, null, 2));
          
          // Trigger SmartCore with full payload (fire and forget)
          this.zoho.triggerSmartCore(postCallPayload)
            .then(success => {
              if (success) {
                console.log(`[Twilio] ✅ SmartCore triggered with full payload`);
              } else {
                console.error(`[Twilio] ❌ SmartCore trigger failed`);
              }
            })
            .catch(err => {
              console.error(`[Twilio] ❌ SmartCore trigger error:`, err.message);
            });
        }
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

  // ═══════════════════════════════════════════════════════════
  // B2B SIGNAL DETECTION (CHATGPT CANONICAL MAP)
  // For Sales360's direct clients: brokers, exchanges, agencies
  // ═══════════════════════════════════════════════════════════
  _extractB2BSignals(signal, callData) {
    // B2B Pain Points
    const b2bPainPoints = {
      'revenue leak': 'revenue_leakage_pain',
      'losing revenue': 'revenue_leakage_pain',
      'leads leak': 'revenue_leakage_pain',
      'follow': 'lead_follow_up_failure',
      'follow-up': 'lead_follow_up_failure',
      'not following': 'lead_follow_up_failure',
      'manual call': 'manual_calling_bottleneck',
      'calling manually': 'manual_calling_bottleneck',
      'inconsistent': 'inconsistent_sales_process',
      'different process': 'inconsistent_sales_process',
      'visibility': 'crm_visibility_gap',
      'can\'t see': 'crm_visibility_gap',
      'sales team': 'sales_team_inefficiency',
      'inefficient': 'sales_team_inefficiency',
      'missed callback': 'missed_callback_problem',
      'slow': 'slow_speed_to_lead',
      'speed to lead': 'slow_speed_to_lead',
      'prioriti': 'poor_lead_prioritisation',
      'founder': 'founder_sales_bottleneck',
      'compliance': 'compliance_or_data_security_concern',
      'security': 'compliance_or_data_security_concern'
    };
    
    for (const [keyword, painPoint] of Object.entries(b2bPainPoints)) {
      if (signal.includes(keyword) && !callData.detectedPainPoints.includes(painPoint)) {
        callData.detectedPainPoints.push(painPoint);
        break;
      }
    }
    
    // B2B Buying Signals
    if (signal.includes('demo') || signal.includes('show me')) {
      if (!callData.buyingSignals.includes('asked_for_demo')) callData.buyingSignals.push('asked_for_demo');
      callData.engagementSignals.demo_requested = true;
    }
    if (signal.includes('integrat') || signal.includes('works with') || signal.includes('connect')) {
      if (!callData.buyingSignals.includes('asked_about_integration')) callData.buyingSignals.push('asked_about_integration');
    }
    if (signal.includes('pricing') || signal.includes('how much') || signal.includes('cost')) {
      if (!callData.buyingSignals.includes('asked_about_pricing')) callData.buyingSignals.push('asked_about_pricing');
      callData.engagementSignals.pricing_discussed = true;
    }
    if (signal.includes('security') || signal.includes('data protection')) {
      if (!callData.buyingSignals.includes('asked_about_security')) callData.buyingSignals.push('asked_about_security');
    }
    if (signal.includes('crm') || signal.includes('zoho')) {
      if (!callData.buyingSignals.includes('asked_about_crm_connection')) callData.buyingSignals.push('asked_about_crm_connection');
    }
    if (signal.includes('ai call') || signal.includes('ai agent')) {
      if (!callData.buyingSignals.includes('asked_about_ai_call_agent')) callData.buyingSignals.push('asked_about_ai_call_agent');
    }
    if (signal.includes('pilot') || signal.includes('trial')) {
      if (!callData.buyingSignals.includes('requested_pilot')) callData.buyingSignals.push('requested_pilot');
    }
    if (signal.includes('management') || signal.includes('review with team')) {
      if (!callData.buyingSignals.includes('requested_management_review')) callData.buyingSignals.push('requested_management_review');
    }
    if (signal.includes('problem') || signal.includes('pain') || signal.includes('struggle')) {
      if (!callData.buyingSignals.includes('confirmed_sales_problem')) callData.buyingSignals.push('confirmed_sales_problem');
    }
    if (signal.includes('lead volume') || signal.includes('many leads')) {
      if (!callData.buyingSignals.includes('confirmed_lead_volume')) callData.buyingSignals.push('confirmed_lead_volume');
    }
    if (signal.includes('callback') || signal.includes('call back') || signal.includes('call me')) {
      callData.engagementSignals.callback_requested = true;
    }
    
    // B2B Objections
    if (signal.includes('expensive') || signal.includes('price') || signal.includes('too much')) {
      if (!callData.objections.includes('price')) callData.objections.push('price');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('timing') || signal.includes('not now') || signal.includes('later')) {
      if (!callData.objections.includes('timing')) callData.objections.push('timing');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('already have crm') || signal.includes('existing crm')) {
      if (!callData.objections.includes('existing_crm')) callData.objections.push('existing_crm');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('security concern') || signal.includes('data concern')) {
      if (!callData.objections.includes('security_concern')) callData.objections.push('security_concern');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('management approval') || signal.includes('need approval')) {
      if (!callData.objections.includes('management_approval_needed')) callData.objections.push('management_approval_needed');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('complex') || signal.includes('difficult to integrate')) {
      if (!callData.objections.includes('integration_complexity')) callData.objections.push('integration_complexity');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('not ready for ai') || signal.includes('skeptical')) {
      if (!callData.objections.includes('not_ready_for_ai_calls')) callData.objections.push('not_ready_for_ai_calls');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('case study') || signal.includes('proof')) {
      if (!callData.objections.includes('wants_case_study')) callData.objections.push('wants_case_study');
      callData.engagementSignals.objection_detected = true;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // B2C SIGNAL DETECTION (CHATGPT CANONICAL MAP)
  // For client's end-users: traders, prospects, applicants
  // ═══════════════════════════════════════════════════════════
  _extractB2CSignals(signal, callData) {
    // B2C Pain Points / Needs
    const b2cNeeds = {
      'account setup': 'account_setup_interest',
      'open account': 'account_setup_interest',
      'trading': 'trading_interest',
      'want to trade': 'trading_interest',
      'beginner': 'beginner_trader',
      'new to': 'beginner_trader',
      'experienced': 'experienced_trader',
      'been trading': 'experienced_trader',
      'funding': 'funding_question',
      'deposit': 'funding_question',
      'platform': 'platform_question',
      'mt4': 'platform_question',
      'mt5': 'platform_question',
      'spread': 'spreads_or_fees_question',
      'fees': 'spreads_or_fees_question',
      'commission': 'spreads_or_fees_question',
      'withdrawal': 'withdrawal_question',
      'withdraw': 'withdrawal_question',
      'regulation': 'regulation_or_trust_question',
      'licensed': 'regulation_or_trust_question',
      'safe': 'regulation_or_trust_question',
      'callback': 'needs_callback',
      'call back': 'needs_callback',
      'human': 'needs_human_support',
      'speak to someone': 'needs_human_support'
    };
    
    for (const [keyword, need] of Object.entries(b2cNeeds)) {
      if (signal.includes(keyword) && !callData.detectedPainPoints.includes(need)) {
        callData.detectedPainPoints.push(need);
        break;
      }
    }
    
    // B2C Buying Signals
    if (signal.includes('open account') || signal.includes('sign up') || signal.includes('register')) {
      if (!callData.buyingSignals.includes('wants_to_open_account')) callData.buyingSignals.push('wants_to_open_account');
    }
    if (signal.includes('spread') || signal.includes('what are your spreads')) {
      if (!callData.buyingSignals.includes('asked_about_spreads')) callData.buyingSignals.push('asked_about_spreads');
    }
    if (signal.includes('deposit') || signal.includes('how much to start')) {
      if (!callData.buyingSignals.includes('asked_about_deposit')) callData.buyingSignals.push('asked_about_deposit');
    }
    if (signal.includes('bonus') || signal.includes('offer') || signal.includes('promotion')) {
      if (!callData.buyingSignals.includes('asked_about_bonus_or_offer')) callData.buyingSignals.push('asked_about_bonus_or_offer');
    }
    if (signal.includes('platform') || signal.includes('mt4') || signal.includes('mt5')) {
      if (!callData.buyingSignals.includes('asked_about_platform')) callData.buyingSignals.push('asked_about_platform');
    }
    if (signal.includes('verification') || signal.includes('kyc') || signal.includes('documents')) {
      if (!callData.buyingSignals.includes('asked_about_verification')) callData.buyingSignals.push('asked_about_verification');
    }
    if (signal.includes('callback') || signal.includes('call back') || signal.includes('call me')) {
      if (!callData.buyingSignals.includes('requested_callback')) callData.buyingSignals.push('requested_callback');
      callData.engagementSignals.callback_requested = true;
    }
    if (signal.includes('account manager') || signal.includes('personal support')) {
      if (!callData.buyingSignals.includes('requested_account_manager')) callData.buyingSignals.push('requested_account_manager');
    }
    if (signal.includes('ready') || signal.includes('let\'s do it')) {
      if (!callData.buyingSignals.includes('ready_to_register')) callData.buyingSignals.push('ready_to_register');
    }
    if (signal.includes('next step') || signal.includes('what now')) {
      if (!callData.buyingSignals.includes('asked_for_next_step')) callData.buyingSignals.push('asked_for_next_step');
    }
    
    // B2C Objections
    if (signal.includes('not ready') || signal.includes('not now')) {
      if (!callData.objections.includes('not_ready')) callData.objections.push('not_ready');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('need more info') || signal.includes('want to think')) {
      if (!callData.objections.includes('needs_more_information')) callData.objections.push('needs_more_information');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('trust') || signal.includes('scam') || signal.includes('legit')) {
      if (!callData.objections.includes('trust_concern')) callData.objections.push('trust_concern');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('regulation') || signal.includes('licensed')) {
      if (!callData.objections.includes('regulation_concern')) callData.objections.push('regulation_concern');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('fees') || signal.includes('expensive') || signal.includes('costs')) {
      if (!callData.objections.includes('fees_concern')) callData.objections.push('fees_concern');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('already') || signal.includes('using') || signal.includes('competitor')) {
      if (!callData.objections.includes('already_using_competitor')) callData.objections.push('already_using_competitor');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('no funds') || signal.includes('no money')) {
      if (!callData.objections.includes('no_funds_now')) callData.objections.push('no_funds_now');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('later') || signal.includes('another time')) {
      if (!callData.objections.includes('wants_to_speak_later')) callData.objections.push('wants_to_speak_later');
      callData.engagementSignals.objection_detected = true;
    }
    if (signal.includes('risk') || signal.includes('lose money')) {
      if (!callData.objections.includes('risk_concern')) callData.objections.push('risk_concern');
      callData.engagementSignals.objection_detected = true;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // HELPER: GENERATE CALL SUMMARY
  // ═══════════════════════════════════════════════════════════
  _generateCallSummary(callData) {
    const parts = [];
    
    // Lead information
    parts.push(`Call with ${callData.prospectName}`);
    
    // Score progression
    if (callData.intentScorePeak > callData.intentScoreStart + 20) {
      parts.push(`strong engagement (score: ${callData.intentScoreStart} → ${callData.intentScorePeak})`);
    } else if (callData.intentScorePeak > callData.intentScoreStart) {
      parts.push(`moderate interest (score: ${callData.intentScoreStart} → ${callData.intentScorePeak})`);
    } else {
      parts.push(`limited engagement (score: ${callData.intentScore})`);
    }
    
    // Key outcomes
    if (callData.engagementSignals.demo_requested) {
      parts.push('requested demo');
    }
    if (callData.engagementSignals.callback_requested) {
      parts.push('requested callback');
    }
    if (callData.engagementSignals.pricing_discussed) {
      parts.push('discussed pricing');
    }
    
    // Pain points
    if (callData.detectedPainPoints.length > 0) {
      parts.push(`pain points: ${callData.detectedPainPoints.slice(0, 2).join(', ')}`);
    }
    
    // Objections
    if (callData.objections.length > 0) {
      parts.push(`objections: ${callData.objections.join(', ')}`);
    }
    
    return parts.join('. ') + '.';
  }
}

module.exports = TwilioService;
