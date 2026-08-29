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
 *
 * ── LO SCOPO DEI CAMPI È DICHIARATO (`autocomplete`) ─────────────────────────
 *
 * I sei campi che raccolgono i dati di chi compila portano `autocomplete`
 * (`given-name`, `family-name`, `email`, `tel`, `address-level2`,
 * `address-level1`): è WCAG 2.1 AA, SC 1.3.5 «Identify Input Purpose», e su un
 * modulo PUBBLICO che si compila dal telefono è la differenza fra sei campi
 * digitati e un tocco. Va dichiarato QUI e non in `FieldRenderer`: lo scopo di un
 * campo lo conosce chi lo definisce, e l'id di un modello costruito dal builder
 * può essere qualunque cosa. `enrollment-template.ts` non lo dichiara ancora, ed
 * è lo stesso debito visto dall'altro lato.
 *
 * ── ⚠️ DEBITO DICHIARATO: LE ETICHETTE QUI SOTTO SONO SOLO IN ITALIANO ───────
 *
 * Tutto ciò che si legge a schermo di questo template — le `label` dei campi,
 * `TITOLI_STUDIO` e `POSIZIONI_OPTIONS` (che il riepilogo di
 * `/lavora-con-noi` ristampa così come sono) e i testi dei consensi — è cablato
 * in italiano. Il guscio della pagina è bilingue per davvero (tutte le chiavi
 * `cand*` di `messages/{it,en}/public.json`, con lock di parità), quindi con
 * l'interfaccia in inglese la schermata esce TRADOTTA A METÀ: è il difetto R13,
 * quello che `PublicPageHeader` è nato per chiudere, ricomparso un livello più
 * sotto.
 *
 * ⚠️ QUI NON CI SONO PIÙ NUMERI, e la ragione è che questa frase li ha sbagliati
 * DUE VOLTE NELLO STESSO GIORNO. Diceva «36 chiavi `cand*`» quando erano 55; il
 * 2026-08-15 il numero è stato corretto in «55» — dentro un inciso che spiegava
 * che «un commento che conta cose mente entro un rilascio» — e nello stesso
 * lavoro le chiavi sono diventate 58. Nella stessa frase «i sette
 * `TITOLI_STUDIO`» era diventato falso appena sopra, con l'aggiunta della licenza
 * media. Un conteggio in un commento non si aggiorna: si toglie, e si lascia
 * contare a chi conta davvero — che qui è il lock di parità.
 *
 * Non è un difetto introdotto qui — è la forma di `enrollment-template.ts`, e
 * vale identico per `/iscrizione` — ma è scritto perché nessuno lo scambi per
 * fatto. Si chiude portando le etichette a chiavi di messaggio (e il testo dei
 * consensi con la sua `CONSENSI_INSEGNANTI_VERSIONE`, che è ciò che finisce
 * archiviato in `consents_log`: tradurlo significa versionarlo). Il giorno in cui
 * si fa, si fa per ENTRAMBI i template, altrimenti il difetto si sposta e basta.
 */

/** Sigla di provincia: due lettere. L'ESISTENZA la controlla `validateField`. */
const PROV_PATTERN = '^[A-Z]{2}$'

/**
 * Le fasce d'età della Scuola.
 *
 * ⚠️ DAL 2026-08-15 QUESTO ELENCO NON È PIÙ UNA DOMANDA DEL MODULO. Nessun campo
 * chiede più «per quali fasce ti proponi»: le fasce si DERIVANO dalle posizioni
 * (`gradiDallePosizioni`), perché l'elenco delle posizioni le contiene già
 * spezzate una per una — «Insegnante — Nido (0-3)», «Insegnante — Infanzia
 * (3-6)», «Insegnante — Primaria (6-11)». Chiederle due volte, una come mestiere
 * e una come fascia, era la stessa informazione raccolta in due schermate.
 *
 * Questa costante resta, e serve a tre cose che non sono sparite: è la SORGENTE
 * da cui si costruiscono le posizioni docenti qui sotto, è ciò che il cockpit di
 * segreteria usa per stampare le fasce di una candidatura, ed è ciò che
 * `admin/candidature-insegnanti:PATCH` filtra prima di scrivere `utenti.gradi`.
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
 * una persona che non ha nessuno a cui chiedere. Per questo `gradi` non arriva
 * più dal client affatto: la route lo COSTRUISCE dalle posizioni, che sono a loro
 * volta un elenco chiuso filtrato da uno `z.enum`. Chi aggiunge una fascia la
 * aggiunge qui E nell'enum E nel `CHECK` di `posizioni`, con una migrazione, e
 * rigenera `__tests__/fixtures/candidature-schema-snapshot.json`.
 */
export const GRADI_OPTIONS: FormFieldOption[] = [
  { label: 'Nido (0-3)', value: 'nido' },
  { label: 'Infanzia (3-6)', value: 'infanzia' },
  { label: 'Primaria (6-11)', value: 'primaria' },
]

/**
 * Il prefisso delle posizioni da INSEGNANTE. Sta in una costante perché lo
 * leggono in tre: la costruzione delle opzioni, la derivazione delle fasce e il
 * predicato che decide se una candidatura fa nascere un account docente.
 */
