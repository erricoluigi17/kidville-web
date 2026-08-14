import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente, requireUser } from '@/lib/auth/require-staff'
import { assertAlunnoInScope, assertSezioneInScope, resolveScuolaScrittura } from '@/lib/auth/scope'
import { getGenitoriDiAlunni } from '@/lib/anagrafiche/legami'
import { rateLimit } from '@/lib/security/rate-limit'
import { formatEuro } from '@/lib/format/valuta'
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
  // L'autorizzazione che il POST qui sotto genera da sé: è una riga di
  // `forms_templates`, e la firma della famiglia sta in `forms_submissions`
  // (Sistema B) — non in `form_submissions` (Sistema A), che è ciò che
  // `form_model_id` interroga. Due sistemi di moduli convivono in questo repo, e
  // un semaforo che ne guarda uno solo direbbe «nessuno ha firmato» proprio
  // sulle gite create dall'app.
  form_id: z.string().optional(),
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
    const { gruppo, alunno_ids: alunnoIdsParam, form_model_id: formModelId, form_id: formId } = q.data
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

    // Autorizzazione della gita GENERATA DALL'APP (il POST qui sotto): la firma
    // sta in `forms_submissions` ed è agganciata al BAMBINO (`student_id`), non
    // al genitore — quindi il semaforo si legge in una query sola e non ha
    // bisogno dei legami di famiglia. È anche più preciso del ramo storico: là
    // «autorizzato» vuol dire «un genitore collegato ha firmato quel modulo»,
    // qui vuol dire «per QUESTO bambino esiste una firma».
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
// L'AUTORIZZAZIONE CHE NASCE DA SÉ A OGNI NUOVA GITA (prestampato n. 10)
//
// `docs/prestampati/10-autorizzazione-uscita.md`: «la segreteria crea l'evento
// una volta; l'app produce un'autorizzazione per ciascun bambino della sezione».
// Qui succede esattamente questo, e senza aggiungere NÉ UNA TABELLA NÉ UNA
// COLONNA — che è il vincolo dichiarato di questo lavoro.
//
// ─── Le due tabelle, e perché sono queste ───────────────────────────────────
//
// 1. LA GITA sta in `eventi_agenda` con `tipo = 'uscita'`. Non è una scelta di
//    comodo: quel valore è già dentro il CHECK della tabella (baseline, riga
//    1440), la riga porta già sede, sezione, data e i due orari, e le famiglie
//    quell'agenda la leggono già (`GET /api/agenda`, ramo genitore). Una tabella
//    nuova avrebbe voluto dire una migrazione e una seconda schermata da
//    scrivere per mostrare ciò che si vede già.
//
// 2. L'AUTORIZZAZIONE è una riga di `forms_templates` — il Sistema B della
//    modulistica — e non di `form_models`. La differenza non è di gusto: è che
//    `forms_templates` ha ESATTAMENTE i tre campi che questa funzione richiede
//    (`scuola_id`, `target_classes`, `expiration_date`) e un `form_type` che
//    vale già `'autorizzazione'`, mentre `form_models` è il sistema dei moduli
//    PUBBLICI (`public_token`, `is_enrollment_form`, `access_mode`), non sa
//    nulla di classi e non ha un termine. E soprattutto: dal Sistema B la strada
//    è già asfaltata fino in fondo, e ognuno di questi pezzi esiste oggi —
//      · `GET /api/parent/forms` propone il modulo alla famiglia, filtrando per
//        le classi dei figli DENTRO le sole sedi dei figli;
//      · `PATCH /api/parent/forms/otp` raccoglie la firma OTP e scrive in
//        `forms_submissions` (`is_signed`, `signature_log`);
//      · `GET /api/documenti-firmati` fa comparire l'esito nell'«Archivio
//        firmati» leggendo proprio `forms_submissions`.
//    Scrivere una riga di `forms_templates` è quindi TUTTO il codice che serve
//    perché un'autorizzazione nasca, si firmi e si archivi: zero schermate,
//    zero colonne, zero migrazioni.
//
// ─── Idempotenza senza una colonna di collegamento ──────────────────────────
//
// Non c'è (e non si può aggiungere) una colonna che leghi il modulo alla gita:
// il legame è quindi una CHIAVE NATURALE DERIVATA, cioè un titolo composto solo
// da dati della gita — attività, destinazione e giorno. Due creazioni identiche
// compongono lo stesso titolo, la seconda ritrova la prima e non scrive niente.
// È anche il motivo per cui il titolo dell'evento NON arriva dal client: se lo
// scegliesse chi chiama, la stessa gita creata due volte con due titoli diversi
// genererebbe due autorizzazioni gemelle, e alla famiglia arriverebbero due
// moduli identici da firmare per lo stesso bambino.
// ─────────────────────────────────────────────────────────────────────────────

