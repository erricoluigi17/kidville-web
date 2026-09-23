import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertPagamentoInScope, formaConfronto, scuoleDiUtente } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import {
  GIORNI_STORICO_CODA,
  STATI_ATTIVI,
  TETTO_VOCI_GET,
  codaAssente,
  senzaDoppioni,
  stimaFineCoda,
  svegliaCoda,
  voceRpc,
  zCorpoAccoda,
  zQueryGetCoda,
  zRispostaAccoda,
  type ConteggiCoda,
  type RispostaConteggiCoda,
  type RispostaGetCoda,
  type StatoCoda,
  type StatoVoceCoda,
  type VoceCodaVista,
} from '@/lib/fatture-coda/api'

/**
 * ─── LA CODA FATTURE: LEGGERLA (GET) E ACCODARE (POST) ──────────────────────────────
 *
 * GET — tutta la coda, di TUTTE le sedi, per tutto lo staff (decisione 6 del titolare:
 * l'utenza Aruba è una sola e il secchio orario è condiviso, quindi chi fattura a Cesa deve
 * vedere che davanti ci sono quaranta fatture di Giugliano). L'unica cosa che non attraversa
 * la sede è il MESSAGGIO d'esito, che può nominare un intestatario: per le voci delle sedi
 * che l'utente non ha, si vede solo il codice. Ogni voce porta `propria`: le azioni
 * (`/coda/azioni`) scrivono solo sulle sedi dell'utente, e il pannello lo sa prima di provarci.
 *
 * GET `?solo=conteggi` — il contatore della voce di menu: solo `conteggi`, senza voci, autori
 * né sedi. Il menu si monta su ogni pagina del cockpit: una lettura leggera, non la coda intera.
 *
 * POST — accoda fino a 500 pagamenti in un gesto. Scope di sede su OGNI voce, pagamento
 * saldato, poi la RPC `fatture_coda_accoda` e la sveglia del lavoratore, senza aspettarlo.
 *
 * DB non migrato (tabella o RPC assenti): la GET risponde `{disponibile:false}`, la POST 503
 * `CODA_FATTURE_NON_DISPONIBILE`. Non è un guasto dell'utente, e non si finge un successo.
 */

// Letterali locali: il lock `errori-con-codice` li risolve solo così (vedi `api.ts`).
const CODICE_NON_DISPONIBILE = 'CODA_FATTURE_NON_DISPONIBILE'
const CODICE_NON_SALDATO = 'PAGAMENTO_NON_SALDATO'
const CODICE_SCRITTURA_FALLITA = 'CODA_FATTURE_SCRITTURA_FALLITA'
const CODICE_LETTURA_FALLITA = 'LETTURA_FALLITA'

const MESSAGGIO_NON_DISPONIBILE =
  'La coda delle fatture non è ancora disponibile: nessuna fattura è stata messa in coda.'

/** Quante verifiche di sede corrono insieme: 500 in fila costerebbero secondi di troppo. */
const SCOPE_IN_PARALLELO = 20
/** Quanti id per `.in()`: 500 uuid in una query string sono ~19 KB. */
const ID_PER_LETTURA = 100

const COLONNE_VOCE =
  'id, stato, urgente, accodata_il, esito_codice, esito_messaggio, scuola_id, pagamento_id, creato_da, ' +
  'pagamenti:pagamento_id ( descrizione, importo, alunni:alunno_id ( nome, cognome ) ), ' +
  'schools:scuola_id ( nome )'

const COLONNE_STATO = 'sospesa, sospesa_il, pausa_fino_a, pausa_motivo, ultimo_giro_il'

interface Esito<T> {
  data: T
  error: unknown
}
interface Conteggio {
  count: number | null
  error: unknown
}

