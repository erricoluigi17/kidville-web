// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * IL LAVORATORE DELLA CODA FATTURE — un giro alla volta, senza nessun browser.
 *
 * ─── COSA È FINTO E COSA NO ──────────────────────────────────────────────────────────
 * Finti: `emettiFatturaPagamento` (la sua correttezza la misurano i test dell'emissione),
 * il conteggio del tetto orario, e il database — ma NON come un mock piatto. Le RPC della
 * coda sono simulate da un piccolo modello con STATO (`CodaFinta`) che rispetta il
 * contratto del §1 della spec: `prendi` rifiuta con coda sospesa, in pausa, con un altro
 * lavoratore o prima di 65 s dall'ultimo accesso della coda ad Aruba (correzione del 24/09:
 * lo timbrano `prendi` quando consegna voci e `rilascia` per un token che ne aveva prese),
 * `chiudi` vale solo col token giusto, `rilascia` scrive la pausa. Così un
 * test può chiedere «dopo tre giri la coda è vuota?» invece di «è stata chiamata una
 * funzione?», che sarebbe verde anche con il giro sbagliato.
 *
 * Vero: il ciclo del blocco (`eseguiBloccoFatture`) e la mappatura degli esiti. I timer
 * sono finti PIENI, perché il ciclo aspetta `PAUSA_FRA_UPLOAD_MS` fra un upload e l'altro
 * e il budget si misura con `Date.now()`.
 */

const h = vi.hoisted(() => ({
  emetti: vi.fn(),
  conta: vi.fn(),
  eventi: [] as {
    evento: string
    livello: string
    campi: Record<string, unknown>
    errore?: unknown
    opzioni?: unknown
  }[],
}))

vi.mock('@/lib/aruba/emissione', async (originale) => {
  const vero = await originale<typeof import('@/lib/aruba/emissione')>()
  return { ...vero, emettiFatturaPagamento: h.emetti }
})
vi.mock('@/lib/pagamenti/tetto-orario-aruba', async (originale) => {
  const vero = await originale<typeof import('@/lib/pagamenti/tetto-orario-aruba')>()
  return { ...vero, contaEmesseUltimaOra: h.conta }
})
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    // Anche il quarto e il quinto argomento (2b): l'errore PostgREST e il `distingui`
    // sono parte di ciò che il giro promette di loggare.
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>, errore?: unknown, opzioni?: unknown) => {
      h.eventi.push({ evento, livello, campi, errore, opzioni })
    },
  }
})

import {
  eseguiGiroCoda,
  inFinestraSync,
  classificaEsito,
  FRASE_429_PRIMA_DEL_NUMERO,
  OPERAZIONE_GIRO,
  PRESTITO_S,
  PAUSA_429_MINUTI,
  PAUSA_INCERTO_MINUTI,
  CODICI_ESITO_CODA,
  DISTANZA_ACCESSI_S,
  ATTESA_MASSIMA_MS,
} from '@/lib/fatture-coda/giro'
import { TETTO_BLOCCO, BUDGET_BLOCCO_MS, RISERVA_PEGGIORE_MS, PAUSA_FRA_UPLOAD_MS } from '@/lib/pagamenti/lotto-fatture'
import { senzaCommenti } from '../../architecture/soglia-fotografia'
import { datiAltroDaPersonaScelta } from '@/lib/fatturazione/intestatario-scelto'
import { VALORE_NON_REGISTRATO } from '@/lib/audit/riassunto'
import { SOGLIA_ORARIA_APP } from '@/lib/pagamenti/tetto-orario-aruba'
import type { SupabaseClient } from '@supabase/supabase-js'

// ─── uuid FINTI: il repository è pubblico ────────────────────────────────────────────
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}
const SEDE = uuid(8000)
/**
 * La sede del BAMBINO, diversa da quella dell'attore (`SEDE`, in `utenti`): la riga di audit
 * della persona sulla scheda deve stare sotto il plesso del bambino (2b, T4).
 */
const SEDE_ALUNNO = uuid(8001)
const STAFF = uuid(7000)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ─── IL MODELLO DELLA CODA ───────────────────────────────────────────────────────────

interface VoceFinta {
  id: string
  pagamento_id: string
  scuola_id: string
  creato_da: string
  stato: 'in_coda' | 'in_invio' | 'emessa' | 'errore' | 'tolta'
  urgente: boolean
  gruppo_seq: number
  ordine_selezione: number
  intestatario_scelto: unknown
  conferma_proposta: boolean
  causale_manuale: string | null
  lavoratore_token: string | null
  esito_codice: string | null
  esito_messaggio: string | null
  tentativi: number
}

class CodaFinta {
  voci: VoceFinta[] = []
  sospesa = false
  pausaFinoA: number | null = null
  pausaMotivo: string | null = null
  lavoratore: { token: string; scade: number } | null = null
  /**
   * Fin quando un giro della coda può aver usato una sessione Aruba (`ultimo_accesso_il`,
   * correzione del 24/09). `prendi` non consegna niente prima di 65 s da qui.
   */
  ultimoAccesso: number | null = null
  /**
   * I token che hanno preso voci: il modello dell'`EXISTS … lavoratore_token = p_token` di
   * `rilascia`. Serve a parte perché il `chiudi` del modello azzera il token delle voci,
   * quindi le voci da sole non basterebbero a ricostruirlo.
   */
  tokenConVoci = new Set<string>()
  /** Risposta forzata sulla lettura di `fatture_coda_stato` (G5: colonna non ancora migrata). */
  guastoStato: { data: unknown; error: unknown } | null = null
  chiamate: { nome: string; args: Record<string, unknown>; t: number }[] = []
  /** Le scritture arrivate con `.from(…)`: tabella, operazione, corpo, filtri. */
  scritture: { tabella: string; op: string; payload: unknown; filtri: Record<string, unknown> }[] = []
  utenti: { id: string; role: string; scuola_id: string | null }[] = [{ id: STAFF, role: 'segreteria', scuola_id: SEDE }]
  /**
   * Il ponte `utenti_scuole` della Direzione (`scuoleDiUtente`): il ramo della persona confronta
   * la sede del BAMBINO con le sedi di chi ha accodato, come faceva la PATCH (giro 1, correzione).
   */
  utentiScuole: { utente_id: string; scuola_id: string }[] = []
  /** Risposta forzata sul ponte (caso i′: lettura fallita ⇒ nessuna sede ⇒ nessuna scrittura). */
  guastoSedi: { data: unknown; error: unknown } | null = null
  /** La scheda del bambino, come la legge `ricordaPersonaSullaScheda` PRIMA di sostituirla (2b, T4). */
  scheda: { intestatario_fatture: unknown; scuola_id: string; section_id: string | null } | null =
    { intestatario_fatture: null, scuola_id: SEDE_ALUNNO, section_id: null }
  /** Risposte forzate sulla scheda: la lettura o la UPDATE di `alunni` (caso h). */
  guastoScheda: { lettura?: { data: unknown; error: unknown }; scrittura?: { data: unknown; error: unknown } } = {}

  accoda(n: number, extra: Partial<VoceFinta> = {}, da = 1): VoceFinta[] {
    const nuove = Array.from({ length: n }, (_, i) => ({
      id: uuid(5000 + da + i),
      pagamento_id: uuid(da + i),
      scuola_id: SEDE,
      creato_da: STAFF,
      stato: 'in_coda' as const,
      urgente: false,
      gruppo_seq: 1,
      ordine_selezione: da + i,
      intestatario_scelto: null,
      conferma_proposta: false,
      causale_manuale: null,
      lavoratore_token: null,
      esito_codice: null,
      esito_messaggio: null,
      tentativi: 0,
      ...extra,
    }))
    this.voci.push(...nuove)
    return nuove
  }

