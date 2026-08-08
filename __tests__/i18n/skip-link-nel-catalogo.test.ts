import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · il testo d'interfaccia dei LAYOUT dell'area riservata sta nel catalogo.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * Il collaudo di localizzazione del 2026-08-08 (F2) ha misurato che il primo
 * elemento di ogni schermata dell'area genitore — il link «Salta al contenuto»,
 * cioè la scorciatoia che raggiunge chi naviga da tastiera e chi usa uno screen
 * reader — è una stringa italiana scritta a mano nel TSX. Con l'interfaccia in
 * inglese resta in italiano dentro un documento dichiarato `lang="en"`, quindi
 * uno screen reader la pronuncia con fonetica inglese.
 *
 * La causa non è una svista sul singolo file: è un PUNTO CIECO di metodo.
 * L'estrazione delle stringhe verso i cataloghi (commit c6dde7d, «Fase 3 i18n
 * IT/EN completa») ha percorso i componenti di pagina, non i tre `layout.tsx`
 * dell'area riservata — file che contengono quasi solo struttura e che «non
 * sembravano contenere testo affatto». Un file che nessuno guarda perché sembra
 * vuoto è esattamente il posto in cui una stringa sopravvive a una bonifica.
 *
 * Nessuno strumento poteva vederlo: la parità dei cataloghi
 * (`messaggi-parita-cataloghi`) confronta it ed en fra loro e non sa niente di
 * ciò che non è MAI entrato in catalogo; il mock di next-intl in `test/setup.ts`
 * risolve i soli messaggi italiani, quindi nessun unit test legge mai la pagina
 * come la legge un utente inglese.
 *
 * ─── COSA CONTROLLA ──────────────────────────────────────────────────────────
 *  1. la chiave dello skip link esiste in ENTRAMBE le lingue, con un testo non
 *     vuoto e DIVERSO fra it ed en: una chiave copiata identica è una traduzione
 *     mancante travestita da presente, e la supererebbe qualunque confronto di
 *     insiemi;
 *  2. i tre layout dell'area riservata non fanno nascere testo d'interfaccia a
 *     mano, salvo le eccezioni DICHIARATE qui sotto — che possono solo
 *     diminuire;
 *  3. ogni eccezione dichiarata è ancora VERA (la stringa è davvero in quel
 *     file): il giorno in cui il layout legge la chiave dal catalogo questa
 *     prova diventa rossa e chiede di cancellare la riga. Un'eccezione che
 *     protegge il nulla è peggio di nessuna eccezione;
 *  4. l'estrattore di nodi di testo funziona davvero — senza questo controllo il
 *     divieto del punto 2 sarebbe verde su un estrattore che non trova mai
 *     niente, che è la forma più silenziosa di non controllare.
 *
 * ─── COSA NON CONTROLLA (di proposito) ───────────────────────────────────────
 *  · gli attributi (`aria-label`, `title`, `alt`): oggi nei tre layout non ce ne
 *    sono con testo umano, e riconoscerli senza falsi positivi vuole un parser
 *    JSX vero, non una scansione testuale. Se ne nascerà uno, andrà fatto con
 *    lo strumento giusto invece che allargando questa regex;
 *  · il resto di `src/`: le pagine sono già passate dall'estrazione i18n, e un
 *    divieto generico su tutto l'albero è un altro lavoro (e un'altra soglia di
 *    falsi positivi).
 */

const RADICE = process.cwd()

/** I layout dell'area riservata: la cornice che sta su OGNI schermata. */
const LAYOUT = [
    'src/app/(dashboard)/parent/layout.tsx',
    'src/app/(dashboard)/teacher/layout.tsx',
    'src/app/(dashboard)/admin/layout.tsx',
] as const

/**
 * Le stringhe ancora scritte a mano, con la ragione e la via d'uscita.
 *
 * NON è un permesso: è il debito dichiarato nel gate invece che nascosto in un
 * report. La chiave di catalogo esiste già (`nav.saltaAlContenuto`, in italiano
 * e in inglese): manca solo che i due layout la leggano, ed è una modifica di
 * `src/` che in questo ciclo appartiene a chi tiene lo stesso elemento `<a>` per
 * il rilievo di contrasto (accessibilità F3, `parent/layout.tsx:14-19`). Due
 * mani sullo stesso tag nello stesso momento si cancellano a vicenda.
 *
 * VIA D'USCITA, in tre righe per file:
 *   import { getTranslations } from 'next-intl/server'
 *   const t = await getTranslations('nav')          // il layout è già `async`
 *   …e al posto del letterale: {t('saltaAlContenuto')}
 * Poi si toglie la riga da qui — e la prova 3 lo pretende, perché diventa rossa
 * da sola appena il letterale sparisce.
 */
const TESTO_A_MANO_AMMESSO = new Map<string, { testo: string; motivo: string }>([
    [
        'src/app/(dashboard)/parent/layout.tsx',
        {
            testo: 'Salta al contenuto',
            motivo:
                'Skip link nato col lavoro di accessibilità (25cc867) prima che l’app fosse bilingue. ' +
                'La chiave `nav.saltaAlContenuto` esiste già in it e in en: resta da farla leggere al ' +
                'layout con `getTranslations(\'nav\')`. La modifica tocca lo STESSO elemento `<a>` su cui ' +
                'lavora il rilievo di contrasto dello skip link (accessibilità F3): va fatta in un ' +
                'passaggio solo, non da due mani in parallelo.',
        },
    ],
    [
        'src/app/(dashboard)/teacher/layout.tsx',
        {
            testo: 'Salta al contenuto',
            motivo:
                'Stessa stringa e stessa storia del layout genitore: lo skip link dell’area docente è ' +
                'la copia gemella, e il rilievo di contrasto dichiara esplicitamente «vale per entrambi ' +
                'i layout». Si normalizzano insieme, con la stessa chiave di catalogo.',
        },
    ],
])

