import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

/**
 * LOCK — esiste una prova che gira sul PRODOTTO COMPILATO, e gira in CI.
 *
 * ─── IL DIFETTO CHE LO RENDE NECESSARIO ─────────────────────────────────────
 * Quinto collaudo, 2026-08-08: otto rotte rispondevano **500 con corpo vuoto a
 * tutte le famiglie**. L'ottimizzatore di Turbopack compilava il ramo `null` di
 * `assertGenitoreNonSospeso` nella stringa «TURBOPACK unreachable»; le rotte
 * facevano `if (sospesoErr) return sospesoErr` e Next non aveva niente da
 * inviare. Per giorni «Comunica un'assenza» è stata inutilizzabile.
 *
 * La cosa che questo lock esiste per ricordare: **il gate era tutto verde.**
 * `eslint` 0, `tsc` 0, 7.694 test, `next build` ok. Non per distrazione — per
 * costruzione: i primi tre leggono il SORGENTE TypeScript, e `next build` esce 0
 * perché la build riesce (è il codice che genera a essere sbagliato). L'unico
 * cancello che esegue il prodotto è l'E2E, e girava — gira tuttora, per il resto
 * della suite — su `npm run dev`, cioè sull'unica configurazione in cui il
 * difetto non esiste.
 *
 * Un difetto che vive solo nell'artefatto si vede solo interrogando l'artefatto.
 * Ci sono due reti, e questo lock pretende che restino entrambe:
 *  1. `scripts/verifica-artefatto.mjs` in `postbuild` — legge i chunk e cerca il
 *     segnaposto. Statica: vede QUESTO difetto, non la classe.
 *  2. `e2e/smoke-artefatto.spec.ts` contro `next start` — fa richieste vere e
 *     guarda se tornano risposte vere. Dinamica: vede la classe.
 *
 * ─── PERCHÉ CONTROLLA ANCHE IL COMANDO DEL SERVER ───────────────────────────
 * Perché il modo silenzioso di perdere questa copertura è che qualcuno, per
 * accorciare la CI, faccia puntare lo smoke al server di sviluppo: resterebbe
 * verde in un secondo e non proverebbe più niente. È lo stesso vizio del
 * progetto che matcha zero file.
 */

const CONFIG = readFileSync('playwright.config.ts', 'utf8')
const CI = readFileSync('.github/workflows/ci.yml', 'utf8')

describe('LOCK · una prova gira sull’artefatto, non sul sorgente', () => {
    it('lo spec esiste', () => {
        expect(
            existsSync('e2e/smoke-artefatto.spec.ts'),
            'sparito lo spec che interroga il prodotto compilato: resta solo il grep sui chunk, ' +
                'che vede il segnaposto di Turbopack e non la classe di guasto',
        ).toBe(true)
    })

    it('il suo server è `next start`, MAI `next dev`', () => {
        // La riga del secondo webServer, quella che costruisce e avvia il prodotto.
        const riga = CONFIG.split('\n').find((l) => l.includes('npm run start'))
        expect(
            riga,
            'il server dello smoke non avvia più il prodotto compilato: se punta a `npm run dev` ' +
                'la prova è verde e non prova niente — è la configurazione in cui il difetto del ' +
                'quinto collaudo NON si manifesta',
        ).toBeTruthy()
        expect(riga, 'il build non precede più `next start`: si avvierebbe un artefatto vecchio').toContain(
            'npm run build',
        )
    })

    it('il progetto lo esegue davvero, e su una porta sua', () => {
        expect(CONFIG).toContain("name: 'smoke-artefatto'")
        expect(
            CONFIG,
            'lo smoke non ha più un baseURL suo: girerebbe contro il server di sviluppo insieme ' +
                'a tutto il resto',
        ).toContain('baseURL: URL_ARTEFATTO')
    })

    it('e SOLO quel progetto: `chromium` non lo esegue contro il server di sviluppo', () => {
        // Nel primo run (2026-08-08) lo smoke è girato DUE volte: 47·48·49 sotto
        // `chromium` e 65·66·67 sotto `smoke-artefatto`. Le prime tre erano verdi
        // contro `next dev` — cioè contro l'unica configurazione in cui il difetto
        // che cercano non esiste. Tre righe verdi che sembrano la prova e non lo
        // sono: è la stessa forma del progetto che matcha zero file.
        const chromium = CONFIG.slice(CONFIG.indexOf("name: 'chromium'"))
        const finoAlProssimo = chromium.slice(0, chromium.indexOf('name:', 10))
        expect(
            finoAlProssimo,
            'il progetto `chromium` non esclude più lo smoke: lo eseguirebbe una seconda volta ' +
                'contro il server di sviluppo, dove è verde per costruzione',
        ).toContain('smoke-artefatto')
    })

    it('in CI gira: non è una prova che si esegue solo se qualcuno se la ricorda', () => {
        // `SMOKE_ARTEFATTO` è vero quando `process.env.CI` c'è: il workflow non
        // deve dichiarare niente, ma la condizione deve restare quella.
        expect(
            CONFIG,
            'lo smoke non è più legato a CI: diventerebbe una prova locale e volontaria, cioè ' +
                'una prova che non esiste',
        ).toMatch(/SMOKE_ARTEFATTO\s*=\s*!!process\.env\.CI/)
        expect(CI, 'il job E2E non esiste più: nessuno eseguirebbe lo smoke').toContain('E2E (Playwright)')
    })

    it('il cancello statico sull’artefatto è ancora agganciato al build', () => {
        const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> }
        expect(
            pkg.scripts?.postbuild,
            'tolto `postbuild`: `npm run build` tornerebbe a uscire 0 su un artefatto che ' +
                'contiene il segnaposto di Turbopack',
        ).toContain('verifica-artefatto')
        expect(existsSync('scripts/verifica-artefatto.mjs')).toBe(true)
    })
})