  voce(pagamentoN: number): VoceFinta {
    const v = this.voci.find((x) => x.pagamento_id === uuid(pagamentoN))
    if (!v) throw new Error(`voce ${pagamentoN} assente`)
    return v
  }

  rpc(nome: string, args: Record<string, unknown> = {}): { data: unknown; error: unknown } {
    this.chiamate.push({ nome, args, t: Date.now() })
    const adesso = Date.now()
    switch (nome) {
      case 'fatture_coda_bidello':
        return { data: 0, error: null }
      case 'fatture_coda_prendi': {
        if (this.sospesa) return { data: [], error: null }
        if (this.pausaFinoA !== null && this.pausaFinoA > adesso) return { data: [], error: null }
        if (this.lavoratore && this.lavoratore.token !== args.p_token && this.lavoratore.scade > adesso) {
          return { data: [], error: null }
        }
        // Meno di 65 s dall'ultimo accesso: come la pausa, niente testimone e nessuna voce toccata.
        if (this.ultimoAccesso !== null && adesso - this.ultimoAccesso < DISTANZA_ACCESSI_S * 1000) {
          return { data: [], error: null }
        }
        this.lavoratore = { token: String(args.p_token), scade: adesso + Number(args.p_prestito_s) * 1000 }
        const prese = this.voci
          .filter((v) => v.stato === 'in_coda')
          .sort((a, b) => Number(b.urgente) - Number(a.urgente) || a.gruppo_seq - b.gruppo_seq || a.ordine_selezione - b.ordine_selezione)
          .slice(0, Number(args.p_max))
        for (const v of prese) {
          v.stato = 'in_invio'
          v.lavoratore_token = String(args.p_token)
          v.tentativi++
        }
        // Almeno una voce consegnata: il `signin` di questo giro arriva fra un istante.
        if (prese.length > 0) {
          this.ultimoAccesso = adesso
          this.tokenConVoci.add(String(args.p_token))
        }
        return { data: prese.map((v) => ({ ...v })), error: null }
      }
      case 'fatture_coda_chiudi': {
        const v = this.voci.find((x) => x.id === args.p_id)
        if (!v || v.stato !== 'in_invio' || v.lavoratore_token !== args.p_token) return { data: null, error: null }
        v.stato = args.p_esito === 'riprova' ? 'in_coda' : (args.p_esito as VoceFinta['stato'])
        v.lavoratore_token = null
        v.esito_codice = (args.p_codice as string | null) ?? null
        v.esito_messaggio = (args.p_messaggio as string | null) ?? null
        return { data: null, error: null }
      }
      case 'fatture_coda_rilascia': {
        // Il timbro della FINE del giro, per un token che aveva voci: mai all'indietro.
        if (this.tokenConVoci.has(String(args.p_token))) {
          this.ultimoAccesso = Math.max(this.ultimoAccesso ?? adesso, adesso)
        }
        if (this.lavoratore?.token === args.p_token) this.lavoratore = null
        const minuti = Number(args.p_pausa_minuti)
        if (minuti > 0) {
          this.pausaFinoA = Math.max(this.pausaFinoA ?? adesso, adesso + minuti * 60_000)
          this.pausaMotivo = (args.p_motivo as string | null) ?? null
        }
        return { data: null, error: null }
      }
      default:
        return { data: null, error: { code: 'PGRST202', message: `funzione ${nome} sconosciuta` } }
    }
  }

  client(): SupabaseClient {
    return {
      rpc: async (nome: string, args?: Record<string, unknown>) => this.rpc(nome, args),
      from: (tabella: string) => {
        const ctx: { op: string; payload?: unknown; filtri: Record<string, unknown> } = { op: 'select', filtri: {} }
        const b: Record<string, unknown> = {}
        const esegui = () => {
          if (ctx.op !== 'select') this.scritture.push({ tabella, op: ctx.op, payload: ctx.payload, filtri: { ...ctx.filtri } })
          if (tabella === 'utenti') return { data: this.utenti, error: null }
          if (tabella === 'utenti_scuole') {
            if (this.guastoSedi) return this.guastoSedi
            return { data: this.utentiScuole.filter((r) => r.utente_id === ctx.filtri.utente_id), error: null }
          }
          if (tabella === 'alunni' && ctx.op === 'update') {
            if (this.guastoScheda.scrittura) return this.guastoScheda.scrittura
            // Con STATO, come le RPC: una lettura fatta DOPO la UPDATE vedrebbe già la persona.
            if (this.scheda) {
              this.scheda = {
                ...this.scheda,
                intestatario_fatture: (ctx.payload as { intestatario_fatture: unknown }).intestatario_fatture,
              }
            }
            return { data: [{ id: ctx.filtri.id }], error: null }
          }
          if (tabella === 'alunni') return this.guastoScheda.lettura ?? { data: this.scheda, error: null }
          if (tabella === 'fatture_coda_stato') {
            if (this.guastoStato) return this.guastoStato
            const iso = (t: number | null | undefined) => (typeof t === 'number' ? new Date(t).toISOString() : null)
            return {
              data: {
                ultimo_accesso_il: iso(this.ultimoAccesso),
                lavoratore_scade_il: iso(this.lavoratore?.scade),
                pausa_fino_a: iso(this.pausaFinoA),
                sospesa: this.sospesa,
              },
              error: null,
            }
          }
          return { data: [], error: null }
        }
        Object.assign(b, {
          select: () => b,
          update: (p: unknown) => { ctx.op = 'update'; ctx.payload = p; return b },
          insert: (p: unknown) => { ctx.op = 'insert'; ctx.payload = p; return b },
          eq: (k: string, v: unknown) => { ctx.filtri[k] = v; return b },
          // Registrato e non valutato: la condizione «scheda vuota» dell'adulto si verifica
          // guardando il filtro che arriva, non simulandolo.
          is: (k: string, v: unknown) => { ctx.filtri['is:' + k] = v; return b },
          in: () => b,
          maybeSingle: () => Promise.resolve(esegui()),
          then: (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(esegui()).then(ok, ko),
        })
        return b
      },
    } as unknown as SupabaseClient
  }
}

// ─── ESITI FINTI DELL'EMISSIONE ──────────────────────────────────────────────────────

const esitoOk = {
  ok: true as const,
  fatturaStato: 'in_attesa' as const,
  uploadFileName: 'IT_finto.xml.p7m',
  numero: 2332,
  alunnoId: null,
  cascataVuota: false,
  categoriaSlug: 'retta',
}
const ko = (motivo: string, httpStatus: number, messaggio = 'rifiuto finto') => ({ ok: false as const, motivo, httpStatus, messaggio })

/** Il messaggio vero del `429` prima del numero, per la parte che conta. */
const MSG_429_PRIMA = `Aruba ha risposto ${FRASE_429_PRIMA_DEL_NUMERO} (limite di 12 ricerche e 1 accesso al minuto). La fattura non è stata emessa.`
/** Il messaggio di trasporto dopo un `429` sull'upload, come lo compone `messaggioTrasporto`. */
const MSG_429_UPLOAD = 'Aruba non ha concluso l’invio della fattura Asilo 1/2026 (HTTP 429) e non sappiamo se il documento sia partito.'

/** Un giro fino in fondo, facendo scorrere i timer finti finché la promessa non si chiude. */
async function completa<T>(p: Promise<T>): Promise<T> {
  let fatto = false
  p.then(
    () => { fatto = true },
    () => { fatto = true },
  )
  for (let i = 0; !fatto && i < 10_000; i++) await vi.advanceTimersByTimeAsync(500)
  return p
}

/** Un minuto del cron (`7,12,…`) alle 10 di Roma: fuori dalla finestra della sync. */
const ORA_BUONA = new Date('2026-09-23T08:07:00Z')

let coda: CodaFinta

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(ORA_BUONA)
  h.eventi.length = 0
  coda = new CodaFinta()
  h.conta.mockResolvedValue(0)
  h.emetti.mockImplementation(async () => esitoOk)
})

