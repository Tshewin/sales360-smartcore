/**
 * Sales360 - Twilio Phone Integration Service
 * Handles inbound/outbound calls with AI conversation
 */

const twilio = require('twilio');

class TwilioService {
  constructor() {
    this.accountSid = process.env.TWILIO_ACCOUNT_SID;
    this.authToken = process.env.TWILIO_AUTH_TOKEN;
    this.phoneNumber = process.env.TWILIO_PHONE_NUMBER;
    this.client = twilio(this.accountSid, this.authToken);
    
    this.activeCalls = new Map(); // Store active call data
    
    console.log('[Twilio Service] Initialized with number:', this.phoneNumber);
  }

  /**
   * Make outbound call
   * @param {string} to - Phone number to call (E.164 format: +1234567890)
   * @param {object} callData - Call metadata (prospectName, region, scenario, etc.)
   * @param {string} webhookBaseUrl - Base URL for Twilio webhooks
   */
  async makeCall(to, callData, webhookBaseUrl) {
    try {
      console.log(`[Twilio] Making call to ${to}`);
      
      const call = await this.client.calls.create({
        to: to,
        from: this.phoneNumber,
        url: `${webhookBaseUrl}/twilio/voice`, // TwiML endpoint
        statusCallback: `${webhookBaseUrl}/twilio/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        record: true, // Record the call
        recordingStatusCallback: `${webhookBaseUrl}/twilio/recording`,
        recordingStatusCallbackMethod: 'POST'
      });

      // Store call data
      this.activeCalls.set(call.sid, {
        sid: call.sid,
        to: to,
        from: this.phoneNumber,
        status: 'initiated',
        startTime: new Date(),
        ...callData
      });

      console.log(`[Twilio] Call initiated: ${call.sid}`);
      
      return {
        success: true,
        callSid: call.sid,
        status: call.status
      };
      
    } catch (error) {
      console.error('[Twilio] Error making call:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Generate TwiML for call greeting
   * @param {string} callSid - Call SID
   */
  generateGreetingTwiML(callSid) {
    const callData = this.activeCalls.get(callSid) || {};
    const prospectName = callData.prospectName || 'there';
    
    // Generate AI greeting based on scenario
    const greeting = this.generateAIGreeting(callData);
    
    const twiml = new twilio.twiml.VoiceResponse();
    
    // Say greeting with AI voice
    twiml.say({
      voice: 'Polly.Matthew', // AWS Polly voice (we'll upgrade to ElevenLabs later)
      language: 'en-US'
    }, greeting);
    
    // Gather user response (up to 30 seconds of speech)
    const gather = twiml.gather({
      input: 'speech',
      timeout: 5,
      speechTimeout: 'auto',
      action: '/twilio/gather',
      method: 'POST'
    });
    
    // If no response, prompt again
    twiml.say({
      voice: 'Polly.Matthew',
      language: 'en-US'
    }, "I didn't catch that. Are you still there?");
    
    return twiml.toString();
  }

  /**
   * Generate AI greeting based on scenario
   */
  generateAIGreeting(callData) {
    const { scenario, prospectName, region } = callData;
    
    // Default greeting
    let greeting = `Hello, this is the Sales360 AI assistant. Am I speaking with ${prospectName || 'the right person'}?`;
    
    // Customize by scenario (we'll make this dynamic with Claude API later)
    if (scenario === 'broker') {
      greeting = `Good afternoon, this is Sales360 AI. I'm calling regarding your enquiry about improving trader qualification. Do you have a couple of minutes?`;
    }
    
    return greeting;
  }

  /**
   * Process user speech response
   * @param {string} callSid - Call SID
   * @param {string} speechResult - User's speech transcription
   */
  async processUserResponse(callSid, speechResult) {
    console.log(`[Twilio] User response (${callSid}):`, speechResult);
    
    const callData = this.activeCalls.get(callSid);
    if (!callData) {
      console.error('[Twilio] Call data not found:', callSid);
      return this.generateErrorTwiML();
    }
    
    // Store conversation history
    if (!callData.transcript) {
      callData.transcript = [];
    }
    
    callData.transcript.push({
      speaker: 'user',
      message: speechResult,
      timestamp: new Date().toISOString()
    });
    
    // TODO: Send to Claude API for AI response
    // For now, use simple response
    const aiResponse = "Thank you for that information. I understand you're interested in our solution. Can you tell me more about your current challenges?";
    
    callData.transcript.push({
      speaker: 'ai',
      message: aiResponse,
      timestamp: new Date().toISOString()
    });
    
    // Update call data
    this.activeCalls.set(callSid, callData);
    
    // Generate TwiML response
    const twiml = new twilio.twiml.VoiceResponse();
    
    twiml.say({
      voice: 'Polly.Matthew',
      language: 'en-US'
    }, aiResponse);
    
    // Continue gathering responses
    twiml.gather({
      input: 'speech',
      timeout: 5,
      speechTimeout: 'auto',
      action: '/twilio/gather',
      method: 'POST'
    });
    
    return twiml.toString();
  }

  /**
   * Handle call status updates
   */
  handleStatusUpdate(callSid, status, data) {
    console.log(`[Twilio] Call ${callSid} status: ${status}`);
    
    const callData = this.activeCalls.get(callSid);
    if (callData) {
      callData.status = status;
      callData.duration = data.CallDuration;
      this.activeCalls.set(callSid, callData);
    }
    
    // Broadcast to WebSocket (we'll connect this next)
    return {
      callSid,
      status,
      callData
    };
  }

  /**
   * Handle recording available
   */
  handleRecording(callSid, recordingUrl, recordingSid) {
    console.log(`[Twilio] Recording available for ${callSid}:`, recordingUrl);
    
    const callData = this.activeCalls.get(callSid);
    if (callData) {
      callData.recordingUrl = recordingUrl;
      callData.recordingSid = recordingSid;
      this.activeCalls.set(callSid, callData);
    }
    
    return { callSid, recordingUrl };
  }

  /**
   * End call
   */
  async endCall(callSid) {
    try {
      await this.client.calls(callSid).update({ status: 'completed' });
      
      const callData = this.activeCalls.get(callSid);
      this.activeCalls.delete(callSid);
      
      console.log(`[Twilio] Call ended: ${callSid}`);
      return { success: true, callData };
      
    } catch (error) {
      console.error('[Twilio] Error ending call:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get active call data
   */
  getCallData(callSid) {
    return this.activeCalls.get(callSid);
  }

  /**
   * Get all active calls
   */
  getAllActiveCalls() {
    return Array.from(this.activeCalls.values());
  }

  /**
   * Generate error TwiML
   */
  generateErrorTwiML() {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({
      voice: 'Polly.Matthew',
      language: 'en-US'
    }, "I'm sorry, there was an error processing your call. Please try again later. Goodbye.");
    twiml.hangup();
    return twiml.toString();
  }
}

// Singleton instance
const twilioService = new TwilioService();

module.exports = twilioService;
