import { beforeEach, describe, expect, it, vi } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

/**
 * L'IMPORT DELLE DOMANDE AGGANCIA I BAMBINI DEL CRM AGLI ALUNNI, E NON FALLISCE MAI PER COLPA DEL CRM.
 *
 * Quando l'import notturno crea gli alunni di una domanda, il CRM deve saperlo: il bambino della scheda con
 * quella domanda e quel figlio si collega all'alunno, e la sua quota d'iscrizione passa in contabilità
 * (spec §5.4). Il punto di aggancio è `eseguiDomanda`, DOPO `chiudi()` — e `chiudi()` è chiamata in due
 * punti: la strada normale e quella della casella condivisa (il genitore ha già un account).
 *
 * Scenario «import intoccabile» (spec §8.5): se `agganciaDaImport` LANCIA, l'import finisce lo stesso con
 * l'esito che avrebbe avuto. È la regola del modulo pubblico (`collegamento.ts`, regola 2) applicata
 * all'import: ci sono famiglie dietro quelle domande, e un guasto del CRM non può far annullare un'iscrizione
 * a cui la password è già stata spedita.
 *
 * `eseguiDomanda` è quella VERA: il database è il finto che applica i filtri, gli inviti sono finti (nessuna
 * email), `aggancio-alunno` è un mock per leggere CHE COSA riceve. Dati di prova soltanto.
 */

const DOMANDA = 'd1d1d1d1-0000-4000-8000-000000000001'

const h = vi.hoisted(() => ({
  log: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  agganciaDaImport: vi.fn(),
  invitaGenitore: vi.fn(),
  findAuthUserIdByEmail: vi.fn(),
}))

vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...m,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.log.push({ evento, livello, campi })
    },
    logErrore: (campi: Record<string, unknown>) => {
      h.log.push({ evento: 'errore', livello: 'error', campi })
    },
  }
})
vi.mock('@/lib/crm/aggancio-alunno', () => ({ agganciaDaImport: (...a: unknown[]) => h.agganciaDaImport(...a) }))
vi.mock('@/lib/iscrizioni/import/inviti', async (orig) => {
  const m = await orig<typeof import('@/lib/iscrizioni/import/inviti')>()
  return { ...m, invitaGenitore: (...a: unknown[]) => h.invitaGenitore(...a) }
})
vi.mock('@/lib/auth/parent-identity', () => ({ findAuthUserIdByEmail: (...a: unknown[]) => h.findAuthUserIdByEmail(...a) }))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: vi.fn(async () => undefined) }))
vi.mock('@/lib/email/ritmo', () => ({ pausaFraEmail: vi.fn(async () => undefined) }))

import { eseguiDomanda } from '@/lib/iscrizioni/import/esegui'
import type { AssegnazioneBambino, Domanda } from '@/lib/iscrizioni/import/analisi'

const CLASSE = '4 ANNI A'

const domanda: Domanda = {
  id: DOMANDA,
  scuolaId: SEDE_A,
  creataIl: '2026-10-01T09:00:00Z',
  bambini: [],
  adulti: [],
}

/** Due figli: l'indice è la posizione in `data.children`, lo stesso numero di `crm_bambini.domanda_figlio`. */
const dati = {
  children: [
    { nome: 'Bimbo', cognome: 'Prova', data_nascita: '2024-03-05' },
    { nome: 'Bimba', cognome: 'Prova', data_nascita: '2023-01-02' },
  ],
  adults: [{ first_name: 'Genitore', last_name: 'Prova', email: 'genitore@example.test', ruolo: 'madre' }],
}

const assegnazioni: AssegnazioneBambino[] = [
  { indice: 0, nome: 'Bimbo', cognome: 'Prova', classe: CLASSE, retta: 150, aCaricoDi: null },
  { indice: 1, nome: 'Bimba', cognome: 'Prova', classe: CLASSE, retta: 150, aCaricoDi: null },
]

type ChiamataRpc = { nome: string; args: Riga }
let chiamateRpc: ChiamataRpc[]
let db: DBFinto
/** L'ordine in cui sono avvenute `iscrizioni_chiudi` e `agganciaDaImport`. */
let ordine: string[]

