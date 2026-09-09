import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseBody, parseData, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ============================================================
// Orario: tempo scuola (27/29/40h) → campanelle → griglia settimanale.
// ============================================================

// ⚠️ Il nome della route si scrive per ESTESO, a mano, in ogni punto: niente
// costante. `__tests__/architecture/logging-coverage.test.ts` riconosce
// `withRoute('<nome>', …)` per LETTERALE — una costante al suo posto lo rende
// cieco su questo file, ed è lo stesso motivo per cui `withRoute` non assorbe i
// gate (vedi la nota in `src/lib/logging/with-route.ts`).

/**
 * Il massimo di ore di LEZIONE che un giorno può contenere.
 *
 * Non è un numero scelto qui: è il `CHECK (ora_lezione >= 1 AND ora_lezione <= 8)`
 * di `registro_orario`, cioè della tabella su cui il docente FIRMA. Una nona
 * lezione in un giorno non è «una configurazione insolita»: è una riga che il
 * registro non sa rappresentare, e chi la incontra è il docente al momento della
 * firma — con un 500 che gli rimanda il messaggio grezzo di Postgres, e in
 * offline con un ritentativo che non finisce mai.
 *
 * ⚠️ IL VINCOLO NON VA SULL'`ordine`, e questa è la parte da leggere prima di
 * «stringere lo zod a 8». `ordine` numera le CAMPANELLE, e le campanelle
 * comprendono l'intervallo e la mensa: la giornata da 40 ore è 8 lezioni + 1
 * intervallo + 1 mensa, cioè `ordine` fino a 10, ed è una giornata LEGITTIMA.
 * Un `.max(8)` sull'ordine vieterebbe proprio la configurazione che il modello
 * da 40 ore esiste per descrivere. Si conta il TIPO `lezione`, non la posizione.
 *
 * Il generatore rispetta l'invariante per costruzione (il massimo dei sei
 * modelli è 40h su 5 giorni, cioè 8 al giorno). Le due porte da cui può entrare
 * una nona lezione sono l'editing manuale — `add-campanella` e
 * `update-campanella` — ed è lì che il controllo sta.
 */
const MAX_LEZIONI_GIORNO = 8

const getQuerySchema = z.object({
  sectionId: zUuid,
})

const postQuerySchema = z.object({
  action: z.enum(['set-tempo', 'genera-campanelle', 'set-cell', 'add-campanella', 'update-campanella', 'delete-campanella']),
})

/**
 * Il body del POST cambia forma a ogni `?action=`, ma `sectionId` c'è sempre —
 * ed è il campo su cui si decide se chi scrive può scrivere. Si legge una volta
 * sola (lo stream del body si consuma una volta sola), si asserisce lo scope, e
 * poi ogni ramo rivalida il PROPRIO schema con `parseData`. È lo stesso schema
 * a due tempi di `admin/primaria/materie/route.ts`.
 * `.loose()` perché le chiavi del ramo devono sopravvivere a questa prima passata.
 */
const postBodyBaseSchema = z.object({ sectionId: zUuid }).loose()

const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'orario in formato HH:MM')
const zTipoCamp = z.enum(['lezione', 'intervallo', 'mensa'])

// Editing manuale delle singole campanelle (oltre alla rigenerazione in blocco).
const addCampanellaBodySchema = z
  .object({
    sectionId: zUuid,
    giornoSettimana: z.coerce.number().int().min(1).max(6),
    // `ordine` numera le campanelle, pause comprese: il tetto è la lunghezza di
    // una giornata, non le 8 ore di lezione (vedi `MAX_LEZIONI_GIORNO`).
    ordine: z.coerce.number().int().min(1).max(20),
    oraInizio: zTime,
    oraFine: zTime,
    tipo: zTipoCamp,
  })
  .refine((b) => b.oraFine > b.oraInizio, { message: 'ora_fine deve essere dopo ora_inizio', path: ['oraFine'] })

const updateCampanellaBodySchema = z.object({
  sectionId: zUuid,
  campanellaId: zUuid,
  ordine: z.coerce.number().int().min(1).max(20).optional(),
  oraInizio: zTime.optional(),
  oraFine: zTime.optional(),
  tipo: zTipoCamp.optional(),
})

