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
    case "$*" in
      *--dry-run*)
        # il PIANO: una riga per ogni cosa che il sync farebbe. Il percorso (con un uuid) deve poi
        # sparire dal log pubblico: lo script ne tiene solo la FORMA e i conteggi.
        i=0; while [ "$i" -lt "\${FAKE_PIANO_COPIE:-0}" ]; do echo "2026/10/06 09:10:00 NOTICE: fatture/${UUID}-$i.pdf: Skipped copy as --dry-run is set (size 10)" >&2; i=$((i+1)); done
        i=0; while [ "$i" -lt "\${FAKE_PIANO_SOSTITUITI:-0}" ]; do echo "2026/10/06 09:10:00 NOTICE: fatture/${UUID}-$i.pdf: Skipped move as --dry-run is set (size 10)" >&2; i=$((i+1)); done
        i=0; while [ "$i" -lt "\${FAKE_PIANO_CANCELLATI:-0}" ]; do echo "2026/10/06 09:10:00 NOTICE: chat-allegati/${UUID}-$i.jpg: Skipped move into backup dir as --dry-run is set (size 10)" >&2; i=$((i+1)); done
        i=0; while [ "$i" -lt "\${FAKE_PIANO_ORARI:-0}" ]; do echo "2026/10/06 09:10:00 DEBUG : fatture/${UUID}-$i.pdf: Modification times differ by 345ms: 2026-10-06 09:10:12.345 +0000 UTC, 2026-10-06 09:10:13 +0000 UTC" >&2; i=$((i+1)); done
        exit "\${FAKE_PIANO_EXIT:-0}"
        ;;
    esac
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
const sync = () => chiamate().filter((c) => c.startsWith('sync ') && !c.includes('--dry-run'))
const piano = () => chiamate().filter((c) => c.startsWith('sync ') && c.includes('--dry-run'))

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
        expect(s[0]).toMatch(/--max-delete 800\b/) // 500 cancellazioni + 300 sostituzioni: il PIANO ha già limitato ciascuna
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

