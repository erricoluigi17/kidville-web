import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { RigaCalendario } from '@/lib/anno-scolastico'
import type { StatoAnno } from '@/lib/anno/tipi'

// =============================================================================
// IL CONTESTO DELL'ANNO (PR 4.2.5). Il calendario e le sedi attive sono finti (sono contesti con un
// loro test); il cookie è quello VERO di jsdom, e le scritture si osservano sul setter di
// `document.cookie`, perché è lì che si vedono gli attributi (`path`, `samesite`, `max-age`).
// Gli stati sono scritti a mano nelle righe del calendario: nessun test dipende da «oggi».
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

const h = vi.hoisted(() => ({
  perSede: {} as Record<string, readonly unknown[]>,
  calLoading: false,
  calErrore: false,
  ricaricaCal: vi.fn(),
  effettive: [] as string[],
  sediLoading: false,
  sediErrore: false,
}))

vi.mock('@/lib/context/calendario-context', () => ({
  useCalendario: () => ({
    perSede: h.perSede,
    loading: h.calLoading,
    errore: h.calErrore,
    ricarica: h.ricaricaCal,
  }),
}))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({ effettive: h.effettive, loading: h.sediLoading, errore: h.sediErrore }),
}))

import { AnnoProvider, AnnoScopeBoundary, COOKIE_ANNO_CLIENT, useAnno, type AnnoContextValue } from '@/lib/context/anno-context'
import { COOKIE_ANNO } from '@/lib/auth/scope'

const A25 = '22222222-2222-4222-8222-222222222025'
const A26 = '22222222-2222-4222-8222-222222222026'
const A27 = '22222222-2222-4222-8222-222222222027'
const A28 = '22222222-2222-4222-8222-222222222028'
const IGNOTO = '22222222-2222-4222-8222-222222229999'

function riga(sede: string, anno: number, stato: StatoAnno, annoId: string): RigaCalendario {
  return {
    annoId,
    annoSedeId: `5ed00000-0000-4000-8000-${sede.slice(-6)}${String(anno).padStart(6, '0')}`,
    annoInizio: anno,
    inizio: `${anno}-09-01`,
    fine: `${anno + 1}-08-31`,
    ultimoGiornoAperto: `${anno + 1}-07-31`,
    preparaSuccessivoDal: `${anno}-03-01`,
    stato,
    domandeAperte: false,
  }
}

/** Come in produzione: 2025/26 chiuso, 2026/27 corrente, 2027/28 in preparazione. */
function treAnni(sede: string): RigaCalendario[] {
  return [
    riga(sede, 2025, 'chiuso', A25),
    riga(sede, 2026, 'corrente', A26),
    riga(sede, 2027, 'in_preparazione', A27),
  ]
}

let ctx: AnnoContextValue
function Spia() {
  const valore = useAnno()
  // In un effetto (non nel render): `render` e `act` li scaricano, quindi dopo di loro `ctx` è aggiornato.
  useEffect(() => {
    ctx = valore
  })
  return null
}

let scritture: string[]
let spiaCookie: ReturnType<typeof vi.spyOn>

function azzeraCookieJsdom() {
  // Scrive nel cookie vero (prima di installare la spia).
  document.cookie = `${COOKIE_ANNO_CLIENT}=; path=/; max-age=0`
}

beforeEach(() => {
  azzeraCookieJsdom()
  h.perSede = { [SEDE_A]: treAnni(SEDE_A) }
  h.calLoading = false
  h.calErrore = false
  h.effettive = [SEDE_A]
  h.sediLoading = false
  h.sediErrore = false
  scritture = []
  spiaCookie = vi.spyOn(document, 'cookie', 'set')
  spiaCookie.mockImplementation(((v: string) => {
    scritture.push(v)
  }) as never)
})

afterEach(() => {
  spiaCookie.mockRestore()
  azzeraCookieJsdom()
})

/** Con la spia installata il cookie non arriva a jsdom: per i test che LEGGONO lo si scrive prima. */
function cookieIniziale(valore: string) {
  spiaCookie.mockRestore()
  document.cookie = `${COOKIE_ANNO_CLIENT}=${valore}; path=/`
  spiaCookie = vi.spyOn(document, 'cookie', 'set')
  spiaCookie.mockImplementation(((v: string) => {
    scritture.push(v)
  }) as never)
}

function monta() {
  return render(
    <AnnoProvider>
      <Spia />
    </AnnoProvider>,
  )
}

describe('AnnoProvider — il nome del cookie', () => {
  it('è lo stesso che legge il server (COOKIE_ANNO di scope.ts)', () => {
    expect(COOKIE_ANNO_CLIENT).toBe(COOKIE_ANNO)
  })
})

