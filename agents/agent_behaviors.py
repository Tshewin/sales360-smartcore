from models.lead_model import LeadData


def intake_agent_message(lead: LeadData) -> dict:
    """
    First-touch message (WhatsApp / Email) to welcome the lead
    and ask 2–3 qualification questions.
    """
    message = (
        "Hi there 👋\n\n"
        "Thanks for reaching out about improving your sales process.\n\n"
        "I'm your Sales360 AI assistant. A few quick questions so I can understand your situation better:\n"
        "1) What type of business are you running? (e.g. FX brokerage, SME, B2B service)\n"
        "2) On average, how many leads do you get per month?\n"
        "3) Are you currently using any CRM or automation tool?\n\n"
        "Reply here and I’ll recommend the best setup for you."
    )

    return {
        "agent": "intake_agent",
        "channel_suggestion": "whatsapp + email",
        "message_type": "first_touch",
        "message": message,
        "notes": "Used for brand new leads to collect more context."
    }


def nurture_agent_message(lead: LeadData, scoring_result: dict) -> dict:
    """
    Nurturing message to warm up Warm or Cold leads.
    """
    intent = scoring_result.get("intent_level", "Warm")
    score = scoring_result.get("score", 0)

    message = (
        "Hi 👋\n\n"
        "Based on what you've shared, I can already see a few quick wins we could unlock "
        "in your sales funnel.\n\n"
        "With Sales360, we usually help businesses like yours:\n"
        "- Capture every lead automatically\n"
        "- Follow up on WhatsApp + email without manual work\n"
        "- Use AI agents to qualify leads and book calls for you\n\n"
        "If I showed you a 10–15 minute walkthrough of how this would work "
        "for your business, would that be useful? 🙂"
    )

    return {
        "agent": "nurture_agent",
        "channel_suggestion": "whatsapp + email",
        "message_type": "nurture",
        "message": message,
        "notes": f"Nurture for {intent} lead with score {score}."
    }


def ai_call_agent_script(lead: LeadData, scoring_result: dict) -> dict:
    """
    Simple call script for the AI Call Agent (for Hot leads).
    """
    region = lead.country_region or "your region"
    industry = lead.industry_type or "your type of business"

    intro = (
        "Hi, this is the Sales360 AI sales assistant calling.\n"
        "Thanks for your interest in automating your sales process.\n\n"
    )

    discovery = (
        f"I understand you're based in {region} and running a {industry} business.\n"
        "To make sure we recommend the right setup, could you tell me:\n"
        "- How you're currently generating leads?\n"
        "- What your biggest frustration is with follow-ups right now?\n"
    )

    close = (
        "\nThank you, that helps a lot.\n"
        "Based on what you've shared, the next best step is a short strategy call "
        "with a human specialist who can map out your exact Sales360 setup.\n\n"
        "Would you prefer a morning or afternoon slot this week?"
    )

    full_script = intro + discovery + close

    return {
        "agent": "ai_call_agent",
        "message_type": "call_script",
        "script": full_script,
        "notes": "Use this for Hot leads. Can be read by AI voice or human SDR."
    }


def appointment_agent_message(lead: LeadData, scoring_result: dict | None = None) -> dict:
    """
    Message to lock in a specific call time.
    Tone adapts slightly based on intent (Hot vs Warm).
    """

    intent = (scoring_result or {}).get("intent_level", "Warm") or "Warm"
    region = (lead.country_region or "").upper() or "YOUR MARKET"
    industry = lead.industry_type or "your type of business"

    if intent == "Hot":
        # More direct, faster timeline
        message = (
            "Brilliant — let’s lock in a quick strategy session so we don’t lose momentum.\n\n"
            f"For your {industry} business in the {region}, we’ll use this call to:\n"
            "• Map your ideal Sales360 flow\n"
            "• Highlight the quickest wins\n"
            "• Show you exactly how the AI agents would work day-to-day\n\n"
            "Here are a few slots you can pick from:\n"
            "• Today or tomorrow morning\n"
            "• Today or tomorrow afternoon\n"
            "• Or a specific time that works better for you\n\n"
            "Reply with your preferred option (e.g. 'tomorrow 11am UK time') and we’ll confirm the calendar invite."
        )
        notes = "High-intent lead. Offer very near-term slots and clear next step."
    else:
        # Warm / unsure leads – softer and more open
        message = (
            "Great — the next simple step is to schedule a short Sales360 strategy session.\n\n"
            f"We’ll walk through your current {industry} setup in {region} and:\n"
            "• Identify where leads are being lost\n"
            "• Show how AI agents + automation can plug those gaps\n"
            "• Outline a realistic rollout that fits your stage\n\n"
            "What usually works best is to pick a time this week that’s not too busy for you.\n\n"
            "You can reply with:\n"
            "• A morning window\n"
            "• An afternoon window\n"
            "• Or a specific day + time that suits you\n\n"
            "Once you share that, we’ll confirm and send over a calendar invite."
        )
        notes = "Warm lead. Encourage booking this week with flexible time options."

    return {
        "agent": "appointment_agent",
        "channel_suggestion": "whatsapp",
        "message_type": "appointment",
        "message": message,
        "notes": notes,
    }


def generate_agent_action(lead: LeadData, routing_result: dict, scoring_result: dict) -> dict:
    """
    Given the routing decision, generate the next agent action
    (message or script) that should be sent.
    """

    assigned_agent = routing_result.get("assigned_agent")

    if assigned_agent == "intake_agent":
        return intake_agent_message(lead)

    if assigned_agent == "nurture_agent":
        return nurture_agent_message(lead, scoring_result)

    if assigned_agent == "ai_call_agent":
        return ai_call_agent_script(lead, scoring_result)

    if assigned_agent == "appointment_agent":
        return appointment_agent_message(lead, scoring_result)


    # Fallback for minimal_touch_agent or unknown
    return {
        "agent": assigned_agent or "minimal_touch_agent",
        "message_type": "minimal_touch",
        "message": (
            "Just checking in quickly – if you’d still like help improving your sales process, "
            "you can reply here anytime and we’ll pick things up 👍"
        ),
        "notes": "Low-priority / long-term nurture touch."
    }
