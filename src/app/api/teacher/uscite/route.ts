import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente, requireUser } from '@/lib/auth/require-staff'
import { assertAlunnoInScope, assertSezioneInScope, resolveScuolaScrittura } from '@/lib/auth/scope'
import { getGenitoriDiAlunni } from '@/lib/anagrafiche/legami'
import { STATI_CON_CANALE_FAMIGLIA } from '@/lib/alunni/stato'
import { genitoriDiAlunni } from '@/lib/notifiche/destinatari'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { rateLimit } from '@/lib/security/rate-limit'
import { formatEuro } from '@/lib/format/valuta'
import {
  componiDescrizioneUscita,
  dataItalianaUscita,
  titoloUscita as componiTitoloUscita,
  MEZZI_USCITA,
  TIPI_ATTIVITA_USCITA,
} from '@/app/api/parent/prestampati/banco-famiglia'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `gruppo` e `alunno_ids` (CSV di id, split nel codice) sono entrambi opzionali
// ma almeno uno dei due deve essere valorizzato: il check incrociato resta nel
// codice con il suo 400 dedicato. Niente zUuid: gli id sono usati solo in .in().
const getQuerySchema = z.object({
  gruppo: z.string().optional(),
  alunno_ids: z.string().optional(),
  // Se valorizzato: autorizzazione PER-GITA (firma di questo specifico modulo),
  // altrimenti retro-compat (qualsiasi modulo firmato dal genitore).
  form_model_id: z.string().optional(),
  // ─── LE TRE STRADE DEL SEMAFORO, e perché sono tre ─────────────────────────
  //
  // In questo repo convivono tre modi in cui una famiglia ha autorizzato un'uscita,
  // e sono tre EPOCHE, non tre opzioni:
  //
  //  · `form_model_id` — Sistema A, `form_submissions`: la modulistica storica,
  //    firmata dal GENITORE (si passa dai legami di famiglia);
  //  · `form_id` — Sistema B, `forms_submissions`: i moduli che questa stessa
  //    route creava in `forms_templates` fino al 2026-08-15. **Non se ne creano
  //    più** (vedi la testata del POST), ma le gite già pubblicate hanno la loro
  //    riga e le famiglie l'hanno già firmata: si spegne la creazione, non la
  //    lettura;
  //  · `uscita_id` — l'id dell'evento in `eventi_agenda`, ed è la strada di oggi:
  //    la famiglia firma il prestampato n. 10, che finisce in `student_documents`
  //    (`document_type = 'autorizzazione_uscita'`) e nel fascicolo del bambino.
  //
  // 🔴 Fino al 2026-08-16 la terza non c'era, e questo è il difetto che la aggiunge:
  // spento il Sistema B era rimasto acceso il suo unico lettore, quindi per ogni
  // gita nuova il semaforo rispondeva «nessuno ha autorizzato» ANCHE con tutte le
  // famiglie che avevano firmato. Con le parole del commento più sotto: «il giorno
  // dell'uscita l'insegnante lascerebbe a scuola dei bambini autorizzati».
  form_id: z.string().optional(),
  uscita_id: zUuid.optional(),
})