const PREFISSO_DOCENTE = 'insegnante_'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LE POSIZIONI — l'unica domanda su «che lavoro vieni a fare»             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Multi-valore, e almeno una: chi cerca lavoro in una scuola dell'infanzia si
 * propone spesso per più cose insieme («insegnante, ma anche in cucina»), e
 * costringerla a sceglierne una sola farebbe perdere alla segreteria proprio
 * l'informazione che le serve per smistarla.
 *
 * ── PERCHÉ LE FASCE SONO POSIZIONI, E NON UNA SECONDA DOMANDA ───────────────
 *
 * Fino al 2026-08-15 il modulo faceva due domande — «per quali fasce ti proponi»
 * (obbligatoria, tre caselle) e nient'altro — e dava per scontato il mestiere:
 * l'unica candidatura esprimibile era quella di un'insegnante. Con l'apertura a
 * collaboratrici, cuoche e segretarie quella domanda diventava di colpo
 * insensata per metà di chi compila: una cuoca non ha una fascia d'età, e un
 * campo obbligatorio che non la riguarda è un modulo che non si può inviare.
 *
 * La soluzione NON è stata rendere le fasce facoltative — sarebbero diventate
 * una casella che le insegnanti dimenticano di spuntare, e la segreteria
 * l'avrebbe scoperto leggendo una candidatura senza fascia. È stata fonderle:
 * l'elenco è uno solo, le tre voci docenti portano la fascia nel nome, e
 * `gradi` si DERIVA da ciò che è stato spuntato. Chi spunta «Insegnante —
 * Nido (0-3)» ha già detto tutte e due le cose, in un tocco invece che in due
 * schermate.
 *
 * ── LE TRE VOCI DOCENTI SI COSTRUISCONO, NON SI RIBATTONO ──────────────────
 *
 * Sono `GRADI_OPTIONS` con un prefisso: una fascia aggiunta domani diventa una
 * posizione da sola, con la sua etichetta già scritta, e `GRADO_DELLA_POSIZIONE`
 * la conosce senza che nessuno tocchi una riga. Ribattere «Insegnante — Nido
 * (0-3)» a mano avrebbe creato la seconda lista da mantenere — ed è esattamente
 * il modo in cui, in questo stesso repo, il riepilogo del wizard era rimasto
 * indietro di undici campi.
 *
 * ⚠️ IL `value` DI OGNI VOCE È UN VALORE IN TABELLA, e la tabella lo verifica:
 * `candidature_insegnanti.posizioni` è `text[]` con un `CHECK` di appartenenza
 * (migrazione `20260814225302_candidature_posizioni_cv`). Un valore aggiunto QUI e non
 * là prende `23514` dall'INSERT, cioè un 500 opaco davanti a chi si candida —
 * la stessa forma del `22P02` che l'enum delle fasce ha già insegnato. Per
 * questo `__tests__/lib/insegnanti-template.test.ts` legge il file della
 * migrazione e confronta le due liste: divergere non è una svista possibile, è
 * un test rosso.
 *
 * ⚠️ E NON È UN `enum` POSTGRES, di proposito: un enum obbliga a una migrazione
 * con `alter type` per ogni voce nuova (e in Postgres, fino alla 12, nemmeno
 * dentro una transazione), mentre qui l'elenco è di prodotto e cambierà più
 * spesso dello schema. Il `CHECK` dà la stessa garanzia con un `alter table`.
 */
export const POSIZIONI_OPTIONS: FormFieldOption[] = [
  ...GRADI_OPTIONS.map((g) => ({
    label: `Insegnante — ${g.label}`,
    value: `${PREFISSO_DOCENTE}${g.value}`,
  })),
  { label: 'Collaboratrice scolastica', value: 'collaboratrice' },
  { label: 'Cuoca / aiuto cucina', value: 'cuoca' },
  { label: 'Segreteria / amministrazione', value: 'segreteria' },
  // Ultima, e con la parola «specifica» nell'etichetta: la casella accanto
  // (`posizione_altro`) diventa obbligatoria appena questa viene spuntata, e
  // l'etichetta è l'unico posto in cui dirlo PRIMA che l'errore compaia.
  { label: 'Altro (specifica qui sotto)', value: 'altro' },
]

/** I soli `value`, per gli `z.enum` e i `CHECK`. */
export const POSIZIONI_AMMESSE: string[] = POSIZIONI_OPTIONS.map((o) => String(o.value))

/**
 * LE POSIZIONI COME LE LEGGE UNA PERSONA — e per «altro», ciò che ha scritto lei.
 *
 * ─── PERCHÉ NON BASTA LA `label` ────────────────────────────────────────────
 * L'etichetta di `altro` è «Altro (specifica qui sotto)», ed è un'ISTRUZIONE A
 * CHI COMPILA, non un mestiere: ha senso accanto a una casella, non dentro una
 * email. Chi si candidava come psicomotricista riceveva la conferma con
 * «Ruolo: Altro (specifica qui sotto)» — la propria professione sostituita da un
 * comando rivolto a un modulo che non stava più guardando — e
 * `posizione_altro`, cioè quello che aveva davvero scritto, non compariva.
 *
 * ─── PERCHÉ STA QUI E NON NELLA ROTTA ───────────────────────────────────────
 * Perché `POSIZIONI_OPTIONS` sta qui, e una regola che traduce quei valori
 * scritta altrove diverge il giorno in cui l'elenco cambia. La rotta la chiama;
 * chiunque debba mostrare le posizioni a una persona la chiama.
 *
 * Ripiego su «Altro» pulito quando il campo libero è vuoto — mai
 * sull'istruzione — e sul valore GREZZO quando non è fra le opzioni: un valore
 * uscito dall'elenco dopo l'invio è un dato che va comunque mostrato, e tacerlo
 * sarebbe peggio che mostrarlo brutto.
 */
