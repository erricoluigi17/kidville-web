// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
    chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `scripts/backup/ripristina-prova.sh` — la prova di ripristino della NOSTRA copia, sul Mac.
 *
 * Roadmap di robustezza, fase 2 (D1 «Sempre»). Un backup mai ripristinato è una speranza, non un
 * backup. Lo script decifra il dump (chiave privata age in un file temporaneo), lo ripristina in un
 * Postgres usa-e-getta che ascolta SOLO su un socket locale, conta le righe di ogni tabella e le
 * confronta con quelle del manifest registrate al momento del dump. Qui Postgres è FINTO: si prova
 * il giudizio dello script (uguale / diverso / escluso), non Postgres.
 *
 * ─── COSA NON DEVE SUCCEDERE ────────────────────────────────────────────────
 *  · scrivere il dump decifrato su disco (va da `age` a `pg_restore` in pipe);
 *  · stampare nomi o valori di righe (si stampano numeri e NOMI DI TABELLA, mai righe né messaggi
 *    di errore di pg_restore, che possono citare valori);
 *  · dichiarare «ripristinato» quando una tabella ha un numero di righe diverso dal manifest;
 *  · lasciare il Postgres temporaneo acceso o la cartella di lavoro in giro.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'backup', 'ripristina-prova.sh')
const MARCATORE = 'PLAINTEXT-MARKER-DEL-DUMP-DECIFRATO'

let radice: string
let finti: string
let log: string

function scrivi(nome: string, corpo: string) {
    const p = join(finti, nome)
    writeFileSync(p, corpo)
    chmodSync(p, 0o755)
}

const MANIFEST_RIGA1 = {
    versione: 'PostgreSQL 17.6',
    estensioni: { plpgsql: '1.0', pgcrypto: '1.3', pg_cron: '1.6' },
    ruoli: ['postgres', 'anon', 'authenticated', 'service_role'],
    impostazioni_database_nomi: ['app.cron_secret'],
    conteggi: {
        'public.alunni': 789,
        'public.utenti': 956,
        'auth.users': 956,
        'public.app_log': 122486,
        'cron.job': 29,
    },
}
const MANIFEST_RIGA2 = { giorno: '2026-10-06T0223Z', dump: { byte: 5000000 }, dati_esclusi: ['public.app_log'] }

function creaFinti() {
    scrivi('initdb', `#!/bin/bash
printf '%s\\n' "$@" > "$FAKE_LOG/initdb.args"
while [ $# -gt 0 ]; do [ "$1" = "-D" ] && mkdir -p "$2"; shift; done
exit 0
`)
    scrivi('pg_ctl', `#!/bin/bash
echo "$*" >> "$FAKE_LOG/pg_ctl.chiamate"
echo "\${LC_ALL:-}" >> "$FAKE_LOG/pg_ctl.locale"
exit 0
`)
    scrivi('psql', `#!/bin/bash
sql=""
prev=""
for a in "$@"; do
  [ "$prev" = "-c" ] && sql="$a"
  prev="$a"
done
[ -z "$sql" ] && sql="$(cat)"
echo "$sql" | head -c 300 >> "$FAKE_LOG/psql.sql"; echo >> "$FAKE_LOG/psql.sql"
case "$sql" in
  *json_object_agg*) echo "$FAKE_CONTEGGI_RIPRISTINO" ;;
  *pg_available_extensions*) echo "plpgsql"; echo "pgcrypto" ;;
esac
exit 0
`)
    scrivi('pg_restore', `#!/bin/bash
printf '%s\\n' "$@" > "$FAKE_LOG/pg_restore.args"
cat > /dev/null
echo "pg_restore: error: could not execute query: ERROR: relation x already exists DETTAGLIO-RISERVATO-CON-UN-VALORE" >&2
exit "\${FAKE_RESTORE_EXIT:-1}"
`)
    scrivi('age', `#!/bin/bash
# finto "age -d -i CHIAVE FILE": per il manifest restituisce il JSONL, per il dump un flusso con un marcatore
file="\${@: -1}"
case "$file" in
  *manifest*) printf '%s\\n%s\\n' "$FAKE_MANIFEST_1" "$FAKE_MANIFEST_2" ;;
  *) echo "${MARCATORE}"; head -c 100000 /dev/zero | tr '\\0' 'B' ;;
esac
`)
}