/** Le cinque voci del cartaceo, nell'ordine in cui il prestampato le elenca. */
const TIPI_ATTIVITA = ['uscita_didattica', 'gita', 'laboratorio_esterno', 'corso_piscina', 'altro'] as const
const ETICHETTA_ATTIVITA: Record<(typeof TIPI_ATTIVITA)[number], string> = {
  uscita_didattica: 'Uscita didattica',
  gita: 'Gita',
  laboratorio_esterno: 'Laboratorio esterno',
  corso_piscina: 'Corso di piscina/nuoto',
  altro: 'Altra attività esterna',
}

/** Le quattro voci del cartaceo per il mezzo di trasporto. */
const MEZZI = ['scuolabus', 'pullman_privato', 'a_piedi', 'altro'] as const
const ETICHETTA_MEZZO: Record<(typeof MEZZI)[number], string> = {
  scuolabus: 'Scuolabus',
  pullman_privato: 'Pullman privato',
  a_piedi: 'A piedi',
  altro: 'Altro',
}

const zOrarioHM = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Orario non valido (atteso HH:MM)')

/**
 * ⚠️ `destinazione` è tagliata a 120 e non a 200 come il titolo di `agenda`, e il
 * numero non è arbitrario: `forms_templates.title` è un `varchar(255)`, e il
 * titolo del modulo è composto (attività + destinazione + data). Con 200 una
 * destinazione lunga farebbe fallire l'INSERT dell'autorizzazione — cioè
 * l'unica parte di questa route che ha il permesso di fallire in silenzio, e
 * sarebbe fallita per un motivo che si può escludere qui.
 */
