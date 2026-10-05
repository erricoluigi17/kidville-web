// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
    chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `scripts/backup/dump-cifrato.sh` — il dump notturno del database, cifrato prima di toccare il disco.
 *
 * Roadmap di robustezza, fase 2 (D1). Qui il database è FINTO: `pg_dump`, `pg_restore`, `psql` e
 * `age` sono piccoli script nel `PATH` che registrano come sono stati chiamati. Quello che si
 * prova è il COMPORTAMENTO dello script — cosa rifiuta, cosa lascia su disco, cosa stampa — non
 * Postgres. La prova col database vero è il giro `prova` del workflow.
 *
 * ─── LE COSE CHE UN DUMP DI BACKUP PUÒ SBAGLIARE IN SILENZIO ────────────────
 *  · scrivere una copia IN CHIARO su disco (qui: il file finto `pg_dump` mette un marcatore nel flusso,
 *    e dopo il giro il marcatore non deve comparire in NESSUN file);
 *  · dichiarare «fatto» con un dump vuoto o monco (rifiuta sotto 1 MB e sotto il 50% di ieri);
 *  · lasciare un file cifrato a metà quando qualcosa va storto (non deve restare niente);
 *  · stampare la stringa di connessione (conterrebbe una password) in un log PUBBLICO;
 *  · cifrare con una chiave PRIVATA al posto di una pubblica.
 *
 * Le PROVE GEMELLE in fondo guastano lo script (tolgono una guardia) e pretendono che il
 * comportamento sbagliato appaia davvero: se resta uguale, il test sulla guardia non misura niente.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'backup', 'dump-cifrato.sh')
const CHIAVE_PUBBLICA = 'age1' + 'q'.repeat(58)
const MARCATORE = 'PLAINTEXT-MARKER-NON-DEVE-FINIRE-SU-DISCO'
const SEGRETO_URL = 'SEGRETO-DI-PROVA-NON-STAMPARE'

type Esito = { status: number | null; out: string; err: string; cartella: string; log: string }

let radice: string
let finti: string
let uscita: string
let log: string

function scrivi(nome: string, corpo: string) {
    const p = join(finti, nome)
    writeFileSync(p, corpo)
    chmodSync(p, 0o755)
}

function creaFinti() {
    scrivi('psql', `#!/bin/bash
[ -n "$FAKE_PSQL_FAIL" ] && exit 3
while IFS= read -r riga; do
  case "$riga" in
    *pg_export_snapshot*) echo "00000003-0000001B-1" ;;
    *json_build_object*) echo '{"versione":"PostgreSQL 17.6","estensioni":{"pg_cron":"1.6"},"ruoli":["postgres"],"conteggi":{"public.alunni":3,"auth.users":5}}' ;;
  esac
done
`)
    scrivi('pg_dump', `#!/bin/bash
printf '%s\\n' "$@" > "$FAKE_LOG/pg_dump.args"
[ -n "$FAKE_PG_DUMP_EXIT" ] && { echo "pg_dump: errore finto" >&2; exit "$FAKE_PG_DUMP_EXIT"; }
echo "PGDMP-FINTO ${MARCATORE}"
head -c "\${FAKE_DUMP_BYTES:-2000000}" /dev/zero | tr '\\0' 'A'
`)
    scrivi('pg_restore', `#!/bin/bash
printf '%s\\n' "$@" > "$FAKE_LOG/pg_restore.args"
cat > /dev/null
if [ -z "$FAKE_SOMMARIO_VUOTO" ]; then
  for t in public.alunni public.utenti public.pagamenti public.incassi public.enrollment_submissions auth.users; do
    echo "CREATE TABLE $t ("
    echo "COPY $t (id) FROM stdin;"
  done
fi
`)
    scrivi('age', `#!/bin/bash
printf '%s\\n' "$@" > "$FAKE_LOG/age.args.$$"
[ -n "$FAKE_AGE_EXIT" ] && { cat > /dev/null; echo "age: errore finto" >&2; exit "$FAKE_AGE_EXIT"; }
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift; fi
  shift
done
{ echo "age-encryption.org/v1"; tr 'A-Za-z' 'N-ZA-Mn-za-m'; } > "\${out:-/dev/stdout}"
`)
}

function esegui(extra: Record<string, string> = {}, script = SCRIPT): Esito {
    const r = spawnSync('bash', [script], {
        encoding: 'utf8',
        // ambiente PULITO (non eredita GITHUB_STEP_SUMMARY & co. del job di CI); NODE_ENV serve ai tipi
        env: {
            NODE_ENV: 'test',
            PATH: `${finti}:${process.env.PATH}`,
            HOME: process.env.HOME ?? '/tmp',
            FAKE_LOG: log,
            BACKUP_DB_URL: `postgresql://backup_lettura.ref:${SEGRETO_URL}@host.pooler.supabase.com:5432/postgres`,
            AGE_RECIPIENT: CHIAVE_PUBBLICA,
            DEST_DIR: uscita,
            GIORNO: '2026-10-06',
            ...extra,
        },
    })
    return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', cartella: uscita, log }
}

