from models.lead_model import LeadData

from agents.agent_behaviors import (
    appointment_agent_message,
    post_call_followup_agent_message,
    reengagement_agent_message,
)

def run_cadence_action(
    lead: LeadData,
    scoring_result: dict,
    cadence_decision: dict,
    days_inactive: int = 0,
    last_touch_channel: str | None = None,
) -> dict:
    """
    Takes the cadence decision and returns the actual agent action payload.
    """

    next_agent = cadence_decision.get("next_agent")
    scenario = cadence_decision.get("scenario")

    if not next_agent:
        return {
            "agent": None,
            "message_type": "no_action",
            "message": None,
            "notes": cadence_decision.get("reason", "No cadence action required."),
        }

    if next_agent == "appointment_agent":
        return appointment_agent_message(lead, scoring_result)

    if next_agent == "post_call_followup_agent":
        # scenario required: missed_call / no_show / reminder / after_call / confirmation
        scenario = scenario or "confirmation"
        return post_call_followup_agent_message(
            lead, scenario, last_touch_channel=last_touch_channel
        )


    if next_agent == "reengagement_agent":
        # Use days_inactive to choose the right re-engagement variant internally
        return reengagement_agent_message(
            lead,
            days_inactive=days_inactive,
            last_touch_channel=last_touch_channel,
        )

    # Fallback for unknown agent name
    return {
        "agent": next_agent,
        "message_type": "unknown_agent",
        "message": "Cadence selected an agent that has not been mapped yet.",
        "notes": "Update cadence_runner.py to map this agent to a behavior function.",
    }
