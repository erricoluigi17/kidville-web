import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertUtenteInScope } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseData, parseMultipart, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rateLimit } from '@/lib/security/rate-limit'
import { LIMITE_UPLOAD_BYTE, LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'
import { rispostaAllegatoNonCaricato } from '@/lib/allegati/risposte'
import {
  estensioneArchiviata,
  rispostaTroppiCaricamenti,
  verificaAllegatoPubblico,
} from '@/lib/upload/allegati-pubblici'
import {
  BUCKET_DOCUMENTI_PERSONALE,
  TABELLA_CARICAMENTI,
  registraCaricamento,
} from '@/lib/personale/caricamenti'
import { DOC_PREFISSO } from '@/lib/personale/percorso-documento'
import { bloccanti, rimuoviEVerifica } from '@/lib/storage/rimozione-verificata'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  POST /api/admin/anagrafica-personale/scansione                          ║
 * ║  — la porta che il commento della rotta gemella prometteva               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `admin/anagrafica-personale:PATCH` tiene `documento_fronte_path` e
 * `documento_retro_path` FUORI dalla whitelist della correzione allo sportello, e
 * lo motiva così (route.ts:169-178): «il percorso è la chiave con cui `?doc=`
 * firma un oggetto del bucket: chi potesse scriverlo a mano potrebbe puntare
 * l'anagrafica di una collega a un file qualunque e poi chiederne la firma
 * passando dal gate — che verificherebbe la SEDE, e la troverebbe giusta. **La
 * scansione si sostituisce caricandone una nuova, che è un'altra porta e ha il suo
 * gate.**»
 *
 * Questa è quell'altra porta. Non è una breccia nel perimetro: il percorso continua
 * a non arrivare MAI dal client — lo genera il server, dopo aver ricevuto i byte —
 * e resta impossibile far puntare un fascicolo a un oggetto scelto da chi bussa.
 *
 * ── PERCHÉ ESISTE, MISURATO E NON DEDOTTO (2026-08-12, database di produzione) ─
 *
 *     select count(*) from anagrafica_personale;                    → 0
 *     select count(*) from utenti where ruolo = 'educator';         → 12
 *     select count(*) from utenti where ruolo <> 'genitore';        → 20
 *
 * Zero fascicoli e venti persone in servizio. Senza questa porta l'unico modo di
 * popolare l'archivio è chiedere a ognuna di compilare il modulo pubblico e
 * aspettare che lo faccia: la Segreteria che ha già la fotocopia del documento in
 * mano non ha nessun posto in cui metterla.
 *
 * ── LA SEGRETERIA È DENTRO, E NON PER GENEROSITÀ ────────────────────────────
 *
 * Il gate è `requireStaff(request)` con i ruoli di default — `admin`,
 * `coordinator` **e `segreteria`** — non `['admin','coordinator']`. La ragione è
 * già scritta nella testata della rotta gemella: la segreteria «è chi sta al banco
 * quando la persona arriva con il documento in mano. Un cruscotto che la esclude
 * costringe a scrivere il dato su un foglio e a farlo inserire da qualcun altro il
 * giorno dopo». In produzione i tre account `segreteria` sono, per giunta, quelli
 * che questo gesto lo faranno davvero.
 *
 * ── ⚠️ GLI IDENTIFICATIVI STANNO IN QUERY, NON NEL MULTIPART ────────────────
 *
 * `?utenteId=<uuid>&lato=fronte|retro`, e il corpo porta il solo `file`. Non è
 * un gusto di stile: è il lock `corpo-letto-dopo-il-gate`, cioè la lezione di
 * `primaria/fascicolo` — «il server avrebbe comunque letto e bufferizzato fino a
 * 15 MB spediti da chiunque prima di sapere chi fosse». Con `utenteId` nel corpo,
 * `assertUtenteInScope` potrebbe girare solo DOPO aver bufferizzato fino a 4 MB
 * mandati da uno staff di un'altra sede. In query, il diniego arriva prima che un
 * byte del file attraversi la rete.
 *
 * ── L'ORDINE DELLE COSE È SOSTANZA ──────────────────────────────────────────
 *
 *   1 gate di ruolo · 2 query · 3 gate di SEDE del bersaglio · 4 tetto per utente
 *   5 **stato attuale dal database** · 6 corpo · 7 dimensione · 8 tipo
 *   9 percorso · 10 bucket · 11 registro · 12 scrittura con compare-and-swap
 *   13 rimozione della copia precedente · 14 audit · 15 log · 16 risposta
 *
 * Il passo 5 sta PRIMA del bucket per due motivi che si sommano: serve a conoscere lo
 * stato attuale della faccia — il testimone del compare-and-swap **e** il percorso
 * `vecchio`, che non sono la stessa cosa (vedi `StatoAttuale`), e senza il secondo la
 * copia precedente resterebbe nel bucket senza nessuna riga che la nomini — e fa
 * fallire con 503 su un database non migrato **senza aver caricato niente**, che è lo
 * stato del DB E2E della CI.
 */

/** La tabella del fascicolo. */
const TABELLA = 'anagrafica_personale'
/** Il bucket privato delle scansioni, dal modulo che lo dichiara: mai ribattuto. */
const BUCKET = BUCKET_DOCUMENTI_PERSONALE

/**
 * Il nome della rotta in `app_log.operazione`, in un posto solo.
 *
 * ⚠️ Sotto, in `withRoute(…)`, lo stesso valore è scritto LETTERALE e non con questa
 * costante — non è una svista. Il lock `logging-coverage` legge il SORGENTE e
 * pretende una stringa letterale che combaci col percorso del file: con una costante
 * non vedrebbe nessun `withRoute` affatto.
 */
const OPERAZIONE = 'admin/anagrafica-personale/scansione:POST'

/* ── I codici d'errore, letterali e in cima ───────────────────────────────────
 * Ogni risposta d'errore ne porta uno, dichiarato in `src/lib/ui/esito-fetch.ts`
 * (lock `errori-con-codice`) e tradotto in italiano e in inglese.
 *
 * ⚠️ TUTTI E TRE SONO CODICI DI QUESTA PORTA, e i primi due lo sono diventati il
 * 13/08/2026: prima erano `ANAGRAFICA_PERSONALE_NON_DISPONIBILE` e
 * `ANAGRAFICA_PERSONALE_NON_AGGIORNATA`, presi in prestito dalla rotta gemella. Il
 * prestito non si vedeva da qui perché **il client non mostra la prosa che questo
 * file scrive**: `messaggioDaCorpo` traduce il CODICE dal catalogo e butta il
 * messaggio del server (tranne per i codici in `CODICI_CON_DETTAGLIO`, che è un
 * elenco di uno). Quindi chi caricava una scansione e incappava nel 503 leggeva «le
 * scadenze dei documenti non sono consultabili… qui sotto non compare nessuna riga»
 * sotto un pulsante di caricamento, oppure «la correzione non è stata registrata»
 * senza aver corretto niente — la frase di un'ALTRA schermata, e in entrambi i casi
 * senza l'unica notizia che conta: che il documento non è stato archiviato.
 *
 * È lo stesso argomento con cui, dodici righe più sotto nel catalogo, esiste
 * `SCANSIONE_SOSTITUITA_ALTROVE` invece di riusare il codice della PATCH. Vale per
 * tutti e tre, e ora è applicato a tutti e tre. */
const CODICE_ARCHIVIO_NON_DISPONIBILE = 'SCANSIONE_ARCHIVIO_NON_DISPONIBILE'
const CODICE_NON_REGISTRATA = 'SCANSIONE_NON_REGISTRATA'
const CODICE_SOSTITUITA_ALTROVE = 'SCANSIONE_SOSTITUITA_ALTROVE'

/**
 * LE DUE COLONNE, UNA PER FACCIA.
 *
 * ⚠️ La mappa è scritta per esteso invece di essere pescata per indice da
 * `COLONNE_DOCUMENTO`, e la ragione è che l'ordine di un array non è un contratto:
 * `COLONNE_DOCUMENTO[0]` è il fronte solo finché nessuno riordina i campi del
 * template, e un riordino silenzioso qui vorrebbe dire archiviare il retro nella
 * colonna del fronte — un fascicolo con due facce scambiate, che nessun errore
 * segnala. Il legame col template non si perde: il test
 * `anagrafica-personale-scansione` verifica che questi due nomi siano ESATTAMENTE
 * `COLONNE_DOCUMENTO`, quindi un rinomino futuro diventa rosso qui invece di
 * diventare un `42703` in produzione.
 */
const COLONNA_PER_LATO = {
  fronte: 'documento_fronte_path',
  retro: 'documento_retro_path',
} as const

type Lato = keyof typeof COLONNA_PER_LATO

/**
 * IL TETTO, PER UTENTE E CON UNA COSTANTE PROPRIA.
 *
 * ⚠️ NON si riusa `TETTO_UPLOAD_PUBBLICO`, e non è pigrizia al contrario: quel
 * numero è tarato su una porta ANONIMA e conta per INDIRIZZO IP, perché là «il
 * modulo si compila in gruppo dietro il NAT di una sede». Qui chi bussa ha un
 * account, quindi il contatore giusto è la PERSONA: tre operatori di segreteria
 * nello stesso ufficio condividono l'indirizzo ma non devono condividere il tetto —
 * è esattamente il difetto che la porta pubblica ha già pagato («dal 21° in poi
 * arrivava un 429 indistinguibile da un servizio rotto»).
 *
 * ── L'ARITMETICA, misurata il 12/08/2026 in produzione ──────────────────────
 *
 *     select count(*) from utenti where ruolo <> 'genitore';   → 20
 *     select count(*) from anagrafica_personale;               → 0
 *
 * Il primo uso vero di questa porta è popolare l'archivio da zero: **20 persone ×
 * 2 facce = 40 caricamenti**, tutti dallo stesso account di segreteria. Quaranta è
 * quindi il fabbisogno, non il margine.
 *
 * ── PERCHÉ LA FINESTRA È DI DIECI MINUTI ────────────────────────────────────
 *
 * Perché 40 in 10 minuti è un caricamento ogni 15 secondi sostenuto per l'intera
 * finestra: più veloce di chiunque debba prendere in mano un documento, girarlo e
 * fotografarlo. Cioè il tetto NON morde il lavoro vero, e resta un tetto per ciò
 * che deve fermare — un client impazzito che ricarica in ciclo, che senza questa
 * riga scriverebbe nel bucket senza limite. Il danno massimo per operatore resta
 * 40 × 4 MB = 160 MB ogni dieci minuti.
 *
 * ⚠️ Il contatore degrada a in-memoria e PER ISTANZA (vedi `@/lib/security/rate-limit`):
 * in quel caso il tetto effettivo è N × 40. Alza il costo di un abuso, non lo azzera.
 */
const TETTO_SCANSIONE_PER_UTENTE = 40
const FINESTRA_SCANSIONE_MS = 10 * 60 * 1000

/**
 * `?utenteId=` e `?lato=`, e nient'altro.
 *
 * `lato` è un enumerato di due valori e non il nome della colonna: il client non
 * deve poter nominare una colonna del database nemmeno per sbaglio, e il giorno in
 * cui le colonne si chiamassero diversamente questo contratto non cambierebbe.
 */
const querySchema = z.object({
  utenteId: zUuid,
  lato: z.enum(['fronte', 'retro'], { error: 'Indicare quale faccia del documento (fronte o retro)' }),
})

/**
 * Il file si valida come presenza/istanza; dimensione e contenuto restano controlli
 * manuali (non materia di zod).
 *
 * ⚠️ NIENTE `utenteId`, niente `lato`, niente percorso: il multipart porta UN campo.
 * Ogni altro campo qui dentro sarebbe un identificativo letto dopo il gate di sede —
 * cioè il difetto che la testata spiega.
 */
const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'Nessun file ricevuto' }),
})

