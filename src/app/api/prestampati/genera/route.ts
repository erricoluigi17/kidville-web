import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente, type AppUser } from '@/lib/auth/require-staff'
import { assertSezioneInScope, resolveScuolaScrittura } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { parseBody, validationError } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { annoFiscale } from '@/lib/format/fiscal-date'
import { applicaCartaIntestata } from '@/lib/carta'
import {
  dataOraItaliana,
  formatNumeroProtocollo,
  righeSegnatura,
} from '@/lib/protocolli/segnatura'
import {
  ensureBucket,
  pathDefinitivi,
  sha256Impronta,
  slugNomeFile,
  PROTOCOLLO_BUCKET,
} from '@/lib/protocolli/store'
import { denominazioneScuola } from '@/lib/protocolli/server'
import { logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { caricaPrefillAlunno } from '@/lib/prestampati/prefill'
import {
  prestampato,
  SLUG_PRESTAMPATI,
  type VocePrestampato,
} from '@/lib/prestampati/registro'
import type { EsitoRender, ProtocolloRender } from '@/lib/prestampati/render'
import {
  cancelloDelModello,
  caricaSezione,
  cartaDelContesto,
  componiPrestampato,
  letturaPerStampa,
  motivoNonGenerabile,
  scadenzaDaRisposte,
  SPIEGAZIONE_NON_GENERABILE,
  type ContestoPrestampato,
  type ContestoSezione,
} from '../banco'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * POST /api/prestampati/genera — il foglio esce dallo sportello.
 *
 * In ordine, e l'ordine è la parte che conta:
 *
 *  1. il modello dal registro (uno slug che non è fra i diciassette è un 400, non un
 *     documento con un `document_type` inventato dentro il fascicolo di un bambino);
 *  2. **la sede si DICHIARA** (`resolveScuolaScrittura`): con più sedi e nessuna indicata
 *     la risposta è 400. Una route che «indovina» la sede protocolla nel registro del
 *     plesso sbagliato, e lo fa in silenzio;
 *  3. il precompilato del soggetto e la validazione delle risposte con lo schema del
 *     modello;
 *  3bis. il REGISTRO DEGLI ACCESSI sull'anagrafica appena letta: una riga `view` per il
 *     bambino, subito dopo i gate e PRIMA che si sappia se il foglio uscirà. È la regola 5
 *     di `docs/prestampati/README.md`, ed è il passo che mancava: legato all'archiviazione,
 *     l'audit non veniva scritto né quando l'archiviazione fallisce (che oggi in produzione
 *     è sempre) né per il n. 31, che non si archivia affatto e intanto porta i dati di un
 *     bambino a un istituto terzo;
 *  3ter. il motivo che si scopre solo qui: cinque dei sei fogli generabili si chiudono con
 *     la firma del legale rappresentante, e il suo nome sta nella configurazione della
 *     sede — che si legge insieme al precompilato. Se manca, 422 col motivo, prima che la
 *     numerazione venga toccata;
 *  4. se il documento esce dalla scuola, il numero di protocollo in USCITA;
 *  5. il render, col nome del legale rappresentante letto dalla configurazione di sede;
 *  6. l'archiviazione nel fascicolo (`student_documents` + bucket privato). Le stampe di
 *     sezione non si archiviano: si consegnano;
 *  6bis. le altre due righe del registro degli accessi: `upload` sul documento entrato nel
 *     fascicolo, e una riga `list` per ciascun bambino di una stampa di sezione — che è ciò
 *     che il n. 49 punto 2 chiama con il suo nome, «un'estrazione di dati personali, anche
 *     se serve a lavorare»;
 *  7. il log del SUCCESSO, non solo dell'errore.
 *
 * ─── PERCHÉ LA NUMERAZIONE È SCRITTA QUI E NON DENTRO `registraProtocollo` ───────
 *
 * `registraProtocollo()` fa tutto in una chiamata — prende il numero, timbra, carica,
 * inserisce — e quindi PRETENDE il PDF già fatto. Va benissimo per le tre route del
 * registro protocolli, dove il numero compare solo nella fascia di segnatura apposta dopo.
 * Qui no: §4.3 della specifica vuole nel foglio il riquadro di verifica che dichiara il
 * numero, e `render.ts` rifiuta di comporre un documento in uscita che non lo dichiari.
 * Il numero deve quindi esistere PRIMA del PDF, e prenderlo con una seconda chiamata alla
 * RPC ne brucerebbe uno a ogni foglio, con il PDF che dice `0000123` e il registro che dice
 * `0000124`.
 *
 * Perciò qui la stessa sequenza è aperta attorno al render, con gli stessi pezzi
 * (`prossimo_numero_protocollo`, `righeSegnatura`, `applicaCartaIntestata`, `pathDefinitivi`,
 * `sha256Impronta`) e lo stesso rollback: non una numerazione nuova, la stessa smontata di
 * un passo. **La riparazione vera sta in `src/lib/protocolli/store.ts`** — un
 * `registraProtocollo` che accetti il numero già preso, o che si divida in
 * «prendi»/«registra» — e quel file non è di questa mano: è segnalato, non fatto.
 *
 * ⚠️ Il numero si prende DOPO che le risposte sono state validate (la prova a vuoto qui
 * sotto), perché un refuso in un campo non deve bruciare un numero di protocollo.
 */

const postBodySchema = z
  .object({
    /** Uno dei diciassette: uno slug fuori dal registro è un errore del client, cioè 400. */
    modello: z.enum(SLUG_PRESTAMPATI),
    alunnoId: zUuid.optional(),
    sezioneId: zUuid.optional(),
    /**
     * La sede su cui si scrive. Facoltativa QUI e obbligatoria di fatto: chi ha più di una
     * sede e non la dichiara riceve il 400 di `resolveScuolaScrittura`, che è l'unico punto
     * del repo che sa distinguere «non me l'hai detta» da «me ne hai detta una non tua».
     */
    scuolaId: zUuid.optional(),
    /** Le risposte del form. Le valida lo schema del MODELLO, non questo: sono diciassette. */
    risposte: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((v, ctx) => {
    const voce = prestampato(v.modello)
    if (!voce) return
    if (voce.soggetto === 'alunno' && !v.alunnoId) {
      ctx.addIssue({
        code: 'custom',
        path: ['alunnoId'],
        message: 'Indicare il bambino di cui generare il prestampato',
      })
    }
    if (voce.soggetto === 'sezione' && !v.sezioneId) {
      ctx.addIssue({
        code: 'custom',
        path: ['sezioneId'],
        message: 'Indicare la sezione di cui generare la stampa',
      })
    }
  })

/** Il bucket privato del fascicolo: lo stesso di `primaria/fascicolo`, non uno nuovo. */
const BUCKET_FASCICOLO = 'sensitive_documents'
const MIME_PDF = 'application/pdf'

/**
 * Il rifiuto del render, tradotto in risposta HTTP.
 *
 * Gli errori di CAMPO non hanno codice — sono l'esito di `zod` sul modulo, uno per campo — e
 * tornano dalla stessa porta di `parseBody` (`validationError`): 400 con `details`, così il
 * pannello li mostra accanto al campo sbagliato invece che in una barra rossa in cima.
 *
 * ⚠️ I codici sono scritti UNO PER UNO, letterali, e non presi da una tabella `codice →
 * status`: il lock `errori-con-codice` legge il sorgente, e un `codice: esito.codice` non
 * gli permette di verificare che quel codice sia dichiarato in `CODICI_ERRORE` e tradotto
 * nelle due lingue. Una riga in più qui vale la garanzia che nessuna di queste risposte
 * arrivi in inglese scritta in italiano.
 */
function rispostaRifiuto(esito: Extract<EsitoRender<unknown>, { ok: false }>): NextResponse {
  const messaggio = esito.errori[0]?.messaggio ?? 'Documento non generato.'
  switch (esito.codice) {
    case undefined:
      return validationError(
        esito.errori.map((e) => ({ path: e.campo ? [e.campo] : [], message: e.messaggio })),
      )
    case 'PRESTAMPATO_SCONOSCIUTO':
      return NextResponse.json({ error: messaggio, codice: 'PRESTAMPATO_SCONOSCIUTO' }, { status: 404 })
    case 'PRESTAMPATO_FIRMA_NON_VALIDA':
      // ⚠️ OGGI DA QUESTA ROUTE NON CI SI ARRIVA, e va detto perché il ramo resta. Il render
      // emette questo codice in due casi: la firma OTP del genitore assente — e quegli otto
      // modelli li ha già rifiutati `motivoNonGenerabile` prima di leggere l'anagrafica — e
      // il nome del legale rappresentante mancante, che è il ramo `3ter` qui sopra, dove il
      // rifiuto esce con `PRESTAMPATO_DATI_MANCANTI` e il suo motivo. Restare è comunque la
      // cosa giusta: questa funzione traduce i codici che `render.ts` DICHIARA, non quelli
      // che oggi capita che emetta, e una traduzione parziale diventerebbe il `default` — un
      // 500 — il giorno in cui un modello nuovo arriva qui con la firma di un genitore.
      return NextResponse.json({ error: messaggio, codice: 'PRESTAMPATO_FIRMA_NON_VALIDA' }, { status: 409 })
    case 'PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE':
      return NextResponse.json(
        { error: messaggio, codice: 'PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE' },
        { status: 409 },
      )
    case 'PRESTAMPATO_DATI_MANCANTI':
      return NextResponse.json({ error: messaggio, codice: 'PRESTAMPATO_DATI_MANCANTI' }, { status: 422 })
    default:
      // Il render oggi non emette altro. Se un giorno lo facesse, un 500 col codice della
      // generazione fallita è la risposta onesta: il documento non c'è.
      return NextResponse.json({ error: messaggio, codice: 'PRESTAMPATO_NON_GENERATO' }, { status: 500 })
  }
}

export const POST = withRoute('prestampati/genera:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const user = auth.user

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { modello, alunnoId, sezioneId, scuolaId, risposte } = b.data

    // ── 1. Il modello dal registro ────────────────────────────────────────────
    // Come nel GET, questo ramo è IRRAGGIUNGIBILE: lo slug è già ristretto dallo schema, e
    // il rifiuto vero di un modello inventato è il 400 di `parseBody`. Resta per il
    // restringimento di tipo — `prestampato()` accetta stringhe qualunque — e non per una
    // difesa in più.
    const voce = prestampato(modello)
    if (!voce) {
      return NextResponse.json(
        { error: 'Prestampato non riconosciuto.', codice: 'PRESTAMPATO_SCONOSCIUTO' },
        { status: 404 },
      )
    }

    // Il cancello dei ruoli del modello: il diniego lo emette il gate, con la sua frase e
    // la sua riga `ruolo-negato`. È la STESSA funzione che chiama il GET — stava scritto
    // due volte, e le due copie erano già divergenti. Vedi la nota in `banco.ts`.
    const negato = await cancelloDelModello(request, voce, user.role)
    if (negato) return negato

    // Un foglio che allo sportello non nasce si rifiuta PRIMA di leggere l'anagrafica di
    // un minore. Il render arriverebbe alla stessa conclusione: qui si anticipa soltanto.
    const motivo = motivoNonGenerabile(voce)
    if (motivo === 'firma_da_raccogliere' || motivo === 'firma_senza_flusso') {
      // DUE MOTIVI, UNA SOLA RISPOSTA, e la differenza sta tutta nella frase. Lo status è
      // lo stesso — il foglio non esce perché la firma del genitore non c'è — ma il primo
      // dice dove andare a prenderla e il secondo dice che non c'è ancora dove andare.
      // Mandare un'educatrice al flusso della famiglia per il verbale di un infortunio, che
      // quel flusso non contiene, è peggio che dirle che oggi quel foglio non nasce.
      //
      // 🔴 E LA FRASE, DA SOLA, NON ARRIVAVA A SCHERMO. `messaggioDaCorpo`
      // (`src/lib/ui/esito-fetch.ts`) mostra il testo di CATALOGO del `codice` e butta via
      // `error`, tranne per i codici dichiarati in `CODICI_CON_DETTAGLIO` — che oggi
      // contiene solo `CLASSI_FUORI_SEDE`. Con lo stesso codice sui due motivi, il pannello
      // mostrava a tutti e due «La firma non risulta raccolta o non è valida…»: cioè la
      // distinzione appena descritta viaggiava fino al client per non essere letta da
      // nessuno, ed è precisamente il difetto che `banco.ts` argomenta tre volte contro.
      //
      // Il rimedio economico è questo: il MOTIVO viaggia in un campo suo, enumerato e
      // stabile, e a tradurlo è il pannello — che ha un catalogo per lingua. Le tre chiavi
      // (`motivoFirmaDaRaccogliere`, `motivoFirmaSenzaFlusso`, `motivoFonteDatiAssente`) sono
      // CHIESTE in `messages/it|en/prestampatiSegreteria.json`: quei due file non sono di
      // questa mano, e la richiesta è nelle note del lavoro. `error` resta la prosa del
      // server, che è il ripiego quando un codice non è ancora dichiarato — non il canale
      // principale.
      return NextResponse.json(
        {
          error: SPIEGAZIONE_NON_GENERABILE[motivo],
          codice: 'PRESTAMPATO_FIRMA_NON_VALIDA',
          motivo,
        },
        { status: 409 },
      )
    }
    if (motivo === 'fonte_dati_assente') {
      // Stesso ragionamento del ramo qui sopra: `PRESTAMPATO_DATI_MANCANTI` è un codice
      // largo — lo usano anche la sezione senza sede e le colonne sanitarie assenti — e la
      // sua frase di catalogo dice «completali in anagrafica e riprova», che per i tre
      // modelli senza fonte dati è un'istruzione impossibile da eseguire. Il campo `motivo`
      // permette al pannello di dire la cosa giusta.
      return NextResponse.json(
        {
          error: SPIEGAZIONE_NON_GENERABILE.fonte_dati_assente,
          codice: 'PRESTAMPATO_DATI_MANCANTI',
          motivo,
        },
        { status: 422 },
      )
    }

    const supabase = await createAdminClient()

    // ── 2. La sede si dichiara ────────────────────────────────────────────────
    const sede = await resolveScuolaScrittura(request, supabase, user, scuolaId)
    if (sede.response) return sede.response
    // Il tipo di ritorno ha DUE campi opzionali, e `response` assente non dichiara a `tsc`
    // che `scuolaId` c'è. Un `as string` chiuderebbe il discorso fidandosi di una garanzia
    // scritta in un altro file — che è la scorciatoia che questo file rifiuta per due volte
    // altrove (`prestampato()` e `sezioneId`). Qui vale lo stesso: un controllo esplicito.
    const sedeScrittura = sede.scuolaId
    if (!sedeScrittura) return rifiutoSede('SEDE_DA_SPECIFICARE')

    // ── 3. Il precompilato del soggetto ───────────────────────────────────────
    const caricato = await caricaContesto(request, supabase, user, voce, {
      alunnoId,
      sezioneId,
      risposte,
      sedeScrittura,
    })
    if (caricato.response) return caricato.response
    const contesto = caricato.contesto

    // La sede del soggetto e la sede dichiarata devono essere la stessa. Non è un doppione
    // del passo 2: là si verifica che la sede sia FRA LE PROPRIE, qui che sia quella del
    // bambino. Senza, un admin di tre plessi archivia nel registro di Cesa il certificato
    // di un bambino di Giugliano — e i due fogli si somigliano abbastanza da non accorgersene.
    const sedeSoggetto =
      contesto.soggetto === 'alunno' ? contesto.prefill.scuolaId : contesto.sezione.scuolaId
    if (sedeSoggetto !== sedeScrittura) {
      logEvento('modulistica', 'warn', {
        operazione: 'prestampati/genera:POST',
        esito: 'sede-dichiarata-diversa-dal-soggetto',
        utente: user.id,
        tipo: voce.slug,
        scuola_id: sedeScrittura,
        sede_soggetto: sedeSoggetto,
      })
      return rifiutoSede('SEDE_NON_ACCESSIBILE')
    }

    // ── 3bis. IL REGISTRO DEGLI ACCESSI, sull'anagrafica appena letta ─────────
    // Regola 5 di `docs/prestampati/README.md`, e lo stesso principio che il GET dichiara
    // sul precompilato: la riga si scrive DOPO i gate — un accesso registrato sopra un 403
    // racconterebbe una lettura che non c'è stata — e resta anche se poi il foglio non esce.
    // `caricaContesto` ha appena letto nome, nascita, codice fiscale, sezione e genitori di
    // un bambino: l'anagrafica è stata comunque aperta.
    //
    // ⚠️ NON si aspetta l'archiviazione. Legarla all'INSERT in `student_documents` — che è
    // com'era — significava zero righe di audit per tutti e quattro i modelli archiviabili,
    // perché quell'insert oggi in produzione fallisce SEMPRE (`22P02` sull'enumerato, vedi
    // `archiviaNelFascicolo`), e nessuna riga MAI per il n. 31, che non si archivia affatto
    // e nel frattempo porta nome, data di nascita e sezione di un bambino a un istituto
    // terzo. L'`upload` sull'insert riuscito resta: sono due fatti diversi — l'anagrafica
    // letta e il documento entrato nel fascicolo — e il registro deve poterli distinguere.
    if (contesto.soggetto === 'alunno') {
      await logAccessoFascicolo(supabase, {
        alunnoId: contesto.prefill.alunnoId,
        utenteId: user.id,
        azione: 'view',
        finalita: `Generazione prestampato ${voce.slug}`,
        request,
      })
    }

    const carta = cartaDelContesto(contesto)
    const legaleRappresentante =
      contesto.soggetto === 'alunno' ? contesto.prefill.legaleRappresentante : null
    const operatore = [user.cognome, user.nome].map((p) => p?.trim()).filter(Boolean).join(' ') || null

    // ── 3ter. IL MOTIVO CHE SI SCOPRE SOLO ADESSO ─────────────────────────────
    //
    // 🔴 È IL RAMO CHE IN PRODUZIONE SCATTA IL 100% DELLE VOLTE, e fino a ieri rispondeva
    // con la frase sbagliata. Cinque dei sei fogli che questo sportello dichiara generabili
    // si chiudono con la firma del legale rappresentante, e `componiFirma` (`render.ts`) li
    // rifiuta quando quel nome manca in `scuole.config.anagrafica.legale_rappresentante`.
    // Misurato in sola lettura il 2026-08-14: `SELECT count(*) FROM scuole` → 4, righe con
    // quella chiave → **0**. Il rifiuto del render porta `PRESTAMPATO_FIRMA_NON_VALIDA`, la
    // cui frase di catalogo dice «La firma non risulta raccolta o non è valida: il documento
    // non si genera prima della firma» — e mandava la segreteria a cercare la firma di un
    // GENITORE mentre a mancare era un campo delle impostazioni di sede.
    //
    // Qui il rifiuto arriva col codice giusto (`PRESTAMPATO_DATI_MANCANTI` → «completali in
    // anagrafica e riprova», che è l'istruzione eseguibile) e col suo `motivo` enumerato,
    // che è ciò che il pannello traduce nella lingua in cui sta lavorando. La chiave di
    // catalogo `motivoLegaleRappresentanteAssente` è CHIESTA in
    // `messages/it|en/prestampatiSegreteria.json`, che non sono di questa mano: la richiesta
    // è nelle note del lavoro, insieme alle altre tre.
    //
    // ⚠️ COSA CAMBIA DAVVERO STARE QUI, detto senza gonfiarlo: **non** il numero di
    // protocollo. Quello lo salvava già la prova a vuoto di `protocollaEComponi`, che
    // compone prima di chiedere la numerazione — misurato togliendo questo ramo: la
    // risposta diventa 409, e `prossimo_numero_protocollo` non viene chiamata. Cambiano la
    // risposta (codice, status e motivo, cioè ciò che la persona legge e fa) e due
    // composizioni jsPDF intere per un foglio che non può uscire. Il resto è ordine: un
    // motivo che si conosce si dice prima di avvicinarsi a un registro WORM, invece di
    // affidarsi a una difesa che vive dentro un'altra funzione.
    const motivoDiSede = motivoNonGenerabile(voce, { legaleRappresentante })
    if (motivoDiSede === 'legale_rappresentante_assente') {
      // Configurazione mancante = livello `error`, mai `info` (AGENTS.md §4): è il conteggio
      // di quante volte lo sportello si è fermato per un campo che due minuti nelle
      // impostazioni della sede rimetterebbero a posto. Solo uuid ed enumerati.
      logEvento('config', 'error', {
        operazione: 'prestampati/genera:POST',
        esito: 'legale-rappresentante-non-configurato',
        utente: user.id,
        tipo: voce.slug,
        scuola_id: sedeScrittura,
      })
      return NextResponse.json(
        {
          error: SPIEGAZIONE_NON_GENERABILE[motivoDiSede],
          codice: 'PRESTAMPATO_DATI_MANCANTI',
          motivo: motivoDiSede,
        },
        { status: 422 },
      )
    }

    // ── 4+5. Protocollo e render ──────────────────────────────────────────────
    let protocollo: EsitoProtocollo | null = null
    if (voce.protocollo === 'uscita') {
      const esito = await protocollaEComponi(supabase, {
        voce,
        contesto,
        risposte,
        carta,
        legaleRappresentante,
        operatore,
        scuolaId: sedeScrittura,
        createdBy: user.id,
      })
      if (esito.response) return esito.response
      protocollo = esito
    }

    const composto =
      protocollo?.reso ??
      componiPrestampato(voce, contesto, risposte, { carta, legaleRappresentante }, operatore)
    if (!composto.ok) return rispostaRifiuto(composto)

    // ── 5bis. LA CARTA DELLA SCUOLA, SU OGNI FOGLIO CHE ESCE DA QUI ───────────
    //
    // Il ramo protocollato l'ha già stesa insieme alla segnatura (una chiamata sola: vedi
    // `protocollaEComponi`). Gli altri diciassette modelli — la scheda sanitaria, la
    // delega al ritiro, la stampa di sezione — passano di qui, e senza questa riga
    // uscirebbero NUDI: `impaginazione.ts` non disegna più né banda né logo né piede,
    // perché ce li ha la carta vera, e un foglio a cui nessuno la stende esce **peggio**
    // di com'era prima di questo lavoro.
    const reso = protocollo
      ? composto
      : { ...composto, pdf: await applicaCartaIntestata(composto.pdf) }

    // ── 6. L'archiviazione nel fascicolo ──────────────────────────────────────
    // I fogli di SEZIONE non si archiviano: `student_documents` è il fascicolo di UN
    // bambino, e un elenco di venticinque non appartiene a nessuno di loro. Si consegna
    // e basta — che è anche ciò che dice il registro (`archiviazione: 'nessuna'`).
    const archivio =
      contesto.soggetto === 'alunno' && voce.archiviazione === 'student_documents'
        ? await archiviaNelFascicolo(supabase, request, {
            prefillAlunnoId: contesto.prefill.alunnoId,
            sezioneId: contesto.prefill.sezioneId,
            slug: voce.slug,
            descrizione: descrizioneArchivio(voce, protocollo?.numeroFormattato ?? null),
            titolo: reso.titolo,
            pdf: reso.pdf,
            scadenza: scadenzaDaRisposte(reso.risposte),
            caricatoDa: user.id,
          })
        : { esito: 'non-previsto' as const, documentoId: null }

    // ── 6bis. L'estrazione di sezione si REGISTRA, una riga per bambino ───────
    if (contesto.soggetto === 'sezione') {
      await tracciaStampaSezione(supabase, request, contesto.sezione, voce.slug, user.id)
    }

    // ── 7. Il log del successo ────────────────────────────────────────────────
    // Senza, «nessun log» non distingue «tutto bene» da «non è mai partito niente». Solo
    // uuid, enumerati e conteggi: mai un nome, mai un codice fiscale, mai un'allergia.
    //
    // ⚠️ `generato-incompleto` NON è un dettaglio d'etichetta. `render.ts` dichiara che un
    // `blocchiDopoFirmaNonStampati > 0` significa «foglio incompleto, non sbagliato» e che
    // chi lo riceve non lo dichiari completo: succede sul n. 31, dove il tagliando da
    // ritagliare non entra nel PDF perché finirebbe sotto la firma del legale
    // rappresentante. Quel foglio va a un istituto terzo mancando di una parte che il
    // destinatario si aspetta, e con un log che dicesse «generato» nessuno lo saprebbe mai.
    const incompleto = reso.blocchiDopoFirmaNonStampati > 0
    logEvento('modulistica', 'info', {
      operazione: 'prestampati/genera:POST',
      esito: incompleto ? 'generato-incompleto' : 'generato',
      utente: user.id,
      ruolo: user.role,
      tipo: voce.slug,
      scuola_id: sedeScrittura,
      alunno_id: contesto.soggetto === 'alunno' ? contesto.prefill.alunnoId : undefined,
      sezione_id: contesto.soggetto === 'sezione' ? contesto.sezione.sezioneId : undefined,
      protocollo_numero: protocollo?.numero,
      protocollo_anno: protocollo?.anno,
      archiviato: archivio.esito === 'archiviato',
      // È un numero, quindi passa la lista bianca e si conta in SQL. La chiave NON si
      // chiama `blocchi_dopo_firma`: `firma` è una radice segreta di `redact`, e quel
      // campo uscirebbe redatto proprio dal presidio che serve ad altro.
      blocchi_non_stampati: reso.blocchiDopoFirmaNonStampati,
      n: reso.pdf.byteLength,
    })

    // ─── QUI ORIGINALE E TIMBRATO SONO LO STESSO FOGLIO — e va detto ──────────
    //
    // Fino al 2026-08-15 queste righe spiegavano una divergenza deliberata: la route
    // sorella (`admin/protocolli/genera-documento`) restituisce il PDF con la fascia di
    // segnatura, questa restituiva l'originale senza. La ragione era il §4.3 — il riquadro
    // di verifica afferma «l'impronta SHA-256 di QUESTO documento è registrata nel registro
    // di protocollo», e l'impronta registrata era quella dei byte PRIMA della fascia,
    // quindi consegnare il timbrato rendeva falsa una frase stampata su un atto diretto a
    // un ente.
    //
    // Sulla carta intestata quella distinzione non esiste più, ed è un miglioramento:
    // `applicaCartaIntestata(pdf, { segnatura })` stende carta e segnatura in una passata
    // sola, quindi il foglio che esce da qui, quello archiviato come originale, quello
    // archiviato come timbrato e quello di cui si registra l'impronta **sono lo stesso
    // file**. La frase del §4.3 è finalmente vera per chi il foglio ce l'ha in mano: se
    // ricalcola lo SHA-256 di ciò che ha scaricato, trova esattamente ciò che il registro
    // ha scritto.
    //
    // E il numero di protocollo è sul foglio una volta sola, nella segnatura: la riga di
    // corpo del §4.1 tace quando la segnatura c'è (`OpzioniStampa.protocolloInSegnatura`).
    const nomeFile = `${slugNomeFile(reso.titolo)}.pdf`
    return new NextResponse(Buffer.from(reso.pdf), {
      status: 201,
      headers: {
        'Content-Type': MIME_PDF,
        'Content-Disposition': `attachment; filename="${nomeFile}"`,
        // Un documento con i dati di un minore non si lascia nella cache di nessuno.
        'Cache-Control': 'no-store',
        'X-Prestampato-Modello': voce.slug,
        // L'esito dell'archiviazione viaggia con il foglio, e non è un dettaglio: quando è
        // `fallita` il documento È stato generato (e magari protocollato) ma NON è nel
        // fascicolo. Dirlo in un header è meno di dirlo in un JSON — che qui non c'è, perché
        // il corpo sono i byte del PDF — ed è molto più di non dirlo affatto.
        'X-Prestampato-Archiviato': archivio.esito,
        // Stesso ragionamento dell'header qui sopra: chi consegna quel foglio deve poter
        // sapere che una parte non c'è. Sul n. 31 è il tagliando che l'istituto
        // destinatario dovrebbe ritagliare e rispedire — se manca, la lettera parte lo
        // stesso e la risposta non torna mai, e nessuno collega le due cose.
        ...(incompleto ? { 'X-Prestampato-Incompleto': String(reso.blocchiDopoFirmaNonStampati) } : {}),
        ...(archivio.documentoId ? { 'X-Prestampato-Documento': archivio.documentoId } : {}),
        ...(protocollo ? { 'X-Prestampato-Protocollo': protocollo.numeroFormattato } : {}),
      },
    })
  } catch (err) {
    // Il messaggio interno resta nel log: su una rotta che genera i documenti di un minore,
    // il testo di un'eccezione può nominare tabelle, colonne e percorsi di storage.
    logErrore({ operazione: 'prestampati/genera:POST', stato: 500 }, err)
    return NextResponse.json(
      {
        error: 'Non è stato possibile generare il documento. Riprova fra qualche minuto.',
        codice: 'PRESTAMPATO_NON_GENERATO',
      },
      { status: 500 },
    )
  }
})

// ─── Il soggetto ────────────────────────────────────────────────────────────────

/**
 * Il precompilato del soggetto che il modello dichiara, con il suo gate di portata.
 *
 * Per l'ALUNNO il gate è dentro `caricaPrefillAlunno` (`requireParentOfStudent`), che
 * risponde già 403 a un bambino di un'altra sede, 404 a uno che non c'è, 409 a uno
 * archiviato o anonimizzato. Nessuna di quelle regole si riscrive qui.
 */
async function caricaContesto(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  voce: VocePrestampato,
  input: {
    alunnoId?: string
    sezioneId?: string
    risposte: Record<string, unknown>
    /** La sede già risolta al passo 2: la sezione deve essere sua, o non si legge. */
    sedeScrittura: string
  },
): Promise<{ contesto: ContestoPrestampato; response?: undefined } | { response: NextResponse }> {
  if (voce.soggetto === 'sezione') {
    // Anche qui `sections` si legge due volte (qui dentro e in `caricaSezione`): il
    // perché e la riparazione — che sta in `src/lib/auth/scope.ts` — sono scritti accanto
    // alla stessa chiamata nel GET (`../route.ts`).
    const fuoriPortata = await assertSezioneInScope(supabase, user, input.sezioneId)
    if (fuoriPortata) return { response: fuoriPortata }

    // Delle tre stampe del n. 49, ciascuna legge SOLO ciò che stampa: l'elenco né diete né
    // telefoni, il foglio della cucina le diete, quello delle emergenze anche i recapiti.
    // Quale sia lo dice `stampa`, e se la risposta è malformata lo schema del modello la
    // rifiuterà comunque poco più avanti. Nel dubbio si legge di meno.
    //
    // `sediAmmesse` porta la sede dichiarata: il confronto fra la sede della sezione e
    // quella su cui si sta scrivendo avviene così PRIMA che i venticinque bambini vengano
    // letti, invece che dopo. Il controllo del chiamante resta — è quello che copre
    // l'alunno — e da qui in poi può solo confermare.
    const caricata = await caricaSezione(supabase, input.sezioneId ?? '', {
      ...letturaPerStampa(input.risposte),
      sediAmmesse: [input.sedeScrittura],
    })
    if (caricata.response) return { response: caricata.response }
    return { contesto: { soggetto: 'sezione', sezione: caricata.sezione } }
  }

  const esito = await caricaPrefillAlunno(request, supabase, input.alunnoId ?? '')
  if (esito.response) return { response: esito.response }
  return { contesto: { soggetto: 'alunno', prefill: esito.prefill } }
}

/**
 * L'estrazione di sezione nel registro degli accessi: UNA RIGA PER BAMBINO.
 *
 * Lo pretende la specifica, ed è il punto 2 delle regole comuni del n. 49: «Ogni
 * generazione è tracciata in `fascicolo_accessi_audit`: chi ha stampato l'elenco di quale
 * sezione e quando. Un foglio con nomi, allergie e telefoni di venti bambini è
 * un'estrazione di dati personali, anche se serve a lavorare.» Il registro è per ALUNNO —
 * `alunno_id` è NOT NULL — quindi venticinque bambini fanno venticinque righe: non c'è una
 * riga «di sezione» da scrivere, e inventarne una significherebbe che il giorno in cui una
 * famiglia chiede chi ha letto i dati di suo figlio quella stampa non risulterebbe.
 *
 * Le righe si scrivono in parallelo e la stampa non le aspetta come condizione: il PDF è
 * già composto e il foglio esce comunque. Un audit che fallisce non si perde però in
 * silenzio — `logAccessoFascicolo` scrive un `error` in `app_log` per ciascuna riga che
 * non è entrata.
 */
async function tracciaStampaSezione(
  supabase: SupabaseClient,
  request: NextRequest,
  sezione: ContestoSezione,
  slug: string,
  utenteId: string,
): Promise<void> {
  await Promise.all(
    sezione.idAlunni.map((alunnoId) =>
      logAccessoFascicolo(supabase, {
        alunnoId,
        utenteId,
        azione: 'list',
        finalita: `Stampa di sezione ${slug}`,
        request,
      }),
    ),
  )
}

// ─── Il protocollo in uscita ────────────────────────────────────────────────────

interface EsitoProtocollo {
  numero: number
  anno: number
  numeroFormattato: string
  reso: EsitoRender<unknown>
  response?: undefined
}

/**
 * Numero → render → segnatura → upload → riga di registro, nell'ordine che la specifica
 * impone (§4.1: la fascia si appone DOPO la generazione; §4.3: l'impronta è quella del PDF
 * PRIMA della fascia, la stessa che finisce in `protocolli.impronta_sha256`).
 *
 * ⚠️ LA PROVA A VUOTO, prima di toccare la numerazione. Il render viene chiamato una volta
 * in più con `copiaFamiglia` — che è l'altra forma legittima dello stesso foglio (§4.1) e
 * quindi non ha bisogno di un numero — solo per vedere se quel foglio sarebbe generabile.
 * Quei byte si buttano e non escono da questa funzione.
 *
 * ─── QUANTO COSTA, DETTO INVECE CHE TACIUTO ─────────────────────────────────────
 *
 * Costa **un secondo giro di jsPDF** a ogni documento protocollato, e le righe di log che
 * `assembla()` emette escono DOPPIE: per il n. 31 il `warn` `blocchi-dopo-firma-non-stampati`
 * compare due volte per una sola generazione. Chi conta quelle righe in SQL lo deve sapere.
 *
 * ─── PERCHÉ NON BASTA VALIDARE LE RISPOSTE ──────────────────────────────────────
 *
 * La strada economica sarebbe una `validaRisposte()` che chiama solo `modello.schema
 * .safeParse` e non compone niente. Non basta, e per un motivo che è rimasto vero anche
 * dopo che il caso più frequente è stato spostato a monte: i rifiuti di CONTESTO di
 * `render.ts` non parlano delle risposte, e uno schema che le accetta non dice niente su di
 * loro. Il più caro dei tre — il nome del legale rappresentante assente, che il 2026-08-14
 * in sola lettura risultava mancante su **tutte e 4** le righe di `scuole` — oggi lo
 * intercetta il passo `3ter` della route, prima di arrivare qui; restano gli altri, e
 * restano i modelli nuovi che domani ne porteranno di propri.
 *
 * Quel che questa prova compra davvero, e che nessuna validazione di schema comprerebbe: un
 * rifiuto qualunque del render dopo la numerazione lascerebbe un buco in un registro WORM, e
 * i buchi non si richiudono. Il test «una risposta mancante è un 400 sul CAMPO, e non brucia
 * un numero di protocollo» è la misura di questa riga.
 *
 * La riparazione vera è in `render.ts` — un modo di chiedere «sarebbe generabile?» che si
 * fermi prima di jsPDF — e quel file non è di questa mano: è segnalato, non fatto.
 */
async function protocollaEComponi(
  supabase: SupabaseClient,
  input: {
    voce: VocePrestampato
    contesto: ContestoPrestampato
    risposte: Record<string, unknown>
    carta: { intestazione: string[]; luogoData: string }
    legaleRappresentante: string | null
    operatore: string | null
    scuolaId: string
    createdBy: string
  },
): Promise<EsitoProtocollo | { response: NextResponse; reso?: undefined }> {
  const opzioniBase = {
    carta: input.carta,
    legaleRappresentante: input.legaleRappresentante,
  }

  const prova = componiPrestampato(
    input.voce,
    input.contesto,
    input.risposte,
    { ...opzioniBase, copiaFamiglia: true },
    input.operatore,
  )
  if (!prova.ok) return { response: rispostaRifiuto(prova) }

  const anno = annoFiscale()
  const { data: numeroGrezzo, error: erroreNumero } = await supabase.rpc(
    'prossimo_numero_protocollo',
    { p_scuola: input.scuolaId, p_anno: anno },
  )
  if (erroreNumero) {
    // PostgREST non lancia: senza questo ramo si proseguirebbe con `numero = NaN`.
    logErrore(
      {
        operazione: 'prestampati/genera:POST',
        evento: `protocollo-numero:${(erroreNumero as { code?: string }).code ?? 'ignoto'}`,
      },
      erroreNumero,
    )
    return { response: rispostaProtocolloNonRiuscito() }
  }
  const numero = Number(numeroGrezzo)
  if (!Number.isInteger(numero) || numero < 1) {
    logEvento('modulistica', 'error', {
      operazione: 'prestampati/genera:POST',
      esito: 'protocollo-numero-non-valido',
      scuola_id: input.scuolaId,
    })
    return { response: rispostaProtocolloNonRiuscito() }
  }

  const quando = new Date()
  const numeroFormattato = formatNumeroProtocollo(numero, anno)
  const protocollo: ProtocolloRender = {
    numero: numeroFormattato,
    data: dataOraItaliana(quando).data,
  }

  const reso = componiPrestampato(
    input.voce,
    input.contesto,
    input.risposte,
    { ...opzioniBase, protocollo },
    input.operatore,
  )
  if (!reso.ok) {
    // Il numero è già stato consumato: resta un buco nella numerazione, che è il rischio
    // dichiarato dal design del registro (`store.ts`, rischio #3). Va però LOGGATO, perché
    // un buco senza spiegazione, fra sei mesi, è una domanda a cui nessuno sa rispondere.
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/genera:POST',
      esito: 'protocollo-bruciato-render-fallito',
      tipo: input.voce.slug,
      scuola_id: input.scuolaId,
      protocollo_numero: numero,
      protocollo_anno: anno,
    })
    return { response: rispostaRifiuto(reso) }
  }

  // ─── LA CARTA DELLA SCUOLA, E LA SEGNATURA, IN UNA CHIAMATA SOLA ──────────────
  //
  // Fino al 2026-08-15 qui c'era `applicaSegnatura(reso.pdf, { righe, logoPng })`, e
  // andava bene quando il motore disegnava da sé una banda verde in cima al foglio. Ora
  // non la disegna più — ce l'ha la carta intestata vera — e comporre le due cose in
  // sequenza produceva, misurato: la fascia verde di `applicaSegnatura` **sopra il
  // marchio della scuola** (che finisce a 26,8 mm), un SECONDO logo Kidville sopra il
  // primo, e la carta riscalata di 777,89/841,89 = 0,924 e ricentrata — cioè il piede a
  // quattro colonne staccato dal fondo del foglio, con due margini bianchi ai lati.
  // Sono, alla lettera, i difetti n. 1 e n. 2 della specifica.
  //
  // `applicaSegnatura()` resta il timbro dei documenti **acquisiti** (una scansione, una
  // foto), che arrivano su un foglio bianco dove la fascia non copre niente. Il lock che
  // lo tiene è in `__tests__/lib/carta-applica.test.ts`.
  //
  // Il numero di protocollo esce da qui una volta sola: `assembla()` spegne la riga
  // «Prot. n. …» nel corpo quando il documento è protocollato, perché la segnatura la
  // contiene già (`OpzioniStampa.protocolloInSegnatura`). Prima ci stava due volte, a
  // diciotto millimetri di distanza, su un certificato diretto all'INPS.
  const denominazione = await denominazioneScuola(supabase, input.scuolaId)
  const suCarta = await applicaCartaIntestata(reso.pdf, {
    segnatura: { righe: righeSegnatura({ denominazione, numero, anno, tipo: 'uscita', quando }) },
  })
  // Da qui in giù il documento È questo: quello che si consegna, quello che si archivia e
  // quello di cui si registra l'impronta sono lo stesso file. È un miglioramento e va
  // detto: il riquadro di verifica stampato in fondo afferma «l'impronta SHA-256 di
  // QUESTO documento è registrata nel registro di protocollo», e prima l'impronta
  // registrata era quella dei byte PRIMA della fascia — cioè di un file che nessuno aveva
  // in mano. Ora quella frase è vera per chi tiene il foglio.
  const documento = { ...reso, pdf: suCarta }

  const percorsi = pathDefinitivi(input.scuolaId, anno, numero)
  const pathOriginale = percorsi.originale('pdf')
  const storage = supabase.storage.from(PROTOCOLLO_BUCKET)
  const caricati: string[] = []

  await ensureBucket(supabase)

  try {
    // Due percorsi, gli STESSI byte: il documento generato nasce già segnato — il
    // registro protocolli ha due colonne (`file_originale`, `file_timbrato`) perché su un
    // documento ACQUISITO l'originale è la scansione com'è arrivata e il timbrato è la
    // copia con la fascia. Qui l'una e l'altra sono lo stesso foglio, e scriverlo due
    // volte è meno pericoloso che far puntare due colonne allo stesso file: la rettifica
    // di un protocollo sostituisce l'originale e rigenera il timbrato, e con un percorso
    // solo si sovrascriverebbero a vicenda.
    for (const [path, bytes] of [
      [pathOriginale, documento.pdf],
      [percorsi.timbrato, documento.pdf],
    ] as const) {
      const { error } = await storage.upload(path, Buffer.from(bytes), {
        contentType: MIME_PDF,
        upsert: true,
      })
      // Il CORPO dell'errore, non solo il suo codice: `403` non dice niente, `403 "new row
      // violates row-level security policy"` dice tutto.
      if (error) throw new Error(`Archiviazione protocollo non riuscita: ${error.message}`)
      caricati.push(path)
    }

    // La riga di registro è l'ULTIMO passo, e non è un dettaglio d'ordine: dopo di lei non
    // c'è niente che possa fallire, quindi non serve mai disfarla. È ciò che distingue
    // questa sequenza da `registraProtocollo`, che inserisce anche gli allegati DOPO e per
    // quello deve poter chiamare `protocollo_elimina` — l'unica via di DELETE che il
    // trigger WORM ammette. Non averne bisogno è meglio che usarla bene.
    const { error: erroreInsert } = await supabase
      .from('protocolli')
      .insert({
        scuola_id: input.scuolaId,
        anno,
        numero,
        tipo: 'uscita',
        data_registrazione: quando.toISOString(),
        oggetto: oggettoProtocollo(input.voce, input.contesto),
        // Una funzione sola per i due campi, e non è uno sfizio: sono le due metà della
        // stessa frase — «a chi va» e «come ci arriva» — e finiscono su una riga di
        // registro WORM che nessuno rettificherà. Vedi `destinazioneProtocollo`.
        ...destinazioneProtocollo(input.voce, input.contesto, documento.risposte),
        impronta_sha256: sha256Impronta(documento.pdf),
        file_originale: pathOriginale,
        file_timbrato: percorsi.timbrato,
        file_nome_originale: `${slugNomeFile(documento.titolo)}.pdf`,
        file_mime: MIME_PDF,
        file_size: documento.pdf.byteLength,
        created_by: input.createdBy,
      })
    if (erroreInsert) {
      // PostgREST non lancia: il `throw` lo scrive questa riga, perché il rollback dei file
      // vive nel `catch`. Il CORPO dell'errore, non solo il codice.
      throw new Error(`Registrazione a protocollo non riuscita: ${erroreInsert.message}`)
    }

    return { numero, anno, numeroFormattato, reso: documento }
  } catch (err) {
    // Rollback best-effort dei soli FILE: la riga di registro, se c'è, non è mai da
    // disfare (vedi sopra). Se anche la rimozione fallisce resta un file orfano nel
    // bucket — che è molto meglio di una riga di registro che punta a un file che non c'è.
    logErrore({ operazione: 'prestampati/genera:POST', evento: 'protocollo-non-registrato' }, err)
    if (caricati.length > 0) {
      await rimuoviFile(supabase, PROTOCOLLO_BUCKET, caricati, { tipo: input.voce.slug })
    }
    return { response: rispostaProtocolloNonRiuscito() }
  }
}