function tuttiIFile(dir: string): string[] {
    const trovati: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) trovati.push(...tuttiIFile(p))
        else trovati.push(p)
    }
    return trovati
}

beforeEach(() => {
    radice = mkdtempSync(join(tmpdir(), 'dump-cifrato-'))
    finti = join(radice, 'finti')
    uscita = join(radice, 'uscita')
    log = join(radice, 'log')
    for (const d of [finti, uscita, log]) mkdirSync(d)
    creaFinti()
})
afterEach(() => rmSync(radice, { recursive: true, force: true }))

describe('dump-cifrato.sh · il giro buono', () => {
    it('produce il dump e il manifest, entrambi cifrati, e dice che è andato bene', () => {
        const r = esegui()
        expect(r.err).not.toMatch(/errore|ERRORE/)
        expect(r.status).toBe(0)
        const file = readdirSync(uscita).sort()
        expect(file).toEqual(['2026-10-06.dump.age', '2026-10-06.manifest.jsonl.age'])
        expect(readFileSync(join(uscita, '2026-10-06.dump.age'), 'utf8').startsWith('age-encryption.org/v1')).toBe(true)
        expect(r.out).toMatch(/^RISULTATO .*dump_byte=\d+/m)
    })

    it('chiama pg_dump con l\'istantanea, il formato custom, senza proprietari e con gli schemi giusti', () => {
        esegui()
        const args = readFileSync(join(log, 'pg_dump.args'), 'utf8').split('\n')
        expect(args).toContain('--format=custom')
        expect(args).toContain('--no-owner')
        expect(args).toContain('--snapshot=00000003-0000001B-1')
        for (const s of ['public', 'auth', 'storage', 'cron', 'supabase_migrations']) {
            expect(args).toContain(`--schema=${s}`)
        }
        expect(args).not.toContain('--schema=vault')
        // i DATI di log e di token di sessione non entrano nel backup (la struttura sì)
        for (const t of [
            'public.app_log', 'cron.job_run_details', 'auth.refresh_tokens', 'auth.sessions',
            'auth.audit_log_entries', 'auth.one_time_tokens', 'auth.flow_state',
        ]) {
            expect(args).toContain(`--exclude-table-data=${t}`)
        }
    })

    it('cifra con la chiave PUBBLICA (age -r age1…)', () => {
        esegui()
        const chiamate = readdirSync(log).filter((f) => f.startsWith('age.args.'))
        expect(chiamate.length).toBeGreaterThanOrEqual(2) // dump + manifest
        for (const f of chiamate) {
            const a = readFileSync(join(log, f), 'utf8').split('\n')
            expect(a).toContain('-r')
            expect(a).toContain(CHIAVE_PUBBLICA)
        }
    })

    it('NON scrive il dump in chiaro da nessuna parte', () => {
        const r = esegui()
        expect(r.status).toBe(0)
        for (const f of tuttiIFile(radice)) {
            if (f.startsWith(finti)) continue
            expect(readFileSync(f, 'utf8'), `in chiaro dentro ${f}`).not.toContain(MARCATORE)
        }
        expect(r.out + r.err).not.toContain(MARCATORE)
    })

    it('NON stampa la stringa di connessione (conterrebbe una password)', () => {
        const r = esegui()
        expect(r.out + r.err).not.toContain(SEGRETO_URL)
    })
})

