from models.lead_model import LeadData


def score_lead(lead: LeadData) -> dict:
    """
    Basic rules-based scoring (Aggressive mode).
    We'll refine this over time.
    """
    score = 0

    # 1. Region score
    if lead.country_region == "UK":
        score += 20
    elif lead.country_region == "Dubai":
        score += 15
    elif lead.country_region == "Nigeria":
        score += 10
    elif lead.country_region:
        score += 5

    # 2. Industry score
    if lead.industry_type == "FX/Crypto":
        score += 20
    elif lead.industry_type == "SME":
        score += 15
    elif lead.industry_type == "B2B":
        score += 10
    elif lead.industry_type:
        score += 5

    # 3. Behaviour score
    if lead.email_opened:
        score += 5
    if lead.link_clicked:
        score += 15
    if lead.whatsapp_replied:
        score += 15

    # 4. Business size / volume
    if lead.monthly_lead_volume:
        if lead.monthly_lead_volume > 100:
            score += 15
        elif lead.monthly_lead_volume >= 30:
            score += 10

    if lead.business_size in ["6-20", "21-50", "51+"]:
        score += 10

    # 5. Budget readiness
    if lead.budget_readiness == "Yes":
        score += 10

    # Cap at 100
    if score > 100:
        score = 100


  # Intent classification (improved thresholds)
    if score >= 80:
        intent = "Hot"
        recommended_action = "Call Now"
        call_decision = "call_now"

    elif score >= 50:
        intent = "Warm"
        recommended_action = "Nurture + Call Later"
        call_decision = "call_after_intake"

    elif score >= 30:
        intent = "Cold"
        recommended_action = "Long Nurture"
        call_decision = "no_call_for_now"

    else:
        intent = "Cold"
        recommended_action = "Low Priority / Disqualify"
        call_decision = "no_call"


    # Signal strength (simple mapping)
    if score >= 80:
        signal_strength = "High"
    elif score >= 50:
        signal_strength = "Medium"
    else:
        signal_strength = "Low"

    return {
        "score": score,
        "intent_level": intent,
        "signal_strength": signal_strength,
        "recommended_action": recommended_action,
        "call_decision": call_decision,
    }
