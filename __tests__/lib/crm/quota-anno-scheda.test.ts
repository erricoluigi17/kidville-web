import { describe, expect, it } from 'vitest'
import type { RigaCalendario } from '@/lib/anno-scolastico'
import { annoDellaQuota, annoDellaScheda, annoIngressoDaAnno } from '@/lib/crm/quota-anno'
import * as quota from '@/lib/crm/quota'

/**
 * COMPITO 4.5.9 · L'anno della quota segue l'anno della SCHEDA (`anno_id`), non «oggi».
 *
 * Funzioni pure. `annoDellaQuota` (l'etichetta relativa + l'anno in corso di oggi) resta per le schede vecchie; `annoDellaScheda` dà
 * l'`anno_inizio` dell'anno che la scheda dichiara, cercandolo fra gli anni della sua sede.
 */

const riga = (annoId: string, annoInizio: number, stato: RigaCalendario['stato']): RigaCalendario => ({
  annoId, annoSedeId: `sede-${annoInizio}`, annoInizio,
  inizio: `${annoInizio}-09-01`, fine: `${annoInizio + 1}-08-31`,
  ultimoGiornoAperto: `${annoInizio + 1}-07-31`, preparaSuccessivoDal: `${annoInizio}-09-01`,
  stato, domandeAperte: false,
})
const A2526 = 'a1111111-1111-4111-8111-111111111111'
const A2627 = 'a2222222-2222-4222-8222-222222222222'
const A2728 = 'a3333333-3333-4333-8333-333333333333'
const CAL = [riga(A2526, 2025, 'chiuso'), riga(A2627, 2026, 'corrente'), riga(A2728, 2027, 'in_preparazione')]

describe('annoDellaScheda', () => {
  it('dà l’anno d’apertura dell’anno che la scheda dichiara, qualunque sia il giorno di oggi', () => {
    expect(annoDellaScheda(A2728, CAL)).toBe(2027)
    expect(annoDellaScheda(A2627, CAL)).toBe(2026)
  })

  it('un anno che la sede non ha, o nessun anno, non dà niente: si ricade sul vecchio calcolo', () => {
    expect(annoDellaScheda('a9999999-9999-4999-8999-999999999999', CAL)).toBeNull()
    expect(annoDellaScheda(null, CAL)).toBeNull()
    expect(annoDellaScheda(undefined, CAL)).toBeNull()
    expect(annoDellaScheda(A2728, null)).toBeNull()
    expect(annoDellaScheda(A2728, [])).toBeNull()
  })

  it('confronta gli uuid senza badare alle maiuscole', () => {
    expect(annoDellaScheda(A2728.toUpperCase(), CAL)).toBe(2027)
  })

  it('l’etichetta relativa resta com’è: le schede vecchie vanno come oggi', () => {
    expect(annoDellaQuota('in_corso', 2026)).toBe(2026)
    expect(annoDellaQuota('prossimo', 2026)).toBe(2027)
    expect(annoDellaQuota('non_indicato', 2026)).toBeNull()
  })

  it('`quota.ts` ripubblica le stesse funzioni (le route le importano da lì)', () => {
    expect(quota.annoDellaScheda).toBe(annoDellaScheda)
    expect(quota.annoDellaQuota).toBe(annoDellaQuota)
  })
})

describe('annoIngressoDaAnno: l’etichetta che resta coerente con l’anno scelto', () => {
  it('l’anno attivo è «in corso», quello dopo «prossimo»', () => {
    expect(annoIngressoDaAnno(CAL[1], CAL)).toBe('in_corso')
    expect(annoIngressoDaAnno(CAL[2], CAL)).toBe('prossimo')
  })

  it('un anno ancora aperto prima dell’attivo (in chiusura) è «in corso»', () => {
    const cal = [riga(A2526, 2025, 'in_chiusura'), riga(A2627, 2026, 'corrente')]
    expect(annoIngressoDaAnno(cal[0], cal)).toBe('in_corso')
  })

  it('in agosto, senza anno `corrente`, l’anno in chiusura è l’attivo e il nuovo è «prossimo»', () => {
    const cal = [riga(A2526, 2025, 'in_chiusura'), riga(A2627, 2026, 'in_preparazione')]
    expect(annoIngressoDaAnno(cal[0], cal)).toBe('in_corso')
    expect(annoIngressoDaAnno(cal[1], cal)).toBe('prossimo')
  })

  it('senza un anno attivo, un anno in preparazione o con le iscrizioni aperte è «prossimo»', () => {
    const cal = [riga(A2728, 2027, 'iscrizioni_aperte')]
    expect(annoIngressoDaAnno(cal[0], cal)).toBe('prossimo')
  })
})
