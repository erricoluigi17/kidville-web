// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
    controlloCronEsiti,
    controlloEmail,
    controlloMigrazioni,
    controlloPush,
    controlloStorage,
    type Controllo,
} from '@/lib/health/controlli'

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

/**
 * LOCK · I CONTROLLI NUOVI DELLA SALUTE NON DICONO MAI `giu`.
 *
 * `/api/health` risponde 503 quando un controllo dice `giu`, e un 503 sveglia qualcuno: il
 * campanello lo tratta come «il sito non serve i genitori». La sessione 7 della seconda serie ha
 * aggiunto cinque controlli (`cron-esiti`, `storage`, `email`, `push`, `migrazioni`) che vedono
 * cose che nessun genitore vede subito: al più `degradato` (200). Il `503` resta di `db-lettura` e
 * `auth` (il vivo) e di `schema-atteso` quando una tabella manca o non si legge — mai per la
 * lentezza, che dal 2026-10 è `degradato` anche per lo schema.
 *
 * L'ECCEZIONE, VOLUTA (specifica della seconda serie, Sessione 7): `db-lettura` e `auth` restano
 * `giu` anche quando superano il tetto di 2 s. Sono i due controlli di `eseguiVivo`, cioè di
 * `/api/health/vivo`, che risponde 200 su `degradato`: se il loro timeout scendesse a `degradato`,
 * un database appeso risponderebbe 200 e il Worker `monitor-esterno` non suonerebbe più. Per
 * questo `MISURE_CHE_POSSONO_DIRE_GIU` li elenca, e nessun altro.
 *
 * Tre prove: nel sorgente (ogni `misura` fuori dal vivo ha `degradato` come esito sul guasto; il
 * letterale `'giu'` sta solo dentro le dichiarazioni elencate qui sotto), nei quattro moduli puri
 * (nessun `giu`), e ESEGUENDO i cinque controlli con un client che non risponde e con uno che lancia.
 */

const RADICE = process.cwd()
const leggi = (percorso: string): string => readFileSync(join(RADICE, percorso), 'utf8')
const CONTROLLI = leggi('src/lib/health/controlli.ts')

/** Le misure che possono dire `giu` quando il tetto scade o lanciano: i due controlli di
 *  `eseguiVivo`, e basta. Un loro timeout a `degradato` farebbe rispondere 200 a `/api/health/vivo`
 *  con il database appeso, e il Worker `monitor-esterno` non suonerebbe più. */
const MISURE_CHE_POSSONO_DIRE_GIU = new Set(['db-lettura', 'auth'])

/** Le dichiarazioni di `controlli.ts` dentro cui il letterale `'giu'` può comparire. */
const DICHIARAZIONI_CON_GIU = new Set(['EsitoControllo', 'controlloDbLettura', 'controlloAuth', 'controlloSchema', 'aggrega'])

const MODULI_SENZA_GIU = [
    'src/lib/health/valutazione.ts',
    'src/lib/health/cron-esiti.ts',
    'src/lib/health/fornitori.ts',
    'src/lib/health/migrazioni.ts',
]

const RE_DICHIARAZIONE = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|type\s+(\w+)|const\s+(\w+)|interface\s+(\w+))/

