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

def post_call_followup_agent_message(
    lead: LeadData, 
    scenario: str = "confirmation", 
    last_touch_channel: str | None = None
) -> dict:

    """
    Post-call follow-up agent.
    Scenarios:
      - confirmation  -> right after booking the call
      - reminder      -> before the call happens
      - missed_call   -> when they didn't pick up
      - no_show       -> when they didn't attend a scheduled meeting
      - after_call    -> after a successful strategy session
    """

    region = (lead.country_region or "").upper() or "YOUR MARKET"
    industry = lead.industry_type or "your business"

    scenario = (scenario or "confirmation").lower().strip()
    preferred_channel = (last_touch_channel or "whatsapp").lower()


    if scenario == "confirmation":
        message = (
            "Awesome — your Sales360 strategy session is booked. 🙌\n\n"
            f"For your {industry} setup in {region}, we’ll use this call to:\n"
            "• Understand how you're currently handling leads\n"
            "• Identify where money is being left on the table\n"
            "• Show you how AI agents + automation could plug those gaps\n\n"
            "If anything changes before the call, just reply here and we’ll adjust the time.\n"
            "Looking forward to speaking with you."
        )
        notes = "Sent immediately after booking to confirm and set expectations."

    elif scenario == "reminder":
        message = (
            "Quick reminder about your upcoming Sales360 strategy session. ⏰\n\n"
            f"We’ll be looking at your {industry} flow in {region} and mapping where AI + automation can give you quick wins.\n\n"
            "If the timing is still perfect, no need to reply — we’ll call as scheduled.\n"
            "If you’d like to shift the time slightly, just reply here with a better slot."
        )
        notes = "Reminder before the scheduled call (e.g. 1–2 hours before)."

    elif scenario == "missed_call":
        message = (
            "We tried to reach you for the Sales360 call but couldn’t get through — no worries at all.\n\n"
            "I know how busy things can get, especially when you're running a growing business.\n\n"
            "To keep things simple, would you prefer to:\n"
            "• Reschedule for a later time today\n"
            "• Pick another day this week\n"
            "• Or move this to WhatsApp/email instead of a live call?\n\n"
            "Reply with what works best for you and we’ll sort it out."
        )
        notes = "Used when the call was attempted but not picked."


    elif scenario == "no_show":
        message = (
            "We had a Sales360 strategy session booked, but it looks like the timing didn’t work out — "
            "no worries at all, these things happen.\n\n"
            "If you’re still interested in optimising your sales process, we can:\n"
            "• Book a fresh slot that fits your schedule better\n"
            "• Or send you a short, personalised video walkthrough you can watch in your own time\n\n"
            "Which option works best for you?"
        )
        notes = "Used when a booked Zoom/meeting was missed completely."

    elif scenario == "after_call":
        message = (
            "Thank you for taking the time to jump on the Sales360 call — really appreciate the openness.\n\n"
            "As a quick recap, we discussed:\n"
            "• Where leads are currently being lost\n"
            "• The key automations/AI agents that could help\n"
            "• The next steps that would give you the fastest win\n\n"
            "I’ll follow up with a short summary so you can share it internally.\n"
            "In the meantime, if any other questions pop up, just reply here — I’ve got you."
        )           
        notes = "Used after a successful call to close the loop."

    else:
        message = (
            "Just checking in regarding your Sales360 session.\n\n"
            "If you’d still like help improving your sales process with AI + automation, "
            "you can reply here with a good time and we’ll take it from there."
        )
        notes = "Fallback scenario for unknown / custom follow-ups."


    preferred_channel = (last_touch_channel or "whatsapp").lower()

    return {
        "agent": "post_call_followup_agent",
        "channel_suggestion": preferred_channel,
        "message_type": f"post_call_{scenario}",
        "message": message,
        "notes": notes,
    }


def reengagement_agent_message(
    lead: LeadData,
    days_inactive: int = 14,
    last_touch_channel: str | None = None,
) -> dict:
    """
    Re-engagement agent for leads that have gone quiet.
    Tone and message vary slightly based on how long they've been inactive.
    """

    region = (lead.country_region or "").upper() or "YOUR MARKET"
    industry = lead.industry_type or "your business"
    channel = (last_touch_channel or "WhatsApp").lower()

    # Short, medium, and long inactivity buckets
    if days_inactive <= 7:
        # Recently inactive – soft nudge
        message = (
            "Just checking in quickly 😊\n\n"
            f"We spoke recently about improving your {industry} sales flow in {region}, "
            "and I didn’t want our last conversation to get lost in the busyness of the week.\n\n"
            "If it’s still on your mind, we can:\n"
            "• Pick up from where we stopped\n"
            "• Or I can send a short summary of what we discussed so far\n\n"
            "What would be most helpful for you right now?"
        )
        notes = "Re-engagement for mildly inactive lead (≤ 7 days)."

    elif days_inactive <= 30:
        # Medium idle – re-open the opportunity
        message = (
            "Hope you’ve been keeping well.\n\n"
            f"A little while ago we started exploring how Sales360 could support your {industry} sales process in {region}.\n"
            "I know priorities can shift, so I wanted to check in without any pressure.\n\n"
            "If you’re still curious, we can:\n"
            "• Look at a very light starting point\n"
            "• Or I can share a short case-style example of how similar businesses approached this\n\n"
            "Would you like to revisit this, or should we pause it for now?"
        )
        notes = "Re-engagement for lead inactive 8–30 days."

    else:
        # Long idle – respectful, almost “closing the file”
        message = (
            "It’s been a little while since we last spoke about Sales360, "
            "so I wanted to quickly close the loop.\n\n"
            f"If optimising your {industry} sales flow in {region} is still on your radar, "
            "I’d be happy to share an updated, very lean way to get started.\n\n"
            "If not, no worries at all — we can simply keep the door open for the future.\n\n"
            "What feels right for you at this stage?"
        )
        notes = "Re-engagement for long inactive lead (> 30 days)."

    return {
        "agent": "reengagement_agent",
        "channel_suggestion": channel,
        "message_type": "reengagement",
        "message": message,
        "notes": notes,
    }
