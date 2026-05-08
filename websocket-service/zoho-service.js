// ═══════════════════════════════════════════════════════════════
// ZOHO CRM SERVICE — OAuth2 + Deluge Functions Integration
// Phase 3C: Mandatory Pre-Call Enrichment + Real-Time Updates
// ═══════════════════════════════════════════════════════════════

class ZohoService {
  constructor() {
    this.clientId = process.env.ZOHO_CLIENT_ID;
    this.clientSecret = process.env.ZOHO_CLIENT_SECRET;
    this.refreshToken = process.env.ZOHO_REFRESH_TOKEN;
    this.apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.eu';
    this.accountsDomain = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.eu';
    
    this.accessToken = null;
    this.tokenExpiry = null;
    this.smartcoreUrl = process.env.SMARTCORE_URL || 'https://sales360-smartcore-production.up.railway.app';
    
    // ✅ ZOHO DELUGE FUNCTION ENDPOINTS (OAuth2-enabled REST APIs)
    this.delugePreCallFetch = `${this.apiDomain}/crm/v7/functions/sales360_pre_call_fetch/actions/execute`;
    this.delugeUpdateScore = `${this.apiDomain}/crm/v7/functions/sales360_update_intent_score/actions/execute`;
    
    // ✅ SmartCore payload format (nested by default)
    // SmartCore expects: { "lead": { ...all fields... } }
    this.USE_FLAT_PAYLOAD = process.env.SMARTCORE_USE_FLAT_PAYLOAD === 'true';
    
    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      console.warn('[Zoho Service] ⚠️  Missing Zoho credentials - CRM integration disabled');
      this.enabled = false;
    } else {
      this.enabled = true;
      console.log('[Zoho Service] ✅ Initialized');
      console.log('[Zoho Service] API Domain:', this.apiDomain);
      console.log('[Zoho Service] SmartCore URL:', this.smartcoreUrl);
      console.log('[Zoho Service] Deluge Pre-Call:', this.delugePreCallFetch.split('/').pop());
      console.log('[Zoho Service] Deluge Update Score:', this.delugeUpdateScore.split('/').pop());
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // OAUTH2 TOKEN MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  
  async getAccessToken() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    console.log('[Zoho Service] 🔄 Refreshing access token...');

    try {
      const response = await fetch(`${this.accountsDomain}/oauth/v2/token`, {
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
        const errorText = await response.text();
        console.error('[Zoho Service] ❌ Token refresh failed:', errorText);
        return null;
      }

      const data = await response.json();
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;

      console.log('[Zoho Service] ✅ Access token refreshed');
      return this.accessToken;

    } catch (error) {
      console.error('[Zoho Service] ❌ Error refreshing token:', error.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ✅ MANDATORY PRE-CALL ENRICHMENT VIA DELUGE FUNCTION
  // Called BEFORE every call to fetch lead context from Zoho
  // Returns: Lead Type (B2B/B2C), Buyer Context (solo/corporate), IntentScore
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

      // ═══════════════════════════════════════════════════════════
      // DIAGNOSTIC LOGGING (ChatGPT requirement)
      // ═══════════════════════════════════════════════════════════
      const functionUrl = `${this.delugePreCallFetch}?auth_type=oauth&leadId=${leadId}`;
      
      console.log('[Zoho PreCall] 🔍 DIAGNOSTIC - Calling Deluge function:');
      console.log('[Zoho PreCall]    Endpoint:', this.delugePreCallFetch.replace(token, '[REDACTED]'));
      console.log('[Zoho PreCall]    HTTP Method: POST');
      console.log('[Zoho PreCall]    Parameter Name: leadId (camelCase - matches Deluge signature)');
      console.log('[Zoho PreCall]    Parameter Value:', leadId);
      console.log('[Zoho PreCall]    Parameter Format: URL query string');
      console.log('[Zoho PreCall]    Full URL (auth redacted):', functionUrl.replace(token, '[REDACTED]'));
      
      // Call Zoho Deluge standalone function (OAuth-enabled)
      // CRITICAL: Parameter name MUST match function signature exactly!
      // Function signature: string standalone.sales360_pre_call_fetch(String leadId)
      // Therefore: Use "leadId" NOT "lead_id"
      const response = await fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json'
        }
      });

      console.log('[Zoho PreCall] 📥 Response Status:', response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Zoho PreCall] ❌ Response Body:', errorText);
        console.error('[Zoho PreCall] ❌ Deluge function call failed');
        return null;
      }