const deleteCampanellaBodySchema = z.object({
  sectionId: zUuid,
  campanellaId: zUuid,
})

const setTempoBodySchema = z.object({
  sectionId: zUuid,
  modello: z.coerce.number().refine((v) => [27, 29, 40].includes(v), 'modello deve essere 27, 29 o 40'),
  // default dinamico (5) applicato nell'handler come oggi.
  // Il range 5-6 è il `CHECK` della colonna: senza, un 7 arrivava a Postgres e
  // tornava indietro come 500 col messaggio del vincolo.
  giorniSettimana: z.coerce.number().int().min(5).max(6).nullish(),
})

const generaCampanelleBodySchema = z.object({
  sectionId: zUuid,
})

const setCellBodySchema = z.object({
  sectionId: zUuid,
  // 1-6 è il `CHECK` di `orario_settimanale.giorno_settimana`, che è NOT NULL.
  // Prima bastava un valore truthy e poi si faceva `Number(giorno)`: `'x'`
  // superava il controllo e diventava un NaN diretto a una colonna NOT NULL.
  giorno: z.coerce.number().int().min(1).max(6),
  campanellaId: zUuid,
  materiaId: zUuid.nullish(),
  docenteId: zUuid.nullish(),
  note: z.string().nullish(),
})

/**
 * L'UNICA risposta 500 di questo file.
 *
 * Non è una questione di stile. Fino al 2026-09-09 cinque punti rimandavano al
 * client `error.message`, cioè la prosa di PostgREST — inglese, e col nome del
 * vincolo che aveva respinto la scrittura — e non la scrivevano da nessuna parte.
 * È il difetto gemello di quello che AGENTS.md racconta sulle email: il corpo
 * dell'errore del fornitore serve nel LOG, dove qualcuno può leggerlo e capire,
 * non davanti a una segretaria che non può farci niente e a cui racconta com'è
 * fatto lo schema.
 *
 * Di qui passa il messaggio in italiano che dice che cosa NON è successo. Il
 * guasto vero lo scrive nel log chi lo ha in mano, perché è l'unico a sapere
 * quale lettura o quale scrittura era.
 *
 * ⚠️ Queste risposte NON portano ancora un `codice`, quindi in inglese l'utente
 * legge italiano. I codici si dichiarano in `src/lib/ui/esito-fetch.ts` e nei due
 * cataloghi `messages/*∕shared.json` — tre file di altri lotti: è lavoro di una
 * passata sola e centrale, non di questo file (vedi il rapporto).
 */
const guasto = (messaggio: string) => NextResponse.json({ error: messaggio }, { status: 500 })

/** Una riga di `campanelle` come la restituisce PostgREST. */
interface CampanellaRiga {
  id: string
  section_id: string
  giorno_settimana: number
  ordine: number
  ora_inizio: string
  ora_fine: string
  tipo: 'lezione' | 'intervallo' | 'mensa'
}

interface CampanellaGen {
  giorno_settimana: number
  ordine: number
  ora_inizio: string
  ora_fine: string
  tipo: 'lezione' | 'intervallo' | 'mensa'
}