// GET /api/teacher/uscite?userId=&alunno_ids=a,b,c  (oppure &gruppo=)
//   Semaforo gite/uscite per l'insegnante. Ritorna SOLO { alunno_id, autorizzato, quota_ok }.
//   MAI dati economici (nessun importo). Accesso: educator/coordinator/admin (NO genitore).
export const GET = withRoute('teacher/uscite:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    if (user.role === 'genitore') {
      return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const {
      gruppo,
      alunno_ids: alunnoIdsParam,
      form_model_id: formModelId,
      form_id: formId,
      uscita_id: uscitaId,
    } = q.data
    const alunnoIds = alunnoIdsParam ? alunnoIdsParam.split(',').map((x) => x.trim()).filter(Boolean) : []

    if (!gruppo && alunnoIds.length === 0) {
      return NextResponse.json({ error: 'Specificare gruppo o alunno_ids' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // Isolamento per sede: gli uuid degli alunni arrivano dal client. La risposta
    // dice, per ogni bambino, se e' autorizzato all'uscita e se la quota e'
    // pagata — su bambini di un'altra sede era informazione che non doveva
    // uscire. Un id fuori scope fa fallire l'intera richiesta.
    for (const aid of alunnoIds) {
      const fuoriScope = await assertAlunnoInScope(supabase, auth.user, aid)
      if (fuoriScope) return fuoriScope
    }
    const { data: cat } = await supabase
      .from('payment_categories').select('id').eq('slug', 'gita').is('scuola_id', null).single()

    // pagamenti gita rilevanti (NON selezioniamo l'importo)
    let pagQuery = supabase.from('pagamenti').select('alunno_id, stato').eq('categoria_id', cat?.id)
    if (gruppo) pagQuery = pagQuery.eq('gruppo', gruppo)
    if (alunnoIds.length > 0) pagQuery = pagQuery.in('alunno_id', alunnoIds)
    const { data: pagamenti } = await pagQuery

    // quota_ok = esiste un pagamento gita 'pagato' per quell'alunno
    const quotaOk = new Map<string, boolean>()
    const targetAlunni = new Set<string>(alunnoIds)
    for (const p of pagamenti || []) {
      targetAlunni.add(p.alunno_id)
      quotaOk.set(p.alunno_id, (quotaOk.get(p.alunno_id) ?? false) || p.stato === 'pagato')
    }

    const alunniList = [...targetAlunni]
    if (alunniList.length === 0) return NextResponse.json({ success: true, data: [] })

    // ── LA GITA DI OGGI: la firma sta nel FASCICOLO del bambino ────────────────
    //
    // Il prestampato n. 10 firmato dalla famiglia diventa una riga di
    // `student_documents` con `document_type = 'autorizzazione_uscita'`, più la
    // traccia in `firme_documenti`. Nessuna colonna lega quel documento all'evento
    // — misurato sullo schema di produzione il 2026-08-16 — e questa è la parte da
    // NON dimenticare rileggendo:
    //
    // ⚠️ QUESTO SEMAFORO DICE «HA FIRMATO UN'AUTORIZZAZIONE DOPO CHE LA GITA È STATA
    // ANNUNCIATA», non «ha firmato QUESTA gita». Il confine temporale è l'unica cosa
    // che si può pretendere senza una migrazione, e non è cosmetico: senza,
    // l'autorizzazione firmata a marzo manderebbe un bambino in gita a maggio senza
    // che nessuno abbia firmato niente per maggio. Resta scoperto il caso di due
    // uscite della stessa sezione annunciate a poca distanza: la famiglia ne vede
    // una sola alla volta nell'elenco (il n. 10 propone la PIÙ VICINA), quindi la
    // firma che arriva è per quella — ma su questo semaforo conterebbe per
    // entrambe. Il rimedio vero è una colonna che leghi il documento all'evento, ed
    // è dichiarato all'orchestratore come lacuna nota.
    if (uscitaId) {
      // L'uscita si legge PRIMA: serve il suo istante di creazione, e serve sapere
      // che esiste davvero — «non la trovo» non è «nessuno ha firmato».
      const { data: uscita, error: erroreUscita } = await supabase
        .from('eventi_agenda')
        .select('id, scuola_id, section_id, tipo, creato_il')
        .eq('id', uscitaId)
        .eq('tipo', 'uscita')
        .maybeSingle()
      if (erroreUscita) {
        // PostgREST non lancia: senza questo controllo un guasto di lettura
        // diventerebbe «l'uscita non esiste», cioè un 404 su una gita che c'è.
        logEvento('modulistica', 'error', {
          operazione: 'teacher/uscite:GET', esito: 'uscita-non-letta',
        }, erroreUscita)
        return NextResponse.json(
          { error: 'Verifica delle autorizzazioni non riuscita', codice: 'AUTORIZZAZIONI_USCITA_NON_LETTE' },
          { status: 500 }
        )
      }
      if (!uscita) {
        /**
         * ⚠️ NON SI RISPONDE «NESSUNO HA AUTORIZZATO», ed è il punto di tutto questo ramo:
         * senza l'uscita non c'è nemmeno l'istante da cui contare le firme, quindi l'unica
         * alternativa sarebbe stata contarle TUTTE — cioè dire «autorizzato» a un bambino
         * che ha firmato per la gita di marzo. Un elenco che non si può calcolare si
         * dichiara; non si stima.
         *
         * ⚠️ E IL CODICE È QUELLO DELLA LETTURA MANCATA, non uno nuovo: la frase di catalogo
         * («non siamo riusciti a leggere chi ha firmato l'autorizzazione … l'elenco mostrato
         * sarebbe incompleto») è vera anche qui, e resta fedele al fatto. Un
         * `USCITA_NON_TROVATA` sarebbe più preciso ma vive in `src/lib/ui/esito-fetch.ts` +
         * `messages/{it,en}/shared.json`, che sono di un'altra mano: è dichiarato
         * all'orchestratore. La DIAGNOSI esatta sta dove serve, cioè nel log.
         *
         * `warn` e non `error`: è un id sbagliato di chi chiama, non un guasto nostro.
         */
        logEvento('modulistica', 'warn', {
          operazione: 'teacher/uscite:GET', esito: 'uscita-non-trovata',
        })
        return NextResponse.json(
          { error: 'Verifica delle autorizzazioni non riuscita', codice: 'AUTORIZZAZIONI_USCITA_NON_LETTE' },
          { status: 500 }
        )
      }
      // La sezione dell'uscita passa dallo stesso presidio delle scritture: un id di
      // un altro plesso non deve poter dire nemmeno «quella gita esiste».
      const fuoriScope = await assertSezioneInScope(supabase, auth.user, uscita.section_id as string)
      if (fuoriScope) return fuoriScope

      // ⚠️ NIENTE `document_type` DENTRO LA QUERY, e non è una preferenza: è un
      // ENUMERATO, il DB E2E della CI non è migrato, e un valore che l'enumerazione
      // non ha risponde `22P02` — cioè questo semaforo diventerebbe un 500 su un
      // ambiente in cui tutto il resto funziona. Si legge ciò che quei bambini hanno
      // e si filtra in TypeScript, dove uno slug è una stringa.
      const { data: documenti, error: erroreDocumenti } = await supabase
        .from('student_documents')
        .select('student_id, document_type, created_at')
        .in('student_id', alunniList)
        .gte('created_at', String(uscita.creato_il ?? new Date(0).toISOString()))
      if (erroreDocumenti) {
        // Un dato sbagliato è peggio di un errore dichiarato: col silenzio
        // l'insegnante lascerebbe a scuola dei bambini autorizzati.
        logEvento('modulistica', 'error', {
          operazione: 'teacher/uscite:GET', esito: 'firme-uscita-non-lette',
        }, erroreDocumenti)
        return NextResponse.json(
          { error: 'Verifica delle autorizzazioni non riuscita', codice: 'AUTORIZZAZIONI_USCITA_NON_LETTE' },
          { status: 500 }
        )
      }
      const autorizzatiDalFascicolo = new Set(
        (documenti ?? [])
          .filter((d) => String(d.document_type ?? '').trim() === TIPO_DOCUMENTO_USCITA)
          .map((d) => d.student_id as string)
      )
      return NextResponse.json({
        success: true,
        data: alunniList.map((alunno_id) => ({
          alunno_id,
          autorizzato: autorizzatiDalFascicolo.has(alunno_id),
          quota_ok: quotaOk.get(alunno_id) ?? false,
        })),
      })
    }

    // Autorizzazione della gita del **Sistema B**, creata da questa route fino al
    // 2026-08-15: la firma sta in `forms_submissions` ed è agganciata al BAMBINO
    // (`student_id`), non al genitore — quindi il semaforo si legge in una query
    // sola e non ha bisogno dei legami di famiglia.
    //
    // ⚠️ RESTA PER LE GITE GIÀ PUBBLICATE, e solo per quelle: nuovi moduli del
    // Sistema B non ne nascono più. Cancellare questo ramo farebbe sparire
    // autorizzazioni già raccolte dalle famiglie.
    if (formId) {
      const { data: firme, error: erroreFirme } = await supabase
        .from('forms_submissions')
        .select('student_id')
        .eq('form_id', formId)
        .in('student_id', alunniList)
        .eq('is_signed', true)
      if (erroreFirme) {
        // PostgREST non lancia: senza questo controllo un guasto di lettura
        // diventerebbe «nessuno ha firmato», e il giorno dell'uscita
        // l'insegnante lascerebbe a scuola dei bambini autorizzati — un dato
        // sbagliato è peggio di un errore dichiarato.
        logEvento('modulistica', 'error', {
          operazione: 'teacher/uscite:GET', esito: 'firme-uscita-non-lette',
        }, erroreFirme)
        return NextResponse.json(
          { error: 'Verifica delle autorizzazioni non riuscita', codice: 'AUTORIZZAZIONI_USCITA_NON_LETTE' },
          { status: 500 }
        )
      }
      const autorizzati = new Set((firme ?? []).map((f) => f.student_id as string))
      return NextResponse.json({
        success: true,
        data: alunniList.map((alunno_id) => ({
          alunno_id,
          autorizzato: autorizzati.has(alunno_id),
          quota_ok: quotaOk.get(alunno_id) ?? false,
        })),
      })
    }

    // Autorizzazione firmata: un genitore collegato ha una form_submission
    // firmata. I legami arrivano dall'UNIONE runtime (`legame_genitori_alunni`)
    // + anagrafica (`student_parents` via ponte `parents.auth_user_id`) — in
    // BLOCCO sull'intera lista (3 query fisse, mai una per bambino): con la sola
    // runtime un bambino importato dal form pubblico risultava SEMPRE "non
    // autorizzato" alla gita, anche col modulo firmato dal genitore.
    const genitoriByAlunno = await getGenitoriDiAlunni(supabase, alunniList)
    const allGenitori = new Set<string>()
    for (const genitori of genitoriByAlunno.values()) for (const g of genitori) allGenitori.add(g)
    const firmatari = new Set<string>()
    if (allGenitori.size > 0) {
      let subsQuery = supabase
        .from('form_submissions').select('user_id, signed_at').in('user_id', [...allGenitori]).not('signed_at', 'is', null)
      // Autorizzazione PER-GITA: se indicato, conta solo la firma di QUEL modulo.
      if (formModelId) subsQuery = subsQuery.eq('model_id', formModelId)
      const { data: subs } = await subsQuery
      for (const sub of subs || []) firmatari.add(sub.user_id)
    }

    const data = alunniList.map((alunno_id) => ({
      alunno_id,
      autorizzato: (genitoriByAlunno.get(alunno_id) || []).some((g) => firmatari.has(g)),
      quota_ok: quotaOk.get(alunno_id) ?? false,
    }))

    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'teacher/uscite:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// LA GITA NASCE QUI, E L'AUTORIZZAZIONE NON PIÙ (prestampato n. 10)
//
// `docs/prestampati/10-autorizzazione-uscita.md`: «la segreteria crea l'evento
// una volta; l'app produce un'autorizzazione per ciascun bambino della sezione».
// Fino al 2026-08-15 questa route lo faceva scrivendo DUE righe: la gita in
// `eventi_agenda` e un modulo del **Sistema B** in `forms_templates`.
//
// ─── PERCHÉ IL SISTEMA B SI SPEGNE (2026-08-16) ─────────────────────────────
//
// Perché erano due sistemi che non si parlavano, e la famiglia li vedeva tutti
// e due. Il prestampato n. 10 esiste — carta intestata, firma OTP, protocollo,
// fascicolo — e restava spento; accanto, un modulo del Sistema B chiedeva le
// stesse cose in una schermata diversa, si firmava altrove e finiva in
// `forms_submissions` invece che nel fascicolo del bambino. Due autorizzazioni
// per la stessa gita, con due valori diversi e due archivi diversi.
//
// Da oggi la gita è **una riga sola**, in `eventi_agenda` (`tipo = 'uscita'`), e
// il prestampato n. 10 la legge: `datiUscitaDaEvento()` in `banco-famiglia.ts`
// ricompone destinazione, data, orari e mezzo, e il modulo compare nell'elenco
// della famiglia SOLO se quell'uscita esiste. L'autorizzazione passa quindi dalla
// carta intestata, dalla firma OTP e dal fascicolo, come tutti gli altri sedici.
//
// ⚠️ **SI SPEGNE LA CREAZIONE, NON LA LETTURA.** Le gite già pubblicate hanno la
// loro riga in `forms_templates` e le famiglie l'hanno già ricevuta: quei moduli
// restano proposti da `GET /api/parent/forms`, si firmano da lì e si leggono
// nell'Archivio firmati. Anche il semaforo del GET qui sopra continua a leggere
// `forms_submissions` con `form_id`. Cancellarli avrebbe fatto sparire
// autorizzazioni già raccolte.
//
// ─── E LA FAMIGLIA COME LO SA? ──────────────────────────────────────────────
//
// Con una notifica push e una voce nel Centro Notifiche, alla pubblicazione
// (vedi in fondo al POST). **Nessuna email**: scelta esplicita del titolare.
// Prima non c'era nemmeno quella — il modulo appariva in una schermata che il
// genitore doveva pensare di aprire.
//
// ─── Idempotenza ────────────────────────────────────────────────────────────
//
// La chiave naturale della gita è sede + tipo + giorno + titolo composto +
// sezione, e il titolo NON arriva dal client: se lo scegliesse chi chiama, la
// stessa gita creata due volte con due titoli diversi diventerebbe due eventi in
// agenda, cioè due notifiche e due autorizzazioni per lo stesso bambino.
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️ LE CINQUE ATTIVITÀ, I QUATTRO MEZZI E IL FORMATO DELLA DESCRIZIONE NON
// STANNO PIÙ QUI. Vivono in `src/app/api/parent/prestampati/banco-famiglia.ts`,
// che è il file di chi li RILEGGE: `eventi_agenda` non ha una colonna `jsonb`,
// quindi i dati dell'uscita viaggiano dentro il testo della descrizione, e due
// copie delle etichette in due file divergono al primo ritocco — con il n. 10
// che smette di stampare la destinazione senza che niente diventi rosso. Il
// round-trip fra chi scrive e chi legge è verificato dal test.

/**
 * Il `document_type` con cui la firma del n. 10 entra nel fascicolo.
 *
 * È lo slug del registro dei prestampati, e sta scritto qui una volta sola perché il
 * semaforo del GET lo confronta in TypeScript invece che dentro la query (vedi lì il
 * motivo: l'enumerato e il DB E2E non migrato).
 */
const TIPO_DOCUMENTO_USCITA = 'autorizzazione_uscita'

const zOrarioHM = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Orario non valido (atteso HH:MM)')

/**
 * ⚠️ `destinazione` resta tagliata a 120 e non a 200 come il titolo di `agenda`.
 * Il motivo originale era `forms_templates.title` (un `varchar(255)`), e quella
 * riga non si scrive più; il limite però resta, e ora per una ragione sua: la
 * destinazione finisce nel titolo dell'evento **e** dentro il foglio del
 * prestampato n. 10, dove `impaginazione.ts` la manda a capo dentro una
 * riga-campo. Allargarlo adesso non romperebbe niente e renderebbe illeggibile
 * un certificato — si allarga il giorno in cui qualcuno lo chiede davvero.
 */
const postBodySchema = z
  .object({
    tipo_attivita: z.enum(TIPI_ATTIVITA_USCITA),
    destinazione: z.string().trim().min(1, 'Destinazione mancante').max(120),
    data: zDataYMD,
    ora_partenza: zOrarioHM,
    ora_rientro: zOrarioHM,
    mezzo: z.enum(MEZZI_USCITA),
    /** Le sezioni coinvolte, per IDENTITÀ: «2 ANNI» esiste ad Aversa e a Cesa. */
    sezioni: z.array(zUuid).min(1, 'Indicare almeno una sezione').max(20),
    attivita_in_acqua: z.boolean().default(false),
    quota: z.number().nonnegative().max(5000).nullable().optional(),
    accompagnatori: z.string().trim().max(300).nullable().optional(),
    /** Termine per autorizzare; assente vale il giorno stesso dell'uscita. */
    termine_autorizzazione: zDataYMD.optional(),
    scuola_id: zUuid.optional(),
  })
  // I due controlli incrociati stanno QUI e non nell'handler, che è dove la
  // prima stesura li aveva messi: sono forma del dato, non regole di dominio, e
  // dallo schema escono col 400 di `validationError` — che nomina il campo
  // sbagliato invece di far indovinare quale dei due orari rifare.
  .refine((c) => c.ora_rientro > c.ora_partenza, {
    // Confronto fra stringhe `HH:MM`: lessicografico e cronologico coincidono.
    error: 'L’orario di rientro deve essere successivo a quello di partenza',
    path: ['ora_rientro'],
  })
  .refine((c) => (c.termine_autorizzazione ?? c.data) <= c.data, {
    error: 'Il termine per autorizzare non può cadere dopo l’uscita',
    path: ['termine_autorizzazione'],
  })

type CorpoUscita = z.infer<typeof postBodySchema>

/**
 * Il titolo dell'evento in agenda, e la prima metà della chiave naturale.
 * Composto, mai ricevuto: vedi la nota sull'idempotenza in testa alla sezione.
 */
function titoloUscita(corpo: CorpoUscita): string {
  return componiTitoloUscita(corpo.tipo_attivita, corpo.destinazione)
}

/**
 * La «DESCRIZIONE DELL'ATTIVITÀ», composta dalla funzione che sa anche rileggerla.
 *
 * `formatEuro` resta QUI e non entra nel codec: la formattazione in euro è una
 * dipendenza del prodotto, e il codec deve poter girare in un test senza
 * trascinarsi dietro l'internazionalizzazione. Il codec riceve la stringa già
 * pronta e non la rilegge — la quota sul foglio del n. 10 non compare.
 */
function descrizioneUscita(corpo: CorpoUscita): string {
  return componiDescrizioneUscita({
    tipo_attivita: corpo.tipo_attivita,
    destinazione: corpo.destinazione,
    data: corpo.data,
    ora_partenza: corpo.ora_partenza,
    ora_rientro: corpo.ora_rientro,
    mezzo: corpo.mezzo,
    attivita_in_acqua: corpo.attivita_in_acqua,
    accompagnatori: corpo.accompagnatori ?? null,
    quota: corpo.quota != null ? formatEuro(corpo.quota) : null,
  })
}

// POST /api/teacher/uscite — crea l'uscita e, con essa, l'autorizzazione da far
//   firmare alle famiglie delle sezioni coinvolte. Staff docente; l'educator
//   solo sulle proprie sezioni (`assertSezioneInScope`).
export const POST = withRoute('teacher/uscite:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const { user } = auth

    // Anti-abuso: ogni creazione propone un modulo da firmare a un'intera
    // sezione, cioè fa fan-out sulle famiglie. Stesso tetto di `agenda:POST`.
    const rl = await rateLimit(`uscite-post:${user.id}`, { limit: 20, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Troppe uscite create. Riprova tra qualche minuto.', codice: 'TROPPE_RICHIESTE' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
      )
    }

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const corpo = b.data

    // Confronto fra stringhe `HH:MM`: lessicografico e cronologico coincidono.
    if (corpo.ora_rientro <= corpo.ora_partenza) {
      return NextResponse.json(
        { error: 'L’orario di rientro deve essere successivo a quello di partenza', codice: 'USCITA_ORARI_NON_VALIDI' },
        { status: 400 }
      )
    }
    const termine = corpo.termine_autorizzazione ?? corpo.data
    // `YYYY-MM-DD`: anche qui l'ordine delle stringhe è quello del calendario.
    if (termine > corpo.data) {
      return NextResponse.json(
        { error: 'Il termine per autorizzare non può cadere dopo l’uscita', codice: 'USCITA_TERMINE_NON_VALIDO' },
        { status: 400 }
      )
    }

    const supabase = await createAdminClient()

    // La sede si DICHIARA. Con tre sedi in produzione, un 400 qui è il caso
    // normale e non un guasto: un'uscita archiviata nel plesso sbagliato
    // porterebbe con sé l'autorizzazione, cioè manderebbe il modulo alle
    // famiglie di un'altra scuola.
    const sw = await resolveScuolaScrittura(request, supabase, user, corpo.scuola_id)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    // Gate per IDENTITÀ di sezione: verifica il plesso e, per l'educator, che la
    // sezione sia davvero sua. Le sezioni sono poche (una gita ne coinvolge due
    // o tre), quindi il costo del ciclo è noto e limitato dal `max(20)` di zod.
    for (const sezione of corpo.sezioni) {
      const fuoriScope = await assertSezioneInScope(supabase, user, sezione)
      if (fuoriScope) return fuoriScope
    }

    // I NOMI delle sezioni: sono ciò che `forms_templates.target_classes`
    // contiene, ed è con quelli che `parent/forms:GET` abbina il modulo ai
    // figli. Il filtro di sede nella stessa query fa anche da verifica di
    // coerenza: una sezione di un altro plesso non torna, e il conteggio non
    // torna con lei.
    const { data: sezioni, error: erroreSezioni } = await supabase
      .from('sections')
      .select('id, name')
      .in('id', corpo.sezioni)
      .eq('scuola_id', scuolaId)
    if (erroreSezioni) {
      logEvento('modulistica', 'error', {
        operazione: 'teacher/uscite:POST', esito: 'sezioni-non-lette', sede: scuolaId,
      }, erroreSezioni)
      return NextResponse.json({ error: 'Verifica delle sezioni non riuscita', codice: 'USCITA_SEZIONI_NON_VERIFICATE' }, { status: 500 })
    }
    if ((sezioni ?? []).length !== corpo.sezioni.length) {
      logEvento('modulistica', 'warn', {
        tipo: 'classe-fuori-sede', operazione: 'teacher/uscite:POST',
        utente: user.id, ruolo: user.role, sede: scuolaId,
        richieste: corpo.sezioni.length, risolte: (sezioni ?? []).length,
      })
      return NextResponse.json(
        { error: 'Una delle sezioni indicate non appartiene alla sede dichiarata', codice: 'USCITA_CLASSE_FUORI_SEDE' },
        { status: 403 }
      )
    }
    const classi = [...new Set((sezioni ?? []).map((s) => s.name as string))]

    const titolo = titoloUscita(corpo)
    const descrizione = descrizioneUscita(corpo)

    // ── La gita ──────────────────────────────────────────────────────────────
    // Idempotenza: la chiave naturale è sede + tipo + giorno + titolo composto +
    // sezione. Si creano SOLO le sezioni che ancora non ce l'hanno, così una
    // seconda chiamata identica non duplica niente e una chiamata che aggiunge
    // una sezione aggiunge solo quella.
    const { data: gia, error: erroreGia } = await supabase
      .from('eventi_agenda')
      .select('id, section_id')
      .eq('scuola_id', scuolaId)
      .eq('tipo', 'uscita')
      .eq('data', corpo.data)
      .eq('titolo', titolo)
      .in('section_id', corpo.sezioni)
    if (erroreGia) {
      // Senza questo controllo un guasto di lettura varrebbe «non esiste» e la
      // gita verrebbe creata una seconda volta, con la sua autorizzazione.
      logEvento('modulistica', 'error', {
        operazione: 'teacher/uscite:POST', esito: 'uscite-esistenti-non-lette', sede: scuolaId,
      }, erroreGia)
      return NextResponse.json({ error: 'Verifica dell’uscita non riuscita', codice: 'USCITA_NON_VERIFICATA' }, { status: 500 })
    }
    const esistenti = (gia ?? []).map((r) => ({ id: r.id as string, section_id: r.section_id as string }))
    const giaCoperte = new Set(esistenti.map((e) => e.section_id))
    const daCreare = corpo.sezioni.filter((s) => !giaCoperte.has(s))

    let create: { id: string; section_id: string }[] = []
    if (daCreare.length > 0) {
      const { data: inserite, error: erroreInsert } = await supabase
        .from('eventi_agenda')
        .insert(
          daCreare.map((sezione) => ({
            scuola_id: scuolaId,
            section_id: sezione,
            titolo,
            descrizione,
            tipo: 'uscita',
            data: corpo.data,
            orario_inizio: corpo.ora_partenza,
            orario_fine: corpo.ora_rientro,
            visibile_genitori: true,
            creato_da: user.id,
          }))
        )
        .select('id, section_id')
      if (erroreInsert) {
        logErrore({ operazione: 'teacher/uscite:POST', stato: 500, evento: 'uscita-non-creata' }, erroreInsert)
        return NextResponse.json({ error: 'Creazione dell’uscita non riuscita', codice: 'USCITA_NON_CREATA' }, { status: 500 })
      }
      create = (inserite ?? []).map((r) => ({ id: r.id as string, section_id: r.section_id as string }))
    }

    // Da qui in poi LA GITA C'È. Qualunque cosa succeda all'autorizzazione,
    // questa route non torna più indietro e non risponde più con un errore:
    // un automatismo che si guasta non può impedire a un'insegnante di
    // programmare l'uscita.
    logEvento('modulistica', 'info', {
      operazione: 'teacher/uscite:POST', esito: 'uscita-creata', sede: scuolaId,
      sezioni: corpo.sezioni.length, create: create.length, gia_presenti: esistenti.length,
    })

    // ── L'ANNUNCIO ALLE FAMIGLIE: push + campanella, nessuna email ────────────
    //
    // Prende il posto della riga di `forms_templates` che questa route scriveva
    // fino al 2026-08-15 (vedi la testata della sezione). Il modulo da firmare
    // ora è il prestampato n. 10, che compare da sé nell'elenco della famiglia
    // appena l'uscita esiste: quello che mancava era **dirlo**.
    //
    // ⚠️ NESSUNA EMAIL — scelta esplicita del titolare. `notificaEvento` scrive
    // la voce nel Centro Notifiche e accoda la push nativa; la posta non la tocca.
    //
    // Si annuncia SOLO ciò che è nato adesso (`create`): una seconda chiamata
    // identica — la stessa gita salvata due volte — non deve far arrivare due
    // notifiche alle stesse famiglie. Le sezioni già coperte le hanno già ricevute.
    let destinatari: string[] = []
    let alunniCoinvolti = 0
    if (create.length > 0) {
      // La query vive DENTRO l'handler: è ancorata alle sezioni che
      // `assertSezioneInScope` ha appena verificato una per una, e il filtro di
      // sede è quello dichiarato da `resolveScuolaScrittura`. Una gita che
      // notificasse le famiglie di un altro plesso è lo stesso difetto della
      // gita archiviata nel plesso sbagliato, visto dal lato di chi riceve.
      const { data: alunni, error: erroreAlunni } = await supabase
        .from('alunni')
        .select('id')
        .eq('scuola_id', scuolaId)
        .in('section_id', create.map((c) => c.section_id))
        // Il confine è `STATI_CON_CANALE_FAMIGLIA` e non una coppia di stringhe
        // scritte qui: è lo stesso predicato che decide chi resta raggiungibile
        // per avvisi e agenda, e una copia scritta a mano è ciò che nel 2026-08-12
        // teneva un ritirato dentro gli avvisi di classe.
        .in('stato', [...STATI_CON_CANALE_FAMIGLIA])
      if (erroreAlunni) {
        // PostgREST non lancia: senza questo ramo un guasto di lettura sarebbe
        // «nessun destinatario», cioè una gita pubblicata che nessuno annuncia —
        // e nessuno se ne accorgerebbe fino al giorno della partenza.
        logEvento('push', 'error', {
          operazione: 'teacher/uscite:POST', esito: 'destinatari-non-letti', sede: scuolaId,
        }, erroreAlunni)
      } else {
        const idAlunni = (alunni ?? []).map((a) => a.id as string)
        alunniCoinvolti = idAlunni.length
        destinatari = await genitoriDiAlunni(supabase, idAlunni)
      }

      let annunciati = 0
      if (destinatari.length > 0) {
        // `consenso_uscita` è il tipo canonico del catalogo («Consensi uscite e
        // gite»): è anche il toggle con cui la Direzione può spegnere questo
        // canale per la propria sede, e inventare un tipo nuovo vorrebbe dire
        // una notifica che nessuno può disattivare.
        //
        // `bufferMin: 0` e non i dieci di default: qui non c'è una finestra di
        // modifica da aspettare — l'uscita è già scritta in agenda e la famiglia
        // ha un termine per autorizzare. Dieci minuti di ritardo su una gita
        // annunciata il giorno prima sono dieci minuti tolti al genitore.
        try {
          await notificaEvento(supabase, {
            tipo: 'consenso_uscita',
            scuolaId,
            utenteIds: destinatari,
            titolo,
            // ⚠️ IL COLLEGAMENTO PORTA ALLA SCHEDA GIUSTA, e prima non lo faceva.
            // Misurato in un browser vero: `/parent/modulistica` si apre su «DA
            // COMPILARE», che a quel genitore diceva «Ottimo lavoro! Non hai moduli
            // da compilare» — mentre il modulo della gita stava nella terza scheda.
            // Il testo per giunta nominava una linguetta con un'etichetta che
            // nell'app non esiste. Ora la pagina legge `?tab=` (come fa già
            // `/admin/modulistica`), quindi il link ci arriva davvero e il corpo non
            // deve più insegnare al genitore dove cercare.
            corpo: `Da autorizzare entro il ${dataItalianaUscita(termine)}. Il modulo da firmare è già pronto in Modulistica.`,
            link: '/parent/modulistica?tab=certificati',
            entitaTipo: 'eventi_agenda',
            entitaId: create[0].id,
            bufferMin: 0,
          })
          annunciati = destinatari.length
        } catch (err) {
          // Da qui in poi la gita c'è: un automatismo che si guasta non può
          // impedire a un'insegnante di programmare l'uscita. Ma non passa in
          // silenzio, e il CORPO dell'errore resta nella riga — `403` non dice
          // niente, `403 "the domain is not verified"` dice tutto.
          logEvento('push', 'error', {
            operazione: 'teacher/uscite:POST',
            esito: 'uscita-non-annunciata',
            tipo: 'consenso_uscita',
            sede: scuolaId,
            n: destinatari.length,
          }, err)
        }
      }

      // ⚠️ IL SUCCESSO SI LOGGA, E SU UN CANALE PERSISTITO. Sono due cose, e la
      // seconda è quella che il 2026-08-16 mancava: la riga stava su `notifica`,
      // che NON è fra gli `EVENTI_PERSISTITI` (`logger.ts`), quindi non arrivava
      // in `app_log` — misurato, per la gita creata alle 00:16 in tabella c'erano
      // solo `header-fallback` e `uscita-creata`. Con trenta giorni di ritenzione
      // e un giorno di log runtime su Vercel, «nessuna riga» avrebbe smesso di
      // distinguere «gli annunci partono» da «non ne è mai partito uno»:
      // l'ambiguità che in questo progetto ha nascosto per mesi il guasto delle
      // email di credenziali. `push` è il canale della CONSEGNA, è già persistito,
      // ed è quello che la deroga di `eventi-log.test.ts` indica per nome.
      //
      // `info` anche con zero destinatari: `notificaEvento` emette già il suo
      // `warn` in quel caso, e alzare il livello qui gonfierebbe il canale dei
      // guasti per una sezione senza iscritti, che non è un guasto.
      logEvento('push', 'info', {
        operazione: 'teacher/uscite:POST',
        esito: annunciati > 0 ? 'uscita-annunciata' : 'uscita-senza-destinatari',
        tipo: 'consenso_uscita',
        sede: scuolaId,
        n: annunciati,
        n_alunni: alunniCoinvolti,
        sezioni: create.length,
      })
      // La risposta dice quante famiglie l'hanno ricevuto DAVVERO, non quante ne
      // sono state trovate: un annuncio fallito che si racconta come riuscito è
      // peggio di nessun annuncio.
      destinatari = annunciati > 0 ? destinatari : []
    }

    // 201 quando qualcosa è nato davvero, 200 quando la chiamata era una
    // ripetizione. `autorizzazione` non c'è più — non si crea nessun modulo del
    // Sistema B — e al suo posto la risposta dice a quante famiglie è stato
    // annunciato: è l'unico fatto verificabile che questa route produce oltre
    // alla gita, e nasconderlo dietro un 201 muto era ciò che rendeva invisibile
    // un automatismo che si guasta.
    return NextResponse.json(
      {
        success: true,
        data: {
          uscita: {
            titolo,
            data: corpo.data,
            scuola_id: scuolaId,
            eventi: [...esistenti, ...create],
            create: create.length,
          },
          termineAutorizzazione: termine,
          notificate: destinatari.length,
          classi,
        },
      },
      { status: create.length > 0 ? 201 : 200 }
    )
  } catch (err) {
    logErrore({ operazione: 'teacher/uscite:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Creazione dell’uscita non riuscita', codice: 'USCITA_NON_CREATA' }, { status: 500 })
  }
})
