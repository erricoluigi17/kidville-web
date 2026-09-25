-- ============================================================================
-- PRIMARIA — tutto quello che scrive il docente diventa modificabile ed
-- eliminabile: impreparati con un TIPO, cestino di 7 giorni per allegati del
-- registro e documenti del fascicolo, sblocchi della Direzione anche per voce
-- (impreparato, allegato, firma) e per classe+giorno.
--
-- PERCHÉ. Fino a oggi né l'API né l'interfaccia permettevano di togliere un
-- impreparato messo per errore: l'unico modo è stato cancellarlo a mano dal
-- database. La spec approvata il 2026-09-24
-- (`docs/superpowers/specs/2026-09-24-sei-interventi-app-1-1-design.md`)
-- stabilisce che valutazioni, impreparati, note, allegati e fascicolo si
-- modificano e si eliminano. Questa migrazione porta SOLO lo schema che serve
-- alle route; la logica (chi, entro quando, con quale sblocco) sta nel codice.
--
-- IDEMPOTENTE. Gira in produzione una volta, dall'integrazione al merge, e sul
-- database della CI anche più volte: ogni ALTER è guardato (IF NOT EXISTS, o un
-- blocco DO che guarda `pg_constraint`), ogni funzione è CREATE OR REPLACE,
-- ogni trigger DROP IF EXISTS + CREATE, ogni UPDATE rifatto non cambia niente.
--
-- STATO AL MOMENTO DELLA SCRITTURA (contato in produzione il 2026-09-25, solo
-- conteggi): `giustifiche_didattiche` 7 righe, tutte `origine='docente'` col
-- testo fisso «Impreparato giustificato»; `allegati_registro` 11 righe;
-- `student_documents` 275; `sblocchi_audit` 0.
--
-- ✅ APPLICATA il 2026-09-25, dall'integrazione Supabase al merge della PR #166,
-- con la version del FILE (`20260924220000`, una sola riga in
-- `schema_migrations`). Subito dopo sono state rigenerate dalla produzione le
-- fotografie (migrazioni, policy, indici unici, FK di sede e verso `utenti`,
-- tabelle con `scuola_id`), e le due FK nuove verso `utenti`
-- (`allegati_registro.eliminato_da`, `student_documents.eliminato_da`, SET NULL)
-- sono state censite in `TRACCE_DOCENTE`.
-- ============================================================================


-- ─── 1. IMPREPARATI: il tipo si separa dal motivo ──────────────────────────
-- Il docente sceglie fra «Impreparato» e «Impreparato giustificato»; il motivo
-- torna a essere quello che dice il nome, un testo libero FACOLTATIVO. Finora
-- il tipo stava scritto dentro il motivo (le 7 righe del docente hanno tutte il
-- testo fisso «Impreparato giustificato»), cioè un'etichetta dell'interfaccia
-- salvata come dato: non si poteva cambiare senza riscrivere il testo, e non
-- distingueva niente perché era uguale per tutti.

ALTER TABLE public.giustifiche_didattiche
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'impreparato';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.giustifiche_didattiche'::regclass
       AND conname  = 'giustifiche_didattiche_tipo_check'
  ) THEN
    ALTER TABLE public.giustifiche_didattiche
      ADD CONSTRAINT giustifiche_didattiche_tipo_check
      CHECK (tipo IN ('impreparato', 'giustificato'));
  END IF;
END $$;

COMMENT ON COLUMN public.giustifiche_didattiche.tipo IS
  '«impreparato» o «giustificato». Lo sceglie il docente e lo cambia con Modifica; quello dichiarato dal genitore (origine=genitore) è sempre «giustificato», e lo impone il trigger trg_giustifiche_didattiche_genitore_giustificato. Il motivo è un testo libero facoltativo, separato dal tipo.';

-- Quello che dichiara il genitore è, per definizione, giustificato. Ripetibile:
-- una seconda esecuzione trova già 'giustificato' e non cambia niente.
UPDATE public.giustifiche_didattiche
   SET tipo = 'giustificato'
 WHERE origine = 'genitore'
   AND tipo IS DISTINCT FROM 'giustificato';