type Uno<T> = T | T[] | null | undefined
const primo = <T,>(v: Uno<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

interface RigaVoce {
  id: string
  stato: StatoVoceCoda
  urgente: boolean | null
  accodata_il: string | null
  esito_codice: string | null
  esito_messaggio: string | null
  scuola_id: string
  pagamento_id: string
  creato_da: string | null
  pagamenti?: Uno<{
    descrizione: string | null
    importo: number | string | null
    alunni?: Uno<{ nome: string | null; cognome: string | null }>
  }>
  schools?: Uno<{ nome: string | null }>
}

function nomeDi(p: { nome?: string | null; cognome?: string | null } | null): string | null {
  if (!p) return null
  const s = `${p.nome ?? ''} ${p.cognome ?? ''}`.trim()
  return s.length > 0 ? s : null
}

function aNumero(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function nonDisponibile(operazione: string, err: unknown): NextResponse {
  logEvento('fattura', 'warn', { operazione, esito: 'coda-assente' }, err)
  return NextResponse.json(
    { error: MESSAGGIO_NON_DISPONIBILE, codice: CODICE_NON_DISPONIBILE, disponibile: false },
    { status: 503 },
  )
}

// ═══════════════════════════════════════════════════════════════════════════════════
// GET
// ═══════════════════════════════════════════════════════════════════════════════════

export const GET = withRoute('pagamenti/fattura/coda:GET', async (request: Request) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, zQueryGetCoda)
  if ('response' in q) return q.response

  const sb = await createAdminClient()
  const adesso = new Date()
  const da7g = new Date(adesso.getTime() - GIORNI_STORICO_CODA * 24 * 60 * 60 * 1000).toISOString()

  // ─── Solo il contatore del menu ─────────────────────────────────────────────
  if (q.data.solo === 'conteggi') {
    const letti = await Promise.all(CONTEGGI.map(([stato, storico]) => conta(sb, stato, storico ? da7g : undefined)))
    const erroriC = letti.map((c) => c.error).filter(Boolean)
    if (erroriC.some(codaAssente)) {
      logEvento('fattura', 'info', { operazione: 'coda:GET-conteggi', esito: 'coda-assente' }, erroriC.find(codaAssente))
      const corpo: RispostaConteggiCoda = { disponibile: false }
      return NextResponse.json(corpo)
    }
    if (erroriC.length > 0) {
      logEvento('fattura', 'error', { operazione: 'coda:GET-conteggi', esito: 'lettura-fallita', n: erroriC.length }, erroriC[0])
      return NextResponse.json(
        { error: 'Impossibile leggere la coda delle fatture: riprova fra poco.', codice: CODICE_LETTURA_FALLITA },
        { status: 500 },
      )
    }
    const corpo: RispostaConteggiCoda = { disponibile: true, conteggi: daConteggi(letti) }
    return NextResponse.json(corpo)
  }

  // Otto letture indipendenti, in parallelo. I conteggi sono ESATTI e separati dall'elenco:
  // l'elenco si ferma a 1000 righe, i contatori no.
  const leggiStato = sb
    .from('fatture_coda_stato')
    .select(COLONNE_STATO)
    .eq('id', 1)
    .maybeSingle() as unknown as PromiseLike<Esito<Partial<StatoCoda> | null>>
  const leggiAttive = sb
    .from('fatture_coda')
    .select(COLONNE_VOCE)
    .in('stato', [...STATI_ATTIVI])
    .order('urgente', { ascending: false })
    .order('gruppo_seq', { ascending: true })
    .order('data_riferimento', { ascending: true })
    .order('ordine_selezione', { ascending: true })
    .order('id', { ascending: true })
    .limit(TETTO_VOCI_GET) as unknown as PromiseLike<Esito<RigaVoce[] | null>>
  const leggiConcluse = sb
    .from('fatture_coda')
    .select(COLONNE_VOCE)
    .in('stato', ['emessa', 'tolta'])
    .gte('concluso_il', da7g)
    .order('concluso_il', { ascending: false })
    .limit(TETTO_VOCI_GET) as unknown as PromiseLike<Esito<RigaVoce[] | null>>

  const [statoR, attiveR, concluseR, conteggiR] = await Promise.all([
    leggiStato,
    leggiAttive,
    leggiConcluse,
    Promise.all(CONTEGGI.map(([stato, storico]) => conta(sb, stato, storico ? da7g : undefined))),
  ])

  const errori = [statoR.error, attiveR.error, concluseR.error, ...conteggiR.map((c) => c.error)].filter(Boolean)
  if (errori.some(codaAssente)) {
    logEvento('fattura', 'info', { operazione: 'coda:GET', esito: 'coda-assente' }, errori.find(codaAssente))
    const corpo: RispostaGetCoda = { disponibile: false }
    return NextResponse.json(corpo)
  }
  if (errori.length > 0) {
    logEvento('fattura', 'error', { operazione: 'coda:GET', esito: 'lettura-fallita', n: errori.length }, errori[0])
    return NextResponse.json(
      { error: 'Impossibile leggere la coda delle fatture: riprova fra poco.', codice: CODICE_LETTURA_FALLITA },
      { status: 500 },
    )
  }

  const s = statoR.data ?? {}
  const stato: StatoCoda = {
    sospesa: s.sospesa === true,
    sospesa_il: s.sospesa_il ?? null,
    pausa_fino_a: s.pausa_fino_a ?? null,
    pausa_motivo: s.pausa_motivo ?? null,
    ultimo_giro_il: s.ultimo_giro_il ?? null,
  }
  const conteggi = daConteggi(conteggiR)

  const attive = attiveR.data ?? []
  const righe = [...attive, ...(concluseR.data ?? [])].slice(0, TETTO_VOCI_GET)

  // Chi ha accodato: `creato_da` non ha FK verso `utenti` (per non accendere la guardia
  // tracce-docente), quindi niente embed — una lettura per gli id distinti. Se fallisce, i
  // nomi restano vuoti: non è un motivo per non mostrare la coda.
  const nomi = new Map<string, string | null>()
  const idsAutori = [...new Set(righe.map((r) => r.creato_da).filter((x): x is string => Boolean(x)))]
  for (let i = 0; i < idsAutori.length; i += ID_PER_LETTURA) {
    const { data, error } = await sb
      .from('utenti')
      .select('id, nome, cognome')
      .in('id', idsAutori.slice(i, i + ID_PER_LETTURA))
    if (error) {
      logEvento('fattura', 'warn', { operazione: 'coda:GET', esito: 'autori-non-letti' }, error)
      break
    }
    for (const u of (data ?? []) as { id: string; nome: string | null; cognome: string | null }[]) {
      nomi.set(u.id, nomeDi(u))
    }
  }

  const plessi = new Set((await scuoleDiUtente(sb, auth.user)).map(formaConfronto))

  let posizione = 0
  const voci: VoceCodaVista[] = righe.map((r) => {
    const pag = primo(r.pagamenti)
    const propria = plessi.has(formaConfronto(r.scuola_id))
    return {
      id: r.id,
      stato: r.stato,
      urgente: r.urgente === true,
      accodata_il: r.accodata_il ?? null,
      esito_codice: r.esito_codice ?? null,
      esito_messaggio: propria ? (r.esito_messaggio ?? null) : null,
      scuola_id: r.scuola_id,
      scuola_nome: primo(r.schools)?.nome ?? null,
      pagamento_id: r.pagamento_id,
      alunno: nomeDi(primo(pag?.alunni)),
      descrizione: pag?.descrizione ?? null,
      importo: aNumero(pag?.importo),
      creato_da_nome: r.creato_da ? (nomi.get(r.creato_da) ?? null) : null,
      posizione: r.stato === 'in_coda' ? ++posizione : null,
      propria,
    }
  })

  const corpo: RispostaGetCoda = {
    disponibile: true,
    stato,
    conteggi,
    stima_fine: stimaFineCoda(conteggi.in_coda + conteggi.in_invio, {
      adesso,
      sospesa: stato.sospesa,
      pausaFinoA: stato.pausa_fino_a,
    }),
    voci,
  }
  return NextResponse.json(corpo)
})

