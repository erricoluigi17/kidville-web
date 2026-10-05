// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `scripts/backup/specchio-storage.sh` — lo specchio notturno dei file di Supabase Storage.
 *
 * Roadmap di robustezza, fase 2 (D2). `rclone` qui è FINTO: registra come viene chiamato e
 * risponde con numeri decisi dal test. Si prova il COMPORTAMENTO dello script, cioè le sue
 * guardie. Che il cestino funzioni davvero lo prova il giro `prova` del workflow, con un
 * rclone vero e una cartella sintetica.
 *
 * ─── IL PERICOLO CHE QUESTE GUARDIE TENGONO FUORI ───────────────────────────
 * `rclone sync` rende la destinazione UGUALE alla sorgente: se la sorgente, per un guasto o
 * un errore di configurazione, appare vuota o quasi, il sync cancella lo specchio. Da qui:
 *  · ogni cosa che sparisce dalla sorgente finisce nel CESTINO (`--backup-dir`), mai nel nulla;
 *  · un tetto alle cancellazioni (`--max-delete`, `--max-delete-size`);
 *  · il rifiuto di partire se la sorgente è vuota, o se è calata sotto il 90% dello specchio;
 *  · nessun sottocomando distruttivo di rclone, mai.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'backup', 'specchio-storage.sh')
const UUID = '3f2c9a1e-7b4d-4e8a-9c01-5d6e7f8a9b0c'

type Esito = { status: number | null; out: string; err: string }

let radice: string
let finti: string
let log: string

function creaRcloneFinto() {
    const p = join(finti, 'rclone')
    writeFileSync(p, `#!/bin/bash
echo "$*" >> "$FAKE_LOG/rclone.chiamate"
cmd="$1"
case "$cmd" in
  size)
    # il percorso dice che cosa si sta misurando
    n="\${FAKE_N_SORGENTE:-100}"
    case "$*" in
      *cestino*) n="\${FAKE_N_CESTINO:-0}" ;;
      *corrente*) n="\${FAKE_N_DEST:-100}" ;;
    esac
    echo "{\\"count\\":$n,\\"bytes\\":$((n * 1000))}"
    ;;
  sync)
    [ -n "$FAKE_SYNC_AVVISO" ] && echo "NOTICE: ${UUID}/foto.jpg: Failed to copy: finto" >&2
    exit "\${FAKE_SYNC_EXIT:-0}"
    ;;
  check)
    dest=""
    prev=""
    for a in "$@"; do
      [ "$prev" = "--missing-on-dst" ] && dest="$a"
      prev="$a"
    done
    n="\${FAKE_MANCANTI:-0}"
    if [ -n "$dest" ]; then
      : > "$dest"
      i=0; while [ "$i" -lt "$n" ]; do echo "file-$i" >> "$dest"; i=$((i+1)); done
    fi
    [ "$n" -gt 0 ] && exit 1
    exit 0
    ;;
  *) echo "rclone finto: sottocomando non previsto: $cmd" >&2; exit 99 ;;
esac
`)
    chmodSync(p, 0o755)
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
            SORGENTE: 'SB_FINTO:',
            DESTINAZIONE: 'CRIPTO:corrente',
            CESTINO: 'CRIPTO:cestino/2026-10-06',
            ...extra,
        },
    })
    return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

function chiamate(): string[] {
    const f = join(log, 'rclone.chiamate')
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []
}
const sync = () => chiamate().filter((c) => c.startsWith('sync '))

beforeEach(() => {
    radice = mkdtempSync(join(tmpdir(), 'specchio-'))
    finti = join(radice, 'finti')
    log = join(radice, 'log')
    mkdirSync(finti)
    mkdirSync(log)
    creaRcloneFinto()
})
afterEach(() => rmSync(radice, { recursive: true, force: true }))

describe('specchio-storage.sh · il giro buono', () => {
    it('fa UN sync, con il cestino e i tetti alle cancellazioni, e dice com\'è andata', () => {
        const r = esegui({ FAKE_N_CESTINO: '4' })
        expect(r.err).not.toMatch(/ERRORE/)
        expect(r.status).toBe(0)
        const s = sync()
        expect(s).toHaveLength(1)
        expect(s[0]).toContain('sync SB_FINTO: CRIPTO:corrente')
        expect(s[0]).toContain('--backup-dir CRIPTO:cestino/2026-10-06')
        expect(s[0]).toMatch(/--max-delete 500\b/)
        expect(s[0]).toMatch(/--max-delete-size 2G\b/)
        expect(r.out).toMatch(/^RISULTATO oggetti_specchio=100 byte_specchio=100000 spostati_nel_cestino=4 mancanti=0/m)
    })

    it('controlla alla fine che niente manchi nello specchio', () => {
        esegui()
        const c = chiamate().filter((x) => x.startsWith('check '))
        expect(c).toHaveLength(1)
        expect(c[0]).toContain('--one-way')
        expect(c[0]).toContain('--size-only')
    })

    it('non chiama MAI un sottocomando distruttivo di rclone', () => {
        esegui({ FAKE_N_CESTINO: '4' })
        const usati = new Set(chiamate().map((c) => c.split(' ')[0]))
        expect(usati.has('sync'), 'lo script non ha chiamato rclone: il test non misurerebbe niente').toBe(true)
        for (const vietato of ['delete', 'deletefile', 'purge', 'cleanup', 'rmdir', 'rmdirs', 'move', 'moveto', 'rmdirs', 'dedupe']) {
            expect(usati.has(vietato), `sottocomando vietato: ${vietato}`).toBe(false)
        }
        expect([...usati].every((u) => ['size', 'sync', 'check'].includes(u))).toBe(true)
    })

    it('non lascia passare nei log i nomi dei file (uuid mascherati)', () => {
        const r = esegui({ FAKE_SYNC_AVVISO: '1' })
        expect(r.out + r.err).not.toContain(UUID)
        expect(r.out + r.err).toContain('<uuid>')
    })
})

