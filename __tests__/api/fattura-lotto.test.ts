import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * IL BLOCCO DI FATTURE — un accesso solo, un budget, e una guardia sul secchio orario.
 *
 * ─── COME SI DIMOSTRA «UN SIGNIN PER BLOCCO», E PERCHÉ NON SI DIMOSTRA QUI ──────────
 * La tentazione sarebbe scrivere qui «quindici fatture ⇒ un `signin`». Sarebbe un test
 * che non collauda niente: per contare i `signin` bisogna NON mockare
 * `@/lib/aruba/emissione`, e allora servono il client Aruba vero, `fetch` finto e una
 * Supabase con stato — cioè un test dell'emissione travestito da test di route. E se
 * invece si mocka `emettiFatturaPagamento`, `arubaSignin` non viene chiamata mai:
 * il contatore starebbe a zero e la prova di mutazione sarebbe invisibile.
 *
 * La proprietà è spezzata in due, e insieme le due metà la dimostrano:
 *
 *  · **che una sessione condivisa produca un solo accesso** lo misura
 *    `__tests__/lib/aruba/signin-prima-della-rpc.test.ts`, col client vero e il conteggio
 *    su `fetch`;
 *  · **che la route ne passi UNA SOLA a tutte le righe** lo misura questo file, sull'
 *    IDENTITÀ dell'oggetto. Se la route creasse una sessione per riga — cioè se tornasse
 *    al comportamento di prima — l'identità cambierebbe e il caso diventerebbe rosso.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  emetti: vi.fn(),
  conta: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ assertPagamentoInScope: h.scope }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      Object.assign(b, { update: () => b, eq: async () => ({ error: null }) })
      return b
    },
  }),
}))
vi.mock('@/lib/pagamenti/tetto-orario-aruba', async (originale) => {
  const actual = await originale<typeof import('@/lib/pagamenti/tetto-orario-aruba')>()
  return { ...actual, contaEmesseUltimaOra: h.conta }
})
vi.mock('@/lib/aruba/emissione', async (originale) => {
  const actual = await originale<typeof import('@/lib/aruba/emissione')>()
  return { ...actual, emettiFatturaPagamento: h.emetti }
})

import { POST } from '@/app/api/pagamenti/fattura/lotto/route'
import {
  TETTO_BLOCCO,
  BUDGET_BLOCCO_MS,
  LAVORO_UTILE_MS,
  MARGINE_PIATTAFORMA_MS,
  MAX_DURATION_BLOCCO_S,
} from '@/lib/pagamenti/lotto-fatture'
import { SOGLIA_ORARIA_APP } from '@/lib/pagamenti/tetto-orario-aruba'

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function richiesta(quante: number, da = 1, conIntestatario = false): Request {
  return new Request('http://localhost/api/pagamenti/fattura/lotto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pagamenti: Array.from({ length: quante }, (_, i) => ({
        pagamento_id: uuid(da + i),
        causale: null,
        ...(conIntestatario ? { intestatario: { tipo: 'adult', adult_id: uuid(900 + i) } } : {}),
      })),
    }),
  })
}

const esitoOk = { ok: true as const, fatturaStato: 'in_attesa' as const, uploadFileName: 'IT_x.p7m', numero: 2332 }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  h.requireStaff.mockResolvedValue({ response: null, user: { id: 'staff-1' } })
  h.scope.mockResolvedValue(null)
  h.conta.mockResolvedValue(0)
  h.emetti.mockImplementation(async () => esitoOk)
})

describe('un accesso ad Aruba per BLOCCO, non per fattura', () => {
  it('tutte le righe ricevono la STESSA sessione, e il ritentativo dell’upload è spento', async () => {
    const res = await POST(richiesta(5))
    expect(res.status).toBe(200)

    const sessioni = h.emetti.mock.calls.map((c) => (c[3] as { sessione?: unknown }).sessione)
    expect(sessioni).toHaveLength(5)
    // ⚠️ L'IDENTITÀ, non l'esistenza: cinque sessioni diverse passerebbero un
    // `toBeTruthy()` e sarebbero cinque accessi ad Aruba, cioè il difetto di prima.
    expect(new Set(sessioni).size, 'una sessione per riga sono cinque accessi al minuto').toBe(1)
    expect(sessioni[0]).toBeTruthy()

    // I novanta secondi del ritentativo vivono dentro `arubaUpload`, dove il ciclo non ha
    // punti di controllo: in un'invocazione a budget farebbero morire il blocco col
    // numero già allocato.
    for (const chiamata of h.emetti.mock.calls) {
      expect((chiamata[3] as { ritentaUpload?: boolean }).ritentaUpload).toBe(false)
    }
  })
})

