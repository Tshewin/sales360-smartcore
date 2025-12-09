from pydantic import BaseModel
from typing import Optional


class LeadData(BaseModel):
    country_region: Optional[str] = None
    industry_type: Optional[str] = None
    lead_source: Optional[str] = None
    entry_channel: Optional[str] = None
    business_size: Optional[str] = None
    monthly_lead_volume: Optional[int] = None
    budget_readiness: Optional[str] = None
    email_opened: Optional[bool] = False
    link_clicked: Optional[bool] = False
    whatsapp_replied: Optional[bool] = False