afterEach(() => {
  vi.useRealTimers()
})

const giro = (adesso = new Date(Date.now())) => completa(eseguiGiroCoda(coda.client(), adesso))
const nomi = () => coda.chiamate.map((c) => c.nome)

describe('la finestra della sync', () => {
  // Dal 24/09 la finestra comincia ai minuti 59 e 29: un giro partito lì farebbe il suo
  // `signin` meno di un minuto prima di quello della sync (ai minuti 0 e 30).
  it.each([0, 2, 5, 29, 30, 32, 35, 59])('al minuto %i di Roma è DENTRO: il giro non tocca niente', async (minuto) => {
    coda.accoda(3)
    const r = await giro(new Date(`2026-09-23T08:${String(minuto).padStart(2, '0')}:30Z`))

    expect(r.esito).toBe('finestra-sync')
    // Né il bidello né il conteggio: la finestra si guarda PRIMA di tutto.
    expect(coda.chiamate).toEqual([])
    expect(h.conta).not.toHaveBeenCalled()
    expect(h.emetti).not.toHaveBeenCalled()
  })

  it.each([6, 7, 28, 36, 57, 58])('al minuto %i è FUORI', (minuto) => {
    expect(inFinestraSync(new Date(`2026-09-23T08:${String(minuto).padStart(2, '0')}:00Z`))).toBe(false)
  })

  it('si guarda il minuto di ROMA anche d’inverno (UTC+1)', () => {
    // 10:31 UTC di gennaio = 11:31 a Roma: dentro la finestra :30–:35.
    expect(inFinestraSync(new Date('2026-01-15T10:31:00Z'))).toBe(true)
    expect(inFinestraSync(new Date('2026-01-15T10:37:00Z'))).toBe(false)
  })
})

describe('i posti del tetto orario', () => {
  it('a secchio pieno il giro non prende niente', async () => {
    coda.accoda(3)
    h.conta.mockResolvedValue(SOGLIA_ORARIA_APP)

    const r = await giro()

    expect(r.esito).toBe('quota-oraria')
    expect(nomi()).not.toContain('fatture_coda_prendi')
    expect(h.emetti).not.toHaveBeenCalled()
    expect(coda.voci.every((v) => v.stato === 'in_coda')).toBe(true)
  })

  it('FAIL-CLOSED: se il conteggio non si è potuto fare, i posti sono ZERO', async () => {
    // L'opposto del lotto, che parte lo stesso: lì c'è una persona davanti allo schermo,
    // qui un cron ogni cinque minuti.
    coda.accoda(3)
    h.conta.mockResolvedValue(null)

    const r = await giro()

    expect(r.esito).toBe('quota-oraria')
    expect(nomi()).not.toContain('fatture_coda_prendi')
    expect(h.emetti).not.toHaveBeenCalled()
    const avviso = h.eventi.find((e) => e.campi.esito === 'tetto-non-misurato')
    expect(avviso?.livello).toBe('warn')
    expect(avviso?.campi.operazione).toBe(OPERAZIONE_GIRO)
  })

  it('si prendono al massimo i posti rimasti, e mai più di un blocco', async () => {
    coda.accoda(20)
    h.conta.mockResolvedValue(SOGLIA_ORARIA_APP - 4)
    await giro()
    expect(coda.chiamate.find((c) => c.nome === 'fatture_coda_prendi')?.args.p_max).toBe(4)
    expect(h.emetti).toHaveBeenCalledTimes(4)

    coda.chiamate.length = 0
    h.conta.mockResolvedValue(0)
    vi.setSystemTime(new Date('2026-09-23T08:12:00Z'))
    await giro()
    expect(coda.chiamate.find((c) => c.nome === 'fatture_coda_prendi')?.args.p_max).toBe(TETTO_BLOCCO)
  })

  it('il conteggio riceve l’istante del giro', async () => {
    await giro(ORA_BUONA)
    expect(h.conta.mock.calls[0][1]).toEqual(ORA_BUONA)
  })
})

describe('il lavoratore: un token, un prestito, un rilascio', () => {
  it('coda vuota ⇒ «niente da fare», e il lavoratore preso viene restituito col suo token', async () => {
    const r = await giro()

    expect(r.esito).toBe('niente-da-fare')
    const prendi = coda.chiamate.find((c) => c.nome === 'fatture_coda_prendi')!
    const rilascia = coda.chiamate.find((c) => c.nome === 'fatture_coda_rilascia')!
    expect(String(prendi.args.p_token)).toMatch(UUID_RE)
    expect(prendi.args.p_prestito_s).toBe(PRESTITO_S)
    expect(rilascia.args).toEqual({ p_token: prendi.args.p_token, p_pausa_minuti: 0, p_motivo: null })
    expect(coda.lavoratore, 'il lavoratore resterebbe preso fino alla scadenza del prestito').toBeNull()
  })

  it('il bidello passa a ogni giro, prima di prendere', async () => {
    coda.accoda(1)
    await giro()
    expect(nomi().indexOf('fatture_coda_bidello')).toBeGreaterThanOrEqual(0)
    expect(nomi().indexOf('fatture_coda_bidello')).toBeLessThan(nomi().indexOf('fatture_coda_prendi'))
  })

  it('ogni chiusura usa il token con cui il blocco è stato preso', async () => {
    coda.accoda(3)
    await giro()
    const token = coda.chiamate.find((c) => c.nome === 'fatture_coda_prendi')!.args.p_token
    const chiusure = coda.chiamate.filter((c) => c.nome === 'fatture_coda_chiudi')
    expect(chiusure).toHaveLength(3)
    expect(chiusure.every((c) => c.args.p_token === token)).toBe(true)
  })

  it('con un altro lavoratore in volo il giro non emette niente', async () => {
    coda.accoda(3)
    coda.lavoratore = { token: uuid(9999), scade: Date.now() + 60_000 }

    const r = await giro()

    expect(r.esito).toBe('niente-da-fare')
    expect(h.emetti).not.toHaveBeenCalled()
    expect(coda.lavoratore?.token, 'il rilascio col token sbagliato non libera il lavoratore altrui').toBe(uuid(9999))
  })
})