export function etichettePosizioni(posizioni: string[], posizioneAltro?: string | null): string | null {
  if (posizioni.length === 0) return null
  const scritto = typeof posizioneAltro === 'string' ? posizioneAltro.trim() : ''
  return posizioni
    .map((v) => {
      if (v === 'altro') return scritto !== '' ? scritto : 'Altro'
      return POSIZIONI_OPTIONS.find((o) => String(o.value) === v)?.label ?? v
    })
    .join(', ')
}

/**
 * Da posizione a fascia d'età — la mappa che sostituisce una domanda.
 *
 * Costruita dalle stesse `GRADI_OPTIONS` che generano le voci docenti: le due
 * cose non possono divergere perché sono la stessa iterazione.
 */
export const GRADO_DELLA_POSIZIONE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    GRADI_OPTIONS.map((g) => [`${PREFISSO_DOCENTE}${g.value}`, String(g.value)]),
  ),
)

/**
 * Le fasce d'età che discendono dalle posizioni scelte — in ordine di
 * `GRADI_OPTIONS` e senza doppioni.
 *
 * ⚠️ RITORNA UN ARRAY VUOTO PER UNA CANDIDATURA NON DOCENTE, ed è il
 * comportamento voluto, non un caso limite dimenticato: una cuoca non ha una
 * fascia d'età. La colonna `gradi` è `not null default '{}'` e il suo `CHECK`
 * (`array_length(gradi, 1) >= 1`) su un array vuoto vale NULL, e un CHECK che
 * vale NULL PASSA — misurato in produzione il 2026-08-10. Fino a quel giorno
 * quella era una CREPA (una candidatura senza fasce entrava in silenzio e la
 * segreteria non sapeva a chi smistarla); da oggi è la porta attraverso cui
 * passa una cuoca, e la crepa è chiusa dall'altra parte — da `posizioni`, che ha
 * un `CHECK` su `cardinality()` e non su `array_length()`, cioè uno che su un
 * array vuoto vale FALSO invece che NULL.
 *
 * L'ordine è quello di `GRADI_OPTIONS` e non quello in cui si è spuntato: due
 * candidature identiche devono produrre lo stesso array, altrimenti `utenti.gradi`
 * dipende dall'ordine dei clic.
 */
export function gradiDallePosizioni(posizioni: unknown): string[] {
  const scelte = new Set(elencoPosizioni(posizioni))
  return GRADI_OPTIONS.map((g) => String(g.value)).filter((grado) =>
    scelte.has(`${PREFISSO_DOCENTE}${grado}`),
  )
}

/**
 * Le posizioni come elenco di stringhe, da un valore di cui non si sa niente.
 *
 * ⚠️ Il parametro è `unknown` e NON `string[]`, e non è pigrizia di tipi: il
 * chiamante che conta è il cockpit di Segreteria, dove questo valore arriva
 * GREZZO da PostgREST — che restituisce un array Postgres come JSON e, su un
 * database senza quella colonna, non lo restituisce affatto. Un tipo che
 * promettesse `string[]` sarebbe una promessa fatta dal linguaggio a nome di un
 * database, cioè la forma di bugia che in questo repo ha già fatto firmare
 * documenti sbagliati.
 *
 * Tutto ciò che non è un array vale ELENCO VUOTO, e da lì
 * `comprendeInsegnamento` risponde «no»: sulla domanda «va creato un account che
 * legge l'anagrafica dei bambini?», «non lo so» deve valere «no».
 */
function elencoPosizioni(posizioni: unknown): string[] {
  return Array.isArray(posizioni) ? posizioni.map((p) => String(p)) : []
}

/**
 * La candidatura comprende almeno una posizione da insegnante?
 *
 * È il predicato da cui dipende l'unica conseguenza pesante di questo modulo:
 * `admin/candidature-insegnanti:PATCH` crea un account `educator` — che legge
 * l'anagrafica dei bambini — SOLO quando questo risponde `true`. Vive qui, e non
 * in quella route, perché la regola è del MODULO: è l'elenco delle posizioni a
 * dire quali sono docenti, e un secondo elenco dentro la route sarebbe quello
 * che un giorno resta indietro di una voce — con la differenza che il verso
 * dell'errore, lì, è un accesso concesso a chi non doveva averlo.
 *
 * Si guarda il PREFISSO e non un elenco di tre stringhe: una quarta fascia
 * aggiunta a `GRADI_OPTIONS` diventa docente da sola.
 */
export function comprendeInsegnamento(posizioni: unknown): boolean {
  return elencoPosizioni(posizioni).some((p) => p.startsWith(PREFISSO_DOCENTE))
}