function addMinutes(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + mins
  const nh = Math.floor(total / 60) % 24
  const nm = total % 60
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`
}

/**
 * Genera la struttura campanelle a partire dal modello tempo scuola.
 *
 * IL MONTE ORE È UN CONTRATTO, NON UNA STIMA. Fino al 2026-09-09 questa
 * funzione calcolava UN solo numero di ore per tutti i giorni,
 * `Math.round(modello / giorni)`, e lo ripeteva: su cinque delle sei
 * combinazioni che l'interfaccia sa produrre il totale non tornava.
 *
 *   27h × 5 → round(5,4) = 5 → **25 ore** (ne mancavano DUE a settimana)
 *   27h × 6 → round(4,5) = 5 → 30 (+3)   29h × 5 → round(5,8) = 6 → 30 (+1)
 *   29h × 6 → round(4,8) = 5 → 30 (+1)   40h × 6 → round(6,7) = 7 → 42 (+2)
 *   40h × 5 → 8 → 40, l'unica esatta.
 *
 * Le 25 ore non erano un'ipotesi: al 2026-09-09 le due sole sezioni con
 * campanelle in produzione avevano 25 righe `lezione` su un modello da 27.
 *
 * La divisione con resto le fa tornare tutte e sei: `base` ore a tutti, e il
 * resto distribuito un'ora per giorno partendo dal lunedì. Nessuna combinazione
 * supera così le 8 lezioni giornaliere (il massimo è 40×5 = 8), cioè il tetto
 * che `registro_orario` sa firmare.
 */
function generaCampanelle(modello: number, giorni: number): CampanellaGen[] {
  const base = Math.floor(modello / giorni)
  const resto = modello % giorni
  const tempoPieno = modello === 40
  const rows: CampanellaGen[] = []

  for (let g = 1; g <= giorni; g++) {
    // I primi `resto` giorni portano l'ora in più: la somma torna al modello.
    const oreDelGiorno = Math.max(1, base + (g <= resto ? 1 : 0))
    let ordine = 1
    let cursor = '08:30'
    for (let h = 1; h <= oreDelGiorno; h++) {
      const fine = addMinutes(cursor, 60)
      rows.push({ giorno_settimana: g, ordine: ordine++, ora_inizio: cursor, ora_fine: fine, tipo: 'lezione' })
      cursor = fine
      // Intervallo dopo la 2ª ora.
      if (h === 2) {
        const fineInt = addMinutes(cursor, 15)
        rows.push({ giorno_settimana: g, ordine: ordine++, ora_inizio: cursor, ora_fine: fineInt, tipo: 'intervallo' })
        cursor = fineInt
      }
      // Mensa a metà giornata nel tempo pieno — metà DI QUEL giorno, che ora può
      // essere diverso dagli altri.
      if (tempoPieno && h === Math.ceil(oreDelGiorno / 2)) {
        const fineMensa = addMinutes(cursor, 60)
        rows.push({ giorno_settimana: g, ordine: ordine++, ora_inizio: cursor, ora_fine: fineMensa, tipo: 'mensa' })
        cursor = fineMensa
      }
    }
  }
  return rows
}

/**
 * Carica una campanella e verifica che sia DI QUESTA sezione.
 *
 * Sta in un posto solo perché `set-cell` e `update-campanella` facevano la
 * stessa domanda in due modi diversi, e ne davano due risposte diverse:
 * `update-campanella` filtrava con `.eq('section_id', …)` e rispondeva **404**
 * anche a chi nominava la campanella di un'altra classe — cioè «non esiste» a
 * una riga che esiste — mentre `set-cell` non la faceva affatto, e la coppia
 * (sezione mia, campanella altrui) finiva scritta in `orario_settimanale` senza
 * che nessuna delle due FK avesse niente da obiettare.
 *
 * 404 e 403 non sono sinonimi e non vanno scambiati: il primo dice «hai
 * sbagliato identificativo», il secondo «questa non è tua». Sono due diagnosi
 * diverse per chi legge i log, e due rimedi diversi per chi usa l'app.
 */
async function caricaCampanellaDellaSezione(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sectionId: string,
  campanellaId: string,
): Promise<{ rifiuto: NextResponse; camp: null } | { rifiuto: null; camp: CampanellaRiga }> {
  const { data, error } = await supabase.from('campanelle').select('*').eq('id', campanellaId).maybeSingle()
  if (error) {
    // PostgREST non lancia: senza il controllo, una lettura fallita diventa un
    // `data` a null e quindi un «non trovata» — un guasto travestito da 404.
    logEvento('db', 'error', { operazione: 'admin/primaria/orario:POST', esito: 'campanella-non-letta', sezione: sectionId }, error)
    return {
      rifiuto: NextResponse.json({ error: 'Verifica della campanella non riuscita.', codice: 'LETTURA_FALLITA' }, { status: 500 }),
      camp: null,
    }
  }
  if (!data) return { rifiuto: NextResponse.json({ error: 'Campanella non trovata' }, { status: 404 }), camp: null }
  const camp = data as CampanellaRiga
  if (camp.section_id !== sectionId) {
    return {
      rifiuto: NextResponse.json({ error: 'Campanella non appartenente alla sezione' }, { status: 403 }),
      camp: null,
    }
  }
  return { rifiuto: null, camp }
}

/**
 * C'è posto per un'altra ora di LEZIONE in quel giorno?
 *
 * `escludi` è la campanella che si sta modificando: se è già una lezione il
 * posto lo occupa di suo, e non va contato due volte.
 *
 * Ritorna la `NextResponse` di rifiuto, oppure `null` se si può procedere.
 */
async function assertPostoPerUnaLezione(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sectionId: string,
  giorno: number,
  escludi: string | null,
): Promise<NextResponse | null> {
  let q = supabase
    .from('campanelle')
    .select('id')
    .eq('section_id', sectionId)
    .eq('giorno_settimana', giorno)
    .eq('tipo', 'lezione')
  if (escludi) q = q.neq('id', escludi)
  const { data, error } = await q
  if (error) {
    // PostgREST non lancia: senza questo controllo un guasto di lettura
    // diventerebbe un «zero lezioni, procedi pure», cioè il contrario della
    // difesa. Fail-closed.
    logEvento('db', 'error', { operazione: 'admin/primaria/orario:POST', esito: 'lezioni-del-giorno-non-contate', sezione: sectionId }, error)
    return NextResponse.json({ error: 'Verifica delle ore del giorno non riuscita.', codice: 'LETTURA_FALLITA' }, { status: 500 })
  }
  if ((data ?? []).length >= MAX_LEZIONI_GIORNO) {
    return NextResponse.json(
      { error: `Un giorno non può avere più di ${MAX_LEZIONI_GIORNO} ore di lezione: il registro non saprebbe firmare la nona.` },
      { status: 422 },
    )
  }
  return null
}

// GET /api/admin/primaria/orario?sectionId=
export const GET = withRoute('admin/primaria/orario:GET', async (request: NextRequest) => {
  // Gate MANCANTE, non solo lo scope: questo GET rispondeva 200 a chiunque, senza
  // alcuna credenziale (verificato in produzione il 2026-07-30). Non espone dati
  // di minori — materie, orari e obiettivi sono configurazione — ma è un
  // endpoint amministrativo, e la POST gemella il gate ce l'aveva già.
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId } = q.data

    const supabase = await createAdminClient()
    // Isolamento per sede: `sectionId` arrivava dal client senza verifica — si
    // leggevano e si scrivevano materie, orari, obiettivi e certificati delle
    // competenze su sezioni di un'altra sede.
    const fuoriScopeSez = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (fuoriScopeSez) return fuoriScopeSez

    const [{ data: tempoScuola }, { data: campanelle }, { data: orario }] = await Promise.all([
      supabase.from('tempo_scuola').select('*').eq('section_id', sectionId).eq('attivo', true).maybeSingle(),
      supabase.from('campanelle').select('*').eq('section_id', sectionId).order('giorno_settimana').order('ordine'),
      supabase
        .from('orario_settimanale')
        .select('*, materie(nome, codice), utenti(nome, cognome)')
        .eq('section_id', sectionId),
    ])

    return NextResponse.json({
      success: true,
      data: { tempoScuola: tempoScuola ?? null, campanelle: campanelle ?? [], orario: orario ?? [] },
    })
  } catch (err) {
    // Il messaggio dell'eccezione resta nel LOG, con il suo stack. Rimandarlo al
    // client non aiutava nessuno: chi legge la schermata non può farci niente, e
    // il testo racconta com'è fatto il server.
    logErrore({ operazione: 'admin/primaria/orario:GET', stato: 500 }, err)
    return guasto('Lettura dell’orario non riuscita.')
  }
})

// POST /api/admin/primaria/orario?action=set-tempo|genera-campanelle|set-cell
export const POST = withRoute('admin/primaria/orario:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response
    const action = q.data.action

    // Il body si legge UNA volta (lo stream si consuma una volta sola): prima il
    // campo che decide il permesso, poi lo schema del ramo su `body` già letto.
    const base = await parseBody(request, postBodyBaseSchema)
    if ('response' in base) return base.response
    const body = base.data

    const supabase = await createAdminClient()

    // ISOLAMENTO PER SEDE — mancava del tutto su questo POST. `assertSezioneInScope`
    // compariva una volta sola nel file, dentro il GET: le sei azioni scrivibili
    // qui sotto accettavano il `sectionId` del client così com'era, con un client
    // service-role che scavalca la RLS. Bastava conoscere l'uuid di una sezione
    // per riscrivere l'orario di una classe di un altro plesso.
    const fuoriScopeSez = await assertSezioneInScope(supabase, auth.user, body.sectionId)
    if (fuoriScopeSez) return fuoriScopeSez
    const sectionId = body.sectionId

    if (action === 'set-tempo') {
      const b = parseData(setTempoBodySchema, body)
      if ('response' in b) return b.response
      const { modello } = b.data
      const giorni = b.data.giorniSettimana ?? 5

      // ══════════════════════════════════════════════════════════════════════
      // TRE SCRITTURE, NESSUNA TRANSAZIONE, E UN INDICE UNICO PARZIALE.
      //
      //   CREATE UNIQUE INDEX uq_tempo_scuola_section_attivo
      //     ON public.tempo_scuola USING btree (section_id) WHERE attivo;
      //
      // (`supabase/migrations/20260704120000_baseline.sql:4877`, riletto su
      // `pg_indexes` il 2026-09-09.) E si legge DA LÌ, non da `pg_constraint` né
      // da `information_schema`: un `CREATE UNIQUE INDEX` non lascia una riga in
      // nessuno dei due, e cercarlo nel posto sbagliato è il modo in cui lo si è
      // creduto inesistente — con 48 test verdi a coprire il buco, perché il
      // finto Supabase gli indici unici non li modella.
      //
      // Quell'indice dice che due modelli accesi sulla stessa sezione non sono
      // uno stato scomodo: sono un **23505**. Inserire il modello nuovo GIÀ
      // acceso mentre il precedente lo è ancora — la sequenza scritta qui fino
      // al 2026-09-09 — è un 500 a ogni rigenerazione; e siccome `set-tempo` è
      // l'unica azione che l'interfaccia usa per rigenerare
      // (`OrarioManager.tsx:268`), è l'orario che non si aggiorna mai più.
      //
      // Senza transazione la finestra a ZERO modelli accesi non si può evitare.
      // Si può aprirla tardi e richiuderla anche quando qualcosa va storto:
      //   1. il modello nuovo NASCE SPENTO. L'insert è la scrittura che più
      //      facilmente viene respinta (FK, CHECK, l'indice stesso): se cade
      //      qui non è cambiato niente, e la classe tiene quello che aveva.
      //   2. si spengono i precedenti, tenendone gli id.
      //   3. si accende il nuovo — un update per chiave primaria, il passo che
      //      meno può fallire. Se fallisce lo stesso si RIACCENDONO i
      //      precedenti: una sezione senza modello acceso il GET la legge come
      //      «non configurata» (`maybeSingle()` su `attivo = true`), cioè una
      //      tendina vuota sopra un orario che invece c'è.
      // Un ritentativo converge sempre, da qualunque dei tre punti si sia rotto.
      // ══════════════════════════════════════════════════════════════════════
      const { data: tempo, error: errInsert } = await supabase
        .from('tempo_scuola')
        .insert({ section_id: sectionId, modello, giorni_settimana: giorni, attivo: false })
        .select()
        .single()
      if (errInsert) {
        logEvento('db', 'error', {
          operazione: 'admin/primaria/orario:POST', esito: 'tempo-scuola-non-creato',
          sezione: sectionId, modello, giorni,
        }, errInsert)
        return guasto('Il nuovo tempo scuola non è stato salvato: la classe ha ancora quello di prima.')
      }

      const { data: spenti, error: errSpegni } = await supabase
        .from('tempo_scuola')
        .update({ attivo: false })
        .eq('section_id', sectionId)
        .eq('attivo', true)
        // `.neq` non serve all'indice (la riga nuova è spenta, quindi il filtro
        // `attivo = true` non la prende già di suo): serve a chi legge, perché
        // dice che questo passo tocca gli ALTRI e non ciò che si è appena scritto.
        .neq('id', tempo.id)
        .select('id')
      if (errSpegni) {
        // Due modelli attivi: il GET fa `maybeSingle()` e ne uscirebbe a mani
        // vuote. Va detto, non ingoiato — e il ritentativo ripulisce.
        logEvento('db', 'error', { operazione: 'admin/primaria/orario:POST', esito: 'tempo-scuola-precedente-non-disattivato', sezione: sectionId }, errSpegni)
        return guasto('Il modello precedente non è stato disattivato: riprova.')
      }

      const { error: errAccendi } = await supabase
        .from('tempo_scuola')
        .update({ attivo: true })
        .eq('id', tempo.id)
      if (errAccendi) {
        logEvento('db', 'error', {
          operazione: 'admin/primaria/orario:POST', esito: 'tempo-scuola-non-attivato',
          sezione: sectionId, spenti: (spenti ?? []).length,
        }, errAccendi)
        // COMPENSAZIONE. Il passo 2 ha già spento i precedenti: senza questo la
        // sezione resterebbe senza alcun modello acceso, che è lo stato peggiore
        // dei tre — peggio di «non è cambiato niente» e peggio di «due accesi».
        const idsPrima = (spenti ?? []).map((r) => r.id as string)
        if (idsPrima.length > 0) {
          const { error: errRipristino } = await supabase.from('tempo_scuola').update({ attivo: true }).in('id', idsPrima)
          if (errRipristino) {
            logEvento('db', 'error', {
              operazione: 'admin/primaria/orario:POST', esito: 'tempo-scuola-precedente-non-ripristinato',
              sezione: sectionId, righe: idsPrima.length,
            }, errRipristino)
          } else {
            // Un evento critico logga anche il SUCCESSO: senza, «nessun log» non
            // distingue «rimesso a posto» da «compensazione mai partita».
            logEvento('db', 'info', {
              operazione: 'admin/primaria/orario:POST', esito: 'tempo-scuola-precedente-ripristinato',
              sezione: sectionId, righe: idsPrima.length,
            })
          }
        }
        // Il messaggio non promette in quale dei due stati si è finiti — dipende
        // dall'esito della compensazione, che è nel log. Dice il fatto che vale
        // per entrambi: il modello nuovo NON è quello in vigore, e si riprova.
        return guasto('Il nuovo tempo scuola non è stato attivato: riprova.')
      }

      // Rigenera le campanelle (sostituisce le esistenti).
      const rig = await rigeneraCampanelle(supabase, sectionId, modello, giorni)
      if (rig.rifiuto) return rig.rifiuto
      logEvento('db', 'info', {
        operazione: 'admin/primaria/orario:POST', esito: 'tempo-scuola-impostato', sezione: sectionId,
        modello, giorni, campanelle: rig.rows.length,
      })
      // La riga è nata spenta e ora è accesa: al client va lo stato in cui è
      // rimasta, non quello con cui è passata.
      return NextResponse.json({ success: true, data: { ...tempo, attivo: true } }, { status: 201 })
    }

    if (action === 'genera-campanelle') {
      const b = parseData(generaCampanelleBodySchema, body)
      if ('response' in b) return b.response
      const { data: tempo, error: errTempo } = await supabase
        .from('tempo_scuola')
        .select('modello, giorni_settimana')
        .eq('section_id', sectionId)
        .eq('attivo', true)
        .maybeSingle()
      if (errTempo) {
        logEvento('db', 'error', { operazione: 'admin/primaria/orario:POST', esito: 'tempo-scuola-non-letto', sezione: sectionId }, errTempo)
        return NextResponse.json({ error: 'Lettura del tempo scuola non riuscita.', codice: 'LETTURA_FALLITA' }, { status: 500 })
      }
      if (!tempo) return NextResponse.json({ error: 'Nessun tempo scuola attivo per la sezione' }, { status: 400 })
      const rig = await rigeneraCampanelle(supabase, sectionId, tempo.modello, tempo.giorni_settimana)
      if (rig.rifiuto) return rig.rifiuto
      return NextResponse.json({ success: true, data: rig.rows })
    }

    if (action === 'set-cell') {
      const b = parseData(setCellBodySchema, body)
      if ('response' in b) return b.response
      const { giorno, campanellaId, materiaId, docenteId, note } = b.data

      // La campanella deve essere DI QUESTA sezione: le due FK chiedono solo che
      // le righe esistano, quindi con un `campanella_id` altrui si scriveva una
      // cella che nomina la sezione A e la campanella della sezione B.
      const c = await caricaCampanellaDellaSezione(supabase, sectionId, campanellaId)
      if (c.rifiuto) return c.rifiuto
      // …e del giorno che la cella dichiara: la chiave unica è
      // (section_id, giorno_settimana, campanella_id), quindi una coppia
      // incoerente non viola nulla — crea in silenzio una riga che nessuna
      // schermata sa più mostrare.
      if (c.camp.giorno_settimana !== giorno) {
        return NextResponse.json({ error: 'La campanella non appartiene a quel giorno' }, { status: 400 })
      }

      const { data, error } = await supabase
        .from('orario_settimanale')
        .upsert(
          {
            section_id: sectionId,
            giorno_settimana: giorno,
            campanella_id: campanellaId,
            materia_id: materiaId ?? null,
            docente_id: docenteId ?? null,
            note: note ?? null,
          },
          { onConflict: 'section_id,giorno_settimana,campanella_id' }
        )
        .select()
        .single()
      if (error) {
        logEvento('db', 'error', { operazione: 'admin/primaria/orario:POST', esito: 'cella-orario-non-salvata', sezione: sectionId, giorno }, error)
        return guasto('La casella dell’orario non è stata salvata.')
      }
      return NextResponse.json({ success: true, data }, { status: 201 })
    }

    if (action === 'add-campanella') {
      const b = parseData(addCampanellaBodySchema, body)
      if ('response' in b) return b.response
      const { giornoSettimana, ordine, oraInizio, oraFine, tipo } = b.data

      if (tipo === 'lezione') {
        const pieno = await assertPostoPerUnaLezione(supabase, sectionId, giornoSettimana, null)
        if (pieno) return pieno
      }

      const { data, error } = await supabase
        .from('campanelle')
        .insert({ section_id: sectionId, giorno_settimana: giornoSettimana, ordine, ora_inizio: oraInizio, ora_fine: oraFine, tipo })
        .select()
        .single()
      if (error) {
        // Fra i motivi possibili c'è `campanelle_section_id_giorno_settimana_ordine_key`
        // (23505: quel posto in quel giorno è già occupato). Il codice esatto sta
        // nel log; a schermo va una frase, non il nome di un vincolo.
        logEvento('db', 'error', {
          operazione: 'admin/primaria/orario:POST', esito: 'campanella-non-aggiunta',
          sezione: sectionId, giorno: giornoSettimana, ordine,
        }, error)
        return guasto('La campanella non è stata aggiunta.')
      }
      return NextResponse.json({ success: true, data }, { status: 201 })
    }

    if (action === 'update-campanella') {
      const b = parseData(updateCampanellaBodySchema, body)
      if ('response' in b) return b.response
      const { campanellaId } = b.data
      // Recupera la campanella (scope sezione) per validare gli orari mergiati.
      const c = await caricaCampanellaDellaSezione(supabase, sectionId, campanellaId)
      if (c.rifiuto) return c.rifiuto
      const cur = c.camp
      const oraInizio = b.data.oraInizio ?? String(cur.ora_inizio).slice(0, 5)
      const oraFine = b.data.oraFine ?? String(cur.ora_fine).slice(0, 5)
      if (oraFine <= oraInizio) return NextResponse.json({ error: 'ora_fine deve essere dopo ora_inizio' }, { status: 400 })
      const tipo = b.data.tipo ?? cur.tipo
      const ordine = b.data.ordine ?? cur.ordine

      // Promuovere una pausa a lezione occupa un posto nuovo nella giornata.
      if (tipo === 'lezione' && cur.tipo !== 'lezione') {
        const pieno = await assertPostoPerUnaLezione(supabase, sectionId, cur.giorno_settimana, campanellaId)
        if (pieno) return pieno
      }

      // LA CELLA SI CANCELLA SOLO ALLA TRANSIZIONE, e prima dell'update.
      // Prima la condizione era `tipo !== 'lezione'` sul tipo GIÀ MERGIATO:
      // bastava correggere l'ora di una campanella già `mensa` — che il tipo non
      // lo cambiava affatto — perché partisse la DELETE sulla cella orario.
      // Sta prima dell'update perché così un guasto non lascia nulla a metà: se
      // la delete fallisce non è cambiato niente e il ritentativo riparte pulito.
      if (tipo !== 'lezione' && cur.tipo === 'lezione') {
        const { error: errCella } = await supabase
          .from('orario_settimanale')
          .delete()
          .eq('section_id', sectionId)
          .eq('campanella_id', campanellaId)
        if (errCella) {
          logEvento('db', 'error', { operazione: 'admin/primaria/orario:POST', esito: 'cella-orfana-non-rimossa', sezione: sectionId }, errCella)
          return guasto('La casella dell’orario non è stata rimossa.')
        }
      }

      const { data, error } = await supabase
        .from('campanelle')
        .update({ ora_inizio: oraInizio, ora_fine: oraFine, tipo, ordine })
        .eq('id', campanellaId)
        .eq('section_id', sectionId)
        .select()
        .single()
      if (error) {
        // Anche qui il 23505 di `campanelle_section_id_giorno_settimana_ordine_key`
        // è possibile: si cambia `ordine` su un posto già occupato.
        logEvento('db', 'error', {
          operazione: 'admin/primaria/orario:POST', esito: 'campanella-non-aggiornata',
          sezione: sectionId, giorno: cur.giorno_settimana, ordine,
        }, error)
        return guasto('La campanella non è stata modificata.')
      }
      return NextResponse.json({ success: true, data })
    }

    if (action === 'delete-campanella') {
      const b = parseData(deleteCampanellaBodySchema, body)
      if ('response' in b) return b.response
      const { campanellaId } = b.data
      const { error } = await supabase
        .from('campanelle')
        .delete()
        .eq('id', campanellaId)
        .eq('section_id', sectionId)
      if (error) {
        logEvento('db', 'error', { operazione: 'admin/primaria/orario:POST', esito: 'campanella-non-rimossa', sezione: sectionId }, error)
        return guasto('La campanella non è stata rimossa.')
      }
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'action non riconosciuta' }, { status: 400 })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/orario:POST', stato: 500 }, err)
    return guasto('Operazione sull’orario non riuscita.')
  }
})

/**
 * Sostituisce in blocco le campanelle di una sezione.
 *
 * Ritorna il RIFIUTO già confezionato, oppure le righe scritte. Fino al
 * 2026-09-09 scartava sia l'errore della delete sia quello dell'insert e
 * restituiva `data ?? []`: nel caso «delete riuscita, insert respinta» la classe
 * restava con ZERO campanelle e `set-tempo` rispondeva 201, cioè a schermo
 * compariva «salvato». PostgREST non lancia: il `try/catch` che non c'era non
 * sarebbe scattato comunque, perché non c'è niente da catturare.
 *
 * La risposta la costruisce QUI, in un punto solo, chi conosce il guasto: i due
 * chiamanti la inoltrano e basta. Due modi di fallire, un solo modo di dirlo.
 */
async function rigeneraCampanelle(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sectionId: string,
  modello: number,
  giorni: number
): Promise<{ rifiuto: NextResponse; rows: null } | { rifiuto: null; rows: Record<string, unknown>[] }> {
  const respinta = (messaggio: string) => ({ rifiuto: guasto(messaggio), rows: null } as const)

  // Rimuove le campanelle esistenti (cascade pulisce le celle orario collegate).
  const { error: errDelete } = await supabase.from('campanelle').delete().eq('section_id', sectionId)
  if (errDelete) {
    logEvento('db', 'error', { operazione: 'admin/primaria/orario:POST', esito: 'campanelle-non-rimosse', sezione: sectionId }, errDelete)
    return respinta('Le campanelle precedenti non sono state rimosse: l\u2019orario \u00e8 rimasto quello di prima.')
  }
  const rows = generaCampanelle(modello, giorni).map((c) => ({ ...c, section_id: sectionId }))
  const { data, error: errInsert } = await supabase.from('campanelle').insert(rows).select()
  if (errInsert) {
    logEvento('db', 'error', {
      operazione: 'admin/primaria/orario:POST', esito: 'campanelle-non-generate', sezione: sectionId, righe: rows.length,
    }, errInsert)
    return respinta('Le campanelle non sono state generate: la classe è rimasta senza orario.')
  }
  // Un evento critico logga anche il SUCCESSO: con i soli errori, «nessun log»
  // non distingue «tutto ok» da «non è mai partito niente».
  logEvento('db', 'info', {
    operazione: 'admin/primaria/orario:POST', esito: 'campanelle-generate', sezione: sectionId, righe: data?.length ?? 0,
  })
  return { rifiuto: null, rows: (data ?? []) as Record<string, unknown>[] }
}
