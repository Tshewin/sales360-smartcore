from models.lead_model import LeadData


BROKER_KEYWORDS = {
    "exness", "ic markets", "icmarkets", "pepperstone", "xm", "fxcm", "ig",
    "oanda", "forex.com", "plus500", "etoro", "eightcap", "vt markets", "vantage",
}

SENIOR_TITLE_KEYWORDS = {
    "founder", "co-founder", "ceo", "chief", "cmo", "cro", "vp", "head", "director", "partner", "owner"
}

DECISION_MAKERS = {"owner", "founder", "ceo", "decision maker", "decisionmaker"}


def _norm(s: str | None) -> str:
    return (s or "").strip().lower()


def score_lead(lead: LeadData) -> dict:
    score = 0

    country_region = _norm(getattr(lead, "country_region", None))
    country = _norm(getattr(lead, "country", None))
    industry_type = _norm(getattr(lead, "industry_type", None))
    company = _norm(getattr(lead, "company", None))
    email = _norm(getattr(lead, "email", None))
    title = _norm(getattr(lead, "title", None))
    lead_source = _norm(getattr(lead, "lead_source", None))
    entry_channel = _norm(getattr(lead, "entry_channel", None))
    decision_level = _norm(getattr(lead, "decision_level", None))
    budget_readiness = _norm(getattr(lead, "budget_readiness", None))
    current_challenges = _norm(getattr(lead, "current_challenges", None))

    # -------------------------
    # 0) Normalise region if missing
    # -------------------------
    if not country_region and country:
        if "united kingdom" in country or country == "uk" or "england" in country:
            country_region = "uk"
        elif "dubai" in country or "uae" in country or "united arab emirates" in country:
            country_region = "dubai"
        elif "nigeria" in country:
            country_region = "nigeria"

    # -------------------------
    # 1) Region score
    # -------------------------
    if country_region == "uk":
        score += 20
    elif country_region == "dubai":
        score += 15
    elif country_region == "nigeria":
        score += 10
    elif country_region:
        score += 5

    # -------------------------
    # 2) Industry score
    # -------------------------
    if industry_type in {"fx/crypto", "fx", "cfd", "brokerage"}:
        score += 20
    elif industry_type == "sme":
        score += 15
    elif industry_type == "b2b":
        score += 10
    elif industry_type:
        score += 5

    # -------------------------
    # 3) ICP baseline (Fit) — NEW
    # -------------------------
    # Company keyword match
    if any(k in company for k in BROKER_KEYWORDS):
        score += 20

    # Email domain keyword match
    if "@" in email:
        domain = email.split("@", 1)[1]
        if any(k.replace(" ", "") in domain.replace(".", "").replace("-", "") for k in BROKER_KEYWORDS):
            score += 10

    # Seniority/title match
    if any(k in title for k in SENIOR_TITLE_KEYWORDS):
        score += 10

    # -------------------------
    # 4) Authority — NEW
    # -------------------------
    if decision_level in DECISION_MAKERS:
        score += 15

    # -------------------------
    # 5) Behaviour score (existing)
    # -------------------------
    if getattr(lead, "email_opened", False):
        score += 5
    if getattr(lead, "link_clicked", False):
        score += 15
    if getattr(lead, "whatsapp_replied", False):
        score += 15

    # -------------------------
    # 6) Business size / volume (existing but fixed key expectation)
    # -------------------------
    monthly_vol = getattr(lead, "monthly_lead_volume", 0) or 0
    if monthly_vol:
        if monthly_vol > 100:
            score += 15
        elif monthly_vol >= 30:
            score += 10

    if getattr(lead, "business_size", None) in ["6-20", "21-50", "51+"]:
        score += 10

    # -------------------------
    # 7) Budget readiness (existing)
    # -------------------------
    if budget_readiness == "yes":
        score += 10

    # -------------------------
    # 8) Pain signal — NEW
    # -------------------------
    if current_challenges:
        score += 10

    # -------------------------
    # 9) Lead source / entry channel — NEW (lightweight)
    # -------------------------
    if lead_source in {"partner", "inbound demo", "website", "referral"}:
        score += 10
    if entry_channel in {"dm", "website", "referral"}:
        score += 5

    # Cap at 100
    score = min(score, 100)

    # Intent classification
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

    # Signal strength
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