function client() {
  chiamateRpc = []
  db = {
    sections: [{ id: 's1', scuola_id: SEDE_A, name: CLASSE }],
    alunni: [],
    parents: [],
    student_parents: [],
    legame_genitori_alunni: [],
    enrollment_submissions: [{ id: DOMANDA, scuola_id: SEDE_A, consents_log: null }],
  }
  const rpc = (nome: string) => async (args: Riga) => {
    chiamateRpc.push({ nome, args })
    if (nome === 'iscrizioni_chiudi') ordine.push('chiudi')
    return { data: null, error: null }
  }
  return creaFintoSupabase(db, [], {
    rpc: {
      iscrizioni_segna_creato: rpc('iscrizioni_segna_creato'),
      iscrizioni_chiudi: rpc('iscrizioni_chiudi'),
      iscrizioni_annulla: rpc('iscrizioni_annulla'),
      iscrizioni_rinvia: rpc('iscrizioni_rinvia'),
    },
  })
}

const logCrm = () => h.log.filter((r) => r.evento === 'crm')

beforeEach(() => {
  h.log.length = 0
  ordine = []
  h.agganciaDaImport.mockReset()
  h.agganciaDaImport.mockImplementation(async () => {
    ordine.push('aggancio')
    return { esito: 'fatto', agganciati: 2 }
  })
  h.invitaGenitore.mockReset()
  h.invitaGenitore.mockResolvedValue({ tipo: 'inviata', authUserId: 'auth-1', messageId: 'm-1' })
  h.findAuthUserIdByEmail.mockReset()
  h.findAuthUserIdByEmail.mockResolvedValue('auth-gemello')
})

