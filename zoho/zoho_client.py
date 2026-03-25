"""
zoho/zoho_client.py
───────────────────
Handles Zoho CRM OAuth token refresh and API calls.
Credentials are read from environment variables — never hardcoded.

Environment variables required on Railway:
  ZOHO_CLIENT_ID       — from api-console.zoho.eu
  ZOHO_CLIENT_SECRET   — from api-console.zoho.eu
  ZOHO_REFRESH_TOKEN   — obtained during OAuth setup
"""

import os
import httpx
from datetime import datetime, timedelta

# ── Zoho EU data centre endpoints ──────────────────────────────────────────
ZOHO_ACCOUNTS_URL = "https://accounts.zoho.eu/oauth/v2/token"
ZOHO_CRM_BASE     = "https://www.zohoapis.eu/crm/v7"

# ── In-memory token cache (refreshed automatically when expired) ────────────
_token_cache = {
    "access_token": None,
    "expires_at":   datetime.utcnow(),
}


async def get_access_token() -> str:
    """
    Returns a valid Zoho access token.
    Automatically refreshes using the refresh token if expired.
    """
    now = datetime.utcnow()

    # Return cached token if still valid (with 60s buffer)
    if _token_cache["access_token"] and _token_cache["expires_at"] > now + timedelta(seconds=60):
        return _token_cache["access_token"]

    # Refresh the token
    client_id     = os.environ["ZOHO_CLIENT_ID"]
    client_secret = os.environ["ZOHO_CLIENT_SECRET"]
    refresh_token = os.environ["ZOHO_REFRESH_TOKEN"]

    async with httpx.AsyncClient() as client:
        response = await client.post(
            ZOHO_ACCOUNTS_URL,
            data={
                "grant_type":    "refresh_token",
                "client_id":     client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
            },
        )
        response.raise_for_status()
        data = response.json()

    if "access_token" not in data:
        raise ValueError(f"Zoho token refresh failed: {data}")

    # Cache the new token
    _token_cache["access_token"] = data["access_token"]
    _token_cache["expires_at"]   = now + timedelta(seconds=data.get("expires_in", 3600))

    return _token_cache["access_token"]


async def fetch_leads(view_name: str = None, page: int = 1, per_page: int = 50) -> dict:
    """
    Fetches leads from Zoho CRM Leads module.

    Args:
        view_name: Optional Zoho custom view name (e.g. 'Sales360_Brokerage_Pilot').
                   If None, returns all leads.
        page:      Page number for pagination (default 1).
        per_page:  Records per page, max 200 (default 50).

    Returns:
        dict with keys: leads (list), total (int), page (int), has_more (bool)
    """
    token = await get_access_token()

    headers = {
        "Authorization": f"Zoho-oauthtoken {token}",
        "Content-Type":  "application/json",
    }

    # Build query params
    params = {
        "page":     page,
        "per_page": per_page,
        # Pull only the fields the dashboard needs
        "fields": ",".join([
            "First_Name",
            "Last_Name",
            "Company",
            "Email",
            "Phone",
            "Lead_Status",
            "Lead_Source",
            "SmartCore_Score",
            "SmartScore_Intent",
            "SmartScore_Fit",
            "SmartScore_Behaviour",
            "Created_Time",
            "Modified_Time",
        ]),
    }

    # Apply custom view filter if provided
    if view_name:
        # First resolve the view ID from the view name
        view_id = await resolve_view_id(view_name, token)
        if view_id:
            params["cvid"] = view_id

    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(
            f"{ZOHO_CRM_BASE}/Leads",
            headers=headers,
            params=params,
        )

    if response.status_code == 204:
        # No content — empty module
        return {"leads": [], "total": 0, "page": page, "has_more": False}

    response.raise_for_status()
    data = response.json()

    raw_leads = data.get("data", [])
    info      = data.get("info", {})

    # Normalise each lead into a clean dashboard-ready shape
    leads = [normalise_lead(lead) for lead in raw_leads]

    return {
        "leads":    leads,
        "total":    info.get("count", len(leads)),
        "page":     info.get("page", page),
        "has_more": info.get("more_records", False),
    }


async def resolve_view_id(view_name: str, token: str) -> str | None:
    """
    Resolves a Zoho custom view name to its ID.
    Returns None if not found.
    """
    headers = {"Authorization": f"Zoho-oauthtoken {token}"}

    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{ZOHO_CRM_BASE}/Leads/views",
            headers=headers,
        )

    if response.status_code != 200:
        return None

    views = response.json().get("views", [])
    for view in views:
        if view.get("display_value", "").strip() == view_name.strip():
            return view.get("id")

    return None


def normalise_lead(raw: dict) -> dict:
    """
    Maps raw Zoho lead fields to the clean shape expected by the dashboard.
    Handles missing SmartCore custom fields gracefully.
    """
    first = raw.get("First_Name", "") or ""
    last  = raw.get("Last_Name", "")  or ""
    name  = f"{first} {last}".strip() or "Unknown"

    # SmartCore score fields (custom Zoho fields)
    fit        = _safe_int(raw.get("SmartScore_Fit"))
    behaviour  = _safe_int(raw.get("SmartScore_Behaviour"))
    intent     = _safe_int(raw.get("SmartScore_Intent"))
    smart_score = _safe_int(raw.get("SmartCore_Score"))

    # If composite SmartCore_Score exists use it, else average the three
    if smart_score is None and all(v is not None for v in [fit, behaviour, intent]):
        smart_score = round((fit + behaviour + intent) / 3)

    return {
        "id":           raw.get("id"),
        "name":         name,
        "company":      raw.get("Company") or "—",
        "email":        raw.get("Email")   or "—",
        "phone":        raw.get("Phone")   or "—",
        "status":       raw.get("Lead_Status") or "New",
        "source":       raw.get("Lead_Source") or "—",
        "score":        smart_score,
        "intent":       intent,
        "fit":          fit,
        "behaviour":    behaviour,
        "created_at":   raw.get("Created_Time"),
        "modified_at":  raw.get("Modified_Time"),
    }


def _safe_int(value) -> int | None:
    """Safely converts a value to int, returns None if not possible."""
    try:
        return int(value) if value is not None else None
    except (ValueError, TypeError):
        return None