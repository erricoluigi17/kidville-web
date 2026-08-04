-- =============================================================================
-- IL TETTO DI FREQUENZA SMETTE DI ESSERE PER-ISTANZA
-- =============================================================================
-- LA STORIA, con la misura invece che con l'aneddoto.
--
-- Il rilievo del collaudo diceva «61 richieste consecutive senza un solo 429»,
-- e la conclusione che se ne traeva — «il tetto non esiste» — è FALSA. Misurato
-- il 2026-08-04 su `app_log` (che persiste ogni 429 come anomalia):
--
--     /api/iscrizione/sedi              201 risposte 429   (29/07 → 04/08)
--     /api/iscrizione/model              61                (04/08)
--     /api/forms/send-otp                37                (01/08 → 02/08)
--     /api/iscrizione                    28                (16/07 → 02/08)
--     /api/public/cancellazione-account  20                (27/07)
--     /api/iscrizione/upload             16                (02/08)
--     /api/logs                          10
--     /api/parent/forms/otp               4
--
-- Il tetto SCATTA. Il difetto vero non è l'assenza, è l'INDETERMINATEZZA: il
-- contatore vive in una `Map` nello scope del modulo, cioè nella memoria di UNA
-- lambda. Su Vercel le lambda concorrenti sono N, e il tetto effettivo è N × il
-- limite dichiarato — con N che nessuno conosce, che cambia con il traffico e
-- che si azzera a ogni riciclo dell'istanza. Chi scrive `limit: 5` dichiara un
-- numero che il sistema non garantisce. `src/lib/security/rate-limit.ts` lo
-- diceva già nella propria testata da quando esiste: questa migrazione è la
-- risposta a quel commento.
--
-- ─── COSA CREA ─────────────────────────────────────────────────────────────
--
--  1. `public.tetto_frequenza` — una riga per chiave, con i colpi VIVI della
--     finestra. Non è una tabella di dati: è un contatore, senza niente di
--     personale dentro (vedi «PRIVACY» in fondo).
--  2. `public.tetto_frequenza_consuma(chiave, limite, finestra_ms)` — l'unica
--     porta: incrementa E decide in UN SOLO statement.
--  3. la pulizia delle righe scadute, su `pg_cron`.
--
-- ─── PERCHÉ UNA SOLA FUNZIONE E UN SOLO STATEMENT ──────────────────────────
--
-- Un limitatore scritto come «leggi il contatore, decidi, scrivi il contatore»
-- è una CORSA CRITICA con le parole giuste: dieci richieste simultanee leggono
-- tutte lo stesso valore e passano tutte. È il difetto classico di questa
-- famiglia, e su una firma con valore legale significa dieci tentativi al
-- prezzo di uno. Qui la lettura, la decisione e la scrittura sono lo stesso
-- `INSERT … ON CONFLICT DO UPDATE … RETURNING`: Postgres prende il lock di riga
-- sul conflitto e le richieste concorrenti si mettono in fila per costruzione.
-- Non c'è una finestra fra il «leggi» e lo «scrivi» perché non c'è un «leggi».
--
-- ─── PERCHÉ UN ARRAY DI ISTANTI E NON UN INTERO ────────────────────────────
--
-- Un contatore intero costringe alla FINESTRA FISSA, che ha un difetto vero: a
-- cavallo di due finestre si ottengono 2 × limite richieste in pochi secondi.
-- L'array conserva la finestra SCORRENTE — la stessa semantica che il codice in
-- memoria ha sempre avuto, quindi nessun comportamento cambia sotto i piedi di
-- chi legge i limiti oggi. Il costo è limitato per costruzione: un istante si
-- appende SOLO quando la richiesta passa, quindi l'array non supera mai
-- `limite` elementi (il massimo dichiarato nel repo è 60, su `chat/translate`).
--
-- ─── PERCHÉ `ultimo_consentito` È UNA COLONNA ──────────────────────────────
--
-- `RETURNING` vede la riga NUOVA. Per rispondere «questa richiesta è passata?»
-- serve un pezzo dello stato VECCHIO, che dopo l'UPDATE non è più leggibile.
-- Ricostruirlo confrontando gli istanti sarebbe un indovinello (due richieste
-- nello stesso microsecondo lo sbaglierebbero); una seconda query lo
-- riporterebbe alla corsa critica che questa migrazione esiste per togliere.
-- Perciò la decisione si CALCOLA dentro l'UPDATE — dove `tetto_frequenza.colpi`
-- a destra dell'`=` è ancora la riga vecchia — e si SCRIVE in colonna, dove
-- `RETURNING` la trova. La colonna serve anche a chi indaga: dice se l'ultimo
-- passaggio su quella chiave è stato ammesso o respinto.
--
-- ─── LA PULIZIA: `pg_cron`, NON opportunistica ─────────────────────────────
--
-- L'alternativa era cancellare le righe scadute dentro la funzione stessa (per
-- esempio una volta ogni cento chiamate). È stata scartata: metterebbe una
-- `DELETE` a scansione dentro il percorso critico di una richiesta pubblica,
-- cioè farebbe pagare a un genitore a caso — con una latenza che salta ogni
-- tanto e senza motivo apparente — la manutenzione di tutti. Un limitatore che
-- ogni tanto si appende è peggio di nessun limitatore, ed è la stessa ragione
-- per cui il client applicativo ha una scadenza sulla chiamata.
-- `pg_cron` gira fuori dalla richiesta, ha un costo costante e si vede in
-- `cron.job_run_details`. Il repo lo usa già per i solleciti e la retention.
--
-- ⚠️ pg_cron NON esiste sul DB E2E della CI: lo `schedule` è in un blocco che
-- ingoia l'eccezione, come le tick esistenti (20260718400000). Senza cron le
-- righe non spariscono ma nemmeno danneggiano: sono piccole, e la funzione le
-- ignora comunque perché filtra per finestra.
--
-- ─── PERCHÉ `SECURITY INVOKER` E PERCHÉ IL REVOKE È OBBLIGATORIO ───────────
--
-- La funzione NON è `SECURITY DEFINER`: chi la chiama è il service-role del
-- server, che la RLS la bypassa già. Non serve alzare i privilegi, e ciò che
-- non si alza non si deve poi abbassare.
--
-- Il `REVOKE` invece serve, e non è formalità. In Supabase `anon` e
-- `authenticated` ricevono EXECUTE per GRANT esplicito: senza revoca, chiunque
-- abbia la chiave anon pubblica potrebbe chiamare
-- `/rest/v1/rpc/tetto_frequenza_consuma` con la chiave di QUALCUN ALTRO e
-- consumargli il budget — trasformando il limitatore in uno strumento per
-- chiudere fuori un genitore vero dalla propria firma. Un tetto scrivibile
-- dall'esterno è un'arma, non una difesa.
--
-- ─── PRIVACY (dati di minori: la domanda va posta) ─────────────────────────
--
-- `chiave` è opaca e a vita brevissima: `iscrizione:<ip>`, `otp-invio:<uuid>`,
-- `otp-verifica-oggetto:<uuid>`. Non contiene nomi, email, codici fiscali né
-- contenuti. L'IP però È un dato personale, quindi la riga vive quanto la
-- finestra (10 minuti) più il margine del cron: la retention è la pulizia
-- stessa, non un compito che qualcuno dovrà ricordarsi. Nessun `select` di
-- questa tabella entra in un log: il client applicativo registra soltanto
-- l'esito e, quando degrada, il motivo.
-- =============================================================================