/** Codici con cui PostgREST/Postgres dicono «questa TABELLA qui non c'è». */
const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])
/** …e «questa COLONNA qui non c'è» (database della CI non migrato). */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])
/**
 * `unique_violation`: la riga del fascicolo esiste GIÀ.
 *
 * Non è un guasto e non è un errore di chi ha caricato: è la corsa fra due operatori
 * che aprono la stessa scheda vergine. Vedi {@link scrivi}, che su questo codice ricade
 * sull'UPDATE condizionato invece di sovrascrivere.
 */
const VIOLAZIONE_UNICA = '23505'

const codiceDi = (err: unknown): string | null => (err as { code?: string } | null)?.code ?? null
const schemaAssente = (err: unknown): boolean => {
  const c = codiceDi(err) ?? ''
  return TABELLA_ASSENTE.has(c) || COLONNA_ASSENTE.has(c)
}

/**
 * «Adesso non si può»: schema non migrato, lettura fallita.
 *
 * 503 e non 200: su un fascicolo del personale una risposta ottimista è la più
 * pericolosa possibile — chi carica crederebbe di aver consegnato il documento.
 */
const nonDisponibile = (messaggio: string) =>
  NextResponse.json({ error: messaggio, codice: CODICE_ARCHIVIO_NON_DISPONIBILE }, { status: 503 })

