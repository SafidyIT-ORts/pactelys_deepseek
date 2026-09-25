-- Migration 006 — Ajoute le détail par étape sur tasks
--
-- execute.js et la nouvelle route execute-auto exécutent des pipelines
-- multi-étapes (plusieurs agents enchaînés), mais tasks.result n'écrase
-- jamais que le texte de la DERNIÈRE étape. Sans stocker le détail de
-- chaque étape, impossible de vérifier que le hand-off entre agents est
-- réel (que l'étape N+1 s'appuie bien sur la sortie de l'étape N) ou de
-- savoir, pour execute-auto, quel plugin/agent a été choisi et pourquoi.

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS step_results JSONB DEFAULT '[]';