-- «SEMPRE GIUSTIFICATO» LO GARANTISCE IL DATABASE, NON LA MEMORIA DI UNA ROUTE.
-- Il riempimento qui sopra gira una volta sola in produzione, e il predefinito
-- della colonna è 'impreparato'. Senza questo trigger bastano due cose per
-- scrivere un «impreparato» a nome del genitore, e per sempre:
--  · la FINESTRA DEL DEPLOY: al merge l'integrazione applica la migrazione,
--    ma per qualche minuto Vercel serve ancora la route del genitore di prima,
--    che `tipo` non lo conosce e prende il predefinito;
--  · una route futura che si dimentica il campo — e i test con i mock non se
--    ne accorgerebbero.
-- Il trigger CORREGGE invece di rifiutare, ed è la scelta voluta: un CHECK
-- (`origine <> 'genitore' OR tipo = 'giustificato'`) nella stessa finestra
-- farebbe FALLIRE le dichiarazioni dei genitori, cioè perderebbe il dato che
-- dovrebbe proteggere. Scatta anche sull'UPDATE di `origine` e di `tipo`, così
-- nemmeno una Modifica può rimettere «impreparato» su una riga del genitore.
--
-- `SECURITY INVOKER` (il predefinito): non legge altre tabelle, e non c'è
-- niente da sbloccare con i privilegi del proprietario.
CREATE OR REPLACE FUNCTION public.giustifiche_didattiche_genitore_giustificato()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.origine = 'genitore' THEN
    NEW.tipo := 'giustificato';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.giustifiche_didattiche_genitore_giustificato() IS
  'Impone tipo=giustificato sulle righe con origine=genitore, in INSERT e in UPDATE di origine o tipo. Corregge invece di rifiutare, per non perdere le dichiarazioni dei genitori scritte da codice che il tipo non lo conosce.';

DROP TRIGGER IF EXISTS trg_giustifiche_didattiche_genitore_giustificato
  ON public.giustifiche_didattiche;

CREATE TRIGGER trg_giustifiche_didattiche_genitore_giustificato
  BEFORE INSERT OR UPDATE OF origine, tipo ON public.giustifiche_didattiche
  FOR EACH ROW
  EXECUTE FUNCTION public.giustifiche_didattiche_genitore_giustificato();

-- I 7 del docente diventano «Impreparato» con motivo NULL, come deciso dal
-- titolare: il testo fisso non era un motivo, era l'etichetta del bottone.
-- La condizione `tipo = 'impreparato'` rende l'UPDATE ripetibile SENZA mai
-- ribaltare il tipo di una riga scritta dopo questa migrazione: al primo giro
-- tutte le righe del docente valgono 'impreparato' (il predefinito appena
-- aggiunto), ai giri successivi una riga che il docente ha segnato
-- «giustificato» non viene toccata.
UPDATE public.giustifiche_didattiche
   SET motivo = NULL
 WHERE origine = 'docente'
   AND tipo = 'impreparato'
   AND motivo = 'Impreparato giustificato';


-- ─── 2. ALLEGATI DEL REGISTRO: cestino e slot d'origine ────────────────────
-- Un allegato eliminato non sparisce: va nel CESTINO per 7 giorni con
-- «Ripristina», poi la purga via cron toglie riga e file. Stessa cosa quando si
-- SOSTITUISCE il file: la riga vecchia va nel cestino e se ne crea una nuova.
--
-- `eliminato_da` perde il riferimento se l'utente viene cancellato (SET NULL):
-- l'allegato nel cestino non deve sparire, né bloccare la cancellazione di un
-- account, solo perché chi l'ha cestinato non c'è più.

ALTER TABLE public.allegati_registro
  ADD COLUMN IF NOT EXISTS eliminato_il timestamptz;

ALTER TABLE public.allegati_registro
  ADD COLUMN IF NOT EXISTS eliminato_da uuid REFERENCES public.utenti(id) ON DELETE SET NULL;

-- LO SLOT D'ORIGINE. Quando si elimina una lezione che ha allegati, gli
-- allegati vanno nel cestino e si possono ripristinare SOLO rifirmando la
-- lezione nello stesso slot (sezione + data + ora). Ma a lezione cancellata il
-- `registro_id` non punta più a niente: lo slot va scritto sull'allegato,
-- altrimenti il ripristino non saprebbe dove riagganciarlo. Lo scrive il
-- trigger `trg_allegati_registro_copia_slot` (più sotto) a ogni aggancio, non
-- le route: vedi lì il perché.
--
-- Nessuna FK su `slot_section_id`: è una COPIA dello slot per il riaggancio,
-- non un legame vivo. Se la sezione sparisse, l'allegato nel cestino
-- semplicemente non troverebbe più una lezione (409 LEZIONE_DA_RIFIRMARE) e
-- la purga lo toglierebbe coi suoi 7 giorni — mentre una FK in CASCADE
-- cancellerebbe la riga lasciando il FILE orfano nello Storage.
ALTER TABLE public.allegati_registro
  ADD COLUMN IF NOT EXISTS slot_section_id uuid;