interface StatoAttuale {
  /** `true` se una riga di anagrafica per questa persona esiste già. */
  esiste: boolean
  /**
   * IL TESTIMONE del compare-and-swap: il valore della colonna **esattamente com'è in
   * tabella**, stringa vuota compresa.
   *
   * ⚠️ NON COINCIDE CON {@link vecchio}, e i due sono stati la stessa cosa fino al
   * 13/08/2026. Il difetto che il tenerli insieme produceva: una colonna che contenga
   * `''` o soli spazi — che il `check` della migrazione `20260812194501` AMMETTE, è
   * `is null or length(…) <= 200` — veniva normalizzata a `null`, ma la riga esisteva,
   * quindi il vincolo diventava `.is(colonna, null)`. In SQL `is null` **non** matcha
   * `''`: zero righe toccate, `esito: 'perso'`, e un **409 «questa scansione è stata
   * sostituita da qualcun altro nel frattempo» PER SEMPRE** — su una faccia che nessuno
   * aveva toccato, con un messaggio che manda a cercare un collega che non esiste.
   * Misurato in produzione il 13/08/2026: `where documento_fronte_path = '' or
   * documento_retro_path = ''` → 0 e 0 su entrambe le tabelle, quindi era latente e non
   * attivo. Latente non è innocuo: è il difetto che aspetta il primo `''`.
   *
   * La regola, detta una volta: **la normalizzazione e il predicato di compare-and-swap
   * devono decidere «vuoto» allo stesso modo.** Qui non decidono affatto — il testimone
   * è il valore grezzo, e il confronto è con quello.
   */
  attuale: string | null
  /**
   * Il percorso ARCHIVIATO per la faccia chiesta, cioè quello che al passo 13 esce dal
   * bucket. Normalizzato: `''` e i soli spazi valgono «non c'è niente da togliere», e
   * un `remove([''])` non deve partire mai.
   */
  vecchio: string | null
}

