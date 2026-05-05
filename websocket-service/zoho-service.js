// ═══════════════════════════════════════════════════════════════
// SALES360 ZOHO CRM SERVICE - PHASE 3C FINAL
// CRITICAL FIXES:
// 1. SmartScore_intent1 (lowercase "i" + "1") - CORRECT API NAME
// 2. Mandatory pre-call Zoho Deluge function enrichment
// 3. Enhanced logging for B2B/B2C routing diagnostics
// ═══════════════════════════════════════════════════════════════

class ZohoService {
  constructor() {
    this.clientId = process.env.ZOHO_CLIENT_ID;
    this.clientSecret = process.env.ZOHO_CLIENT_SECRET;
    this.refreshToken = process.env.ZOHO_REFRESH_TOKEN;
    this.apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.eu';
    this.smartcoreUrl = process.env.SMARTCORE_URL || 'https://sales360-smartcore-production.up.railway.app';
    
    // ✅ ZOHO DELUGE FUNCTION ENDPOINTS (OAuth2-enabled REST APIs)
    this.delugePreCallFetch = `${this.apiDomain}/crm/v7/functions/sales360_pre_call_fetch/actions/execute`;
    this.delugeUpdateScore = `${this.apiDomain}/crm/v7/functions/sales360_update_intent_score/actions/execute`;
    
    this.USE_FLAT_PAYLOAD = process.env.SMARTCORE_USE_FLAT_PAYLOAD !== 'false';
    
    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      console.warn('[Zoho Service] ⚠️  Missing Zoho credentials - CRM integration disabled');
      this.enabled = false;
    } else {
      console.log('[Zoho Service] ✅ Initialized');
      console.log('[Zoho Service] API Domain:', this.apiDomain);
      console.log('[Zoho Service] SmartCore URL:', this.smartcoreUrl);
      console.log('[Zoho Service] Deluge Pre-Call:', this.delugePreCallFetch);
      console.log('[Zoho Service] Deluge Update Score:', this.delugeUpdateScore);
      this.enabled = true;
    }
    
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
  // ✅ NEW: MANDATORY PRE-CALL ENRICHMENT VIA DELUGE FUNCTION
  // Replaces direct CRM API fetch with standalone Deluge function
  // Returns: Full lead context for AI prompt selection
  // ═══════════════════════════════════════════════════════════════
  