/**
 * I cinque contatori, nell'ordine di `ConteggiCoda`. `true` = solo le concluse negli ultimi
 * `GIORNI_STORICO_CODA` giorni. Un elenco solo, per la GET piena e per `?solo=conteggi`.
 */
const CONTEGGI: readonly (readonly [StatoVoceCoda, boolean])[] = [
  ['in_coda', false],
  ['in_invio', false],
  ['errore', false],
  ['emessa', true],
  ['tolta', true],
]

function daConteggi(c: readonly Conteggio[]): ConteggiCoda {
  return {
    in_coda: c[0]?.count ?? 0,
    in_invio: c[1]?.count ?? 0,
    errore: c[2]?.count ?? 0,
    emesse_7g: c[3]?.count ?? 0,
    tolte_7g: c[4]?.count ?? 0,
  }
}

/** Un conteggio esatto di voci in uno stato; con `dal`, solo quelle concluse da allora. */
function conta(sb: SupabaseClient, stato: StatoVoceCoda, dal?: string): PromiseLike<Conteggio> {
  const q = sb.from('fatture_coda').select('id', { count: 'exact', head: true }).eq('stato', stato)
  return (dal ? q.gte('concluso_il', dal) : q) as unknown as PromiseLike<Conteggio>
}

// ═══════════════════════════════════════════════════════════════════════════════════
// POST
// ═══════════════════════════════════════════════════════════════════════════════════