/** Toglie i commenti — di riga, di blocco e quelli in graffe del JSX. */
function senzaCommenti(sorgente: string): string {
    return sorgente
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ')
}

/**
 * I NODI DI TESTO del JSX: ciò che sta fra la chiusura di un tag e l'apertura
 * del successivo, senza graffe (così `{t('x')}` e `{children}` restano fuori) e
 * con almeno una lettera (così `·`, `—`, i numeri e la spaziatura non entrano).
 */
function nodiDiTesto(sorgente: string): string[] {
    const testo = senzaCommenti(sorgente)
    const trovati: string[] = []
    const re = />([^<>{}]+)</g
    let m: RegExpExecArray | null
    while ((m = re.exec(testo)) !== null) {
        const s = m[1].trim()
        if (/\p{L}/u.test(s)) trovati.push(s)
    }
    return trovati
}

const leggi = (relativo: string): string => readFileSync(join(RADICE, relativo), 'utf8')
const catalogo = (lingua: string, ns: string): Record<string, string> =>
    JSON.parse(readFileSync(join(RADICE, 'messages', lingua, `${ns}.json`), 'utf8'))

describe('lock localizzazione · lo skip link ha una chiave, e i layout non scrivono testo a mano', () => {
    it('la chiave dello skip link c’è in italiano e in inglese, e le due lingue non sono la stessa parola', () => {
        const it = catalogo('it', 'nav').saltaAlContenuto
        const en = catalogo('en', 'nav').saltaAlContenuto
        expect(
            typeof it,
            'manca messages/it/nav.json → saltaAlContenuto: è il primo elemento di ogni schermata ' +
            'dell’area riservata e oggi vive come letterale nel TSX.',
        ).toBe('string')
        expect(typeof en, 'manca messages/en/nav.json → saltaAlContenuto').toBe('string')
        expect(it.trim(), 'messages/it/nav.json → saltaAlContenuto è vuoto').not.toBe('')
        expect(en.trim(), 'messages/en/nav.json → saltaAlContenuto è vuoto').not.toBe('')
        expect(
            en,
            `messages/en/nav.json → saltaAlContenuto = «${en}» è identico all’italiano. Una chiave ` +
            'copiata identica supera la parità dei cataloghi e a schermo resta la lingua sbagliata: ' +
            'è esattamente il difetto che questo lock chiude.',
        ).not.toBe(it)
    })

    it('i layout dell’area riservata non fanno nascere testo d’interfaccia a mano', () => {
        const guasti: string[] = []
        for (const file of LAYOUT) {
            expect(existsSync(join(RADICE, file)), `sparito: ${file}`).toBe(true)
            const ammesso = TESTO_A_MANO_AMMESSO.get(file)?.testo
            for (const testo of nodiDiTesto(leggi(file))) {
                if (testo !== ammesso) guasti.push(`${file} → «${testo}»`)
            }
        }
        expect(
            guasti,
            `Questi testi sono scritti dentro un layout invece che nel catalogo:\n  ${guasti.join('\n  ')}\n` +
            'Un layout sta su OGNI schermata della sua area: una parola scritta qui resta italiana ' +
            'anche in un documento `lang="en"`. Va spostata in `messages/it|en/nav.json` e letta con ' +
            '`getTranslations(\'nav\')` — i tre layout sono già Server Component `async`.',
        ).toEqual([])
    })

    it('le eccezioni dichiarate sono ancora vere, e possono solo diminuire', () => {
        expect(
            TESTO_A_MANO_AMMESSO.size,
            'le eccezioni al divieto di testo a mano nei layout non aumentano: due sono il debito ' +
            'misurato il 2026-08-08, e la loro unica direzione è verso zero.',
        ).toBeLessThanOrEqual(2)
        for (const [file, { testo, motivo }] of TESTO_A_MANO_AMMESSO) {
            expect(motivo.length, `${file} è dichiarato senza una ragione leggibile`).toBeGreaterThan(80)
            expect(
                nodiDiTesto(leggi(file)),
                `${file} non contiene più «${testo}»: l’eccezione non serve più. Togli la riga da ` +
                'TESTO_A_MANO_AMMESSO — finché resta, protegge il nulla e nasconde la prossima stringa ' +
                'che nascerà nello stesso punto.',
            ).toContain(testo)
        }
    })

    it('l’estrattore vede davvero un nodo di testo (e non scambia il codice per prosa)', () => {
        // Senza questo controllo il divieto qui sopra sarebbe verde anche su un
        // estrattore che non trova mai niente: un elenco vuoto confrontato con un
        // elenco vuoto è la forma più silenziosa di non verificare.
        const finto = [
            '<div className="x">',
            '  {/* Salta questo commento */}',
            '  // e anche questa riga',
            '  <a href="#content">Vai al contenuto</a>',
            '  <span>{t(\'chiaveTradotta\')}</span>',
            '  <p>{children}</p>',
            '  <b>·</b>',
            '</div>',
        ].join('\n')
        const trovati = nodiDiTesto(finto)
        expect(trovati, 'la prosa dentro un tag deve essere trovata').toContain('Vai al contenuto')
        expect(trovati, 'una chiamata a `t()` non è prosa').not.toContain("{t('chiaveTradotta')}")
        expect(trovati, '`{children}` non è prosa').not.toContain('{children}')
        expect(trovati, 'un commento JSX non è prosa').not.toContain('Salta questo commento')
        expect(trovati, 'un separatore senza lettere non è prosa').not.toContain('·')
        expect(trovati).toHaveLength(1)
    })
})
