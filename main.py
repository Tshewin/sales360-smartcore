from fastapi import FastAPI
from pydantic import BaseModel
from models.lead_model import LeadData
from scoring.scoring_engine import score_lead
from agents.routing_engine import route_lead
from agents.agent_behaviors import generate_agent_action
from agents.agent_behaviors import (
    generate_agent_action,
    appointment_agent_message,
    post_call_followup_agent_message,
    reengagement_agent_message,
)
from cadence.cadence_engine import decide_next_agent
from cadence.cadence_runner import run_cadence_action




class ObjectionPayload(BaseModel):
    lead: LeadData
    objection_text: str


class PostCallPayload(BaseModel):
    lead: LeadData
    scenario: str  # "confirmation", "reminder", "missed_call", "no_show", "after_call"

class ReengagementPayload(BaseModel):
    lead: LeadData
    days_inactive: int = 14
    last_touch_channel: str | None = None

class CadencePayload(BaseModel):
    lead: LeadData
    last_agent: str | None = None
    days_inactive: int = 0
    last_outcome: str | None = None

class CadenceRunPayload(BaseModel):
    lead: LeadData
    last_agent: str | None = None
    days_inactive: int = 0
    last_outcome: str | None = None
    last_touch_channel: str | None = None



app = FastAPI(
    title="Sales360 Smart Core",
    description="AI scoring and routing engine for Sales360",
    version="0.1.0",
)


@app.get("/")
def health_check():
    return {"status": "ok", "message": "Sales360 Smart Core is running"}


@app.post("/score_lead")
def score_lead_endpoint(lead: LeadData):
    result = score_lead(lead)
    return result


@app.post("/route_lead")
def route_lead_endpoint(lead: LeadData):
    """
    Combined scoring + routing:
    1) Score the lead
    2) Decide which AI agent should act next
    """
    scoring_result = score_lead(lead)
    routing_result = route_lead(lead, scoring_result)

    # Optionally merge both into one response
    return {
        "scoring": scoring_result,
        "routing": routing_result,
    }


@app.post("/next_action")
def next_action_endpoint(lead: LeadData):
    """
    1) Score the lead
    2) Route to the right agent
    3) Generate the next action/message/script
    """
    scoring_result = score_lead(lead)
    routing_result = route_lead(lead, scoring_result)
    agent_action = generate_agent_action(lead, routing_result, scoring_result)

    return {
        "scoring": scoring_result,
        "routing": routing_result,
        "agent_action": agent_action,
    }


@app.post("/handle_objection")
def handle_objection_endpoint(payload: ObjectionPayload):
    """
    Handle a sales objection:
    1) Score the lead
    2) Generate an objection-aware response
    """
    scoring_result = score_lead(payload.lead)
    objection_result = generate_objection_response(
        payload.lead,
        scoring_result,
        payload.objection_text,
    )

    return {
        "scoring": scoring_result,
        "objection_handling": objection_result,
    }

@app.post("/test_appointment")
def test_appointment_endpoint(lead: LeadData):
    """
    Test endpoint to see the Appointment Agent message directly,
    without depending on routing rules.
    """
    scoring_result = score_lead(lead)
    agent_action = appointment_agent_message(lead, scoring_result)

    return {
        "scoring": scoring_result,
        "agent_action": agent_action,
    }


@app.post("/post_call_followup")
def post_call_followup(payload: PostCallPayload):
    """
    Generate a post-call follow-up message based on scenario.
    """
    response = post_call_followup_agent_message(
        payload.lead,
        payload.scenario,
    )
    return response


@app.post("/reengage_lead")
def reengage_lead(payload: ReengagementPayload):
    """
    Generate a re-engagement message for inactive leads.
    """
    response = reengagement_agent_message(
        payload.lead,
        payload.days_inactive,
        payload.last_touch_channel,
    )
    return response

@app.post("/cadence/next_step")
def cadence_next_step(payload: CadencePayload):
    scoring = score_lead(payload.lead)

    decision = decide_next_agent(
        lead=payload.lead,
        scoring_result=scoring,
        last_agent=payload.last_agent,
        days_inactive=payload.days_inactive,
        last_outcome=payload.last_outcome,
    )

    return {
        "scoring": scoring,
        "cadence_decision": decision
    }


@app.post("/cadence/run")
def cadence_run(payload: CadenceRunPayload):
    scoring = score_lead(payload.lead)

    decision = decide_next_agent(
        lead=payload.lead,
        scoring_result=scoring,
        last_agent=payload.last_agent,
        days_inactive=payload.days_inactive,
        last_outcome=payload.last_outcome,
    )

    agent_action = run_cadence_action(
        lead=payload.lead,
        scoring_result=scoring,
        cadence_decision=decision,
        days_inactive=payload.days_inactive,
        last_touch_channel=payload.last_touch_channel,
    )

    return {
        "scoring": scoring,
        "cadence_decision": decision,
        "agent_action": agent_action,
    }
