import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/parent/presenze → campo `comunicate`
//
// Il genitore che comunica un'assenza per un giorno futuro non aveva alcun modo
// di RILEGGERLA: la home restituiva solo lo stato dell'appello odierno e i
// conteggi degli ultimi 30 giorni. Senza elenco non esiste annullamento.
//
// `comunicate` = le righe `presenze` dell'alunno che:
//   • hanno `data >= oggi`            (il passato non si annulla)
//   • hanno `giustificata_da` NON nullo (l'ha scritta un genitore, non l'appello)
//   • hanno `registrato_da` NULLO      (il docente non ha ancora fatto l'appello)
// ordinate per data crescente.
//
// ⚠️ IL FUSO NON È UN DETTAGLIO. L'orologio di questi test è fermo alle 22:30 UTC
// del 10 agosto, che in Italia (CEST, UTC+2) sono le 00:30 dell'11. Con
// `new Date().toISOString().slice(0,10)` — quello che la route usava — "oggi"
// sarebbe il 10: l'assenza di ieri risulterebbe ancora annullabile e il badge
// della home mostrerebbe l'appello del giorno sbagliato. Perciò si usa
// `oggiFiscaleISO()` (Europe/Rome), e questi test lo dimostrano invece di
// ripeterne il calcolo.
// ─────────────────────────────────────────────────────────────────────────────

type Riga = Record<string, unknown>
type Filtro = { op: string; col: string; val: unknown }

const h = vi.hoisted(() => {
  const state = {
    tabelle: {} as Record<string, Riga[]>,
    // Errore PostgREST forzato su una query riconosciuta dai suoi filtri.
    erroreSe: null as null | ((tabella: string, filtri: Filtro[]) => { code: string; message: string } | null),
    // Traccia di tutte le query eseguite (serve alle asserzioni sul contratto).
    eseguite: [] as { tabella: string; colonne: string; filtri: Filtro[] }[],
  }
  const logErrore = vi.fn()
  const logEvento = vi.fn()

  /** Un ramo `colonna.op.valore` del filtro `or` di PostgREST. */
  function ramoOr(riga: Riga, ramo: string): boolean {
    const [col, ...resto] = ramo.split('.')
    const coda = resto.join('.')
    const v = riga[col]
    if (coda === 'is.null') return v === null || v === undefined
    if (coda === 'not.is.null') return v !== null && v !== undefined
    if (coda.startsWith('neq.')) return String(v ?? '') !== coda.slice(4)
    throw new Error(`ramo or non gestito dal doppio: ${ramo}`)
  }

  function applica(riga: Riga, f: Filtro): boolean {
    const v = riga[f.col]
    switch (f.op) {
      case 'eq':
        return v === f.val
      case 'gte':
        return String(v) >= String(f.val)
      case 'lte':
        return String(v) <= String(f.val)
      case 'is':
        // `.is(col, null)` → la colonna deve essere NULL.
        return f.val === null ? v === null || v === undefined : v === f.val
      case 'not.is':
        // `.not(col, 'is', null)` → la colonna NON deve essere NULL.
        return f.val === null ? v !== null && v !== undefined : v !== f.val
      case 'or':
        // `.or('a,b,c')` → DISGIUNZIONE. È il filtro sulla SORGENTE aggiunto da
        // Q4: il tetto `data <= oggi` non può escludere una riga che cade su
        // OGGI, e «oggi» è il giorno preimpostato dal modulo del genitore.
        return String(f.val).split(',').some((ramo) => ramoOr(riga, ramo))
      default:
        return true
    }
  }

  function proietta(riga: Riga, colonne: string): Riga {
    if (colonne === '*') return { ...riga }
    const out: Riga = {}
    for (const c of colonne.split(',').map((s) => s.trim()).filter(Boolean)) out[c] = riga[c] ?? null
    return out
  }

  function makeClient() {
    return {
      from(tabella: string) {
        const filtri: Filtro[] = []
        let colonne = '*'
        let ordine: { col: string; asc: boolean } | null = null
        const qb: Record<string, unknown> = {}
        qb.select = (c?: string) => {
          if (typeof c === 'string' && c.trim()) colonne = c
          return qb
        }
        for (const op of ['eq', 'gte', 'lte'] as const) {
          qb[op] = (col: string, val: unknown) => {
            filtri.push({ op, col, val })
            return qb
          }
        }
        qb.is = (col: string, val: unknown) => {
          filtri.push({ op: 'is', col, val })
          return qb
        }
        qb.not = (col: string, op: string, val: unknown) => {
          filtri.push({ op: `not.${op}`, col, val })
          return qb
        }
        qb.or = (val: string) => {
          filtri.push({ op: 'or', col: '', val })
          return qb
        }
        qb.order = (col: string, opts?: { ascending?: boolean }) => {
          ordine = { col, asc: opts?.ascending !== false }
          return qb
        }
        qb.limit = () => qb
        qb.in = (col: string, val: unknown) => {
          filtri.push({ op: 'in', col, val })
          return qb
        }
        const esegui = () => {
          state.eseguite.push({ tabella, colonne, filtri: [...filtri] })
          const err = state.erroreSe?.(tabella, filtri) ?? null
          if (err) return { data: null, error: err }
          let righe = (state.tabelle[tabella] ?? []).filter((r) => filtri.every((f) => applica(r, f)))
          if (ordine) {
            const o = ordine as { col: string; asc: boolean }
            righe = [...righe].sort((a, b) => {
              const x = String(a[o.col] ?? '')
              const y = String(b[o.col] ?? '')
              return (x < y ? -1 : x > y ? 1 : 0) * (o.asc ? 1 : -1)
            })
          }
          return { data: righe.map((r) => proietta(r, colonne)), error: null }
        }
        qb.maybeSingle = () => {
          const res = esegui()
          return Promise.resolve(res.error ? res : { data: res.data?.[0] ?? null, error: null })
        }
        qb.single = qb.maybeSingle
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(esegui()).then(res, rej)
        return qb
      },
    }
  }

  return { state, makeClient, logErrore, logEvento }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))

