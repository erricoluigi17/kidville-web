import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import { AvvisoCard, type Avviso } from '@/components/features/avvisi/AvvisoCard'
import itAvvisi from '../../messages/it/avvisi.json'

expect.extend(toHaveNoViolations)

// =============================================================================
// S18 — la bacheca degli avvisi DICE se una card è aperta o chiusa.
//
// Il difetto misurato dal collaudo di accessibilità del 2026-08-02: le card si
// aprono e si chiudono, ma non lo annunciano. Chi usa uno screen reader mette il
// focus sulla card, preme Invio, il corpo dell'avviso compare sotto — e
// l'annuncio resta identico: «pulsante». Su /teacher/avvisi gli elementi con
// `aria-expanded` erano UNO in tutta la pagina, ed era il menu della bottom-nav:
// nessuna delle nove card ce l'aveva. Il componente è condiviso, quindi la stessa
// cecità valeva per la bacheca del GENITORE, cioè per la funzione con cui le
// famiglie leggono le circolari della scuola.
//
// Perché nessun test lo vedeva. Il ciclo precedente aveva lavorato sulla
// semantica del titolo della card (h3 → h2, lock in `semantica-schermate-chiave`),
// ma quel lock guarda il LIVELLO dell'intestazione: il livello era giusto, e lo
// resta anche con lo stato non annunciato. Un lock che misura una proprietà non
// ne sorveglia un'altra — e qui c'era anche un secondo difetto, invisibile a
// entrambi: l'`<h2>` stava DENTRO il `<button>`. Il content model di `<button>`
// ammette solo phrasing content; un'intestazione annidata è HTML non valido e
// diversi screen reader appiattiscono il contenuto del bottone in un'unica
// etichetta, vanificando proprio la correzione h3 → h2 appena fatta.
//
// METODO. Le asserzioni guardano il DOM RESO del componente vero, non il
// sorgente, e ogni negativa ha accanto la positiva che cadrebbe per prima
// (se la card smettesse di rendere qualcosa, «non c'è il difetto» passerebbe
// da solo). Il pattern di riferimento è il disclosure di ARIA APG:
// intestazione → bottone con `aria-expanded` e `aria-controls` → pannello.
// =============================================================================

afterEach(cleanup)

/** Dati inventati: nessun contenuto reale di famiglie o bambini nei test. */
const AVVISO: Avviso = {
    id: 'avv-disclosure-1',
    author_id: 'aut-1',
    titolo: 'TEST Uscita al parco',
    contenuto: 'TEST corpo della comunicazione, visibile solo da aperto.',
    tipo: 'presa_visione',
    target_scope: 'globale',
    target_classes: null,
    scadenza: null,
    attachment_url: null,
    created_at: '2026-08-01T08:00:00.000Z',
    author: { first_name: 'TEST', last_name: 'Docente', role: 'educator' },
    stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
}

/** Il controllo che apre la card: si cerca per RUOLO e per NOME, come uno screen reader. */
const bottoneDellaCard = () => screen.getByRole('button', { name: AVVISO.titolo })

describe('S18 · AvvisoCard — il disclosure annuncia il proprio stato', () => {
    it('da chiusa dichiara `aria-expanded="false"` (e il corpo non è nel DOM)', () => {
        render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)

        const bottone = bottoneDellaCard()
        expect(bottone).toHaveAttribute('aria-expanded', 'false')
        // Controllo positivo: la card è davvero chiusa — senza, l'asserzione
        // sopra passerebbe anche su un componente che non apre più niente.
        expect(screen.queryByText(AVVISO.contenuto)).not.toBeInTheDocument()
    })

    it('dopo Invio dichiara `aria-expanded="true"`, e il corpo compare', () => {
        render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)

        fireEvent.click(bottoneDellaCard())

        expect(bottoneDellaCard()).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText(AVVISO.contenuto)).toBeInTheDocument()
    })

    it('richiudendola torna a dichiararsi chiusa', () => {
        render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)

        fireEvent.click(bottoneDellaCard())
        expect(bottoneDellaCard()).toHaveAttribute('aria-expanded', 'true')

        fireEvent.click(bottoneDellaCard())
        expect(bottoneDellaCard()).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText(AVVISO.contenuto)).not.toBeInTheDocument()
    })

    it('`aria-controls` punta al pannello che apre DAVVERO, non a un id qualsiasi', () => {
        render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)

        const id = bottoneDellaCard().getAttribute('aria-controls')
        expect(id, 'il bottone non dichiara quale pannello governa').toBeTruthy()

        fireEvent.click(bottoneDellaCard())

        // `getElementById`, non un selettore CSS: `useId()` produce id con
        // caratteri che un selettore dovrebbe escapare.
        const pannello = document.getElementById(String(id))
        expect(pannello, `nessun elemento con id «${id}» nel documento`).not.toBeNull()
        // …ed è il pannello GIUSTO: contiene il corpo dell'avviso.
        expect(pannello?.textContent).toContain(AVVISO.contenuto)
    })

    it('lo STESSO avviso mostrato due volte non genera due id uguali', () => {
        // Il caso vero: la comunicazione in cima alla bacheca è la stessa che
        // compare nell'anteprima della home. Se l'id del pannello nascesse da
        // `avviso.id`, i due pannelli aperti avrebbero lo stesso id e
        // `aria-controls` diventerebbe ambiguo — un riferimento che punta a due
        // elementi non punta a nessuno dei due.
        // (Questa prova è nata da un falso verde: la prima versione montava due
        // avvisi DIVERSI, e passava anche con l'id derivato dall'avviso.)
        render(
            <>
                <AvvisoCard avviso={AVVISO} index={0} isTeacher />
                <AvvisoCard avviso={AVVISO} index={1} isTeacher />
            </>,
        )

        const bottoni = screen.getAllByRole('button', { name: AVVISO.titolo })
        // Controllo positivo: le card montate sono davvero due.
        expect(bottoni).toHaveLength(2)

        const id = bottoni.map((b) => b.getAttribute('aria-controls'))
        expect(id[0]).toBeTruthy()
        expect(id[1]).toBeTruthy()
        expect(id[0]).not.toBe(id[1])

        // …e aprendole entrambe, ogni id resta di un solo elemento.
        bottoni.forEach((b) => fireEvent.click(b))
        for (const x of id) {
            expect(document.querySelectorAll(`[id="${x}"]`), `id «${x}» duplicato nel documento`).toHaveLength(1)
        }
    })

    it('è un `type="button"`: dentro un form non lo invia', () => {
        render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)

        expect(bottoneDellaCard()).toHaveAttribute('type', 'button')
    })
})

