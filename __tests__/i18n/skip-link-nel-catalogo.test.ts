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

/**
 * I file che non fanno nascere testo d'interfaccia a mano.
 *
 * ─── PERCHÉ NON SONO PIÙ SOLO I LAYOUT (2026-08-08, Q14 e Q15) ──────────────
 * Il nome di questo file dice «skip link» perché da lì è nato. Il perimetro è
 * cresciuto lo stesso giorno, perché il collaudo ha trovato la STESSA firma in
 * due schermate diverse: `src/app/error.tsx` teneva le sue tre frasi come
 * letterali italiani nel TSX, e `src/app/not-found.tsx` non esisteva affatto —
 * quindi Next serviva il proprio «404 This page could not be found.», inglese
 * per costruzione, dentro un documento `lang="it"`.
 *
 * È la stessa causa dello skip link: sono file che «non sembravano contenere
 * testo», e la campagna di estrazione i18n non ci è passata. Aggiungerli QUI, e
 * non in un lock nuovo, è il punto: una regola valida per più strade deve vivere
 * in un posto solo, altrimenti la prossima schermata di servizio nascerà fuori
 * da entrambe.
 *
 * `src/app/global-error.tsx` è deliberatamente FUORI e ha una regola sua, in
 * fondo a questo file: sostituisce il root layout, cioè il componente che monta
 * il `NextIntlClientProvider` — lì il catalogo non esiste più e il testo deve
 * viaggiare dentro il documento.
 */