/**
 * Il 503 di un protocollo che non si è potuto registrare.
 *
 * Il documento NON viene consegnato, ed è deliberato: un certificato in uscita senza la
 * sua riga nel registro è un foglio che dichiara un numero che nessun registro conferma.
 * Meglio riprovare fra un minuto che consegnarlo.
 */
function rispostaProtocolloNonRiuscito(): NextResponse {
  return NextResponse.json(
    {
      error:
        'Non è stato possibile registrare il documento al protocollo: non è stato generato niente. Riprova fra qualche minuto.',
      codice: 'PRESTAMPATO_NON_GENERATO',
    },
    { status: 503 },
  )
}

/** L'oggetto della riga di registro: che documento è, e di chi parla. */
function oggettoProtocollo(voce: VocePrestampato, contesto: ContestoPrestampato): string {
  if (contesto.soggetto !== 'alunno') return voce.etichetta
  const a = contesto.prefill.dati.alunno
  return `${voce.etichetta} — ${a.cognome} ${a.nome}`.trim()
}

/**
 * A CHI VA IL FOGLIO E COME CI ARRIVA — i due campi insieme, decisi dalla stessa leva.
 *
 * È la riga più facile da scrivere sbagliata: il registro protocolli è WORM, e ciò che
 * finisce qui ci resta per sempre. Erano due funzioni, e le due leve non erano la stessa —
 * il destinatario guardava le RISPOSTE (c'è un campo `istituto`? allora è l'istituto), il
 * mezzo guardava il MODELLO. Sul nulla osta le due si contraddicevano su una riga sola:
 * `destinatario = «Istituto Comprensivo X»` e `mezzo = «Consegna a mano»`, cioè un atto
 * consegnato a mano a una scuola che sta in un altro comune. Il n. 30 ha il campo `istituto`
 * — è l'istituto di DESTINAZIONE del bambino, cioè l'OGGETTO del nulla osta — ma il foglio
 * lo prende la famiglia («Dopo la generazione: PDF in `student_documents` + copia al
 * genitore», `docs/prestampati/30-nulla-osta.md`).
 *
 * La leva è una sola, ed è `archiviazione`, che nel registro dei diciassette è già la riga
 * che distingue i due destini:
 *
 *  · `'protocolli'` — solo il n. 31: «nessuna copia nel fascicolo dell'alunno: è
 *    corrispondenza fra istituti». Il destinatario è l'ISTITUTO, che qui è davvero chi
 *    riceve la lettera. Il mezzo resta **`null`** (la colonna è `text` e ammette il nullo),
 *    perché questa route non spedisce niente — non c'è invio per email né per PEC — e
 *    scrivere «Email/PEC» sarebbe falso quanto «Consegna a mano». Lo compilerà l'invio,
 *    quando esisterà, o la rettifica del protocollo, che registra chi l'ha scritto. Un campo
 *    vuoto è una domanda aperta; un campo pieno di una cosa mai avvenuta è una risposta
 *    sbagliata che nessuno rileggerà più;
 *  · tutti gli altri — nulla osta e certificati — vanno alla FAMIGLIA, e nascono allo
 *    sportello davanti a chi li ha chiesti: «Consegna a mano» è vero, ed è anche ciò che
 *    scrive la route sorella del registro protocolli.
 *
 * `risposte` sono quelle GIÀ VALIDATE dallo schema del modello, non il corpo grezzo: sul
 * n. 31 `istituto` è una stringa non vuota per costruzione. Il ripiego esiste lo stesso,
 * perché un registro senza destinatario è una riga che non si sa più leggere.
 */