-- ─── 1) LA TABELLA ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tetto_frequenza (
    -- La chiave applicativa così com'è (`gruppo:soggetto`). PK: è anche il punto
    -- su cui `ON CONFLICT` prende il lock di riga, cioè ciò che rende atomico
    -- il conteggio.
    chiave              text        PRIMARY KEY,
    -- Gli istanti dei colpi VIVI della finestra scorrevole. Mai più lunghi di
    -- `limite` elementi: si appende solo quando la richiesta passa.
    colpi               timestamptz[] NOT NULL DEFAULT '{}',
    -- L'esito dell'ultima consumazione. Esiste perché `RETURNING` vede solo la
    -- riga nuova (vedi la testata).
    ultimo_consentito   boolean     NOT NULL DEFAULT true,
    -- Quando questa riga smette di significare qualcosa. È l'unica cosa che il
    -- cron guarda.
    scade_il            timestamptz NOT NULL,
    creata_il           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tetto_frequenza IS
    'Contatore CONDIVISO dei tetti di frequenza (rate limit). Sostituisce la Map in memoria, '
    'che contava per-istanza: su Vercel il tetto effettivo era N × il limite dichiarato. '
    'Righe effimere (una finestra, ~10 minuti), ripulite da pg_cron: la chiave può contenere '
    'un IP, che è un dato personale, e non deve sopravvivere alla propria utilità.';

-- L'unico accesso non per chiave è quello del cron, che cancella per scadenza.
CREATE INDEX IF NOT EXISTS idx_tetto_frequenza_scade_il
    ON public.tetto_frequenza (scade_il);

-- Nessuna policy, e RLS ACCESA: la tabella è raggiungibile solo dal service-role
-- (che la bypassa) e dalla funzione qui sotto. Una tabella senza RLS in questo
-- schema sarebbe leggibile con la chiave anon pubblica via PostgREST — cioè
-- l'elenco degli IP che hanno bussato, servito a chiunque.
ALTER TABLE public.tetto_frequenza ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tetto_frequenza FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.tetto_frequenza TO service_role;

-- ─── 2) LA PORTA UNICA: consuma e decidi, in un solo statement ──────────────