/** Il sorgente senza commenti, con le righe al loro posto (un commento può citare `giu`). */
function senzaCommenti(sorgente: string): string {
    return sorgente
        .replace(/\/\*[\s\S]*?\*\//g, (blocco) => blocco.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('lock · nel sorgente', () => {
    it('ogni misura fuori dal vivo ha `degradato` come esito sul guasto', () => {
        const misure = [...CONTROLLI.matchAll(/misura\(\s*'([a-z0-9-]+)'\s*,\s*'([a-z]+)'/g)].map((m) => ({
            nome: m[1],
            suGuasto: m[2],
        }))
        // 9 misure prima della sessione 7, 14 dopo: sotto, la regex non vede più niente.
        expect(misure.length).toBeGreaterThanOrEqual(14)
        expect(misure.filter((m) => !MISURE_CHE_POSSONO_DIRE_GIU.has(m.nome) && m.suGuasto !== 'degradato')).toEqual([])
    })

    it("il letterale 'giu' compare solo nel tipo, nel vivo, nello schema e nell'aggregazione", () => {
        const dove = new Set<string>()
        let corrente = '(testa del file)'
        for (const riga of senzaCommenti(CONTROLLI).split('\n')) {
            const m = RE_DICHIARAZIONE.exec(riga)
            if (m) corrente = m[1] ?? m[2] ?? m[3] ?? m[4] ?? corrente
            if (riga.includes("'giu'")) dove.add(corrente)
        }
        expect(dove.has('aggrega'), 'la scansione non vede più `aggrega`: è diventata cieca').toBe(true)
        expect([...dove].filter((d) => !DICHIARAZIONI_CON_GIU.has(d))).toEqual([])
    })

    it.each(MODULI_SENZA_GIU)('%s non contiene giu', (percorso) => {
        expect(leggi(percorso)).not.toMatch(/['"]giu['"]/)
    })
})

/** Un client che non risponde mai: ogni accesso restituisce sé stesso, e un `await` resta appeso. */
const appeso: object = new Proxy(() => undefined, {
    get: (_bersaglio, chiave) => (chiave === 'then' ? () => undefined : appeso),
    apply: () => appeso,
})

/** Un client che lancia al primo accesso. */
const esplode: object = new Proxy(() => undefined, {
    get: () => {
        throw new Error('client rotto')
    },
})

function tuttiECinque(client: object, adesso: number): Promise<Controllo[]> {
    const s = client as unknown as SupabaseClient
    return Promise.all([
        controlloCronEsiti(s, adesso),
        controlloStorage(s),
        controlloEmail(s, adesso, 'production'),
        controlloPush(s, adesso, 'production'),
        controlloMigrazioni(s, adesso, 'production'),
    ])
}

describe('lock · eseguiti', () => {
    beforeEach(() => {
        // Tutti i canali configurati e la versione della build fissata: ogni controllo arriva al client.
        for (const nome of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY', 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
            vi.stubEnv(nome, 'valore-di-prova')
        }
        vi.stubEnv('KV_MIGRAZIONE_REPO', '20261020091500')
        vi.stubEnv('KV_MIGRAZIONI_REPO_NUMERO', '233')
        vi.stubEnv('KV_BUILD_IL', new Date().toISOString())
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllEnvs()
    })

    it('un client che non risponde: tutti e cinque degradato al tetto dei 2 s, nessuno giu', async () => {
        vi.useFakeTimers()
        const promessa = tuttiECinque(appeso, Date.now())
        await vi.advanceTimersByTimeAsync(2000)

        expect((await promessa).map((c) => [c.nome, c.esito, c.dettaglio])).toEqual([
            ['cron-esiti', 'degradato', 'oltre il tetto di 2000 ms'],
            ['storage', 'degradato', 'oltre il tetto di 2000 ms'],
            ['email', 'degradato', 'oltre il tetto di 2000 ms'],
            ['push', 'degradato', 'oltre il tetto di 2000 ms'],
            ['migrazioni', 'degradato', 'oltre il tetto di 2000 ms'],
        ])
    })

    it('un client che lancia: tutti e cinque degradato, con il nome dell’eccezione', async () => {
        expect((await tuttiECinque(esplode, Date.now())).map((c) => [c.nome, c.esito, c.dettaglio])).toEqual([
            ['cron-esiti', 'degradato', 'eccezione Error'],
            ['storage', 'degradato', 'eccezione Error'],
            ['email', 'degradato', 'eccezione Error'],
            ['push', 'degradato', 'eccezione Error'],
            ['migrazioni', 'degradato', 'eccezione Error'],
        ])
    })
})