describe('import → CRM · l’aggancio dopo chiudi()', () => {
  it('domanda importata: chiama agganciaDaImport con { figlio: indice, alunnoId } dopo chiudi()', async () => {
    const supabase = client()
    const esito = await eseguiDomanda(supabase, domanda, dati, assegnazioni, SEDE_A)

    expect(esito.esito).toBe('inviata')
    expect(h.agganciaDaImport).toHaveBeenCalledTimes(1)
    const [passato, args] = h.agganciaDaImport.mock.calls[0] as [unknown, { domandaId: string; scuolaId: string; figli: { figlio: number; alunnoId: string }[] }]
    expect(passato).toBe(supabase)
    expect(args.domandaId).toBe(DOMANDA)
    expect(args.scuolaId).toBe(SEDE_A)

    // Gli id degli alunni sono quelli che l'import ha DAVVERO creato, uno per figlio, nell'ordine dell'indice.
    const alunni = (db.alunni as Riga[]).map((a) => ({ id: a.id as string, nome: a.nome as string }))
    expect(alunni).toHaveLength(2)
    expect(args.figli).toEqual([
      { figlio: 0, alunnoId: alunni.find((a) => a.nome === 'Bimbo')!.id },
      { figlio: 1, alunnoId: alunni.find((a) => a.nome === 'Bimba')!.id },
    ])

    // DOPO la chiusura della domanda, non prima.
    expect(ordine).toEqual(['chiudi', 'aggancio'])
  })

  it('il figlio è l’indice della domanda, non la posizione nell’elenco delle assegnazioni', async () => {
    // Una domanda con tre figli di cui l'import ne assegna soltanto due (il primo no): il numero che il CRM ha
    // salvato è la posizione in `data.children`, cioè `ass.indice`.
    await eseguiDomanda(client(), domanda, dati, [assegnazioni[1]], SEDE_A)
    const args = h.agganciaDaImport.mock.calls[0][1] as { figli: { figlio: number }[] }
    expect(args.figli.map((f) => f.figlio)).toEqual([1])
  })

  it('agganciaDaImport che lancia: l’import finisce lo stesso con esito inviata', async () => {
    h.agganciaDaImport.mockRejectedValue(new Error('il CRM è esploso'))
    const esito = await eseguiDomanda(client(), domanda, dati, assegnazioni, SEDE_A)

    expect(esito).toMatchObject({ esito: 'inviata', messageId: 'm-1', errore: null, emailSpedite: 1 })
    // La domanda è stata chiusa, e nessuna annullata: il guasto del CRM non disfa niente.
    expect(chiamateRpc.map((c) => c.nome)).toContain('iscrizioni_chiudi')
    expect(chiamateRpc.map((c) => c.nome)).not.toContain('iscrizioni_annulla')
    // Gli alunni ci sono ancora.
    expect(db.alunni as Riga[]).toHaveLength(2)
    // E il guasto lascia una riga di log a livello error (un catch che non logga è un bug).
    expect(logCrm().some((r) => r.livello === 'error' && r.campi.entita_id === DOMANDA)).toBe(true)
  })

  it('agganciaDaImport che risponde errore o non_installato: l’esito dell’import non cambia', async () => {
    for (const risposta of [{ esito: 'errore' }, { esito: 'non_installato' }]) {
      h.agganciaDaImport.mockResolvedValue(risposta)
      const esito = await eseguiDomanda(client(), domanda, dati, assegnazioni, SEDE_A)
      expect(esito).toMatchObject({ esito: 'inviata', errore: null })
    }
  })

  it('domanda fallita prima di chiudi(): agganciaDaImport non è mai chiamata', async () => {
    h.invitaGenitore.mockResolvedValue({ tipo: 'fallita', motivo: 'smtp caduto' })
    const esito = await eseguiDomanda(client(), domanda, dati, assegnazioni, SEDE_A)

    expect(esito.esito).toBe('errore')
    expect(chiamateRpc.map((c) => c.nome)).toContain('iscrizioni_annulla')
    expect(chiamateRpc.map((c) => c.nome)).not.toContain('iscrizioni_chiudi')
    expect(h.agganciaDaImport).not.toHaveBeenCalled()
  })

  it('domanda rinviata (quota email): niente aggancio, perché niente chiudi()', async () => {
    h.invitaGenitore.mockResolvedValue({ tipo: 'rinviata', motivo: 'quota esaurita' })
    const esito = await eseguiDomanda(client(), domanda, dati, assegnazioni, SEDE_A)
    expect(esito.esito).toBe('rinviata')
    expect(h.agganciaDaImport).not.toHaveBeenCalled()
  })

  it('la seconda strada: casella condivisa, la domanda si chiude e il bambino si aggancia lo stesso', async () => {
    // Il genitore ha già un account (fratelli iscritti separatamente): niente email, ma la chiudi() c'è, e
    // con lei i bambini del CRM da agganciare. È il SECONDO punto in cui `chiudi()` viene chiamata.
    h.invitaGenitore.mockResolvedValue({ tipo: 'condivisa', motivo: 'casella già di un’altra anagrafica' })
    const supabase = client()
    ;(db.parents as Riga[]).push({ id: 'gemello-1', auth_user_id: 'auth-gemello' })
    const esito = await eseguiDomanda(supabase, domanda, dati, assegnazioni, SEDE_A)

    expect(esito.esito).toBe('gia_invitata')
    expect(h.agganciaDaImport).toHaveBeenCalledTimes(1)
    expect(ordine).toEqual(['chiudi', 'aggancio'])
  })

  it('la seconda strada con il CRM che lancia: la domanda resta gia_invitata', async () => {
    h.invitaGenitore.mockResolvedValue({ tipo: 'condivisa', motivo: 'casella già di un’altra anagrafica' })
    h.agganciaDaImport.mockRejectedValue(new Error('il CRM è esploso'))
    const supabase = client()
    ;(db.parents as Riga[]).push({ id: 'gemello-1', auth_user_id: 'auth-gemello' })
    const esito = await eseguiDomanda(supabase, domanda, dati, assegnazioni, SEDE_A)
    expect(esito).toMatchObject({ esito: 'gia_invitata', errore: null })
  })

  it('il gia_invitata sulla strada normale (registro già preso) aggancia comunque: gli alunni esistono', async () => {
    h.invitaGenitore.mockResolvedValue({ tipo: 'gia_invitata', authUserId: 'auth-1' })
    const esito = await eseguiDomanda(client(), domanda, dati, assegnazioni, SEDE_A)
    expect(esito.esito).toBe('gia_invitata')
    expect(h.agganciaDaImport).toHaveBeenCalledTimes(1)
  })

  it('nei log del guasto non finisce nessun dato personale', async () => {
    h.agganciaDaImport.mockRejectedValue(new Error('il CRM è esploso'))
    await eseguiDomanda(client(), domanda, dati, assegnazioni, SEDE_A)
    const testo = JSON.stringify(h.log.filter((r) => r.evento === 'crm'))
    for (const dato of ['Bimbo', 'Bimba', 'Prova', 'genitore@example.test', '2024-03-05']) {
      expect(testo, `«${dato}» è finito in un log del CRM`).not.toContain(dato)
    }
  })
})
