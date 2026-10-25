// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'

const h = vi.hoisted(() => ({ logErrore: vi.fn() }))

vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: (...a: unknown[]) => h.logErrore(...a) }
})

import { rispostaErroreInterno, rispostaErroreInternoGiaRegistrato } from '@/lib/api/errore-interno'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'

const FRASE = 'Si è verificato un errore imprevisto. Riprova fra poco.'

beforeEach(() => vi.clearAllMocks())

describe('rispostaErroreInterno — al chiamante il codice, al log l’errore intero', () => {
  it('500 con il solo codice: il messaggio dell’eccezione resta nel log', async () => {
    const err = new Error('violates unique constraint: dettaglio interno')
    const res = rispostaErroreInterno('x:POST', err)
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo).toEqual({ error: FRASE, codice: 'ERRORE_INTERNO' })
    expect(JSON.stringify(corpo)).not.toContain('dettaglio interno')
    expect(h.logErrore).toHaveBeenCalledWith({ operazione: 'x:POST', stato: 500 }, err)
  })

  it('la variante «già registrato» risponde uguale e non scrive una seconda riga', async () => {
    const res = rispostaErroreInternoGiaRegistrato()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: FRASE, codice: 'ERRORE_INTERNO' })
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('il codice è dichiarato e tradotto, e la frase italiana è quella del catalogo', () => {
    const chiave = (CODICI_ERRORE as Record<string, string>).ERRORE_INTERNO
    expect(chiave).toBe('erroreInterno')
    expect((itShared as Record<string, string>)[chiave]).toBe(FRASE)
    expect((enShared as Record<string, string>)[chiave]).toBeTruthy()
  })
})
