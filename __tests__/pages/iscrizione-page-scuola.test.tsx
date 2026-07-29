// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'

/**
 * `/iscrizione` legge `?scuola=` e lo passa al wizard. Il caso che conta è il
 * PARAMETRO ASSENTE: è il link che la segreteria diffonde a tutti e tre i plessi,
 * e deve arrivare al wizard come "sede non decisa" (null), non come `undefined`
 * ambiguo né come stringa vuota.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}))
vi.mock('@/components/features/public/EnrollmentWizard', () => ({
  EnrollmentWizard: () => null,
}))

import IscrizionePage from '@/app/iscrizione/page'

async function scuolaIdPassato(sp: { scuola?: string }): Promise<unknown> {
  const el = (await IscrizionePage({ searchParams: Promise.resolve(sp) })) as ReactElement<{
    scuolaId?: string | null
  }>
  return el.props.scuolaId
}

describe('/iscrizione — passaggio di ?scuola= al wizard', () => {
  it('parametro ASSENTE → null (il wizard chiederà la sede se ce n\'è più d\'una)', async () => {
    await expect(scuolaIdPassato({})).resolves.toBeNull()
  })

  it('parametro valorizzato → passa invariato (scorciatoia che salta il passo sede)', async () => {
    await expect(scuolaIdPassato({ scuola: 'd53b0fbc-a9eb-4073-b302-73d1d5abd529' }))
      .resolves.toBe('d53b0fbc-a9eb-4073-b302-73d1d5abd529')
  })

  it('parametro VUOTO o di soli spazi → null, non stringa vuota', async () => {
    await expect(scuolaIdPassato({ scuola: '' })).resolves.toBeNull()
    await expect(scuolaIdPassato({ scuola: '   ' })).resolves.toBeNull()
  })
})
