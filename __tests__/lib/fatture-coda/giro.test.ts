// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * IL LAVORATORE DELLA CODA FATTURE — un giro alla volta, senza nessun browser.
 *
 * ─── COSA È FINTO E COSA NO ──────────────────────────────────────────────────────────
 * Finti: `emettiFatturaPagamento` (la sua correttezza la misurano i test dell'emissione),
 * il conteggio del tetto orario, e il database — ma NON come un mock piatto. Le RPC della
 * coda sono simulate da un piccolo modello con STATO (`CodaFinta`) che rispetta il
 * contratto del §1 della spec: `prendi` rifiuta con coda sospesa, in pausa o con un altro
 * lavoratore, `chiudi` vale solo col token giusto, `rilascia` scrive la pausa. Così un
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
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
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
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
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
} from '@/lib/fatture-coda/giro'
import { TETTO_BLOCCO } from '@/lib/pagamenti/lotto-fatture'
import { SOGLIA_ORARIA_APP } from '@/lib/pagamenti/tetto-orario-aruba'
import type { SupabaseClient } from '@supabase/supabase-js'

// ─── uuid FINTI: il repository è pubblico ────────────────────────────────────────────
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}
const SEDE = uuid(8000)
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
  chiamate: { nome: string; args: Record<string, unknown> }[] = []
  /** Le scritture arrivate con `.from(…)`: tabella, operazione, corpo, filtri. */
  scritture: { tabella: string; op: string; payload: unknown; filtri: Record<string, unknown> }[] = []
  utenti: { id: string; role: string; scuola_id: string | null }[] = [{ id: STAFF, role: 'segreteria', scuola_id: SEDE }]

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
    this.chiamate.push({ nome, args })
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
          if (tabella === 'alunni' && ctx.op === 'update') return { data: [{ id: ctx.filtri.id }], error: null }
          return { data: [], error: null }
        }
        Object.assign(b, {
          select: () => b,
          update: (p: unknown) => { ctx.op = 'update'; ctx.payload = p; return b },
          insert: (p: unknown) => { ctx.op = 'insert'; ctx.payload = p; return b },
          eq: (k: string, v: unknown) => { ctx.filtri[k] = v; return b },
          is: () => b,
          in: () => b,
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
  it.each([0, 2, 5, 30, 32, 35])('al minuto %i di Roma è DENTRO: il giro non tocca niente', async (minuto) => {
    coda.accoda(3)
    const r = await giro(new Date(`2026-09-23T08:${String(minuto).padStart(2, '0')}:30Z`))

    expect(r.esito).toBe('finestra-sync')
    // Né il bidello né il conteggio: la finestra si guarda PRIMA di tutto.
    expect(coda.chiamate).toEqual([])
    expect(h.conta).not.toHaveBeenCalled()
    expect(h.emetti).not.toHaveBeenCalled()
  })

  it.each([6, 7, 29, 36, 57])('al minuto %i è FUORI', (minuto) => {
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
      { tabella: 'alunni', op: 'update', payload: { intestatario_fatture: adulto }, filtri: { id: uuid(3001) } },
    ])
    // E la scrittura lascia la sua riga nel registro immodificabile, a nome di chi ha accodato.
    const audit = coda.scritture.filter((s) => s.tabella === 'audit_scritture_docente')
    expect(audit).toHaveLength(1)
    expect((audit[0].payload as { attore_id: string }).attore_id).toBe(STAFF)
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
