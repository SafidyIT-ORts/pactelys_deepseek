import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import asyncpg

from app.content_marketing_crew import run_content_marketing_campaign

app = FastAPI()
pool: Optional[asyncpg.Pool] = None


@app.on_event("startup")
async def startup():
    global pool
    pool = await asyncpg.create_pool(dsn=os.environ["DATABASE_URL"])
    os.environ.setdefault("ANTHROPIC_API_KEY", os.environ.get("ANTHROPIC_API_KEY", ""))


@app.get("/health")
async def health():
    return {"status": "ok", "service": "crewai-service"}


class ContentCampaignRequest(BaseModel):
    org_id: str
    program_name: str
    duration: str = "2weeks"
    frequency: str = "weekly"
    max_articles: Optional[int] = 2  # limite de sécurité par défaut pour les tests


@app.post("/v1/campaigns/content-marketing")
async def content_marketing_campaign(req: ContentCampaignRequest):
    try:
        result = await run_content_marketing_campaign(
            pool=pool,
            org_id=req.org_id,
            program_name=req.program_name,
            duration=req.duration,
            frequency=req.frequency,
            max_articles=req.max_articles,
        )
        return {"success": True, **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
