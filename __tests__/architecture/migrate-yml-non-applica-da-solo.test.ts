import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * LOCK — `migrate.yml` non applica niente da solo, e non applica niente senza `--dry-run`.
 *
 * ─── IL DIFETTO CHE LO RENDE NECESSARIO ─────────────────────────────────────
 * Roadmap di robustezza del 2026-10-05, problema D7. Il workflow «DB migrate (prod)» partiva
 * a ogni push su `main` che toccava `supabase/migrations/**` e, appena qualcuno approvava
 * l'ambiente `production`, lanciava `supabase db push` contro il database di produzione, con la
 * CLI `latest` e senza dry-run. Era una SECONDA strada per le migrazioni: la prima è
 * l'integrazione GitHub di Supabase, che le applica al merge, e questa arrivava sempre dopo.
 *
 * I giri approvati hanno sempre stampato «Remote database is up to date»: giri a vuoto. Il guasto
 * non era nei giri a vuoto, era in quello che sarebbe successo il giorno in cui l'integrazione
 * avesse ritardato o fallito: la stessa approvazione, data per abitudine, avrebbe applicato DAVVERO
 * le migrazioni pendenti, con una CLI che nessuno aveva scelto, su un database con dati reali di
 * minori, senza che nessuno avesse prima guardato cosa c'era da applicare. Il registro dei giri
 * ne contava 72 dal 2026-07-04, e a ogni merge una nuova richiesta in attesa.
 *
 * Il workflow ora fa una cosa sola, a mano: `supabase db push --dry-run`, che elenca le migrazioni
 * mancanti e non ne applica nessuna.
 *
 * ─── COSA PRETENDE QUESTO LOCK ──────────────────────────────────────────────
 *  1. L'unico trigger è `workflow_dispatch`: niente `push`, `pull_request`, `schedule`.
 *  2. Ogni `db push` porta `--dry-run` sulla stessa riga.
 *  3. Nessun altro comando che scrive nel database (`migration up`, `migration repair`,
 *     `db reset`, `--include-all`, `psql`).
 *  4. La CLI è fissata a una versione esatta, non `latest` né un intervallo.
 *  5. Il segreto del database di produzione sta in un job con `environment: production`,
 *     cioè dietro un revisore.
 *
 * ─── COME LEGGE IL FILE, E PERCHÉ TOGLIE I COMMENTI ─────────────────────────
 * Un test che legge un file come testo legge anche i commenti, e un lock può immunizzarsi da
 * solo: il commento in testa a `migrate.yml` spiega il disarmo e nomina `push`, `db push` e
 * `latest`. Qui i commenti si tolgono PRIMA di cercare. E vale anche il rovescio: un `--dry-run`
 * scritto soltanto nel commento in coda a una riga non la rende un dry-run (caso provato sotto).
 *
 * Per applicare una migrazione NON si riarma questo workflow: si usa l'integrazione, vedi
 * `docs/cicd.md`. Se un giorno servisse davvero un'altra strada, si cambia questo lock apposta,
 * con la ragione scritta accanto alla riga cambiata.
 */

const VERSIONE_ESATTA = /^\d+\.\d+\.\d+$/

