import { describe, it, expect } from 'vitest'
import it_ from '../../../../messages/it/shared.json'
import en_ from '../../../../messages/en/shared.json'

/**
 * Scelta del titolare (10/11/2026): l'assistente non propone la classe, può dire le fasce d'età;
 * la classe la propone la segreteria durante la visita. I testi dell'assistente parlano di
 * «fascia d'età» o «servizio», mai di «classe».
 */
describe('CRM AI · i testi non parlano di classe', () => {
  const tutte = (m: Record<string, string>) =>
    Object.entries(m).filter(([k]) => k.startsWith('erroreCrmAi'))

  it('italiano: nessun messaggio dell’assistente nomina la classe', () => {
    const elenco = tutte(it_ as Record<string, string>)
    expect(elenco.length).toBeGreaterThan(5)
    for (const [k, v] of elenco) expect(v, k).not.toMatch(/class[ei]/i)
  })

  it('inglese: nessun messaggio dell’assistente nomina la class', () => {
    for (const [k, v] of tutte(en_ as Record<string, string>)) expect(v, k).not.toMatch(/\bclass(es)?\b/i)
  })

  it('ETA_NON_COPERTA parla di fascia d’età o servizio in entrambe le lingue', () => {
    expect((it_ as Record<string, string>).erroreCrmAiEtaNonCoperta).toMatch(/fascia d.età|servizio/i)
    expect((en_ as Record<string, string>).erroreCrmAiEtaNonCoperta).toMatch(/age (group|range)|service/i)
  })
})
