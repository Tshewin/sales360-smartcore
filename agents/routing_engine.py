from models.lead_model import LeadData


def route_lead(lead: LeadData, scoring_result: dict) -> dict:
    """
    Simple rule-based routing engine for Sales360.
    Uses score, intent, call_decision and basic behaviour to pick the next AI agent.
    """

    score = scoring_result.get("score", 0)
    intent = scoring_result.get("intent_level", "Cold")
    call_decision = scoring_result.get("call_decision", "no_call")
    signal_strength = scoring_result.get("signal_strength", "Low")

    # Default routing
    agent = "nurture_agent"
    channel = "email"
    persistence = "low"
    notes = "Default route – low priority nurture."

    # 1. HOT LEADS → AI Call Agent + WhatsApp
    if intent == "Hot" or call_decision == "call_now":
        agent = "ai_call_agent"
        channel = "phone_call + whatsapp"
        persistence = "high"
        notes = "High intent lead. Call immediately, follow up via WhatsApp."

    # 2. WARM LEADS → Nurture then Call
    elif intent == "Warm" or call_decision == "call_after_intake":
        agent = "nurture_agent"
        channel = "whatsapp + email"
        persistence = "medium"
        notes = "Warm lead. Start nurture, then hand off to call agent if engagement increases."

        # If region is Nigeria or Dubai, we might be a bit more persistent
        if lead.country_region in ["Nigeria", "Dubai"]:
            persistence = "high"
            notes += " Region allows higher persistence."

    # 3. LOW SCORE BUT SOME SIGNALS → Long Nurture
    elif intent == "Cold" and score >= 30:
        agent = "nurture_agent"
        channel = "email"
        persistence = "low"
        notes = "Cold but not dead. Put into long-term nurture."

    # 4. VERY LOW SCORE → Minimal contact
    elif score < 30:
        agent = "minimal_touch_agent"
        channel = "email"
        persistence = "very_low"
        notes = "Very low score. Occasional soft check-ins only."

    # 5. Behaviour-based overrides
    # If they replied on WhatsApp, we ALWAYS treat them with higher priority.
    if lead.whatsapp_replied:
        if score >= 50:
            agent = "ai_call_agent"
            channel = "phone_call + whatsapp"
            persistence = "high"
            notes = "WhatsApp reply + decent score. Prioritise call."
        else:
            agent = "nurture_agent"
            channel = "whatsapp"
            persistence = "medium"
            notes = "WhatsApp reply but low score. Nurture via WhatsApp."

    # Final routing response
    return {
        "assigned_agent": agent,
        "primary_channel": channel,
        "persistence_level": persistence,
        "routing_notes": notes,
        "score": score,
        "intent_level": intent,
        "signal_strength": signal_strength,
        "call_decision": call_decision,
    }