describe('la mappatura degli esiti (§2 punto 7)', () => {
  type Caso = [string, unknown, VoceFinta['stato'], string, number]
  const casi: Caso[] = [
    ['ok', esitoOk, 'emessa', 'emessa', 0],
    ['già a registro', { ...esitoOk, gia: true }, 'emessa', 'gia_emessa', 0],
    ['rifiuto locale 400', ko('non_saldato', 400), 'errore', 'non_saldato', 0],
    ['rifiuto locale 404', ko('errore', 404, 'Pagamento non trovato'), 'errore', 'pagamento_non_trovato', 0],
    ['rifiuto locale 409 (quota estranea)', ko('quota_estranea', 409), 'errore', 'quota_estranea', 0],
    ['rifiuto locale 409 (partita non registrata)', ko('partita_non_registrata', 409), 'errore', 'partita_non_registrata', 0],
    ['rifiuto locale 409 (trasporto già a registro)', ko('errore', 409), 'errore', 'trasporto_da_verificare', 0],
    ['rifiuto locale 422', ko('intestatario_non_del_bambino', 422), 'errore', 'intestatario_non_del_bambino', 0],
    ['scarto di merito di Aruba', ko('scartata', 502, 'Emissione scartata (00404)'), 'errore', 'scarto_aruba', 0],
    ['trasporto ignoto (502)', ko('errore', 502, 'Aruba non ha concluso l’invio (HTTP 500)'), 'errore', 'esito_incerto', PAUSA_INCERTO_MINUTI],
    ['5xx prima del numero (503)', ko('non_configurato', 503), 'errore', 'esito_incerto', PAUSA_INCERTO_MINUTI],
    ['XML non composto (500)', ko('errore', 500), 'errore', 'esito_incerto', PAUSA_INCERTO_MINUTI],
    ['numerazione illeggibile, non un 429', ko('numerazione_non_allineata', 503, 'Aruba non ha risposto entro 30 secondi.'), 'errore', 'esito_incerto', PAUSA_INCERTO_MINUTI],
    ['429 sull’upload', ko('errore', 502, MSG_429_UPLOAD), 'errore', 'esito_incerto', PAUSA_429_MINUTI],
    ['429 PRIMA del numero', ko('numerazione_non_allineata', 503, MSG_429_PRIMA), 'in_coda', 'aruba_429', PAUSA_429_MINUTI],
  ]

  it.each(casi)('%s', async (_nome, esito, stato, codice, pausa) => {
    coda.accoda(1)
    h.emetti.mockResolvedValue(esito)

    const r = await giro()

    const v = coda.voce(1)
    expect(v.stato).toBe(stato)
    expect(v.esito_codice).toBe(codice)
    expect(r.pausaMinuti).toBe(pausa)
    if (pausa > 0) {
      expect(coda.pausaFinoA! - Date.now()).toBeGreaterThan((pausa - 1) * 60_000)
      expect(coda.pausaFinoA! - Date.now()).toBeLessThanOrEqual(pausa * 60_000)
      expect(coda.pausaMotivo).toBe(pausa === PAUSA_429_MINUTI ? 'aruba-429' : 'esito-incerto')
    } else {
      expect(coda.pausaFinoA).toBeNull()
    }
    // Il giro non tiene nessuna voce in volo quando finisce.
    expect(coda.voci.some((x) => x.stato === 'in_invio')).toBe(false)
    expect(CODICI_ESITO_CODA as readonly string[], 'ogni codice scritto deve avere la sua traduzione').toContain(codice)
  })

  it('un rifiuto locale porta il suo messaggio fino alla voce; un esito positivo nessuno', async () => {
    coda.accoda(2)
    h.emetti.mockImplementation(async (_sb: unknown, id: string) =>
      id === uuid(1) ? ko('quota_estranea', 409, 'riga viva estranea') : esitoOk,
    )
    await giro()
    expect(coda.voce(1).esito_messaggio).toBe('riga viva estranea')
    expect(coda.voce(2).esito_messaggio).toBeNull()
  })

  it('il messaggio salvato non supera i 500 caratteri', () => {
    const c = classificaEsito(ko('quota_estranea', 409, 'x'.repeat(2_000)) as never)
    expect(c.messaggio!.length).toBeLessThanOrEqual(500)
  })

  it('un rifiuto LOCALE non ferma il blocco: le voci dopo si emettono', async () => {
    coda.accoda(4)
    h.emetti.mockImplementation(async (_sb: unknown, id: string) =>
      id === uuid(2) ? ko('quota_estranea', 409) : esitoOk,
    )
    const r = await giro()
    expect(h.emetti).toHaveBeenCalledTimes(4)
    expect(r).toMatchObject({ esito: 'eseguito', emesse: 3, errori: 1, riprova: 0, pausaMinuti: 0 })
  })

  it('le voci NON toccate perché il giro si è fermato tornano in coda, e non come errori', async () => {
    coda.accoda(4)
    h.emetti.mockImplementation(async (_sb: unknown, id: string) =>
      id === uuid(2) ? ko('errore', 502, 'Aruba non ha concluso l’invio (HTTP 503)') : esitoOk,
    )

    const r = await giro()

    expect(h.emetti, 'dopo un esito incerto non si insiste sul canale').toHaveBeenCalledTimes(2)
    expect(coda.voce(1)).toMatchObject({ stato: 'emessa', esito_codice: 'emessa' })
    expect(coda.voce(2)).toMatchObject({ stato: 'errore', esito_codice: 'esito_incerto' })
    expect(coda.voce(3)).toMatchObject({ stato: 'in_coda', esito_codice: 'non_tentata' })
    expect(coda.voce(4)).toMatchObject({ stato: 'in_coda', esito_codice: 'non_tentata' })
    expect(r).toMatchObject({ esito: 'eseguito', emesse: 1, errori: 1, riprova: 2, pausaMinuti: PAUSA_INCERTO_MINUTI })
  })

  it('un 429 prima del numero rimette in coda la voce E quelle dopo, e ferma la coda per un’ora', async () => {
    coda.accoda(3)
    h.emetti.mockImplementation(async (_sb: unknown, id: string) =>
      id === uuid(2) ? ko('numerazione_non_allineata', 503, MSG_429_PRIMA) : esitoOk,
    )

    await giro()
    expect(coda.voci.map((v) => v.stato)).toEqual(['emessa', 'in_coda', 'in_coda'])

    // Il giro dopo, cinque minuti più tardi, trova la coda in pausa: nessuna chiamata ad Aruba.
    h.emetti.mockClear()
    vi.setSystemTime(new Date('2026-09-23T08:12:00Z'))
    const r = await giro()
    expect(r.esito).toBe('niente-da-fare')
    expect(h.emetti).not.toHaveBeenCalled()
  })

  it('un’eccezione a metà blocco: la voce in volo è INCERTA, le altre tornano in coda', async () => {
    coda.accoda(3)
    h.emetti.mockImplementation(async (_sb: unknown, id: string) => {
      if (id === uuid(2)) throw new Error('rete caduta')
      return esitoOk
    })

    const r = await giro()

    expect(coda.voci.map((v) => [v.stato, v.esito_codice])).toEqual([
      ['emessa', 'emessa'],
      ['errore', 'esito_incerto'],
      ['in_coda', 'non_tentata'],
    ])
    expect(r).toMatchObject({ esito: 'eseguito', pausaMinuti: PAUSA_INCERTO_MINUTI })
    expect(coda.lavoratore).toBeNull()
  })

  it('un intestatario illeggibile non parte mai: deciderebbe la cascata, in silenzio', async () => {
    coda.accoda(1, { intestatario_scelto: { tipo: 'adult' } }) // senza `adult_id`
    coda.accoda(1, {}, 2)

    await giro()

    expect(h.emetti).toHaveBeenCalledTimes(1)
    expect(h.emetti.mock.calls[0][1]).toBe(uuid(2))
    expect(coda.voce(1)).toMatchObject({ stato: 'errore', esito_codice: 'intestatario_non_valido' })
  })
})