// =============================================================================
describe('S18 · AvvisoCard — l\'intestazione avvolge il bottone, non il contrario', () => {
    it('il titolo resta un `h2` e CONTIENE il controllo (pattern APG)', () => {
        render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)

        const titolo = screen.getByRole('heading', { level: 2, name: AVVISO.titolo })
        const bottone = bottoneDellaCard()
        // L'intestazione avvolge il controllo…
        expect(titolo.contains(bottone), 'l\'`h2` non avvolge il bottone').toBe(true)
        // …e non viceversa: un heading dentro un button è HTML non valido.
        expect(bottone.contains(titolo)).toBe(false)
    })

    it('nel `<button>` non finisce contenuto di flusso (solo phrasing content)', () => {
        render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)

        const vietati = bottoneDellaCard().querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,ul,ol,li,section,article')
        expect(
            Array.from(vietati).map((e) => e.tagName.toLowerCase()),
            'contenuto di flusso dentro il bottone: HTML non valido, e gli screen reader appiattiscono l\'etichetta',
        ).toEqual([])
    })

    it('il nome accessibile del controllo è il TITOLO, non tutta la testata', () => {
        render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)

        // Controllo positivo: la testata mostra davvero anche gli altri dati —
        // che però NON devono confluire nell'etichetta del bottone, altrimenti
        // l'annuncio diventa «Comunicazione 2 giorni fa TEST Uscita al parco…».
        expect(screen.getByText(itAvvisi.badgeComunicazione)).toBeInTheDocument()
        expect(screen.getByText('TEST Docente', { exact: false })).toBeInTheDocument()

        expect(bottoneDellaCard()).toHaveAccessibleName(AVVISO.titolo)
    })

    it('l\'area di tocco resta TUTTA la testata, non le sole lettere del titolo', () => {
        // Su un telefono la card si apre toccandola ovunque: restringere il
        // bersaglio al testo del titolo sarebbe una regressione d'uso mentre si
        // corregge l'accessibilità. Il bottone si estende con uno pseudo-elemento
        // sopra la testata posizionata (`relative`), che in jsdom non ha layout:
        // qui si verifica il contratto delle classi che lo producono.
        const { container } = render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)

        const bottone = bottoneDellaCard()
        expect(bottone.className, 'il bottone non si estende sulla testata').toContain('after:absolute')
        expect(bottone.className).toContain('after:inset-0')

        const testata = container.querySelector('[data-kv-testata-avviso]')
        expect(testata, 'la testata non è marcata: lo pseudo-elemento non ha un riferimento').not.toBeNull()
        expect(testata?.className, 'la testata non è il riferimento di posizionamento').toContain('relative')
        expect(testata?.contains(bottone)).toBe(true)

        // Il troncamento del titolo lungo NON sta sul bottone: `truncate` porta
        // `overflow: hidden`, e mettere su un elemento che ritaglia i propri
        // discendenti lo pseudo-elemento che allarga l'area di tocco farebbe
        // dipendere il bersaglio da una regola di clipping sottile. Sta su uno
        // `span` interno — che resta phrasing content.
        expect(bottone.className, 'il bottone ritaglia: l\'area di tocco dipende dal clipping').not.toContain('truncate')
        const testo = bottone.querySelector('span')
        expect(testo, 'manca lo span che tronca il titolo').not.toBeNull()
        expect(testo?.className, 'un titolo lungo sfonderebbe la testata').toContain('truncate')
        expect(testo?.textContent).toBe(AVVISO.titolo)
    })
})

// =============================================================================
describe('S18 · AvvisoCard — niente regressioni sul comportamento', () => {
    it('aprendo la card il genitore segna la lettura, una volta sola', () => {
        const onReadReceipt = vi.fn()
        render(<AvvisoCard avviso={AVVISO} index={0} onReadReceipt={onReadReceipt} />)

        fireEvent.click(bottoneDellaCard())

        expect(onReadReceipt).toHaveBeenCalledWith(AVVISO.id)
    })

    it('axe non trova violazioni, né da chiusa né da aperta', async () => {
        // Le regole di livello DOCUMENTO non si applicano a un componente isolato
        // in jsdom (stesso rule-set di `smoke.axe.test.tsx`).
        const opzioni = {
            rules: {
                region: { enabled: false },
                'landmark-one-main': { enabled: false },
                'page-has-heading-one': { enabled: false },
            },
        }
        const { container } = render(<AvvisoCard avviso={AVVISO} index={0} isTeacher />)

        expect(await axe(container, opzioni)).toHaveNoViolations()

        fireEvent.click(bottoneDellaCard())
        expect(await axe(container, opzioni)).toHaveNoViolations()
    })
})
