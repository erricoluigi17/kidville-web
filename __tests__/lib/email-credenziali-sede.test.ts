import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// W4-A / R90 — «Kidville» non è più il nome di una scuola: è il nome di tre.
//
// L'email che porta le credenziali al genitore dice «la tua iscrizione a
// Kidville è stata registrata». Con una sede sola era una frase completa; con
// Giugliano, Aversa e Cesa il genitore non sa a quale plesso si stia iscrivendo
// suo figlio, e non ha modo di accorgersi se lo hanno registrato nella sede
// sbagliata — che è esattamente ciò che il resto di questo audit sta
// correggendo lato server.
//
// Il nome della sede NON si indovina: lo passa chi manda l'email, dopo averlo
// risolto dai figli del genitore. Se non è risolvibile, la frase resta quella
// generica — meglio vaga che falsa.
// =============================================================================

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})

import { credentialsEmailBody } from '@/lib/email/send'
import { nomeSede } from '@/lib/scuole/reali'

beforeEach(() => vi.clearAllMocks())

describe('credentialsEmailBody — la sede compare nel corpo', () => {
  it('con la sede: la frase la nomina, e la firma anche', () => {
    const testo = credentialsEmailBody('Maria', 'mamma@example.test', 'Segreta.2026!', NOME_SEDE_A)
    expect(testo).toContain(`iscrizione a ${NOME_SEDE_A}`)
    expect(testo).toContain(`Lo staff di ${NOME_SEDE_A}`)
    // Ciò che serviva prima serve ancora.
    expect(testo).toContain('mamma@example.test')
    expect(testo).toContain('Segreta.2026!')
  })

  it('senza la sede: nessuna sede inventata, la frase resta quella generica', () => {
    for (const senza of [undefined, null, '', '   ']) {
      const testo = credentialsEmailBody('Maria', 'mamma@example.test', 'x', senza)
      expect(testo).toContain('iscrizione a Kidville è stata registrata')
      expect(testo).toContain('Lo staff Kidville')
    }
  })

  it('due sedi diverse ⇒ due corpi diversi (è il punto di tutto)', () => {
    const a = credentialsEmailBody('Maria', 'm@example.test', 'x', NOME_SEDE_A)
    const b = credentialsEmailBody('Maria', 'm@example.test', 'x', NOME_SEDE_B)
    expect(a).not.toEqual(b)
    expect(a).not.toContain(NOME_SEDE_B)
    expect(b).not.toContain(NOME_SEDE_A)
  })
})

describe('nomeSede — il nome si legge, non si deduce', () => {
  const db = (): DBFinto => ({
    schools: [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
    ],
  })

  it('legge il nome della sede richiesta e SOLO di quella', async () => {
    const d = db()
    const tabelle: string[] = []
    expect(await nomeSede(creaFintoSupabase(d, tabelle), SEDE_B, 'test')).toBe(NOME_SEDE_B)
    expect(tabelle).toEqual(['schools'])
  })

  it('sede nulla o sconosciuta ⇒ null, senza chiedere niente al database', async () => {
    const tabelle: string[] = []
    expect(await nomeSede(creaFintoSupabase(db(), tabelle), null, 'test')).toBeNull()
    expect(tabelle).toEqual([])
    expect(await nomeSede(creaFintoSupabase(db(), tabelle), 'sede-che-non-esiste', 'test')).toBeNull()
  })

  it('lettura in errore ⇒ null E una riga di log: un catch muto è un bug', async () => {
    const client = creaFintoSupabase(db(), [], {
      errori: { schools: { code: '08006', message: 'connection failure' } },
    })
    expect(await nomeSede(client, SEDE_A, 'test')).toBeNull()
    expect(h.logEvento).toHaveBeenCalledWith(
      'multi_sede',
      'info',
      expect.objectContaining({ operazione: 'test', esito: 'nome-sede-non-letto' }),
      expect.anything(),
    )
  })
})
