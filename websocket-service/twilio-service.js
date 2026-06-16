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
    
    console.log('[Twilio Service] ✅ Initialized with number:', this.phoneNumber);
    console.log('[Twilio Service] Anthropic API Key:', this.anthropicApiKey ? `YES (length: ${this.anthropicApiKey.length})` : '❌ MISSING!');
    console.log('[Twilio Service] ElevenLabs:', this.elevenLabs.isReady() ? '✅ Ready' : '⚠️  Disabled');
    console.log('[Twilio Service] Storage: ✅ Ready (3-tier fallback: R2 → Volume → Direct)');
    console.log('[Twilio Service] Zoho CRM:', this.zoho.isEnabled() ? '✅ Connected' : '⚠️  Disabled');
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
    
    // ⚡ OPTIMIZATION: Check cache first
    const cacheKey = `${prospectName}-${region}-${scenario}`;
    
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

    // Continue with speech gathering — optimised for natural interruptions
    const gather = twiml.gather({
      input: 'speech',
      action: `${this.webhookBaseUrl}/twilio/gather`,
      method: 'POST',
      timeout: 10,           // ✅ Was 60 — shorter = faster response to silence
      speechTimeout: '1',    // ✅ Was 'auto' — 1 second pause = natural conversation pace
      speechModel: 'phone_call',
      enhanced: true,
      language: 'en-GB',
      partialResultCallback: `${this.webhookBaseUrl}/twilio/partial`, // ✅ Detect speech starting
      partialResultCallbackMethod: 'POST'
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

      // Broadcast to dashboard
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
      this.pendingResponses.set(callSid, {
        error: error.message,
        timestamp: Date.now(),
        success: false
      });
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
      twiml.say({ voice: 'Polly.Matthew' }, 'I apologize, there was an error. Goodbye.');
      twiml.hangup();
      return twiml.toString();
    }

    // Handle empty or silence speech
    if (!speechResult || speechResult.trim() === '') {
      console.log('[Twilio Webhook] Gather - No speech detected');
      
      twiml.say({
        voice: 'Polly.Matthew',
        language: 'en-GB'
      }, "I didn't catch that. Could you please repeat?");
      
      const gather = twiml.gather({
        input: 'speech',
        action: `${this.webhookBaseUrl}/twilio/gather`,
        method: 'POST',
        timeout: 10,
        speechTimeout: '1',
        speechModel: 'phone_call',
        enhanced: true,
        language: 'en-GB'
      });
      gather.pause({ length: 1 });
      
      return twiml.toString();
    }

    console.log(`[Twilio Webhook] 🎤 User said: ${speechResult}`);

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
      const systemPrompt = this._selectPromptByLeadType(callData);

      console.log(`[Claude API] 📤 Sending request (turn ${callData.conversationHistory.length / 2})`);
      console.log(`[Claude API] 🎯 Lead Type: ${callData.leadType} | Call Type: ${callData.callType}`);
      console.log(`[Claude API] 📊 Current IntentScore: ${callData.intentScore}`);

      const maxTokens = this._getOptimalTokens(callData, userSpeech);
      console.log(`[Claude API] 🎯 Using ${maxTokens} tokens for this response`);
      
      // ✅ SPEED OPTIMIZATION: Haiku 4.5 for B2C (4x faster!), Sonnet 4.5 for B2B
      const modelToUse = callData.leadType === 'B2C' 
        ? 'claude-haiku-4-5'              // ✅ Haiku 4.5 - CORRECT MODEL NAME
        : 'claude-sonnet-4-20250514';     // Sonnet 4.5 - Smart for B2B
      
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
        const fullText = data.content[0].text || '';
        
        let aiText = fullText;
        let scoreData = null;

        // ═══════════════════════════════════════════════════════════
        // EXTRACT & REMOVE JSON METADATA (Multiple pattern matching)
        // ═══════════════════════════════════════════════════════════
        
        // Pattern 1: Plain JSON on new line or at end
        let jsonMatch = fullText.match(/\{[^{}]*"score"[^{}]*\}/);
        
        // Pattern 2: Markdown-wrapped JSON (```json ... ```)
        if (!jsonMatch) {
          const mdMatch = fullText.match(/```json\s*(\{[^}]*"score"[^}]*\})\s*```/);
          if (mdMatch) jsonMatch = [mdMatch[1]];
        }
        
        // Pattern 3: JSON with newlines/whitespace
        if (!jsonMatch) {
          jsonMatch = fullText.match(/\{\s*"score"\s*:\s*\d+[^}]*\}/);
        }

        if (jsonMatch) {
          try {
            scoreData = JSON.parse(jsonMatch[0]);
            
            // Remove JSON from spoken text (all patterns)
            aiText = fullText
              .replace(/\{[^{}]*"score"[^{}]*\}/g, '')           // Plain JSON
              .replace(/```json[\s\S]*?```/g, '')                // Markdown JSON
              .replace(/\{\s*"score"\s*:\s*\d+[^}]*\}/g, '')    // Whitespace JSON
              .replace(/\n\s*\n/g, '\n')                         // Double newlines
              .trim();
            
            console.log(`[Claude API] ✅ Metadata extracted: Score ${scoreData.score}, Signal: ${scoreData.signal}`);
            
          } catch (e) {
            console.warn('[Claude API] ⚠️  Could not parse score JSON:', jsonMatch[0].substring(0, 50));
            // Still remove the malformed JSON from spoken text
            aiText = fullText.replace(jsonMatch[0], '').trim();
          }
        } else {
          console.warn('[Claude API] ⚠️  No score JSON found in response');
        }

        // ✅ VALIDATE RESPONSE (B2C only - Chuks Methodology: 25-word limit + questions)
        if (callData.leadType === 'B2C') {
          const validation = ChuksMethodology.validateResponse(aiText);
          
          if (!validation.valid) {
            console.log('[Chuks Methodology] ⚠️  Response quality warnings:');
            validation.warnings.forEach(w => console.log(`  ${w}`));
            // Still use the response, but flag for monitoring
          } else {
            console.log(`[Claude API] ✅ Response validated: ${validation.wordCount} words, ends with question`);
          }
        }

        // ═══════════════════════════════════════════════════════════
        // SAVE TO CONVERSATION HISTORY (cleaned text only, NO JSON!)
        // ═══════════════════════════════════════════════════════════
        callData.conversationHistory.push({
          role: 'assistant',
          content: aiText  // ✅ CLEANED TEXT (JSON removed!)
        });

        if (scoreData && scoreData.score !== undefined) {
          callData.intentScore = Math.min(100, Math.max(0, parseInt(scoreData.score)));
          
          // ✅ Track peak score
          if (callData.intentScore > callData.intentScorePeak) {
            callData.intentScorePeak = callData.intentScore;
          }
          
          // ✅ Track engagement signals
          if (callData.conversationHistory.length > 1) {
            callData.engagementSignals.call_answered = true;
            callData.engagementSignals.meaningful_conversation = true;
          }
          
          // ✅ Extract signals
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
          
          // ═══════════════════════════════════════════════════════════
          // ZOHO REAL-TIME SCORE UPDATE (via Deluge function)
          // ═══════════════════════════════════════════════════════════
          if (callData.leadId && this.zoho.isEnabled()) {
            let behaviourDelta = 0;
            
            if (scoreData.signal_type === 'engagement') {
              behaviourDelta = 3;
              callData.behaviourScoreDelta += 3;
              callData.behaviourScore = Math.max(0, Math.min(100, callData.behaviourScore + 3));
            } else if (scoreData.signal_type === 'positive') {
              behaviourDelta = 5;
              callData.behaviourScoreDelta += 5;
              callData.behaviourScore = Math.max(0, Math.min(100, callData.behaviourScore + 5));
            } else if (callData.conversationHistory.length > 2) {
              behaviourDelta = 1;
              callData.behaviourScoreDelta += 1;
              callData.behaviourScore = Math.max(0, Math.min(100, callData.behaviourScore + 1));
            }
            
            // ✅ Fire-and-forget live update
            this.zoho.updateIntentScore(
              callData.leadId,
              callData.intentScore,
              0
            ).catch(err => {
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

  // ⚡ SMART TOKEN ALLOCATION
  _getOptimalTokens(callData, userSpeech) {
    const turnCount = callData.conversationHistory.length / 2;
    const userWordCount = userSpeech.split(' ').length;
    const intentScore = callData.intentScore || 0;

    // ✅ B2C: OPTIMIZED FOR SPEED (Chuks Methodology: 25-word limit)
    if (callData.leadType === 'B2C') {
      // Shorter tokens = faster response (4x with Haiku)
      if (intentScore < 30) return 60;   // Cold: Very short (was 80)
      if (intentScore < 60) return 80;   // Warm: Short + authority (was 100)
      if (intentScore < 75) return 100;  // Hot: Urgency (was 120)
      return 80;  // SQL: Direct close (was 100)
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
      // ✅ SALES360 MASTER PROMPT V2 - Haiku-Optimised (674 tokens, fast!)
      console.log('[Twilio] 🎯 Using SALES360 MASTER PROMPT V2 (Haiku-Optimised)');

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
    if (scenario === 'broker') {
      return `Good afternoon ${name.split(' ')[0]}, this is Sales360 AI. I'm calling following your enquiry about reducing trader churn. Do you have a moment?`;
    } else {
      return `Hey ${name.split(' ')[0]}! This is Sales360 AI. I saw you signed up but haven't activated your account yet. What's up with that?`;
    }
  }

  _getDynamicGreeting(name, traderProfile) {
    const { age, region, leadType } = traderProfile;
    const firstName = name.split(' ')[0];
    const timeOfDay = new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening';
    
    if (leadType === 'inbound_warm') {
      return `Good ${timeOfDay}, ${firstName}! This is the AI assistant from HFM. I'm following up on your inquiry. Do you have a moment?`;
    } else if (leadType === 'outbound_cold' && age > 45) {
      return `Good ${timeOfDay}, ${traderProfile.gender === 'Male' ? 'Sir' : 'Madam'}. Am I speaking with ${name}?`;
    } else {
      return `Hi ${firstName}! This is the AI assistant from HFM. Are you trading right now?`;
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