function destinazioneProtocollo(
  voce: VocePrestampato,
  contesto: ContestoPrestampato,
  risposte: unknown,
): { destinatario: string; mezzo: string | null } {
  if (voce.archiviazione === 'protocolli') {
    const istituto =
      typeof risposte === 'object' && risposte !== null
        ? (risposte as { istituto?: unknown }).istituto
        : undefined
    const nome = typeof istituto === 'string' ? istituto.trim() : ''
    return { destinatario: nome || 'Istituto destinatario non indicato', mezzo: null }
  }
  if (contesto.soggetto !== 'alunno') return { destinatario: 'Uso interno', mezzo: 'Consegna a mano' }
  const a = contesto.prefill.dati.alunno
  return {
    destinatario: `Famiglia dell'alunno/a ${a.cognome} ${a.nome}`.trim(),
    mezzo: 'Consegna a mano',
  }
}

// ─── L'archiviazione nel fascicolo ──────────────────────────────────────────────

type EsitoArchiviazione = { esito: 'archiviato' | 'fallita' | 'non-previsto'; documentoId: string | null }

/** La descrizione che l'elenco del fascicolo mostra. Nessun dato personale: c'è già il PDF. */
function descrizioneArchivio(voce: VocePrestampato, numeroFormattato: string | null): string {
  return numeroFormattato ? `${voce.etichetta} — Prot. n. ${numeroFormattato}` : voce.etichetta
}

