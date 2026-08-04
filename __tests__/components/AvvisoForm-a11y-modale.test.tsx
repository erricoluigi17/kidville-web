import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { useRef, useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

import itTeacher from '../../messages/it/teacherComunicazioni.json'
import itShared from '../../messages/it/shared.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

// =============================================================================
// `AvvisoForm` — la modale esiste anche per chi non la vede.
//
// Il difetto misurato su Android e iOS: il contenitore non aveva `role="dialog"`,
// né `aria-modal`, né `aria-labelledby`, né focus-trap. Per TalkBack la modale
// semplicemente NON c'era: l'albero di accessibilità continuava a esporre la
// pagina sotto. Il bottone di chiusura era 32×32 px (sotto il minimo touch) e
// senza `aria-label`: muto per chi non vede l'icona. E la modale stava a `z-50`,
// lo stesso piano della bottom-nav, che le copriva il bottone «Pubblica avviso».
//
// METODO. Le asserzioni qui NON sono «non è fallito»: si asserisce DOVE finisce
// il focus (elemento esatto), QUALE nodo etichetta il dialog (il titolo vero) e
// che il numero di z-index sia STRETTAMENTE maggiore di quello che le barre fisse
// dichiarano davvero nel sorgente. Il controllo positivo è la prima prova: a
// modale CHIUSA la pagina sotto deve essere raggiungibile — senza quello, un
// test che verifica «lo sfondo non è raggiungibile» passerebbe anche su una
// pagina che non carica affatto.
//
// -----------------------------------------------------------------------------
// PERCHÉ QUESTO LOCK ERA VERDE MENTRE TRE TESTER SEGNALAVANO LA STESSA MODALE
// (collaudo 2026-07-31: design F2, frontend F2, iOS F1).
//
// Il blocco finale confrontava il piano della modale con **le sole tre
// bottom-nav** (z-50). Il difetto vero era simmetrico e stava in ALTO: la topbar
// verde del cockpit (`kv-admin-topbar`, z-105) e la sidebar (z-105) coprivano il
// bordo superiore del dialogo — su iPhone il tap sulla ✕ finiva sulla campanella
// delle notifiche (`elementFromPoint` → `HEADER.kv-admin-topbar`).
//
// Misurato prima di riscrivere questo file: rimettendo `z-[80]` in
// `src/components/ui/Modal.tsx` — cioè il difetto esatto dei tre report — il lock
// restava **verde, 10 test su 10**, perché 80 > 50. Il lock non guardava la
// regola («la modale sta sopra ogni superficie fissa»): guardava il difetto del
// giorno prima («la bottom-nav copriva il bottone Pubblica»), e un elenco di tre
// file scritto a mano non è cresciuto quando è nato il chrome del cockpit.
//
// COME È STATO CHIUSO. Non allungando la lista a mano — sarebbe lo stesso vizio,
// solo posticipato. L'inventario delle superfici fisse si RICAVA dal sorgente
// (`fixed`/`sticky` + un piano dichiarato, in `src/`), la regola è «nessuna
// superficie fissa arriva al piano della modale» e le eccezioni sono elencate
// UNA PER UNA con la ragione scritta. Una superficie nuova che nasce sopra la
// modale fa fallire il lock finché qualcuno non dichiara perché deve stare lì.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

import { AvvisoForm, type ClasseAvviso, type DatiAvviso, type EsitoInvioAvviso } from '@/components/features/avvisi/AvvisoForm'
import type { Avviso } from '@/components/features/avvisi/AvvisoCard'

const CLASSI: ClasseAvviso[] = [
    { id: 'sez-a-2anni', nome: '2 ANNI', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
]

/** Un avviso già archiviato — dati inventati, nessuna PII. */
const AVVISO_ESISTENTE: Avviso = {
    id: 'avv-1',
    author_id: 'aut-1',
    titolo: 'Uscita anticipata',
    contenuto: 'Domani si esce alle 12.',
    tipo: 'presa_visione',
    target_scope: 'globale',
    target_classes: [],
    scadenza: null,
    attachment_url: null,
    created_at: '2026-07-31T08:00:00.000Z',
    author: { first_name: 'Nome', last_name: 'Cognome', role: 'segreteria' },
    stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
}

const SFONDO_TRIGGER = 'Nuovo avviso'
const SFONDO_ALTRO = 'Filtro della pagina'

/**
 * Una pagina finta con DUE controlli di sfondo e la modale dentro: senza lo
 * sfondo non si può dimostrare né che a modale chiusa è raggiungibile, né che a
 * modale aperta il Tab non ci finisce sopra.
 */
function Pagina({ onSubmit }: { onSubmit?: (d: DatiAvviso) => Promise<EsitoInvioAvviso> } = {}) {
    const [open, setOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement>(null)
    return (
        <>
            <button ref={triggerRef} onClick={() => setOpen(true)}>{SFONDO_TRIGGER}</button>
            <button>{SFONDO_ALTRO}</button>
            <AvvisoForm
                open={open}
                onClose={() => setOpen(false)}
                onSubmit={onSubmit ?? (async () => ({ ok: true }))}
                availableClasses={CLASSI}
            />
        </>
    )
}

const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

const focusabili = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))

const apri = () => fireEvent.click(screen.getByRole('button', { name: SFONDO_TRIGGER }))

describe('AvvisoForm — controllo positivo: a modale CHIUSA la pagina sotto è viva', () => {
    it('nessun dialog, e i controlli di sfondo sono nell’albero e prendono il focus', () => {
        render(<Pagina />)
        expect(screen.queryByRole('dialog')).toBeNull()

        const trigger = screen.getByRole('button', { name: SFONDO_TRIGGER })
        const altro = screen.getByRole('button', { name: SFONDO_ALTRO })
        altro.focus()
        expect(document.activeElement).toBe(altro)
        trigger.focus()
        expect(document.activeElement).toBe(trigger)
        // E il Tab non è intercettato da nessuno: nessun trap attivo a riposo.
        fireEvent.keyDown(document, { key: 'Tab' })
        expect(document.activeElement).toBe(trigger)
    })
})

describe('AvvisoForm — la modale è esposta all’albero di accessibilità', () => {
    it('role="dialog" + aria-modal + aria-labelledby che punta al TITOLO vero', () => {
        render(<Pagina />)
        apri()

        const dialog = screen.getByRole('dialog')
        expect(dialog).toHaveAttribute('aria-modal', 'true')

        const labelledBy = dialog.getAttribute('aria-labelledby')
        expect(labelledBy).toBeTruthy()
        const titolo = document.getElementById(labelledBy as string)
        expect(titolo).not.toBeNull()
        // Non un id qualsiasi: l'intestazione che l'operatore legge a schermo.
        expect(titolo).toBe(screen.getByRole('heading', { name: itTeacher.formTitoloNuovo }))
        expect(titolo?.textContent).toBe(itTeacher.formTitoloNuovo)
    })

    it('in modifica l’etichetta accessibile segue il titolo «modifica»', () => {
        render(
            <AvvisoForm
                open
                onClose={vi.fn()}
                onSubmit={async () => ({ ok: true })}
                availableClasses={CLASSI}
                initialAvviso={AVVISO_ESISTENTE}
            />,
        )
        const dialog = screen.getByRole('dialog')
        const titolo = document.getElementById(dialog.getAttribute('aria-labelledby') as string)
        expect(titolo?.textContent).toBe(itTeacher.formTitoloModifica)
    })
})

describe('AvvisoForm — il focus entra, resta dentro e torna indietro', () => {
    it('all’apertura il focus entra nella modale (non resta sul bottone della pagina)', () => {
        render(<Pagina />)
        const trigger = screen.getByRole('button', { name: SFONDO_TRIGGER })
        trigger.focus()
        apri()

        const dialog = screen.getByRole('dialog')
        expect(dialog.contains(document.activeElement)).toBe(true)
        expect(document.activeElement).toBe(focusabili(dialog)[0])
    })

    it('Tab dall’ULTIMO controllo torna al PRIMO: non esce sullo sfondo', () => {
        render(<Pagina />)
        apri()
        const dialog = screen.getByRole('dialog')
        const controlli = focusabili(dialog)
        expect(controlli.length).toBeGreaterThan(1)

        const ultimo = controlli[controlli.length - 1]
        ultimo.focus()
        expect(document.activeElement).toBe(ultimo)

        fireEvent.keyDown(document, { key: 'Tab' })
        // Asserzione POSITIVA sull'elemento esatto, non «non è lo sfondo».
        expect(document.activeElement).toBe(controlli[0])
        expect(dialog.contains(document.activeElement)).toBe(true)
    })

    it('Shift+Tab dal PRIMO torna all’ULTIMO', () => {
        render(<Pagina />)
        apri()
        const dialog = screen.getByRole('dialog')
        const controlli = focusabili(dialog)

        controlli[0].focus()
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
        expect(document.activeElement).toBe(controlli[controlli.length - 1])
    })

    it('Esc chiude la modale e restituisce il focus al bottone che l’ha aperta', () => {
        render(<Pagina />)
        const trigger = screen.getByRole('button', { name: SFONDO_TRIGGER })
        trigger.focus()
        apri()
        expect(screen.getByRole('dialog')).toBeInTheDocument()

        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(document.activeElement).toBe(trigger)
    })
})

describe('AvvisoForm — il bottone di chiusura', () => {
    it('ha un nome accessibile e un’area toccabile di almeno 44×44', () => {
        render(<Pagina />)
        apri()
        // Prima del fix questo bottone NON aveva alcun nome accessibile: la query
        // per nome falliva, ed è esattamente il difetto misurato con TalkBack.
        const chiudi = screen.getByRole('button', { name: itShared.chiudi })
        expect(chiudi).toHaveAttribute('aria-label', itShared.chiudi)
        // jsdom non fa layout: il minimo touch si verifica sulle classi dichiarate.
        expect(chiudi.className).toMatch(/(^|\s)min-w-\[44px\](\s|$)/)
        expect(chiudi.className).toMatch(/(^|\s)min-h-\[44px\](\s|$)/)
    })

    it('chiude davvero la modale', () => {
        render(<Pagina />)
        apri()
        fireEvent.click(screen.getByRole('button', { name: itShared.chiudi }))
        expect(screen.queryByRole('dialog')).toBeNull()
    })
})

// =============================================================================
// IL PIANO DELLA MODALE — contro TUTTE le superfici fisse, non solo le bottom-nav
// =============================================================================

/** Una superficie fissa: dove sta, a che riga, e a che piano si dichiara. */
interface Superficie {
    file: string
    riga: number
    z: number
    testo: string
}

/** La primitiva stessa: è il metro, non un concorrente. */
const LA_PRIMITIVA = 'src/components/ui/Modal.tsx'

/**
 * Le barre che l'inventario DEVE contenere. È il controllo positivo del parser:
 * il giorno in cui una barra cambia forma (classe spostata in CSS, `sticky` reso
 * condizionale, file rinominato) l'inventario smetterebbe di vederla e il lock
 * tornerebbe verde per vuoto — cioè il modo esatto in cui i lock muoiono.
 */
const BARRE_ATTESE: ReadonlyArray<readonly [string, string]> = [
    ['src/components/features/admin/AdminTopBarMobile.tsx', 'topbar verde del cockpit (mobile) — quella che copriva la ✕'],
    ['src/components/features/admin/AdminSidebar.tsx', 'sidebar del cockpit (desktop)'],
    ['src/components/features/admin/AdminTopBar.tsx', 'topbar del cockpit (desktop)'],
    ['src/components/features/admin/AdminMenuSheet.tsx', 'foglio «Menu» del cockpit'],
    ['src/components/features/admin/AdminBottomNav.tsx', 'bottom-nav del cockpit'],
    ['src/components/features/teacher/TeacherBottomNav.tsx', 'bottom-nav del docente'],
    ['src/components/features/parent/BottomNav.tsx', 'bottom-nav del genitore'],
    ['src/components/features/shell/AppBar.tsx', 'AppBar docente/genitore'],
]

/**
 * Le UNICHE superfici ammesse SOPRA la modale, con la ragione scritta.
 * Non si allunga per comodità: ogni voce qui è una finestra che può coprire un
 * dialogo aperto, e va difesa a parole prima che a numeri.
 */
const SOPRA_LA_MODALE: Readonly<Record<string, string>> = {
    'src/components/providers/BiometricGate.tsx':
        'il velo biometrico deve coprire TUTTO, dialoghi compresi: ad app bloccata non si devono leggere i dati sotto',
    'src/components/ui/PageLoader.module.css':
        'il loader globale di pagina copre la navigazione in corso: se restasse sotto una modale, si vedrebbe mezza schermata cambiare',
    'src/components/providers/ChunkErrorBoundary.tsx':
        'il pannello «un pezzo del programma non è arrivato» (z-9998): quando manca un chunk, il ' +
        'codice che chiuderebbe il dialogo aperto è proprio quello che non è arrivato — una modale ' +
        'sopra questo pannello sarebbe una finestra che non si può più chiudere. Sta sotto al solo ' +
        'gate biometrico (9999), che protegge i dati di un minore e viene prima di un guasto tecnico',
}

/**
 * Superfici ammesse allo STESSO piano della modale (mai oltre): pillole di
 * conferma effimere, che devono restare leggibili mentre un dialogo è aperto.
 */
const AL_PIANO_DELLA_MODALE: Readonly<Record<string, string>> = {
    'src/app/(dashboard)/admin/protocolli/page.tsx':
        'pillola «protocollo salvato» (toast effimero, in basso a destra)',
    'src/components/features/admin/FamilyRegistryManager.tsx':
        'pillola di esito del salvataggio anagrafica (toast effimero, in alto al centro)',
}

/**
 * Commenti via: `Modal.tsx` CITA i piani del chrome (105, 110, 80) per spiegarsi,
 * e un piano citato non è una superficie.
 *
 * I BLOCCHI `/*…*\/` SI SVUOTANO SENZA TOGLIERE GLI A-CAPO. Collassandoli, il lock
 * indicava `AdminTopBarMobile.tsx:17` per una barra che sta alla riga 39: chi legge
 * il fallimento apre il file e non trova niente. Un lock che manda a caccia nel
 * posto sbagliato si smette di credere alla seconda volta.
 */
function senzaCommenti(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (blocco) => blocco.replace(/[^\n]/g, ' '))
        .split('\n')
        .map((r) => (/^\s*(\/\/|\*)/.test(r) ? '' : r.replace(/\s\/\/.*$/, '')))
        .join('\n')
}

