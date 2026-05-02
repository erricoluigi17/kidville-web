-- ============================================================
-- KIDVILLE — Seed dati di sviluppo
-- Eseguire dall'SQL Editor di Supabase (gira come postgres, bypassa RLS)
-- ============================================================

-- 0. Crea prima gli utenti in auth.users (Supabase Auth)
-- Senza questo step, utenti.id non può referenziare auth.users
INSERT INTO auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, role, aud, created_at, updated_at)
VALUES
('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'maestra.anna@kidville.it', crypt('kidville123', gen_salt('bf')), now(), 'authenticated', 'authenticated', now(), now()),
('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'sarah.pagano@email.it', crypt('kidville123', gen_salt('bf')), now(), 'authenticated', 'authenticated', now(), now())
ON CONFLICT (id) DO NOTHING;

-- Identities per permettere login con email/password
INSERT INTO auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
VALUES
('22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'maestra.anna@kidville.it', 'email', '{"sub":"22222222-2222-2222-2222-222222222222","email":"maestra.anna@kidville.it"}', now(), now(), now()),
('33333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', 'sarah.pagano@email.it', 'email', '{"sub":"33333333-3333-3333-3333-333333333333","email":"sarah.pagano@email.it"}', now(), now(), now())
ON CONFLICT (id) DO NOTHING;

-- 1. Scuola
INSERT INTO schools (id, nome, indirizzo, citta)
VALUES ('11111111-1111-1111-1111-111111111111', 'Kidville Roma', 'Via Roma 1', 'Roma')
ON CONFLICT (id) DO NOTHING;

-- 2. Utenti (profilo app, collegato a auth.users)
INSERT INTO utenti (id, email, nome, cognome, cellulare, ruolo, scuola_id) VALUES
('22222222-2222-2222-2222-222222222222', 'maestra.anna@kidville.it', 'Anna', 'Verdi', '3331234567', 'maestra', '11111111-1111-1111-1111-111111111111'),
('33333333-3333-3333-3333-333333333333', 'sarah.pagano@email.it', 'Sarah', 'Pagano', '3339876543', 'genitore', '11111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO NOTHING;

-- 3. Alunni sezione Girasoli
INSERT INTO alunni (id, scuola_id, nome, cognome, data_nascita, classe_sezione, note_mediche) VALUES
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Sofia',    'Esposito', '2022-03-15', 'Girasoli', 'Lattosio, Frutta secca'),
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'Leonardo', 'Ricci',    '2022-05-20', 'Girasoli', NULL),
('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'Emma',     'Conti',    '2022-01-10', 'Girasoli', 'Glutine'),
('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'Matteo',   'Ferrara',  '2021-11-05', 'Girasoli', NULL),
('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111', 'Giulia',   'Martini',  '2022-07-22', 'Girasoli', NULL)
ON CONFLICT (id) DO NOTHING;

-- 4. Legame genitore-figlio (Sarah → Sofia)
INSERT INTO legame_genitori_alunni (genitore_id, alunno_id) VALUES
('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
ON CONFLICT DO NOTHING;

-- 5. Verifica
SELECT '✅ Auth Users' as risultato, count(*) as righe FROM auth.users WHERE id IN ('22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333')
UNION ALL SELECT '✅ Scuole', count(*) FROM schools
UNION ALL SELECT '✅ Utenti', count(*) FROM utenti
UNION ALL SELECT '✅ Alunni', count(*) FROM alunni
UNION ALL SELECT '✅ Legami', count(*) FROM legame_genitori_alunni;

-- ============================================================
-- 6. Catalogo Armadietto (Fase 2.2)
-- ============================================================
INSERT INTO locker_catalog (id, scuola_id, nome, icona, unita, soglia_gialla, soglia_rossa, ordinamento) VALUES
('ca000001-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Pannolini',   '🧷', 'pz', 5, 2, 1),
('ca000002-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Salviette',   '🧻', 'pz', 3, 1, 2),
('ca000003-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Crema',       '🧴', 'ml', 2, 1, 3),
('ca000004-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Body Cambio', '👕', 'pz', 2, 1, 4),
('ca000005-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'Calzini',     '🧦', 'pz', 2, 1, 5)
ON CONFLICT (id) DO NOTHING;

-- 7. Inventario iniziale per gli alunni Girasoli
-- Sofia: pannolini quasi finiti (alert giallo), il resto ok
-- Leonardo: pannolini in emergenza (alert rosso)
-- Gli altri: quantità normali
INSERT INTO locker_inventory (alunno_id, catalogo_id, quantita, ultimo_carico) VALUES
-- Sofia Esposito
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ca000001-0000-0000-0000-000000000001', 4, now()),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ca000002-0000-0000-0000-000000000002', 8, now()),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ca000003-0000-0000-0000-000000000003', 3, now()),
-- Leonardo Ricci
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'ca000001-0000-0000-0000-000000000001', 1, now()),
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'ca000002-0000-0000-0000-000000000002', 5, now()),
-- Emma Conti
('cccccccc-cccc-cccc-cccc-cccccccccccc', 'ca000001-0000-0000-0000-000000000001', 15, now()),
('cccccccc-cccc-cccc-cccc-cccccccccccc', 'ca000002-0000-0000-0000-000000000002', 10, now()),
('cccccccc-cccc-cccc-cccc-cccccccccccc', 'ca000004-0000-0000-0000-000000000004', 3, now()),
-- Matteo Ferrara
('dddddddd-dddd-dddd-dddd-dddddddddddd', 'ca000001-0000-0000-0000-000000000001', 12, now()),
-- Giulia Martini
('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ca000001-0000-0000-0000-000000000001', 8, now()),
('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ca000002-0000-0000-0000-000000000002', 6, now())
ON CONFLICT DO NOTHING;

-- 8. Richiesta esempio per Leonardo (pannolini in rosso)
INSERT INTO locker_requests (alunno_id, catalogo_id, livello_alert, quantita_residua, stato) VALUES
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'ca000001-0000-0000-0000-000000000001', 'rosso', 1, 'pending')
ON CONFLICT DO NOTHING;

-- 9. Verifica Fase 2.2
SELECT '✅ Catalogo' as risultato, count(*) as righe FROM locker_catalog
UNION ALL SELECT '✅ Inventario', count(*) FROM locker_inventory
UNION ALL SELECT '✅ Richieste', count(*) FROM locker_requests;