describe('AnnoProvider — l\'anno predefinito è l\'anno attivo', () => {
  it('senza cookie l\'effettivo è l\'attivo (2026/27, corrente) e nessuna scrittura avviene', () => {
    monta()
    expect(ctx.anni.map((a) => a.annoInizio)).toEqual([2027, 2026, 2025])
    expect(ctx.selezionato).toBeNull()
    expect(ctx.effettivo?.annoId).toBe(A26)
    expect(ctx.effettivo?.attivo).toBe(true)
    expect(ctx.eAttivo).toBe(true)
    expect(ctx.effettivo?.annoSedeId).toBe(h.perSede[SEDE_A][1] && (h.perSede[SEDE_A][1] as RigaCalendario).annoSedeId)
    expect(ctx.effettivo?.etichettaBreve).toBe('2026/27')
    expect(scritture).toEqual([])
  })

  it('l\'attivo è l\'inizio più recente fra corrente / in_chiusura / chiuso (in_preparazione e iscrizioni_aperte no)', () => {
    h.perSede = {
      [SEDE_A]: [
        riga(SEDE_A, 2025, 'chiuso', A25),
        riga(SEDE_A, 2026, 'in_chiusura', A26),
        riga(SEDE_A, 2027, 'iscrizioni_aperte', A27),
        riga(SEDE_A, 2028, 'in_preparazione', A28),
      ],
    }
    monta()
    expect(ctx.effettivo?.annoId).toBe(A26)
    expect(ctx.effettivo?.stato).toBe('in_chiusura')
    expect(ctx.anni.filter((a) => a.attivo).map((a) => a.annoId)).toEqual([A26])
  })
})

describe('AnnoProvider — scegliere, tornare all\'attivo, epoca', () => {
  it('scegliere un altro anno scrive il cookie e avanza epocaAnno; usaAttivo lo cancella e avanza di nuovo', () => {
    monta()
    expect(ctx.epocaAnno).toBe(0)

    act(() => ctx.scegli(A27))
    expect(scritture).toEqual([`anno_attivo=${A27}; path=/; samesite=lax; max-age=604800`])
    expect(ctx.epocaAnno).toBe(1)
    expect(ctx.selezionato).toBe(A27)
    expect(ctx.effettivo?.annoId).toBe(A27)
    expect(ctx.eAttivo).toBe(false)

    act(() => ctx.usaAttivo())
    expect(scritture[1]).toBe('anno_attivo=; path=/; samesite=lax; max-age=0')
    expect(ctx.epocaAnno).toBe(2)
    expect(ctx.selezionato).toBeNull()
    expect(ctx.effettivo?.annoId).toBe(A26)
    expect(ctx.eAttivo).toBe(true)
  })

  it('il primo caricamento del calendario NON avanza epocaAnno', () => {
    h.calLoading = true
    h.perSede = {}
    const { rerender } = monta()
    expect(ctx.loading).toBe(true)
    expect(ctx.anni).toEqual([])
    expect(ctx.epocaAnno).toBe(0)

    h.calLoading = false
    h.perSede = { [SEDE_A]: treAnni(SEDE_A) }
    rerender(
      <AnnoProvider>
        <Spia />
      </AnnoProvider>,
    )
    expect(ctx.anni).toHaveLength(3)
    expect(ctx.epocaAnno).toBe(0)
  })

  it('scegliere un anno che non è nell\'elenco non scrive niente e non avanza l\'epoca', () => {
    monta()
    act(() => ctx.scegli(IGNOTO))
    expect(scritture).toEqual([])
    expect(ctx.epocaAnno).toBe(0)
    expect(ctx.selezionato).toBeNull()
  })

  it('ricarica() rilegge il calendario e non è un cambio di anno', () => {
    monta()
    act(() => ctx.ricarica())
    expect(h.ricaricaCal).toHaveBeenCalledTimes(1)
    expect(ctx.epocaAnno).toBe(0)
  })
})

describe('AnnoProvider — il cookie stantio', () => {
  it('un cookie che non è più nell\'elenco viene potato a elenco arrivato', () => {
    cookieIniziale(IGNOTO)
    monta()
    expect(scritture).toEqual(['anno_attivo=; path=/; samesite=lax; max-age=0'])
    expect(ctx.selezionato).toBeNull()
    expect(ctx.effettivo?.annoId).toBe(A26)
    expect(ctx.epocaAnno).toBe(0)
  })

  it('un cookie valido e presente nell\'elenco resta, ed è la scelta', () => {
    cookieIniziale(A27)
    monta()
    expect(scritture).toEqual([])
    expect(ctx.selezionato).toBe(A27)
    expect(ctx.effettivo?.annoId).toBe(A27)
  })

  it('con il calendario in errore il cookie RESTA (un elenco vuoto per un guasto non è un elenco)', () => {
    cookieIniziale(IGNOTO)
    h.calErrore = true
    h.perSede = {}
    monta()
    expect(scritture).toEqual([])
    expect(ctx.errore).toBe(true)
  })

  it('con il calendario ancora in caricamento il cookie RESTA', () => {
    cookieIniziale(IGNOTO)
    h.calLoading = true
    h.perSede = {}
    monta()
    expect(scritture).toEqual([])
  })

  it('con le sedi ancora in caricamento (o in errore) il cookie RESTA', () => {
    cookieIniziale(A26)
    h.perSede = {} // il calendario non conosce ancora le sedi: gli anni sono vuoti, ma non per scelta
    h.sediLoading = true
    monta()
    expect(scritture).toEqual([])
    h.sediLoading = false
    h.sediErrore = true
    monta()
    expect(scritture).toEqual([])
  })

  it('un cookie che non ha la forma di un uuid si ignora (senza scrivere)', () => {
    cookieIniziale('non-un-uuid')
    monta()
    expect(ctx.selezionato).toBeNull()
    expect(ctx.effettivo?.annoId).toBe(A26)
  })
})