describe('ciò che la voce porta arriva fino all’emissione', () => {
  it('attore = chi ha accodato, intestatario e causale scritta a mano; UNA sessione, ritentativo spento', async () => {
    const altroStaff = uuid(7001)
    coda.accoda(1, {
      creato_da: altroStaff,
      intestatario_scelto: { tipo: 'adult', adult_id: uuid(900) },
      causale_manuale: 'Retta di settembre',
    })
    coda.accoda(1, {}, 2)

    await giro()

    const [prima, seconda] = h.emetti.mock.calls
    expect(prima[2]).toEqual({ id: altroStaff })
    expect(seconda[2]).toEqual({ id: STAFF })
    expect(prima[3].intestatarioScelto).toEqual({ tipo: 'adult', adult_id: uuid(900) })
    expect(seconda[3].intestatarioScelto).toBeUndefined()
    expect(prima[3].sessione).toBe(seconda[3].sessione)
    expect(prima[3].ritentaUpload).toBe(false)

    // La causale scritta a mano si scrive; senza, si TOGLIE la correzione salvata (come
    // facevano il lotto e il pulsante singolo): `fattura_causale` è appiccicoso.
    const causali = coda.scritture.filter((s) => s.tabella === 'pagamenti')
    expect(causali).toEqual([
      { tabella: 'pagamenti', op: 'update', payload: { fattura_causale: 'Retta di settembre' }, filtri: { id: uuid(1) } },
      { tabella: 'pagamenti', op: 'update', payload: { fattura_causale: null }, filtri: { id: uuid(2) } },
    ])
  })

  it('la proposta del bonifico CONFERMATA si ricorda sulla scheda; la scelta a mano no', async () => {
    const adulto = { tipo: 'adult', adult_id: uuid(900) }
    coda.accoda(1, { intestatario_scelto: adulto, conferma_proposta: true })
    coda.accoda(1, { intestatario_scelto: adulto, conferma_proposta: false }, 2)
    h.emetti.mockImplementation(async (_sb: unknown, id: string) => ({
      ...esitoOk,
      alunnoId: id === uuid(1) ? uuid(3001) : uuid(3002),
      cascataVuota: true,
    }))

    await giro()

    const schede = coda.scritture.filter((s) => s.tabella === 'alunni')
    expect(schede).toEqual([
      // La condizione «scheda vuota» viaggia DENTRO la UPDATE: l'adulto non sovrascrive mai.
      {
        tabella: 'alunni',
        op: 'update',
        payload: { intestatario_fatture: adulto },
        filtri: { id: uuid(3001), 'is:intestatario_fatture': null },
      },
    ])
    // E la scrittura lascia la sua riga nel registro immodificabile, a nome di chi ha accodato.
    const audit = coda.scritture.filter((s) => s.tabella === 'audit_scritture_docente')
    expect(audit).toHaveLength(1)
    expect((audit[0].payload as { attore_id: string }).attore_id).toBe(STAFF)
  })
})

/**
 * La persona scritta a mano, col cast di `FatturaButton-intestatario.test.tsx` (`COMPLETI`, con
 * `CF_DIGITATO`), ricopiato: non se ne inventa un'altra.
 */
const PERSONA = {
  tipo: 'persona' as const,
  codice_fiscale: 'PRLCRL85M41H501Y',
  nome: 'Carlo',
  cognome: 'Perlini',
  indirizzo: 'Via delle Prove 1',
  cap: '80014',
  comune: 'Giugliano in Campania',
}

