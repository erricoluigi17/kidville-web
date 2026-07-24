-- cleanup.sql — rollback della campagna «collaudo-giornata» (dati del giorno).
-- Eseguire via Supabase MCP execute_sql. Idempotente. NON tocca l'admin reale.
-- I findings/screenshot restano come prova in e2e/collaudo-giornata/run/.

-- 1) Ripristina le email OTP dirottate (login già usava auth.users.email → invariato).
update public.utenti u set email = au.email
from auth.users au
where au.id = u.id and u.email like 'lerrico7+%';

-- 2) Avvisi del giorno + relative risposte (adesioni/letture).
delete from public.avvisi_risposte
where avviso_id in (select id from public.avvisi where titolo ilike '%[E2E-GIORNATA]%');
delete from public.avvisi where titolo ilike '%[E2E-GIORNATA]%';

-- 3) Voci di diario del giorno (righe merenda con nota_libera taggata).
delete from public.eventi_diario where nota_libera ilike '%[E2E-GIORNATA]%';

-- 4) Delegato al ritiro di test.
delete from public.delegates where last_name = '[E2E-GIORNATA]';

-- 5) Presenze di test del giorno (non taggabili): eventualmente azzerare per gli
--    alunni TEST sulla data odierna, se il collaudo le ha scritte.
-- delete from public.presenze
-- where data = current_date
--   and alunno_id in (select id from public.alunni where section_id in
--     ('bb4e9f8a-c737-4d41-8634-02f8f8e48601','219cab6a-2bf3-48d6-a443-b7aecda40f42'));

-- ── STRUTTURA RIUSABILE (NON rimuovere di default; è roster TEST legittimo) ──
-- Legami scenari familiari (multi-figlio / infanzia+primaria):
-- delete from public.legame_genitori_alunni where genitore_id='0e30c48a-eb3b-47f2-b831-4dc23947c94c' and alunno_id='aaacb836-8d02-422d-88cb-ea99cf8e3c56';
-- delete from public.legame_genitori_alunni where genitore_id='303a0918-fb80-42d2-bd3f-02c4fd1ebaf4' and alunno_id='cf249c09-f56f-40a7-bcd8-1e1b1db916ab';
-- Account opzionali (cuoca, docente misto): rimuovere anche da auth.users via Admin API se si vuole azzerare del tutto.
