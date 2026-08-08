import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK — chi ospita il piede dell'azione contiene anche la sua RISERVA.
 *
 * ─── IL DIFETTO, MISURATO SUL PRODOTTO COMPILATO ────────────────────────────
 * `PiedeAzioneAssenza` toglie il tetto al proprio sollevamento con uno spaziatore
 * alto 200vh e un margine negativo identico sul piede: è ciò che ha chiuso il
 * bloccante R21 (il pulsante «Comunica assenza» coperto dalla barra a ogni altezza
 * di telefono, con il tocco al suo centro che apriva un'altra scheda).
 *
 * «La somma è zero» vale per l'ALTEZZA del contenitore — i pannelli con e senza
 * restano alti uguali al pixel — ma NON per l'area SCORRIBILE: lo spaziatore è un
 * box che sborda oltre il fondo della card, e `scrollHeight` del documento lo
 * conta. Misurato il 2026-08-08 su `next start` con una sessione vera, 390×731:
 *
 *     documento 2147 px con la riserva  ·  1060 px senza
 *
 * cioè, dopo l'elenco, un'altra schermata e mezza di NULLA sotto le dita del
 * genitore. È anche ciò che ha fatto fallire l'ultimo passo del percorso Maestro
 * su iPhone: dopo l'annullamento lo scroll finiva nella coda e non ritrovava più
 * l'elenco — un collaudo rosso per un difetto vero, ma illeggibile.
 *
 * ─── PERCHÉ IL LOCK STA QUI E NON NEL COMPONENTE ────────────────────────────
 * Perché il rimedio (`contain: paint`) va sull'ANTENATO, e un componente non può
 * dichiarare niente sul proprio genitore. È esattamente la forma di difetto che
 * questo ciclo ha pagato tre volte: una regola che vive in un commento invece che
 * in un controllo, e che alla porta accanto non arriva. La terza schermata che
 * monterà il piede dimenticherà la classe, e la coda tornerà in silenzio — la
 * pagina si vede, il pulsante funziona, semplicemente sotto c'è il vuoto.
 */

const CARTELLE = ['src/app/(dashboard)/parent', 'src/components/features/parent']
const CLASSE = 'kv-ospita-piede'

/** Tutti i .tsx sotto le cartelle del genitore. */
function fileTsx(dir: string): string[] {
    const out: string[] = []
    for (const voce of readdirSync(dir)) {
        const p = join(dir, voce)
        if (statSync(p).isDirectory()) out.push(...fileTsx(p))
        else if (p.endsWith('.tsx')) out.push(p)
    }
    return out
}

const MONTANO = CARTELLE.flatMap(fileTsx).filter((f) => /<PiedeAzioneAssenza[\s/>]/.test(readFileSync(f, 'utf8')))

describe('LOCK · la riserva del piede resta dentro chi lo ospita', () => {
    it('c’è almeno una schermata che monta il piede (altrimenti questo lock è vuoto)', () => {
        expect(
            MONTANO.length,
            'nessun file monta più `PiedeAzioneAssenza`: o è stato rimosso, o questo lock non ' +
                'guarda più dove serve',
        ).toBeGreaterThan(0)
    })

    it('ognuna dichiara `kv-ospita-piede` sul contenitore', () => {
        const senza = MONTANO.filter((f) => !readFileSync(f, 'utf8').includes(CLASSE))
        expect(
            senza,
            'queste schermate montano il piede senza contenerne la riserva: lo spaziatore da 200vh ' +
                'sborda e allunga la PAGINA di un\'altra schermata e mezza di vuoto (misurato: ' +
                'documento 2147 px invece di 1060). Aggiungere `kv-ospita-piede` alla card che lo ospita:\n  ' +
                senza.join('\n  '),
        ).toEqual([])
    })

    it('la regola CSS esiste davvero, ed è `contain`', () => {
        const css = readFileSync('src/app/globals.css', 'utf8')
        const i = css.indexOf(`.${CLASSE}`)
        expect(i, `la classe .${CLASSE} non è più definita: le schermate la scrivono a vuoto`).toBeGreaterThan(-1)
        expect(
            css.slice(i, css.indexOf('}', i)),
            'la classe non contiene più il disegno fuori dai bordi: senza `contain` lo spaziatore ' +
                'torna a sbordare, e il markup resterebbe verde',
        ).toContain('contain: paint')
    })

    it('la riserva è ancora accoppiata: spaziatore e margine hanno lo STESSO valore', () => {
        // Se divergessero, il flusso si sposterebbe: il piede lascerebbe un buco
        // (margine più piccolo) o mangerebbe il contenuto sopra (più grande).
        const src = readFileSync('src/components/features/parent/PiedeAzioneAssenza.tsx', 'utf8')
        const h = /spaziatore:\s*'h-\[(\d+vh)\]'/.exec(src)?.[1]
        const m = /margine:\s*'-mt-\[(\d+vh)\]'/.exec(src)?.[1]
        expect(h, 'lo spaziatore non dichiara più un\'altezza in vh').toBeTruthy()
        expect(m, `il margine (${m}) non pareggia più lo spaziatore (${h}): il flusso si sposta`).toBe(h)
    })
})