/**
 * Titolo di studio: elenco chiuso, il dettaglio libero sta nel campo accanto.
 *
 * ⚠️ «Licenza media» è stata aggiunta il 2026-08-15, ed è una conseguenza diretta
 * dell'apertura del modulo alle posizioni non docenti. L'elenco cominciava dal
 * diploma di scuola superiore perché l'unica candidatura possibile era quella di
 * un'insegnante, per cui il diploma è il minimo di legge; per una collaboratrice
 * scolastica o per chi lavora in cucina non lo è, e il campo è OBBLIGATORIO.
 * Senza questa voce l'unica risposta vera sarebbe stata «Altro titolo», cioè
 * chiedere a una persona di dichiarare il proprio titolo come un'eccezione.
 *
 * La colonna `titolo_studio` è `text` senza vincoli (misurato in produzione il
 * 2026-08-15): aggiungere una voce non richiede nessuna migrazione, e i valori
 * già archiviati non cambiano.
 */
export const TITOLI_STUDIO: FormFieldOption[] = [
  { label: 'Licenza media', value: 'licenza_media' },
  { label: 'Diploma di scuola superiore', value: 'diploma' },
  { label: 'Diploma magistrale / Liceo socio-psico-pedagogico', value: 'magistrale' },
  { label: 'Laurea triennale', value: 'laurea_triennale' },
  { label: 'Laurea magistrale', value: 'laurea_magistrale' },
  { label: 'Laurea in Scienze della Formazione Primaria', value: 'formazione_primaria' },
  { label: 'Master o specializzazione post-laurea', value: 'master' },
  { label: 'Altro titolo', value: 'altro' },
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
  /**
   * Caratteri della posizione scritta a mano (la casella accanto ad «Altro»).
   *
   * Cento, e non mille: qui non ci si racconta — per quello c'è la
   * presentazione libera qui sopra — si nomina un mestiere. «Psicomotricista»
   * ne misura 15, «tirocinio curricolare in scienze della formazione» 44. Il
   * numero è ANCHE il `CHECK` della colonna
   * (`length(posizione_altro) <= 100`): due tetti indipendenti per lo stesso
   * campo divergono, e a divergere sarebbe il confine fra un rifiuto sotto il
   * campo e un `23514` che diventa un 500 opaco.
   */
  maxPosizioneAltro: 100,
  /** Mesi di conservazione della candidatura NON accolta, se acconsentito. */
  mesiConservazione: 24,
} as const

