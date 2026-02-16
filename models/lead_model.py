from pydantic import BaseModel
from typing import Optional, List

class LeadData(BaseModel):
    # identity/context
    full_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    company: Optional[str] = None
    title: Optional[str] = None
    country: Optional[str] = None

    # scoring inputs
    country_region: Optional[str] = None
    industry_type: Optional[str] = None
    lead_source: Optional[str] = None
    entry_channel: Optional[str] = None
    business_size: Optional[str] = None
    monthly_lead_volume: Optional[int] = None
    budget_readiness: Optional[str] = None

    decision_level: Optional[str] = None
    current_challenges: Optional[str] = None
    interested_services: Optional[List[str]] = None
    utm_source: Optional[str] = None
    utm_medium: Optional[str] = None

    # behaviour
    email_opened: Optional[bool] = False
    link_clicked: Optional[bool] = False
    whatsapp_replied: Optional[bool] = False