ALTER TABLE public.allegati_registro
  ADD COLUMN IF NOT EXISTS slot_data date;

-- `integer` e non `smallint`: è il tipo di `registro_orario.ora_lezione` e di
-- `sblocchi_audit.ora_lezione`. Due tipi diversi per lo stesso numero sono il
-- modo in cui un confronto comincia a passare da una conversione implicita che
-- nessuno ha scelto (stessa ragione scritta in 20260909121501).
ALTER TABLE public.allegati_registro
  ADD COLUMN IF NOT EXISTS slot_ora_lezione integer;

-- Gli allegati che esistono già ricevono lo slot della loro lezione: senza,
-- eliminare oggi una lezione vecchia renderebbe i suoi allegati impossibili da
-- ripristinare. Ripetibile: tocca solo le righe che lo slot non ce l'hanno.
UPDATE public.allegati_registro a
   SET slot_section_id  = r.section_id,
       slot_data        = r.data,
       slot_ora_lezione = r.ora_lezione
  FROM public.registro_orario r
 WHERE r.id = a.registro_id
   AND a.slot_section_id IS NULL
   AND r.section_id IS NOT NULL;

-- La FK verso la lezione passa da CASCADE a SET NULL: eliminare una lezione
-- NON deve più cancellare gli allegati (sparirebbero senza cestino, e il file
-- resterebbe orfano nello Storage). Si cerca il vincolo per STRUTTURA
-- (colonna e tabella di arrivo), non solo per nome: se in un ambiente avesse un
-- nome diverso, un DROP per nome non lo troverebbe e il CASCADE resterebbe.
DO $$
DECLARE
  v_fk record;
  v_col smallint;
