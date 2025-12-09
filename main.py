from fastapi import FastAPI
from pydantic import BaseModel
from models.lead_model import LeadData
from scoring.scoring_engine import score_lead
from agents.routing_engine import route_lead
from agents.agent_behaviors import generate_agent_action
from agents.agent_behaviors import generate_agent_action, appointment_agent_message


class ObjectionPayload(BaseModel):
    lead: LeadData
    objection_text: str



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