/** Toglie i commenti YAML: `#` a inizio riga o dopo uno spazio, fino a fine riga. */
function senzaCommenti(yaml: string): string {
    return yaml
        .split('\n')
        .map((riga) => riga.replace(/(^|\s)#.*$/, '$1'))
        .join('\n')
}

/** I nomi degli eventi sotto `on:`, in forma a blocco o in linea; `null` se il blocco manca. */
function trigger(codice: string): string[] | null {
    const righe = codice.split('\n')
    const i = righe.findIndex((r) => /^on\s*:/.test(r))
    if (i < 0) return null
    const inline = righe[i].replace(/^on\s*:/, '').trim()
    if (inline !== '') {
        // `on: push`, `on: [push, pull_request]`, `on: { push: {} }`
        return inline.replace(/[[\]{}:]/g, ' ').split(/[\s,]+/).filter(Boolean)
    }
    const eventi: string[] = []
    for (const r of righe.slice(i + 1)) {
        if (/^\S/.test(r)) break // la prossima chiave di primo livello chiude il blocco `on`
        const m = /^ {2}([A-Za-z_]+)\s*:/.exec(r)
        if (m) eventi.push(m[1])
    }
    return eventi
}

/** La `version:` del passo `supabase/setup-cli`; `null` se il passo non c'è, `''` se non è dichiarata. */
function versioneDellaCli(codice: string): string | null {
    const righe = codice.split('\n')
    const i = righe.findIndex((r) => /uses:\s*supabase\/setup-cli@/.test(r))
    if (i < 0) return null
    for (const r of righe.slice(i + 1, i + 5)) {
        const m = /^\s*version:\s*['"]?([^\s'"]+)['"]?\s*$/.exec(r)
        if (m) return m[1]
        if (/^\s*-\s/.test(r)) break // è già il passo successivo
    }
    return ''
}

/** Le violazioni del file, una per riga di messaggio; vuoto = il file rispetta il lock. */
function controlla(yaml: string): string[] {
    const codice = senzaCommenti(yaml)
    const v: string[] = []

    const eventi = trigger(codice)
    if (eventi === null) {
        v.push('manca il blocco `on:`')
    } else if (eventi.length !== 1 || eventi[0] !== 'workflow_dispatch') {
        v.push(`il solo trigger ammesso è \`workflow_dispatch\`; trovati: ${eventi.join(', ') || '(nessuno)'}`)
    }

    for (const riga of codice.split('\n')) {
        if (/\bdb\s+push\b/.test(riga) && !/--dry-run\b/.test(riga)) {
            v.push(`\`db push\` senza \`--dry-run\` sulla stessa riga: ${riga.trim()}`)
        }
        for (const [nome, re] of VIETATI) {
            if (re.test(riga)) v.push(`comando che scrive nel database: ${nome}: ${riga.trim()}`)
        }
    }

    const versione = versioneDellaCli(codice)
    if (versione !== null && !VERSIONE_ESATTA.test(versione)) {
        v.push(`la CLI non è fissata a una versione esatta (trovato: ${versione === '' ? 'nessuna `version`' : versione})`)
    }

    if (/PROD_SUPABASE_DB_URL/.test(codice) && !/^\s*environment:\s*production\s*$/m.test(codice)) {
        v.push('il segreto del database di produzione è usato senza `environment: production` (nessun revisore)')
    }

    return v
}

/** I comandi che modificano il database remoto e che un dry-run non ha motivo di contenere. */
const VIETATI: ReadonlyArray<readonly [string, RegExp]> = [
    ['migration up', /\bmigration\s+up\b/],
    ['migration repair', /\bmigration\s+repair\b/],
    ['migration squash', /\bmigration\s+squash\b/],
    ['db reset', /\bdb\s+reset\b/],
    ['--include-all', /--include-all\b/],
    ['psql', /\bpsql\b/],
]

const REALE = readFileSync('.github/workflows/migrate.yml', 'utf8')

/** Un file valido, minimo, su cui provare le mutazioni. Le righe sono unite a mano: niente `${{` nel template. */
const BASE = [
    'name: prova',
    'on:',
    '  workflow_dispatch: {}',
    'jobs:',
    '  verifica:',
    '    runs-on: ubuntu-latest',
    '    environment: production',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: supabase/setup-cli@v1',
    '        with:',
    '          version: 2.109.0',
    '      - run: supabase db push --dry-run --db-url "${{ secrets.PROD_SUPABASE_DB_URL }}"',
    '',
].join('\n')

describe('LOCK · migrate.yml non applica migrazioni da solo', () => {
    it('il file vero rispetta tutte le regole', () => {
        expect(
            controlla(REALE),
            'migrate.yml è stato riarmato: ricompare un trigger automatico, un `db push` senza ' +
                '`--dry-run`, una CLI non fissata o un comando che scrive. Per applicare una migrazione ' +
                'si usa l’integrazione GitHub di Supabase (docs/cicd.md), non questo workflow.',
        ).toEqual([])
    })

    it('non è un lock cieco: nel file vero c’è davvero un trigger manuale e un dry-run', () => {
        const codice = senzaCommenti(REALE)
        expect(trigger(codice)).toEqual(['workflow_dispatch'])
        expect(codice, 'sparito il dry-run: il workflow non verifica più niente').toMatch(/\bdb\s+push\s+--dry-run\b/)
        expect(versioneDellaCli(codice)).toMatch(VERSIONE_ESATTA)
    })

    it('il file di prova valido non ha violazioni (la controprova delle mutazioni)', () => {
        expect(controlla(BASE)).toEqual([])
    })

    describe('ogni riarmo viene visto', () => {
        const mutazioni: ReadonlyArray<readonly [string, (s: string) => string, RegExp]> = [
            [
                'torna il trigger su push',
                (s) => s.replace('  workflow_dispatch: {}', '  push:\n    branches: [main]\n  workflow_dispatch: {}'),
                /trigger ammesso.*push/,
            ],
            [
                'si aggiunge pull_request',
                (s) => s.replace('  workflow_dispatch: {}', '  pull_request:\n  workflow_dispatch: {}'),
                /trigger ammesso.*pull_request/,
            ],
            [
                'si aggiunge una schedulazione',
                (s) => s.replace('  workflow_dispatch: {}', "  schedule:\n    - cron: '0 3 * * *'\n  workflow_dispatch: {}"),
                /trigger ammesso.*schedule/,
            ],
            ['trigger in linea', (s) => s.replace(/on:\n  workflow_dispatch: \{\}/, 'on: push'), /trigger ammesso.*push/],
            ['trigger in linea con elenco', (s) => s.replace(/on:\n  workflow_dispatch: \{\}/, 'on: [push, workflow_dispatch]'), /trigger ammesso/],
            ['si toglie --dry-run', (s) => s.replace(' --dry-run', ''), /`db push` senza `--dry-run`/],
            [
                '--dry-run scritto solo nel commento in coda',
                (s) => s.replace('db push --dry-run --db-url', 'db push --db-url').replace(/"$/m, '" # --dry-run'),
                /`db push` senza `--dry-run`/,
            ],
            ['CLI latest', (s) => s.replace('version: 2.109.0', 'version: latest'), /CLI non è fissata/],
            ['CLI con intervallo', (s) => s.replace('version: 2.109.0', 'version: 2.x'), /CLI non è fissata/],
            ['CLI senza version', (s) => s.replace('        with:\n          version: 2.109.0\n', ''), /CLI non è fissata/],
            ['db reset', (s) => s + '      - run: supabase db reset --linked\n', /db reset/],
            ['migration up', (s) => s + '      - run: supabase migration up --db-url x\n', /migration up/],
            ['psql', (s) => s + '      - run: psql "$URL" -f supabase/migrations/x.sql\n', /psql/],
            ['segreto senza revisore', (s) => s.replace('    environment: production\n', ''), /nessun revisore/],
        ]

        for (const [nome, muta, atteso] of mutazioni) {
            it(nome, () => {
                const mutato = muta(BASE)
                expect(mutato, 'la mutazione non ha cambiato niente: il caso di prova è cieco').not.toBe(BASE)
                expect(controlla(mutato).join('\n')).toMatch(atteso)
            })
        }
    })

    it('i commenti non contano: né per far fallire il lock né per ingannarlo', () => {
        // Il commento nomina tutto ciò che il lock vieta: non deve produrre violazioni.
        const spiegato =
            '# Prima: on push, `supabase db push`, `latest`, supabase db reset, psql.\n' +
            BASE.replace('jobs:', '# su push partiva da solo\njobs:')
        expect(controlla(spiegato)).toEqual([])
    })
})
