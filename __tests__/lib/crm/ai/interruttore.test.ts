import { afterEach, describe, expect, it, vi } from 'vitest'
import { crmAiAttivo, sedeAmmessaAi, sediAmmesseAi } from '@/lib/crm/ai/interruttore'
import { SEDE_A, SEDE_B, SEDE_C } from '../../../fixtures/sedi'

afterEach(() => vi.unstubAllEnvs())

describe('interruttore dell’accesso AI', () => {
  it.each([undefined, '', 'true', 'on', 'yes', '0', ' 1', '1 '])('è spento con %s', (valore) => {
    vi.stubEnv('CRM_AI_ATTIVO', valore)
    expect(crmAiAttivo()).toBe(false)
  })

  it('è acceso solo con «1»', () => {
    vi.stubEnv('CRM_AI_ATTIVO', '1')
    expect(crmAiAttivo()).toBe(true)
  })

  it.each([undefined, '', ' , , ', 'qualsiasi'])('senza UUID validi nessuna sede è ammessa (%s)', (valore) => {
    vi.stubEnv('CRM_AI_SEDI_AMMESSE', valore)
    expect(sediAmmesseAi()).toEqual([])
    expect(sedeAmmessaAi(SEDE_A)).toBe(false)
  })

  it('ammette solo gli UUID dell’elenco, senza doppioni e senza badare a spazi e maiuscole', () => {
    vi.stubEnv('CRM_AI_SEDI_AMMESSE', ` ${SEDE_A.toUpperCase()}, ,errata,${SEDE_B},${SEDE_A} `)
    expect(sediAmmesseAi()).toEqual([SEDE_A, SEDE_B])
    expect(sedeAmmessaAi(` ${SEDE_A.toUpperCase()} `)).toBe(true)
    expect(sedeAmmessaAi(SEDE_B)).toBe(true)
    expect(sedeAmmessaAi(SEDE_C)).toBe(false)
    expect(sedeAmmessaAi('errata')).toBe(false)
  })
})
