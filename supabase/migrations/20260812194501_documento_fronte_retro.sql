-- =============================================================================
-- DUE FACCE, NON UNA — il documento d'identità si conserva fronte E retro
--
-- ✅ APPLICATA il 2026-08-12, version `20260812194501`.
--    Verificato DOPO, con una query e non a occhio:
--      • `pratiche_personale` e `anagrafica_personale` hanno entrambe le due colonne;
--      • `caricamenti_personale.anagrafica_utente_id` c'è, e l'indice parziale dei
--        sospesi è diventato `WHERE pratica_id IS NULL AND anagrafica_utente_id IS NULL`;
--      • `get_advisors(security)` → 0 ERROR e nessun WARN nuovo (restano i due
--        preesistenti: `pg_net` in public e `current_parent_student_ids`).
--    Il nome del file è stato allineato alla versione registrata in
--    `supabase_migrations.schema_migrations`: un file il cui nome non coincide viene
--    riapplicato dal `db push` successivo.
--
-- IL PERCHÉ, misurato il 2026-08-12
--    `/anagrafica-personale` chiedeva UNA scansione sola. Su una carta d'identità
--    cartacea il retro è dove stanno residenza e firma; su una patente è dove
--    stanno le categorie. Chiedere una faccia sola significa che la Segreteria
--    telefona per il pezzo mancante — cioè che il modulo non ha fatto il suo lavoro.
--
-- PERCHÉ SI RINOMINA invece di affiancare `documento_retro_path` a `documento_path`
--    In questo repo `PERSONALE_FIELDS[].id` **è** il nome della colonna, e da quell'id
--    discendono `costruisciRiga`, `COLONNE_ANAGRAFICA`, `COLONNE_DETTAGLIO`,
--    `GRUPPI_ANAGRAFICA_PERSONALE` e `CAMPI_MOSTRATI_FUORI_DAI_GRUPPI`. Un campo
--    etichettato «Fronte del documento» con id `documento_path` sarebbe un nome che
--    mente in cinque file.
--    Il costo sui dati è nullo, ed è stato misurato prima di scrivere questa riga:
--        select count(*) from anagrafica_personale;  → 0
--        select count(*) from pratiche_personale;    → 1
--    L'unico valore esistente diventa il FRONTE, che è anche semanticamente giusto:
--    una scansione sola, in pratica, è il fronte.
--
-- ⚠️ ORDINE DI RILASCIO VINCOLANTE: PRIMA QUESTA MIGRAZIONE, POI IL DEPLOY.
--    Un `rename column` non è retrocompatibile a runtime. Se il codice nuovo arriva
--    prima, `iscrizione/personale:POST` prende `PGRST204` e il suo ramo di degrado
--    TOGLIE la colonna sconosciuta e inserisce la pratica SENZA il percorso: la
--    scansione si perde in silenzio, che è il modo peggiore di perderla.
--    Al contrario, migrazione prima del codice = 503 per il tempo del deploy. È
--    l'errore giusto: rumoroso e reversibile.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. `pratiche_personale` — il dato NON fidato che arriva dal modulo pubblico
-- -----------------------------------------------------------------------------
alter table public.pratiche_personale
  rename column documento_path to documento_fronte_path;

-- Il CHECK segue la colonna ma si porta dietro il vecchio nome: rinominarlo evita
-- che fra un anno qualcuno cerchi `…documento_fronte_path_check` e non lo trovi.
alter table public.pratiche_personale
  rename constraint pratiche_personale_documento_path_check
                 to pratiche_personale_documento_fronte_path_check;

alter table public.pratiche_personale
  add column documento_retro_path text
    check (documento_retro_path is null or length(documento_retro_path) <= 200);

-- -----------------------------------------------------------------------------
-- 2. `anagrafica_personale` — il fascicolo, dopo l'approvazione
-- -----------------------------------------------------------------------------
alter table public.anagrafica_personale
  rename column documento_path to documento_fronte_path;

alter table public.anagrafica_personale
  add column documento_retro_path text
    check (documento_retro_path is null or length(documento_retro_path) <= 200);

-- ⚠️ IL CHECK CHE MANCAVA, e perché si aggiunge adesso.
--    `pratiche_personale.documento_path` aveva `length <= 200` fin dal principio;
--    `anagrafica_personale.documento_path` NO. Non era una svista innocua: era
--    sostenibile finché quella colonna aveva UN SOLO scrittore — il travaso
--    all'approvazione, che copia un valore già validato a monte.
--    Da questo lavoro ne ha DUE: si aggiunge la porta admin
--    (`admin/anagrafica-personale/scansione`) che il percorso se lo scrive da sé.
--    Con due scrittori l'invariante non può più vivere nella disciplina di chi
--    chiama. E c'è un vincolo di coerenza: `caricamenti_personale.percorso` ha già
--    `length(percorso) <= 200` nel CHECK della sua PK, quindi un percorso che sta
--    in quel registro DEVE poter stare anche qui.
alter table public.anagrafica_personale
  add constraint anagrafica_personale_documento_fronte_path_check
    check (documento_fronte_path is null or length(documento_fronte_path) <= 200);

