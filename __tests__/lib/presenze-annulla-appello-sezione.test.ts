/**
 * `annullaAppelloAlunno` — l'estensione per la primaria (compito A3).
 *
 * Due cose aggiunte alla libreria per la rotta `DELETE /api/primaria/appello`:
 *  · `sectionId` facoltativo: la primaria verifica lo scope sulla CLASSE, quindi la
 *    riga si cerca anche per `section_id`. Senza, la rotta dello 0-6 resta com'era
 *    (nessun filtro di sezione: lì lo scope è l'alunno);
 *  · `scuolaId` negli esiti riusciti: la sede della riga letta, che la primaria
 *    passa all'avviso al docente titolare invece di indovinarla dall'utente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn() }))

import { annullaAppelloAlunno } from '@/lib/presenze/annulla-appello'
import type { AppUser } from '@/lib/auth/require-staff'

const DOCENTE = 'd0000000-0000-4000-8000-0000000000d1'
const GENITORE = 'e0000000-0000-4000-8000-0000000000e1'
const ALUNNO = '11111111-1111-4111-8111-111111111111'
const SEDE = 'aaaa0000-0000-4000-8000-00000000a002'
const SEZIONE = 'bbbb0000-0000-4000-8000-00000000b001'
const ALTRA_SEZIONE = 'bbbb0000-0000-4000-8000-00000000b002'
const PRESENZA = 'cccc0000-0000-4000-8000-00000000c001'
const GIORNO = '2026-09-25'

const attore = { id: DOCENTE, role: 'educator', scuola_id: 'aaaa0000-0000-4000-8000-00000000a001' } as unknown as AppUser

let rigaLetta: Record<string, unknown> | null
let letture: unknown[][][]

function finto() {
  return {
    from(tabella: string) {
      const filtri: unknown[][] = []
      let verbo = 'select'
      let payload: Record<string, unknown> = {}
      if (tabella === 'presenze') letture.push(filtri)
      const qb: Record<string, unknown> = {
        select: () => qb,
        update: (p: Record<string, unknown>) => { verbo = 'update'; payload = p; return qb },
        delete: () => { verbo = 'delete'; return qb },
        eq: (...a: unknown[]) => { filtri.push(['eq', ...a]); return qb },
        is: (...a: unknown[]) => { filtri.push(['is', ...a]); return qb },
        not: (...a: unknown[]) => { filtri.push(['not', ...a]); return qb },
        maybeSingle: async () => {
          const s = filtri.find((f) => f[0] === 'eq' && f[1] === 'section_id')
          if (s && rigaLetta && s[2] !== rigaLetta.section_id) return { data: null, error: null }
          return { data: rigaLetta, error: null }
        },
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(
            tabella === 'notifiche' || verbo === 'select'
              ? { data: null, error: null }
              : { data: [{ ...(rigaLetta ?? {}), ...payload }], error: null },
          ).then(res),
      }
      return qb
    },
  }
}

const riga = (extra: Record<string, unknown> = {}) => ({
  id: PRESENZA,
  alunno_id: ALUNNO,
  data: GIORNO,
  stato: 'presente',
  orario_entrata: null,
  orario_uscita: null,
  registrato_da: DOCENTE,
  giustificata_da: null,
  scuola_id: SEDE,
  section_id: SEZIONE,
  ...extra,
})

beforeEach(() => {
  rigaLetta = riga()
  letture = []
})

describe('sectionId facoltativo', () => {
  it('senza sectionId la lettura NON filtra per sezione (la rotta 0-6 resta com\'era)', async () => {
    await annullaAppelloAlunno(finto() as never, { alunnoId: ALUNNO, data: GIORNO, attore })
    expect(letture[0].some((f) => f[1] === 'section_id')).toBe(false)
  })

  it('con sectionId la lettura filtra per quella sezione', async () => {
    const r = await annullaAppelloAlunno(finto() as never, { alunnoId: ALUNNO, data: GIORNO, attore, sectionId: SEZIONE })
    expect(letture[0]).toEqual(expect.arrayContaining([
      ['eq', 'alunno_id', ALUNNO],
      ['eq', 'data', GIORNO],
      ['eq', 'section_id', SEZIONE],
    ]))
    expect(r.esito).toBe('cancellata')
  })

  it('riga registrata in un\'altra sezione → `non-trovata`, niente scritto', async () => {
    rigaLetta = riga({ section_id: ALTRA_SEZIONE })
    const r = await annullaAppelloAlunno(finto() as never, { alunnoId: ALUNNO, data: GIORNO, attore, sectionId: SEZIONE })
    expect(r).toEqual({ esito: 'non-trovata' })
    expect(letture).toHaveLength(1)
  })
})

describe('scuolaId negli esiti riusciti è la sede della RIGA, non dell\'attore', () => {
  it.each([
    ['cancellata', riga()],
    ['ripristinata-comunicazione', riga({ giustificata_da: GENITORE })],
  ])('%s', async (esito, r) => {
    rigaLetta = r
    const out = await annullaAppelloAlunno(finto() as never, { alunnoId: ALUNNO, data: GIORNO, attore, sectionId: SEZIONE })
    expect(out).toMatchObject({ esito, scuolaId: SEDE })
  })
})
