// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `scripts/backup/apri-campioni.sh` — «apri 5 file per bucket» della prova di ripristino, senza guardarli.
 *
 * Roadmap di robustezza, fase 2 (D2). Per ogni bucket prende alcuni file dallo specchio cifrato,
 * li decifra e li confronta con l'originale su Supabase: stessa impronta e firma dei primi byte
 * coerente con l'estensione (un PDF che non comincia con `%PDF` è un file rotto, anche se
 * l'impronta fosse uguale perché rotto anche all'origine). Il contenuto di quei file sono foto di
 * bambini, moduli firmati, documenti 104/PEI: lo script NON li mostra, NON stampa i loro nomi
 * (sono uuid ma identificano un documento di una famiglia) e non li salva da nessuna parte.
 *
 * `rclone` qui è FINTO e restituisce contenuti decisi dal test.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'backup', 'apri-campioni.sh')
const NOME_RISERVATO = 'SEGRETO-NOME-FILE'

let radice: string
let finti: string

function creaRcloneFinto() {
    const p = join(finti, 'rclone')
    writeFileSync(p, `#!/bin/bash
cmd="$1"; shift
case "$cmd" in
  lsf)
    case "$*" in
      *--dirs-only*) [ -n "$FAKE_SENZA_BUCKET" ] || { printf 'b1/\\nb2/\\nvuoto/\\n'; if [ -n "$FAKE_CON_ESCLUSO" ]; then printf 'escluso/\\n'; fi; } ;;
      *"SB_FINTO:escluso"*) for i in 1 2; do echo "${NOME_RISERVATO}-$i.pdf"; done ;;
      *"SB_FINTO:b1"*)
        n=7; [ -n "$FAKE_BUCKET_GRANDE" ] && n="$FAKE_BUCKET_GRANDE"
        i=1; while [ "$i" -le "$n" ]; do echo "${NOME_RISERVATO}-$i.pdf"; i=$((i + 1)); done ;;
      *"SB_FINTO:b2"*) for i in 1 2 3; do echo "${NOME_RISERVATO}-$i.jpg"; done ;;
    esac
    ;;
  cat)
    percorso="$1"; shift
    conta=""
    [ "$1" = "--count" ] && conta="$2"
    [ -n "$FAKE_CAT_FALLISCE" ] && case "$percorso" in *"$FAKE_CAT_FALLISCE"*) exit 1 ;; esac
    # un bucket che nello specchio non esiste (escluso dal backup): la lettura dalla copia fallisce
    case "$percorso" in CRIPTO_FINTO:*/escluso/*) exit 1 ;; esac
    case "$percorso" in
      *.pdf) corpo="%PDF-1.4 contenuto-riservato-pdf" ;;
      *.jpg) corpo="$(printf '\\xff\\xd8\\xff')contenuto-riservato-jpg" ;;
    esac
    # una copia "danneggiata": solo nello specchio, per il nome indicato
    case "$percorso" in
      CRIPTO_FINTO:*"$FAKE_DANNEGGIA"*) [ -n "$FAKE_DANNEGGIA" ] && corpo="$corpo-ALTERATO" ;;
    esac
    case "$percorso" in
      CRIPTO_FINTO:*"$FAKE_SENZA_FIRMA"*) [ -n "$FAKE_SENZA_FIRMA" ] && corpo="NON-UN-PDF-NE-UN-JPG" ;;
    esac
    if [ -n "$conta" ]; then printf '%s' "$corpo" | head -c "$conta"; else printf '%s' "$corpo"; fi
    ;;
  *) echo "rclone finto: sottocomando non previsto: $cmd" >&2; exit 99 ;;
esac
`)
    chmodSync(p, 0o755)
}