function esegui(extra: Record<string, string> = {}, script = SCRIPT) {
    const chiave = join(radice, 'chiave-temporanea.txt')
    writeFileSync(chiave, 'AGE-SECRET-KEY-FINTA-NON-REALE\n')
    writeFileSync(join(radice, 'x.dump.age'), 'age-encryption.org/v1\n')
    writeFileSync(join(radice, 'x.manifest.jsonl.age'), 'age-encryption.org/v1\n')
    const r = spawnSync('bash', [script], {
        encoding: 'utf8',
        // ambiente PULITO (non eredita GITHUB_STEP_SUMMARY & co. del job di CI); NODE_ENV serve ai tipi
        env: {
            NODE_ENV: 'test',
            PATH: `${finti}:${process.env.PATH}`,
            HOME: process.env.HOME ?? '/tmp',
            TMPDIR: radice,
            FAKE_LOG: log,
            DUMP_FILE: join(radice, 'x.dump.age'),
            MANIFEST_FILE: join(radice, 'x.manifest.jsonl.age'),
            AGE_KEY_FILE: chiave,
            FAKE_MANIFEST_1: JSON.stringify(MANIFEST_RIGA1),
            FAKE_MANIFEST_2: JSON.stringify(MANIFEST_RIGA2),
            FAKE_CONTEGGI_RIPRISTINO: JSON.stringify({
                'public.alunni': 789, 'public.utenti': 956, 'auth.users': 956, 'public.app_log': 0,
            }),
            ...extra,
        },
    })
    return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

function tuttiIFile(dir: string): string[] {
    const t: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) t.push(...tuttiIFile(p))
        else t.push(p)
    }
    return t
}

beforeEach(() => {
    radice = mkdtempSync(join(tmpdir(), 'ripristina-'))
    finti = join(radice, 'finti')
    log = join(radice, 'log')
    mkdirSync(finti)
    mkdirSync(log)
    creaFinti()
})
afterEach(() => rmSync(radice, { recursive: true, force: true }))

describe('ripristina-prova.sh · il giudizio', () => {
    it('conteggi uguali al manifest (escluse le tabelle senza dati e quelle di pg_cron) → riuscita', () => {
        const r = esegui()
        expect(r.err).not.toMatch(/DIVERSE|diversa/i)
        expect(r.status).toBe(0)
        // 3 tabelle da confrontare (alunni, utenti, auth.users); app_log è esclusa (deve essere vuota); cron.job non si confronta
        expect(r.out).toMatch(/^RISULTATO tabelle_confrontate=3 uguali=3 diverse=0 /m)
    })

    it('una tabella con il numero di righe diverso → fallita, e dice QUALE (solo il nome)', () => {
        const r = esegui({
            FAKE_CONTEGGI_RIPRISTINO: JSON.stringify({
                'public.alunni': 700, 'public.utenti': 956, 'auth.users': 956, 'public.app_log': 0,
            }),
        })
        expect(r.status).not.toBe(0)
        expect(r.out).toMatch(/tabelle_confrontate=3 uguali=2 diverse=1/)
        expect(r.err + r.out).toContain('public.alunni')
    })

    it('una tabella che manca del tutto nel ripristino → fallita', () => {
        const r = esegui({
            FAKE_CONTEGGI_RIPRISTINO: JSON.stringify({ 'public.alunni': 789, 'auth.users': 956, 'public.app_log': 0 }),
        })
        expect(r.status).not.toBe(0)
        expect(r.err + r.out).toContain('public.utenti')
    })

    it('una tabella ESCLUSA dal backup che nel ripristino ha righe → fallita (i dati esclusi non dovevano esserci)', () => {
        const r = esegui({
            FAKE_CONTEGGI_RIPRISTINO: JSON.stringify({
                'public.alunni': 789, 'public.utenti': 956, 'auth.users': 956, 'public.app_log': 5,
            }),
        })
        expect(r.status).not.toBe(0)
        expect(r.err + r.out).toContain('public.app_log')
    })

    it('gli errori di pg_restore (ci sono sempre, per pg_cron e le estensioni) NON bastano a bocciare, ma si contano', () => {
        const r = esegui({ FAKE_RESTORE_EXIT: '1' })
        expect(r.status).toBe(0)
        expect(r.out).toMatch(/errori_pg_restore=1\b/)
    })
})