const POSIZIONE_FISSA = /(?:^|["'`\s])(?:[a-z0-9-]+:)*(?:fixed|sticky)(?:["'`\s]|$)|position:\s*(?:fixed|sticky)/
const PIANO = /(?:^|["'`\s])(?:[a-z0-9-]+:)*z-\[?(\d+)\]?(?:["'`\s]|$)|z-index:\s*(\d+)/g

function sorgenti(dir: string, out: string[] = []): string[] {
    for (const voce of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, voce.name)
        if (voce.isDirectory()) sorgenti(p, out)
        else if (/\.(tsx?|css)$/.test(voce.name)) out.push(p)
    }
    return out
}

/**
 * L'inventario delle superfici fisse di `src/`.
 *
 * GENEROSO DI PROPOSITO: basta che il file dichiari da qualche parte `fixed` o
 * `sticky` perché TUTTI i suoi piani entrino nel conto. Un parser fine (solo la
 * z che sta nella stessa class-string del `fixed`) perderebbe i template literal
 * su più righe e le classi composte — e un lock cieco è peggio di nessun lock.
 * Il prezzo è qualche riga di dichiarazione in più, e si paga UNA volta.
 */
function inventarioSuperficiFisse(): Superficie[] {
    const out: Superficie[] = []
    for (const file of sorgenti('src')) {
        const grezzo = readFileSync(path.resolve(process.cwd(), file), 'utf8')
        const src = senzaCommenti(grezzo)
        if (!POSIZIONE_FISSA.test(src)) continue
        src.split('\n').forEach((riga, i) => {
            PIANO.lastIndex = 0
            let m: RegExpExecArray | null
            while ((m = PIANO.exec(riga))) {
                out.push({ file, riga: i + 1, z: Number(m[1] ?? m[2]), testo: riga.trim().slice(0, 100) })
            }
        })
    }
    return out
}

const INVENTARIO = inventarioSuperficiFisse()

/**
 * La regola, in forma di funzione pura: nessuna superficie fissa arriva al piano
 * della modale, salvo le eccezioni dichiarate. Pura perché il lock deve poter
 * essere messo alla prova col difetto di ieri (`zModale = 80`) senza toccare il
 * codice di produzione — vedi l'ultimo test di questo file.
 */
function superficiSopraLaModale(zModale: number, inventario: Superficie[]): string[] {
    const fuori: string[] = []
    for (const s of inventario) {
        if (s.file === LA_PRIMITIVA || s.file in SOPRA_LA_MODALE) continue
        const limite = s.file in AL_PIANO_DELLA_MODALE ? zModale : zModale - 1
        if (s.z > limite) {
            fuori.push(`${s.file}:${s.riga} dichiara z-${s.z} contro z-${zModale} della modale → «${s.testo}»`)
        }
    }
    return fuori
}

/** Il piano della modale come lo rende il browser: dal dialogo si risale al contenitore `fixed`. */
function zDellaModaleRenderizzata(): number {
    const dialog = screen.getByRole('dialog')
    let nodo: HTMLElement | null = dialog.parentElement
    while (nodo) {
        if (/(^|\s)fixed(\s|$)/.test(nodo.className)) {
            const z = Number(/(?:^|\s)z-\[?(\d+)\]?/.exec(nodo.className)?.[1])
            expect(Number.isFinite(z)).toBe(true)
            return z
        }
        nodo = nodo.parentElement
    }
    throw new Error('la modale non ha nessun antenato `fixed`: non è più un piano sovrapposto')
}

describe('AvvisoForm — l’inventario delle superfici fisse vede davvero le barre', () => {
    it('le otto barre dell’app sono nell’inventario, con un piano dichiarato', () => {
        for (const [file, cosa] of BARRE_ATTESE) {
            const piani = INVENTARIO.filter((s) => s.file === file).map((s) => s.z)
            // Se il parser smettesse di vedere una barra, tutto il resto di questo
            // blocco diventerebbe verde per vuoto: è la prova che deve cadere per prima.
            expect(piani.length, `${cosa}: nessun piano trovato in ${file}`).toBeGreaterThan(0)
            expect(Math.max(...piani), `${cosa}: piano irrisorio`).toBeGreaterThanOrEqual(30)
        }
    })

    it('ogni riga citata dall’inventario esiste nel file vero e contiene quel piano', () => {
        // Il lock parla per indirizzi: `file:riga`. Se l'indirizzo è sbagliato, chi
        // legge il fallimento apre il file, non trova niente e smette di crederci.
        const cache = new Map<string, string[]>()
        for (const s of INVENTARIO) {
            if (!cache.has(s.file)) {
                cache.set(s.file, readFileSync(path.resolve(process.cwd(), s.file), 'utf8').split('\n'))
            }
            const riga = cache.get(s.file)?.[s.riga - 1] ?? ''
            expect(riga, `${s.file}:${s.riga} non contiene il piano z-${s.z}`).toMatch(
                new RegExp(`z-\\[?${s.z}\\]?(?![0-9])|z-index:\\s*${s.z}(?![0-9])`),
            )
        }
    })

    it('il chrome del cockpit sta davvero in alto nella scala (≥ 105)', () => {
        const chrome = INVENTARIO.filter((s) =>
            /Admin(TopBarMobile|Sidebar|MenuSheet)\.tsx$/.test(s.file),
        ).map((s) => s.z)
        // Controllo positivo del confronto che segue: senza questo, un inventario
        // vuoto renderebbe «la modale sta sopra tutti» vero per assenza di tutti.
        expect(Math.max(...chrome)).toBeGreaterThanOrEqual(105)
    })
})

describe('AvvisoForm — la modale sta sopra OGNI superficie fissa', () => {
    it('nessuna superficie fissa non dichiarata raggiunge il piano della modale', () => {
        render(<Pagina />)
        apri()
        const zModale = zDellaModaleRenderizzata()

        // Il piano reso a schermo e quello scritto nella primitiva devono coincidere:
        // altrimenti si starebbe misurando una modale diversa da quella che si spedisce.
        const dichiarato = Math.max(
            ...INVENTARIO.filter((s) => s.file === LA_PRIMITIVA).map((s) => s.z),
        )
        expect(zModale).toBe(dichiarato)

        expect(
            superficiSopraLaModale(zModale, INVENTARIO),
            'Una superficie fissa arriva al piano della modale e le coprirà i bordi (è il difetto di design F2 / frontend F2 / iOS F1). ' +
                'Se è voluto, dichiarala qui sopra in SOPRA_LA_MODALE o in AL_PIANO_DELLA_MODALE con la ragione scritta; altrimenti abbassale il piano.',
        ).toEqual([])
    })

    it('le eccezioni dichiarate esistono davvero e rispettano la propria regola', () => {
        render(<Pagina />)
        apri()
        const zModale = zDellaModaleRenderizzata()

        for (const file of Object.keys(SOPRA_LA_MODALE)) {
            const piani = INVENTARIO.filter((s) => s.file === file).map((s) => s.z)
            // Un'allowlist che nomina file inesistenti è una bugia che invecchia in
            // silenzio: se la superficie non c'è più, la riga va tolta.
            expect(piani.length, `eccezione morta: ${file} non è più una superficie fissa`).toBeGreaterThan(0)
            expect(Math.max(...piani), `${file} è dichiarato SOPRA ma non lo è`).toBeGreaterThan(zModale)
        }
        for (const file of Object.keys(AL_PIANO_DELLA_MODALE)) {
            const piani = INVENTARIO.filter((s) => s.file === file).map((s) => s.z)
            expect(piani.length, `eccezione morta: ${file} non è più una superficie fissa`).toBeGreaterThan(0)
            expect(Math.max(...piani), `${file} è dichiarato al piano della modale ma la supera`).toBeLessThanOrEqual(zModale)
        }
    })
})

describe('AvvisoForm — la topbar non resta viva dietro il dialogo', () => {
    /** Il guscio del cockpit: la barra verde è un fratello del ramo che contiene la modale. */
    function PaginaCockpit() {
        const [open, setOpen] = useState(false)
        return (
            <div data-kv-shell>
                <header className="kv-admin-topbar">
                    <button>Notifiche</button>
                </header>
                <main>
                    <button onClick={() => setOpen(true)}>{SFONDO_TRIGGER}</button>
                    <AvvisoForm
                        open={open}
                        onClose={() => setOpen(false)}
                        onSubmit={async () => ({ ok: true })}
                        availableClasses={CLASSI}
                    />
                </main>
            </div>
        )
    }

    it('a modale chiusa la campanella è viva (controllo positivo), aperta è inerte', () => {
        render(<PaginaCockpit />)
        const campanella = screen.getByRole('button', { name: 'Notifiche' })
        campanella.focus()
        expect(document.activeElement).toBe(campanella)
        expect(campanella.closest('[inert]')).toBeNull()

        apri()
        // Il piano (z) risolve il tocco; questo risolve l'altra metà del rilievo iOS:
        // con `aria-modal` su un div la barra restava anche NELL'ALBERO di
        // accessibilità, e con TalkBack lo swipe ci finiva sopra.
        expect(campanella.closest('[inert]')).not.toBeNull()
        expect(screen.getByRole('dialog').closest('[inert]')).toBeNull()

        fireEvent.keyDown(document, { key: 'Escape' })
        expect(campanella.closest('[inert]')).toBeNull()
    })
})

describe('AvvisoForm — il lock sa fallire: col piano di ieri nomina la barra che copre', () => {
    it('a z-80 (il difetto misurato) il lock cade e nomina topbar, sidebar e foglio Menu', () => {
        // `80` non è un numero qualsiasi: è il piano che la primitiva aveva durante
        // il collaudo del 31/07, quando design F2, frontend F2 e iOS F1 hanno
        // riportato la stessa modale coperta — e questo file era verde.
        const fuori = superficiSopraLaModale(80, INVENTARIO)
        expect(fuori.length).toBeGreaterThan(0)
        expect(fuori.join('\n')).toMatch(/AdminTopBarMobile\.tsx:\d+ dichiara z-105/)
        expect(fuori.join('\n')).toMatch(/AdminSidebar\.tsx:\d+ dichiara z-105/)
        expect(fuori.join('\n')).toMatch(/AdminMenuSheet\.tsx:\d+ dichiara z-110/)
    })

    it('e spiega perché il criterio vecchio taceva: le bottom-nav restavano sotto anche a z-80', () => {
        const fuori = superficiSopraLaModale(80, INVENTARIO)
        // Le tre bottom-nav (z-50) NON compaiono fra le violazioni: il vecchio
        // confronto era soddisfatto (80 > 50) mentre la barra in alto copriva la ✕.
        expect(fuori.filter((r) => /BottomNav\.tsx/.test(r))).toEqual([])
        // …e col piano di oggi non ne resta fuori nessuna: il confronto vecchio è
        // incluso in quello nuovo, non sostituito.
        const nav = INVENTARIO.filter((s) => /BottomNav\.tsx$/.test(s.file)).map((s) => s.z)
        expect(Math.max(...nav)).toBeGreaterThanOrEqual(50)
    })
})