describe('AnnoProvider — più sedi attive', () => {
  beforeEach(() => {
    h.effettive = [SEDE_A, SEDE_B]
    h.perSede = {
      [SEDE_A]: treAnni(SEDE_A),
      // La seconda sede non ha il 2025/26.
      [SEDE_B]: [riga(SEDE_B, 2026, 'corrente', A26), riga(SEDE_B, 2027, 'in_preparazione', A27)],
    }
  })

  it('anni è l\'intersezione, annoSedeId è null, effettivo è null senza scelta e non c\'è nulla da segnalare', () => {
    monta()
    expect(ctx.anni.map((a) => a.annoId)).toEqual([A27, A26])
    expect(ctx.anni.every((a) => a.annoSedeId === null)).toBe(true)
    expect(ctx.effettivo).toBeNull()
    expect(ctx.eAttivo).toBe(true)
    expect(ctx.anni.find((a) => a.annoId === A26)?.attivo).toBe(true)
    expect(ctx.anni.find((a) => a.annoId === A27)?.attivo).toBe(false)
  })

  it('con una scelta l\'effettivo è quell\'anno, e non è l\'attivo', () => {
    monta()
    act(() => ctx.scegli(A27))
    expect(ctx.effettivo?.annoId).toBe(A27)
    expect(ctx.effettivo?.annoSedeId).toBeNull()
    expect(ctx.eAttivo).toBe(false)
  })

  it('se una delle sedi non ha ancora il calendario non ci sono anni in comune', () => {
    h.perSede = { [SEDE_A]: treAnni(SEDE_A) }
    monta()
    expect(ctx.anni).toEqual([])
  })
})

describe('AnnoProvider — cambiare sede', () => {
  it('ricalcola gli anni e, se l\'anno scelto non esiste nella nuova sede, torna all\'attivo e pota il cookie', () => {
    h.perSede = {
      [SEDE_A]: treAnni(SEDE_A),
      [SEDE_B]: [riga(SEDE_B, 2026, 'corrente', A26), riga(SEDE_B, 2027, 'in_preparazione', A27)],
    }
    const { rerender } = monta()
    act(() => ctx.scegli(A25))
    expect(ctx.effettivo?.annoId).toBe(A25)
    scritture.length = 0

    h.effettive = [SEDE_B]
    rerender(
      <AnnoProvider>
        <Spia />
      </AnnoProvider>,
    )
    expect(ctx.anni.map((a) => a.annoId)).toEqual([A27, A26])
    expect(ctx.selezionato).toBeNull()
    expect(ctx.effettivo?.annoId).toBe(A26)
    expect(scritture).toEqual(['anno_attivo=; path=/; samesite=lax; max-age=0'])
  })

  it('se l\'anno scelto esiste anche nella nuova sede resta scelto, con la riga della nuova sede', () => {
    h.perSede = { [SEDE_A]: treAnni(SEDE_A), [SEDE_B]: treAnni(SEDE_B) }
    const { rerender } = monta()
    act(() => ctx.scegli(A27))
    const sedeA = ctx.effettivo?.annoSedeId

    h.effettive = [SEDE_B]
    rerender(
      <AnnoProvider>
        <Spia />
      </AnnoProvider>,
    )
    expect(ctx.effettivo?.annoId).toBe(A27)
    expect(ctx.effettivo?.annoSedeId).not.toBe(sedeA)
    expect(ctx.effettivo?.annoSedeId).toBe((h.perSede[SEDE_B][2] as RigaCalendario).annoSedeId)
  })
})

describe('AnnoScopeBoundary', () => {
  let montaggi = 0
  function Pagina() {
    const [n] = useState(() => ++montaggi)
    return <div data-testid="pagina">{n}</div>
  }

  beforeEach(() => {
    montaggi = 0
  })

  it('cambiando anno i figli rimontano; il primo caricamento non li rimonta', () => {
    h.calLoading = true
    h.perSede = {}
    // Un elemento NUOVO a ogni giro: lo stesso elemento farebbe saltare il re-render di React.
    const albero = () => (
      <AnnoProvider>
        <Spia />
        <AnnoScopeBoundary>
          <Pagina />
        </AnnoScopeBoundary>
      </AnnoProvider>
    )
    const { rerender } = render(albero())
    expect(montaggi).toBe(1)

    h.calLoading = false
    h.perSede = { [SEDE_A]: treAnni(SEDE_A) }
    rerender(albero())
    expect(ctx.anni).toHaveLength(3)
    expect(montaggi).toBe(1)

    act(() => ctx.scegli(A27))
    expect(montaggi).toBe(2)
    act(() => ctx.usaAttivo())
    expect(montaggi).toBe(3)
  })
})