BEGIN
  SELECT attnum INTO v_col
    FROM pg_attribute
   WHERE attrelid = 'public.allegati_registro'::regclass
     AND attname  = 'registro_id';

  FOR v_fk IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid  = 'public.allegati_registro'::regclass
       AND confrelid = 'public.registro_orario'::regclass
       AND contype   = 'f'
       AND conkey    = ARRAY[v_col]
       AND confdeltype <> 'n'          -- 'n' = SET NULL: già a posto
  LOOP
    EXECUTE format('ALTER TABLE public.allegati_registro DROP CONSTRAINT %I', v_fk.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid  = 'public.allegati_registro'::regclass
       AND confrelid = 'public.registro_orario'::regclass
       AND contype   = 'f'
       AND conkey    = ARRAY[v_col]
  ) THEN
    ALTER TABLE public.allegati_registro
      ADD CONSTRAINT allegati_registro_registro_id_fkey
      FOREIGN KEY (registro_id) REFERENCES public.registro_orario(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.allegati_registro
  ALTER COLUMN registro_id DROP NOT NULL;

-- LO SLOT LO COPIA IL DATABASE A OGNI AGGANCIO. Il riempimento qui sopra copre
-- solo gli allegati che esistono oggi; dal minuto dopo il caricamento
-- (POST /api/primaria/allegati) continua a inserire righe senza slot, e nessuno
-- ha il compito di cambiarlo. Senza questo trigger nasce una trappola precisa:
-- un allegato caricato dopo il merge viene SOSTITUITO, la riga vecchia va nel
-- cestino col `registro_id` ancora valorizzato e senza slot; quando poi si
-- elimina la lezione, il SET NULL della FK viola il vincolo qui sotto e il
-- DELETE fallisce con 23514. E se chi elimina la lezione scrivesse lo slot solo
-- sugli allegati attivi, quelli già nel cestino resterebbero senza slot: non
-- ripristinabili, e d'ostacolo alla cancellazione.
--
-- Così ogni riga agganciata a una lezione HA il suo slot, per costruzione, e
-- né l'upload, né la sostituzione, né l'eliminazione della lezione devono
-- ricordarsene. Scatta su INSERT e su UPDATE di `registro_id`:
--  · `registro_id` valorizzato (caricamento, ripristino con riaggancio) → si
--    copiano sezione, data e ora della lezione;
--  · `registro_id` NULL (è il SET NULL della FK quando la lezione sparisce) →
--    non si tocca niente: lo slot copiato prima è esattamente ciò che serve.
-- Lo slot di una lezione non si sposta: `registro_orario` si scrive in upsert
-- sulla chiave sezione+data+ora, quindi la copia non invecchia.
--
-- `SECURITY INVOKER` (il predefinito), come `avvisi_scadenza_compat`: gli
-- allegati si scrivono dal service-role. Se chi scrive non VEDE la lezione, il
-- trigger fallisce invece di lasciar passare una riga senza slot: fra le due,
-- la direzione sicura è negare.
CREATE OR REPLACE FUNCTION public.allegati_registro_copia_slot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lezione record;
BEGIN
  IF NEW.registro_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT section_id, data, ora_lezione
    INTO v_lezione
    FROM public.registro_orario
   WHERE id = NEW.registro_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'allegati_registro: lezione % non trovata, lo slot d''origine non si può copiare', NEW.registro_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.slot_section_id  := v_lezione.section_id;
  NEW.slot_data        := v_lezione.data;
  NEW.slot_ora_lezione := v_lezione.ora_lezione;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.allegati_registro_copia_slot() IS
  'Copia in slot_section_id/slot_data/slot_ora_lezione lo slot della lezione a cui l''allegato si aggancia (INSERT, UPDATE di registro_id). Con registro_id NULL — il SET NULL della lezione eliminata — lascia lo slot com''è.';

DROP TRIGGER IF EXISTS trg_allegati_registro_copia_slot
  ON public.allegati_registro;

CREATE TRIGGER trg_allegati_registro_copia_slot
  BEFORE INSERT OR UPDATE OF registro_id ON public.allegati_registro
  FOR EACH ROW
  EXECUTE FUNCTION public.allegati_registro_copia_slot();

-- UN ALLEGATO SENZA LEZIONE STA NEL CESTINO, E SA DOVE TORNARE. Il SET NULL
-- qui sopra apre una forma nuova, `registro_id IS NULL`, e questo vincolo la
-- restringe all'unico caso legittimo: la lezione è stata eliminata DOPO aver
-- messo i suoi allegati nel cestino con lo slot d'origine. Un allegato senza
-- lezione e fuori dal cestino sarebbe invisibile a tutti (nessuna lezione lo
-- mostra) ma mai purgato (la purga guarda il cestino): un file di un minore
-- conservato per sempre senza che nessuno lo sappia.
--
-- Conseguenza per chi elimina una lezione: PRIMA si cestinano i suoi allegati
-- attivi scrivendo `eliminato_il` ed `eliminato_da`, POI si cancella la
-- lezione. Lo slot non va scritto: c'è già, lo ha copiato il trigger qui sopra
-- all'aggancio (anche sugli allegati già nel cestino per una sostituzione).
-- Nell'ordine inverso il DELETE fallisce con 23514 — rumorosamente, che è il
-- punto: fallire in silenzio sarebbe il difetto.
--
-- Conseguenza per chi ripristina un allegato rimasto senza lezione: nello
-- stesso UPDATE si rimette `registro_id` sulla lezione rifirmata (il trigger
-- ricopia lo slot); altrimenti uscire dal cestino dà 23514.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.allegati_registro'::regclass
       AND conname  = 'allegati_registro_senza_lezione_nel_cestino_check'
  ) THEN
    ALTER TABLE public.allegati_registro
      ADD CONSTRAINT allegati_registro_senza_lezione_nel_cestino_check
      CHECK (
        registro_id IS NOT NULL
        OR (
          eliminato_il IS NOT NULL
          AND slot_section_id IS NOT NULL
          AND slot_data IS NOT NULL
          AND slot_ora_lezione IS NOT NULL
        )
      );
  END IF;
END $$;

-- La purga cerca SOLO le righe nel cestino, che sono poche: un indice parziale
-- le tiene tutte e nient'altro.
CREATE INDEX IF NOT EXISTS idx_allegati_registro_cestino
  ON public.allegati_registro (eliminato_il)
  WHERE eliminato_il IS NOT NULL;

