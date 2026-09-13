import { describe, it, expect } from 'vitest'
import { fatturaViva, etichettaFattura, type RigaFatturaEmessa } from '@/lib/pagamenti/fattura-viva'
import { mapStatoAruba } from '@/lib/aruba/stato'

/**
 * «QUESTO DOCUMENTO È ANCORA VIVO?» — IN UN POSTO SOLO.
 *
 * Il predicato nasce qui perché due strade diverse devono fermare lo stesso
 * riabbinamento: `pagamenti/riconciliazione/[id]:PATCH` (la conferma a voce
 * singola) e `pagamenti/riconciliazione/[id]/componi:POST` (la composizione).
 * Sono DUE PORTE sullo stesso stato «movimento riaperto», e due definizioni di
 * «viva» direbbero due cose diverse dello stesso documento: una fermerebbe e
 * l'altra lascerebbe passare, con un 200 sopra.
 *
 * 🔑 E DAL 2026-09-13 I CHIAMANTI SONO CINQUE, non due: oltre alle porte ci sono
 * il chip «fatturata» del registro (`pagamenti/riconciliazione:GET`), la consegna
 * del PDF (`pagamenti/fattura:GET`) e — la più cara — la guardia di idempotenza
 * dell'emissione (`emissione.ts`), quella che impedisce che allo SDI partano due
 * documenti per la stessa retta. Le prove qui sotto valgono per tutte e cinque;
 * che nessuna torni a derivarlo in casa lo tiene il lock
 * `__tests__/architecture/annullo-riapre-movimento.test.ts`.
 */
const riga = (sdi_stato: number | null): RigaFatturaEmessa => ({
  numero: 2328,
  anno: 2026,
  sezionale: 'Asilo',
  sdi_stato,
})

describe('fatturaViva — derivato da `mapStatoAruba`, non copiato', () => {
  it('per OGNI codice SDI il verdetto è l’esatto complemento di `isScarto`', () => {
    // Derivazione e non copia: il giorno in cui Aruba aggiunge uno stato di
    // scarto, il predicato lo segue senza che nessuno ricordi di aggiornarlo —
    // ed è questo test a dirlo, invece di un commento che lo promette.
    for (let codice = 0; codice <= 20; codice++) {
      expect(fatturaViva(riga(codice)), `stato SDI ${codice}`).toBe(!mapStatoAruba(codice).isScarto)
    }
  })

  it('gli scarti di oggi — 2, 4 e 9 — non sono vivi: una riga scartata si riemette', () => {
    for (const scarto of [2, 4, 9]) expect(fatturaViva(riga(scarto))).toBe(false)
  })

  it('presa in carico, inviata, consegnata, accettata: vive', () => {
    for (const vivo of [1, 3, 5, 6, 7, 8]) expect(fatturaViva(riga(vivo))).toBe(true)
  })

  it('stato ASSENTE → viva: un rifiuto di trasporto non dice che il documento non sia partito', () => {
    expect(fatturaViva(riga(null))).toBe(true)
  })
})

describe('etichettaFattura — il numero come si legge sul documento', () => {
  it('col sezionale: «Asilo 2328/2026»', () => {
    expect(etichettaFattura({ numero: 2328, anno: 2026, sezionale: 'Asilo' })).toBe('Asilo 2328/2026')
  })

  it('senza sezionale (righe storiche): «2328/2026»', () => {
    expect(etichettaFattura({ numero: 2328, anno: 2026, sezionale: null })).toBe('2328/2026')
  })

  it('senza anno ripiega sull’anno corrente, e NON lancia', () => {
    // `formattaNumeroFattura` di `@/lib/fatturazione/sezionale` LANCIA su un
    // sezionale assente o un anno fuori scala: nasce per comporre il numero di un
    // documento che sta per partire. Qui si sta solo NOMINANDO una riga già a
    // registro, e un'eccezione trasformerebbe un avviso in un 500.
    const atteso = `2328/${new Date().getFullYear()}`
    expect(etichettaFattura({ numero: 2328, anno: null, sezionale: null })).toBe(atteso)
  })
})