const postBodySchema = z
  .object({
    tipo_attivita: z.enum(TIPI_ATTIVITA),
    destinazione: z.string().trim().min(1, 'Destinazione mancante').max(120),
    data: zDataYMD,
    ora_partenza: zOrarioHM,
    ora_rientro: zOrarioHM,
    mezzo: z.enum(MEZZI),
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

/** `2026-09-12` → `12/09/2026`, senza costruire una `Date`: nessun fuso di mezzo. */
function dataItaliana(ymd: string): string {
  const [anno, mese, giorno] = ymd.split('-')
  return `${giorno}/${mese}/${anno}`
}

/**
 * Il titolo dell'evento in agenda, e la prima metà della chiave naturale.
 * Composto, mai ricevuto: vedi la nota sull'idempotenza in testa alla sezione.
 */
function titoloUscita(corpo: CorpoUscita): string {
  return `${ETICHETTA_ATTIVITA[corpo.tipo_attivita]}: ${corpo.destinazione}`
}

/** Il titolo del modulo da firmare: è la chiave naturale dell'autorizzazione. */
function titoloAutorizzazione(corpo: CorpoUscita): string {
  return `Autorizzazione · ${titoloUscita(corpo)} · ${dataItaliana(corpo.data)}`
}

/**
 * La «DESCRIZIONE DELL'ATTIVITÀ» del prestampato, tutta precompilata dall'evento.
 *
 * Le righe di cui la gita non porta il dato NON compaiono: è la disciplina dei
 * prestampati («mai una riga vuota che sembri un valore»), e su un foglio che
 * autorizza l'uscita di un minore un «Quota: —» si legge come una quota decisa.
 */
function descrizioneUscita(corpo: CorpoUscita): string {
  const righe = [
    `Tipo di attività: ${ETICHETTA_ATTIVITA[corpo.tipo_attivita]}`,
    `Destinazione: ${corpo.destinazione}`,
    `Data: ${dataItaliana(corpo.data)} · Partenza: ${corpo.ora_partenza} · Rientro previsto: ${corpo.ora_rientro}`,
    `Mezzo di trasporto: ${ETICHETTA_MEZZO[corpo.mezzo]}`,
  ]
  if (corpo.accompagnatori) righe.push(`Accompagnatori: ${corpo.accompagnatori}`)
  if (corpo.quota != null) righe.push(`Quota di partecipazione: ${formatEuro(corpo.quota)}`)
  righe.push(
    'Si ricorda di segnalare eventuali informazioni sanitarie rilevanti già indicate nella scheda sanitaria dell’alunno/a.',
  )
  return righe.join('\n')
}

/**
 * I campi che restano alla famiglia. Sono tre al massimo, e sono quelli che il
 * prestampato n. 10 lascia da compilare: tutto il resto è già scritto sopra.
 *
 * La forma è quella che il pannello del genitore sa già disegnare
 * (`FormField` in `parent/modulistica/page.tsx`): `id`, `type`, `label`,
 * `required`, e per i `radio` le `options`. `db_mapping` è il canale con cui
 * quel pannello precompila un campo dall'anagrafica.
 *
 * «Autorizzo / Non autorizzo» è un `radio` e non una casella obbligatoria: una
 * casella si può solo spuntare, cioè il diniego non sarebbe firmabile e
 * resterebbe una telefonata. Il cruscotto della gita deve poter distinguere chi
 * ha negato da chi non ha ancora risposto.
 */
function campiAutorizzazione(inAcqua: boolean): Record<string, unknown>[] {
  const campi: Record<string, unknown>[] = []
  if (inAcqua) {
    campi.push({
      id: 'sa_nuotare',
      type: 'radio',
      label: 'Il/La bambino/a sa nuotare',
      required: true,
      options: [
        { label: 'Sì', value: 'si' },
        { label: 'No', value: 'no' },
      ],
    })
  }
  campi.push({
    id: 'recapito_reperibile',
    type: 'text',
    label: 'Recapito telefonico reperibile durante l’uscita',
    required: true,
    db_mapping: 'utenti.telefono',
  })
  campi.push({
    id: 'autorizzazione',
    type: 'radio',
    label:
      'Autorizzo il/la mio/a figlio/a a partecipare all’attività sopra descritta, sollevando la Scuola da responsabilità per fatti non imputabili a negligenza del personale',
    required: true,
    options: [
      { label: 'Autorizzo', value: 'autorizzo' },
      { label: 'Non autorizzo', value: 'non_autorizzo' },
    ],
  })
  return campi
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

    // ── L'autorizzazione ─────────────────────────────────────────────────────
    let autorizzazione: { id: string; title: string } | null = null
    let esitoAutorizzazione: 'creata' | 'gia-presente' | 'non-creata' = 'non-creata'
    const titoloModulo = titoloAutorizzazione(corpo)
    try {
      const { data: moduli, error: erroreModuli } = await supabase
        .from('forms_templates')
        .select('id, title, target_classes')
        .eq('scuola_id', scuolaId)
        .eq('title', titoloModulo)
      if (erroreModuli) {
        // Non si prosegue con l'INSERT: «non lo so» qui vuol dire che il modulo
        // POTREBBE già esserci, e crearne un secondo manderebbe alla famiglia
        // due moduli identici da firmare per lo stesso bambino.
        logErrore(
          { operazione: 'teacher/uscite:POST', evento: 'autorizzazione-non-verificata' },
          erroreModuli
        )
      } else {
        // La domanda non è «esiste un modulo con questo titolo?» ma «quali
        // classi non ce l'hanno ancora?», e la differenza si vede quando la
        // gita si allarga a una sezione nuova:
        //  · rispondendo per modulo, la sezione nuova resterebbe senza
        //    autorizzazione — e la scoprirebbe il giorno dell'uscita il
        //    genitore che non ha mai ricevuto niente;
        //  · creando un secondo modulo con TUTTE le classi, le famiglie della
        //    prima sezione si troverebbero due moduli identici da firmare per
        //    lo stesso bambino.
        // Si crea quindi il modulo per le sole classi SCOPERTE.
        const coperte = new Set(
          (moduli ?? []).flatMap((m) => (m.target_classes as string[] | null) ?? [])
        )
        const mancanti = classi.filter((c) => !coperte.has(c))
        const esistente =
          mancanti.length === 0
            ? (moduli ?? []).find((m) =>
                classi.some((c) => ((m.target_classes as string[] | null) ?? []).includes(c))
              )
            : undefined
        if (esistente) {
          autorizzazione = { id: esistente.id as string, title: esistente.title as string }
          esitoAutorizzazione = 'gia-presente'
          logEvento('modulistica', 'info', {
            operazione: 'teacher/uscite:POST', esito: 'autorizzazione-uscita-gia-presente',
            entita_tipo: 'forms_templates', entita_id: esistente.id, sede: scuolaId,
            classi: classi.length,
          })
        } else {
          const { data: creata, error: erroreCreazione } = await supabase
            .from('forms_templates')
            .insert({
              scuola_id: scuolaId,
              title: titoloModulo,
              description: descrizione,
              form_type: 'autorizzazione',
              fields: campiAutorizzazione(corpo.attivita_in_acqua),
              target_scope: 'class',
              target_classes: mancanti,
              // Fine giornata e non mezzanotte: `expiration_date` è un istante e
              // `parent/forms:GET` marca «expired» ciò che sta nel passato — col
              // solo `YYYY-MM-DD` il termine scadrebbe all'alba del giorno in cui
              // si può ancora firmare.
              expiration_date: `${termine}T23:59:59`,
            })
            .select('id, title')
            .single()
          if (erroreCreazione || !creata) {
            logErrore(
              { operazione: 'teacher/uscite:POST', evento: 'autorizzazione-non-creata' },
              erroreCreazione ?? new Error('INSERT senza riga e senza errore')
            )
          } else {
            autorizzazione = { id: creata.id as string, title: creata.title as string }
            esitoAutorizzazione = 'creata'
            // Il SUCCESSO si logga, e non è una nota di colore: senza questa riga
            // «nessun log» non distingue «le autorizzazioni partono» da «non ne è
            // mai partita una» — l'ambiguità che in questo progetto ha nascosto
            // per mesi il guasto delle email di credenziali.
            logEvento('modulistica', 'info', {
              operazione: 'teacher/uscite:POST', esito: 'autorizzazione-uscita-creata',
              entita_tipo: 'forms_templates', entita_id: creata.id, sede: scuolaId,
              classi: mancanti.length, scadenza: termine,
            })
          }
        }
      }
    } catch (e) {
      // PostgREST non lancia, ma la rete sì: un timeout qui non deve portarsi
      // via la gita che è già stata scritta.
      logErrore({ operazione: 'teacher/uscite:POST', evento: 'autorizzazione-non-creata' }, e)
    }

    // 201 quando qualcosa è nato davvero, 200 quando la chiamata era una
    // ripetizione: lo stato descrive la gita, il corpo descrive l'autorizzazione
    // — così un secondo tentativo che finalmente crea il modulo mancante lo dice
    // in `esitoAutorizzazione` invece di nasconderlo dietro un 200.
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
          autorizzazione,
          esitoAutorizzazione,
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