/**
 * I codici con cui Postgres/PostgREST dicono «lo SCHEMA non regge», distinti da quelli con
 * cui dicono «adesso non si può».
 *
 * La differenza decide il destino del PDF già caricato: un guasto transitorio si riprova e
 * il file va tolto (resterebbe orfano), una lacuna di schema NON si riprova — riproverà
 * uguale domani — e il file è l'unica copia recuperabile il giorno in cui lo schema si
 * allarga. `22P02` è il valore fuori dall'enumerato, gli altri quattro sono la colonna o la
 * tabella che non esistono (il DB E2E della CI è un progetto separato e non è migrato).
 */
const SCHEMA_NON_PRONTO = new Set(['22P02', 'PGRST204', '42703', '42P01', 'PGRST205'])

/**
 * Il PDF nel fascicolo del bambino: file nel bucket privato già in uso, riga in
 * `student_documents` con il `document_type` del modello.
 *
 * 🔴 `document_type` È UN ENUMERATO, E NESSUNO DEI DICIASSETTE SLUG CI STA DENTRO.
 * Misurato in produzione il 2026-08-14, in sola lettura:
 * `SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE
 * t.typname = 'document_type_enum'` → `diagnosi`, `pei`, `104`, `pdp`. Sono i quattro del
 * baseline (`supabase/migrations/20260704120000_baseline.sql:43`) e nessuna migrazione ne
 * ha aggiunti. Postgres rifiuta quindi l'INSERT con `22P02 invalid input value for enum`,
 * e dal codice non si aggira: allargare l'enumerato è una migrazione, e le migrazioni su
 * questo database sono vietate dal titolare.
 *
 * Perciò OGGI, in produzione, tutti e quattro i modelli archiviabili che nascono qui
 * (`nulla_osta`, `certificato_competenze`, `certificato_iscrizione_frequenza`,
 * `certificato_bonus_nido`) escono con `X-Prestampato-Archiviato: fallita`. Va detto qui,
 * dove qualcuno lo legge, invece di lasciarlo scoprire a chi apre l'«Archivio firmati» e lo
 * trova vuoto.
 *
 * Le due strade sbagliate, dette perché nessuno le prenda credendole ovvie — sono le stesse
 * che ha scritto la route gemella della famiglia (`parent/prestampati/firma`), e le due
 * mani sono arrivate alla stessa conclusione lo stesso giorno:
 *  · **ripiegare su un valore ammesso** («un nulla osta è quasi un pdp») metterebbe nel
 *    fascicolo di un minore un tipo di documento FALSO;
 *  · **rispondere 500** butterebbe via un documento generato e — sui protocollati — già
 *    registrato, cioè trasformerebbe una lacuna dello schema nella perdita di un atto, e
 *    manderebbe a rigenerare consumando un secondo numero di protocollo.
 *
 * Quindi: il PDF **resta nel bucket** (è l'unica copia recuperabile il giorno in cui
 * l'enumerato si allarga), la riga non si crea, l'esito lo dichiara l'header, e il
 * fallimento è un `error` in `app_log` — canale persistito, interrogabile in SQL: è così
 * che si conta quanti documenti stanno aspettando l'enumerato. Il giorno in cui i
 * diciassette slug ci entrano, questo codice comincia a funzionare senza che nessuno lo
 * tocchi.
 *
 * ⚠️ NON fa fallire la richiesta, per la ragione detta sopra: il foglio si consegna,
 * l'esito viaggia nell'header `X-Prestampato-Archiviato`, e il fallimento è nei log — col
 * CORPO dell'errore, non col solo codice.
 */