describe('il gate di sede vale per OGNI riga del blocco', () => {
  it('una riga di un’altra sede in mezzo rifiuta l’intera richiesta', async () => {
    // ⚠️ La riga fuori sede è la TERZA, non la prima: in prima posizione passerebbe
    // anche un'implementazione che controlla solo il primo pagamento e poi si fida.
    h.scope.mockImplementation(async (_sb: unknown, _user: unknown, id: string) =>
      id === uuid(3) ? new Response('fuori sede', { status: 403 }) : null,
    )

    const res = await POST(richiesta(5))

    expect(res.status).toBe(403)
    expect(h.emetti, 'nessuna fattura deve partire da una richiesta malformata').not.toHaveBeenCalled()
  })

  it('lo scope si verifica su tutte le righe, non a campione', async () => {
    await POST(richiesta(4))
    const idVisti = h.scope.mock.calls.map((c) => c[2])
    expect(idVisti).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)])
  })
})

describe('la guardia sul tetto orario di Aruba', () => {
  it('a secchio pieno rifiuta PRIMA di partire, e non rivela i volumi di nessuna sede', async () => {
    h.conta.mockResolvedValue(SOGLIA_ORARIA_APP)

    const res = await POST(richiesta(5))
    const body = (await res.json()) as { codice?: string; error?: string; data?: Record<string, unknown> }

    expect(res.status).toBe(429)
    expect(body.codice).toBe('LOTTO_TETTO_ORARIO_RAGGIUNTO')
    expect(h.emetti).not.toHaveBeenCalled()
    // Il conteggio è su TUTTE le sedi (il secchio è per IP): il messaggio non deve
    // lasciar dedurre quanto fattura un altro plesso.
    expect(JSON.stringify(body.data)).not.toContain('scuola')
  })

  it('se ne restano tre e il blocco ne chiede cinque, ne partono TRE e due tornano fra i restanti', async () => {
    // Si tronca invece di rifiutare tutto: tre fatture emesse sono tre fatture emesse.
    h.conta.mockResolvedValue(SOGLIA_ORARIA_APP - 3)

    const res = await POST(richiesta(5))
    const body = (await res.json()) as { data: { emesse: unknown[]; restanti: string[] } }

    expect(h.emetti).toHaveBeenCalledTimes(3)
    expect(body.data.emesse).toHaveLength(3)
    expect(body.data.restanti).toEqual([uuid(4), uuid(5)])
  })

  it('se il conteggio NON si è potuto fare, il blocco parte lo stesso', async () => {
    // Una cintura che si rompe non deve fermare il lavoro: sul DB E2E la tabella può
    // non esserci affatto, e la protezione vera contro i numeri sbagliati è altrove.
    h.conta.mockResolvedValue(null)
    await POST(richiesta(4))
    expect(h.emetti).toHaveBeenCalledTimes(4)
  })
})

describe('il budget di tempo', () => {
  it('quando il tempo residuo non basta al COSTO PEGGIORE di una fattura, il blocco si ferma e dichiara i restanti', async () => {
    // ⚠️ Timer finti PIENI (`useFakeTimers`), non `toFake: ['Date']`: con `Date`
    // congelato il tempo trascorso resterebbe zero e questa guardia non scatterebbe
    // MAI — il test sarebbe verde sul nulla.
    //
    // La cucitura è l'emissione stessa: ogni chiamata fa avanzare l'orologio finto, così
    // il budget si consuma senza aspettare davvero.
    vi.useFakeTimers()
    const passoMs = Math.ceil(LAVORO_UTILE_MS / 2) + 1_000
    h.emetti.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + passoMs))
      return esitoOk
    })

    const attesa = POST(richiesta(TETTO_BLOCCO))
    await vi.advanceTimersByTimeAsync(BUDGET_BLOCCO_MS * 2)
    const res = await attesa
    const body = (await res.json()) as { data: { emesse: unknown[]; restanti: string[]; fermato: string | null } }

    expect(body.data.fermato).toBe('budget')
    expect(body.data.emesse.length).toBeLessThan(TETTO_BLOCCO)
    expect(
      body.data.emesse.length + body.data.restanti.length,
      'nessuna riga può sparire fra le emesse e i restanti',
    ).toBe(TETTO_BLOCCO)
    vi.useRealTimers()
  })
})

describe('un guasto a metà blocco', () => {
  it('un 502 di trasporto ferma il blocco e le righe dopo tornano fra i restanti', async () => {
    h.emetti.mockImplementation(async (_sb: unknown, id: string) =>
      id === uuid(2)
        ? { ok: false, motivo: 'errore', messaggio: 'trasporto ignoto', httpStatus: 502 }
        : esitoOk,
    )

    const res = await POST(richiesta(5))
    const body = (await res.json()) as {
      data: { emesse: unknown[]; fallite: { codice?: string }[]; restanti: string[]; fermato: string | null }
    }

    expect(body.data.fermato).toBe('errore')
    expect(body.data.emesse).toHaveLength(1)
    expect(body.data.fallite).toHaveLength(1)
    // Il codice è ciò che dice al pannello di NON ripremere: senza, il trasporto ignoto
    // sarebbe indistinguibile da un rifiuto qualunque.
    expect(body.data.fallite[0].codice).toBe('FATTURA_TRASPORTO_IGNOTO')
    expect(body.data.restanti).toEqual([uuid(3), uuid(4), uuid(5)])
  })

  it('un rifiuto LOCALE non ferma il blocco: le righe dopo si tentano', async () => {
    // 409 nasce dai nostri gate, prima del `signin`: riguarda quella riga e basta.
    h.emetti.mockImplementation(async (_sb: unknown, id: string) =>
      id === uuid(2)
        ? { ok: false, motivo: 'quota_estranea', messaggio: 'riga viva estranea', httpStatus: 409 }
        : esitoOk,
    )

    const res = await POST(richiesta(4))
    const body = (await res.json()) as { data: { emesse: unknown[]; fallite: unknown[]; restanti: string[]; fermato: string | null } }

    expect(body.data.fermato).toBeNull()
    expect(body.data.emesse).toHaveLength(3)
    expect(body.data.fallite).toHaveLength(1)
    expect(body.data.restanti).toEqual([])
  })
})