describe('l’intestatario scritto a mano («Altro», consegna 2b, D1)', () => {
  const esitoConAlunno = { ...esitoOk, alunnoId: uuid(3001) }
  const schede = () => coda.scritture.filter((s) => s.tabella === 'alunni')
  const audit = () => coda.scritture.filter((s) => s.tabella === 'audit_scritture_docente')
  const evento = (esito: string) => h.eventi.filter((e) => e.campi.esito === esito)

  // Chi accoda, in questo blocco, è la Direzione di DUE plessi: la sua sede primaria (`SEDE`,
  // in `utenti`) e quella del bambino (`SEDE_ALUNNO`, dal ponte). Così la scheda si può
  // scrivere, e resta provato che il registro va sotto la sede del BAMBINO e non sotto la
  // primaria dell'attore. Il caso (i) torna alla segreteria di un plesso solo.
  beforeEach(() => {
    coda.utenti = [{ id: STAFF, role: 'admin', scuola_id: SEDE }]
    coda.utentiScuole = [{ utente_id: STAFF, scuola_id: SEDE_ALUNNO }]
  })

  it('(a) la persona arriva fino all’emissione, intera', async () => {
    coda.accoda(1, { intestatario_scelto: PERSONA })

    await giro()

    expect(h.emetti).toHaveBeenCalledTimes(1)
    expect(h.emetti.mock.calls[0][3].intestatarioScelto).toEqual(PERSONA)
    expect(coda.voce(1).stato).toBe('emessa')
  })

  it('(b) con «ricorda» e un’emissione NUOVA: la scheda si SOSTITUISCE, e il registro ha il valore di prima sotto la sede del bambino', async () => {
    coda.scheda = {
      intestatario_fatture: { tipo: 'adult', adult_id: uuid(3100) },
      scuola_id: SEDE_ALUNNO,
      section_id: uuid(3200),
    }
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: true })
    h.emetti.mockResolvedValue(esitoConAlunno)

    await giro()

    expect(schede()).toEqual([
      {
        tabella: 'alunni',
        op: 'update',
        payload: { intestatario_fatture: { tipo: 'altro', dati: datiAltroDaPersonaScelta(PERSONA) } },
        // ⚠️ NESSUN `is:intestatario_fatture`: chi ha spuntato «ricorda» ha chiesto di sostituire.
        filtri: { id: uuid(3001) },
      },
    ])
    const righe = audit()
    expect(righe).toHaveLength(1)
    const riga = righe[0].payload as {
      attore_id: string
      entita_id: string
      scuola_id: string
      section_id: string | null
      valore_prima: unknown
      valore_dopo: { intestatario_fatture: { dati: Record<string, unknown> } }
    }
    expect(riga.attore_id).toBe(STAFF)
    expect(riga.entita_id).toBe(uuid(3001))
    // Non `SEDE`: con la sede dell'attore la riga uscirebbe dalla vista del plesso del bambino.
    expect(riga.scuola_id).toBe(SEDE_ALUNNO)
    expect(riga.section_id).toBe(uuid(3200))
    // Il valore SOSTITUITO: senza, il registro perderebbe chi era l'intestatario della detrazione.
    expect(riga.valore_prima).toEqual({ intestatario_fatture: { tipo: 'adult', adult_id: uuid(3100) } })
    const dati = riga.valore_dopo.intestatario_fatture.dati
    expect(dati.nome).toBe(VALORE_NON_REGISTRATO)
    expect(dati.cognome).toBe(VALORE_NON_REGISTRATO)
    expect(dati.cf).toBe(VALORE_NON_REGISTRATO)
    const salvato = evento('intestatario-persona-salvato')
    expect(salvato).toHaveLength(1)
    expect(salvato[0].livello).toBe('info')
    expect(salvato[0].campi).toMatchObject({ operazione: OPERAZIONE_GIRO, pagamento_id: uuid(1), alunno_id: uuid(3001) })
    expect(salvato[0].opzioni).toEqual({ distingui: ['alunno_id'] })
  })

  it('(c) senza «ricorda» la scheda non si tocca, anche quando l’attore è noto per un’altra voce dello stesso giro', async () => {
    // ⚠️ DUE voci dello STESSO operatore nello stesso giro, e non una sola: con la voce senza
    // «ricorda» da sola `leggiAttori` non legge l'attore, e la scrittura salterebbe per il ramo
    // «attore ignoto», non per la casella. Qui l'attore è noto (lo porta la voce 1), quindi
    // l'unica cosa che tiene ferma la scheda del bambino della voce 2 è `ricordaSullaScheda`.
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: true })
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: false }, 2)
    h.emetti.mockImplementation(async (_sb: unknown, pagamentoId: string) => ({
      ...esitoOk,
      alunnoId: pagamentoId === uuid(1) ? uuid(3001) : uuid(3002),
    }))

    await giro()

    expect(coda.voce(1).stato).toBe('emessa')
    expect(coda.voce(2).stato).toBe('emessa')
    // Presenza: la voce con la casella scrive la SUA scheda (l'attore c'è davvero).
    expect(schede().map((s) => s.filtri.id)).toEqual([uuid(3001)])
    // Assenza: nessuna scrittura, né riga di registro, col bambino della voce senza casella.
    expect(audit().map((s) => (s.payload as { entita_id: string }).entita_id)).toEqual([uuid(3001)])
    expect(evento('intestatario-persona-non-ricordato-attore-ignoto')).toEqual([])
  })

  it('(d) una riga GIÀ a registro non dice niente su oggi: nessuna scrittura', async () => {
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: true })
    h.emetti.mockResolvedValue({ ...esitoConAlunno, gia: true })

    await giro()

    expect(coda.voce(1).stato).toBe('emessa')
    expect(schede()).toEqual([])
    expect(audit()).toEqual([])
  })

  it('(e) un’emissione rifiutata non lascia dietro una modifica permanente', async () => {
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: true })
    h.emetti.mockResolvedValue(ko('intestatario_non_del_bambino', 422))

    await giro()

    expect(coda.voce(1).stato).toBe('errore')
    expect(schede()).toEqual([])
  })

  it('(f) chi ha accodato non si legge: niente scrittura senza la sua riga di audit, e lo si dice', async () => {
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: true, creato_da: uuid(7002) })
    h.emetti.mockResolvedValue(esitoConAlunno)

    await giro()

    expect(coda.voce(1).stato).toBe('emessa')
    expect(schede()).toEqual([])
    expect(audit()).toEqual([])
    const avviso = evento('intestatario-persona-non-ricordato-attore-ignoto')
    expect(avviso).toHaveLength(1)
    expect(avviso[0].livello).toBe('warn')
  })

  it('(b′) l’attore si legge anche per la persona con «ricorda»', async () => {
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: true })
    h.emetti.mockResolvedValue(esitoConAlunno)

    await giro()

    expect(evento('intestatario-persona-non-ricordato-attore-ignoto')).toEqual([])
    expect(audit()).toHaveLength(1)
  })

  const ERRORE_FINTO = { code: '42501', message: 'permesso negato' }
  it.each([
    ['la lettura della scheda in errore', { lettura: { data: null, error: ERRORE_FINTO } }, ERRORE_FINTO],
    ['la UPDATE in errore', { scrittura: { data: null, error: ERRORE_FINTO } }, ERRORE_FINTO],
    ['la UPDATE a zero righe', { scrittura: { data: [], error: null } }, undefined],
  ])('(h) %s: nessuna riga di audit, un `warn` con l’errore, e la voce resta emessa', async (_nome, guasto, errore) => {
    coda.guastoScheda = guasto
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: true })
    h.emetti.mockResolvedValue(esitoConAlunno)

    await giro()

    expect(coda.voce(1).stato).toBe('emessa')
    expect(audit()).toEqual([])
    expect(evento('intestatario-persona-salvato')).toEqual([])
    const avviso = evento('intestatario-persona-non-salvato')
    expect(avviso).toHaveLength(1)
    expect(avviso[0].livello).toBe('warn')
    expect(avviso[0].campi).toMatchObject({ operazione: OPERAZIONE_GIRO, pagamento_id: uuid(1), alunno_id: uuid(3001) })
    expect(avviso[0].errore).toEqual(errore)
    expect(avviso[0].opzioni).toEqual({ distingui: ['alunno_id'] })
    // Fallita la lettura, non si scrive: il registro non avrebbe il valore sostituito.
    if ('lettura' in guasto) expect(schede()).toEqual([])
  })

  it('(g) nessun evento registrato porta nome, cognome o codice fiscale della persona', async () => {
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: true })
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: true, creato_da: uuid(7002) }, 2)
    coda.accoda(1, { intestatario_scelto: { ...PERSONA, nome: '' } }, 3) // illeggibile: il ramo d'errore
    h.emetti.mockResolvedValue(esitoConAlunno)

    await giro()
    coda.guastoScheda = { scrittura: { data: null, error: ERRORE_FINTO } }
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: true }, 4)
    vi.setSystemTime(new Date('2026-09-23T08:12:00Z'))
    await giro()

    // Sono passati tutti i rami: il salvato, l'attore ignoto, l'illeggibile e il non salvato.
    for (const e of ['intestatario-persona-salvato', 'intestatario-persona-non-ricordato-attore-ignoto', 'intestatario-persona-non-salvato']) {
      expect(evento(e), e).toHaveLength(1)
    }
    const testo = JSON.stringify(h.eventi)
    for (const dato of [PERSONA.nome, PERSONA.cognome, PERSONA.codice_fiscale]) expect(testo).not.toContain(dato)
  })

  /*
   * ⚠️ IL PERIMETRO DI SEDE DEL BAMBINO (giro 1, correzione). La PATCH del browser che questo
   * ramo sostituisce passava da `assertAlunnoInScope` (403 «alunno fuori dal tuo plesso»). Il
   * giro controlla la sede del PAGAMENTO, e dopo un trasferimento i pagamenti vecchi restano
   * nella sede di partenza: senza il confronto, la segreteria di `SEDE` riscriverebbe
   * l'intestatario della detrazione di un bambino che ora sta in `SEDE_ALUNNO`.
   */
  it('(i) segreteria di un plesso, bambino in un ALTRO: fattura emessa, scheda intatta, niente registro, un `warn`', async () => {
    coda.utenti = [{ id: STAFF, role: 'segreteria', scuola_id: SEDE }]
    coda.utentiScuole = [{ utente_id: STAFF, scuola_id: SEDE_ALUNNO }] // ignorato: non è Direzione
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: true })
    h.emetti.mockResolvedValue(esitoConAlunno)

    await giro()

    expect(coda.voce(1).stato).toBe('emessa')
    expect(schede()).toEqual([])
    expect(audit()).toEqual([])
    expect(evento('intestatario-persona-salvato')).toEqual([])
    const avviso = evento('intestatario-persona-fuori-sede')
    expect(avviso).toHaveLength(1)
    expect(avviso[0].livello).toBe('warn')
    expect(avviso[0].campi).toMatchObject({ operazione: OPERAZIONE_GIRO, pagamento_id: uuid(1), alunno_id: uuid(3001) })
    expect(avviso[0].opzioni).toEqual({ distingui: ['alunno_id'] })
  })

  it('(i′) le sedi della Direzione non si leggono: fail-closed, nessuna scrittura sulla scheda', async () => {
    coda.guastoSedi = { data: null, error: { code: '57014', message: 'timeout finto' } }
    coda.accoda(1, { intestatario_scelto: PERSONA, conferma_proposta: true })
    h.emetti.mockResolvedValue(esitoConAlunno)

    await giro()

    expect(coda.voce(1).stato).toBe('emessa')
    expect(schede()).toEqual([])
    expect(audit()).toEqual([])
    expect(evento('intestatario-persona-fuori-sede')).toHaveLength(1)
  })
})