async function archiviaNelFascicolo(
  supabase: SupabaseClient,
  request: NextRequest,
  input: {
    prefillAlunnoId: string
    sezioneId: string | null
    slug: string
    descrizione: string
    titolo: string
    pdf: Uint8Array
    scadenza: string | null
    caricatoDa: string
  },
): Promise<EsitoArchiviazione> {
  const nomeFile = `${slugNomeFile(input.titolo)}.pdf`
  const path = `${input.prefillAlunnoId}/prestampati/${input.slug}-${Date.now()}.pdf`

  const { error: erroreUpload } = await supabase.storage
    .from(BUCKET_FASCICOLO)
    .upload(path, Buffer.from(input.pdf), { contentType: MIME_PDF, upsert: true })
  if (erroreUpload) {
    logEvento('storage', 'error', {
      operazione: 'prestampati/genera:POST',
      esito: 'fascicolo-file-non-caricato',
      bucket: BUCKET_FASCICOLO,
      tipo: input.slug,
      alunno_id: input.prefillAlunnoId,
      // Il CORPO dell'errore dello storage NON si butta via: arriva dal parametro `err`,
      // che `descriviErrore` scrive per esteso nella riga persistita. Ripeterlo qui fra i
      // campi lo farebbe solo redigere — la lista bianca è per chiave, e una chiave
      // `messaggio` è testo libero.
    }, erroreUpload)
    // ⚠️ IL PERCHÉ SI CERCA SOLO ADESSO, e prima si cercava sempre: la verifica del bucket
    // stava SOPRA l'upload e faceva un `listBuckets()` a ogni archiviazione — anche a
    // quelle riuscite, dove il suo unico prodotto era niente. Serve a spiegare un
    // fallimento, quindi si chiama dove un fallimento c'è, e DOPO la riga che lo dichiara:
    // in `app_log` si legge prima il fatto e poi la sua spiegazione, non il contrario.
    await spiegaFallimentoBucket(supabase)
    return { esito: 'fallita', documentoId: null }
  }

  const { data, error } = await supabase
    .from('student_documents')
    .insert({
      student_id: input.prefillAlunnoId,
      section_id: input.sezioneId,
      document_type: input.slug,
      descrizione: input.descrizione,
      file_name: nomeFile,
      storage_path: path,
      // Path privato: il download avviene via signed URL, mai `getPublicUrl`.
      file_url: path,
      expiry_date: input.scadenza,
      caricato_da: input.caricatoDa,
    })
    .select('id')
    .single()
  if (error) {
    // PostgREST non lancia: il valore di ritorno va controllato, sempre.
    const codice = (error as { code?: string }).code ?? null
    const schemaNonPronto = SCHEMA_NON_PRONTO.has(codice ?? '')
    logEvento('modulistica', 'error', {
      operazione: 'prestampati/genera:POST',
      // Due esiti distinti, e non è pedanteria: il primo è la lacuna dell'enumerato — si
      // conta, non si indaga — il secondo è un guasto vero. Con un esito solo, la riga
      // che segnala un difetto sarebbe sepolta sotto quelle che segnalano il noto.
      esito: schemaNonPronto ? 'fascicolo-schema-non-pronto' : 'fascicolo-riga-non-scritta',
      entita_tipo: 'student_documents',
      tipo: input.slug,
      alunno_id: input.prefillAlunnoId,
      error_code: codice,
    }, error)
    // Il file si toglie SOLO quando ritentare ha senso. Se è lo schema a non reggere
    // (`22P02` sull'enumerato), riprovare darebbe lo stesso errore domani e il PDF nel
    // bucket è l'unica copia che resta: buttarlo via significherebbe che il giorno in cui
    // l'enumerato si allarga non c'è più niente da agganciare.
    if (!schemaNonPronto) {
      await rimuoviFile(supabase, BUCKET_FASCICOLO, [path], {
        tipo: input.slug,
        alunnoId: input.prefillAlunnoId,
      })
    }
    return { esito: 'fallita', documentoId: null }
  }

  const documentoId = String((data as { id: string }).id)

  // ── IL REGISTRO DEGLI ACCESSI AL FASCICOLO ────────────────────────────────
  // Regola 5 di `docs/prestampati/README.md`, e la stessa riga che scrive
  // `primaria/fascicolo:POST` sul suo INSERT. `app_log` non è un sostituto: ha trenta
  // giorni di retention e non è il registro che si mostra a chi chiede chi ha toccato il
  // fascicolo di suo figlio. Dopo l'insert e non prima: si registra ciò che è successo.
  await logAccessoFascicolo(supabase, {
    alunnoId: input.prefillAlunnoId,
    utenteId: input.caricatoDa,
    azione: 'upload',
    documentoId,
    finalita: `Prestampato ${input.slug} generato allo sportello`,
    request,
  })

  return { esito: 'archiviato', documentoId }
}

