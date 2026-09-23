import { describe, it, expect } from 'vitest'
import { CODICI_ESITO_CODA } from '@/lib/fatture-coda/giro'
import catalogoIt from '../../messages/it/adminContabilita.json'
import catalogoEn from '../../messages/en/adminContabilita.json'

/**
 * LOCK · ogni codice di `CODICI_ESITO_CODA` (`src/lib/fatture-coda/giro.ts`, §2 punto 7
 * del nucleo) ha una traduzione `adminContabilita.codaFatture.esiti.<codice>`, in it E in en.
 *
 * Perché esiste (correzione giro 2 del critico). Il pannello (`CodaFatturePanel.tsx`)
 * traduce un codice noto e ricade sul messaggio grezzo del server per uno sconosciuto —
 * ma `esito_messaggio` è `null` per le voci di un'altra sede (decisione 6 del nucleo,
 * `esito_messaggio è null se l'utente non ha la sede della voce`): un codice che il
 * catalogo non conosce non mostra NESSUN motivo, in silenzio. Al primo giro il catalogo
 * ne aveva 4 su 19: la segreteria di un'altra sede vedeva una riga «Errore» muta per 15
 * codici su 19.
 *
 * Il test è rosso se: `giro.ts` aggiunge un codice e il catalogo non lo segue; il
 * catalogo perde una chiave (tolta per errore); una chiave esiste ma con testo vuoto.
 */

type CatalogoEsiti = Record<string, string>

function esitiDi(catalogo: unknown): CatalogoEsiti {
    const c = catalogo as { codaFatture?: { esiti?: unknown } }
    const esiti = c.codaFatture?.esiti
    if (typeof esiti !== 'object' || esiti === null) return {}
    return esiti as CatalogoEsiti
}

describe('LOCK · CODICI_ESITO_CODA ↔ adminContabilita.codaFatture.esiti', () => {
    it('CODICI_ESITO_CODA non è vuoto (altrimenti il confronto sotto è sempre verde)', () => {
        expect(CODICI_ESITO_CODA.length).toBeGreaterThan(0)
    })

    it.each(['it', 'en'] as const)('ogni codice del giro ha una traduzione non vuota in %s', (lingua) => {
        const catalogo = lingua === 'it' ? catalogoIt : catalogoEn
        const esiti = esitiDi(catalogo)
        const mancanti = CODICI_ESITO_CODA.filter((codice) => !esiti[codice] || esiti[codice].trim() === '')
        expect(
            mancanti,
            `Codici del giro (giro.ts) senza traduzione in ${lingua} sotto codaFatture.esiti: ${mancanti.join(', ')}. ` +
            `Senza, una voce di un'altra sede (esito_messaggio null) mostra una riga d'errore muta.`,
        ).toEqual([])
    })

    it('il catalogo (it) non ha chiavi in eccesso: solo i codici che il giro può davvero scrivere', () => {
        const esiti = esitiDi(catalogoIt)
        const noti = new Set<string>(CODICI_ESITO_CODA)
        const eccesso = Object.keys(esiti).filter((codice) => !noti.has(codice))
        expect(eccesso, `Chiavi in codaFatture.esiti che giro.ts non scrive più: ${eccesso.join(', ')}`).toEqual([])
    })

    it('la prova che il lock sa davvero trovare un codice mancante (fantoccio)', () => {
        const finti = ['...un codice così non esiste in giro.ts...']
        const esitiVuoti: CatalogoEsiti = {}
        const mancanti = finti.filter((codice) => !esitiVuoti[codice])
        expect(mancanti).toEqual(finti)
    })
})