describe('la coda si svuota da sola, un giro del cron dopo l’altro', () => {
  /** I minuti del cron `fatture-coda-tick`: niente 2 e 32 (sync). */
  const MINUTI_CRON = [7, 12, 17, 22, 27, 37, 42, 47, 52, 57]
  function* tickDelCron(da: Date): Generator<Date> {
    const t = new Date(da)
    for (;;) {
      t.setUTCSeconds(0, 0)
      t.setUTCMinutes(t.getUTCMinutes() + 1)
      if (MINUTI_CRON.includes(t.getUTCMinutes())) yield new Date(t)
    }
  }

  /** Il registro delle emissioni, per il conteggio del tetto orario (SU TUTTE le sedi). */
  function collegaIlTetto(): number[] {
    const emissioni: number[] = []
    h.emetti.mockImplementation(async () => {
      emissioni.push(Date.now())
      return esitoOk
    })
    h.conta.mockImplementation(async (_sb: unknown, adesso: Date) =>
      emissioni.filter((t) => t > adesso.getTime() - 3_600_000).length,
    )
    return emissioni
  }

  async function giraFinoAVuota(maxGiri = 100): Promise<{ esiti: string[]; prese: number[] }> {
    const esiti: string[] = []
    const prese: number[] = []
    const tick = tickDelCron(new Date(Date.now() - 60_000))
    for (let i = 0; i < maxGiri && coda.voci.some((v) => v.stato === 'in_coda'); i++) {
      const quando = tick.next().value as Date
      if (quando.getTime() > Date.now()) vi.setSystemTime(quando)
      const prima = h.emetti.mock.calls.length
      const r = await giro(quando)
      esiti.push(r.esito)
      if (r.esito === 'eseguito') prese.push(h.emetti.mock.calls.length - prima)
    }
    return { esiti, prese }
  }

  it('quaranta voci, nessun browser: tre giri, ognuna emessa UNA volta', async () => {
    collegaIlTetto()
    coda.accoda(40)

    const { prese } = await giraFinoAVuota()

    expect(prese).toEqual([15, 15, 10])
    expect(coda.voci.every((v) => v.stato === 'emessa')).toBe(true)
    const emessi = h.emetti.mock.calls.map((c) => c[1])
    expect(new Set(emessi).size, 'nessun pagamento emesso due volte').toBe(40)
    expect(emessi).toEqual(coda.voci.map((v) => v.pagamento_id))
  })

  it('sessanta voci: il tetto orario ferma la coda a 50, e la riprende quando l’ora è passata', async () => {
    const emissioni = collegaIlTetto()
    coda.accoda(60)

    const { esiti } = await giraFinoAVuota()

    expect(coda.voci.every((v) => v.stato === 'emessa')).toBe(true)
    expect(esiti).toContain('quota-oraria')
    // In NESSUNA finestra di un'ora si supera la soglia che l'app si dà.
    for (const t of emissioni) {
      const nellOra = emissioni.filter((x) => x >= t && x < t + 3_600_000).length
      expect(nellOra).toBeLessThanOrEqual(SOGLIA_ORARIA_APP)
    }
  })
})

/*
 * ─── LA DISTANZA FRA DUE ACCESSI AD ARUBA (correzione del 24/09/2026) ────────────────
 * Il 24/09 alle 10:09:59 un giro svegliato da un accodamento ha fatto il `signin` una
 * quarantina di secondi dopo quello del giro precedente: Aruba ne concede uno al minuto per
 * IP, ha risposto `429`, e la pausa del `429` ha fermato la coda per un'ora. `prendi` ora
 * rifiuta prima di 65 s dall'ultimo accesso (il modello lo riproduce); il giro, se l'unico
 * ostacolo è la distanza, ASPETTA il residuo invece di lasciare l'urgente al cron.
 */
