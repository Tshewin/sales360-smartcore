// ═══════════════════════════════════════════════════════════════
// SALES360 ZOHO CRM SERVICE - CHATGPT ALIGNED
// Phase 3C: AI Calling Agent Integration
// Follows: SALES360 AI CALLING AGENT ↔ SMARTCORE ↔ ZOHO EXECUTION GUIDE
// ═══════════════════════════════════════════════════════════════

class ZohoService {
  constructor() {
    this.clientId = process.env.ZOHO_CLIENT_ID;
    this.clientSecret = process.env.ZOHO_CLIENT_SECRET;
    this.refreshToken = process.env.ZOHO_REFRESH_TOKEN;
    this.apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.eu';
    this.smartcoreUrl = process.env.SMARTCORE_URL || 'https://sales360-smartcore-production.up.railway.app';
    
    // ✅ FIX 1: SmartCore payload compatibility toggle
    // Set to true for flat payload (new architecture)
    // Set to false for wrapped payload (legacy compatibility)
    this.USE_FLAT_PAYLOAD = process.env.SMARTCORE_USE_FLAT_PAYLOAD !== 'false'; // Default: true
    
    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      console.warn('[Zoho Service] ⚠️  Missing Zoho credentials - CRM integration disabled');
      this.enabled = false;
    } else {
      console.log('[Zoho Service] ✅ Initialized');
      console.log('[Zoho Service] API Domain:', this.apiDomain);
      console.log('[Zoho Service] SmartCore URL:', this.smartcoreUrl);
      console.log('[Zoho Service] Payload Format:', this.USE_FLAT_PAYLOAD ? 'FLAT (new)' : 'WRAPPED (legacy)');
      this.enabled = true;
    }
    
    // ✅ FIX 3: Validate SmartCore API key
    if (process.env.SMARTCORE_API_KEY) {
      console.log('[Zoho Service] 🔑 SmartCore API key configured');
    } else {
      console.warn('[Zoho Service] ⚠️  SMARTCORE_API_KEY missing — requests may be rejected');
    }
    
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  // ═══════════════════════════════════════════════════════════════
  // OAUTH2 TOKEN MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  
  async getAccessToken() {
    if (!this.enabled) {
      console.warn('[Zoho Service] Skipping token refresh - service disabled');
      return null;
    }

    // Check if current token is still valid (with 5 min buffer)
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry - 300000) {
      return this.accessToken;
    }

    console.log('[Zoho Service] 🔄 Refreshing access token...');

    try {
      const response = await fetch('https://accounts.zoho.eu/oauth/v2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          refresh_token: this.refreshToken,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'refresh_token'
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('[Zoho Service] ❌ Token refresh failed:', error);
        return null;
      }

      const data = await response.json();
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in * 1000);

