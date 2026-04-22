// ═══════════════════════════════════════════════════════════
// SALES360 TWILIO SERVICE - REAL AI CONVERSATION ENGINE
// ═══════════════════════════════════════════════════════════

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

class TwilioService {
  constructor() {
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
    
    console.log('[Twilio Service] Initialized with number:', this.phoneNumber);
    console.log('[Twilio Service] Anthropic API Key loaded:', this.anthropicApiKey ? 'YES (length: ' + this.anthropicApiKey.length + ')' : 'NO - MISSING!');
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
      console.log('[Twilio Service] Call initiated:', call.sid, 'to:', to);
      
      return {
        success: true,
        callSid: call.sid,
        status: call.status,
        to: to,
        from: this.phoneNumber
      };
    } catch (error) {
      console.error('[Twilio Service] Error making call:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // GENERATE OPENING GREETING (TwiML)
  // ═══════════════════════════════════════════════════════════
  generateGreetingTwiML(prospectName, region, scenario) {
    const twiml = new VoiceResponse();
    const greeting = this._getGreeting(scenario, prospectName, region);
    
    // Say the greeting
    twiml.say({
      voice: 'Polly.Matthew',
      language: 'en-GB'
    }, greeting);

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

    // Silence while waiting for response
    gather.pause({ length: 1 });

    // If no input, prompt again
    twiml.say({
      voice: 'Polly.Matthew',
      language: 'en-GB'
    }, "I didn't catch that. Are you still there?");

    twiml.redirect(`${this.webhookBaseUrl}/twilio/gather`);

    return twiml.toString();
  }

  // ═══════════════════════════════════════════════════════════
  // PROCESS USER RESPONSE - REAL AI CONVERSATION
  // ═══════════════════════════════════════════════════════════
  async processUserResponse(callSid, userSpeech, wsServer = null) {
    try {
      console.log('[Twilio Webhook] Gather - User said:', userSpeech);
      
      const callData = this.activeCalls.get(callSid);
      if (!callData) {
        console.error('[Twilio Service] Call data not found for:', callSid);
        return this._generateErrorTwiML();
      }

      // Add user message to conversation history
      callData.conversationHistory.push({
        role: 'user',
        content: userSpeech
      });

      // ═══════════════════════════════════════════════════════════
      // CALL CLAUDE API FOR INTELLIGENT RESPONSE
      // ═══════════════════════════════════════════════════════════
      const aiResponse = await this._getClaudeResponse(callData);
      
      if (!aiResponse.success) {
        console.error('[Twilio Service] Claude API error:', aiResponse.error);
        return this._generateErrorTwiML();
      }

      // Add AI response to conversation history
      callData.conversationHistory.push({
        role: 'assistant',
        content: aiResponse.fullText
      });

      // Update IntentScore
      if (aiResponse.score !== null) {
        callData.intentScore = aiResponse.score;
      }

      // ═══════════════════════════════════════════════════════════
      // BROADCAST TO DASHBOARD (WebSocket)
      // ═══════════════════════════════════════════════════════════
      if (wsServer) {
        wsServer.broadcast({
          type: 'transcript',
          role: 'user',
          text: userSpeech,
          timestamp: new Date().toISOString()
        });

        wsServer.broadcast({
          type: 'transcript',
          role: 'ai',
          text: aiResponse.displayText,
          timestamp: new Date().toISOString()
        });

        if (aiResponse.score !== null) {
          wsServer.broadcast({
            type: 'intentScore',
            score: aiResponse.score,
            delta: aiResponse.delta || 0
          });
        }

        if (aiResponse.signal) {
          wsServer.broadcast({
            type: 'signal',
            signal: aiResponse.signal,
            signalType: aiResponse.signalType || 'neutral',
            delta: aiResponse.delta || 0
          });
        }

        if (aiResponse.score >= 75) {
          wsServer.broadcast({
            type: 'hotLead',
            score: aiResponse.score,
            prospectName: callData.prospectName
          });
        }
      }

      // ═══════════════════════════════════════════════════════════
      // GENERATE TwiML RESPONSE
      // ═══════════════════════════════════════════════════════════
      const twiml = new VoiceResponse();
      
      twiml.say({
        voice: 'Polly.Matthew',
        language: 'en-GB'
      }, aiResponse.displayText);

      // Gather next user response
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

      // If no input, prompt again
      twiml.say({
        voice: 'Polly.Matthew',
        language: 'en-GB'
      }, "Are you still there?");

      twiml.redirect(`${this.webhookBaseUrl}/twilio/gather`);

      return twiml.toString();

    } catch (error) {
      console.error('[Twilio Service] Error processing user response:', error);
      return this._generateErrorTwiML();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CALL CLAUDE API
  // ═══════════════════════════════════════════════════════════
  async _getClaudeResponse(callData) {
    try {
      const systemPrompt = this._getSystemPrompt(callData.scenario, callData.region, callData.prospectName);
      
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: systemPrompt,
          messages: callData.conversationHistory
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Claude API] Error response:', errorText);
        return {
          success: false,
          error: `API returned ${response.status}: ${errorText}`
        };
      }

      const data = await response.json();
      
      if (!data.content || !data.content[0]) {
        return {
          success: false,
          error: 'No content in API response'
        };
      }

      const fullText = data.content[0].text || '';
      
      // Extract JSON score/signal from response
      const jsonMatch = fullText.match(/\{[^{}]*"score"[^{}]*\}/);
      let parsed = null;
      let displayText = fullText;
      
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
          displayText = fullText.replace(jsonMatch[0], '').trim();
        } catch (e) {
          console.error('[Claude API] Failed to parse JSON:', e.message);
        }
      }

      return {
        success: true,
        fullText: fullText,
        displayText: displayText,
        score: parsed?.score || null,
        delta: parsed?.delta || null,
        signal: parsed?.signal || null,
        signalType: parsed?.signal_type || null
      };

    } catch (error) {
      console.error('[Claude API] Fetch error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // HANDLE STATUS UPDATES
  // ═══════════════════════════════════════════════════════════
  handleStatusUpdate(callSid, status, callData) {
    console.log(`[Twilio] Call ${callSid} status: ${status}`);
    
    if (this.activeCalls.has(callSid)) {
      const data = this.activeCalls.get(callSid);
      data.status = status;
      
      if (status === 'completed' || status === 'failed' || status === 'busy' || status === 'no-answer') {
        data.endTime = new Date().toISOString();
        console.log('[Twilio] Call ended:', callSid, 'Duration:', callData?.CallDuration || 'unknown');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // HANDLE RECORDING
  // ═══════════════════════════════════════════════════════════
  handleRecording(callSid, recordingUrl, recordingSid) {
    console.log('[Twilio] Recording available for call:', callSid);
    console.log('[Twilio] Recording URL:', recordingUrl);
    console.log('[Twilio] Recording SID:', recordingSid);
    
    if (this.activeCalls.has(callSid)) {
      const data = this.activeCalls.get(callSid);
      data.recordingUrl = recordingUrl;
      data.recordingSid = recordingSid;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // END CALL
  // ═══════════════════════════════════════════════════════════
  async endCall(callSid) {
    try {
      await this.client.calls(callSid).update({ status: 'completed' });
      this.activeCalls.delete(callSid);
      console.log('[Twilio Service] Call ended:', callSid);
      return { success: true };
    } catch (error) {
      console.error('[Twilio Service] Error ending call:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // GET ACTIVE CALLS
  // ═══════════════════════════════════════════════════════════
  getActiveCalls() {
    return Array.from(this.activeCalls.entries()).map(([sid, data]) => ({
      callSid: sid,
      ...data
    }));
  }

  // ═══════════════════════════════════════════════════════════
  // GET CALL DETAILS
  // ═══════════════════════════════════════════════════════════
  getCallDetails(callSid) {
    return this.activeCalls.get(callSid) || null;
  }

  // ═══════════════════════════════════════════════════════════
  // HELPER: GET SYSTEM PROMPT
  // ═══════════════════════════════════════════════════════════
  _getSystemPrompt(scenario, region, prospectName) {
    // Using HFM broker scenario as default
    return `You are the Sales360 AI Call Agent — the world's most intelligent sales system, built on 15+ years of front-line sales expertise.

You are on a live PHONE CALL with ${prospectName}, a business leader in ${region}. They enquired about reducing trader churn and improving trader qualification.

METHODOLOGY: Buyer Persuasion Loop™ — trained on Hormozi, Suby, Cardone, Belfort.
STYLE: Professional, warm, direct. This is a PHONE CALL — be concise. Max 2-3 sentences per turn. Natural speech only.
GOAL: Uncover their pain, build urgency, earn a pilot booking.
THEIR PAIN: High trader churn. Poor qualification process means losing good traders to competitors.

PHONE CALL RULES:
- Speak naturally (contractions, conversational tone)
- Keep responses SHORT (2-3 sentences max)
- One question at a time
- Listen more than you talk
- React naturally to what they say

After EVERY response, on a NEW LINE append exactly this JSON (no markdown, no extra text):
{"score":<integer>,"delta":<integer>,"signal":"<short label>","signal_type":"<pain|intent|buy|neutral>"}

Score tracking: Increase for admitting pain (+8-12), asking price/ROI (+12-18), urgency/timeline (+15-20), integration questions (+10), team buy-in "we" (+6), follow-up questions (+4-8). Decrease for dismissive short replies (-2 to 0). Max change per turn: 20. Never exceed 100.`;
  }

  // ═══════════════════════════════════════════════════════════
  // HELPER: GET GREETING
  // ═══════════════════════════════════════════════════════════
  _getGreeting(scenario, prospectName, region) {
    const firstName = prospectName.split(' ')[0];
    
    return `Good afternoon ${firstName}, this is Sales360 AI. I'm calling following your enquiry about reducing trader churn and improving qualification. Do you have a couple of minutes?`;
  }

  // ═══════════════════════════════════════════════════════════
  // HELPER: GET STARTING SCORE
  // ═══════════════════════════════════════════════════════════
  _getStartingScore(scenario) {
    return 28; // Default starting score for broker demos
  }

  // ═══════════════════════════════════════════════════════════
  // HELPER: GENERATE ERROR TwiML
  // ═══════════════════════════════════════════════════════════
  _generateErrorTwiML() {
    const twiml = new VoiceResponse();
    twiml.say({
      voice: 'Polly.Matthew',
      language: 'en-GB'
    }, "I apologize, but I'm experiencing technical difficulties. Please try again later or contact us directly.");
    twiml.hangup();
    return twiml.toString();
  }
}

module.exports = TwilioService;