describe('specchio-storage.sh · cosa rifiuta', () => {
    it('rifiuta una sorgente vuota e NON lancia il sync', () => {
        const r = esegui({ FAKE_N_SORGENTE: '0' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/sorgente vuota/i)
        expect(sync()).toHaveLength(0)
    })

    it('rifiuta se la sorgente è calata sotto il 90% dello specchio', () => {
        const r = esegui({ FAKE_N_SORGENTE: '80', FAKE_N_DEST: '100' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/calata|90/i)
        expect(sync()).toHaveLength(0)
    })

    it('accetta un calo del 5% (cancellazioni normali)', () => {
        const r = esegui({ FAKE_N_SORGENTE: '95', FAKE_N_DEST: '100' })
        expect(r.status).toBe(0)
        expect(sync()).toHaveLength(1)
    })

    it('un calo grande passa solo con PERMETTI_CALO=1, detto a voce', () => {
        const r = esegui({ FAKE_N_SORGENTE: '80', FAKE_N_DEST: '100', PERMETTI_CALO: '1' })
        expect(r.status).toBe(0)
        expect(sync()).toHaveLength(1)
        expect(r.err + r.out).toMatch(/PERMETTI_CALO/)
    })

    it('se il sync fallisce (per esempio supera --max-delete) lo script fallisce', () => {
        const r = esegui({ FAKE_SYNC_EXIT: '7' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/sync ha fallito \(codice 7\)/)
    })

    it('rifiuta se mancano più file dello specchio del tetto', () => {
        const r = esegui({ FAKE_MANCANTI: '21' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/mancanti/i)
    })

    it('tollera pochi file mancanti (caricati mentre girava)', () => {
        const r = esegui({ FAKE_MANCANTI: '3' })
        expect(r.status).toBe(0)
        expect(r.out).toMatch(/mancanti=3/)
    })

    it('rifiuta un cestino dentro (o uguale a) la destinazione', () => {
        for (const cestino of ['CRIPTO:corrente', 'CRIPTO:corrente/cestino']) {
            const r = esegui({ CESTINO: cestino })
            expect(r.status, cestino).not.toBe(0)
            expect(r.err).toMatch(/cestino/i)
            expect(sync()).toHaveLength(0)
        }
    })

    it('rifiuta se manca una delle tre destinazioni', () => {
        for (const v of ['SORGENTE', 'DESTINAZIONE', 'CESTINO']) {
            const r = esegui({ [v]: '' })
            expect(r.status, v).not.toBe(0)
            expect(r.err).toContain(v)
        }
        expect(sync()).toHaveLength(0)
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

    it('senza --backup-dir, ciò che sparisce dalla sorgente sparirebbe anche dallo specchio', () => {
        const p = mutato(/--backup-dir "\$CESTINO"/, '')
        esegui({}, p)
        expect(sync()[0]).not.toContain('--backup-dir')
    })

    it('senza --max-delete, una cancellazione di massa passerebbe', () => {
        const p = mutato(/--max-delete "\$MAX_DELETE"/, '')
        esegui({}, p)
        expect(sync()[0]).not.toContain('--max-delete ')
    })

    it('senza la guardia sulla sorgente vuota, il sync partirebbe su una sorgente vuota', () => {
        const p = mutato(/\[ "\$N_SORGENTE" -gt 0 \]/, 'true')
        // specchio vuoto anch'esso: così la guardia del 90% non interviene e si misura solo questa
        esegui({ FAKE_N_SORGENTE: '0', FAKE_N_DEST: '0' }, p)
        expect(sync().length).toBeGreaterThan(0)
    })

    it('senza la guardia del 90%, un crollo della sorgente passerebbe', () => {
        const p = mutato(/\$\(\(N_SORGENTE \* 10\)\) -lt \$\(\(N_DEST \* 9\)\)/, '1 -lt 0')
        esegui({ FAKE_N_SORGENTE: '80', FAKE_N_DEST: '100' }, p)
        expect(sync().length).toBeGreaterThan(0)
    })

    it('senza la maschera degli uuid, i nomi dei file finirebbero nel log pubblico', () => {
        const p = mutato(/sed -E 's\/\[0-9a-f\]\{8\}[^']*'/, "cat #")
        const r = esegui({ FAKE_SYNC_AVVISO: '1' }, p)
        expect(r.out + r.err).toContain(UUID)
    })
})

describe('specchio-storage.sh · forma', () => {
    it('esiste e la sintassi è valida per bash', () => {
        expect(existsSync(SCRIPT)).toBe(true)
        const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })
        expect(r.status, r.stderr).toBe(0)
    })
})