/**
 * Perché l'upload nel fascicolo è appena fallito: il bucket non c'è, o è un altro guasto.
 *
 * ⚠️ SI CHIAMA DOPO UN UPLOAD FALLITO, e non prima di ognuno. La versione precedente
 * girava a ogni archiviazione — un `listBuckets()` in più su ogni foglio, anche quando
 * andava tutto bene — e il suo unico prodotto era una riga di log nel caso in cui il bucket
 * mancasse: cioè esattamente il caso in cui l'upload subito dopo falliva comunque, con il
 * proprio corpo d'errore («Bucket not found»), che è il rimedio che questa funzione stessa
 * dichiara. Spostarla di sei righe non toglie niente e non fa pagare la chiamata alle
 * archiviazioni riuscite, che sono tutte quelle che contano.
 *
 * Il bucket c'è? Si guarda, e NON si crea.
 *
 * 🔴 QUESTA FUNZIONE IL BUCKET LO CREAVA, ed era il modo silenzioso di rompere il fascicolo
 * di tutta la scuola. `sensitive_documents` è CONDIVISO e il suo proprietario è
 * `src/app/api/primaria/fascicolo/route.ts`, che lo crea con quattro tipi ammessi — PDF,
 * JPEG, PNG, WEBP (costante `ALLOWED`, riga 15) — perché il contenuto principale di un
 * fascicolo sono le SCANSIONI: carte d'identità, referti, verbali fotografati. Qui veniva
 * creato con `allowedMimeTypes: ['application/pdf']` e basta, e vince chi arriva primo:
 * bastava generare un prestampato prima del primo caricamento nel fascicolo perché ogni
 * immagine venisse poi rifiutata dallo storage, con un errore che parla di MIME e non nomina
 * mai chi ha creato il bucket. Il commento che stava qui dichiarava «garanzia idempotente,
 * come in `primaria/fascicolo`»: la parità che affermava non esisteva, ed è la parte che
 * nessuno riverifica.
 *
 * 🔴 E NON ERA UN'IPOTESI: in produzione quel bucket **non esiste ancora**. La fotografia
 * dello storage — `__tests__/fixtures/bucket-storage-snapshot.json`, generata l'11/08 — ne
 * elenca quattordici e `sensitive_documents` non è fra loro, perché `primaria/fascicolo` lo
 * crea alla prima scansione caricata e quella prima volta non è mai avvenuta. Chi lo avrebbe
 * creato, quindi, era questa route: al primo nulla osta generato allo sportello, con i tipi
 * MIME sbagliati, e da lì in poi il fascicolo di tutte e tre le sedi avrebbe accettato solo
 * PDF.
 *
 * La strada di ricopiare i quattro tipi è stata scartata: sarebbe una terza copia di una
 * configurazione che vive già in due file (`primaria/fascicolo` e la route gemella della
 * famiglia), e la prossima divergenza tornerebbe uguale. Importarli da `primaria/fascicolo`
 * — che è la forma giusta — vorrebbe dire esportarli da un `route.ts` che non è di questa
 * mano: segnalato, non fatto. **Una route che non è proprietaria di un bucket non lo crea.**
 *
 * Il rimedio quando manca è quello che c'era già: l'upload fallisce col PROPRIO corpo
 * d'errore e l'archiviazione si ferma, dichiarandolo nell'header. Questa riga aggiunge il
 * PERCHÉ, che senza di lei si leggerebbe solo come «Bucket not found» — e lo aggiunge a
 * livello `error`, perché un bucket assente in produzione è configurazione mancante
 * (AGENTS.md regola 4), non una nota a piè di pagina.
 *
 * ⚠️ NEMMENO IL CLIENT STORAGE RIGETTA: `listBuckets()` risolve con `{ data, error }`,
 * esattamente come PostgREST (AGENTS.md regola 7) e come `storage.remove()`, di cui
 * `rimuoviFile` racconta più sotto la stessa trappola. Qui `error` veniva scartato dalla
 * destrutturazione: il `try` intercettava solo le eccezioni, cioè il modo di fallimento che
 * questa chiamata non ha.
 */