export const POST = withRoute('admin/anagrafica-personale/scansione:POST', async (request: NextRequest) => {
  // ── 1. IL GATE DI RUOLO, PRIMA DI TUTTO ────────────────────────────────────
  // Segreteria compresa: vedi la testata.
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  try {
    // ── 2. GLI IDENTIFICATIVI, DALLA QUERY ───────────────────────────────────
    const q = parseQuery(request, querySchema)
    if ('response' in q) return q.response
    const { utenteId, lato } = q.data
    // Da qui in giù `colonna` è uno dei due letterali della mappa e nient'altro: zod
    // ha già rifiutato ogni altro valore con un 400. È la ragione per cui più sotto si
    // può interpolare `colonna` dentro una `select()` e dentro un `.eq()` senza
    // chiedersi da dove venga.
    //
    // ⚠️ `satisfies Lato` NON è decorazione: tiene insieme l'enumerato di `zod` e le
    // chiavi della mappa. Il giorno in cui qualcuno aggiungesse una terza faccia allo
    // schema senza aggiungere la sua colonna, questa riga non compilerebbe — invece di
    // produrre a runtime un `colonna` `undefined`, cioè una `select('utente_id,
    // undefined')` e un fascicolo scritto sul nulla.
    const colonna: string = COLONNA_PER_LATO[lato satisfies Lato]

    const supabase = await createAdminClient()

    // ── 3. IL GATE DI SEDE — sulla persona BERSAGLIO, non su chi carica ──────
    // Senza, il solo `requireStaff` lascerebbe appendere una scansione al
    // fascicolo del personale di un'altra sede. E sta qui, prima del corpo:
    // è il motivo per cui `utenteId` viaggia in query.
    const fuoriScope = await assertUtenteInScope(supabase, auth.user, utenteId)
    if (fuoriScope) return fuoriScope

    // ── 4. IL TETTO, PER UTENTE ──────────────────────────────────────────────
    // Dopo il gate (l'identità serve per la chiave) e prima del corpo: una difesa
    // che si paga dopo aver letto 4 MB non ha difeso niente.
    const rl = await rateLimit(`personale-scansione:${auth.user.id}`, {
      limit: TETTO_SCANSIONE_PER_UTENTE,
      windowMs: FINESTRA_SCANSIONE_MS,
    })
    if (!rl.ok) {
      // `warn` e non `error`: è un uso sbagliato, non un guasto nostro. La riga ci
      // vuole comunque — senza, un client impazzito non lascerebbe traccia.
      logEvento('storage', 'warn', {
        operazione: OPERAZIONE,
        esito: 'tetto-utente-raggiunto',
        bucket: BUCKET,
        utente: auth.user.id,
        ruolo: auth.user.role,
      })
      return rispostaTroppiCaricamenti(rl.retryAfterMs)
    }

    // ── 5. LO STATO ATTUALE, PRIMA DI TOCCARE IL BUCKET ──────────────────────
    const stato = await leggiStato(supabase, utenteId, colonna)
    if ('risposta' in stato) return stato.risposta

    // ── 6. IL CORPO ──────────────────────────────────────────────────────────
    // `parseMultipart` e non `request.formData()`: quest'ultima LANCIA quando il
    // Content-Type non è multipart, e l'eccezione finirebbe nel `catch` in fondo —
    // che è tarato sui guasti del server — restituendo un 500 a un errore del client.
    const form = await parseMultipart(request)
    if ('response' in form) return form.response

    const parsed = parseData(postFormSchema, { file: form.data.get('file') })
    if ('response' in parsed) return parsed.response
    const { file } = parsed.data

    // ── 7. LA DIMENSIONE ─────────────────────────────────────────────────────
    // Il limite VERO è quello della piattaforma: sopra i ~4,5 MB il corpo lo rifiuta
    // Vercel (413 `FUNCTION_PAYLOAD_TOO_LARGE`, corpo di testo) e questo handler non
    // viene mai eseguito. 413 e non 400 così il client ha una cosa sola da riconoscere,
    // e a differenza di quello della piattaforma questo ha un corpo JSON leggibile.
    //
    // ⚠️ Il codice è `ALLEGATO_OLTRE_LIMITE_PIATTAFORMA` e non `ALLEGATO_TROPPO_GRANDE`:
    // la frase di quest'ultimo, in entrambi i cataloghi, dice «al massimo 10 MB» — cioè
    // il limite di un ALTRO bucket, e qui direbbe che c'è ancora margine.
    if (file.size > LIMITE_UPLOAD_BYTE) {
      return NextResponse.json(
        {
          error: `File troppo grande (max ${LIMITE_UPLOAD_MB} MB)`,
          codice: 'ALLEGATO_OLTRE_LIMITE_PIATTAFORMA',
        },
        { status: 413 },
      )
    }

    // ── 8. IL TIPO ───────────────────────────────────────────────────────────
    // ⚠️ SI RIUSA `verificaAllegatoPubblico` NONOSTANTE IL NOME DICA «pubblico», e
    // la ragione va scritta perché la tentazione opposta è forte: quella funzione
    // NON è «il gate delle porte anonime», è il gate dei cinque tipi di QUESTO
    // bucket — `documenti_personale` li DICHIARA in migrazione (`20260811205643`),
    // ed è la stessa lista che il template usa come `accept`. Riscriverla qui
    // sarebbe la seconda lista che diverge alla prima modifica: è già successo su
    // `gallery` (50 MB nel bucket, 200 MB nella route, per mesi) ed è la lezione
    // scritta in `@/lib/allegati/mime`. Un file respinto dall'applicazione e
    // accettato dal bucket — o viceversa — è un caricamento che «riesce» e non si
    // può più aprire.
    const gate = verificaAllegatoPubblico(file, { operazione: OPERAZIONE, bucket: BUCKET })
    if (!gate.ok) return gate.risposta

    // L'estensione la decide il TIPO (già normalizzato dal gate), mai il nome del
    // file: qui il nome è «carta-identita-<cognome>.pdf», cioè il cognome di una
    // persona, e non deve sopravvivere alla richiesta.
    const estensione = estensioneArchiviata(gate.contentType)
    if (!estensione) {
      // FAIL-CLOSED: è ciò che accadrebbe il giorno in cui il gate condiviso
      // ammettesse un tipo che la mappa non conosce. Meglio un rifiuto comprensibile
      // che un oggetto archiviato con un'estensione che nessun visualizzatore apre.
      logEvento('storage', 'error', {
        operazione: OPERAZIONE,
        esito: 'estensione-non-derivabile',
        bucket: BUCKET,
        mime: gate.contentType,
      })
      return rispostaAllegatoNonCaricato()
    }

    // ── 9. IL PERCORSO ───────────────────────────────────────────────────────
    // IDENTICO IN FORMA a quello che produce la porta pubblica, e non per simmetria:
    // `percorsoDocumentoAmmesso` e il `check (… like 'documenti/%')` della colonna
    // valgono per l'una e per l'altra senza una seconda regola da tenere allineata.
    // Due uuid e nessun frammento del nome originale; `DOC_PREFISSO` si importa
    // invece di riscriverlo, così le due porte non possono divergere di cartella.
    const path = `${DOC_PREFISSO}${crypto.randomUUID()}/${crypto.randomUUID()}.${estensione}`

    // ── 10. IL BUCKET ────────────────────────────────────────────────────────
    // `upsert: false`: un percorso generato dal server non deve poterne sostituire
    // un altro. La sostituzione della scansione avviene cambiando la COLONNA, non
    // riscrivendo un oggetto.
    const arrayBuffer = await file.arrayBuffer()
    const { error: erroreUpload } = await supabase.storage.from(BUCKET).upload(path, arrayBuffer, {
      cacheControl: '3600',
      upsert: false,
      contentType: gate.contentType,
    })
    if (erroreUpload) {
      // Il corpo dell'errore del fornitore resta nel LOG e non torna al client
      // (AGENTS §3): porta fuori il nome del bucket, i vincoli e le policy.
      logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'storage' }, erroreUpload)
      return rispostaAllegatoNonCaricato()
    }

    // ── 11. LA RIGA CHE NOMINA L'OGGETTO — e nasce GIÀ di proprietà ──────────
    //
    // ⚠️ `anagraficaUtenteId` NON è un ornamento. Senza, la riga nascerebbe «in
    // sospeso» (`pratica_id is null` **e** `anagrafica_utente_id is null`) e
    // `spazzaCaricamentiSospesi` toglierebbe dal bucket, entro 24 ore, la
    // fotografia del documento di una dipendente in servizio MENTRE il suo
    // fascicolo la nomina: il fascicolo punterebbe a un file che non c'è più. È il
    // caso peggiore possibile, ed è dichiarato per esteso nella migrazione
    // `20260812194501` e nella testata di `@/lib/personale/caricamenti`.
    const registro = await registraCaricamento(supabase, path, OPERAZIONE, {
      anagraficaUtenteId: utenteId,
    })
    if (!registro.registrato) {
      // SE LA RIGA NON SI SCRIVE, L'OGGETTO SI RITIRA. Un allegato senza registro è
      // l'orfano invisibile: nessuna riga lo nomina, quindi non è nemmeno
      // identificabile per cancellarlo se la persona lo chiedesse.
      await ritira(supabase, path, 'registro-non-scritto', gate.contentType, file.size)
      return rispostaAllegatoNonCaricato()
    }

    // ── 12. LA SCRITTURA, CON COMPARE-AND-SWAP ───────────────────────────────
    const scritta = await scrivi(supabase, {
      utenteId,
      colonna,
      path,
      // ⚠️ `attuale` e non `vecchio`: il compare-and-swap confronta il valore GREZZO,
      // `''` compreso. Passare qui il percorso normalizzato è il 409 permanente
      // descritto su {@link StatoAttuale}.
      attuale: stato.attuale,
      esiste: stato.esiste,
      attore: auth.user.id,
    })
    if (scritta.esito === 'errore') {
      // La colonna non è cambiata: l'oggetto appena caricato non lo nomina nessuno.
      await ritira(supabase, path, 'colonna-non-scritta', gate.contentType, file.size)
      logEvento('personale', schemaAssente(scritta.error) ? 'warn' : 'error', {
        operazione: OPERAZIONE,
        esito: schemaAssente(scritta.error) ? 'schema-assente' : 'scansione-non-scritta',
        entita_tipo: TABELLA,
        entita_id: utenteId,
        error_code: codiceDi(scritta.error),
      }, scritta.error)
      return NextResponse.json(
        {
          error: 'La scansione non è stata registrata e il file non è stato conservato: riprovare fra poco.',
          codice: CODICE_NON_REGISTRATA,
        },
        { status: 503 },
      )
    }
    if (scritta.esito === 'perso') {
      // ⚠️ ZERO RIGHE TOCCATE NON È «NIENTE DA FARE»: significa che fra il passo 5 e
      // adesso qualcun ALTRO ha sostituito questa stessa faccia. Sovrascrivere
      // sarebbe cancellare il file di un collega senza dirglielo — e su un documento
      // d'identità la copia cancellata non si recupera. Si ritira il proprio oggetto
      // e si risponde 409: chi ha caricato ricarica la scheda e vede che cosa c'è.
      await ritira(supabase, path, 'sostituita-altrove', gate.contentType, file.size)
      logEvento('personale', 'warn', {
        operazione: OPERAZIONE,
        esito: 'scansione-sostituita-altrove',
        azione: `scansione-${lato}`,
        entita_tipo: TABELLA,
        entita_id: utenteId,
        utente: auth.user.id,
        ruolo: auth.user.role,
      })
      return NextResponse.json(
        {
          error: 'Questa scansione è stata sostituita da qualcun altro nel frattempo: ricarica la scheda e riprova.',
          codice: CODICE_SOSTITUITA_ALTROVE,
        },
        { status: 409 },
      )
    }

    // ── 13. SOLO ORA LA COPIA PRECEDENTE ESCE DALL'ARCHIVIO ──────────────────
    //
    // ⚠️ L'ORDINE È L'OPPOSTO DI `gdpr/retention-personale`, che fa «prima i file,
    // poi le righe», e la differenza non è una svista: là la riga sparisce comunque,
    // quindi il rischio da evitare è il file che resta senza nessuna riga che lo
    // nomini. **Qui la riga RESTA**, ed è il fascicolo di una persona in servizio:
    // deve poter nominare un file che esiste. Togliere prima l'oggetto e poi
    // scrivere la colonna lascerebbe — per il tempo di una riga di codice, e per
    // sempre se la scrittura fallisse — un fascicolo che punta al nulla.
    if (stato.vecchio && stato.vecchio !== path) {
      await togliVecchia(supabase, stato.vecchio, utenteId)
    }

    // ── 14. L'AUDIT — che cosa è stato fatto, mai il percorso ────────────────
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: TABELLA,
      entitaId: utenteId,
      azione: 'update',
      scuolaId: null,
      // ⚠️ IL PERCORSO NON ENTRA QUI, e non è una dimenticanza: `audit_scritture_docente`
      // è il registro IMMUTABILE — ciò che ci finisce non si toglie più — e un percorso
      // è la chiave con cui si firma la fotografia di un documento d'identità. Che la
      // faccia sia stata caricata o sostituita si legge da qui; qual è il file, si legge
      // nel fascicolo, che ha un gate suo.
      valoreDopo: { campi: [colonna], lato, sostituzione: Boolean(stato.vecchio) },
    })

    // ── 15. IL SUCCESSO SI LOGGA (AGENTS §5) ─────────────────────────────────
    // Con i soli errori, «nessun log» non distingue «nessuno carica scansioni» da
    // «i caricamenti non partono più» — l'ambiguità che ha tenuto invisibile per mesi
    // il guasto delle email. Solo metadati, e nemmeno il PERCORSO.
    logEvento('storage', 'info', {
      operazione: OPERAZIONE,
      esito: stato.vecchio ? 'scansione-sostituita' : 'scansione-caricata',
      azione: `scansione-${lato}`,
      bucket: BUCKET,
      mime: gate.contentType,
      byte: file.size,
      entita_tipo: TABELLA,
      entita_id: utenteId,
      sede_id: auth.user.scuola_id ?? null,
      utente: auth.user.id,
      ruolo: auth.user.role,
    })

    // ── 16. LA RISPOSTA, SENZA IL PERCORSO ───────────────────────────────────
    //
    // ⚠️ La porta PUBBLICA restituisce `{ path }` perché deve: là il modulo rimanda
    // quel valore all'invio della pratica. Qui il percorso lo scrive il server nella
    // colonna, nella stessa richiesta, e nessuno lo deve rimandare indietro — quindi
    // farlo viaggiare sarebbe far uscire dal server, senza nessun motivo, la chiave
    // che apre il documento d'identità di una persona. La scheda rilegge dal
    // fascicolo, che è la sua unica fonte di verità.
    return NextResponse.json({ success: true })
  } catch (err) {
    // `withRoute` non vede le eccezioni CATTURATE: il log lo fa questo ramo.
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
    return rispostaAllegatoNonCaricato()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Gli aiutanti
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LO STATO ATTUALE DELLA FACCIA CHIESTA — e la risposta pronta se non si sa.
 *
 * FAIL-CLOSED: se il fascicolo non si può leggere non si carica niente. Non sapere
 * quale sia il percorso precedente significherebbe, un passo più avanti, o
 * sovrascrivere una colonna alla cieca o lasciare nell'archivio una fotografia che
 * nessuna riga nomina più.
 *
 * Riga assente NON è un errore: è il caso NORMALE del primo giorno — in produzione
 * `anagrafica_personale` ha zero righe — ed è ciò che il passo 12 gestisce con un
 * INSERT invece che con un update (e mai con un upsert: vedi {@link scrivi}).
 */
async function leggiStato(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  utenteId: string,
  colonna: string,
): Promise<StatoAttuale | { risposta: NextResponse }> {
  const { data, error } = await supabase
    .from(TABELLA)
    // Proiezione ESPLICITA e ridotta al minimo: da qui non devono uscire codice
    // fiscale, residenza e numero del documento — questa rotta non li guarda.
    .select(`utente_id, ${colonna}`)
    .eq('utente_id', utenteId)
    .maybeSingle()

  if (error) {
    const assente = schemaAssente(error)
    logEvento('personale', assente ? 'warn' : 'error', {
      operazione: OPERAZIONE,
      esito: assente ? 'schema-assente' : 'fascicolo-non-letto',
      entita_tipo: TABELLA,
      entita_id: utenteId,
      error_code: codiceDi(error),
    }, error)
    return {
      risposta: nonDisponibile(
        assente
          ? 'L\'anagrafica del personale non è disponibile su questo ambiente: lo schema non è ancora stato creato.'
          : 'La scansione non si può caricare in questo momento: riprovare fra poco.',
      ),
    }
  }

  const riga = data as Record<string, unknown> | null
  const grezzo = riga ? riga[colonna] : null
  // ⚠️ DUE VALORI DA UN CAMPO SOLO, e il motivo sta per esteso su {@link StatoAttuale}:
  // `attuale` è il TESTIMONE del compare-and-swap e conserva `''`, `vecchio` è il file
  // da togliere e non esiste quando la colonna è vuota. Fonderli in uno — che è com'era
  // fino al 13/08/2026 — fa nascere un 409 permanente su una faccia che nessuno ha
  // toccato, perché `is null` non matcha `''`.
  const attuale = typeof grezzo === 'string' ? grezzo : null
  const vecchio = attuale !== null && attuale.trim() !== '' ? attuale : null
  return { esiste: riga !== null, attuale, vecchio }
}

type EsitoScrittura =
  | { esito: 'scritta' }
  /** Zero righe toccate: qualcun altro ha sostituito la scansione nel frattempo. */
  | { esito: 'perso' }
  | { esito: 'errore'; error: unknown }

/**
 * LA SCRITTURA DELLA COLONNA, CON COMPARE-AND-SWAP — E MAI UN UPSERT.
 *
 * ── ⚠️ PERCHÉ NON C'È PIÙ L'UPSERT, che qui c'è stato fino al 13/08/2026 ────────
 *
 * Il ramo «riga assente» faceva `upsert(… , { onConflict: 'utente_id' })`, e il
 * commento sosteneva che nella finestra fra il passo 5 e il passo 12 «il gesto
 * perdente non distrugge niente». Era vero per i DATI e falso per l'ARCHIVIO. La
 * sequenza, per intero:
 *
 *   1. due operatori aprono la scheda della stessa persona, che non ha ancora
 *      fascicolo. Entrambi leggono al passo 5: riga assente.
 *   2. il primo arriva in fondo: crea la riga con `documento_fronte_path = A`.
 *   3. il secondo arriva con la STESSA faccia. L'`upsert` fondeva la sua riga sopra
 *      quella già creata e scriveva `documento_fronte_path = B`.
 *   4. il passo 13 non faceva NIENTE, perché lavora su `stato.vecchio` — e per lui
 *      valeva `null`, letto quando la riga non c'era.
 *
 * Risultato: **A resta nel bucket e nessuna colonna lo nomina**. Non lo raccoglie
 * nemmeno `spazzaCaricamentiSospesi`, perché la sua riga di `caricamenti_personale`
 * ha `anagrafica_utente_id` valorizzato e la spazzata guarda solo ciò che non ha
 * proprietario. È la fotografia di un documento d'identità che nessuna riga nomina e
 * nessuna spazzata toglie — cioè **letteralmente «l'orfano invisibile» che il passo 11
 * dichiara di esistere per impedire**, prodotto dal passo 12.
 *
 * ── LE DUE FORME DI OGGI ────────────────────────────────────────────────────────
 *
 *  · **riga assente ⇒ INSERT.** Nessun `onConflict`: se la riga è nata nel frattempo,
 *    Postgres risponde `23505` e non sovrascrive niente. Quel codice non è un guasto,
 *    è la notizia che la corsa c'è stata; si ricade allora sul ramo qui sotto **con il
 *    testimone originale**, che era «niente».
 *  · **riga presente ⇒ UPDATE con il vincolo sul valore ATTUALE** (`.eq(colonna,
 *    attuale)`, oppure `.is(colonna, null)` quando in tabella c'è `NULL`). Zero righe
 *    toccate significa che il valore è cambiato sotto: 409 invece di sovrascrivere,
 *    perché sovrascrivere qui vuol dire cancellare — al passo 13 — la scansione che un
 *    collega ha appena caricato.
 *
 * ⚠️ DOPO IL `23505` IL TESTIMONE NON SI RILEGGE, ed è la parte che vale la pena
 * dire: rileggere e adottare il valore trovato significherebbe accettare come «stato
 * di partenza» proprio ciò che il collega ha appena scritto, e cancellarglielo al passo
 * 13. Il testimone resta quello osservato al passo 5 — «la colonna non aveva niente» —
 * quindi il `.is(colonna, null)` riesce solo se il collega ha riempito **l'altra**
 * faccia, e fallisce (409, oggetto ritirato) se ha riempito questa. Le due corse
 * finiscono come devono, senza un orfano in nessuna delle due.
 *
 * ⚠️ `.select()` DOPO la scrittura, e non è decorazione: un `update` che non trova
 * niente NON è un errore per PostgREST — risponde `{ data: [], error: null }`, cioè
 * «fatto» — e senza contare le righe toccate la corsa si perderebbe in silenzio. È
 * la stessa lezione già scritta in `collegaCaricamenti`: «si verifica lo STATO, non
 * l'intenzione».
 */
async function scrivi(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  p: {
    utenteId: string
    colonna: string
    path: string
    /** Il valore GREZZO letto al passo 5 — `''` compreso. Vedi {@link StatoAttuale}. */
    attuale: string | null
    esiste: boolean
    attore: string
  },
): Promise<EsitoScrittura> {
  // `aggiornata_da` c'è per la stessa ragione per cui c'è nella PATCH gemella: il
  // fascicolo deve dire CHI l'ha toccato per ultimo. Il trigger
  // `anagrafica_personale_tocca` pensa a `aggiornata_il`, e quella regola vive in un
  // posto solo.
  const patch = { [p.colonna]: p.path, aggiornata_da: p.attore }

  if (!p.esiste) {
    const { data, error } = await supabase
      .from(TABELLA)
      .insert({ utente_id: p.utenteId, ...patch })
      .select('utente_id')
    if (!error) return { esito: (data ?? []).length > 0 ? 'scritta' : 'perso' }
    // Qualunque altro errore è un guasto: si ritira l'oggetto e si risponde 503.
    if (codiceDi(error) !== VIOLAZIONE_UNICA) return { esito: 'errore', error }
    // `23505`: la riga è apparsa fra il passo 5 e adesso. Si prosegue sul ramo
    // dell'UPDATE, e `p.attuale` vale `null` — che è ciò che si era osservato.
  }

  const base = supabase.from(TABELLA).update(patch).eq('utente_id', p.utenteId)
  const conVincolo = p.attuale === null ? base.is(p.colonna, null) : base.eq(p.colonna, p.attuale)
  const { data, error } = await conVincolo.select('utente_id')
  if (error) return { esito: 'errore', error }
  return { esito: (data ?? []).length > 0 ? 'scritta' : 'perso' }
}

/**
 * RITIRA l'oggetto appena caricato e la sua riga di registro.
 *
 * Si chiama quando il caricamento non ha prodotto un fascicolo aggiornato: registro
 * non scritto, colonna non scritta, corsa persa. In tutti e tre i casi l'oggetto nel
 * bucket non è nominato da nessuna colonna, e lasciarlo lì è la fotografia di un
 * documento d'identità che nessuno sa di avere.
 *
 * `remove()` nudo e non `rimuoviEVerifica`: qui non si sta cancellando la riga di
 * nessuno, si sta annullando un caricamento fatto un istante fa. L'esito si guarda
 * comunque — la Storage API non lancia — perché un ritiro fallito è la riga che
 * permette di andare a togliere l'oggetto a mano.
 */
async function ritira(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  path: string,
  motivo: string,
  mime: string,
  byte: number,
): Promise<void> {
  const { error: erroreRitiro } = await supabase.storage.from(BUCKET).remove([path])
  // La riga di registro segue l'oggetto: se resta, `caricamenti_personale` nomina un
  // file che non c'è e la porta pubblica non potrà più reclamare quel percorso.
  // `anagrafica_utente_id` è valorizzato, quindi la spazzata — che guarda solo le
  // righe SENZA proprietario — non passerebbe mai a raccoglierla.
  const { error: erroreRiga } = await supabase.from(TABELLA_CARICAMENTI).delete().eq('percorso', path)
  logEvento(
    'storage',
    'error',
    {
      operazione: OPERAZIONE,
      esito: erroreRitiro ? 'scansione-non-ritirata' : 'scansione-ritirata',
      tipo: motivo,
      bucket: BUCKET,
      mime,
      byte,
      error_code: codiceDi(erroreRitiro) ?? codiceDi(erroreRiga),
      msg: erroreRitiro
        ? `${OPERAZIONE}: il fascicolo non è stato aggiornato E il ritiro non è riuscito: nel bucket resta una scansione che nessuna colonna nomina`
        : `${OPERAZIONE}: il fascicolo non è stato aggiornato, scansione ritirata dal bucket`,
    },
    erroreRitiro ?? erroreRiga ?? undefined,
  )
}

/**
 * TOGLIE DALL'ARCHIVIO LA COPIA PRECEDENTE, dopo che il fascicolo nomina la nuova.
 *
 * `rimuoviEVerifica` e non un `remove()` nudo, al contrario di {@link ritira}: qui si
 * sta cancellando **per sempre** la fotografia del documento d'identità di una
 * persona, e `remove()` non fallisce sui percorsi che non esistono — guardare solo
 * `error` farebbe passare per successo uno «zero file rimossi su uno». La primitiva
 * condivisa verifica lo STATO e tratta il file già assente come esito raggiunto.
 *
 * ⚠️ LA RIGA DI REGISTRO SI CANCELLA ANCHE QUANDO IL FILE È RIMASTO, e la scelta va
 * detta invece di essere subita: quella riga ha `anagrafica_utente_id` valorizzato,
 * quindi `spazzaCaricamentiSospesi` — che raccoglie solo ciò che non ha NESSUN
 * proprietario — non la guarderebbe mai. Tenerla non farebbe riprovare nessuno:
 * lascerebbe soltanto un registro che nomina un file che il fascicolo non nomina più.
 * Perciò la riga esce e il fatto si GRIDA, con la frase che dice esattamente in che
 * stato è rimasto l'archivio.
 *
 * La richiesta RIESCE lo stesso: il fascicolo è già aggiornato e la persona ha
 * consegnato il documento. Un guasto della pulizia non può diventare un caricamento
 * fallito per chi ha fatto tutto bene — ma non può nemmeno restare muto (AGENTS §6).
 */
async function togliVecchia(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  vecchio: string,
  utenteId: string,
): Promise<void> {
  const esito = await rimuoviEVerifica(supabase, BUCKET, [vecchio], OPERAZIONE)
  const rimasta = esito.erroreRimozione || bloccanti(esito).length > 0

  const { error: erroreRiga } = await supabase
    .from(TABELLA_CARICAMENTI)
    .delete()
    .eq('percorso', vecchio)

  if (!rimasta && !erroreRiga) {
    // Anche questo successo si logga: è la sola prova che la copia sostituita esce
    // davvero dall'archivio, cioè che la promessa del terzo consenso
    // (`presa_visione_copia_documento`) viene mantenuta.
    logEvento('gdpr', 'info', {
      operazione: OPERAZIONE,
      esito: 'scansione-precedente-rimossa',
      bucket: BUCKET,
      entita_tipo: TABELLA,
      entita_id: utenteId,
      n_file_gia_assenti: esito.giaAssenti.length,
    })
    return
  }

  logEvento(
    'gdpr',
    'error',
    {
      operazione: OPERAZIONE,
      esito: rimasta ? 'scansione-precedente-non-rimossa' : 'registro-precedente-non-cancellato',
      bucket: BUCKET,
      entita_tipo: TABELLA,
      entita_id: utenteId,
      error_code: codiceDi(erroreRiga),
      msg: rimasta
        ? `${OPERAZIONE}: la copia precedente è rimasta nel bucket e nessuna riga la nomina più — va tolta a mano dall'archivio`
        : `${OPERAZIONE}: copia precedente rimossa dall'archivio ma riga di ${TABELLA_CARICAMENTI} NON cancellata`,
    },
    erroreRiga ?? undefined,
  )
}
