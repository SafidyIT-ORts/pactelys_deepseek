-- Migration initiale — Pactelys API
-- À exécuter une seule fois sur la base "pactelys"

-- ============================================================
-- 1. ORGANIZATIONS — les clients (Pactelys, Praxitele, futurs...)
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    wordpress_user_id VARCHAR(100),        -- lien vers le compte WordPress
    status VARCHAR(20) NOT NULL DEFAULT 'active',  -- active | suspended | trial
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- 2. CLIENT_CONFIG — l'équivalent structuré de CLAUDE.md/Brand.md/S01.md
-- ============================================================
CREATE TABLE IF NOT EXISTS client_config (
    org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    -- Identité
    company_name VARCHAR(255),
    sector VARCHAR(255),
    company_size VARCHAR(50),
    target_revenue VARCHAR(100),
    market VARCHAR(255),
    website_url VARCHAR(500),
    -- Promesse centrale
    core_promise TEXT,
    -- ICP
    icp_target_sector TEXT,
    icp_company_size VARCHAR(100),
    icp_primary_titles JSONB DEFAULT '[]',
    icp_secondary_titles JSONB DEFAULT '[]',
    icp_geography VARCHAR(255),
    icp_buying_signals JSONB DEFAULT '[]',
    icp_exclusion_criteria JSONB DEFAULT '[]',
    -- Proposition de valeur
    value_prop_problem TEXT,
    value_prop_benefit TEXT,
    value_prop_differentiator TEXT,
    -- Règles de comportement
    tone_of_voice VARCHAR(20) DEFAULT 'vouvoiement',  -- vouvoiement | tutoiement
    behavior_rules JSONB DEFAULT '[]',
    -- Tunnel de conversion (étapes ordonnées, propre à chaque client)
    conversion_funnel JSONB DEFAULT '[]',
    -- Contenu brut, si le client préfère fournir du texte libre en plus des champs structurés
    brand_md_raw TEXT,
    s01_md_raw TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. AI_CONNECTIONS — clés API client (BYOK), chiffrées
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL,          -- anthropic | openai
    encrypted_key TEXT NOT NULL,             -- chiffré AES-256-GCM, jamais en clair
    key_last_four VARCHAR(4),                -- juste pour affichage/vérification visuelle
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (org_id, provider)
);

-- ============================================================
-- 4. SOURCE_FILES — bibliothèque brute des plugins (miroir GitHub)
--    Peuplée par import_gtm_plugins.py, jamais modifiée à la main
-- ============================================================
CREATE TABLE IF NOT EXISTS source_files (
    id SERIAL PRIMARY KEY,
    plugin_name VARCHAR(100) NOT NULL,
    file_type VARCHAR(20) NOT NULL,          -- command | agent | skill | asset
    file_name VARCHAR(150) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    usage TEXT,
    model VARCHAR(100),                       -- vide si non précisé dans le frontmatter
    raw_content TEXT NOT NULL,
    source_path VARCHAR(255) UNIQUE NOT NULL,
    last_synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 5. PROMPT_TEMPLATES — prompts déjà fusionnés, prêts à l'emploi
--    Peuplée par build_prompt_templates.py + load_to_postgres.py
-- ============================================================
CREATE TABLE IF NOT EXISTS prompt_templates (
    id SERIAL PRIMARY KEY,
    action_id VARCHAR(150) NOT NULL,
    label VARCHAR(255),
    type VARCHAR(20) NOT NULL,                -- simple | pipeline
    step_order INT NOT NULL DEFAULT 1,
    model VARCHAR(100) NOT NULL,
    tools_config JSONB DEFAULT '{}',
    source_names_used JSONB,
    system_prompt_final TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,           -- permet de désactiver une action sans la supprimer
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (action_id, step_order)
);

-- ============================================================
-- 6. TASKS — historique et état des exécutions
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    action_id VARCHAR(150) NOT NULL,
    params JSONB DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'queued',
        -- queued | in_progress | needs_validation | completed | error
    current_step_order INT DEFAULT 1,
    result TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_org_id ON tasks(org_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- ============================================================
-- 7. TASK_VALIDATIONS — demandes d'approbation humaine
-- ============================================================
CREATE TABLE IF NOT EXISTS task_validations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    content_to_review TEXT NOT NULL,
    decision VARCHAR(20),                     -- NULL tant qu'en attente | approve | reject
    feedback TEXT,
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    decided_at TIMESTAMPTZ
);

-- Migration 002 — Ajout des actions activées par client + URLs de référence

ALTER TABLE client_config
    ADD COLUMN IF NOT EXISTS content_language VARCHAR(10) DEFAULT 'fr-FR',
    ADD COLUMN IF NOT EXISTS key_urls JSONB DEFAULT '{}';

CREATE TABLE IF NOT EXISTS client_enabled_actions (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    action_id VARCHAR(150) NOT NULL,
    enabled_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (org_id, action_id)
);

-- ============================================================
-- Note pour plus tard (durcissement sécurité, pas fait dans ce MVP) :
-- Le document d'architecture recommande le Row Level Security (RLS)
-- PostgreSQL pour l'isolation stricte par organisation. Non activé ici
-- pour rester simple au démarrage — l'isolation repose pour l'instant
-- sur le filtrage applicatif (WHERE org_id = ...) dans le code Fastify.
-- À activer avant d'avoir de vraies données clients sensibles en prod :
--   ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY org_isolation ON tasks
--     USING (org_id = current_setting('app.current_org_id')::uuid);
-- (nécessite que Fastify fasse un SET app.current_org_id à chaque requête)
-- ============================================================