async function spiegaFallimentoBucket(supabase: SupabaseClient): Promise<void> {
  try {
    const { data: buckets, error: erroreElenco } = await supabase.storage.listBuckets()
    if (erroreElenco) {
      // `warn` e non `error`: un elenco che non si legge non dimostra un bucket assente, e
      // il fallimento vero l'ha già dichiarato l'upload, col suo corpo d'errore.
      logEvento('storage', 'warn', {
        operazione: 'prestampati/genera:POST',
        esito: 'bucket-elenco-non-letto',
        bucket: BUCKET_FASCICOLO,
      }, erroreElenco)
      return
    }
    if (buckets?.some((b) => b.name === BUCKET_FASCICOLO)) return

    logEvento('storage', 'error', {
      operazione: 'prestampati/genera:POST',
      esito: 'bucket-fascicolo-assente',
      bucket: BUCKET_FASCICOLO,
      // Nessun corpo d'errore da riportare: non è una chiamata fallita, è una lettura
      // riuscita che dice che il bucket non c'è. Il rimedio è crearlo dove è di casa —
      // `primaria/fascicolo`, con i suoi quattro tipi MIME — non da qui.
    })
  } catch (e) {
    // Resta il guasto di TRASPORTO — il fetch che esplode prima di arrivare allo storage —
    // che è l'unico modo in cui questa chiamata lancia davvero. Un `catch` che non logga
    // sarebbe un bug (AGENTS.md regola 6).
    logEvento('storage', 'warn', {
      operazione: 'prestampati/genera:POST',
      esito: 'bucket-non-verificato',
      bucket: BUCKET_FASCICOLO,
    }, e)
  }
}

