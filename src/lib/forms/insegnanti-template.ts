import type { FormField, FormFieldOption } from '@/types/database.types'
// Il tetto della PIATTAFORMA, non il nostro. Questo modulo non importa niente e lo
// carica anche un componente `'use client'`: vedi il suo commento in testa.
import { LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'

/**
 * Template prestampato della CANDIDATURA di un'insegnante — il modulo pubblico
 * di `/lavora-con-noi`, che alimenta `POST /api/iscrizione/insegnanti`.
 *
 * Come in `enrollment-template.ts`, `id` = nome della colonna di destinazione,
 * così ciò che il modulo raccoglie è già pronto per l'INSERT; `db_mapping` porta
 * `tabella.colonna` per riferimento.
 *
 * Le colonne sono state LETTE dal database di produzione il 2026-08-10
 * (`information_schema.columns` su `candidature_insegnanti`), non dedotte: da lì
 * vengono `residence_city`/`residence_province` (che nell'anagrafica del repo si
 * chiamano già così), `titolo_dettaglio` e `note`, che è il campo dove l'utente
 * si presenta. Un id inventato non farebbe rosso da nessuna parte: PostgREST
 * risponderebbe `PGRST204` in produzione, sul primo invio vero.
 *
 * ── PERCHÉ QUI NON C'È IL CODICE FISCALE ─────────────────────────────────────
 *
 * Perché serve all'ASSUNZIONE, non alla candidatura: fino al contratto la Scuola
 * non ne fa nulla, e l'art. 5 §1 lett. c GDPR dice che i dati raccolti sono solo
 * quelli necessari alla finalità dichiarata. La finalità dichiarata qui è
 * «valutare una proposta di collaborazione»: per farlo bastano un nome, un
 * recapito e un'esperienza.
 *
 * E c'è la circostanza, che pesa quanto il principio: questo modulo è PUBBLICO e
 * senza login. Un codice fiscale chiesto qui è un identificativo nazionale in una
 * tabella che chiunque può alimentare, e da lì non si torna indietro — la tabella
 * `enrollment_submissions` di questo stesso repo ne conteneva 324 di minori
 * quattro giorni dopo che qualcuno aveva scritto «tanto siamo pre-lancio».
 * Quando l'assunzione ci sarà, il dato si chiede allora, a una persona sola.
 */

/** Sigla di provincia: due lettere. L'ESISTENZA la controlla `validateField`. */
const PROV_PATTERN = '^[A-Z]{2}$'

/**
 * Le fasce d'età per cui ci si può proporre. Multi-valore: chi ha lavorato al
 * nido e all'infanzia si candida per tutte e due, e costringerla a scegliere
 * farebbe perdere alla segreteria l'informazione che serve a smistarla.
 *
 * ⚠️ Questi tre `value` NON sono un'invenzione di questo file: sono le etichette
 * dell'enum `school_type_enum`, perché la colonna `gradi` è di tipo
 * `school_type_enum[]` (misurato: `information_schema.columns.udt_name` =
 * `_school_type_enum`, e `pg_enum` dà esattamente `{nido, infanzia, primaria}`).
 * Quindi un quarto valore NON entra affatto in tabella: Postgres lo rifiuta con
 * `22P02 invalid input value for enum` — verificato eseguendo
 * `select 'sostegno'::school_type_enum` in produzione il 2026-08-10.
 *
 * Il che sposta il problema, invece di toglierlo: `22P02` arriva dall'INSERT come
 * errore PostgREST, e su un modulo PUBBLICO diventerebbe un 500 opaco davanti a
 * una persona che non ha nessuno a cui chiedere. Per questo la route deve
 * FILTRARE i valori contro `GRADI_OPTIONS` prima di scrivere (vedi la
 * prescrizione sul campo `gradi`, più sotto). Chi aggiunge una fascia la aggiunge
 * qui E nell'enum, con una migrazione, e rigenera
 * `__tests__/fixtures/candidature-schema-snapshot.json`.
 */
export const GRADI_OPTIONS: FormFieldOption[] = [
  { label: 'Nido (0-3)', value: 'nido' },
  { label: 'Infanzia (3-6)', value: 'infanzia' },
  { label: 'Primaria (6-11)', value: 'primaria' },
]

/** Titolo di studio: elenco chiuso, il dettaglio libero sta nel campo accanto. */
export const TITOLI_STUDIO: FormFieldOption[] = [
  { label: 'Diploma di scuola superiore', value: 'diploma' },
  { label: 'Diploma magistrale / Liceo socio-psico-pedagogico', value: 'magistrale' },
  { label: 'Laurea triennale', value: 'laurea_triennale' },
  { label: 'Laurea magistrale', value: 'laurea_magistrale' },
  { label: 'Laurea in Scienze della Formazione Primaria', value: 'formazione_primaria' },
  { label: 'Master o specializzazione post-laurea', value: 'master' },
  { label: 'Altro titolo', value: 'altro' },
]

/** Disponibilità dichiarata: serve alla segreteria per smistare, non a valutare. */
const DISPONIBILITA: FormFieldOption[] = [
  { label: 'Tempo pieno', value: 'tempo_pieno' },
  { label: 'Part-time mattina', value: 'part_time_mattina' },
  { label: 'Part-time pomeriggio', value: 'part_time_pomeriggio' },
  { label: 'Supplenze e sostituzioni', value: 'supplenze' },
  { label: 'Tirocinio o volontariato', value: 'tirocinio' },
]

/**
 * I limiti del modulo, in un posto solo.
 *
 * `maxPresentazione` è ANCHE il `max_length` del campo `note` qui sotto, e
 * `maxCvMb` ANCHE il `max_size_mb` del campo `cv_path`: si scrivono una volta e
 * si rileggono, perché due costanti indipendenti per lo stesso limite finiscono
 * per divergere — è già successo in questo repo con il tetto della riga di log,
 * dichiarato in due file.
 *
 * ⚠️ E questo file lo aveva appena rifatto: `maxCvMb` valeva **5**, un numero
 * scritto a occhio accanto ad altri due che nessuno aveva confrontato. Misurato il
 * 2026-08-10, i tetti in gioco sono TRE e il più stretto non è quello che sembra:
 *
 *   | dove | valore | chi lo applica |
 *   |---|---|---|
 *   | bucket `form_attachments` | 8 MB (`file_size_limit = 8388608`) | lo Storage, DOPO il caricamento |
 *   | default delle due route di upload | 8 MB (`DEFAULT_MAX_MB`) | la route, se il campo non dice niente |
 *   | **piattaforma (Vercel)** | **4 MB** (`LIMITE_UPLOAD_MB`) | **prima di tutti: la funzione non parte nemmeno** |
 *
 * Sopra il tetto della piattaforma la richiesta muore contro un `413
 * FUNCTION_PAYLOAD_TOO_LARGE` che non è nostro e che non risponde nemmeno in JSON
 * — 41 tentativi falliti in un solo giorno sul modulo pubblico d'iscrizione, il
 * 31/07/2026, prima che qualcuno lo misurasse. `limiteUploadByte()` fa già un
 * `Math.min` con 4 MB: un campo che dichiara 5 non ottiene 5, ottiene 4 e ha
 * promesso 5. Perciò qui non c'è più un numero: c'è il tetto vero, letto da
 * `@/lib/upload/limite-piattaforma`.
 *
 * `mesiConservazione` è il numero che il testo del consenso PROMETTE
 * all'interessata. Chi scriverà il cron di cancellazione lo legga da qui: una
 * retention che applica un termine diverso da quello dichiarato non è un refuso,
 * è la dichiarazione su cui è stato prestato il consenso (art. 13 §2 lett. a).
 */
export const CANDIDATURA_LIMITI = {
  /**
   * Tetto dell'allegato CV, in MB — cioè il tetto della PIATTAFORMA, non una
   * scelta redazionale. Un curriculum ci sta con abbondanza; e qualunque numero
   * più alto sarebbe una promessa che la richiesta non arriva a mantenere.
   */
  maxCvMb: LIMITE_UPLOAD_MB,
  /** Caratteri della presentazione libera. */
  maxPresentazione: 1000,
  /** Mesi di conservazione della candidatura NON accolta, se acconsentito. */
  mesiConservazione: 24,
} as const

// ── Campi della CANDIDATURA (→ candidature_insegnanti) ────────────────────────
export const INSEGNANTE_FIELDS: FormField[] = [
  { id: 'nome', type: 'text', label: 'Nome', required: true, db_mapping: 'candidature_insegnanti.nome', placeholder: 'Es. Maria', validation: { min_length: 2, max_length: 50 } },
  { id: 'cognome', type: 'text', label: 'Cognome', required: true, db_mapping: 'candidature_insegnanti.cognome', placeholder: 'Es. Rossi', validation: { min_length: 2, max_length: 50 } },
  { id: 'email', type: 'email', label: 'Email', required: true, db_mapping: 'candidature_insegnanti.email', placeholder: 'Es. mario.rossi@email.com', validation: { max_length: 200 } },
  { id: 'telefono', type: 'phone', label: 'Numero di telefono', required: false, db_mapping: 'candidature_insegnanti.telefono', placeholder: 'Es. +39 333 1234567', validation: { max_length: 30 } },

  // Residenza: FACOLTATIVA. Serve a capire se la sede è raggiungibile, non a
  // decidere; pretenderla vorrebbe dire respingere una candidatura per un dato
  // che non c'entra con il lavoro.
  { id: 'residence_city', type: 'text', label: 'Comune di residenza', required: false, db_mapping: 'candidature_insegnanti.residence_city', placeholder: 'Es. Giugliano in Campania', validation: { max_length: 100 } },
  // ⚠️ L'id FINISCE per `_province` di proposito: `isProvinceField` guarda quel
  // suffisso, e da lì arrivano gratis l'auto-maiuscolo, lo snap su blur
  // («Napoli» → «NA») e il controllo che la sigla ESISTA davvero. Chiamarlo
  // `provincia_residenza` avrebbe spento tutte e tre le cose senza un rosso.
  { id: 'residence_province', type: 'text', label: 'Provincia di residenza', required: false, db_mapping: 'candidature_insegnanti.residence_province', placeholder: 'Es. NA', validation: { pattern: PROV_PATTERN, min_length: 2, max_length: 2 } },

  { id: 'titolo_studio', type: 'select', label: 'Titolo di studio', required: true, db_mapping: 'candidature_insegnanti.titolo_studio', options: TITOLI_STUDIO },
  { id: 'titolo_dettaglio', type: 'text', label: 'Dettaglio del titolo (indirizzo, istituto)', required: false, db_mapping: 'candidature_insegnanti.titolo_dettaglio', placeholder: 'Es. Scienze dell’educazione', validation: { max_length: 200 } },
  // 0-60 sono gli stessi estremi del CHECK in tabella
  // (`candidature_insegnanti_anni_esperienza_check`, letto in produzione):
  // qui il rifiuto arriva sotto il campo, lì è l'ultima rete.
  { id: 'anni_esperienza', type: 'number', label: 'Anni di esperienza', required: false, db_mapping: 'candidature_insegnanti.anni_esperienza', placeholder: 'Es. 3', validation: { min: 0, max: 60 } },

  // ── I GRADI, e le DUE difese che tocca alla route ──────────────────────────
  //
  // Quello che il modulo fa da sé. `type: 'checkbox'` è GIÀ multi-valore:
  // `FieldRenderer` lo rende con un `Controller` il cui valore è un array di
  // `value` (default `[]`), e `validateField` — tramite `eVuoto()` — considera
  // vuota una checkbox il cui valore non è un array o è un array vuoto. Quindi
  // `required: true` significa già «almeno una fascia», sul client e sul server,
  // con la STESSA funzione, senza una riga di validazione nuova.
  //
  // ⚠️ Quello che il DATABASE NON fa, contrariamente a quanto questo commento ha
  // dichiarato fino al 2026-08-10. Il CHECK in tabella è
  // `array_length(gradi, 1) >= 1`, e su un array vuoto `array_length` vale NULL:
  // un CHECK che vale NULL PASSA. Misurato in produzione, non dedotto:
  //     select (array_length('{}'::text[],1) >= 1)                    →  NULL
  //     create temp table t (g text[] not null default '{}'
  //                          check (array_length(g,1) >= 1));
  //     insert into t default values;                                 →  1 riga, `{}`
  // Sommato al `gradi ... not null default '{}'` della migrazione, il confine dei
  // due non coincide affatto: il modulo tiene, la tabella no.
  //
  // Perciò la route `POST /api/iscrizione/insegnanti` DEVE, e non è facoltativo:
  //   1. passare `gradi` SEMPRE ESPLICITO nell'INSERT — ometterlo non fa errore,
  //      fa entrare una candidatura con zero fasce, in silenzio, che la segreteria
  //      non sa a chi smistare;
  //   2. FILTRARE i valori ricevuti contro `GRADI_OPTIONS` prima di scrivere —
  //      `validateField` sulla checkbox controlla solo il VUOTO, non
  //      l'appartenenza (il ramo «Selezione non valida» di `validate-fields.ts` è
  //      scritto per `select` e `radio`), e un valore fuori enum arriva
  //      all'INSERT e prende `22P02`: su un modulo pubblico, un 500 opaco.
  // Entrambe le difese sono sorvegliate in `__tests__/lib/insegnanti-template.test.ts`.
  { id: 'gradi', type: 'checkbox', label: 'Per quali fasce ti proponi', required: true, db_mapping: 'candidature_insegnanti.gradi', options: GRADI_OPTIONS },

  { id: 'disponibilita', type: 'select', label: 'Disponibilità', required: false, db_mapping: 'candidature_insegnanti.disponibilita', options: DISPONIBILITA },
  { id: 'note', type: 'textarea', label: 'Presentati in poche righe', required: false, db_mapping: 'candidature_insegnanti.note', placeholder: 'Raccontaci il tuo percorso e perché ti piacerebbe lavorare con noi', validation: { max_length: CANDIDATURA_LIMITI.maxPresentazione } },

  // ── IL CV, e la difesa che tocca alla route (misurata, non dedotta) ─────────
  //
  // CV facoltativo: chi si candida dal telefono spesso il curriculum non ce
  // l'ha sottomano, e un allegato obbligatorio farebbe abbandonare il modulo a
  // chi i campi li ha già compilati tutti.
  //
  // ⚠️ L'`accept` NON è una scelta di questo file, ed è la correzione del
  // 2026-08-10. Prima diceva `.pdf,.doc,.docx,.jpg,.jpeg,.png`: sei estensioni
  // scritte a occhio, senza che nessuno avesse guardato il lato Storage. Misurato
  // in produzione (`select id, file_size_limit, allowed_mime_types from
  // storage.buckets`):
  //   · NON esiste nessun bucket per i curriculum. L'unica strada pubblica di
  //     caricamento del repo scrive in `form_attachments`;
  //   · `form_attachments` ammette cinque tipi — `application/pdf`, `image/jpeg`,
  //     `image/png`, `image/webp`, `image/heic` — e NON comprende né
  //     `application/msword` né `…wordprocessingml.document`.
  // Quindi il selettore OFFRIVA `.doc`/`.docx` — il formato in cui la maggioranza
  // dei curriculum viaggia — e il server li avrebbe respinti con un 415 DOPO che
  // la persona aveva compilato tutto il modulo, senza login e senza nessuno a cui
  // chiedere. È il difetto «bucket più stretto del gate» per cui in questo repo
  // esistono `src/lib/allegati/mime.ts` e il lock `allegati-mime-dichiarati`,
  // spostato di un campo. All'opposto `.heic` — quello che produce l'iPhone, che
  // il gate pubblico ACCETTA — non era offerto: una foto valida del curriculum
  // respinta dal selettore di file.
  //
  // Perciò la route `POST /api/iscrizione/insegnanti` (e la rotta di upload che
  // serve questo campo) DEVE:
  //   1. scrivere nel bucket `form_attachments`, NON inventarne uno nuovo — se un
  //      bucket `curriculum` dovrà esistere, nasce con una MIGRAZIONE che dichiara
  //      `allowed_mime_types` e `file_size_limit`, e questa lista si allinea a
  //      quella (il lock `bucket-storage-dichiarati` pretende la dichiarazione);
  //   2. passare da `verificaAllegatoPubblico` (`@/lib/upload/allegati-pubblici`),
  //      che è dove vivono l'allowlist, la concordanza tipo/estensione e il tetto
  //      per IP. Un gate riscritto qui sarebbe la terza copia della stessa regola.
  // L'elenco qui sotto è ESATTAMENTE `ESTENSIONI_ALLEGATO_PUBBLICO`, e
  // `__tests__/lib/insegnanti-template.test.ts` lo confronta con quella costante:
  // ribatterlo è il modo in cui le due liste divergono in silenzio. Non è importato
  // perché quel modulo tira dentro `next/server`, e questo template lo carica anche
  // il browser.
  { id: 'cv_path', type: 'file', label: 'Curriculum (facoltativo)', required: false, db_mapping: 'candidature_insegnanti.cv_path', accept: '.pdf,.jpg,.jpeg,.png,.webp,.heic', max_size_mb: CANDIDATURA_LIMITI.maxCvMb },
]

// ── Consensi (→ candidature_insegnanti.consents_log) ──────────────────────────
/**
 * I DUE blocchi di consenso della candidatura — e sono due, non quattro, per una
 * ragione che va rifatta qui e non copiata dall'iscrizione.
 *
 * ── QUAL È LA BASE GIURIDICA, E PERCHÉ NON È IL CONSENSO ─────────────────────
 *
 * Nel modulo d'iscrizione i dati sono di un MINORE e comprendono allergie e note
 * mediche: lì la base è l'interesse pubblico rilevante nell'istruzione (art. 9.2.g
 * + art. 2-sexies c. 2 lett. bb del Codice privacy), e il consenso sarebbe
 * addirittura dannoso perché non sarebbe libero.
 *
 * Qui la situazione è un'altra: i dati sono di una persona ADULTA che si propone
 * di sua iniziativa per un rapporto di lavoro. La base è l'**art. 6.1.b GDPR** —
 * *esecuzione di misure precontrattuali adottate su richiesta dell'interessato*.
 * Valutare una candidatura È la misura precontrattuale: chiedere il permesso di
 * fare la cosa che la persona ci ha appena chiesto di fare sarebbe una domanda
 * senza risposta possibile. Un «no» renderebbe il modulo inutile — cioè non
 * sarebbe un consenso libero, e un consenso non libero non vale nulla
 * (art. 7 §4 e cons. 43). Il Garante lo ha detto molte volte sul recruiting: per
 * i dati che il candidato invia spontaneamente, il consenso non è la base
 * corretta e chiederlo confonde chi legge.
 *
 * Quello che serve davvero, e che qui è OBBLIGATORIO, è **l'informativa al punto
 * di raccolta** (art. 13) e la prova che sia stata data. Da qui il primo blocco:
 * non è un consenso al trattamento, è una presa visione.
 *
 * ── L'UNICA COSA PER CUI IL CONSENSO SERVE DAVVERO ───────────────────────────
 *
 * Conservare la candidatura DOPO che la valutazione è finita. Finita la
 * selezione, la misura precontrattuale è esaurita e l'art. 6.1.b non copre più
 * niente: tenere il curriculum «per il futuro» è una finalità nuova, e per quella
 * il consenso è la base giusta — perché rifiutarlo non costa nulla a chi si
 * candida. È lo stesso ragionamento che nell'iscrizione vale per le fotografie, e
 * per lo stesso motivo: è libero solo un consenso che si può negare senza
 * conseguenze.
 *
 * Perciò il secondo blocco è FACOLTATIVO e REVOCABILE, e lo dice nel testo.
 * Chi non lo spunta viene valutato esattamente come gli altri: la sua candidatura
 * si cancella a valutazione conclusa.
 *
 * ── COSA MANCA ANCORA, detto qui invece che taciuto ──────────────────────────
 *
 * L'informativa pubblica (`src/app/privacy/page.tsx`) al 2026-08-10 non ha una
 * sezione per le candidature: dice cosa succede alle domande d'iscrizione non
 * accolte, non ai curriculum. Finché non ce l'ha, il link qui sotto porta a un
 * testo che non parla di chi lo sta leggendo. È fuori dal perimetro di questo
 * file — ma un consenso raccolto su un'informativa che non copre la finalità è
 * esattamente il difetto T06-F2 di questo repo, spostato di un modulo.
 */
export const CONSENSI_INSEGNANTI_FIELDS: FormField[] = [
  {
    id: 'presa_visione_informativa',
    type: 'consent',
    label: 'Ho letto l’informativa sulla privacy',
    required: true,
    text:
      'Dichiaro di aver preso visione dell’informativa sul trattamento dei dati personali. ' +
      'I dati di questo modulo sono trattati dalla Scuola per valutare la mia candidatura, ' +
      'cioè per dare seguito alla richiesta che sto facendo: per questa finalità non è ' +
      'richiesto il consenso, ed è per lo stesso motivo che non mi viene chiesto. ' +
      'Posso in ogni momento chiedere di accedere ai miei dati, correggerli o farli cancellare.',
    link: '/privacy',
    link_label: 'Leggi l’informativa completa',
  },
  {
    id: 'consenso_conservazione_candidatura',
    type: 'consent',
    label: 'Conservate la mia candidatura per future opportunità',
    required: false,
    // ⚠️ Il numero dei mesi è INTERPOLATO da `CANDIDATURA_LIMITI`, non ribattuto a
    // mano: questo è il termine PROMESSO all'interessata (art. 13 §2 lett. a) e
    // finisce archiviato in `consents_log`. Chi lo riscrivesse come letterale
    // rimetterebbe in piedi esattamente il difetto che `CANDIDATURA_LIMITI`
    // condanna — due costanti indipendenti per lo stesso limite divergono — con
    // l'aggravante che qui a divergere sarebbe il termine dichiarato da quello
    // applicato dal futuro cron di cancellazione.
    text:
      `Acconsento a che la Scuola conservi la mia candidatura per ${CANDIDATURA_LIMITI.mesiConservazione} mesi anche se la ` +
      'valutazione dovesse avere esito negativo, per potermi ricontattare quando si aprirà ' +
      'una posizione adatta. Il consenso è facoltativo e revocabile in qualsiasi momento: se ' +
      'non lo do, la mia candidatura viene valutata comunque e poi cancellata.',
  },
]

/**
 * Versione del TESTO dei consensi qui sopra. Cambia quando cambia il testo: è ciò
 * che viene archiviato in `consents_log` insieme alla risposta, così fra due anni
 * si sa a quale formulazione la persona aveva detto sì — e se quella formulazione
 * prometteva davvero 24 mesi.
 */
export const CONSENSI_INSEGNANTI_VERSIONE = '2026-08-10'
