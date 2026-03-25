"""
zoho/routes.py
──────────────
FastAPI router exposing Zoho CRM data to the Sales360 dashboard.

Endpoints:
  GET /zoho/leads              → all leads
  GET /zoho/leads?view=NAME    → leads filtered by custom view
  GET /zoho/health             → confirms Zoho connection is working
"""

from fastapi import APIRouter, HTTPException, Query
from zoho.zoho_client import fetch_leads, get_access_token

router = APIRouter(prefix="/zoho", tags=["Zoho CRM"])


@router.get("/leads")
async def get_leads(
    view: str = Query(
        default=None,
        description="Optional Zoho custom view name. E.g. 'Sales360_Brokerage_Pilot' for pilot leads, omit for all leads.",
    ),
    page: int = Query(default=1, ge=1, description="Page number"),
    per_page: int = Query(default=50, ge=1, le=200, description="Records per page (max 200)"),
):
    """
    Returns leads from Zoho CRM, optionally filtered by a custom view.

    Examples:
      GET /zoho/leads
        → Returns all leads

      GET /zoho/leads?view=Sales360_Brokerage_Pilot
        → Returns only pilot broker leads

      GET /zoho/leads?view=Sales360_Brokerage_Pilot&page=2&per_page=20
        → Paginated pilot leads
    """
    try:
        result = await fetch_leads(view_name=view, page=page, per_page=per_page)
        return {
            "success": True,
            "source":  "zoho_crm",
            "view":    view or "all_leads",
            **result,
        }
    except KeyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Missing environment variable: {e}. Please set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN on Railway.",
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Zoho CRM error: {str(e)}",
        )


@router.get("/health")
async def zoho_health():
    """
    Confirms the Zoho OAuth connection is working by attempting a token refresh.
    Use this to verify credentials are correctly set on Railway.
    """
    try:
        token = await get_access_token()
        # Only return first/last 6 chars of token for verification
        masked = f"{token[:6]}...{token[-6:]}"
        return {
            "success": True,
            "message": "Zoho OAuth connection healthy",
            "token_preview": masked,
        }
    except KeyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Missing environment variable: {e}",
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Zoho connection failed: {str(e)}",
        )