  async enrichLeadBeforeCall(leadId) {
    if (!this.enabled) {
      console.warn('[Zoho PreCall] CRM integration disabled - returning null');
      return null;
    }

    console.log(`[Zoho PreCall] 🔍 Fetch started for leadId: ${leadId}`);

    try {
      const token = await this.getAccessToken();
      if (!token) {
        console.error('[Zoho PreCall] ❌ No access token available');
        return null;
      }

      // Call Zoho Deluge standalone function
      const response = await fetch(this.delugePreCallFetch, {
        method: 'POST',
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          arguments: JSON.stringify({ lead_id: leadId })  // ✅ FIX: Use lead_id (underscore)
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('[Zoho PreCall] ❌ Deluge function call failed:', error);
        return null;
      }

      const data = await response.json();
      
      console.log('[Zoho PreCall] 📥 Raw response:', JSON.stringify(data));

      // Extract output from Deluge function response
      const output = data.details?.output;
      
      if (!output || !output.success) {
        console.error('[Zoho PreCall] ❌ Deluge function returned error:', output?.error || 'Unknown error');
        return null;
      }

      // Parse lead data from Deluge response
      const leadData = {
        leadId: output.lead_id,
        fullName: output.full_name,
        email: output.email,
        phone: output.phone,
        company: output.company,
        country: output.country,
        leadType: output.lead_type || 'B2B',  // ✅ DEFAULT TO B2B
        intentScore: output.intent_score || 0,
        behaviourScore: output.behaviour_score || 0,
        smartcoreScore: output.smartcore_score || 0,
        stage: output.stage || 'Cold',
        nextAgent: output.next_agent,
        lastAgent: output.last_agent,
        lastTouchAt: output.last_touch_at,
        lastTouchChannel: output.last_touch_channel,
        lastOutcome: output.last_outcome,
        daysSinceLastTouch: output.days_since_last_touch || 0,
        
        // B2B-specific data
        industryType: output.industry_type,
        interestedServices: output.interested_services,
        decisionLevel: output.decision_level,
        currentChallenges: output.current_challenges,
        budgetReadiness: output.budget_readiness,
        businessSize: output.business_size,
        monthlyLeadsVolume: output.monthly_leads_volume || 0,
        entryChannel: output.entry_channel,
        leadSource: output.lead_source
      };

      // ✅ DIAGNOSTIC LOGGING (ChatGPT requirement)
      console.log(`[Zoho PreCall] ✅ Parsed lead_type: ${leadData.leadType}`);
      console.log(`[Zoho PreCall] ✅ Parsed intent_score: ${leadData.intentScore}`);
      console.log(`[Zoho PreCall] ✅ Parsed behaviour_score: ${leadData.behaviourScore}`);
      console.log(`[Zoho PreCall] ✅ Parsed stage: ${leadData.stage}`);
      
      // Select prompt branch based on Lead_Type
      const promptBranch = leadData.leadType === 'B2C' 
        ? 'B2C trader/end-user' 
        : 'B2B client acquisition';
      
      console.log(`[Zoho PreCall] 🎯 Prompt branch selected: ${promptBranch}`);
      console.log(`[Zoho PreCall] ✅ Enrichment complete for: ${leadData.fullName}`);

      return leadData;

    } catch (error) {
      console.error('[Zoho PreCall] ❌ Exception:', error.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ✅ LEGACY: DIRECT CRM API FETCH (DEPRECATED - USE enrichLeadBeforeCall)
  // Kept for backward compatibility
  // ═══════════════════════════════════════════════════════════════
  
  async fetchLeadForCall(leadId) {
    console.warn('[Zoho Service] ⚠️  Using LEGACY fetchLeadForCall - prefer enrichLeadBeforeCall instead');
    
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

      // Extract relevant fields (CORRECTED FIELD NAMES)
      const leadContext = {
        id: lead.id,
        fullName: lead.Full_Name || '',
        email: lead.Email || '',
        phone: lead.Phone || '',
        company: lead.Company || '',
        country: lead.Country || '',
        region: this._mapCountryToRegion(lead.Country || ''),
        
        leadType: lead.Lead_Type || 'B2B',
        
        // ✅ CRITICAL FIX: SmartScore_intent1 (lowercase "i" + "1")
        intentScore: lead.SmartScore_intent1 || 0,           // ✅ CORRECTED
        behaviourScore: lead.SmartScore_Behaviour || 0,
        smartcoreScore: lead.SmartCore_Score || 0,
        stage: lead.SmartStage || 'Cold',
        nextAgent: lead.SmartScore_Next_Agent || null,
        lastAgent: lead.SmartLastAgent || null,
        lastTouchAt: lead.SmartLastTouchAt || null,
        lastTouchChannel: lead.SmartLastTouchChannel || null,
        lastOutcome: lead.SmartLastOutcome || null,
        
        industryType: lead.Industry_Type || '',
        interestedServices: lead.Interested_Services || '',
        decisionLevel: lead.Decision_Level || '',
        currentChallenges: lead.Current_Challenges || '',
        budgetReadiness: lead.Budget_Readiness || '',
        businessSize: lead.Business_Size || '',
        monthlyLeadsVolume: lead.Monthly_Leads_No || 0
      };
      
      if (!leadContext.leadType || leadContext.leadType.trim() === '') {
        console.warn(`[Zoho Service] ⚠️ LEAD_TYPE_MISSING for ${leadId} → Defaulted to B2B`);
        leadContext.leadType = 'B2B';
      }

      console.log('[Zoho Service] ✅ Lead fetched successfully');
      console.log('[Zoho Service] Lead:', leadContext.fullName, '| Type:', leadContext.leadType);

      return leadContext;

    } catch (error) {
      console.error('[Zoho Service] ❌ Error fetching lead:', error.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ✅ UPDATE INTENTSCORE IN REAL-TIME VIA DELUGE FUNCTION
  // Called DURING active call to update IntentScore + BehaviourScore
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

      // ✅ RELIABILITY: Cap IntentScore 0-100
      const cappedScore = Math.max(0, Math.min(100, intentScore));
      
      console.log(`[Zoho Service] 📊 Live IntentScore update: leadId=${leadId}, score=${cappedScore}, behaviourDelta=${behaviourDelta}`);

      // Call Zoho Deluge standalone function
      const response = await fetch(this.delugeUpdateScore, {
        method: 'POST',
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          arguments: JSON.stringify({
            lead_id: leadId,              // ✅ FIX: Use lead_id (underscore)
            intent_score: cappedScore,    // ✅ FIX: Use intent_score (underscore)
            behaviour_delta: behaviourDelta  // ✅ FIX: Use behaviour_delta (underscore)
          })
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('[Zoho Service] ❌ Deluge score update failed:', error);
        return false;
      }

      const data = await response.json();
      const output = data.details?.output;

      if (!output || !output.success) {
        console.error('[Zoho Service] ❌ Deluge function returned error:', output?.error || 'Unknown error');
        return false;
      }

      console.log('[Zoho Service] ✅ IntentScore updated via Deluge:', output.intent_score);

      return true;

    } catch (error) {
      console.error('[Zoho Service] ❌ Error updating scores:', error.message);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TRIGGER SMARTCORE AFTER CALL COMPLETION
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

      // Update last touch fields in Zoho
      const token = await this.getAccessToken();
      if (!token) {
        console.error('[Zoho Service] No access token - cannot update last touch');
        return false;
      }

      const normalizedBuyerContext = ['solo', 'corporate'].includes(postCallPayload.buyer_context) 
        ? postCallPayload.buyer_context 
        : 'corporate';

      const updateData = {
        data: [{
          id: leadId,
          SmartScore_intent1: postCallPayload.intent_score_final,  // ✅ CORRECTED FIELD NAME
          SmartScore_Behaviour: postCallPayload.behaviour_score_final,
          SmartLastTouchAt: new Date().toISOString(),
          SmartLastTouchChannel: postCallPayload.last_touch_channel || 'AI Call',
          SmartLastOutcome: postCallPayload.last_outcome,
          SmartLastAgent: postCallPayload.last_agent,
          Buyer_Context: normalizedBuyerContext
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

      if (!zohoUpdateResponse.ok) {
        const error = await zohoUpdateResponse.text();
        console.error('[Zoho Service] ❌ Last touch update failed:', error);
        return false;
      }

      console.log('[Zoho Service] ✅ Last touch fields updated');

      // Send payload to SmartCore
      console.log('[Zoho Service] 📤 Sending post-call payload to SmartCore...');
      
      let smartcorePayload;
      
      if (this.USE_FLAT_PAYLOAD) {
        smartcorePayload = postCallPayload;
      } else {
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
      }
      
      const smartcoreHeaders = {
        'Content-Type': 'application/json'
      };
      
      if (process.env.SMARTCORE_API_KEY) {
        smartcoreHeaders['X-SMARTCORE-KEY'] = process.env.SMARTCORE_API_KEY;
      }
      
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
        throw fetchError;
      }

      if (!smartcoreResponse.ok) {
        const error = await smartcoreResponse.text();
        console.error('[Zoho Service] ❌ SmartCore trigger failed:', error);
        return false;
      }

      const result = await smartcoreResponse.json();
      
      console.log('[Zoho Service] ✅ SmartCore triggered successfully');

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
    
    return country;
  }

  // ═══════════════════════════════════════════════════════════════
  // CHECK IF SERVICE IS ENABLED
  // ═══════════════════════════════════════════════════════════════
  
  isEnabled() {
    return this.enabled;
  }
}

module.exports = ZohoService;