const auth = vi.hoisted(() => ({ requireParentOfStudent: vi.fn() }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: auth.requireParentOfStudent }))

// Si tiene il modulo reale (withRoute importa logOk/vaPersistito/…) e si spiano
// solo le due funzioni di emissione che il ramo degradato deve chiamare.
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logErrore: h.logErrore, logEvento: h.logEvento }
})

import { GET } from '@/app/api/parent/presenze/route'
import { NextRequest } from 'next/server'

function req(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/parent/presenze${qs}`, { headers: { 'x-user-id': 'u-1' } })
}

// 10 agosto 2026, 22:30 UTC = 11 agosto, 00:30 in Italia.
const ISTANTE = new Date('2026-08-10T22:30:00.000Z')
const OGGI_ROMA = '2026-08-11'
const IERI_ROMA = '2026-08-10' // ...che in UTC è ancora "oggi": è tutto il punto.

function presenza(over: Riga): Riga {
  return {
    alunno_id: 'a-1',
    stato: 'assente',
    orario_entrata: null,
    orario_uscita: null,
    giustificazione_testo: null,
    giustificata_da: null,
    registrato_da: null,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Solo `Date`: i timer restano veri, così nessuna promise resta appesa.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ISTANTE)
  h.state.tabelle = {}
  h.state.erroreSe = null
  h.state.eseguite = []
  auth.requireParentOfStudent.mockResolvedValue({ user: { id: 'u-1', role: 'genitore' }, response: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/parent/presenze — assenze comunicate ancora annullabili', () => {
  beforeEach(() => {
    h.state.tabelle = {
      alunni: [{ id: 'a-1', section_id: 'sez-1', scuola_id: 's-1' }],
      sections: [{ id: 'sez-1', school_type: 'infanzia' }],
      presenze: [
        // Ieri (a Roma): comunicata dal genitore ma ormai passata → non annullabile.
        // Lo stato è 'ritardo' per distinguerla: se la route calcolasse "oggi" in
        // UTC, sarebbe QUESTA la riga letta come appello odierno.
        presenza({ id: 'p-ieri', data: IERI_ROMA, stato: 'ritardo', giustificata_da: 'u-1' }),
        // Oggi: comunicata e appello non ancora fatto → annullabile.
        presenza({ id: 'p-oggi', data: OGGI_ROMA, giustificata_da: 'u-1', giustificazione_testo: 'febbre' }),
        // Dopodomani: messa PRIMA di domani nel dataset, per provare l'ordinamento.
        presenza({ id: 'p-dopodomani', data: '2026-08-13', giustificata_da: 'u-1' }),
        presenza({ id: 'p-domani', data: '2026-08-12', giustificata_da: 'u-1', giustificazione_testo: 'controllo' }),
        // Futura ma già passata all'appello del docente → non più annullabile.
        presenza({ id: 'p-appello', data: '2026-08-14', giustificata_da: 'u-1', registrato_da: 'doc-1' }),
        // Futura ma non comunicata da un genitore → non è roba sua.
        presenza({ id: 'p-docente', data: '2026-08-15', registrato_da: 'doc-1' }),
        // Di un altro alunno.
        presenza({ id: 'p-altro', alunno_id: 'a-2', data: '2026-08-12', giustificata_da: 'u-9' }),
      ],
    }
  })

  it('elenca solo le assenze da oggi in poi comunicate dal genitore e non ancora passate all\'appello', async () => {
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.comunicate.map((c: { id: string }) => c.id)).toEqual(['p-oggi', 'p-domani', 'p-dopodomani'])
    expect(body.data.comunicate[0]).toEqual({
      id: 'p-oggi',
      data: OGGI_ROMA,
      giustificazione_testo: 'febbre',
      stato: 'assente',
    })
  })

  it('non annulla il passato: la riga di ieri (ora italiana) resta fuori dall\'elenco', async () => {
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    const ids = body.data.comunicate.map((c: { id: string }) => c.id)
    expect(ids).not.toContain('p-ieri')
    // ...e "oggi" è l'11, non il 10, E la riga dell'11 è un ANNUNCIO (Q4).
    //
    // Questa asserzione diceva `'assente'` e stava misurando il difetto: la riga
    // `p-oggi` è scritta dal genitore (`giustificata_da` valorizzato,
    // `registrato_da` nullo) e nessun docente ha fatto l'appello, quindi il
    // contratto della rotta impone `stato: null`.
    // Il discriminante sul FUSO non si perde, si inverte: con «oggi» calcolato
    // in UTC la rotta leggerebbe `p-ieri`, che è un 'ritardo' — cioè NON un
    // annuncio — e qui vedremmo `'ritardo'` al posto di `null`.
    expect(body.data.oggi.stato).toBeNull()
    expect(body.data.riepilogo.to).toBe(OGGI_ROMA)
    expect(body.data.riepilogo.from).toBe('2026-07-12')
  })

  it('lascia intatti `oggi` e `riepilogo` (la modifica è additiva, e il futuro non si conteggia)', async () => {
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    expect(body.data.schoolType).toBe('infanzia')
    expect(body.data.oggi).toEqual({ stato: null, orario_entrata: null, orario_uscita: null })
    // Nei 30 giorni cadono 'p-ieri' (ritardo, un fatto) e 'p-oggi' (assenza solo
    // ANNUNCIATA per il giorno corrente, che dal rilievo Q4 non si conta: era
    // `assenze: 1` con zero appelli fatti). Le assenze FUTURE non gonfiavano già
    // più i conteggi; quella di OGGI sì, perché `oggi <= oggi`.
    expect(body.data.riepilogo).toMatchObject({ presenze: 0, assenze: 0, ritardi: 1, uscite: 0 })
  })

  it('chiede a PostgREST i filtri giusti (giustificata_da NOT NULL · registrato_da NULL)', async () => {
    await GET(req('?studentId=a-1'))

    const q = h.state.eseguite.find(
      (e) => e.tabella === 'presenze' && e.filtri.some((f) => f.col === 'registrato_da'),
    )
    expect(q, 'la route deve interrogare `presenze` filtrando su registrato_da').toBeDefined()
    expect(q?.filtri).toEqual(
      expect.arrayContaining([
        { op: 'eq', col: 'alunno_id', val: 'a-1' },
        { op: 'gte', col: 'data', val: OGGI_ROMA },
        { op: 'not.is', col: 'giustificata_da', val: null },
        { op: 'is', col: 'registrato_da', val: null },
      ]),
    )
  })

  it('degrada a lista vuota LOGGANDO se la query fallisce, senza rompere la home', async () => {
    h.state.erroreSe = (tabella, filtri) =>
      tabella === 'presenze' && filtri.some((f) => f.col === 'registrato_da')
        ? { code: '42703', message: 'column presenze.registrato_da does not exist' }
        : null

    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.comunicate).toEqual([])
    // Il resto della home arriva comunque. `oggi.stato` è `null` perché la riga
    // dell'11 è un annuncio del genitore, non un appello (Q4).
    expect(body.data.oggi.stato).toBeNull()
    expect(body.data.riepilogo).toMatchObject({ assenze: 0, ritardi: 1 })
    // ...e il silenzio è vietato.
    const loggato = h.logErrore.mock.calls.length + h.logEvento.mock.calls.length
    expect(loggato, 'una query fallita non può passare in silenzio').toBeGreaterThan(0)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // «NON NE HAI» E «NON SONO RIUSCITO A LEGGERLE» SONO DUE COSE DIVERSE.
  //
  // Il degrado qui sopra è la scelta giusta per la home — un elenco accessorio
  // non deve rompere la dashboard — ma da solo produce un 200 valido con
  // `comunicate: []`, e le due schermate che lo consumano
  // (`parent/attendance/page.tsx`, `ComunicaAssenzaCard.tsx`) non hanno modo di
  // distinguerlo dal vuoto vero: mostrano «Non hai comunicato nessuna assenza» a
  // un genitore che ne ha, e che quindi non può nemmeno annullarle. Entrambe
  // hanno un ramo d'errore già scritto e funzionante, che su questo guasto non
  // veniva MAI raggiunto. Il log lo diceva, ma il log lo leggiamo noi, non lui.
  //
  // Il flag è ADDITIVO e vive accanto a `comunicate`: `oggi` e `riepilogo` non
  // cambiano forma, perché ci vive sopra `PresenzeTodayCard`.
  // ───────────────────────────────────────────────────────────────────────────
  it('lettura riuscita: `comunicateLette` è true (il flag c’è sempre, non solo quando serve)', async () => {
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    expect(body.data.comunicateLette).toBe(true)
  })

  it('lettura fallita: 200 con `comunicateLette` FALSE, così il vuoto non può mentire', async () => {
    h.state.erroreSe = (tabella, filtri) =>
      tabella === 'presenze' && filtri.some((f) => f.col === 'registrato_da')
        ? { code: '42703', message: 'column presenze.registrato_da does not exist' }
        : null

    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.comunicateLette).toBe(false)
    expect(body.data.comunicate).toEqual([])
    // La modifica è additiva: la home continua a ricevere ciò che le serve.
    // `stato: null` è il contratto della rotta quando l'appello non c'è, e la
    // riga dell'11 è un annuncio del genitore (Q4).
    expect(body.data.oggi).toEqual({ stato: null, orario_entrata: null, orario_uscita: null })
    expect(body.data.riepilogo).toMatchObject({ assenze: 0, ritardi: 1 })
  })

  it('alunno senza sezione: nessuna sezione, ma le comunicate si leggono lo stesso', async () => {
    h.state.tabelle.alunni = [{ id: 'a-1', section_id: null, scuola_id: 's-1' }]
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.schoolType).toBeNull()
    expect(body.data.comunicate.map((c: { id: string }) => c.id)).toEqual(['p-oggi', 'p-domani', 'p-dopodomani'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// «NON C'È» E «NON L'HO POTUTO LEGGERE» SONO DUE COSE DIVERSE.
//
// Delle sei letture di questa route una sola — `comunicate`, nata nel ciclo
// precedente — controllava `{ error }`. Le altre cinque destrutturavano il solo
// `data`: PostgREST non lancia, quindi `alunno` restava `null` e il flusso cadeva
// nella porta del 404 «Alunno non trovato». A un genitore si diceva che suo
// figlio non esiste per un guasto del database — ed è letteralmente la bugia che
// la route gemella dichiara di aver corretto quaranta righe più in là.
//
// Il riepilogo faceva la stessa cosa in silenzio: una lettura fallita usciva come
// una fila di ZERI, cioè «tuo figlio non è mai stato assente», con un 200 e senza
// una riga di log.
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/parent/presenze — un guasto di lettura non si traveste da dato', () => {
  beforeEach(() => {
    h.state.tabelle = {
      alunni: [{ id: 'a-1', section_id: 'sez-1', scuola_id: 's-1' }],
      sections: [{ id: 'sez-1', school_type: 'infanzia' }],
      presenze: [presenza({ id: 'p-oggi', data: OGGI_ROMA, stato: 'assente', giustificata_da: 'u-1' })],
    }
  })

  /** Tutto ciò che è stato loggato, in una stringa sola. */
  const logScritti = () =>
    JSON.stringify([...h.logErrore.mock.calls, ...h.logEvento.mock.calls], (_k, v) =>
      v instanceof Error ? `${v.name}: ${v.message}` : v,
    )

  it('anagrafica illeggibile → 500 con codice, MAI «Alunno non trovato»', async () => {
    h.state.erroreSe = (tabella) =>
      tabella === 'alunni' ? { code: '42501', message: 'permission denied for table alunni' } : null

    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.codice).toBe('PRESENZE_NON_LETTE')
    expect(JSON.stringify(body)).not.toContain('non trovato')
    // Il `message` di PostgREST resta nel log, dove dice PERCHÉ — e non esce
    // verso il genitore, che leggerebbe prosa inglese con dentro nomi di tabelle.
    expect(JSON.stringify(body)).not.toContain('permission denied')
    expect(logScritti()).toContain('42501')
  })

  it('alunno davvero inesistente → 404 col suo codice (il 404 resta un 404)', async () => {
    const res = await GET(req('?studentId=a-9'))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.codice).toBe('ALUNNO_NON_TROVATO')
  })

  it('riepilogo illeggibile → il degrado si DICHIARA, e non passa in silenzio', async () => {
    // `lte` e non `gte`: la finestra dei 30 giorni è l'unica query di `presenze`
    // che ha un limite SUPERIORE — `comunicate` guarda dall'oggi in avanti e usa
    // solo `gte`. Distinguerle qui è ciò che rende questo test una prova del
    // riepilogo e non un secondo test di `comunicate`.
    h.state.erroreSe = (tabella, filtri) =>
      tabella === 'presenze' && filtri.some((f) => f.op === 'lte' && f.col === 'data')
        ? { code: '42703', message: 'column presenze.stato does not exist' }
        : null

    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    // La home non si rompe per un riepilogo: continua ad arrivare tutto il resto.
    expect(res.status).toBe(200)
    expect(body.data.riepilogoLetto).toBe(false)
    expect(body.data.comunicate.map((c: { id: string }) => c.id)).toEqual(['p-oggi'])
    expect(logScritti()).toContain('42703')
  })

  it('appello di oggi illeggibile → `oggiLetto` false, non un badge che dice «non registrato»', async () => {
    h.state.erroreSe = (tabella, filtri) =>
      tabella === 'presenze' && filtri.some((f) => f.op === 'eq' && f.col === 'data')
        ? { code: '42501', message: 'permission denied' }
        : null

    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.oggiLetto).toBe(false)
    expect(body.data.oggi.stato).toBeNull()
    expect(logScritti()).toContain('42501')
  })

  it('lettura riuscita: i due flag ci sono e valgono `true` (il vuoto vero è un dato)', async () => {
    h.state.tabelle.presenze = []
    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    expect(body.data.oggiLetto).toBe(true)
    expect(body.data.riepilogoLetto).toBe(true)
    expect(body.data.riepilogo).toMatchObject({ presenze: 0, assenze: 0 })
  })

  it('grado illeggibile → si logga, e la vista degrada senza inventare un grado', async () => {
    h.state.erroreSe = (tabella) => (tabella === 'sections' ? { code: '42P01', message: 'relation missing' } : null)

    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.schoolType).toBeNull()
    expect(logScritti()).toContain('42P01')
  })

  it('campanelle illeggibili (primaria) → si logga invece di far sparire il monte ore', async () => {
    h.state.tabelle.sections = [{ id: 'sez-1', school_type: 'primaria' }]
    h.state.erroreSe = (tabella) =>
      tabella === 'campanelle' ? { code: '42703', message: 'column campanelle.tipo does not exist' } : null

    const res = await GET(req('?studentId=a-1'))
    expect(res.status).toBe(200)
    expect(logScritti()).toContain('42703')
  })

  it('un guasto imprevisto non fa uscire il messaggio interno verso il genitore', async () => {
    auth.requireParentOfStudent.mockRejectedValue(new Error('boom: connessione al pool esaurita'))

    const res = await GET(req('?studentId=a-1'))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.codice).toBe('PRESENZE_NON_LETTE')
    expect(JSON.stringify(body)).not.toContain('boom')
    expect(logScritti()).toContain('boom')
  })
})
