import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEDE_A } from '../../fixtures/sedi'
import { CrmShell } from '@/components/features/crm/CrmShell'
import { TAB_CRM, tabDaParametro } from '@/lib/crm/tab'
import {
  ANNI_INGRESSO,
  ESITI_AZIONE,
  ESITI_BAMBINO,
  MOTIVI_INDISPONIBILITA,
  MOTIVI_PERDITA,
  ORIGINI,
  STATI_APPUNTAMENTO,
  TIPI_AZIONE,
  TIPI_EVENTO,
} from '@/lib/crm/tipi'

/**
 * CRM della segreteria · Compito 1.6 — la cornice: cinque schede guidate da `?tab=` e le etichette
 * di TUTTI i vocabolari in italiano e in inglese.
 *
 * Qui girano i segnaposto VERI (`data-crm-segnaposto`): il test misura che la cornice monti la
 * schermata giusta e le passi la sede. Il comportamento del pannello di dettaglio, che ha bisogno
 * di schermate che chiamino `onApri`, sta in `crm-shell-dettaglio.test.tsx`.
 */

const h = vi.hoisted(() => ({ query: '' }))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => '/admin/crm',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

// `StatisticheCrm` non è più un segnaposto (sessione 6): chiama il server. La cornice si misura con un
// segnaposto al suo posto; la schermata vera ha il suo test (`statistiche.test.tsx`).
vi.mock('@/components/features/crm/statistiche/StatisticheCrm', async () => {
  const { Segnaposto } = await import('@/components/features/crm/Segnaposto')
  return {
    StatisticheCrm: ({ scuolaId }: { scuolaId: string }) => (
      <Segnaposto nome="StatisticheCrm" dati={{ 'scuola-id': scuolaId }} />
    ),
  }
})

// Sessione 5: «Da richiamare» non è più un segnaposto, ha la sua schermata vera (e il suo test,
// `follow-up.test.tsx`). Qui si misura la CORNICE: quale schermata monta e con quale sede. Un finto che
// rende il segnaposto tiene vere le asserzioni su `data-crm-segnaposto` senza far partire la rete.
vi.mock('@/components/features/crm/follow-up/DaRichiamare', async () => {
  const { Segnaposto } = await import('@/components/features/crm/Segnaposto')
  return {
    DaRichiamare: ({ scuolaId }: { scuolaId: string }) => (
      <Segnaposto nome="DaRichiamare" dati={{ 'scuola-id': scuolaId }} />
    ),
  }
})

/** Quale segnaposto sta a schermo per ciascuna linguetta. */
const SEGNAPOSTO_DI: Record<(typeof TAB_CRM)[number], string> = {
  agenda: 'AgendaSettimana',
  richiamare: 'DaRichiamare',
  schede: 'ElencoSchede',
  disponibilita: 'DisponibilitaPersona',
  statistiche: 'StatisticheCrm',
}

const montati = () =>
  Array.from(document.querySelectorAll('[data-crm-segnaposto]')).map((e) => e.getAttribute('data-crm-segnaposto'))

beforeEach(() => {
  h.query = ''
  window.history.replaceState(null, '', '/admin/crm')
})

