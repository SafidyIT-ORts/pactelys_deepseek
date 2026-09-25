"""
content_marketing_crew.py — Orchestration CrewAI du plugin content-marketing.

Reproduit le pattern découvert dans plan-pillar.md (l'orchestrateur officiel
GTM Agents) : un calendrier produit une sortie STRUCTURÉE (garantie par
CrewAI via output_pydantic, pas juste "espérée" via un prompt), qui sert
ensuite à générer automatiquement les articles correspondants.

Niveau 1 (agents dynamiques à l'intérieur d'une tâche) : allow_delegation
laissé à False ici volontairement, pour un premier test simple à observer.
À activer une fois ce premier flux validé.

Niveau 3 (dépendance entre commandes) : c'est le vrai sujet de ce fichier —
Phase 1 (content-pipeline) produit un calendrier ; Phase 2 (generate-blog)
consomme ce calendrier, une fois par article prévu.
"""
import asyncpg
from crewai import Agent, Task, Crew, Process, LLM
from pydantic import BaseModel
from typing import List, Optional


class ArticlePlan(BaseModel):
    topic: str
    persona: str
    keyword: str
    week: int


class ContentCalendar(BaseModel):
    program_name: str
    articles: List[ArticlePlan]


async def _load_source_file(conn, name: str, file_type: str) -> dict:
    row = await conn.fetchrow(
        "SELECT raw_content, model FROM source_files WHERE name = $1 AND file_type = $2",
        name, file_type,
    )
    if row is None:
        raise ValueError(f"Fichier introuvable en base : name={name}, file_type={file_type}")
    return dict(row)


async def _load_client_context(conn, org_id: str) -> str:
    cfg = await conn.fetchrow("SELECT * FROM client_config WHERE org_id = $1", org_id)
    if cfg is None:
        return ""
    parts = [cfg.get("claude_md_raw") or "", cfg.get("brand_md_raw") or "", cfg.get("s01_md_raw") or ""]
    return "\n\n".join(p for p in parts if p)


async def run_content_marketing_campaign(
    pool: asyncpg.Pool,
    org_id: str,
    program_name: str,
    duration: str,
    frequency: str,
    max_articles: Optional[int] = None,
) -> dict:
    """Exécute le flux complet : calendrier structuré -> N articles générés.

    max_articles : limite volontaire pour les tests (évite de générer
    10 articles complets par accident pendant qu'on valide le mécanisme).
    """
    async with pool.acquire() as conn:
        command_calendar = await _load_source_file(conn, "content-pipeline", "command")
        agent_strategist = await _load_source_file(conn, "content-strategist", "agent")
        skill_editorial_ops = await _load_source_file(conn, "editorial-ops", "skill")

        command_blog = await _load_source_file(conn, "generate-blog", "command")
        agent_writer = await _load_source_file(conn, "blog-writer", "agent")
        skill_seo_writing = await _load_source_file(conn, "seo-writing", "skill")

        client_context = await _load_client_context(conn, org_id)

    # ============================================================
    # PHASE 1 — Calendrier éditorial, sortie STRUCTURÉE garantie
    # ============================================================
    strategist = Agent(
        role="Content Strategist",
        goal="Planifier un calendrier éditorial cohérent avec les objectifs business du client",
        backstory=(
            f"{command_calendar['raw_content']}\n\n"
            f"{agent_strategist['raw_content']}\n\n"
            f"{skill_editorial_ops['raw_content']}\n\n"
            f"CONTEXTE CLIENT — SOURCE DE VÉRITÉ :\n{client_context}"
        ),
        llm=LLM(model=f"anthropic/{agent_strategist['model'] or 'claude-haiku-4-5-20251001'}"),
        verbose=True,
    )

    calendar_task = Task(
        description=(
            f"Construis un calendrier éditorial pour le programme '{program_name}', "
            f"sur une durée de {duration}, avec une fréquence {frequency}. "
            f"Retourne la liste structurée des articles à produire."
        ),
        expected_output="Un calendrier avec le nom du programme et la liste des articles (topic, persona, keyword, semaine)",
        agent=strategist,
        output_pydantic=ContentCalendar,
    )

    calendar_crew = Crew(agents=[strategist], tasks=[calendar_task], process=Process.sequential)
    calendar_result = calendar_crew.kickoff()
    calendar_data: ContentCalendar = calendar_result.pydantic

    # ============================================================
    # PHASE 2 — Un article complet par entrée du calendrier
    # ============================================================
    writer = Agent(
        role="Blog Writer",
        goal="Rédiger des articles de blog complets, pas de simples briefs",
        backstory=(
            f"{command_blog['raw_content']}\n\n"
            f"{agent_writer['raw_content']}\n\n"
            f"{skill_seo_writing['raw_content']}\n\n"
            f"CONTEXTE CLIENT — SOURCE DE VÉRITÉ :\n{client_context}\n\n"
            f"IMPORTANT : rédige l'article COMPLET en entier, pas seulement "
            f"un plan ou un brief — va jusqu'au bout du texte."
        ),
        llm=LLM(model=f"anthropic/{agent_writer['model'] or 'claude-haiku-4-5-20251001'}"),
        verbose=True,
    )

    articles_to_generate = calendar_data.articles
    if max_articles is not None:
        articles_to_generate = articles_to_generate[:max_articles]

    generated_articles = []
    for plan in articles_to_generate:
        article_task = Task(
            description=(
                f"Rédige l'article complet sur le sujet : {plan.topic}. "
                f"Persona : {plan.persona}. Mot-clé principal : {plan.keyword}."
            ),
            expected_output="L'article de blog complet, rédigé en entier",
            agent=writer,
        )
        article_crew = Crew(agents=[writer], tasks=[article_task], process=Process.sequential)
        article_result = article_crew.kickoff()
        generated_articles.append({
            "topic": plan.topic,
            "persona": plan.persona,
            "keyword": plan.keyword,
            "week": plan.week,
            "content": str(article_result),
        })

    return {
        "program_name": calendar_data.program_name,
        "total_articles_planned": len(calendar_data.articles),
        "articles_generated": len(generated_articles),
        "articles": generated_articles,
    }