describe('ripristina-prova.sh · cosa NON deve succedere', () => {
    it('non scrive il dump decifrato su disco', () => {
        const r = esegui()
        expect(r.status).toBe(0)
        for (const f of tuttiIFile(radice)) {
            if (f.startsWith(finti)) continue
            expect(readFileSync(f, 'utf8'), `in chiaro dentro ${f}`).not.toContain(MARCATORE)
        }
        expect(r.out + r.err).not.toContain(MARCATORE)
    })

    it('non stampa i messaggi di pg_restore (possono citare valori delle righe)', () => {
        const r = esegui()
        expect(r.out + r.err).not.toContain('DETTAGLIO-RISERVATO-CON-UN-VALORE')
    })

    it('non stampa la chiave privata né il suo percorso contenuto', () => {
        const r = esegui()
        expect(r.out + r.err).not.toContain('AGE-SECRET-KEY')
    })

    it('spegne il Postgres temporaneo e toglie la cartella di lavoro', () => {
        esegui()
        const chiamate = readFileSync(join(log, 'pg_ctl.chiamate'), 'utf8')
        expect(chiamate).toMatch(/start/)
        expect(chiamate).toMatch(/stop/)
        expect(readdirSync(radice).filter((n) => n.startsWith('ripristina-prova.'))).toEqual([])
    })

    it('avvia il Postgres con una LC_ALL valida (su macOS senza, il server rifiuta di partire: visto dal vivo il 06/10)', () => {
        // Su macOS un postmaster senza una locale valida muore con «postmaster became multithreaded during startup».
        // I Postgres finti non lo sanno: per questo il finto registra la LC_ALL con cui lo script lo avvia.
        esegui()
        // una riga per ogni chiamata di pg_ctl (start e stop), VUOTA se la LC_ALL non c'era: va tenuta, non scartata
        const locali = readFileSync(join(log, 'pg_ctl.locale'), 'utf8').replace(/\n$/, '').split('\n')
        expect(locali.length).toBeGreaterThanOrEqual(2)
        for (const l of locali) expect(l).toMatch(/^[A-Za-z_]+\.UTF-8$/)
    })

    it('il Postgres temporaneo ascolta SOLO su un socket locale (nessuna rete)', () => {
        esegui()
        const chiamate = readFileSync(join(log, 'pg_ctl.chiamate'), 'utf8')
        expect(chiamate).toMatch(/listen_addresses=''/)
    })

    it('rifiuta se manca la chiave, il dump o il manifest, e non parte', () => {
        for (const v of ['AGE_KEY_FILE', 'DUMP_FILE', 'MANIFEST_FILE']) {
            const r = esegui({ [v]: join(radice, 'non-esiste') })
            expect(r.status, v).not.toBe(0)
            expect(r.err).toContain(v)
        }
        expect(existsSync(join(log, 'pg_ctl.chiamate'))).toBe(false)
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

    it('senza il confronto dei conteggi, una tabella con meno righe passerebbe', () => {
        const p = mutato(/\[ "\$N_DIVERSE" -eq 0 \]/, 'true')
        const r = esegui({
            FAKE_CONTEGGI_RIPRISTINO: JSON.stringify({
                'public.alunni': 1, 'public.utenti': 956, 'auth.users': 956, 'public.app_log': 0,
            }),
        }, p)
        expect(r.status).toBe(0)
    })

    it('senza il silenzio sui messaggi di pg_restore, un valore di riga finirebbe nel log', () => {
        const p = mutato(/2> "\$W\/pgrestore\.err"/, '2>&1')
        const r = esegui({}, p)
        expect(r.out + r.err).toContain('DETTAGLIO-RISERVATO-CON-UN-VALORE')
    })

    it('senza listen_addresses vuoto, il Postgres temporaneo ascolterebbe in rete', () => {
        const p = mutato(/-c listen_addresses=''/, '')
        esegui({}, p)
        expect(readFileSync(join(log, 'pg_ctl.chiamate'), 'utf8')).not.toMatch(/listen_addresses=''/)
    })
})

describe('ripristina-prova.sh · forma', () => {
    it('esiste e la sintassi è valida per bash', () => {
        expect(existsSync(SCRIPT)).toBe(true)
        const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })
        expect(r.status, r.stderr).toBe(0)
    })
})

describe('dump e ripristino contano le righe con la STESSA query', () => {
    // Se i due script contassero in modo diverso (un filtro in più, uno schema in meno), il confronto
    // fra il manifest del dump e il database ripristinato direbbe «uguale» o «diverso» a caso.
    function fraIMarcatori(file: string): string {
        const t = readFileSync(join(process.cwd(), 'scripts', 'backup', file), 'utf8')
        const m = /#@CONTEGGI-INIZIO\n([\s\S]*?)#@CONTEGGI-FINE/.exec(t)
        expect(m, `i marcatori #@CONTEGGI mancano in ${file}`).not.toBeNull()
        return m![1].trim()
    }

    it('il testo fra i marcatori è identico', () => {
        const dump = fraIMarcatori('dump-cifrato.sh')
        const ripristino = fraIMarcatori('ripristina-prova.sh')
        expect(dump.length).toBeGreaterThan(100)
        expect(ripristino).toBe(dump)
    })

    it('conta gli stessi schemi che il dump salva', () => {
        const q = fraIMarcatori('dump-cifrato.sh')
        const dump = readFileSync(join(process.cwd(), 'scripts', 'backup', 'dump-cifrato.sh'), 'utf8')
        const schemi = /^SCHEMI="([^"]+)"/m.exec(dump)![1].split(/\s+/).sort()
        const contati = [...q.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((n) => schemi.includes(n)).sort()
        expect(contati).toEqual(schemi)
    })
})