export const POST = withRoute('pagamenti/fattura/coda:POST', async (request: Request) => {
  // Il gate PRIMA della lettura del corpo (lock `corpo-letto-dopo-il-gate`).
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, zCorpoAccoda)
  if ('response' in b) return b.response
  const voci = senzaDoppioni(b.data.voci, (v) => v.pagamento_id)
  const urgente = b.data.urgente === true

  const sb = await createAdminClient()

  // ─── ISOLAMENTO PER SEDE, VOCE PER VOCE ───────────────────────────────────────
  // Basta UNA voce fuori scope perché l'intera richiesta sia rifiutata, come nel lotto.
  // Le verifiche corrono a gruppi, ma la risposta è quella della PRIMA voce che fallisce
  // nell'ordine dato: il risultato non dipende da quale promessa arriva prima.
  for (let i = 0; i < voci.length; i += SCOPE_IN_PARALLELO) {
    const gruppo = voci.slice(i, i + SCOPE_IN_PARALLELO)
    const esiti = await Promise.all(gruppo.map((v) => assertPagamentoInScope(sb, auth.user, v.pagamento_id)))
    const rifiuto = esiti.find((e) => e !== null)
    if (rifiuto) return rifiuto
  }

  // ─── SOLO PAGAMENTI SALDATI ───────────────────────────────────────────────────
  // Il lavoratore lo ricontrollerebbe (`emettiFatturaPagamento` rifiuta i non saldati), ma
  // scoprirlo fra un'ora come «errore» in coda è peggio che dirlo adesso.
  const plessi = await scuoleDiUtente(sb, auth.user)
  const saldati = new Set<string>()
  const ids = voci.map((v) => v.pagamento_id)
  for (let i = 0; i < ids.length; i += ID_PER_LETTURA) {
    const { data, error } = await sb
      .from('pagamenti')
      .select('id, stato')
      .in('id', ids.slice(i, i + ID_PER_LETTURA))
      .in('scuola_id', plessi)
    if (error) {
      logEvento('fattura', 'error', { operazione: 'coda:POST', esito: 'pagamenti-non-letti' }, error)
      return NextResponse.json(
        { error: 'Impossibile verificare i pagamenti: nessuna fattura è stata messa in coda.', codice: CODICE_LETTURA_FALLITA },
        { status: 500 },
      )
    }
    for (const p of (data ?? []) as { id: string; stato: string | null }[]) {
      if (p.stato === 'pagato') saldati.add(formaConfronto(p.id))
    }
  }
  const nonSaldati = ids.filter((id) => !saldati.has(formaConfronto(id)))
  if (nonSaldati.length > 0) {
    logEvento('fattura', 'warn', { operazione: 'coda:POST', esito: 'pagamento-non-saldato', n: nonSaldati.length })
    return NextResponse.json(
      {
        error: 'La fattura può essere messa in coda solo per pagamenti saldati: nessuna fattura è stata messa in coda.',
        codice: CODICE_NON_SALDATO,
        data: { pagamento_ids: nonSaldati },
      },
      { status: 400 },
    )
  }

  // ─── ACCODAMENTO ──────────────────────────────────────────────────────────────
  const { data, error } = await sb.rpc('fatture_coda_accoda', {
    p_voci: voci.map((v, i) => voceRpc(v, i)),
    p_creato_da: auth.user.id,
    p_urgente: urgente,
  })
  if (error) {
    if (codaAssente(error)) return nonDisponibile('coda:POST', error)
    logEvento('fattura', 'error', { operazione: 'coda:POST', esito: 'accodamento-fallito', n: voci.length }, error)
    return NextResponse.json(
      { error: 'Non è stato possibile mettere in coda le fatture: riprova fra poco.', codice: CODICE_SCRITTURA_FALLITA },
      { status: 500 },
    )
  }
  const letta = zRispostaAccoda.safeParse(data)
  if (!letta.success) {
    // La RPC ha scritto (nessun errore) ma ha risposto in una forma inattesa: le voci sono in
    // coda, quindi NON è un 500 — ma il conteggio non si può dare per buono.
    logEvento('fattura', 'error', { operazione: 'coda:POST', esito: 'risposta-rpc-inattesa', n: voci.length }, letta.error)
  }
  const risposta = letta.success ? letta.data : { gruppo_id: '', accodate: 0, gia_in_coda: [] }

  logEvento('fattura', 'info', {
    operazione: 'coda:POST',
    esito: 'accodate',
    n: risposta.accodate,
    gia_in_coda: risposta.gia_in_coda.length,
    urgente,
  })

  if (risposta.accodate > 0 || !letta.success) svegliaCoda(sb, 'coda:POST')

  return NextResponse.json(risposta)
})
