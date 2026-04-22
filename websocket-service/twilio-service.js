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
  // GENERATE OPENING GREETING (WITH ELEVENLABS!)
  // ═══════════════════════════════════════════════════════════
  async generateGreetingTwiML(prospectName, region, scenario) {
    const twiml = new VoiceResponse();
    const greeting = this._getGreeting(scenario, prospectName, region);
    
    console.log(`[Twilio Service] 🎤 Generating greeting with ElevenLabs...`);
    
    // Try to generate with ElevenLabs
    const audioBuffer = await this.elevenLabs.generateAudio(greeting, region, 'Male');
    
    if (audioBuffer) {
      // Upload to storage or use data URI
      const audioUrl = await this.storage.uploadAudio(audioBuffer, 'greeting');
      
      console.log('[Twilio Service] ✅ Using ElevenLabs voice');
      twiml.play(audioUrl);
    } else {
      // Fallback to AWS Polly
      console.log('[Twilio Service] ⚠️  Falling back to AWS Polly');
      twiml.say({
        voice: 'Polly.Matthew',
        language: 'en-GB'
      }, greeting);
    }

    // Gather user response
    const gather = twiml.gather({
      input: 'speech',
      action: `${this.webhookBaseUrl}/twilio/gather`,
      method: 'POST',
      speechTimeout: 'auto',
      speechModel: 'phone_call',
      enhanced: true,
      language: 'en-GB'
    });

    gather.pause({ length: 1 });

    return twiml.toString();
  }

  // ═══════════════════════════════════════════════════════════
  // HANDLE USER RESPONSE (WITH ELEVENLABS!)
  // ═══════════════════════════════════════════════════════════
  async handleGather(callSid, speechResult) {
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
      twiml.redirect(`${this.webhookBaseUrl}/twilio/gather`);
      return twiml.toString();
    }

    console.log(`[Twilio Webhook] 🎤 User said: ${speechResult}`);

    // Get AI response from Claude
    const aiResponse = await this._getClaudeResponse(callData, speechResult);
    
    if (!aiResponse) {
      twiml.say({ voice: 'Polly.Matthew' }, 'I apologize, I\'m having trouble processing that. Let me try again.');
      twiml.redirect(`${this.webhookBaseUrl}/twilio/gather`);
      return twiml.toString();
    }

    console.log(`[Twilio Webhook] 🤖 AI response: ${aiResponse.text.substring(0, 100)}...`);

    // Generate audio with ElevenLabs
    const audioBuffer = await this.elevenLabs.generateAudio(
      aiResponse.text, 
      callData.region, 
      'Male'
    );

    if (audioBuffer) {
      // Upload to storage or use data URI
      const audioUrl = await this.storage.uploadAudio(audioBuffer, callSid);
      
      console.log('[Twilio Webhook] ✅ Playing ElevenLabs voice');
      twiml.play(audioUrl);
    } else {
      // Fallback to AWS Polly
      console.log('[Twilio Webhook] ⚠️  Falling back to AWS Polly');
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
      speechTimeout: 'auto',
      speechModel: 'phone_call',
      enhanced: true,
      language: 'en-GB'
    });

    gather.pause({ length: 1 });

    return twiml.toString();
  }

  // ═══════════════════════════════════════════════════════════
  // GET CLAUDE AI RESPONSE
  // ═══════════════════════════════════════════════════════════
  async _getClaudeResponse(callData, userSpeech) {
    try {
      callData.conversationHistory.push({
        role: 'user',
        content: userSpeech
      });

      const systemPrompt = this._getSystemPrompt(callData.scenario, callData.prospectName, callData.region);

      console.log('[Claude API] 📤 Sending request...');

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          system: systemPrompt,
          messages: callData.conversationHistory
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Claude API] ❌ Error:', response.status, errorText);
        return null;
      }

      const data = await response.json();
      console.log('[Claude API] ✅ Response received');

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
      console.error('[Claude API] ❌ Exception:', error.message);
      return null;
    }
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

  handleRecording(callSid, recordingUrl, recordingSid) {
    console.log(`[Twilio] Recording available for call: ${callSid}`);
    console.log(`[Twilio] Recording URL: ${recordingUrl}`);
    console.log(`[Twilio] Recording SID: ${recordingSid}`);
  }
}

module.exports = TwilioService;