const PERIMETRO = [
    'src/app/(dashboard)/parent/layout.tsx',
    'src/app/(dashboard)/teacher/layout.tsx',
    'src/app/(dashboard)/admin/layout.tsx',
    'src/app/error.tsx',
    'src/app/not-found.tsx',
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
    // ─────────────────────────────────────────────────────────────────────────
    // VUOTA, E IL GIORNO IN CUI SI È SVUOTATA.
    //
    // Questa mappa conteneva i due layout dell'area riservata, che scrivevano
    // «Salta al contenuto» a mano nel TSX: il PRIMO elemento di ogni schermata —
    // quello che incontra chi naviga da tastiera e chi usa uno screen reader —
    // era anche l'unico testo dell'interfaccia che in un documento `lang="en"`
    // sarebbe rimasto italiano.
    //
    // L'eccezione è stata scritta il 2026-08-08 con la sua via d'uscita dentro, e
    // la via d'uscita ha funzionato: appena i due layout hanno letto
    // `nav.saltaAlContenuto` dal catalogo, la prova «le eccezioni dichiarate sono
    // ancora vere» è diventata ROSSA DA SOLA, chiedendo di cancellare le righe che
    // non proteggevano più niente. Poche ore, non mesi.
    //
    // Se questa mappa torna a riempirsi, ogni voce porti la stessa cosa: non solo
    // il motivo, ma la condizione precisa alla quale sparisce.
    // ─────────────────────────────────────────────────────────────────────────
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

    it('layout e schermate di servizio non fanno nascere testo d’interfaccia a mano', () => {
        const guasti: string[] = []
        for (const file of PERIMETRO) {
            expect(existsSync(join(RADICE, file)), `sparito: ${file}`).toBe(true)
            const ammesso = TESTO_A_MANO_AMMESSO.get(file)?.testo
            for (const testo of nodiDiTesto(leggi(file))) {
                if (testo !== ammesso) guasti.push(`${file} → «${testo}»`)
            }
        }
        expect(
            guasti,
            `Questi testi sono scritti dentro il file invece che nel catalogo:\n  ${guasti.join('\n  ')}\n` +
            'Un layout sta su OGNI schermata della sua area, e le schermate di servizio (404, errore ' +
            'di segmento) sono quelle che l’utente vede quando qualcosa è già andato storto: una ' +
            'parola scritta qui resta italiana anche in un documento `lang="en"`. Va spostata nei ' +
            'cataloghi (`messages/it|en/…`) e letta con `useTranslations` / `getTranslations`.',
        ).toEqual([])
    })

    it('le schermate di servizio leggono davvero il catalogo (non è un elenco vuoto)', () => {
        // Il divieto qui sopra è verde anche su un file che non contiene NESSUN
        // testo — per esempio perché qualcuno ha svuotato la pagina. Questa prova
        // pretende il contrario: che le due schermate di servizio chiamino il
        // catalogo, e che le chiavi che chiamano esistano da entrambe le parti.
        const CHIAVI_ATTESE: Record<string, string[]> = {
            'src/app/error.tsx': ['paginaErroreTitolo', 'paginaErroreCorpo', 'paginaErroreRiprova'],
            'src/app/not-found.tsx': [
                'paginaNonTrovataTitolo',
                'paginaNonTrovataCorpo',
                'paginaNonTrovataTornaHome',
            ],
        }
        const shared = { it: catalogo('it', 'shared'), en: catalogo('en', 'shared') }
        for (const [file, chiavi] of Object.entries(CHIAVI_ATTESE)) {
            const sorgente = leggi(file)
            expect(sorgente, `${file} non usa useTranslations: le stringhe sono tornate letterali`)
                .toContain('useTranslations')
            for (const chiave of chiavi) {
                expect(sorgente, `${file} non legge più shared.${chiave}`).toContain(`'${chiave}'`)
                expect(typeof shared.it[chiave], `manca messages/it/shared.json → ${chiave}`).toBe('string')
                expect(typeof shared.en[chiave], `manca messages/en/shared.json → ${chiave}`).toBe('string')
                expect(
                    shared.en[chiave],
                    `messages/en/shared.json → ${chiave} è identica all’italiano: una traduzione ` +
                    'copiata supera la parità dei cataloghi e lascia a schermo la lingua sbagliata.',
                ).not.toBe(shared.it[chiave])
            }
        }
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

/**
 * R13 · LA RIGA DI TESTA DELLE PAGINE PUBBLICHE, TENUTA INSIEME PER COSTRUZIONE.
 *
 * ─── PERCHÉ STA QUI E NON IN UN LOCK NUOVO ───────────────────────────────────
 * È la stessa firma dello skip link — un comando di NAVIGAZIONE scritto a mano
 * in italiano dentro un documento che può essere `lang="en"` — e la lezione di
 * questo file è che una regola valida per più strade vive in un posto solo.
 *
 * ─── COSA ERA SUCCESSO ───────────────────────────────────────────────────────
 * Le cinque superfici pubbliche condividevano la riga di testa per CONVENZIONE:
 * il comando di alto contrasto era stato estratto in `PublicContrastButton`, il
 * link di ritorno era rimasto COPIATO in ogni pagina. Due su cinque sono poi
 * passate al catalogo, tre no — e con l'app in inglese la riga rendeva
 * «← Torna indietro» accanto a «High contrast». Il commento di quelle pagine
 * dichiarava proprio l'intento opposto («sta in un componente unico proprio
 * perché queste cinque pagine non ricomincino a divergere»), ma copriva solo la
 * metà destra della riga.
 *
 * ─── PERCHÉ NON BASTA «METTERE LA CHIAVE» ────────────────────────────────────
 * Perché la causa non è la stringa: è che la riga NON è un componente. Finché
 * ogni pagina la ridisegna, la prossima pagina pubblica nascerà con la propria
 * copia — che è come sono nate queste tre. Il lock pretende quindi il
 * COMPONENTE, non il letterale giusto.
 *
 * ─── E `lang` ────────────────────────────────────────────────────────────────
 * Le tre pagine legali dichiarano `<main lang="it">`, ed è corretto: il testo
 * legale È italiano per scelta. Ma un comando di navigazione tradotto dentro
 * quel contenitore verrebbe letto da uno screen reader inglese con fonetica
 * italiana — lo stesso WCAG 3.1.2 che quell'attributo serve a rispettare. Il
 * componente porta quindi il proprio `lang`.
 */
describe('lock localizzazione · la riga di testa delle pagine pubbliche', () => {
    const COMPONENTE = 'src/components/ui/PublicPageHeader.tsx'
    const PAGINE_PUBBLICHE = [
        'src/app/privacy/page.tsx',
        'src/app/termini/page.tsx',
        'src/app/assistenza/page.tsx',
        'src/app/cancellazione-account/page.tsx',
    ] as const

    it('la chiave del comando di ritorno c’è nelle due lingue, e non è la stessa parola', () => {
        const it = catalogo('it', 'common').tornaIndietro
        const en = catalogo('en', 'common').tornaIndietro
        expect(typeof it, 'manca messages/it/common.json → tornaIndietro').toBe('string')
        expect(typeof en, 'manca messages/en/common.json → tornaIndietro').toBe('string')
        expect(
            en,
            `messages/en/common.json → tornaIndietro = «${en}» è identico all’italiano: una chiave ` +
            'copiata supera la parità dei cataloghi e a schermo resta la lingua sbagliata.',
        ).not.toBe(it)
    })

    it('nessuna pagina pubblica scrive a mano il comando di ritorno', () => {
        const it = catalogo('it', 'common').tornaIndietro
        const guasti = PAGINE_PUBBLICHE.filter((f) => nodiDiTesto(leggi(f)).some((t) => t.includes(it)))
        expect(
            guasti,
            `Queste pagine scrivono «${it}» dentro il TSX invece di leggerlo dal catalogo:\n  ` +
            `${guasti.join('\n  ')}\n` +
            'Con l’app in inglese la riga di testa esce mista — comando di sinistra in italiano, ' +
            'comando di destra tradotto — e il ritorno è l’unica via d’uscita di quelle pagine.',
        ).toEqual([])
    })

    it('tutte e quattro montano lo STESSO componente di testa', () => {
        const senza = PAGINE_PUBBLICHE.filter((f) => !leggi(f).includes('PublicPageHeader'))
        expect(
            senza,
            `Queste pagine ridisegnano la riga di testa per conto proprio:\n  ${senza.join('\n  ')}\n` +
            'Finché la riga è copiata, la metà tradotta e la metà a mano possono ridivergere — è ' +
            'esattamente come sono nate le tre pagine del rilievo. Va montato `PublicPageHeader`.',
        ).toEqual([])
    })

    it('il componente legge il catalogo e porta il proprio `lang`', () => {
        const sorgente = leggi(COMPONENTE)
        expect(sorgente, `${COMPONENTE} non legge common.tornaIndietro dal catalogo`).toContain("'tornaIndietro'")
        expect(
            sorgente,
            `${COMPONENTE} non dichiara \`lang\` sul comando di ritorno: dentro <main lang="it"> — che ` +
            'è giusto per il testo legale — un comando tradotto verrebbe pronunciato in italiano da uno ' +
            'screen reader inglese (WCAG 3.1.2).',
        ).toMatch(/lang=\{/)
    })

    it('la riga di testa tiene insieme ENTRAMBI i comandi, non solo quello di destra', () => {
        // Il difetto è nato perché uno dei due comandi era già condiviso e
        // l'altro no: se il componente montasse solo il ritorno, la prossima
        // pagina rifarebbe a mano il contrasto e la storia ricomincerebbe.
        expect(leggi(COMPONENTE)).toContain('PublicContrastButton')
    })
})

/**
 * L'ECCEZIONE CHE HA UNA RAGIONE STRUTTURALE, E QUINDI NON SPARIRÀ.
 *
 * `src/app/global-error.tsx` è l'unico componente del repo che disegna il
 * documento intero: SOSTITUISCE il root layout, cioè il file che monta il
 * `NextIntlClientProvider`. Quando viene reso, il catalogo non c'è più — non per
 * una svista, ma perché il componente che lo forniva è quello appena saltato.
 * Il testo deve quindi viaggiare DENTRO di lui, ed è la stessa forma già adottata
 * da `ChunkErrorBoundary` (un chunk mancante è il momento in cui il runtime di
 * traduzione può non esserci) e dalla pagina `/offline` (`force-static`: a build
 * time il cookie `KV_LOCALE` non esiste ancora).
 *
 * Il rischio di questa forma è che «tanto è un'eccezione» diventi «tanto è
 * italiano»: fino al 2026-08-08 quel file aveva tre frasi italiane e basta, e un
 * `lang="it"` cablato che le avrebbe dichiarate italiane anche dopo. Da qui le
 * tre regole.
 */
describe('lock localizzazione · l’errore globale porta le due lingue con sé', () => {
    const FILE = 'src/app/global-error.tsx'

    it('contiene entrambe le lingue, non solo l’italiano', () => {
        const sorgente = leggi(FILE)
        expect(
            /\bit\s*:\s*\{/.test(sorgente) && /\ben\s*:\s*\{/.test(sorgente),
            `${FILE} deve dichiarare i suoi testi in italiano E in inglese: qui il catalogo non ` +
            'esiste (questo componente sostituisce il root layout, cioè il provider), quindi le due ' +
            'lingue viaggiano dentro il documento — come in ChunkErrorBoundary e in /offline.',
        ).toBe(true)
    })

    it('sceglie la lingua dal cookie KV_LOCALE, come il resto dell’app', () => {
        const sorgente = leggi(FILE)
        expect(
            sorgente,
            `${FILE} non legge il cookie KV_LOCALE: le due lingue nel file senza il criterio di ` +
            'scelta sono un testo bilingue che nessuno vedrà mai in inglese.',
        ).toContain('KV_LOCALE')
    })

    it('l’attributo `lang` segue la lingua scelta e non è cablato', () => {
        const sorgente = leggi(FILE)
        expect(
            sorgente,
            `${FILE} dichiara ancora <html lang="it"> con un valore fisso: un testo inglese dentro ` +
            'un documento dichiarato italiano viene letto da uno screen reader con la fonetica ' +
            'sbagliata — che è metà del difetto Q14, non il suo rimedio.',
        ).not.toMatch(/<html\s+lang\s*=\s*["']it["']/)
        expect(sorgente, `${FILE} non lega più \`lang\` alla lingua scelta`).toMatch(/<html\s+lang=\{/)
    })
})
