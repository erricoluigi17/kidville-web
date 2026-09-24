// @vitest-environment node
/**
 * D5 (consegna 2b della coda fatture Aruba) nel MOTORE UNICO: una riga il cui pagamento ha una voce ATTIVA in
 * `fatture_coda` (in coda, in invio, in errore) non è più «da fatturare» nella lista di lavoro — niente sottofiltro
 * `?fattura=da_fatturare`, niente pillola, niente casella del lotto — ma il CHIP non cambia: la fattura resta da fare
 * finché la coda non l'ha emessa.
 *
 * Che `STATI_ATTIVI` di `fatture-coda/api.ts` sia lo STESSO elenco (non una copia) lo prova il test di `api.ts`
 * (`toBe`): questo file non importa niente da lì.
 */
import { describe, expect, it } from 'vitest'
import {
  STATI_CODA_OCCUPATA,
  azioneConCoda,
  daFatturareInListaDiLavoro,
  esitoFatturazione,
  fatturaDaFare,
  inCodaAttiva,
  type RigaListaDiLavoro,
} from '@/lib/pagamenti/fatturazione-riga'

const BASE: RigaListaDiLavoro = {
  stato: 'confermato',
  pagamento_id: 'p1',
  pagamento_stato: 'pagato',
  fattura_stato: 'non_richiesta',
  fattura: { stato: 'da_fatturare', numeri: [] },
}

/** Una riga con `coda_stato` qualunque: il tipo lo restringe, il dato che arriva dal JSON no. */
function conCoda(codaStato: unknown, base: RigaListaDiLavoro = BASE): RigaListaDiLavoro {
  return { ...base, coda_stato: codaStato } as RigaListaDiLavoro
}

describe('STATI_CODA_OCCUPATA — l’unico elenco degli stati che occupano il pagamento', () => {
  it('è esattamente in_coda, in_invio, errore', () => {
    expect([...STATI_CODA_OCCUPATA].sort()).toEqual(['errore', 'in_coda', 'in_invio'])
  })
})

describe('daFatturareInListaDiLavoro con la coda (D5)', () => {
  it('controllo positivo: la riga di base, senza voce, è da fatturare', () => {
    expect(daFatturareInListaDiLavoro(BASE)).toBe(true)
  })

  it.each(['in_coda', 'in_invio', 'errore'])('con una voce %s NON è da fatturare', (s) => {
    expect(daFatturareInListaDiLavoro(conCoda(s))).toBe(false)
  })

  it.each([
    ['null', null],
    ['assente', undefined],
    ['tolta', 'tolta'],
    ['emessa', 'emessa'],
  ])('con coda_stato %s resta da fatturare (elenco esplicito, non `!= null`)', (_n, s) => {
    const r = s === undefined ? { ...BASE } : conCoda(s)
    if (s === undefined) expect('coda_stato' in r).toBe(false)
    expect(daFatturareInListaDiLavoro(r)).toBe(true)
  })

  it('una scartata dai documenti: da rifare senza voce, fuori dalla lista con una voce in coda', () => {
    const scartata: RigaListaDiLavoro = { ...BASE, fattura_stato: 'emessa', fattura: { stato: 'scartata', numeri: [] } }
    expect(daFatturareInListaDiLavoro(scartata)).toBe(true)
    expect(daFatturareInListaDiLavoro(conCoda('in_coda', scartata))).toBe(false)
  })
})

describe('il CHIP non cambia con la coda attiva (D5 tocca la lista di lavoro, non il chip)', () => {
  it.each(['in_coda', 'in_invio', 'errore'])('con %s: esitoFatturazione e fatturaDaFare come senza voce', (s) => {
    const r = conCoda(s)
    expect(esitoFatturazione(r)).toEqual({ tono: 'da_fatturare', fonte: 'riassunto', numeri: [] })
    expect(esitoFatturazione(r)).toEqual(esitoFatturazione(BASE))
    expect(fatturaDaFare(r)).toBe(true)
  })
})

describe('inCodaAttiva', () => {
  it.each([
    ['in_coda', true],
    ['in_invio', true],
    ['errore', true],
    ['tolta', false],
    ['emessa', false],
    [null, false],
    [undefined, false],
    ['', false],
    [1, false],
  ])('%s → %s', (s, atteso) => {
    expect(inCodaAttiva(s)).toBe(atteso)
  })
})

describe('azioneConCoda — che cosa offre il posto del pulsante della fattura', () => {
  it.each([
    [undefined, 'invia'],
    [null, 'invia'],
    ['tolta', 'invia'],
    ['emessa', 'invia'],
    ['in_coda', 'nessuna'],
    ['in_invio', 'nessuna'],
    ['errore', 'vai_alla_coda'],
  ])('%s → %s', (s, atteso) => {
    expect(azioneConCoda(s)).toBe(atteso)
  })
})
