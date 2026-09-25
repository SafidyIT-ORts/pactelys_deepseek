-- Migration 005 — Ajoute les colonnes manquantes sur client_config
--
-- Trouvé en testant POST /api/client/config en local : le code (app.js,
-- generateMarkdownFiles) lit/écrit ces champs depuis 001_initial_schema.sql,
-- mais ils n'ont jamais été créés par aucune migration :
--   error: column "icp_technology" of relation "client_config" does not exist
--
-- Champs concernés : S01.md (icp_technology, icp_stage, icp_seniority_minimum)
-- et Brand.md (positioning_contrast, tone_traits, key_messages, validated_phrases).

ALTER TABLE client_config
    ADD COLUMN IF NOT EXISTS icp_technology TEXT,
    ADD COLUMN IF NOT EXISTS icp_stage VARCHAR(100),
    ADD COLUMN IF NOT EXISTS icp_seniority_minimum VARCHAR(100),
    ADD COLUMN IF NOT EXISTS positioning_contrast TEXT,
    ADD COLUMN IF NOT EXISTS tone_traits JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS key_messages JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS validated_phrases JSONB DEFAULT '[]';