describe('specchio-storage.sh · il PIANO prima di eseguire (06/10: il primo sync su uno specchio già popolato)', () => {
    /**
     * Il 06/10 il primo giro programmato ha lanciato `rclone sync` su uno specchio GIÀ popolato (il
     * `completo` delle 00:04 l'aveva trovato vuoto) e ha superato `--max-delete 500` dopo 80 secondi,
     * a metà trasferimento, spostando nel cestino le vecchie versioni di centinaia di file che nella
     * sorgente non erano cambiati. Nessuno sapeva perché. Ora: un dry-run PRIMA (stessa riga di
     * comando), con un riepilogo senza nomi; se il piano è anomalo ci si ferma PRIMA di toccare lo
     * specchio, e il log dice che cosa rclone riteneva diverso.
     */
    it('lancia un dry-run con le STESSE opzioni del sync vero, e senza tetto (per contare tutto)', () => {
        esegui({ ESCLUDI_BUCKET: 'gallery' })
        const pi = piano()
        expect(pi, 'il piano non è stato chiesto').toHaveLength(1)
        expect(pi[0]).toContain('sync SB_FINTO: CRIPTO:corrente')
        expect(pi[0]).toContain('--backup-dir CRIPTO:cestino/2026-10-06')
        expect(pi[0]).toContain('--exclude /gallery/**')
        expect(pi[0]).toMatch(/--max-delete -1\b/)
        expect(pi[0]).toMatch(/-vv\b/)
    })

    it('piano e sync vero usano la STESSA finestra sulle date (un crypt non ha hash: 1 ns = tutto «cambiato»)', () => {
        esegui()
        expect(piano()[0]).toMatch(/--modify-window 2s\b/)
        expect(sync()[0]).toMatch(/--modify-window 2s\b/)
        // il controllo finale confronta solo le dimensioni: la data non c'entra
        const c = chiamate().find((x) => x.startsWith('check '))!
        expect(c).not.toContain('--modify-window')
    })

    it('il piano viene PRIMA del sync vero', () => {
        esegui()
        const tutte = chiamate()
        const iPiano = tutte.findIndex((c) => c.startsWith('sync ') && c.includes('--dry-run'))
        const iVero = tutte.findIndex((c) => c.startsWith('sync ') && !c.includes('--dry-run'))
        expect(iPiano).toBeGreaterThanOrEqual(0)
        expect(iVero).toBeGreaterThan(iPiano)
    })

    it('un piano normale (pochi nuovi, pochi sostituiti, poche cancellazioni) passa e finisce nel RISULTATO', () => {
        const r = esegui({ FAKE_PIANO_COPIE: '40', FAKE_PIANO_SOSTITUITI: '3', FAKE_PIANO_CANCELLATI: '2' })
        expect(r.status, r.err).toBe(0)
        expect(sync()).toHaveLength(1)
        expect(r.out).toMatch(/^PIANO copie=40 sostituiti=3 cancellati=2\b/m)
        expect(r.out).toMatch(/^RISULTATO .*piano_sostituiti=3 piano_cancellati=2/m)
    })

    it('troppe SOSTITUZIONI: tutto sembra cambiato → si ferma PRIMA, senza toccare lo specchio', () => {
        const r = esegui({ FAKE_PIANO_COPIE: '700', FAKE_PIANO_SOSTITUITI: '650' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/sostituir|cambiati/i)
        expect(r.err).toMatch(/650/)
        expect(sync(), 'il sync vero non doveva partire').toHaveLength(0)
    })

    it('troppe CANCELLAZIONI: si ferma PRIMA, senza toccare lo specchio', () => {
        const r = esegui({ FAKE_PIANO_CANCELLATI: '501' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/cancellazion/i)
        expect(r.err).toMatch(/501/)
        expect(sync()).toHaveLength(0)
    })

    it('i tetti del piano sono configurabili (una pulizia voluta passa alzando MAX_DELETE)', () => {
        expect(esegui({ FAKE_PIANO_SOSTITUITI: '10', MAX_SOSTITUITI: '5' }).status).not.toBe(0)
        expect(esegui({ FAKE_PIANO_SOSTITUITI: '10', MAX_SOSTITUITI: '20' }).status).toBe(0)
        expect(esegui({ FAKE_PIANO_CANCELLATI: '600', MAX_DELETE: '700' }).status).toBe(0)
    })

    it('se il piano stesso fallisce, non si va avanti: non si sa che cosa farebbe il sync', () => {
        const r = esegui({ FAKE_PIANO_EXIT: '3' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/piano/i)
        expect(sync()).toHaveLength(0)
    })

    it('il log mostra le FRASI di rclone con i conteggi (che cosa riteneva diverso) senza nessun nome di file', () => {
        const r = esegui({ FAKE_PIANO_COPIE: '12', FAKE_PIANO_SOSTITUITI: '12', FAKE_PIANO_ORARI: '12' })
        expect(r.out).toMatch(/Modification times differ by/)
        expect(r.out).toMatch(/Skipped move as --dry-run/)
        expect(r.out).not.toContain(UUID)
        expect(r.out).not.toMatch(/fatture\/|\.pdf/)
    })

    it('anche quando si ferma, il log del rifiuto porta la forma dei messaggi e nessun nome', () => {
        const r = esegui({ FAKE_PIANO_SOSTITUITI: '650', FAKE_PIANO_ORARI: '650' })
        expect(r.status).not.toBe(0)
        expect((r.out + r.err)).toMatch(/Modification times differ by/)
        expect((r.out + r.err)).not.toContain(UUID)
    })

    it('rifiuta tetti non numerici', () => {
        const r = esegui({ MAX_SOSTITUITI: 'molti' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/numeri/)
    })
})

describe('specchio-storage.sh · bucket esclusi dal backup (scelta del titolare, 06/10)', () => {
    it('senza ESCLUDI_BUCKET non c\'è nessun filtro', () => {
        esegui()
        expect(chiamate().filter((c) => c.includes('--exclude'))).toEqual([])
    })

    it('con ESCLUDI_BUCKET la sorgente, il sync e il controllo finale usano gli STESSI filtri', () => {
        const r = esegui({ ESCLUDI_BUCKET: 'gallery video_originals' })
        expect(r.status).toBe(0)
        const con = chiamate().filter((c) => c.includes('--exclude /gallery/** --exclude /video_originals/**'))
        const comandi = con.map((c) => c.split(' ')[0]).sort()
        // size della sorgente + sync + check; NON la size dello specchio né quella del cestino
        expect(comandi).toEqual(['check', 'size', 'sync', 'sync']) // il piano (dry-run) e il sync vero
        const size = con.find((c) => c.startsWith('size'))!
        expect(size).toContain('SB_FINTO:')
        expect(r.out).toMatch(/esclusi=gallery,video_originals/)
    })

    it('rifiuta un nome di bucket non valido, e non lancia il sync', () => {
        for (const cattivo of ['../x', 'Gallery', 'a/b', '*', 'x;y']) {
            const r = esegui({ ESCLUDI_BUCKET: `gallery ${cattivo}` })
            expect(r.status, cattivo).not.toBe(0)
            expect(r.err, cattivo).toMatch(/ESCLUDI_BUCKET/)
        }
        expect(sync()).toHaveLength(0)
    })

    it('i file esclusi non pesano nella guardia del 90%: la sorgente filtrata è quella che conta', () => {
        // Il finto rclone risponde 100 per ogni size della sorgente; qui si controlla solo che il conteggio
        // della sorgente sia chiesto CON i filtri (altrimenti la guardia confronterebbe mele con pere).
        esegui({ ESCLUDI_BUCKET: 'gallery' })
        const sizeSorgente = chiamate().find((c) => c.startsWith('size') && c.includes('SB_FINTO:'))!
        expect(sizeSorgente).toContain('--exclude /gallery/**')
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
        // quello del sync VERO (il primo è del piano, e lì il dry-run non sposta niente)
        const p = mutato(/--backup-dir "\$CESTINO" \\\n  --max-delete "\$TETTO_RCLONE"/, '--max-delete "$TETTO_RCLONE"')
        esegui({}, p)
        expect(sync()[0]).not.toContain('--backup-dir')
    })

    it('senza --max-delete, una cancellazione di massa passerebbe', () => {
        const p = mutato(/--max-delete "\$TETTO_RCLONE"/, '')
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

    it('senza i filtri sul sync, la galleria verrebbe copiata comunque', () => {
        const p = mutato(/  \$\{FILTRI\[@\]\+"\$\{FILTRI\[@\]\}"\} \\\n  --log-level NOTICE --stats 0 2>&1 \| maschera\nST_SYNC/, '  --log-level NOTICE --stats 0 2>&1 | maschera\nST_SYNC')
        esegui({ ESCLUDI_BUCKET: 'gallery' }, p)
        expect(sync()[0]).not.toContain('--exclude')
    })

    it('senza la validazione dei nomi, un valore con un glob verrebbe usato come filtro', () => {
        const p = mutato(/'' \| \*\[!a-z0-9_-\]\*\) errore/, "'@@@') errore")
        const r = esegui({ ESCLUDI_BUCKET: 'x;y' }, p)
        expect(r.status).toBe(0)
    })

    it('senza la maschera degli uuid, i nomi dei file finirebbero nel log pubblico', () => {
        const p = mutato(/sed -E 's\/\[0-9a-f\]\{8\}[^']*'/, "cat #")
        const r = esegui({ FAKE_SYNC_AVVISO: '1' }, p)
        expect(r.out + r.err).toContain(UUID)
    })
    it('senza il piano, un sync anomalo partirebbe a metà e si fermerebbe sul tetto di rclone', () => {
        // si toglie il rifiuto sul numero di sostituzioni: il sync vero parte comunque
        const p = mutato(/\[ "\$SOSTITUITI" -gt "\$MAX_SOSTITUITI" \]/, 'false')
        esegui({ FAKE_PIANO_SOSTITUITI: '650' }, p)
        expect(sync().length).toBeGreaterThan(0)
    })

    it('senza il rifiuto sulle cancellazioni del piano, una cancellazione di massa partirebbe', () => {
        const p = mutato(/\[ "\$CANCELLATI" -gt "\$MAX_DELETE" \]/, 'false')
        esegui({ FAKE_PIANO_CANCELLATI: '501' }, p)
        expect(sync().length).toBeGreaterThan(0)
    })

    it('senza --dry-run il «piano» sarebbe un secondo sync vero: toccherebbe lo specchio prima di ogni guardia', () => {
        const p = mutato(/--dry-run -vv --max-delete -1/, '-vv --max-delete -1')
        esegui({}, p)
        expect(piano()).toHaveLength(0)
        expect(sync(), 'due sync veri').toHaveLength(2)
    })

    it('senza la finestra sulle date, il sync vero ricopierebbe tutto ciò che differisce di un attimo', () => {
        const p = mutato(/  --max-delete-size "\$MAX_DELETE_SIZE" \\\n  --modify-window "\$FINESTRA_DATE" \\\n/, '  --max-delete-size "$MAX_DELETE_SIZE" \\\n')
        esegui({}, p)
        expect(sync()[0]).not.toContain('--modify-window')
    })

    it('senza la lista bianca sul riepilogo del piano, i nomi dei file finirebbero nel log pubblico', () => {
        const p = mutato(/forma_piano\(\) \{/, 'forma_piano() { cat "$T/piano.log"; return 0;')
        const r = esegui({ FAKE_PIANO_SOSTITUITI: '2' }, p)
        expect(r.out + r.err).toContain('fatture/')
    })
})

describe('specchio-storage.sh · forma', () => {
    it('esiste e la sintassi è valida per bash', () => {
        expect(existsSync(SCRIPT)).toBe(true)
        const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })
        expect(r.status, r.stderr).toBe(0)
    })
})