// ── Campi della CANDIDATURA (→ candidature_insegnanti) ────────────────────────
export const INSEGNANTE_FIELDS: FormField[] = [
  { id: 'nome', type: 'text', label: 'Nome', required: true, autocomplete: 'given-name', db_mapping: 'candidature_insegnanti.nome', placeholder: 'Es. Maria', validation: { min_length: 2, max_length: 50 } },
  { id: 'cognome', type: 'text', label: 'Cognome', required: true, autocomplete: 'family-name', db_mapping: 'candidature_insegnanti.cognome', placeholder: 'Es. Rossi', validation: { min_length: 2, max_length: 50 } },
  { id: 'email', type: 'email', label: 'Email', required: true, autocomplete: 'email', db_mapping: 'candidature_insegnanti.email', placeholder: 'Es. mario.rossi@email.com', validation: { max_length: 200 } },
  { id: 'telefono', type: 'phone', label: 'Numero di telefono', required: false, autocomplete: 'tel', db_mapping: 'candidature_insegnanti.telefono', placeholder: 'Es. +39 333 1234567', validation: { max_length: 30 } },

  // Residenza: FACOLTATIVA. Serve a capire se la sede è raggiungibile, non a
  // decidere; pretenderla vorrebbe dire respingere una candidatura per un dato
  // che non c'entra con il lavoro.
  { id: 'residence_city', type: 'text', label: 'Comune di residenza', required: false, autocomplete: 'address-level2', db_mapping: 'candidature_insegnanti.residence_city', placeholder: 'Es. Giugliano in Campania', validation: { max_length: 100 } },
  // ⚠️ L'id FINISCE per `_province` di proposito: `isProvinceField` guarda quel
  // suffisso, e da lì arrivano gratis l'auto-maiuscolo, lo snap su blur
  // («Napoli» → «NA») e il controllo che la sigla ESISTA davvero. Chiamarlo
  // `provincia_residenza` avrebbe spento tutte e tre le cose senza un rosso.
  { id: 'residence_province', type: 'text', label: 'Provincia di residenza', required: false, autocomplete: 'address-level1', db_mapping: 'candidature_insegnanti.residence_province', placeholder: 'Es. NA', validation: { pattern: PROV_PATTERN, min_length: 2, max_length: 2 } },

  // ── LE POSIZIONI, prima domanda del profilo ────────────────────────────────
  //
  // Sta PRIMA del titolo di studio, e l'ordine è la domanda che viene prima
  // nella testa di chi compila: «che lavoro vengo a fare» precede «che titolo
  // ho». È anche l'ordine che rende leggibile il campo qui sotto — «Altro» non
  // si capisce se non si è appena letto di che elenco fa parte.
  //
  // `type: 'checkbox'` è GIÀ multi-valore: `FieldRenderer` lo rende con un
  // `Controller` il cui valore è un array di `value` (default `[]`), e
  // `validateField` — tramite `eVuoto()` — considera vuota una checkbox il cui
  // valore non è un array o è un array vuoto. Quindi `required: true` significa
  // già «almeno una posizione», sul client e sul server, con la STESSA funzione.
  //
  // ⚠️ E QUI IL DATABASE È D'ACCORDO, a differenza di quanto accadeva con
  // `gradi`. Il `CHECK` della colonna è `cardinality(posizioni) >= 1`, non
  // `array_length(posizioni, 1) >= 1`: su un array vuoto `array_length` vale
  // NULL e un CHECK che vale NULL PASSA (misurato in produzione il 2026-08-10),
  // mentre `cardinality('{}')` vale `0` e il CHECK FALLISCE. È la stessa regola
  // scritta due volte, ma stavolta le due scritture coincidono davvero: il
  // modulo tiene e la tabella pure.
  //
  // Resta comunque alla route una difesa che il template non può dare: FILTRARE
  // i valori ricevuti contro `POSIZIONI_AMMESSE` prima di scrivere.
  // `validateField` sulla checkbox controlla solo il VUOTO, non l'appartenenza
  // (il ramo «Selezione non valida» di `validate-fields.ts` è scritto per
  // `select` e `radio`), e un valore fuori elenco arriverebbe all'INSERT e
  // prenderebbe `23514`: su un modulo pubblico, un 500 opaco. Lo fa lo `z.enum`
  // di `POSIZIONI_AMMESSE` in `iscrizione/insegnanti:POST`.
  { id: 'posizioni', type: 'checkbox', label: 'Per quali posizioni ti proponi', required: true, db_mapping: 'candidature_insegnanti.posizioni', options: POSIZIONI_OPTIONS },

  // ── «ALTRO», e la casella che compare solo quando serve ────────────────────
  //
  // `condition` è il motore di `@/lib/forms/conditional.ts`, che esiste da
  // DL-024 e che fino a oggi in questo template non era mai stato usato:
  // `operator: 'contains'` su un valore che è un ARRAY confronta elemento per
  // elemento (`valutaCondizione`, ramo `contains`), quindi la casella compare
  // esattamente quando «Altro» è spuntato.
  //
  // ⚠️ `required: true` NON vuol dire «obbligatorio sempre»: vuol dire
  // «obbligatorio quando è visibile». Chi valida deve perciò passare i campi
  // VISIBILI e non l'intero template — sul client E SUL SERVER. È la riga di
  // `validatePage` che diceva «sul server si passa il template completo»: valeva
  // finché nessun campo aveva una condizione, e da oggi non vale più. Senza quel
  // filtro, `iscrizione/insegnanti:POST` rifiuterebbe con «Campo obbligatorio»
  // OGNI candidatura che non ha spuntato «Altro» — cioè quasi tutte.
  { id: 'posizione_altro', type: 'text', label: 'Quale posizione', required: true, condition: { field_id: 'posizioni', operator: 'contains', value: 'altro' }, db_mapping: 'candidature_insegnanti.posizione_altro', placeholder: 'Es. psicomotricista', validation: { min_length: 2, max_length: CANDIDATURA_LIMITI.maxPosizioneAltro } },

  { id: 'titolo_studio', type: 'select', label: 'Titolo di studio', required: true, db_mapping: 'candidature_insegnanti.titolo_studio', options: TITOLI_STUDIO },
  { id: 'titolo_dettaglio', type: 'text', label: 'Dettaglio del titolo (indirizzo, istituto)', required: false, db_mapping: 'candidature_insegnanti.titolo_dettaglio', placeholder: 'Es. Scienze dell’educazione', validation: { max_length: 200 } },
  // 0-60 sono gli stessi estremi del CHECK in tabella
  // (`candidature_insegnanti_anni_esperienza_check`, letto in produzione):
  // qui il rifiuto arriva sotto il campo, lì è l'ultima rete.
  { id: 'anni_esperienza', type: 'number', label: 'Anni di esperienza', required: false, db_mapping: 'candidature_insegnanti.anni_esperienza', placeholder: 'Es. 3', validation: { min: 0, max: 60 } },

  // ── ⚠️ QUI C'ERA IL CAMPO `gradi`, E NON È STATO RESO FACOLTATIVO: È SPARITO ─
  //
  // Chiedeva «Per quali fasce ti proponi» con tre caselle obbligatorie, e dava
  // per scontato che chi compila sia un'insegnante. Dal 2026-08-15 non lo è più:
  // il modulo accoglie anche collaboratrici, cuoche, segretarie e un «Altro»
  // scritto a mano. Per tutte quelle una fascia d'età non esiste, e un campo
  // obbligatorio che non le riguarda è un modulo che non si può inviare.
  //
  // Renderlo `required: false` sarebbe stato il rimedio sbagliato: sarebbe
  // diventato la casella che le insegnanti dimenticano di spuntare, e la
  // segreteria l'avrebbe scoperto aprendo una candidatura senza fascia — cioè lo
  // stesso difetto di prima, spostato dal modulo alla scrivania. La fascia è
  // stata FUSA nella posizione: «Insegnante — Nido (0-3)» dice tutte e due le
  // cose insieme, e `gradiDallePosizioni()` la ricava.
  //
  // LA COLONNA `gradi` RESTA, e resta popolata: è ciò che
  // `admin/candidature-insegnanti:PATCH` travasa in `utenti.gradi` quando
  // approva. Cambia CHI la scrive — non più il client, che potrebbe dichiarare
  // qualunque cosa, ma la route, che la deriva dalle posizioni già filtrate.
  // Cioè: il valore non arriva più da fuori affatto, e il `22P02` dell'enum
  // diventa inesprimibile invece che difeso.

  // ── LA DISPONIBILITÀ NON SI CHIEDE PIÙ, E LA COLONNA RESTA ─────────────────
  //
  // Fino al 2026-08-24 qui c'era una select — tempo pieno, part-time mattina,
  // part-time pomeriggio, supplenze, tirocinio — e serviva alla segreteria per
  // smistare. È uscita perché in Kidville si lavora solo a tempo pieno: delle
  // sue voci una sola era accettabile, e le altre promettevano un impegno che
  // non esiste. Chiedere una cosa già decisa la fa sembrare trattabile. È una
  // rimozione SECCA, decisa dal titolare: al suo posto non va nessuna riga
  // informativa, perché una nota che spiega un campo assente è il campo.
  //
  // LA COLONNA `candidature_insegnanti.disponibilita` RESTA, e resta `nullable`:
  // le candidature arrivate prima ci hanno scritto un valore vero, e la scheda
  // di segreteria continua a leggerlo di lì. Le etichette che lo traducono non
  // vivono più qui: le risolve `CHIAVE_DISPONIBILITA` (`CandidatureInsegnanti.tsx`)
  // sui cataloghi `messages/{it,en}/adminAltro.json`, ed è quella mappa — non più
  // questo file — la fonte del lock che le sorveglia. Da oggi ogni candidatura
  // nuova nasce con quel valore NULL, e nella scheda la riga sparisce da sé.

  { id: 'note', type: 'textarea', label: 'Presentati in poche righe', required: false, db_mapping: 'candidature_insegnanti.note', placeholder: 'Raccontaci il tuo percorso e perché ti piacerebbe lavorare con noi', validation: { max_length: CANDIDATURA_LIMITI.maxPresentazione } },

  // ── IL CV, e la difesa che tocca alla route (misurata, non dedotta) ─────────
  //
  // ⚠️ IL CURRICULUM È OBBLIGATORIO DAL 2026-08-24, ED È UNA DECISIONE, NON UN
  // ASSESTAMENTO. Fino a quel giorno queste righe argomentavano il CONTRARIO —
  // «chi si candida dal telefono spesso il curriculum non ce l'ha sottomano, e
  // un allegato obbligatorio farebbe abbandonare il modulo a chi i campi li ha
  // già compilati tutti» — ed è il tipo di commento più caro che esista: fra sei
  // mesi qualcuno lo rilegge, lo trova ragionevole e rimette `required: false`
  // «perché c'era una ragione». La ragione c'era davvero. È stata pesata contro
  // un'altra e ha perso.
  //
  // Decisione del titolare: una candidatura senza curriculum non è una
  // candidatura. La segreteria non ha niente da valutare, deve scrivere per
  // chiederlo, e nel frattempo la persona resta in una coda che nessuno muove.
  //
  // ⚠️ IL PREZZO, MISURATO PRIMA DI DECIDERE — ÀNCORA `MISURA-CV`.
  //
  // QUESTO È L'UNICO POSTO DEL PERIMETRO CANDIDATURE CHE PORTA LA CIFRA. Ogni
  // altro commento che ne aveva bisogno NOMINA questa àncora invece di
  // ribattere il numero, e il lock
  // `__tests__/architecture/misura-cv-un-posto-solo.test.ts` lo impone: una
  // percentuale scritta in un file del perimetro fa cadere il gate. Non è
  // pignoleria — è la cronaca di queste righe, raccontata qui sotto.
  //
  // Misurato in produzione il **2026-08-25 alle 19:26** (ora di Roma):
  // **100 candidature senza curriculum su 248**. Non è una stima ed è la parte
  // che conta: sono esattamente le persone che d'ora in poi NON potranno
  // inviare il modulo.
  //
  // ⚠️ QUI C'ERA SCRITTO CHE «LA PERCENTUALE È LA SOLA COSA STABILE». È FALSO, e
  // la stessa giornata l'ha smentito due volte, in due versi opposti:
  //   · alle 12:08 erano **98 su 237** — l'assoluto FERMO, la percentuale scesa
  //     dal 41,9% al 41,4%, perché nel frattempo arrivavano candidature CON il
  //     curriculum;
  //   · alle 19:26 sono **100 su 248** — si è mosso anche l'ASSOLUTO.
  // Finché il modulo vecchio è in produzione non esiste nessuna cifra stabile.
  // La sola differenza vera è che DOPO il rilascio l'assoluto si ferma — a
  // quell'insieme nessuno può più aggiungersi — mentre la percentuale continua
  // a scendere da sola, avendo al denominatore un totale che cresce. Chi vorrà
  // misurare l'effetto dell'obbligo guardi **l'assoluto e il totale**, mai la
  // percentuale; e **rifaccia il conto invece di fidarsi di questa riga**, che a
  // quel punto avrà mesi. È una query sola:
  //     select count(*) filter (where cv_path is null), count(*)
  //     from candidature_insegnanti;
  //
  // ⚠️ LA CONTRO-OBIEZIONE RESTA VERA, e per questo la nota sotto il campo NON è
  // stata tolta: continua a dire che va bene anche una FOTOGRAFIA del curriculum
  // (`candCvNota`, `messages/{it,en}/public.json`). È ciò che tiene aperta la
  // porta a chi compila dal telefono e non ha un PDF sottomano — cioè l'unica
  // risposta che questo campo dà al rischio di abbandono che il commento
  // precedente denunciava. Toglierla per «snellire» rimetterebbe in piedi il
  // difetto senza rimettere il campo facoltativo: il peggiore dei due mondi.
  //
  // ⚠️ NEL DATABASE `cv_path` RESTA `nullable`, e non è una svista: le righe
  // storiche che ce l'hanno NULL sono quattro su dieci (la cifra, con la sua ora
  // e la sua query, sta nell'àncora `MISURA-CV` qui sopra — qui non si ribatte),
  // quindi un `NOT NULL` non si applicherebbe nemmeno.
  //
  // ⚠️ QUI C'ERA UN NUMERO, ed era SBAGLIATO: «95 righe storiche», copiato dal
  // piano del giorno prima e sopravvissuto alla rimisurazione del 25/08 che aveva
  // aggiornato il paragrafo qui sopra. Era una cifra già etichettata come SUPERATA
  // poche righe più su, e ripetuta qui come stato di oggi, senza data. È
  // esattamente la trappola che l'àncora `MISURA-CV` esiste per denunciare,
  // ripetuta dentro la prosa che la denuncia — ed è il motivo per cui quella cifra
  // ora ha UN POSTO SOLO, e un lock che lo difende.
  //
  // ⚠️ E LE DISTANZE IN RIGHE ERANO A LORO VOLTA SBAGLIATE (rilevato al giro 3, e il
  // collaudatore aveva ragione: contate, non misurate). Qui c'era scritto «sedici
  // righe più in alto» dove ce n'erano 23, «venti righe più su» dove ce n'erano 23,
  // e «queste venticinque righe» per un blocco che ne copre oltre quaranta. Un
  // numero di righe scritto in prosa è falso al primo commento inserito sopra: è la
  // stessa specie di cifra che questo blocco denuncia, applicata a sé stesso. La
  // regola giusta era già scritta nella route gemella
  // (`iscrizione/insegnanti/route.ts`, blocco `ESITO_MAX`): «si trova cercando la
  // costante, non contando le righe — anche una distanza è un numero che invecchia».
  // Ora i riferimenti sono ÀNCORE CERCABILI, e restano vere comunque si muova il file.
  // Tolto invece che aggiornato: l'argomento regge senza, e un intero non datato
  // sopra un insieme che cresce di sei righe al giorno tornerebbe falso domani.
  // L'obbligatorietà è APPLICATIVA e vive in tre punti che leggono tutti da qui:
  // il `required` di questa riga, le `rules` del `Controller` in `FieldRenderer`
  // e `validatePage(campiVisibili(...))` nella route. Nessuno dei tre è una
  // seconda regola: sono lo stesso `validateField` chiamato da tre parti.
  //
  // ⚠️ E `cv_path` NON DEVE MAI PRENDERE UNA `condition`: uscirebbe dal filtro di
  // `campiVisibili` e l'obbligo sul server sparirebbe in silenzio, con i test
  // verdi.
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
  // ⚠️ L'etichetta è «Curriculum» e basta, SENZA «(obbligatorio)»: l'asterisco lo
  // stampa `FieldRenderer` da sé leggendo `required`, e «Curriculum
  // (obbligatorio) *» sarebbe lo stesso segnale detto due volte.
  //
  // ⚠️ `link: '/privacy'` NON È UN ORNAMENTO, ed è arrivato con l'obbligo. Questo
  // allegato parte nell'istante in cui si sceglie il file — `FileField` chiama la
  // rotta di caricamento dentro `onChange` — cioè DUE PASSI prima della schermata
  // dei consensi, che fino al 25/08 era l'unico punto del modulo da cui
  // l'informativa fosse raggiungibile. Finché il campo era facoltativo una strada
  // c'era (saltare l'allegato, leggere, tornare indietro) e la percorrevano
  // quattro su dieci (la cifra, con la sua ora, sta nell'àncora `MISURA-CV`).
  // Da quando è obbligatorio quella strada non esiste più, e l'art. 13 parla del
  // momento in cui i dati sono OTTENUTI: per un allegato è il caricamento.
  // ⚠️ NIENTE `link_label`, E L'ETICHETTA È COMUNQUE QUELLA DELLE ALTRE
  // (25/08/2026, seconda correzione in giornata — vale la pena raccontarla per
  // intero, perché la strada giusta era la terza e nessuna delle prime due lo era).
  //   · Al mattino `link_label` non c'era: `FieldRenderer` ripiegava su
  //     `t('leggiInformativa')`, cioè «Leggi l'informativa» / «Read the policy».
  //     Tradotto, ma generico — e in inglese chiede «quale policy?», in un punto
  //     dove la parola «informativa» non compare da nessun'altra parte del passo:
  //     sui consensi il collegamento è preceduto da «Ho letto l'informativa sulla
  //     privacy», qui è nudo.
  //   · A mezzogiorno si è cablato «Leggi l'informativa completa» qui dentro, per
  //     allinearlo alle altre dichiarazioni. Chiarezza comprata pagando la lingua:
  //     MISURATO sulla pagina viva con `KV_LOCALE=en`, sotto una nota inglese
  //     compariva una riga italiana.
  //   · La terza strada — quella presa — costava le stesse due righe delle altre
  //     due: una CHIAVE nei due cataloghi. `leggiInformativaCompleta` è ora il
  //     ripiego del collegamento di CAMPO in `FieldRenderer`, quindi qui non serve
  //     dichiarare niente e l'etichetta è insieme la stessa delle altre E tradotta.
  //     ⚠️ LA CHIAVE E NON LA FRASE: la versione delle 12:22 di questo commento
  //     ricopiava il valore italiano, e il valore è cambiato nel pomeriggio dello
  //     stesso giorno («…sulla privacy», perché al passo 3 quella parola non
  //     compare da nessun'altra parte). Il commento è invecchiato prima di sera:
  //     è la stessa trappola che il resto di questo file denuncia sulle CIFRE.
  //     È la stessa mossa fatta poche ore prima per `attendiCaricamento` e
  //     `caricamentoAllegato`, in questo stesso lavoro: era già lì da copiare.
  //
  // ⚠️ E LE ALTRE SONO TRE, NON QUATTRO. La versione di mezzogiorno di questo
  // commento diceva «le altre QUATTRO dichiarazioni» e poi ne nominava tre, con un
  // numero di riga già invecchiato (708 invece di 720). Misurato con
  // `grep -rn "link: '/privacy'" src`, esito catturato prima di qualunque pipe:
  // TRE — `enrollment-template.ts`, `personale-template.ts` e il consenso in fondo
  // a questo file — più questa, che quattro le fa in tutto. È lo stesso difetto che
  // questo repo insegue da settimane: un conteggio ribattuto a mano invecchia entro
  // il commit che lo scrive. Chi ha bisogno del numero lo rifaccia con il grep,
  // che è una riga.
  { id: 'cv_path', type: 'file', label: 'Curriculum', required: true, db_mapping: 'candidature_insegnanti.cv_path', accept: '.pdf,.jpg,.jpeg,.png,.webp,.heic', max_size_mb: CANDIDATURA_LIMITI.maxCvMb, link: '/privacy' },
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
 * ⚠️ QUESTA NOTA ERA SCADUTA E DICEVA IL FALSO AL CONTRARIO, corretta il
 * 25/08/2026. Sosteneva che «l'informativa pubblica (`src/app/privacy/page.tsx`)
 * al 2026-08-10 non ha una sezione per le candidature» e che quindi «il link qui
 * sotto porta a un testo che non parla di chi lo sta leggendo». La sezione
 * ESISTE, ed esiste dal 2026-08-10 stesso: `src/app/privacy/page.tsx` dichiara i
 * dodici mesi (ventiquattro col consenso alla conservazione), la cancellazione del
 * curriculum insieme alla candidatura e la copia recapitata alla casella di
 * ciascuna sede scelta — con un lock che la difende. Una nota di debito che
 * descrive un buco GDPR ormai chiuso costa quanto una che ne nasconde uno aperto:
 * chi la legge va a cercare un guasto che non c'è, o peggio, si fida del suo
 * essere «già noto» e non ricontrolla.
 *
 * ⚠️ L'ART. 13 §2 LETT. e È STATO CHIUSO IL 2026-08-25, e questo paragrafo lo dice
 * perché fino a quel giorno diceva il contrario. Dal 24/08 il curriculum è
 * necessario, quindi l'informativa doveva dichiarare la necessità e le conseguenze
 * del rifiuto: la sezione «Natura del conferimento» di `src/app/privacy/page.tsx`
 * ora ha la sua voce per «Lavora con noi», e `VERSIONE_PRIVACY` è salita a
 * '2026-08-25' con la nuova impronta in `pagine-legali.test.ts`.
 *
 * ⚠️ E QUESTO DEBITO NON DOVEVA VIVERE QUI. Era stato scritto dentro un commento di
 * codice invece che nel PRD, cioè nel file che si riapre solo quando lo si tocca
 * invece che nel documento che sopravvive al codice: due collaudatori indipendenti
 * l'hanno rilevato, e avevano ragione. Un elenco di cose da fare in un commento non
 * è tracciato, è dimenticato con una nota. La regola sta in AGENTS.md e vale anche
 * per i debiti, non solo per le funzionalità.
 *
 * ⚠️ I DUE COMMENTI CHE DICEVANO «e SPESSO il curriculum» SONO GIÀ CORRETTI, ed è
 * il motivo per cui non sono più elencati qui. Il 2026-08-25 questa nota ne
 * nominava UNO (`src/app/privacy/page.tsx`) e ce n'erano DUE: il gemello stava in
 * `src/app/api/gdpr/retention-candidature/route.ts`, e chi fosse venuto a chiudere
 * il debito fidandosi dell'elenco ne avrebbe corretto uno solo. L'elenco era stato
 * scritto a memoria dentro il paragrafo che esiste proprio per impedire a un testo
 * di invecchiare — la stessa trappola che il resto di questo file denuncia. Il
 * rimedio non è stato allungare l'elenco (`grep -rn "spesso il curriculum" src`
 * l'avrebbe derivato, ma sarebbe di nuovo invecchiato): è stato correggere le due
 * frasi, così l'elenco non serve più.
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