/**
 * Toglie dei file dal bucket, e DICE quando non ci riesce.
 *
 * ⚠️ `storage.remove()` NON RIGETTA: risolve con `{ data, error }`, esattamente come
 * PostgREST (AGENTS.md regola 7). Qui c'era un `.then(() => undefined, () => undefined)` —
 * la forma travestita di `.catch(() => {})`, che la regola 6 vieta — e il gestore di reject
 * era per giunta decorativo: il modo di fallimento vero, `{ error }` valorizzato, non lo
 * osservava nessuno. Restava nel bucket privato un PDF con i dati di un minore che nessuna
 * riga di database nominava, e nessun log lo diceva.
 *
 * Il livello è `warn` e non `error`, ed è una scelta: la richiesta che ha portato qui è già
 * fallita e l'ha già detto: questa riga aggiunge il fatto che quel fallimento ha lasciato
 * qualcosa dietro di sé.
 */
async function rimuoviFile(
  supabase: SupabaseClient,
  bucket: string,
  percorsi: string[],
  contesto: { tipo: string; alunnoId?: string | null },
): Promise<void> {
  const { error } = await supabase.storage.from(bucket).remove(percorsi)
  if (!error) return
  logEvento('storage', 'warn', {
    operazione: 'prestampati/genera:POST',
    esito: 'file-orfano-non-rimosso',
    bucket,
    tipo: contesto.tipo,
    n: percorsi.length,
    ...(contesto.alunnoId ? { alunno_id: contesto.alunnoId } : {}),
    // Il CORPO dell'errore arriva dal parametro `err` e `descriviErrore` lo scrive per
    // esteso: ripeterlo qui fra i campi lo farebbe solo redigere.
  }, error)
}
