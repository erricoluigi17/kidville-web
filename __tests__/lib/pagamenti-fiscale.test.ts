import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})

import {
  isTracciabile,
  bolloDovuto,
  datiStruttura,
  CATEGORIE_ESCLUSE_ADE,
  BOLLO_SOGLIA_DEFAULT,
} from '@/lib/pagamenti/fiscale'

beforeEach(() => vi.clearAllMocks())

describe('isTracciabile', () => {
  it('vero solo se tutti gli incassi sono con metodo tracciabile', () => {
    expect(isTracciabile(['bonifico', 'pos'])).toBe(true)
    expect(isTracciabile(['assegno'])).toBe(true)
    expect(isTracciabile(['bonifico', 'contanti'])).toBe(false)
    expect(isTracciabile(['contanti'])).toBe(false)
  })
  it('falso senza incassi o con metodo ignoto/mancante', () => {
    expect(isTracciabile([])).toBe(false)
    expect(isTracciabile([undefined])).toBe(false)
  })
})

describe('bolloDovuto', () => {
  it('€2 sopra la soglia 77,47 quando abilitato', () => {
    expect(bolloDovuto(100, { bollo_enabled: true })).toBe(2)
    expect(bolloDovuto(77.48, { bollo_enabled: true })).toBe(2)
  })
  it('0 sotto/alla soglia, se disabilitato o config assente', () => {
    expect(bolloDovuto(77.47, { bollo_enabled: true })).toBe(0)
    expect(bolloDovuto(50, { bollo_enabled: true })).toBe(0)
    expect(bolloDovuto(100, { bollo_enabled: false })).toBe(0)
    expect(bolloDovuto(100, null)).toBe(0)
  })
  it('soglia e importo personalizzabili', () => {
    expect(bolloDovuto(60, { bollo_enabled: true, bollo_soglia: 50, bollo_importo: 2.5 })).toBe(2.5)
    expect(BOLLO_SOGLIA_DEFAULT).toBe(77.47)
  })
})

describe('datiStruttura', () => {
  it('usa fiscale_config e ricade su aruba_config.fiscal per i campi mancanti', () => {
    const d = datiStruttura(
      { denominazione: 'Kidville Giugliano' },
      { fiscal: { piva: '01234567890', ragione_sociale: 'Kidville Srl' } }
    )
    expect(d.denominazione).toBe('Kidville Giugliano')
    expect(d.piva).toBe('01234567890')
  })
  it('senza nulla ritorna campi vuoti (mai undefined che rompe i PDF)', () => {
    const d = datiStruttura(null, null)
    expect(d.denominazione).toBe('')
    expect(d.piva).toBe('')
  })
})

// W4-A / R124 — «una ricevuta è già stata emessa senza intestazione».
//
// `fiscale_config` è `{}` su tutte e quattro le righe di `admin_settings`, e
// `aruba_config` esiste solo per Giugliano con `piva`/`ragione_sociale` vuote:
// `datiStruttura` restituisce allora sette stringhe vuote, il PDF stampa
// l'intestazione generica «Attestazione dei pagamenti» al posto del nome
// dell'ente e OMETTE la riga fiscale, perché P.IVA e CF si stampano solo se
// valorizzati. Il documento esce, semplicemente anonimo — ed è già successo.
// Nessun avviso, né a schermo né nei log.
//
// La scelta «i documenti omettono ciò che manca» resta (non si inventano dati
// fiscali). Quello che cambia è che il buco si VEDE: configurazione critica
// assente = livello `error`, mai `info` (AGENTS.md §4).
describe('datiStruttura — la configurazione fiscale mancante è un incidente', () => {
  it('denominazione e P.IVA vuote ⇒ logEvento a livello error, con la sede', () => {
    datiStruttura(null, null, { operazione: 'pagamenti/ricevuta:GET', scuolaId: 'sede-1' })
    expect(h.logEvento).toHaveBeenCalledWith(
      'fiscale',
      'error',
      expect.objectContaining({
        operazione: 'pagamenti/ricevuta:GET',
        esito: 'dati-struttura-mancanti',
        scuola_id: 'sede-1',
        denominazione_presente: false,
        piva_presente: false,
      }),
    )
  })

  it('basta che ne manchi UNA delle due: un documento con la P.IVA e senza nome non è valido', () => {
    datiStruttura({ denominazione: 'Cooperativa' }, null, { operazione: 'x' })
    expect(h.logEvento).toHaveBeenCalledWith(
      'fiscale',
      'error',
      expect.objectContaining({ esito: 'dati-struttura-mancanti', piva_presente: false, denominazione_presente: true }),
    )
  })

  it('configurazione completa ⇒ nessun log (il rumore spegne l’allarme)', () => {
    const d = datiStruttura(
      { denominazione: 'Cooperativa', piva: '01234567890' },
      null,
      { operazione: 'x', scuolaId: 'sede-1' },
    )
    expect(d.denominazione).toBe('Cooperativa')
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('nessun dato fiscale finisce nel log: solo booleani e l’uuid della sede', () => {
    datiStruttura({ denominazione: '', piva: '', codice_fiscale: 'RSSMRA80A01F839X' }, null, {
      operazione: 'x',
      scuolaId: 'sede-1',
    })
    const campi = h.logEvento.mock.calls[0][2] as Record<string, unknown>
    expect(JSON.stringify(campi)).not.toContain('RSSMRA80A01F839X')
    for (const v of Object.values(campi)) expect(['string', 'boolean']).toContain(typeof v)
  })
})

describe('CATEGORIE_ESCLUSE_ADE', () => {
  it('esclude merchandise e materiale (non sono spese di istruzione)', () => {
    expect(CATEGORIE_ESCLUSE_ADE).toContain('divisa')
    expect(CATEGORIE_ESCLUSE_ADE).toContain('materiale')
  })
})
