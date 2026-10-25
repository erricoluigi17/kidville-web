import { describe, expect, it } from 'vitest'
import { leggiStatoMigrazioniDb, statoMigrazioniRepo, valutaMigrazioni } from '@/lib/health/migrazioni'
import { TOLLERANZA_MERGE_MS, inAttesaDellIntegrazione } from '@/lib/health/valutazione'

/**
 * LE MIGRAZIONI DEL REPO CONTRO QUELLE DEL DATABASE (sessione 7 della seconda serie di robustezza).
 */

const MIN = 60_000
const ADESSO = Date.parse('2026-10-20T10:00:00.000Z')
const REPO = { ultima: '20261020091500', numero: 233 }
const COPPIA = 'repo 20261020091500 (233), database 20261019223123 (232)'

describe('statoMigrazioniRepo', () => {
    it('la versione più alta e il numero dei soli file di migrazione', () => {
        expect(
            statoMigrazioniRepo([
                '20261001000000_a.sql',
                '20261020091500_c.sql',
                '20261010000000_b.sql',
                'README.md',
                '2026_x.sql',
                '.gitkeep',
            ]),
        ).toEqual({ ultima: '20261020091500', numero: 3 })
    })

    it('nessun file di migrazione: null', () => {
        expect(statoMigrazioniRepo([])).toBeNull()
        expect(statoMigrazioniRepo(['README.md'])).toBeNull()
    })
})

describe('leggiStatoMigrazioniDb', () => {
    it('la riga della RPC, in un elenco o da sola', () => {
        expect(leggiStatoMigrazioniDb([{ ultima: '20261020091500', numero: 233 }])).toEqual(REPO)
        expect(leggiStatoMigrazioniDb({ ultima: '20261020091500', numero: 233 })).toEqual(REPO)
    })

    it.each([
        ['un elenco vuoto', []],
        ['null', null],
        ['una versione corta', [{ ultima: '2026102009', numero: 233 }]],
        ['una tabella vuota', [{ ultima: null, numero: 0 }]],
        ['un numero in testo', [{ ultima: '20261020091500', numero: '233' }]],
        ['un numero negativo', [{ ultima: '20261020091500', numero: -1 }]],
    ])('%s → illeggibile', (_caso, data) => {
        expect(leggiStatoMigrazioniDb(data)).toBeNull()
    })
})

describe('la tolleranza del merge', () => {
    it('30 minuti dalla build, al secondo; fuori da una build non scade', () => {
        expect(TOLLERANZA_MERGE_MS).toBe(1_800_000)
        expect(inAttesaDellIntegrazione(ADESSO - 30 * MIN + 1000, ADESSO)).toBe(true)
        expect(inAttesaDellIntegrazione(ADESSO - 30 * MIN, ADESSO)).toBe(true)
        expect(inAttesaDellIntegrazione(ADESSO - 30 * MIN - 1000, ADESSO)).toBe(false)
        expect(inAttesaDellIntegrazione(null, ADESSO)).toBe(true)
    })
})

describe('valutaMigrazioni', () => {
    const DB_INDIETRO = { ultima: '20261019223123', numero: 232 }

    it('uguali: ok, con il numero e l’ultima', () => {
        expect(valutaMigrazioni(REPO, REPO, ADESSO - 120 * MIN, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '233 migrazioni, ultima 20261020091500',
        })
    })

    it('repo avanti 29 minuti dopo la build: ok, l’integrazione sta applicando', () => {
        expect(valutaMigrazioni(REPO, DB_INDIETRO, ADESSO - 29 * MIN, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: `in attesa dell'integrazione: ${COPPIA}`,
        })
    })

    it('repo avanti 31 minuti dopo la build: degradato', () => {
        expect(valutaMigrazioni(REPO, DB_INDIETRO, ADESSO - 31 * MIN, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: `migrazioni del repo non applicate da oltre 30 min dalla build: ${COPPIA}`,
        })
    })

    it('stessa ultima versione ma una in mezzo mancante: degradato (lo vede il numero)', () => {
        expect(valutaMigrazioni(REPO, { ultima: '20261020091500', numero: 232 }, ADESSO - 120 * MIN, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio:
                'migrazioni del repo non applicate da oltre 30 min dalla build: repo 20261020091500 (233), database 20261020091500 (232)',
        })
    })

    it('database avanti (deploy in corso, Instant Rollback): ok', () => {
        expect(valutaMigrazioni(REPO, { ultima: '20261021080000', numero: 234 }, ADESSO - 120 * MIN, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio:
                'database avanti sul repo (deploy in corso o ritorno indietro): repo 20261020091500 (233), database 20261021080000 (234)',
        })
    })

    it('una riga doppia in schema_migrations: ok come «database avanti» (limite dichiarato)', () => {
        expect(valutaMigrazioni(REPO, { ultima: '20261020091500', numero: 234 }, ADESSO - 120 * MIN, ADESSO)).toMatchObject({
            esito: 'ok',
        })
    })

    it('fuori da una build (istante ignoto): la differenza resta «in attesa»', () => {
        expect(valutaMigrazioni(REPO, DB_INDIETRO, null, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: `in attesa dell'integrazione: ${COPPIA}`,
        })
    })
})
