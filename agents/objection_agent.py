from models.lead_model import LeadData


def classify_objection(objection: str) -> str:
    """
    Classifies the objection into one of the core categories.
    """
    text = objection.lower()

    if "expensive" in text or "cost" in text or "price" in text:
        return "price"
    if "budget" in text or "can't afford" in text or "no money" in text:
        return "budget"
    if "send" in text and "info" in text or "information" in text:
        return "info"
    if "later" in text or "not a good time" in text or "timing" in text:
        return "timing"
    
        # Competitor tools
    competitor_keywords = [
        "hubspot", "zoho", "gohighlevel", "highlevel", "pipedrive",
        "salesforce", "freshsales", "creatio", "clickup",
        "monday", "zendesk", "crm"
    ]

    if any(word in text for word in competitor_keywords):
        return "competitor"


    if "already" in text and ("tool" in text or "crm" in text or "using" in text):
        return "competitor"
    if "not sure" in text or "does it work" in text or "work for us" in text:
        return "risk"
    if "not enough leads" in text or "low leads" in text:
        return "lead_volume"
    if "not a priority" in text or "priority" in text:
        return "priority"
    if "boss" in text or "manager" in text or "partner" in text or "approval" in text:
        return "authority"
    if "who are you" in text or "never heard" in text or "trust" in text:
        return "trust"

    return "general"