describe('la distanza fra due accessi ad Aruba (24/09)', () => {
  const eventi = (esito: string) => h.eventi.filter((e) => e.campi.esito === esito)

  it('G1 · il 24/09 in piccolo: la sveglia arriva 42 s dopo la fine del giro precedente, il giro ASPETTA, poi emette', async () => {
    coda.accoda(1, { urgente: true })
    await giro()
    const fine = coda.ultimoAccesso!
    expect(fine, 'il rilascia del modello timbra la fine del giro').not.toBeNull()

    coda.accoda(1, { urgente: true }, 2)
    vi.setSystemTime(fine + 42_000)
    h.eventi.length = 0
    const r = await giro()

    expect(r).toMatchObject({ esito: 'eseguito', emesse: 1 })
    expect(coda.voce(2).stato).toBe('emessa')
    const prese = coda.chiamate.filter((c) => c.nome === 'fatture_coda_prendi')
    expect(prese.at(-1)!.t - fine).toBeGreaterThanOrEqual(DISTANZA_ACCESSI_S * 1000)
    const attese = eventi('attesa-accesso')
    expect(attese).toHaveLength(1)
    expect(attese[0].livello).toBe('info')
    expect(attese[0].campi.operazione).toBe(OPERAZIONE_GIRO)
    expect(attese[0].campi.ms).toBeGreaterThanOrEqual(23_000)
    expect(attese[0].campi.ms).toBeLessThanOrEqual(24_000)
    // Il tetto orario si conta sull'istante di DOPO l'attesa.
    const istante = h.conta.mock.calls.at(-1)![1] as Date
    expect(istante.getTime() - fine).toBeGreaterThanOrEqual(DISTANZA_ACCESSI_S * 1000)
  })

  it.each([
    ['un altro lavoratore attivo', (c: CodaFinta) => { c.lavoratore = { token: uuid(9999), scade: Date.now() + 60_000 } }],
    ['la pausa di un 429', (c: CodaFinta) => { c.pausaFinoA = Date.now() + 30 * 60_000 }],
    ['la coda sospesa', (c: CodaFinta) => { c.sospesa = true }],
  ])('G2 · con %s il giro NON aspetta: prendi rifiuterebbe comunque', async (_nome, ostacolo) => {
    coda.accoda(1)
    // Senza la regola si aspetterebbero 56 s.
    coda.ultimoAccesso = Date.now() - 10_000
    ostacolo(coda)
    const t0 = Date.now()

    const r = await giro()

    expect(r.esito).toBe('niente-da-fare')
    expect(h.emetti).not.toHaveBeenCalled()
    expect(eventi('attesa-accesso')).toEqual([])
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  it('G3 · un’attesa che finisce dentro la finestra della sync: il giro si ferma lì, prima del bidello', async () => {
    // 10:28:40 a Roma, fuori finestra; l'attesa di 56 s porta alle 10:29:36, dentro.
    vi.setSystemTime(new Date('2026-09-23T08:28:40Z'))
    coda.accoda(1)
    coda.ultimoAccesso = Date.now() - 10_000

    const r = await giro()

    expect(r.esito).toBe('finestra-sync')
    expect(eventi('attesa-accesso')).toHaveLength(1)
    expect(nomi(), 'né bidello né prendi').toEqual([])
    expect(h.emetti).not.toHaveBeenCalled()
    expect(coda.voce(1).stato).toBe('in_coda')
  })

  it('G4 · la sveglia che arriva mentre un giro lavora non perde la voce: la prende il cron dopo, UNA volta', async () => {
    coda.accoda(1)
    h.emetti.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 20_000))
      return esitoOk
    })

    const primo = eseguiGiroCoda(coda.client(), new Date(Date.now()))
    await vi.advanceTimersByTimeAsync(10_000)
    coda.accoda(1, {}, 2)
    const secondo = eseguiGiroCoda(coda.client(), new Date(Date.now()))
    const [r1, r2] = await completa(Promise.all([primo, secondo]))

    expect(r1).toMatchObject({ esito: 'eseguito', emesse: 1 })
    expect(r2.esito).toBe('niente-da-fare')
    expect(coda.voce(2)).toMatchObject({ stato: 'in_coda', tentativi: 0 })

    vi.setSystemTime(new Date('2026-09-23T08:12:00Z'))
    const r3 = await giro()
    expect(r3).toMatchObject({ esito: 'eseguito', emesse: 1 })
    expect(h.emetti.mock.calls.map((c) => c[1])).toEqual([uuid(1), uuid(2)])
  })

  it('G5 · la lettura dell’ultimo accesso fallisce (42703, colonna non ancora migrata): nessuna attesa, un `warn`, decide prendi', async () => {
    coda.accoda(1)
    coda.guastoStato = { data: null, error: { code: '42703', message: 'colonna finta assente' } }

    const r = await giro()

    expect(r).toMatchObject({ esito: 'eseguito', emesse: 1 })
    const avvisi = eventi('accesso-non-letto')
    expect(avvisi).toHaveLength(1)
    expect(avvisi[0].livello).toBe('warn')
    expect(avvisi[0].campi.operazione).toBe(OPERAZIONE_GIRO)
    expect(avvisi[0].errore).toMatchObject({ code: '42703' })
    expect(eventi('attesa-accesso')).toEqual([])
  })

  // Il budget del blocco si conta da PRIMA dell'attesa (`inizioMs: inizio`): l'attesa sta dentro
  // gli stessi 300 s dell'invocazione. Qui ogni fattura dura 10 s: con l'attesa contata il blocco
  // si ferma prima di quanto farebbe partendo dopo l'attesa, e le altre restano in coda.
  it('G9 · l’attesa si paga col budget del blocco: si emettono meno fatture, le altre restano in coda', async () => {
    const DURATA_MS = 10_000
    const quanteNelBudget = (partenzaMs: number) => {
      let t = partenzaMs
      let n = 0
      for (let i = 0; i < TETTO_BLOCCO; i++) {
        if (t + RISERVA_PEGGIORE_MS > BUDGET_BLOCCO_MS) break
        if (i > 0) t += PAUSA_FRA_UPLOAD_MS
        t += DURATA_MS
        n++
      }
      return n
    }
    coda.accoda(TETTO_BLOCCO)
    coda.ultimoAccesso = Date.now() - 10_000
    h.emetti.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, DURATA_MS))
      return esitoOk
    })

    const r = await giro()

    const attesa = eventi('attesa-accesso')[0].campi.ms as number
    expect(attesa).toBeGreaterThan(50_000)
    const conAttesa = quanteNelBudget(attesa)
    // La prova ha senso solo se partire dopo l'attesa darebbe un numero diverso.
    expect(conAttesa).toBeLessThan(quanteNelBudget(0))
    expect(r.emesse).toBe(conAttesa)
    expect(coda.voci.filter((v) => v.stato === 'in_coda')).toHaveLength(TETTO_BLOCCO - conAttesa)
  })

  it('G8 · un ultimo accesso nel FUTURO: si aspetta al massimo ATTESA_MASSIMA_MS', async () => {
    coda.accoda(1)
    coda.ultimoAccesso = Date.now() + 60 * 60_000
    const t0 = Date.now()

    const r = await giro()

    // Il modello rifiuta ancora: decide `prendi`, non l'attesa.
    expect(r.esito).toBe('niente-da-fare')
    expect(Date.now() - t0).toBeLessThanOrEqual(ATTESA_MASSIMA_MS + 1_000)
    const attese = eventi('attesa-accesso')
    expect(attese).toHaveLength(1)
    expect(attese[0].campi.ms).toBe(ATTESA_MASSIMA_MS)
    expect(coda.voce(1).stato).toBe('in_coda')
  })
})

describe('LOCK: la distanza fra gli accessi è UNA, scritta in due lingue', () => {
  const cartella = path.join(process.cwd(), 'supabase/migrations')
  const trovati = readdirSync(cartella).filter((f) => f.endsWith('_fatture_coda_distanza_accessi.sql'))

  it('G6 · in supabase/migrations c’è UN solo file della distanza fra gli accessi', () => {
    expect(trovati).toHaveLength(1)
  })

  it('G6 · l’SQL eseguibile ha UN solo intervallo in secondi, uguale a DISTANZA_ACCESSI_S', () => {
    const sql = senzaCommenti(readFileSync(path.join(cartella, trovati[0]), 'utf8'))
    const intervalli = [...sql.matchAll(/interval\s+'(\d+)\s+seconds?'/gi)].map((m) => Number(m[1]))
    expect(intervalli).toEqual([DISTANZA_ACCESSI_S])
  })

  it('G6 · l’attesa più lunga è la distanza più un secondo, e dopo resta il budget per una fattura', () => {
    expect(ATTESA_MASSIMA_MS).toBe(DISTANZA_ACCESSI_S * 1000 + 1_000)
    expect(ATTESA_MASSIMA_MS + RISERVA_PEGGIORE_MS).toBeLessThan(BUDGET_BLOCCO_MS)
  })
})

describe('LOCK: le frasi dell’emissione su cui il giro riconosce i 429', () => {
  const sorgente = readFileSync(path.join(process.cwd(), 'src/lib/aruba/emissione.ts'), 'utf8')

  it('il ramo `429` della numerazione dice ancora «troppe richieste»', () => {
    // Se la frase cambia, il 429 prima del numero diventerebbe un «esito incerto» — il verso
    // sicuro, ma una voce che andava rimessa in coda da sola finirebbe fra gli errori.
    // ⚠️ Si guarda DENTRO il ramo, fra `case '429':` e il `case` successivo: la frase che
    // compare in un commento qualunque del file non deve bastare.
    const inizio = sorgente.indexOf("case '429':")
    expect(inizio, 'il ramo `case \'429\'` della numerazione non c’è più').toBeGreaterThan(0)
    const fine = sorgente.indexOf('case ', inizio + 5)
    const ramo = sorgente.slice(inizio, fine)
    expect(ramo).toContain(`'Aruba ha risposto ${FRASE_429_PRIMA_DEL_NUMERO}`)
  })

  it('il messaggio di trasporto porta il guasto fra parentesi, dove il giro cerca il `429`', () => {
    const inizio = sorgente.indexOf('function messaggioTrasporto(')
    expect(inizio).toBeGreaterThan(0)
    const corpo = sorgente.slice(inizio, sorgente.indexOf('\n}\n', inizio))
    expect(corpo).toContain('(${quale})')
    // E il 429 sull'upload viene davvero riconosciuto con quella forma.
    expect(classificaEsito(ko('errore', 502, MSG_429_UPLOAD) as never).segnale).toBe('aruba-429')
    expect(classificaEsito(ko('errore', 502, 'Aruba non ha concluso l’invio (rete)') as never).segnale).toBe('incerto')
  })
})
