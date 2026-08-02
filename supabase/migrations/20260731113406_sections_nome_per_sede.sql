-- =============================================================================
-- 20260731113406 — Il nome di una classe è unico DENTRO la sua sede
--
-- IL DIFETTO (R107, audit globale multi-sede del 2026-07-31).
-- `public.sections` non aveva nessun vincolo oltre alla chiave primaria:
-- `pg_constraint` su quella tabella dava `sections_pkey` e la sola FK verso
-- `schools`. Nessun `contype='u'`. Eppure l'invariante «il nome-classe è univoco
-- dentro la sede» è scritto in TRE docstring — `src/lib/auth/scope.ts`,
-- `src/lib/registro/chiave-orario.ts`, `src/app/api/agenda/route.ts` — ed è
-- quello su cui poggiano agenda, registro, armadietto e il gate di classe:
-- `assertClasseNomeInScope` risolve un nome con `.eq('name', …)` e gli basta UN
-- riscontro; `agenda` e `register/lessons` risolvono la sezione con un
-- `.limit(1)` senza ORDER BY.
--
-- Un invariante che vive solo nei commenti non è un invariante: è una speranza.
-- Due click sul pulsante «crea sezione» — o due operatori nella stessa mattina —
-- bastavano a creare due «2 ANNI» NELLA STESSA SEDE, senza errore. Da
-- quell'istante il filtro `.in('scuola_id', plessi)` non protegge più nessuno,
-- perché l'ambiguità è tutta interna a un plesso: i due `.limit(1)` scelgono a
-- caso fra due gruppi di bambini diversi. È il difetto del 29 luglio che si
-- ripresenta identico, ma col filtro di sede già in posizione e inutile.
--
-- STATO PRIMA DI QUESTA MIGRAZIONE (verificato in produzione, sola lettura):
--   · 38 sezioni (Giugliano 18, Cesa 12, Aversa 5, sede finta E2E 3);
--   · `select scuola_id, name, count(*) … having count(*) > 1` → 0 righe;
--   · 0 collisioni anche sul nome NORMALIZZATO `lower(replace(name,' ',''))`;
--   · `sections.scuola_id` e `sections.name` sono entrambe NOT NULL, quindi non
--     esiste il buco dei NULLS DISTINCT: nessuna riga sfugge all'indice.
-- Nessun dato da bonificare: il vincolo si applica a costo nullo e non rifiuta
-- niente di ciò che esiste oggi.
--
-- COSA NON CAMBIA. L'omonimia FRA sedi resta lecita, ed è voluta: «2 ANNI»
-- esiste sia ad Aversa sia a Cesa e deve poter esistere. La chiave è la COPPIA.
--
-- IL LATO APPLICATIVO. `admin/sections` POST/PATCH fa ora un controllo
-- preventivo e risponde 409 con un messaggio leggibile invece di lasciar passare
-- il duplicato; se la corsa fra due click arriva comunque fino a qui, il 23505
-- di questo indice viene tradotto nello stesso 409. Il database E2E della CI NON
-- è migrato: là l'unico presidio è il controllo applicativo, e va bene così —
-- non c'è nessun consumo di questo indice che possa fallire con 42703/PGRST204.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS sections_nome_per_sede
    ON public.sections (scuola_id, name);

COMMENT ON INDEX public.sections_nome_per_sede IS
    'Il nome della classe è unico DENTRO la sede (audit multi-sede 2026-07-31, R107). '
    'L''omonimia FRA sedi resta lecita: la chiave è la coppia (scuola_id, name).';