describe('CrmShell · la linguetta aperta la decide ?tab=', () => {
  it.each(TAB_CRM)('apre la scheda indicata da ?tab=%s', (tab) => {
    h.query = `tab=${tab}`
    render(<CrmShell scuolaId={SEDE_A} />)
    // UNA sola schermata, e quella giusta: un `getByText` qui pescherebbe i sosia.
    expect(montati()).toEqual([SEGNAPOSTO_DI[tab]])
  })

  it.each([
    ['nessun tab', ''],
    ['un tab inventato', 'tab=contabilita'],
    ['un tab vuoto', 'tab='],
    ['un tab con le maiuscole sbagliate', 'tab=Agenda'],
  ])('con %s si apre l’agenda', (_nome, query) => {
    h.query = query
    render(<CrmShell scuolaId={SEDE_A} />)
    expect(montati()).toEqual(['AgendaSettimana'])
  })

  it('tabDaParametro ripiega sull’agenda per tutto ciò che non è una delle cinque', () => {
    expect(tabDaParametro(null)).toBe('agenda')
    expect(tabDaParametro(undefined)).toBe('agenda')
    expect(tabDaParametro('')).toBe('agenda')
    expect(tabDaParametro('__proto__')).toBe('agenda')
    expect(tabDaParametro('toString')).toBe('agenda')
    for (const t of TAB_CRM) expect(tabDaParametro(t)).toBe(t)
  })

  it('le cinque linguette ci sono tutte, con il loro nome in italiano', () => {
    render(<CrmShell scuolaId={SEDE_A} />)
    for (const nome of ['Agenda', 'Da richiamare', 'Schede', 'Disponibilità', 'Statistiche']) {
      expect(screen.getByRole('button', { name: nome })).toBeTruthy()
    }
    // La linguetta attiva è dichiarata a chi non vede il colore.
    expect(screen.getByRole('button', { name: 'Agenda' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Schede' }).getAttribute('aria-pressed')).toBe('false')
  })
})

describe('CrmShell · la sede arriva a OGNI schermata', () => {
  it.each(TAB_CRM)('la linguetta %s riceve la sede dichiarata dalla pagina', (tab) => {
    h.query = `tab=${tab}`
    render(<CrmShell scuolaId={SEDE_A} />)
    const schermata = document.querySelector(`[data-crm-segnaposto="${SEGNAPOSTO_DI[tab]}"]`)
    expect(schermata?.getAttribute('data-scuola-id')).toBe(SEDE_A)
  })
})

describe('CrmShell · cambiare linguetta', () => {
  it('mostra la schermata scelta e riscrive l’indirizzo con il solo ?tab=', () => {
    window.history.replaceState(null, '', '/admin/crm?tab=agenda&esito=perso&q=prova')
    render(<CrmShell scuolaId={SEDE_A} />)

    fireEvent.click(screen.getByRole('button', { name: 'Statistiche' }))

    expect(montati()).toEqual(['StatisticheCrm'])
    // I filtri dell’elenco, su un’altra schermata, sarebbero rumore: restano solo `tab`.
    expect(window.location.pathname + window.location.search).toBe('/admin/crm?tab=statistiche')
    expect(screen.getByRole('button', { name: 'Statistiche' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Agenda' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('un clic sulla linguetta già aperta non tocca l’indirizzo', () => {
    window.history.replaceState(null, '', '/admin/crm?tab=schede&esito=perso')
    h.query = 'tab=schede&esito=perso'
    render(<CrmShell scuolaId={SEDE_A} />)

    fireEvent.click(screen.getByRole('button', { name: 'Schede' }))

    expect(window.location.search).toBe('?tab=schede&esito=perso')
  })

  it('se l’indirizzo cambia da fuori, la cornice lo segue', () => {
    h.query = 'tab=agenda'
    const { rerender } = render(<CrmShell scuolaId={SEDE_A} />)
    expect(montati()).toEqual(['AgendaSettimana'])

    h.query = 'tab=richiamare'
    rerender(<CrmShell scuolaId={SEDE_A} />)

    expect(montati()).toEqual(['DaRichiamare'])
  })
})

// ─── LE ETICHETTE DEI VOCABOLARI ────────────────────────────────────────────────
//
// I cataloghi si leggono dal disco e non da `useTranslations`: il mock globale di next-intl
// (`test/setup.ts`) risolve solo le chiavi di PRIMO livello, quindi `t('esiti.aperto')` finirebbe a
// schermo come `crmShell.esiti.aperto` e un test su di esso sarebbe verde su qualunque catalogo.

const LINGUE = ['it', 'en'] as const

/** Gruppo del catalogo → il vocabolario di `src/lib/crm/tipi.ts` di cui porta le etichette. */
const GRUPPI: Record<string, readonly string[]> = {
  esiti: ESITI_BAMBINO,
  origini: ORIGINI,
  motiviPerdita: MOTIVI_PERDITA,
  anniIngresso: ANNI_INGRESSO,
  statiAppuntamento: STATI_APPUNTAMENTO,
  tipiAzione: TIPI_AZIONE,
  esitiAzione: ESITI_AZIONE,
  motiviIndisponibilita: MOTIVI_INDISPONIBILITA,
  tipiEvento: TIPI_EVENTO,
}

const catalogo = (lingua: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(process.cwd(), `messages/${lingua}/crmShell.json`), 'utf8'))

describe('crmShell · ogni valore dei vocabolari ha un’etichetta in it e in en', () => {
  it('ogni valore dei vocabolari ha un’etichetta in it e in en', () => {
    const mancanti: string[] = []
    let controllate = 0
    for (const lingua of LINGUE) {
      const cat = catalogo(lingua)
      for (const [gruppo, valori] of Object.entries(GRUPPI)) {
        const etichette = cat[gruppo] as Record<string, unknown> | undefined
        for (const valore of valori) {
          controllate++
          const e = etichette?.[valore]
          if (typeof e !== 'string' || e.trim() === '') mancanti.push(`${lingua}: ${gruppo}.${valore}`)
        }
      }
    }
    expect(mancanti, 'Valori di un vocabolario senza etichetta nel catalogo crmShell').toEqual([])
    // Se i vocabolari si svuotassero, il ciclo non controllerebbe niente e il test resterebbe verde.
    const attese = Object.values(GRUPPI).reduce((n, v) => n + v.length, 0) * LINGUE.length
    expect(controllate).toBe(attese)
    expect(controllate).toBeGreaterThan(100)
  })

  it('nessuna etichetta è rimasta senza un valore: i gruppi dicono esattamente i valori del vocabolario', () => {
    const orfane: string[] = []
    for (const lingua of LINGUE) {
      const cat = catalogo(lingua)
      for (const [gruppo, valori] of Object.entries(GRUPPI)) {
        const etichette = Object.keys((cat[gruppo] as Record<string, unknown>) ?? {})
        for (const chiave of etichette) {
          if (!valori.includes(chiave)) orfane.push(`${lingua}: ${gruppo}.${chiave}`)
        }
      }
    }
    expect(orfane, 'Etichette di un valore che il vocabolario non conosce più').toEqual([])
  })

  it('un’etichetta non è il valore grezzo del database (`lista_attesa`, `follow_up_1`…)', () => {
    const grezze: string[] = []
    for (const lingua of LINGUE) {
      const cat = catalogo(lingua)
      for (const [gruppo, valori] of Object.entries(GRUPPI)) {
        const etichette = cat[gruppo] as Record<string, string>
        for (const valore of valori) {
          if (valore.includes('_') && etichette[valore]?.toLowerCase() === valore) grezze.push(`${lingua}: ${gruppo}.${valore}`)
          if (etichette[valore]?.includes('_')) grezze.push(`${lingua}: ${gruppo}.${valore} contiene un trattino basso`)
        }
      }
    }
    expect(grezze).toEqual([])
  })
})

describe('crmShell · i sei namespace sono montati', () => {
  const NAMESPACE = ['crmShell', 'crmSchede', 'crmAgenda', 'crmCollegamento', 'crmFollowUp', 'crmStatistiche']
  const request = readFileSync(join(process.cwd(), 'src/i18n/request.ts'), 'utf8')

  it.each(NAMESPACE)('%s è registrato in src/i18n/request.ts e ha un file per lingua', (ns) => {
    expect(request).toContain(`${ns}: (await import(\`../../messages/\${locale}/${ns}.json\`)).default`)
    for (const lingua of LINGUE) {
      const file = readFileSync(join(process.cwd(), `messages/${lingua}/${ns}.json`), 'utf8')
      expect(typeof JSON.parse(file)).toBe('object')
    }
  })

  // Un namespace riempito dalla sua sessione esce da questo elenco (e dal controllo qui sotto), con la ragione:
  //  · Sessione 5: crmFollowUp → le chiavi sono usate da `follow-up/*`, il test `follow-up.test.tsx` le legge a schermo
  //  · Sessione 6: crmStatistiche → ha i suoi test in `statistiche.test.tsx`
  const RIEMPITI = ['crmFollowUp', 'crmStatistiche']

  it('i namespace non ancora riempiti nascono vuoti: li riempie la sessione che ne ha la schermata', () => {
    for (const lingua of LINGUE) {
      for (const ns of NAMESPACE.filter((n) => n !== 'crmShell' && !RIEMPITI.includes(n))) {
        const file = JSON.parse(readFileSync(join(process.cwd(), `messages/${lingua}/${ns}.json`), 'utf8'))
        expect(Object.keys(file)).toEqual([])
      }
    }
    cleanup()
  })
})