      const data = await response.json();
      
      console.log('[Zoho PreCall] 📥 Raw response:', JSON.stringify(data));

      // ═══════════════════════════════════════════════════════════
      // ZOHO DELUGE RESPONSE PARSING (ChatGPT requirement)
      // ═══════════════════════════════════════════════════════════
      // Step 1: Check outer response code
      if (data.code !== 'success') {
        console.error('[Zoho PreCall] ❌ Outer response not successful:', data.code);
        console.error('[Zoho PreCall] ❌ Message:', data.message);
        return null;
      }

      // Step 2: Extract output string from details
      const outputString = data.details?.output;
      
      if (!outputString) {
        console.error('[Zoho PreCall] ❌ No output in Deluge response');
        return null;
      }

      // Step 3: Parse the JSON string
      let output;
      try {
        output = JSON.parse(outputString);
      } catch (parseError) {
        console.error('[Zoho PreCall] ❌ Failed to parse output JSON:', parseError.message);
        console.error('[Zoho PreCall] ❌ Raw output:', outputString);
        return null;
      }
      
      // Step 4: Check inner success flag
      if (!output || output.success !== true) {
        console.error('[Zoho PreCall] ❌ Deluge function returned error:', output?.error || 'Unknown error');
        return null;
      }

      console.log('[Zoho PreCall] ✅ Deluge function succeeded');

      // Parse lead data from Deluge response
      const leadData = {
        id: output.lead_id,
        fullName: output.full_name || '',
        email: output.email || '',
        phone: output.phone || '',
        company: output.company || '',
        country: output.country || '',
        
        // ✅ CRITICAL: Lead Type (B2B vs B2C)
        leadType: output.lead_type || 'B2B',
        
        // ✅ CRITICAL: IntentScore (0-100)
        intentScore: output.intent_score || 0,
        behaviourScore: output.behaviour_score || 0,
        smartcoreScore: output.smartcore_score || 0,
        
        stage: output.stage || 'Cold',
        nextAgent: output.next_agent || null,
        lastAgent: output.last_agent || null,
        lastTouchAt: output.last_touch_at || null,
        lastTouchChannel: output.last_touch_channel || null,
        lastOutcome: output.last_outcome || null,
        
        // B2B-specific fields
        industryType: output.industry_type || '',
        interestedServices: output.interested_services || [],
        decisionLevel: output.decision_level || '',
        currentChallenges: output.current_challenges || '',
        budgetReadiness: output.budget_readiness || '',
        businessSize: output.business_size || '',
        monthlyLeadsVolume: output.monthly_leads_volume || 0,
        
        // Additional metadata
        entryChannel: output.entry_channel || '',
        leadSource: output.lead_source || '',
        daysSinceLastTouch: output.days_since_last_touch || 0
      };

      console.log('[Zoho PreCall] ✅ Parsed lead_type:', leadData.leadType);
      console.log('[Zoho PreCall] ✅ Parsed intent_score:', leadData.intentScore);
      console.log('[Zoho PreCall] ✅ Parsed behaviour_score:', leadData.behaviourScore);
      console.log('[Zoho PreCall] ✅ Parsed stage:', leadData.stage);
      
      // ✅ PROMPT BRANCH SELECTION (B2B vs B2C)
      if (leadData.leadType === 'B2C') {
        console.log('[Zoho PreCall] 🎯 Prompt branch selected: B2C trader/end-user');
      } else {
        console.log('[Zoho PreCall] 🎯 Prompt branch selected: B2B client acquisition');
      }
      
      console.log('[Zoho PreCall] ✅ Enrichment complete for:', leadData.fullName);