      console.log('[Zoho Service] ✅ Access token refreshed');
      return this.accessToken;

    } catch (error) {
      console.error('[Zoho Service] ❌ Token refresh error:', error.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FETCH LEAD FOR PRE-CALL CONTEXT
  // Uses: SmartScore_Intent1, SmartScore_Behaviour, SmartScore_Next_Agent
  // ═══════════════════════════════════════════════════════════════
  
  async fetchLeadForCall(leadId) {
    if (!this.enabled) {
      console.warn('[Zoho Service] CRM integration disabled - returning null');
      return null;
    }

    try {
      const token = await this.getAccessToken();
      if (!token) {
        console.error('[Zoho Service] No access token available');
        return null;
      }

      console.log(`[Zoho Service] 📥 Fetching lead: ${leadId}`);

      const response = await fetch(
        `${this.apiDomain}/crm/v2/Leads/${leadId}`,
        {
          headers: {
            'Authorization': `Zoho-oauthtoken ${token}`
          }
        }
      );

      if (!response.ok) {
        const error = await response.text();
        console.error('[Zoho Service] ❌ Lead fetch failed:', error);
        return null;
      }

      const data = await response.json();
      
      if (!data.data || data.data.length === 0) {
        console.error('[Zoho Service] ❌ Lead not found:', leadId);
        return null;
      }

      const lead = data.data[0];

      // Extract relevant fields for AI context (CHATGPT-ALIGNED FIELDS)
      const leadContext = {
        id: lead.id,
        fullName: lead.Full_Name || '',
        email: lead.Email || '',
        phone: lead.Phone || '',
        company: lead.Company || '',
        country: lead.Country || '',
        region: this._mapCountryToRegion(lead.Country || ''),
        
        // ✅ B2B/B2C CLASSIFICATION (ChatGPT aligned)
        // DEFAULT TO B2B (Sales360's primary ICP: brokers, exchanges, agencies)
        // ONLY default to B2C when explicitly set
        leadType: lead.Lead_Type || 'B2B',
        
        // ✅ CHATGPT-ALIGNED: Sales360 Smart fields (CORRECT NAMES)
        intentScore: lead.SmartScore_Intent1 || 0,           // ✅ CORRECT
        behaviourScore: lead.SmartScore_Behaviour || 0,      // ✅ CORRECT
        smartcoreScore: lead.SmartCore_Score || 0,           // ✅ CORRECT
        stage: lead.SmartStage || 'Cold',                    // ✅ CORRECT
        nextAgent: lead.SmartScore_Next_Agent || null,       // ✅ CORRECT
        lastAgent: lead.SmartLastAgent || null,              // ✅ NEW (ChatGPT directive)
        lastTouchAt: lead.SmartLastTouchAt || null,
        lastTouchChannel: lead.SmartLastTouchChannel || null,
        lastOutcome: lead.SmartLastOutcome || null,
        
        // Qualification data
        industryType: lead.Industry_Type || '',
        interestedServices: lead.Interested_Services || '',
        decisionLevel: lead.Decision_Level || '',
        currentChallenges: lead.Current_Challenges || '',
        budgetReadiness: lead.Budget_Readiness || '',
        
        // ✅ CONTEXT ENRICHMENT: Solo vs Corporate detection
        businessSize: lead.Business_Size || '',
        monthlyLeadsVolume: lead.Monthly_Leads_No || 0
      };
      
      // ✅ SAFEGUARD: Check for empty string and log warning
      if (!leadContext.leadType || leadContext.leadType.trim() === '') {
        console.warn(`[Zoho Service] ⚠️ LEAD_TYPE_MISSING for ${leadId} → Defaulted to B2B`);
        leadContext.leadType = 'B2B';
      }

      console.log('[Zoho Service] ✅ Lead fetched successfully');
      console.log('[Zoho Service] Lead:', leadContext.fullName, '| Type:', leadContext.leadType);
      console.log('[Zoho Service] IntentScore:', leadContext.intentScore, '| BehaviourScore:', leadContext.behaviourScore);
      console.log('[Zoho Service] Stage:', leadContext.stage, '| Next Agent:', leadContext.nextAgent);

      return leadContext;

    } catch (error) {
      console.error('[Zoho Service] ❌ Error fetching lead:', error.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // UPDATE INTENTSCORE IN REAL-TIME (DURING CALL)
  // ✅ OPTIMIZED: Only updates IntentScore during call
  // ✅ BehaviourScore tracked locally, updated at call end
  // ═══════════════════════════════════════════════════════════════
  
  async updateIntentScore(leadId, intentScore, behaviourDelta = 0) {
    if (!this.enabled) {
      console.warn('[Zoho Service] CRM integration disabled - skipping score update');
      return false;
    }

    try {
      const token = await this.getAccessToken();
      if (!token) {
        console.error('[Zoho Service] No access token available');
        return false;
      }

      console.log(`[Zoho Service] 📊 Updating IntentScore for lead ${leadId}: ${intentScore}`);

      // ✅ OPTIMIZED: Update SmartScore_Intent1 + SmartLastTouchAt ONLY
      // BehaviourScore is tracked locally and updated at call end (no GET needed)
      // DO NOT update SmartStage - SmartCore decides that after call
      const updateData = {
        data: [{
          id: leadId,
          SmartScore_Intent1: intentScore,
          SmartLastTouchAt: new Date().toISOString()
        }]
      };

      const response = await fetch(
        `${this.apiDomain}/crm/v2/Leads`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updateData)
        }
      );

      if (!response.ok) {
        const error = await response.text();
        console.error('[Zoho Service] ❌ Score update failed:', error);
        return false;
      }

      console.log('[Zoho Service] ✅ IntentScore updated:', intentScore, '| BehaviourScore tracked locally, will update at call end');

      return true;

    } catch (error) {
      console.error('[Zoho Service] ❌ Error updating scores:', error.message);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TRIGGER SMARTCORE AFTER CALL COMPLETION
  // CHATGPT PAYLOAD CONTRACT: B2B/B2C aligned payload
  // SmartCore decides: SmartStage, task creation, next action
  // ═══════════════════════════════════════════════════════════════
  
  async triggerSmartCore(postCallPayload) {
    if (!this.enabled) {
      console.warn('[Zoho Service] CRM integration disabled - skipping SmartCore trigger');
      return false;
    }

    try {
      const leadId = postCallPayload.lead_id;
      console.log(`[Zoho Service] 🚀 Triggering SmartCore for lead: ${leadId}`);
      console.log(`[Zoho Service] Lead Type: ${postCallPayload.lead_type}`);
      console.log(`[Zoho Service] Call outcome: ${postCallPayload.call_outcome}`);
      console.log(`[Zoho Service] Intent score: ${postCallPayload.intent_score_start} → ${postCallPayload.intent_score_final} (peak: ${postCallPayload.intent_score_peak})`);

      // ✅ STEP 1: Update last touch fields in Zoho
      const token = await this.getAccessToken();
      if (!token) {
        console.error('[Zoho Service] No access token - cannot update last touch');
        return false;
      }

      // ✅ RELIABILITY FIX 2: Normalize Buyer_Context to valid picklist values
      const normalizedBuyerContext = ['solo', 'corporate'].includes(postCallPayload.buyer_context) 
        ? postCallPayload.buyer_context 
        : 'corporate';

      const updateData = {
        data: [{
          id: leadId,
          SmartScore_Intent1: postCallPayload.intent_score_final,  // ✅ Final score (also updated live during call)
          SmartScore_Behaviour: postCallPayload.behaviour_score_final,  // ✅ OPTIMIZATION: Only updated at end
          SmartLastTouchAt: new Date().toISOString(),
          SmartLastTouchChannel: postCallPayload.last_touch_channel || 'AI Call',
          SmartLastOutcome: postCallPayload.last_outcome,
          SmartLastAgent: postCallPayload.last_agent,
          Buyer_Context: normalizedBuyerContext  // ✅ RELIABILITY: Only 'solo' or 'corporate'
        }]
      };

      const zohoUpdateResponse = await fetch(
        `${this.apiDomain}/crm/v2/Leads`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updateData)
        }
      );

      // ✅ CHECK 2: Validate response before logging success
      if (!zohoUpdateResponse.ok) {
        const error = await zohoUpdateResponse.text();
        console.error('[Zoho Service] ❌ Last touch update failed:', error);
        return false;
      }

      console.log('[Zoho Service] ✅ Last touch fields updated');

      // ✅ STEP 2: Send full payload to SmartCore
      console.log('[Zoho Service] 📤 Sending post-call payload to SmartCore...');
      
      // ✅ FIX 1: Payload compatibility layer
      let smartcorePayload;
      
      if (this.USE_FLAT_PAYLOAD) {
        // Option A: Flat payload (new architecture - PREFERRED)
        smartcorePayload = postCallPayload;
        console.log('[Zoho Service] 📦 Using FLAT payload format (new architecture)');
      } else {
        // Option B: Wrapped payload (legacy compatibility)
        smartcorePayload = {
          lead: {
            id: postCallPayload.lead_id,
            lead_type: postCallPayload.lead_type
          },
          last_agent: postCallPayload.last_agent,
          last_outcome: postCallPayload.last_outcome,
          intent_score: postCallPayload.intent_score_final,
          behaviour_score: postCallPayload.behaviour_score_final,
          metadata: postCallPayload
        };
        console.log('[Zoho Service] 📦 Using WRAPPED payload format (legacy compatibility)');
      }
      
      // ✅ FIX 4: Log payload size before sending
      console.log('[Zoho Service] 📦 Final Payload Size:', JSON.stringify(smartcorePayload).length, 'bytes');
      
      // ✅ FIX 3: Build headers with SmartCore security key
      const smartcoreHeaders = {
        'Content-Type': 'application/json'
      };
      
      // Add X-SMARTCORE-KEY if environment variable exists
      if (process.env.SMARTCORE_API_KEY) {
        smartcoreHeaders['X-SMARTCORE-KEY'] = process.env.SMARTCORE_API_KEY;
      } else {
        console.warn('[Zoho Service] ⚠️  SMARTCORE_API_KEY missing — request may be rejected');
      }
      
      // ✅ RELIABILITY FIX 1: SmartCore timeout protection (8 seconds)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      
      let smartcoreResponse;
      try {
        smartcoreResponse = await fetch(
          `${this.smartcoreUrl}/cadence/run`,
          {
            method: 'POST',
            headers: smartcoreHeaders,
            body: JSON.stringify(smartcorePayload),
            signal: controller.signal
          }
        );
        clearTimeout(timeout);
      } catch (fetchError) {
        clearTimeout(timeout);
        if (fetchError.name === 'AbortError') {
          console.error('[Zoho Service] ⏱️  SmartCore request timed out (8s limit)');
          return false;
        }
        throw fetchError; // Re-throw non-timeout errors
      }

      if (!smartcoreResponse.ok) {
        const error = await smartcoreResponse.text();
        console.error('[Zoho Service] ❌ SmartCore trigger failed:', error);
        return false;
      }

      const result = await smartcoreResponse.json();
      
      // ✅ FIX 4: Enhanced SmartCore decision logging
      console.log('[Zoho Service] ✅ SmartCore triggered successfully');
      console.log('[Zoho Service] 🎯 SmartCore Decision:', {
        nextAgent: result?.cadence_decision?.next_agent || result?.next_agent || 'N/A',
        action: result?.agent_action?.message_type || result?.action || 'N/A',
        stage: result?.stage || 'N/A',
        taskCreated: result?.task_created || false
      });
      
      // Log full response for debugging (can be disabled in production)
      if (process.env.NODE_ENV !== 'production') {
        console.log('[Zoho Service] 📋 Full SmartCore response:', JSON.stringify(result, null, 2));
      }

      return true;

    } catch (error) {
      console.error('[Zoho Service] ❌ Error triggering SmartCore:', error.message);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPER: MAP COUNTRY TO REGION
  // ═══════════════════════════════════════════════════════════════
  
  _mapCountryToRegion(country) {
    const c = country.toLowerCase();
    
    if (c.includes('nigeria')) return 'Nigeria';
    if (c.includes('united kingdom') || c === 'uk' || c.includes('england') || c.includes('london')) return 'UK';
    if (c.includes('dubai') || c.includes('uae') || c.includes('united arab emirates')) return 'Dubai';
    if (c.includes('south africa')) return 'South Africa';
    
    return country; // Return as-is if no match
  }

  // ═══════════════════════════════════════════════════════════════
  // CHECK IF SERVICE IS ENABLED
  // ═══════════════════════════════════════════════════════════════
  
  isEnabled() {
    return this.enabled;
  }
}

module.exports = ZohoService;