describe('«già a registro» non si conta come «emessa adesso»', () => {
  it('un rilancio idempotente finisce in `gia_emesse`, non fra le emesse', async () => {
    // Senza questa distinzione, rilanciare un blocco parzialmente eseguito direbbe
    // «emesse 4» quando le nuove erano una: chi usa quel numero per la quadratura
    // conterebbe tre documenti mai emessi oggi.
    h.emetti.mockImplementation(async (_sb: unknown, id: string) =>
      id === uuid(1) ? esitoOk : { ...esitoOk, gia: true },
    )

    const res = await POST(richiesta(4))
    const body = (await res.json()) as { data: { emesse: unknown[]; gia_emesse: unknown[] } }

    expect(body.data.emesse).toHaveLength(1)
    expect(body.data.gia_emesse).toHaveLength(3)
  })
})

describe('il budget si deriva da `maxDuration`, e i due non possono divergere', () => {
  it('la route dichiara nel SORGENTE lo stesso `maxDuration` su cui il budget è calcolato', () => {
    // `maxDuration` è una RICHIESTA alla piattaforma: se il budget fosse calcolato su un
    // numero e la route ne dichiarasse un altro, la guardia sarebbe tarata sul muro
    // sbagliato e nessun test se ne accorgerebbe. Si legge dal sorgente, come fa già
    // `import-iscrizioni-giri-non-si-sovrappongono.test.ts`.
    const sorgente = readFileSync(
      path.join(process.cwd(), 'src/app/api/pagamenti/fattura/lotto/route.ts'),
      'utf8',
    )
    // ⚠️ IL LETTERALE, NON LA COSTANTE. Next analizza la configurazione di segmento
    // STATICAMENTE: un valore importato fa fallire il build con «Invalid segment
    // configuration export detected» — provato, non dedotto. Quindi il numero è scritto
    // in due posti, e questo è il punto che impedisce alle due copie di divergere in
    // silenzio lasciando il budget tarato su un muro che non esiste più.
    const dichiarato = /export const maxDuration = (\d+)/.exec(sorgente)?.[1]
    expect(dichiarato, 'la route deve dichiarare `maxDuration`').toBeTruthy()
    expect(Number(dichiarato)).toBe(MAX_DURATION_BLOCCO_S)
    expect(BUDGET_BLOCCO_MS).toBe(MAX_DURATION_BLOCCO_S * 1_000 - MARGINE_PIATTAFORMA_MS)
  })
})

describe('l’intestatario proposto dal bonifico arriva fino all’emissione', () => {
  it('non viene scartato per strada: ogni riga lo porta con sé', async () => {
    // ⚠️ IL DIFETTO CHE QUESTO CASO CHIUDE È SILENZIOSO. `zod` è una lista bianca **in
    // scrittura**: un campo non dichiarato nello schema viene scartato senza un errore,
    // e la richiesta risponde 200. Il pannello manderebbe l'intestatario scelto, il
    // blocco lo butterebbe via, e il server deciderebbe con la cascata predefinita —
    // fatture intestate a qualcun altro, senza nessuna schermata che lo dica.
    //
    // È già successo su questo repo con `scuola_id` (trasferimento di sede, 04/09) e
    // con i campi dell'anagrafica di sede (15/08): due volte, sempre con un 200.
    const res = await POST(richiesta(3, 1, true))
    expect(res.status).toBe(200)

    const passati = h.emetti.mock.calls.map((c) => (c[3] as { intestatarioScelto?: unknown }).intestatarioScelto)
    expect(passati).toEqual([
      { tipo: 'adult', adult_id: uuid(900) },
      { tipo: 'adult', adult_id: uuid(901) },
      { tipo: 'adult', adult_id: uuid(902) },
    ])
  })

  it('senza intestatario resta `undefined`: decide la cascata del server, come prima', async () => {
    await POST(richiesta(2))
    for (const chiamata of h.emetti.mock.calls) {
      expect((chiamata[3] as { intestatarioScelto?: unknown }).intestatarioScelto).toBeUndefined()
    }
  })
})