function esegui(extra: Record<string, string> = {}, script = SCRIPT) {
    const r = spawnSync('bash', [script], {
        encoding: 'utf8',
        // ambiente PULITO (non eredita GITHUB_STEP_SUMMARY & co. del job di CI); NODE_ENV serve ai tipi
        env: {
            NODE_ENV: 'test',
            PATH: `${finti}:${process.env.PATH}`,
            HOME: process.env.HOME ?? '/tmp',
            SORGENTE: 'SB_FINTO:',
            SPECCHIO: 'CRIPTO_FINTO:corrente',
            ...extra,
        },
    })
    return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

beforeEach(() => {
    radice = mkdtempSync(join(tmpdir(), 'campioni-'))
    finti = join(radice, 'finti')
    mkdirSync(finti)
    creaRcloneFinto()
})
afterEach(() => rmSync(radice, { recursive: true, force: true }))

describe('apri-campioni.sh · il giudizio', () => {
    it('file identici e con la firma giusta → riuscita; al massimo 5 per bucket, tutti se sono meno', () => {
        const r = esegui()
        expect(r.err).not.toMatch(/ERRORE/)
        expect(r.status).toBe(0)
        expect(r.out).toMatch(/^CAMPIONE bucket=b1 provati=5 identici=5 diversi=0 firma_errata=0 /m)
        expect(r.out).toMatch(/^CAMPIONE bucket=b2 provati=3 identici=3 diversi=0 firma_errata=0 /m)
        expect(r.out).toMatch(/^RISULTATO provati=8 identici=8 diversi=0 firma_errata=0 non_leggibili=0/m)
    })

    it('un bucket con decine di migliaia di file NON fa morire lo script per SIGPIPE (visto dal vivo il 06/10: codice 141)', () => {
        // Con `set -o pipefail`, `sort -R file | head -n 5` fa morire `sort` quando `head` ha preso le sue 5 righe e
        // chiude la pipe: la pipeline esce 141 e `set -e` ferma lo script. Succede solo se l'elenco è abbastanza
        // lungo da non essere già stato scritto tutto: il rclone finto con 7 file non lo faceva mai.
        const r = esegui({ FAKE_BUCKET_GRANDE: '60000' })
        expect(r.err).not.toMatch(/ERRORE/)
        expect(r.status).toBe(0)
        expect(r.out).toMatch(/^CAMPIONE bucket=b1 provati=5 identici=5 diversi=0 firma_errata=0 /m)
        expect(r.out).toMatch(/^RISULTATO provati=8 /m)
    })

    it('un bucket che non è nello specchio FA FALLIRE il giro (non deve passare inosservato)', () => {
        const r = esegui({ FAKE_CON_ESCLUSO: '1' })
        expect(r.status).not.toBe(0)
        expect(r.out).toMatch(/^CAMPIONE bucket=escluso provati=2 .*non_leggibili=2/m)
    })

    it('ESCLUDI_BUCKET salta i bucket fuori dal backup per scelta del titolare, e lo dice', () => {
        const r = esegui({ FAKE_CON_ESCLUSO: '1', ESCLUDI_BUCKET: 'escluso' })
        expect(r.err).not.toMatch(/ERRORE/)
        expect(r.status).toBe(0)
        expect(r.out).toMatch(/^ESCLUSO bucket=escluso /m)
        expect(r.out).not.toMatch(/^CAMPIONE bucket=escluso/m)
        expect(r.out).toMatch(/^RISULTATO provati=8 /m)
    })

    it('ESCLUDI_BUCKET con un nome non valido → rifiutato prima di fare qualsiasi cosa', () => {
        const r = esegui({ ESCLUDI_BUCKET: 'b1;rm' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/ESCLUDI_BUCKET: «b1;rm» non è un nome di bucket valido/)
        expect(r.out).not.toMatch(/CAMPIONE/)
    })

    it('un bucket vuoto si salta senza errore', () => {
        const r = esegui()
        expect(r.status).toBe(0)
        expect(r.out).not.toMatch(/bucket=vuoto provati=[1-9]/)
    })

    it('se non ha potuto provare nessun file (specchio o sorgente vuoti) NON dice che va bene', () => {
        const r = esegui({ FAKE_SENZA_BUCKET: '1' })
        expect(r.status).not.toBe(0)
        expect(r.err).toMatch(/nessun file provato/)
    })

    it('PER_BUCKET cambia quanti file si provano', () => {
        const r = esegui({ PER_BUCKET: '2' })
        expect(r.out).toMatch(/bucket=b1 provati=2/)
        expect(r.out).toMatch(/bucket=b2 provati=2/)
    })

    it('un file che nello specchio è diverso dall\'originale → fallita', () => {
        const r = esegui({ FAKE_DANNEGGIA: '-1.' , PER_BUCKET: '7' })
        expect(r.status).not.toBe(0)
        expect(r.out).toMatch(/diversi=[1-9]/)
    })

    it('un PDF senza la firma %PDF → fallita, anche se è uguale all\'originale', () => {
        // la firma sbagliata c'è sia nello specchio che nell'originale? No: qui solo nello specchio → diverso E firma errata
        const r = esegui({ FAKE_SENZA_FIRMA: '-2.', PER_BUCKET: '7' })
        expect(r.status).not.toBe(0)
        expect(r.out).toMatch(/firma_errata=[1-9]/)
    })

    it('un file che non si riesce a leggere → fallita, e si conta', () => {
        const r = esegui({ FAKE_CAT_FALLISCE: '-3.', PER_BUCKET: '7' })
        expect(r.status).not.toBe(0)
        expect(r.out).toMatch(/non_leggibili=[1-9]/)
    })
})

describe('apri-campioni.sh · cosa NON deve succedere', () => {
    it('non stampa i nomi dei file né il loro contenuto', () => {
        const r = esegui({ FAKE_DANNEGGIA: '-1.', PER_BUCKET: '7' })
        expect(r.out + r.err).not.toContain(NOME_RISERVATO)
        expect(r.out + r.err).not.toContain('contenuto-riservato')
    })

    it('non salva niente su disco (nessun file temporaneo con il contenuto)', () => {
        esegui()
        const trovati: string[] = []
        const visita = (d: string) => {
            for (const n of readdirSync(d, { withFileTypes: true })) {
                const p = join(d, n.name)
                if (n.isDirectory()) visita(p)
                else if (!p.startsWith(finti) && readFileSync(p, 'utf8').includes('contenuto-riservato')) trovati.push(p)
            }
        }
        visita(radice)
        expect(trovati).toEqual([])
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

    it('senza il confronto delle impronte, un file alterato passerebbe', () => {
        const p = mutato(/\[ "\$H_ORIG" = "\$H_COPIA" \]/, 'true')
        const r = esegui({ FAKE_DANNEGGIA: '-1.', PER_BUCKET: '7' }, p)
        expect(r.out).toMatch(/diversi=0/)
    })

    it('senza il salto dei bucket esclusi, un bucket fuori dal backup farebbe fallire il giro', () => {
        const p = mutato(/\*" \$b "\*\) echo "ESCLUSO[^\n]*\n/, '*" $b "*) : ;;\n')
        const r = esegui({ FAKE_CON_ESCLUSO: '1', ESCLUDI_BUCKET: 'escluso' }, p)
        expect(r.status).not.toBe(0)
        expect(r.out).toMatch(/bucket=escluso provati=2 .*non_leggibili=2/)
    })

    it('senza il controllo della firma, un PDF che non lo è passerebbe', () => {
        const p = mutato(/\[ "\$FIRMA_OK" = "1" \]/, 'true')
        const r = esegui({ FAKE_SENZA_FIRMA: '-2.', PER_BUCKET: '7' }, p)
        expect(r.out).toMatch(/firma_errata=0/)
    })
})

describe('apri-campioni.sh · forma', () => {
    it('esiste e la sintassi è valida per bash', () => {
        expect(existsSync(SCRIPT)).toBe(true)
        const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })
        expect(r.status, r.stderr).toBe(0)
    })
})
