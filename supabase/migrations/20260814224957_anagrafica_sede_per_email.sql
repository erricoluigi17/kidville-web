-- =============================================================================
-- 20260814224957 — Anagrafica di sede: l'indirizzo e la casella di ogni plesso, per il piè di
-- pagina delle dodici email transazionali.
--
-- ✅ APPLICATA il 2026-08-15, version 20260814224957.
--
-- ⚠️ IL FILE SI CHIAMAVA `20260815010000_...` E QUELLA VERSION NON È MAI
--    ESISTITA. `apply_migration` assegna la version da sé, e in produzione la
--    riga è `20260814224957`; il nome era stato scelto a mano, dopo. Rinominato
--    il 2026-08-17 sulla version vera: il CLI applica i file in ordine
--    ALFABETICO di nome, quindi un timestamp inventato fa ricostruire il
--    database in un ordine che in produzione non è mai avvenuto — e si rompe
--    sulla prima dipendenza (un ALTER prima del CREATE che lo giustifica).
--    Il difetto era invisibile finché la fotografia delle migrazioni è rimasta
--    ferma al 2026-08-12.
--
-- ─── COSA C'ERA PRIMA, MISURATO IL 2026-08-15 ───────────────────────────────
--   scuole.indirizzo    Giugliano → NULL
--                       Aversa    → «Via Dell'Archeologia 54, 81031 Aversa (CE)»   ✓
--                       Cesa      → «Via Filippo Turati 2, 81030 Cesa (CE)»        ✓
--   schools.indirizzo   Giugliano → «Via Roma 1»   ← SEGNAPOSTO, mai corretto
--   config->'anagrafica'  assente su tutte e tre le sedi reali (config = '{}')
--
-- Il piè di pagina delle email nomina il plesso che scrive. Senza questa riga,
-- le email di Kidville Giugliano — il plesso con più famiglie — sarebbero uscite
-- senza indirizzo, oppure, se qualcuno avesse letto `schools`, con «Via Roma 1».
--
-- ─── SI SELEZIONA PER NOME, NON PER UUID ────────────────────────────────────
-- Non è una preferenza di stile: è il lock `migrazioni-senza-sede-cablata`, e la
-- ragione per cui esiste. Una migrazione che scriveva
-- `WHERE scuola_id = '<uuid di Giugliano>'` accese i solleciti per una sola sede
-- su tre, e per settimane «nessun sollecito» somigliò moltissimo a «nessun
-- moroso». Un uuid incollato in un file è un filtro invisibile che nessuno
-- rilegge; un nome si legge, e quando è sbagliato zero righe cambiano e si vede.
--
-- Il nome è anche l'unica chiave che sopravvive a un database ricostruito: gli
-- uuid cambierebbero, «Kidville Aversa» no.
--
-- Tutte le istruzioni sono IDEMPOTENTI: rieseguirle non cambia niente.
--
-- ─── IL TELEFONO NON C'È, E NON SI INVENTA ──────────────────────────────────
-- Un recapito telefonico per plesso non esiste in nessuna tabella e in nessun
-- documento dell'archivio della cooperativa. La colonna `telefono` dello schema
-- `zAnagraficaSede` resta quindi VUOTA, e il piè di pagina omette la riga invece
-- di stampare un `tel:` senza numero. Il giorno che qualcuno compila il campo in
-- Impostazioni, la riga compare da sola: non serve toccare il codice.
--
-- ─── LE TRE CASELLE ESISTONO DAVVERO ────────────────────────────────────────
-- `giugliano@`, `aversa@` e `cesa@kidville.it` sono tre caselle attive, una per
-- plesso. Non sono alias inventati per riempire il modello: sono l'indirizzo a
-- cui una famiglia di Aversa deve scrivere, ed è diverso da quello di Cesa.
--
-- La scrittura di `config` è un MERGE (`||`): se qualcuno riempie in Impostazioni
-- il codice meccanografico o la P.IVA prima che questa migrazione giri, quei
-- valori restano.
-- =============================================================================

-- Kidville Giugliano — l'indirizzo mancava del tutto.
-- Civico 5: il «3» che compare nelle pratiche antincendio più recenti è un
-- refuso di quei documenti, confermato dal titolare.
update public.scuole
   set indirizzo = 'Via Prima Traversa Antica Giardini 5, 80014 Giugliano in Campania (NA)',
       updated_at = now()
 where nome = 'Kidville Giugliano'
   and coalesce(btrim(indirizzo), '') = '';

-- `schools` è il gemello che le route admin tengono allineato a `scuole` (vedi
-- l'upsert in `src/app/api/admin/schools/route.ts`). Qui i due disaccordavano:
-- uno era vuoto, l'altro era un segnaposto.
update public.schools s
   set indirizzo = v.indirizzo
  from public.scuole v
 where v.id = s.id
   and v.nome = 'Kidville Giugliano'
   and v.indirizzo is not null
   and coalesce(s.indirizzo, '') is distinct from v.indirizzo;

-- La casella di ciascun plesso, dentro `config->'anagrafica'`.
update public.scuole s
   set config = jsonb_set(
           coalesce(s.config, '{}'::jsonb),
           '{anagrafica}',
           coalesce(s.config -> 'anagrafica', '{}'::jsonb) || jsonb_build_object('email', v.email),
           true
       ),
       updated_at = now()
  from (values
        ('Kidville Giugliano', 'giugliano@kidville.it'),
        ('Kidville Aversa',    'aversa@kidville.it'),
        ('Kidville Cesa',      'cesa@kidville.it')
       ) as v(nome, email)
 where s.nome = v.nome
   and coalesce(s.config -> 'anagrafica' ->> 'email', '') is distinct from v.email;