def generate_objection_response(
    lead: LeadData, scoring_result: dict, objection_text: str
) -> dict:
    """
    Generates a hybrid-tone, Chuks-style objection response.
    """

    category = classify_objection(objection_text)
    score = scoring_result.get("score", 0)
    intent = scoring_result.get("intent_level", "Unknown")
    region = (lead.country_region or "").upper() or "YOUR MARKET"
    industry = lead.industry_type or "your type of business"

    message = ""
    tone = ""
    recommended_next_step = "nurture"

    # ---------------------------------------------------------
    # 1. PRICE OBJECTION
    # ---------------------------------------------------------
    if category == "price":
        message = (
            "I completely understand you — pricing should always be something you think through properly.\n\n"
            "And honestly, most of the businesses we help felt the same way at the beginning until they realised how much revenue was slipping away through:\n\n"
            "• Leads not being followed up fast enough\n"
            "• SDRs missing buyers who were ready to convert\n"
            "• Inconsistent WhatsApp + email follow-up\n"
            "• Opportunities that simply never came back\n\n"
            "Sales360 is designed to *pay for itself* by fixing these gaps — not by increasing your workload or costs.\n\n"
            "What I usually suggest is a quick 10-minute ROI walkthrough. No pressure — just clarity.\n"
            f"We’ll map out the real revenue potential for a {industry} business in {region} like yours, and then you decide if it makes sense.\n\n"
            "Would you be open to seeing that breakdown?"
        )
        tone = "gentle_consultant"
        recommended_next_step = "book_strategy_call"

    # ---------------------------------------------------------
    # 2. BUDGET OBJECTION
    # ---------------------------------------------------------
    elif category == "budget":
        message = (
            "Totally fair — if the budget isn’t available right now, forcing a decision is never helpful.\n\n"
            "What works really well for many of our clients in this exact situation is starting very small:\n\n"
            "• One AI agent\n"
            "• One automated follow-up sequence\n"
            "• One conversion gap we fix quickly\n\n"
            "Even this light setup often recovers enough revenue to fund the full rollout later.\n\n"
            "Here’s what I recommend: let’s have a simple, no-pressure planning chat.\n"
            "We’ll look at what a realistic phased rollout could look like for your business.\n\n"
            "Would you be open to that?"
        )
        tone = "gentle_consultant"
        recommended_next_step = "nurture"

    # ---------------------------------------------------------
    # 3. SEND INFO / MORE INFORMATION
    # ---------------------------------------------------------
    elif category == "info":
        message = (
            "Absolutely — I can definitely send more information.\n\n"
            "Just so I don’t send a generic brochure, what angle would you like the info to focus on?\n\n"
            "• Lead capture automation\n"
            "• WhatsApp + email follow-up\n"
            "• AI sales agents (SDR replacement/augmentation)\n"
            "• Full Sales360 setup\n\n"
            "A quick one-liner helps me tailor the exact walkthrough you need.\n"
            "Once I have that, I’ll send a short, focused breakdown and a 2-minute video made for your situation."
        )
        tone = "friendly_consultative"
        recommended_next_step = "nurture"

    # ---------------------------------------------------------
    # 4. TIMING / NOT A GOOD TIME
    # ---------------------------------------------------------
    elif category == "timing":
        message = (
            "I hear you — timing is a challenge for every business.\n\n"
            "But here’s the honest pattern we see all the time:\n\n"
            "• Teams wait for the 'perfect moment'\n"
            "• Meanwhile follow-up gaps continue\n"
            "• Competitors move faster\n"
            "• And fixing it later costs more\n\n"
            "We don’t need to do a full rollout now. We can simply map out a light, low-risk starting point "
            "so you’re not starting from zero when the timing fits.\n\n"
            "Would it be unreasonable if we explored a small starter plan together?"
        )
        tone = "gentle_push"
        recommended_next_step = "nurture"

    # ---------------------------------------------------------
    # 5. COMPETITOR / USING ANOTHER TOOL
    # ---------------------------------------------------------
    elif category == "competitor":
        message = (
            "That’s actually a good thing — businesses already using tools like yours usually get the fastest results.\n\n"
            "Sales360 doesn’t replace your CRM. It *sits on top of it* and boosts performance:\n\n"
            "• AI scoring\n"
            "• AI follow-up agents\n"
            "• WhatsApp + email automation\n"
            "• Intelligent routing\n"
            "• Behaviour-based timing\n\n"
            "Most clients simply plug Sales360 into what they already use.\n\n"
            "If you’re open to it, we can do a light audit and show you exactly:\n"
            "• Where you’re losing conversions\n"
            "• Where AI can take over manual SDR work\n"
            "• How to boost performance without switching systems\n\n"
            "Would a short review call make sense?"
        )
        tone = "strategic_advisor"
        recommended_next_step = "book_strategy_call"

    # ---------------------------------------------------------
    # 6. RISK / NOT SURE IT WILL WORK
    # ---------------------------------------------------------
    elif category == "risk":
        message = (
            "That’s a smart concern — and you're absolutely right to think this way.\n\n"
            "We never ask anyone to trust hype. Instead, we prove it.\n\n"
            "Here’s how we handle this:\n"
            "• Start with a small pilot\n"
            "• Define what success looks like\n"
            "• Deploy one AI agent or sequence\n"
            "• Review the data together\n\n"
            "No risk. No long commitments. Just clarity.\n\n"
            "Would you be open to defining a small test so you can see the results yourself?"
        )
        tone = "reassuring"
        recommended_next_step = "pilot_offer"

    # ---------------------------------------------------------
    # 7. NOT ENOUGH LEADS
    # ---------------------------------------------------------
    elif category == "lead_volume":
        message = (
            "I completely understand — and that actually makes automation even MORE important.\n\n"
            "When lead flow is low:\n"
            "• Every lead becomes more valuable\n"
            "• Losing even one has a bigger impact\n"
            "• Manual follow-up becomes risky\n"
            "• Automation instantly raises conversions\n\n"
            "Before buying more leads, most businesses first fix the conversion flow from the leads they already have.\n\n"
            "Would you be open to seeing how Sales360 could help you convert more from your current lead volume?"
        )
        tone = "gentle_consultant"
        recommended_next_step = "nurture"

    # ---------------------------------------------------------
    # 8. LOW PRIORITY
    # ---------------------------------------------------------
    elif category == "priority":
        message = (
            "Totally understood — every business is juggling a lot.\n\n"
            "What we see often is that sales operations sit in the 'important but not urgent' box…\n"
            "until the cost of delay becomes clear.\n\n"
            "Instead of a sales call, we can treat this as a *blueprint* session:\n"
            "• You get a clear map of your optimized sales flow\n"
            "• You keep the blueprint regardless\n"
            "• You use it whenever the timing is right\n\n"
            "Would a clarity session like that be useful?"
        )
        tone = "professional_consultant"
        recommended_next_step = "book_strategy_call"

    # ---------------------------------------------------------
    # 9. NEED APPROVAL / BOSS / PARTNER
    # ---------------------------------------------------------
    elif category == "authority":
        message = (
            "That makes complete sense — proper decisions always involve more than one person.\n\n"
            "What works best is simple:\n"
            "• We keep this chat light and exploratory\n"
            "• I prepare a 1-page internal summary for your team\n"
            "• If helpful, we join your decision-maker on a follow-up call\n\n"
            "This way, you look prepared and your team gets clarity without extra work.\n\n"
            "Does that approach work for you?"
        )
        tone = "gentle_consultant"
        recommended_next_step = "send_internal_summary"

    # ---------------------------------------------------------
    # 10. TRUST OBJECTION / NEVER HEARD OF YOU
    # ---------------------------------------------------------
    elif category == "trust":
        message = (
            "Totally fair — you should always be careful about who you plug into your sales operations.\n\n"
            "Instead of asking you to trust claims, here's what I prefer:\n"
            "• Show you exactly how the system works\n"
            "• Share examples from businesses like yours\n"
            "• Give full transparency on what the AI is doing\n\n"
            "Then you decide based on clarity, not hype.\n\n"
            "Would you be open to a short walkthrough?"
        )
        tone = "reassuring"
        recommended_next_step = "book_walkthrough"

    # ---------------------------------------------------------
    # 11. GENERAL / UNKNOWN OBJECTION
    # ---------------------------------------------------------
    else:
        message = (
            "I completely understand your point.\n\n"
            "If you're open to it, we can walk through your situation together and see what makes the most sense.\n\n"
            "No pressure — just clarity."
        )
        tone = "neutral_consultative"
        recommended_next_step = "nurture"

    # ---------------------------------------------------------
    # RETURN RESPONSE
    # ---------------------------------------------------------
    return {
        "category": category,
        "tone": tone,
        "message": message,
        "recommended_next_step": recommended_next_step,
        "score": score,
        "intent_level": intent,
        "region": region,
        "industry": industry,
        "original_objection": objection_text,
    }