-- -----------------------------------------------------------------------------
-- 3. `caricamenti_personale` — un oggetto che nasce già di proprietà
-- -----------------------------------------------------------------------------
-- Il registro esisteva per un difetto solo: la scansione si carica a un passo e la
-- pratica nasce al passo dopo, quindi un modulo abbandonato lasciava nel bucket una
-- carta d'identità che nessuna riga nominava. `spazzaCaricamentiSospesi` toglie
-- entro 24 h ciò che ha `pratica_id is null`.
--
-- La porta admin rompe quel presupposto: là l'oggetto NON appartiene a una pratica,
-- appartiene a un'anagrafica, e nasce già collegato nella stessa richiesta.
--
-- ⚠️ LA SCORCIATOIA DA NON PRENDERE — ed è quella che verrebbe naturale:
--    registrare l'oggetto admin senza nessuna colonna di proprietà. Resterebbe con
--    `pratica_id is null`, cioè «in sospeso», e la spazzata cancellerebbe entro 24
--    ore la scansione di una persona vera mentre `anagrafica_personale` la nomina.
--    È il caso peggiore possibile: l'anagrafica punterebbe a un file che non c'è.
alter table public.caricamenti_personale
  add column anagrafica_utente_id uuid
    references public.anagrafica_personale(utente_id) on delete cascade;

-- Un oggetto, un proprietario: o una pratica, o un'anagrafica, o nessuno dei due
-- (ed è quest'ultimo caso che la spazzata raccoglie). Mai entrambi.
alter table public.caricamenti_personale
  add constraint caricamenti_personale_un_solo_proprietario
    check (num_nonnulls(pratica_id, anagrafica_utente_id) <= 1);

-- L'indice dei sospesi deve conoscere il secondo proprietario, altrimenti la
-- spazzata continua a vedere «in sospeso» ciò che è già di qualcuno.
drop index if exists public.caricamenti_personale_sospesi_idx;
create index caricamenti_personale_sospesi_idx
  on public.caricamenti_personale (caricato_il)
  where pratica_id is null and anagrafica_utente_id is null;

-- -----------------------------------------------------------------------------
-- 4. I commenti — quello che il prossimo lettore deve sapere senza chiederlo
-- -----------------------------------------------------------------------------
comment on column public.pratiche_personale.documento_fronte_path is
  'Percorso nel bucket `documenti_personale` della faccia ANTERIORE del documento. '
  'Era `documento_path` fino al 2026-08-12: rinominata quando il modulo ha smesso di '
  'chiedere una faccia sola. All''approvazione l''oggetto NON si copia: l''anagrafica '
  'punta allo stesso file e questa colonna torna NULL. Un oggetto, un proprietario.';

comment on column public.pratiche_personale.documento_retro_path is
  'Come `documento_fronte_path`, per la faccia POSTERIORE. Obbligatoria nel modulo '
  '(`PERSONALE_FIELDS.required`), NULLABLE qui: l''obbligo vive nella validazione, non '
  'nel DDL, altrimenti una pratica degradata su un DB senza questa colonna non '
  'potrebbe più entrare. I due percorsi non possono essere uguali — lo impone la '
  'route, non il database, perché il confronto serve PRIMA di scrivere.';

comment on column public.anagrafica_personale.documento_fronte_path is
  'Faccia anteriore, nel fascicolo. Due scrittori: il travaso all''approvazione di una '
  'pratica e la porta `admin/anagrafica-personale/scansione`. Il percorso lo scrive '
  'sempre il server: non è, e non deve diventare, un campo del PATCH — chi potesse '
  'scriverlo a mano punterebbe l''anagrafica di una collega a un file qualunque.';

comment on column public.anagrafica_personale.documento_retro_path is
  'Faccia posteriore. Vale parola per parola quanto detto per il fronte. '
  'La conservazione (`gdpr/retention-personale`) le tratta come un insieme: la riga si '
  'chiude solo quando ENTRAMBI i file sono usciti dal bucket, mai una a metà.';

comment on column public.caricamenti_personale.anagrafica_utente_id is
  'Proprietario alternativo a `pratica_id`, per gli oggetti caricati dalla Segreteria '
  'dalla scheda della persona: là non c''è nessuna pratica, e la riga nasce già '
  'collegata nella stessa richiesta che carica il file. '
  '⚠️ NON si valorizza all''approvazione di una pratica: il percorso passa '
  'all''anagrafica ma la riga di registro RESTA con `pratica_id`. Spostarla '
  'richiederebbe uno swap con una finestra in cui entrambe le colonne sono NULL — '
  'cioè, per la durata di quella finestra, spazzabile. Il registro traccia CHI HA '
  'CARICATO, non chi possiede adesso.';

commit;

-- =============================================================================
-- QUELLO CHE QUESTA MIGRAZIONE NON FA, e non deve fare
--
--   • NON tocca il bucket `documenti_personale`: stesso nome, stessi 5 MIME, stesso
--     tetto di 4 MB. Le due facce stanno nello stesso archivio, con la stessa forma
--     di percorso `documenti/<uuid>/<uuid>.<ext>`, così il gate di forma e il CHECK
--     `like 'documenti/%'` valgono per entrambe senza una seconda regola.
--     Conseguenza attesa: `__tests__/fixtures/bucket-storage-snapshot.json` NON
--     cambia. Se cambia, qualcuno ha toccato il bucket per sbaglio.
--
--   • NON mette `not null` su nessuna delle quattro colonne. L'obbligatorietà del
--     retro vive in `PERSONALE_FIELDS.required` + `validatePage`. Un `not null` qui
--     renderebbe impossibile l'upsert della porta admin (che scrive un lato alla
--     volta) e l'approvazione di una pratica arrivata da un DB degradato.
--
--   • NON accende RLS su niente: le due tabelle ce l'hanno già, senza policy, cioè
--     raggiungibili solo dal service_role. Quindi la fotografia della RLS non va
--     rigenerata per questa migrazione.
-- =============================================================================
