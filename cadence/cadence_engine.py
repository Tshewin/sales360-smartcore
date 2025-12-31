from models.lead_model import LeadData


def determine_cadence_profile(
    intent: str,
    signal_strength: str,
    region: str | None = None,
) -> dict:
    """
    Determines how aggressive or light the follow-up cadence should be.
    """

    region = (region or "").upper()

    # Default (safe baseline)
    cadence = {
        "level": "low",
        "max_touches_per_week": 1,
        "min_days_between_touches": 4,
    }

    # Warm leads
    if intent == "Warm":
        cadence = {
            "level": "medium",
            "max_touches_per_week": 2,
            "min_days_between_touches": 2,
        }

    # Hot leads
    if intent == "Hot":
        cadence = {
            "level": "high",
            "max_touches_per_week": 3,
            "min_days_between_touches": 1,
        }

    # Extra persistence for strong signals
    if intent == "Hot" and signal_strength == "High":
        cadence["max_touches_per_week"] = 4

    # Regional nuance (optional but realistic)
    if region in {"DUBAI", "NIGERIA"} and intent == "Hot":
        cadence["max_touches_per_week"] += 1

    return cadence



def decide_next_agent(
    lead: LeadData,
    scoring_result: dict,
    last_agent: str | None,
    days_inactive: int = 0,
    last_outcome: str | None = None,
) -> dict:
    """
    Cadence Engine v1
    Decides which agent should act next based on lead state.
    """

    intent = scoring_result.get("intent_level", "Warm")


    signal_strength = scoring_result.get("signal_strength", "Medium")
    region = lead.country_region
    cadence_profile = determine_cadence_profile(
        intent=intent,
        signal_strength=signal_strength,
        region=region,
    )




    if intent == "Hot" and last_agent == "appointment_agent" and days_inactive >= 3 and days_inactive < 7:
        return {
            "next_agent": "post_call_followup_agent",
            "scenario": "reminder",
            "reason": "Hot lead: gentle reminder before switching to re-engagement."
        }


    # -------------------------------
    # Missed call or no-show handling
    # -------------------------------
    if last_outcome == "missed_call":
        return {
            "next_agent": "post_call_followup_agent",
            "scenario": "missed_call",
            "reason": "Call was attempted but not picked.",
            "cadence_profile": cadence_profile
        }

    if last_outcome == "no_show":
        return {
            "next_agent": "post_call_followup_agent",
            "scenario": "no_show",
            "reason": "Lead did not attend scheduled meeting.",
            "cadence_profile": cadence_profile
        }

    if last_outcome == "after_call":
        return {
            "next_agent": "post_call_followup_agent",
            "scenario": "after_call",
            "reason": "Send recap and next steps after a successful call.",
            "cadence_profile": cadence_profile
        }
    
    if last_outcome == "reminder":
        return {
            "next_agent": "post_call_followup_agent",
            "scenario": "reminder",
            "reason": "Send a reminder message before the scheduled call.",
            "cadence_profile": cadence_profile
        }


    # -------------------------------
    # Hot lead follow-up logic
    # -------------------------------
    if intent == "Hot" and last_agent == "ai_call_agent" and days_inactive >= 1:
        return {
            "next_agent": "appointment_agent",
            "reason": "Hot lead inactive after call attempt.",
            "cadence_profile": cadence_profile
        }

    # -------------------------------
    # -------------------------------
    # Appointment follow-up cadence
    # -------------------------------
    if last_agent == "appointment_agent":
        # Day 1: gentle reminder
        if days_inactive == 1:
            return {
                "next_agent": "post_call_followup_agent",
                "scenario": "reminder",
                "reason": "Reminder 1 day after appointment outreach.",
                "cadence_profile": cadence_profile
            }

        # Day 3–6: second reminder for Hot leads (optional but effective)
        if intent == "Hot" and 3 <= days_inactive < 7:
            return {
                "next_agent": "post_call_followup_agent",
                "scenario": "reminder",
                "reason": "Hot lead: reminder before switching to re-engagement.",
                "cadence_profile": cadence_profile
            }

    # Day 7+: switch to re-engagement
    if days_inactive >= 7:
        return {
            "next_agent": "reengagement_agent",
            "reason": "No response after reminders. Switching to re-engagement.",            
            "cadence_profile": cadence_profile
        }

    # -------------------------------
    # Long inactivity handling
    # -------------------------------
    if days_inactive >= 30:
        return {
            "next_agent": "reengagement_agent",
            "reason": "Lead inactive for over 30 days.",
            "cadence_profile": cadence_profile
        }

    if days_inactive >= 14:
        return {
            "next_agent": "reengagement_agent",
            "reason": "Lead inactive for over 14 days.",
            "cadence_profile": cadence_profile
        }

    # -------------------------------
    # Default: do nothing
    # -------------------------------
    return {
        "next_agent": None,
        "reason": "No cadence action required at this time.",
        "cadence_profile": cadence_profile
    }