      return leadData;

    } catch (error) {
      console.error('[Zoho PreCall] ❌ Error during enrichment:', error.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LEGACY: DIRECT ZOHO API FETCH (Deprecated - use enrichLeadBeforeCall instead)
  // ═══════════════════════════════════════════════════════════════
  
  async fetchLead(leadId) {
    if (!this.enabled) {
      console.warn('[Zoho Service] CRM integration disabled - skipping fetch');
      return null;
    }

    console.log(`[Zoho Service] 🔍 Fetching lead: ${leadId}`);

    try {
      const token = await this.getAccessToken();
      if (!token) {
        console.error('[Zoho Service] No access token available');
        return null;
      }

      const response = await fetch(
        `${this.apiDomain}/crm/v2/Leads/${leadId}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Zoho-oauthtoken ${token}`
          }
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Zoho Service] ❌ Fetch failed:', errorText);
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

      // ═══════════════════════════════════════════════════════════
      // DIAGNOSTIC LOGGING (ChatGPT requirement)
      // ═══════════════════════════════════════════════════════════
      const functionUrl = `${this.delugeUpdateScore}?auth_type=oauth&leadId=${leadId}&score=${cappedScore}&behaviourDelta=${behaviourDelta}`;
      
      console.log('[Zoho UpdateScore] 🔍 DIAGNOSTIC - Calling Deluge function:');
      console.log('[Zoho UpdateScore]    Endpoint:', this.delugeUpdateScore);
      console.log('[Zoho UpdateScore]    HTTP Method: POST');
      console.log('[Zoho UpdateScore]    Parameters: leadId, score, behaviourDelta (matching Deluge signature)');
      console.log('[Zoho UpdateScore]    Values: leadId=', leadId, 'score=', cappedScore, 'behaviourDelta=', behaviourDelta);
      console.log('[Zoho UpdateScore]    Parameter Format: URL query string');
      
      // Call Zoho Deluge standalone function (OAuth-enabled)
      // CRITICAL: Parameter names MUST match function signature exactly!
      // Function signature: string standalone.sales360_update_intent_score(String leadId, String score, String behaviourDelta)
      const response = await fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json'
        }
      });

      console.log('[Zoho UpdateScore] 📥 Response Status:', response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Zoho UpdateScore] ❌ Response Body:', errorText);
        console.error('[Zoho UpdateScore] ❌ Deluge score update failed');
        return false;
      }

      const data = await response.json();

      // ═══════════════════════════════════════════════════════════
      // ZOHO DELUGE RESPONSE PARSING (ChatGPT requirement)
      // ═══════════════════════════════════════════════════════════
      // Step 1: Check outer response code
      if (data.code !== 'success') {
        console.error('[Zoho UpdateScore] ❌ Outer response not successful:', data.code);
        console.error('[Zoho UpdateScore] ❌ Message:', data.message);
        return false;
      }

      // Step 2: Extract output string from details
      const outputString = data.details?.output;
      
      if (!outputString) {
        console.error('[Zoho UpdateScore] ❌ No output in Deluge response');
        return false;
      }

      // Step 3: Parse the JSON string
      let output;
      try {
        output = JSON.parse(outputString);
      } catch (parseError) {
        console.error('[Zoho UpdateScore] ❌ Failed to parse output JSON:', parseError.message);
        console.error('[Zoho UpdateScore] ❌ Raw output:', outputString);
        return false;
      }

      // Step 4: Check inner success flag
      if (!output || output.success !== true) {
        console.error('[Zoho UpdateScore] ❌ Deluge function returned error:', output?.error || 'Unknown error');
        return false;
      }

      console.log('[Zoho UpdateScore] ✅ IntentScore updated successfully');
      console.log('[Zoho UpdateScore] ✅ Final score:', output.intent_score);

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
        // FLAT PAYLOAD (deprecated - SmartCore doesn't use this anymore)
        smartcorePayload = postCallPayload;
      } else {
        // NESTED PAYLOAD (SmartCore expects this format)
        // Wrap the entire post-call payload inside "lead" object
        smartcorePayload = {
          lead: postCallPayload
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
      console.log('[Zoho Service] Next Action:', result.next_action || 'none');

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
    const countryLower = country.toLowerCase();
    
    if (countryLower.includes('nigeria')) return 'Nigeria';
    if (countryLower.includes('united kingdom') || countryLower.includes('uk')) return 'UK';
    if (countryLower.includes('united arab emirates') || countryLower.includes('dubai')) return 'Dubai';
    if (countryLower.includes('south africa')) return 'South Africa';
    if (countryLower.includes('kenya')) return 'Kenya';
    if (countryLower.includes('ghana')) return 'Ghana';
    
    return country;
  }
}

module.exports = ZohoService;