COMMENT ON COLUMN public.allegati_registro.eliminato_il IS
  'Cestino: valorizzato = eliminato (o sostituito). Resta ripristinabile per 7 giorni, poi la purga toglie riga e file. Ogni lettura fuori da cestino e purga filtra eliminato_il IS NULL.';
COMMENT ON COLUMN public.allegati_registro.slot_section_id IS
  'Slot d''origine (con slot_data e slot_ora_lezione): serve a riagganciare l''allegato quando la lezione è stata eliminata e poi rifirmata nello stesso slot.';


-- ─── 3. FASCICOLO: stesso cestino ──────────────────────────────────────────
-- Un documento del fascicolo eliminato, o sostituito da un file nuovo, resta 7
-- giorni nel cestino. Nessuno slot qui: il documento appartiene all'alunno,
-- non a una lezione, e la FK `student_id` resta com'è.

ALTER TABLE public.student_documents
  ADD COLUMN IF NOT EXISTS eliminato_il timestamptz;

ALTER TABLE public.student_documents
  ADD COLUMN IF NOT EXISTS eliminato_da uuid REFERENCES public.utenti(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_student_documents_cestino
  ON public.student_documents (eliminato_il)
  WHERE eliminato_il IS NOT NULL;

COMMENT ON COLUMN public.student_documents.eliminato_il IS
  'Cestino: valorizzato = eliminato (o sostituito). Resta ripristinabile per 7 giorni, poi la purga toglie riga e file. Ogni lettura fuori da cestino e purga filtra eliminato_il IS NULL.';


-- ─── 4. SBLOCCHI DELLA DIREZIONE: nuovi tipi e il «giorno» ─────────────────
-- Il termine (2 giorni, 15 per le verifiche scritte) vale ora anche per
-- modificare ed eliminare, e anche per impreparati, allegati e firme. Oltre il
-- termine serve lo sblocco della Direzione, VOCE PER VOCE oppure per
-- CLASSE+GIORNO. I tipi esistenti restano tutti: la tabella è un registro
-- d'audit, e un tipo tolto renderebbe illeggibili le righe già scritte.
--
-- Si ricrea con DROP IF EXISTS + ADD, come in 20260909121501: la tabella ha 0
-- righe, e un vincolo ricreato identico a ogni giro è idempotente per
-- costruzione.

ALTER TABLE public.sblocchi_audit
  DROP CONSTRAINT IF EXISTS sblocchi_audit_entita_tipo_check;

ALTER TABLE public.sblocchi_audit
  ADD CONSTRAINT sblocchi_audit_entita_tipo_check
  CHECK (entita_tipo IN (
    'registro', 'valutazione', 'nota', 'scrutinio',
    'impreparato', 'allegato', 'firma', 'giorno'
  ));

-- IL BERSAGLIO. Il vincolo del 2026-09-09 ammetteva due forme: una riga
-- (`entita_id`) o uno slot della campanella (sezione + data + ora). Lo
-- sblocco di un GIORNO intero non ha né l'una né l'altra: ha sezione e data, e
-- nessuna ora — col vincolo vecchio sarebbe stato rifiutato.
--
-- La terza forma si ammette SOLO per `entita_tipo = 'giorno'`, e per quel tipo
-- è l'UNICA ammessa: un «giorno» con un'ora indicata sarebbe uno slot con
-- l'etichetta sbagliata, e uno con `entita_id` sarebbe ambiguo su che cosa
-- sblocca. Negli altri tipi la regola resta quella di prima: una riga che non
-- indica NIENTE è un'autorizzazione che nessuno andrà mai a cercare.
--
-- La ricerca del giorno usa `idx_sblocchi_slot (entita_tipo, section_id, data,
-- ora_lezione)`, di cui è un prefisso: nessun indice nuovo.
ALTER TABLE public.sblocchi_audit
  DROP CONSTRAINT IF EXISTS sblocchi_audit_bersaglio_check;

ALTER TABLE public.sblocchi_audit
  ADD CONSTRAINT sblocchi_audit_bersaglio_check
  CHECK (
    CASE
      WHEN entita_tipo = 'giorno' THEN
        entita_id IS NULL
        AND section_id IS NOT NULL
        AND data IS NOT NULL
        AND ora_lezione IS NULL
      ELSE
        entita_id IS NOT NULL
        OR (section_id IS NOT NULL AND data IS NOT NULL AND ora_lezione IS NOT NULL)
    END
  );