CREATE OR REPLACE FUNCTION public.tetto_frequenza_consuma(
    p_chiave      text,
    p_limite      integer,
    p_finestra_ms integer
)
RETURNS TABLE (consentito boolean, rimanenti integer, riprova_fra_ms integer)
LANGUAGE plpgsql
VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    -- `clock_timestamp()` e NON `now()`: `now()` è l'istante di inizio della
    -- TRANSAZIONE ed è identico per tutte le chiamate che ci finiscono dentro.
    v_ora      timestamptz := clock_timestamp();
    v_finestra interval    := make_interval(secs => GREATEST(p_finestra_ms, 0) / 1000.0);
    v_colpi    timestamptz[];
    v_ok       boolean;
    v_vivi     integer;
    v_primo    timestamptz;
BEGIN
    IF p_chiave IS NULL OR p_limite IS NULL OR p_limite < 0 THEN
        RAISE EXCEPTION 'tetto_frequenza_consuma: parametri non validi';
    END IF;

    INSERT INTO public.tetto_frequenza AS t (chiave, colpi, ultimo_consentito, scade_il)
    VALUES (p_chiave, ARRAY[v_ora], (p_limite > 0), v_ora + v_finestra)
    ON CONFLICT (chiave) DO UPDATE
        SET
            -- A destra dell'`=`, `t.colpi` è ancora la riga VECCHIA: si scartano i
            -- colpi usciti dalla finestra e si appende quello nuovo solo se c'è
            -- posto. Tutto dentro l'UPDATE, quindi sotto il lock di riga.
            colpi = (
                SELECT CASE
                           WHEN COALESCE(array_length(v.vivi, 1), 0) >= p_limite THEN v.vivi
                           ELSE v.vivi || v_ora
                       END
                FROM (
                    SELECT COALESCE(array_agg(x ORDER BY x), '{}'::timestamptz[]) AS vivi
                    FROM unnest(t.colpi) AS x
                    WHERE x > v_ora - v_finestra
                ) v
            ),
            ultimo_consentito = (
                SELECT COUNT(*) < p_limite
                FROM unnest(t.colpi) AS x
                WHERE x > v_ora - v_finestra
            ),
            scade_il = v_ora + v_finestra
    RETURNING t.colpi, t.ultimo_consentito INTO v_colpi, v_ok;

    v_vivi := COALESCE(array_length(v_colpi, 1), 0);

    IF v_ok THEN
        consentito     := true;
        rimanenti      := GREATEST(p_limite - v_vivi, 0);
        riprova_fra_ms := 0;
    ELSE
        SELECT MIN(x) INTO v_primo FROM unnest(v_colpi) AS x;
        consentito     := false;
        rimanenti      := 0;
        -- Quanto manca perché il colpo più vecchio esca dalla finestra. Mai 0:
        -- un `Retry-After: 0` è un invito a ritentare subito.
        riprova_fra_ms := GREATEST(
            1,
            CEIL(EXTRACT(EPOCH FROM ((v_primo + v_finestra) - v_ora)) * 1000)::integer
        );
    END IF;

    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.tetto_frequenza_consuma(text, integer, integer) IS
    'Consuma UNA unità del tetto `p_chiave` e restituisce (consentito, rimanenti, riprova_fra_ms) '
    'in una sola andata e ritorno. Incremento e decisione stanno nello stesso INSERT … ON CONFLICT '
    'DO UPDATE: due query separate sarebbero una corsa critica, e N richieste simultanee '
    'passerebbero tutte.';

-- Nessuno che non sia il server può consumare il budget di qualcun altro.
REVOKE ALL ON FUNCTION public.tetto_frequenza_consuma(text, integer, integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tetto_frequenza_consuma(text, integer, integer)
    TO service_role;

-- ─── 3) LA PULIZIA ──────────────────────────────────────────────────────────
-- Ogni 10 minuti, fuori dalla richiesta. Il margine di 5 minuti oltre la
-- scadenza non serve alla correttezza (la funzione filtra comunque per
-- finestra): serve a non cancellare una riga che una richiesta in volo sta per
-- riusare, il che costerebbe un INSERT invece di un UPDATE. È manutenzione, non
-- semantica.
DO $$
BEGIN
    PERFORM cron.unschedule('tetto-frequenza-pulizia');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    PERFORM cron.schedule(
        'tetto-frequenza-pulizia',
        '*/10 * * * *',
        $sql$DELETE FROM public.tetto_frequenza WHERE scade_il < now() - interval '5 minutes'$sql$
    );
EXCEPTION WHEN OTHERS THEN NULL;  -- pg_cron non esiste sul DB E2E della CI
END $$;