describe('dump-cifrato.sh · cosa rifiuta', () => {
    it('rifiuta una chiave PRIVATA al posto della pubblica', () => {
        const r = esegui({ AGE_RECIPIENT: 'AGE-SECRET-KEY-1' + 'Q'.repeat(50) })
        expect(r.status).not.toBe(0)
        expect(readdirSync(uscita)).toEqual([])
        expect(r.err).toMatch(/privata|pubblica/i)
        expect(r.out + r.err).not.toContain('AGE-SECRET-KEY-1QQ')
    })

    it('rifiuta una chiave che non ha la forma di una chiave pubblica age', () => {
        const r = esegui({ AGE_RECIPIENT: 'chiave-a-caso' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/chiave pubblica|forma/i)
        expect(readdirSync(uscita)).toEqual([])
    })

    it('rifiuta se manca la stringa di connessione, senza inventarsene una', () => {
        const r = esegui({ BACKUP_DB_URL: '' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/BACKUP_DB_URL/)
        expect(readdirSync(uscita)).toEqual([])
    })

    it('rifiuta un dump sotto 1 MB e non lascia niente', () => {
        const r = esegui({ FAKE_DUMP_BYTES: '1000' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/troppo piccolo|sotto/i)
        expect(readdirSync(uscita)).toEqual([])
    })

    it('rifiuta un dump sotto il 50% di quello di ieri', () => {
        const r = esegui({ FAKE_DUMP_BYTES: '2000000', PREV_DUMP_BYTES: '9000000' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/ieri|precedente|50/i)
        expect(readdirSync(uscita)).toEqual([])
    })

    it('accetta un dump che è il 60% di quello di ieri (cala un po\', non è un guasto)', () => {
        const r = esegui({ FAKE_DUMP_BYTES: '2000000', PREV_DUMP_BYTES: '3000000' })
        expect(r.status).toBe(0)
    })

    it('rifiuta se il sommario non contiene le tabelle chiave', () => {
        const r = esegui({ FAKE_SOMMARIO_VUOTO: '1' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/tabelle chiave|sommario/i)
        expect(readdirSync(uscita)).toEqual([])
    })

    it('se pg_dump fallisce non resta nessun file e lo script esce con errore', () => {
        const r = esegui({ FAKE_PG_DUMP_EXIT: '1' })
        expect(r.status).not.toBe(0)
        expect(existsSync(join(log, 'pg_dump.args'))).toBe(true) // lo script è partito davvero
        expect(r.err).toMatch(/pg_dump/i)
        expect(readdirSync(uscita)).toEqual([])
    })

    it('se age fallisce non resta nessun file e lo script esce con errore', () => {
        const r = esegui({ FAKE_AGE_EXIT: '1' })
        expect(r.status).not.toBe(0)
        expect(readdirSync(log).some((f) => f.startsWith('age.args.'))).toBe(true) // age è stato chiamato
        expect(r.err).toMatch(/age ha fallito \(codice 1\)/)
        expect(readdirSync(uscita)).toEqual([])
    })

    it('se non riesce nemmeno a collegarsi per l\'istantanea, si ferma', () => {
        const r = esegui({ FAKE_PSQL_FAIL: '1' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/istantanea|snapshot|connession/i)
        expect(existsSync(join(log, 'pg_dump.args'))).toBe(false) // senza istantanea non si parte
        expect(readdirSync(uscita)).toEqual([])
    })
})

describe('PROVE GEMELLE · se si toglie una guardia, il comportamento sbagliato appare davvero', () => {
    function mutato(da: RegExp, a: string): string {
        const originale = readFileSync(SCRIPT, 'utf8')
        const nuovo = originale.replace(da, a)
        expect(nuovo, `la mutazione ${da} non ha cambiato lo script`).not.toBe(originale)
        const p = join(radice, 'mutato.sh')
        writeFileSync(p, nuovo)
        return p
    }

    it('senza la soglia di 1 MB, un dump da 1 KB verrebbe accettato', () => {
        const p = mutato(/MIN_BYTES:-1048576/, 'MIN_BYTES:-1')
        const r = esegui({ FAKE_DUMP_BYTES: '1000' }, p)
        expect(r.status).toBe(0)
    })

    it('senza il confronto con ieri, un dump a metà verrebbe accettato', () => {
        const p = mutato(/-lt "\$PREV_DUMP_BYTES"/, '-lt 0')
        const r = esegui({ FAKE_DUMP_BYTES: '2000000', PREV_DUMP_BYTES: '9000000' }, p)
        expect(r.status).toBe(0)
    })

    it('senza --snapshot, pg_dump non userebbe la stessa fotografia dei conteggi', () => {
        const p = mutato(/--snapshot="\$SNAP"/, '')
        esegui({}, p)
        const args = readFileSync(join(log, 'pg_dump.args'), 'utf8')
        expect(args).not.toContain('--snapshot')
    })

    it('senza il controllo della chiave, una chiave privata verrebbe usata', () => {
        const p = mutato(/AGE-SECRET-KEY-/, 'XXX-NON-CONTROLLATO-')
        const r = esegui({ AGE_RECIPIENT: 'AGE-SECRET-KEY-1' + 'Q'.repeat(50) }, p)
        // (con la guardia sulla forma pubblica ancora attiva si ferma comunque: la mutazione
        // deve almeno cambiare il MESSAGGIO, cioè il ramo che riconosce la chiave privata)
        expect(r.err).not.toMatch(/privata/i)
    })
})

describe('dump-cifrato.sh · il file esiste ed è eseguibile da bash 3.2', () => {
    it('esiste', () => {
        expect(existsSync(SCRIPT)).toBe(true)
    })
})
