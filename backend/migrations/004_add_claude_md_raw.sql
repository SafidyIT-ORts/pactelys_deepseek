-- Migration 004 — Ajoute la colonne claude_md_raw manquante sur client_config
-- Ne modifie pas les migrations existantes (001, 002, 003).
--
-- Bug trouvé par le test d'intégration Phase 3 (test/execute.integration.test.js) :
-- brand_md_raw et s01_md_raw existent depuis 001_initial_schema.sql, mais
-- claude_md_raw n'a jamais été créée par aucune migration, alors que le
-- code s'appuie dessus à 3 endroits :
--   - execute.js::_getClientFilesFromDB (fallback quand les .md ne sont pas
--     sur disque pour un client — utilisé par POST /v1/actions/execute)
--   - GET  /v1/organizations/:id/markdown-files (lit cfg.claude_md_raw)
--   - PATCH /v1/organizations/:id/raw-config (écrit claude_md_raw)
-- Sans cette colonne, ces 3 chemins échouent avec :
--   error: column "claude_md_raw" of relation "client_config" does not exist

ALTER TABLE client_config
    ADD COLUMN IF NOT EXISTS claude_md_raw TEXT;
