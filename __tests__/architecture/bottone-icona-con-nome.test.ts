import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/**
 * LOCK · un bottone che contiene SOLO un'icona deve avere un nome accessibile.
 *
 * ─── LA STORIA ───────────────────────────────────────────────────────────────
 * Il collaudo di accessibilità del 2026-08-02 ha trovato diciassette `<button>`
 * il cui unico contenuto era un glifo di `lucide-react`: nessun testo, nessun
 * `aria-label`, nessun `title`. Uno screen reader li annuncia «pulsante», e
 * basta. Fra questi i tre comandi in cima al registro presenze del docente —
 * mese precedente, mese successivo, aggiorna — cioè tre pulsanti identici
 * nell'annuncio e diversi nell'effetto. È WCAG 4.1.2 (Nome, Ruolo, Valore),
 * livello A; per axe è la regola `button-name`, impatto `critical`.
 *
 * Ma il numero vero non era diciassette: **sessantasei, in quarantacinque file**.
 * La differenza fra i due numeri è tutto il senso di questo file. Il collaudo
 * guardava i componenti toccati dal branch e quelli che era riuscito a montare;
 * la forma difettosa, invece, era sparsa in tutto `src/`, ed era arrivata lì un
 * bottone alla volta, ognuno copiato dal precedente. Il pattern corretto esisteva
 * già nel repo (`OtpSignatureModal` ha `aria-label={t('chiudi')}` dal primo
 * giorno): mancava qualcosa che rendesse VISIBILE il momento in cui qualcuno
 * scriveva il bottone senza nome. È la lezione già scritta in memoria per questo
 * ciclo — *una regola valida per due strade deve vivere in un posto solo*.
 *
 * ─── LA REGOLA ───────────────────────────────────────────────────────────────
 * Un comando il cui contenuto è composto SOLO da icone deve dichiarare il proprio
 * nome con `aria-label`, `aria-labelledby` oppure `title`.
 *
 * «Comando» comprende i LINK, non solo i bottoni: un `<Link>` con dentro la sola
 * freccia «indietro» si annuncia «link» e nient'altro — stesso criterio WCAG
 * 4.1.2, per axe è la regola gemella `link-name`. Il lock è nato sui bottoni;
 * estenderlo è costato la misura (due link in tutto `src/`, entrambi «torna
 * indietro») e ha chiuso la porta prima che diventassero venti.
 *
 * Perché `title` è accettato: la specifica del nome accessibile lo usa come
 * ripiego e axe considera `button-name` soddisfatto. Un lock che chiedesse di
 * riscrivere codice che axe dichiara corretto non sarebbe più severo — sarebbe
 * solo più rumoroso, e il primo che lo zittisce con un'esenzione avrebbe ragione
 * lui. (Resta vero che `aria-label` è preferibile: `title` non compare su touch e
 * non è annunciato in modo uniforme. Il lock impone il minimo, non il gusto.)
 *
 * ─── COME LEGGE IL SORGENTE (e perché non è una grep) ────────────────────────
 * Il file viene PARSATO con il compilatore TypeScript (`ts.createSourceFile`,
 * modalità TSX) e si ragiona sull'albero. Una grep qui produrrebbe entrambi gli
 * errori possibili: un `aria-label` citato in un commento sembrerebbe un nome, e
 * un bottone scritto su nove righe non starebbe mai «su una riga».
 *
 * Che cos'è un'ICONA: un elemento il cui tag è importato da `lucide-react`,
 * `react-icons` o `@heroicons` — oppure un `<svg>` scritto a mano. L'elenco non è
 * cablato: si legge dagli `import` di quel file, così un'icona nuova è coperta
 * dal giorno in cui viene importata.
 *
 * Che cos'è un COMANDO: i tag intrinseci `<button>` e `<a>`, più i componenti
 * importati da `@/components/ui/Btn` (l'unico involucro di bottone del repo che
 * rende un `<button>` vero girandogli tutte le props, `{...rest}`, quindi l'unico
 * su cui un `aria-label` scritto dal chiamante arriva davvero a destinazione) e
 * quelli importati da `next/link`, che rendono un `<a>` allo stesso modo.
 *
 * PERCHÉ L'IMPORT VA RISOLTO, e non basta il nome del tag. Misurato: se si
 * accetta il tag `<Btn>` per come si chiama, `NewsRichTextEditor.tsx` produce
 * DIECI falsi positivi in fila — perché quel file ha un `Btn` suo, definito lì
 * sopra, che l'`aria-label` ce l'ha già (`aria-label={etichetta}`, riga 40) e lo
 * riceve da una prop chiamata `etichetta`. Un lock che segnala dieci volte il
 * file di chi ha fatto la cosa giusta viene disattivato nel giro di un ciclo.
 *
 * ─── COSA NON VEDE, DICHIARATO ───────────────────────────────────────────────
 * Quando il contenuto del bottone è un'espressione che la sonda non sa ridurre a
 * un elenco di rami (`{icona}`, `{render()}`, `{voci.map(…)}`), il bottone viene
 * SALTATO invece che segnalato. È una scelta: in un lock di forma un falso
 * positivo costa più di un falso negativo, perché il primo insegna a ignorare il
 * test. I casi decidibili sono già ridotti (`{x ? <A/> : <B/>}`, `{x && <A/>}`,
 * frammenti), che coprono la forma «spinner mentre carica, icona altrimenti».
 * Restano fuori anche i bottoni con `{...props}`: lì il nome può arrivare dal
 * chiamante e il sorgente, da solo, non può dirlo.
 *
 * ─── PERCHÉ ANCHE UN PAVIMENTO, E NON SOLO UN TETTO ──────────────────────────
 * Dopo la bonifica l'elenco dei difetti è vuoto — e una sonda ROTTA produce
 * esattamente lo stesso elenco vuoto. Per questo il lock misura anche i bottoni
 * a sola icona CHE IL NOME CE L'HANNO e pretende che siano tanti: è la prova che
 * sta ancora guardando nel posto giusto. Senza quella riga, il giorno in cui una
 * modifica al parser lo rendesse cieco, questo file resterebbe verde per sempre.
 */

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')
const ALLOWLIST = path.join(RADICE, 'docs/superpowers/bottoni-icona-senza-nome-allowlist.json')

/**
 * TETTI MONOTONI DECRESCENTI — misura del 2026-08-02, a bonifica fatta.
 * Resta fuori il solo comando in mano a un altro intervento dello stesso ciclo
 * (vedi l'allowlist). Si abbassano, non si alzano: alzarli significa aver appena
 * scritto un comando che uno screen reader annuncia «pulsante».
 */
const TETTO_FILE = 1
const TETTO_OCCORRENZE = 1

/**
 * PAVIMENTO della sonda: quanti comandi a sola icona CON nome deve continuare a
 * vedere. Misurati 164 il 2026-08-02 (68 bonificati in questo intervento — 66
 * bottoni e 2 link — più quelli che il nome ce l'avevano già). Il margine è largo
 * di proposito: serve a distinguere «il repo è cambiato» da «la sonda non vede
 * più niente», non a inseguire il conteggio.
 */
const PAVIMENTO_CON_NOME = 120

/** I moduli da cui, in questo repo, si importano icone. */
const MODULI_ICONA = /^(lucide-react|react-icons|@heroicons)/

/**
 * Gli involucri che girano le props al comando vero: il bottone-pillola del repo
 * e il `Link` di Next (che rende un `<a>`).
 */
const MODULI_COMANDO = new Set(['@/components/ui/Btn', 'next/link'])

const ATTRIBUTI_NOME = new Set(['aria-label', 'aria-labelledby', 'title'])

export interface BottoneSenzaNome {
    file: string
    riga: number
    /** I tag delle icone che stanno dentro: serve a riconoscere il punto a colpo d'occhio. */
    contenuto: string
}

export interface Analisi {
    senzaNome: BottoneSenzaNome[]
    /** Bottoni a sola icona che il nome ce l'hanno: il pavimento si misura su questi. */
    conNome: number
    /** Contenuto non riducibile a rami: saltati di proposito (vedi intestazione). */
    indecisi: number
}

/** Il tag di un elemento JSX, aperto o autochiudente. */
const nomeTag = (n: ts.JsxElement | ts.JsxSelfClosingElement): string =>
    ts.isJsxElement(n) ? n.openingElement.tagName.getText() : n.tagName.getText()

const attributi = (n: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes =>
    ts.isJsxElement(n) ? n.openingElement.attributes : n.attributes

/** `aria-label=""` e `aria-label={''}` non sono nomi: sono attributi vuoti. */
function valoreNonVuoto(attr: ts.JsxAttribute): boolean {
    const v = attr.initializer
    if (!v) return false // `title` senza valore vale `""`
    if (ts.isStringLiteral(v)) return v.text.trim().length > 0
    if (ts.isJsxExpression(v)) {
        if (!v.expression) return false
        if (ts.isStringLiteral(v.expression) || ts.isNoSubstitutionTemplateLiteral(v.expression)) {
            return v.expression.text.trim().length > 0
        }
        return true // espressione qualunque: il valore lo decide il runtime
    }
    return true
}

/**
 * La sonda. Esportata perché il controllo positivo qui sotto la esegue su
 * sorgenti finti: un lock che non prova la propria sonda è una promessa.
 */
export function analizza(sorgente: string, nomeFile = 'prova.tsx'): Analisi {
    const sf = ts.createSourceFile(nomeFile, sorgente, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

    const icone = new Set<string>()
    const comandi = new Set<string>(['button', 'a'])
    sf.forEachChild((n) => {
        if (!ts.isImportDeclaration(n)) return
        const modulo = (n.moduleSpecifier as ts.StringLiteral).text
        const bersaglio = MODULI_ICONA.test(modulo) ? icone : MODULI_COMANDO.has(modulo) ? comandi : null
        if (!bersaglio) return
        const b = n.importClause?.namedBindings
        if (b && ts.isNamedImports(b)) for (const el of b.elements) bersaglio.add(el.name.getText())
        // `import Link from 'next/link'` è un default: senza questa riga il tag
        // `<Link>` resterebbe invisibile alla sonda in quasi tutti i file del repo.
        if (n.importClause?.name) bersaglio.add(n.importClause.name.getText())
    })

    const eIcona = (n: ts.Node): boolean =>
        (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) &&
        (icone.has(nomeTag(n)) || nomeTag(n) === 'svg')

    /**
     * I rami di OUTPUT di un'espressione JSX: che cosa può finire dentro al
     * bottone. `null` = non decidibile (e allora il bottone si salta).
     */
    const rami = (e: ts.Expression | undefined): ts.Node[] | null => {
        if (!e) return []
        if (ts.isParenthesizedExpression(e)) return rami(e.expression)
        if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) return [e]
        if (ts.isJsxFragment(e)) {
            const out: ts.Node[] = []
            for (const c of e.children) {
                if (ts.isJsxText(c)) {
                    if (c.getText().trim()) return null // testo: il nome ce l'ha già
                    continue
                }
                if (ts.isJsxExpression(c)) {
                    const r = rami(c.expression)
                    if (r === null) return null
                    out.push(...r)
                    continue
                }
                out.push(c)
            }
            return out
        }
        if (ts.isConditionalExpression(e)) {
            const a = rami(e.whenTrue)
            const b = rami(e.whenFalse)
            return a === null || b === null ? null : [...a, ...b]
        }
        if (ts.isBinaryExpression(e)) {
            const k = e.operatorToken.kind
            // `cond && <Icona/>`: il valore reso è solo il lato destro.
            if (k === ts.SyntaxKind.AmpersandAmpersandToken) return rami(e.right)
            if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) {
                const a = rami(e.left)
                const b = rami(e.right)
                return a === null || b === null ? null : [...a, ...b]
            }
            return null
        }
        if (e.kind === ts.SyntaxKind.NullKeyword) return []
        if (ts.isIdentifier(e) && e.getText() === 'undefined') return []
        return null
    }

    const out: Analisi = { senzaNome: [], conNome: 0, indecisi: 0 }

    const visita = (n: ts.Node): void => {
        if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && comandi.has(nomeTag(n))) {
            let spread = false
            let haNome = false
            for (const p of attributi(n).properties) {
                if (ts.isJsxSpreadAttribute(p)) { spread = true; continue }
                if (ATTRIBUTI_NOME.has(p.name.getText()) && valoreNonVuoto(p)) haNome = true
            }
            if (!spread) {
                const figli = ts.isJsxElement(n) ? n.children : []
                let testo = false
                let indeciso = false
                const contenuti: ts.Node[] = []
                for (const c of figli) {
                    if (ts.isJsxText(c)) { if (c.getText().trim()) testo = true; continue }
                    if (ts.isJsxExpression(c)) {
                        if (!c.expression) continue // `{/* commento */}`
                        const r = rami(c.expression)
                        if (r === null) { indeciso = true; continue }
                        contenuti.push(...r)
                        continue
                    }
                    contenuti.push(c)
                }
                if (testo) {
                    // ha già un nome dal proprio contenuto testuale
                } else if (indeciso) {
                    if (!haNome) out.indecisi++
                } else if (contenuti.length > 0 && contenuti.every(eIcona)) {
                    if (haNome) out.conNome++
                    else {
                        out.senzaNome.push({
                            file: nomeFile,
                            riga: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
                            contenuto: contenuti.map((c) => nomeTag(c as ts.JsxElement)).join('+'),
                        })
                    }
                }
            }
        }
        n.forEachChild(visita)
    }
    visita(sf)
    return out
}

/**
 * ─── Il nome che passa dal catalogo: esiste davvero? ─────────────────────────
 *
 * Un `aria-label={t('chiaveSbagliata')}` è, per la sonda qui sopra, un nome
 * perfettamente valido — c'è l'attributo, c'è un'espressione. Ma next-intl (e il
 * mock in `test/setup.ts`, che si comporta allo stesso modo) su una chiave
 * assente NON restituisce vuoto: restituisce il PERCORSO, `teacherPresenze.pippo`.
 * Il risultato è un comando che axe considera nominato e che uno screen reader
 * legge come «teacherPresenze punto pippo»: un difetto peggiore di quello che si
 * voleva correggere, e invisibile a ogni altro controllo del repo.
 *
 * È il rischio concreto di un intervento come questo, che ha scritto in un colpo
 * solo una settantina di chiavi nuove a mano.
 *
 * COME SI LEGA UNA CHIAMATA AL SUO CATALOGO. Solo attraverso la variabile: si
 * raccolgono le dichiarazioni `const X = useTranslations('ns')` e si controllano
 * unicamente le chiamate `X('chiave')`. Non basta che il file nomini un namespace
 * da qualche parte.
 *
 * Misurato mentre questo controllo veniva scritto: la versione ingenua — «il file
 * dichiara `shared`, quindi ogni `t(...)` è di `shared`» — segnalava
 * `ChatConversationMenu.tsx`, dove `t` NON è una variabile locale ma una PROP
 * ricevuta dal chiamante (che passa il proprio `t` di `parentChat` o
 * `teacherComunicazioni`), mentre l'unico `useTranslations` del file è legato a
 * `s`. Era un falso positivo su codice corretto, cioè il modo più rapido per far
 * disattivare un lock. Quando `t` arriva da fuori, da qui non si può giudicare, e
 * il controllo tace.
 *
 * Se la stessa variabile è dichiarata più volte nel file con namespace diversi
 * (due componenti nello stesso sorgente), la chiave basta che esista in uno.
 */
const CATALOGO_IT = path.join(RADICE, 'messages/it')

const catalogo = (ns: string): Record<string, unknown> | null => {
    const p = path.join(CATALOGO_IT, `${ns}.json`)
    return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>) : null
}

export function chiaviNomeMancanti(sorgente: string, nomeFile = 'prova.tsx'): string[] {
    const sf = ts.createSourceFile(nomeFile, sorgente, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    /** variabile → namespace a cui `useTranslations` l'ha legata, in QUESTO file. */
    const legami = new Map<string, Set<string>>()
    const chiamate: Array<{ variabile: string; chiave: string; riga: number }> = []

    const visita = (n: ts.Node): void => {
        if (
            ts.isVariableDeclaration(n) &&
            ts.isIdentifier(n.name) &&
            n.initializer &&
            ts.isCallExpression(n.initializer) &&
            n.initializer.expression.getText() === 'useTranslations' &&
            n.initializer.arguments.length === 1 &&
            ts.isStringLiteral(n.initializer.arguments[0])
        ) {
            const nome = n.name.getText()
            const ns = (n.initializer.arguments[0] as ts.StringLiteral).text
            if (!legami.has(nome)) legami.set(nome, new Set())
            legami.get(nome)!.add(ns)
        }
        if (ts.isJsxAttribute(n) && ATTRIBUTI_NOME.has(n.name.getText())) {
            const v = n.initializer
            if (v && ts.isJsxExpression(v) && v.expression && ts.isCallExpression(v.expression)) {
                const chiamata = v.expression
                if (
                    ts.isIdentifier(chiamata.expression) &&
                    chiamata.arguments.length >= 1 &&
                    ts.isStringLiteral(chiamata.arguments[0])
                ) {
                    chiamate.push({
                        variabile: chiamata.expression.getText(),
                        chiave: (chiamata.arguments[0] as ts.StringLiteral).text,
                        riga: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
                    })
                }
            }
        }
        n.forEachChild(visita)
    }
    visita(sf)

    const mancanti: string[] = []
    for (const { variabile, chiave, riga } of chiamate) {
        const ns = legami.get(variabile)
        if (!ns) continue // `t` ricevuto come prop: da qui non si può giudicare
        const cataloghi = [...ns].map(catalogo).filter((c): c is Record<string, unknown> => c !== null)
        if (cataloghi.length === 0) continue
        const esiste = cataloghi.some((c) => typeof c[chiave] === 'string' && (c[chiave] as string).trim())
        if (!esiste) {
            mancanti.push(`${nomeFile}:${riga} → ${variabile}('${chiave}') non esiste in ${[...ns].join(' | ')}`)
        }
    }
    return mancanti
}

/** Tutti i `.tsx` sotto `src/`, in path relativi con separatore `/`. */
function sorgenti(dir = SRC): string[] {
    const out: string[] = []
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        const assoluto = path.join(dir, voce.name)
        if (voce.isDirectory()) { out.push(...sorgenti(assoluto)); continue }
        if (!voce.name.endsWith('.tsx')) continue
        out.push(path.relative(RADICE, assoluto).split(path.sep).join('/'))
    }
    return out
}

/** La misura vera, su disco, adesso. */
const MISURA: Analisi = (() => {
    const tot: Analisi = { senzaNome: [], conNome: 0, indecisi: 0 }
    for (const rel of sorgenti()) {
        const a = analizza(fs.readFileSync(path.join(RADICE, rel), 'utf8'), rel)
        tot.senzaNome.push(...a.senzaNome)
        tot.conNome += a.conNome
        tot.indecisi += a.indecisi
    }
    return tot
})()

const PER_FILE = new Map<string, number>()
for (const b of MISURA.senzaNome) PER_FILE.set(b.file, (PER_FILE.get(b.file) ?? 0) + 1)

type Voce = { path: string; n: number; motivo: string }
type AllowlistFile = { misurato_il: string; totale_file: number; totale_occorrenze: number; file: Voce[] }

const leggiAllowlist = (): AllowlistFile => JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')) as AllowlistFile

const COME_SI_CORREGGE =
    'Dai un nome al comando: `aria-label={t(\'chiaveDelCatalogo\')}` sul `<button>` (e la chiave ' +
    'in messages/it + messages/en, che hanno il lock di parità). Se il nome sta già a schermo in ' +
    'un altro elemento, `aria-labelledby` col suo id. NON aggiungere il file all\'allowlist: ' +
    'l\'allowlist può solo accorciarsi.'

describe('lock — un comando a sola icona (bottone o link) ha un nome (WCAG 4.1.2, livello A)', () => {
    it('CONTROLLO POSITIVO: la sonda riconosce la forma difettosa e non le altre', () => {
        const intestazione = "import { X, ChevronLeft, Loader2, Send } from 'lucide-react'\n"

        // 1. Il difetto vero, nelle due scritture in cui compare nel repo.
        expect(analizza(intestazione + 'const A = () => <button onClick={c}><X size={14} /></button>').senzaNome)
            .toHaveLength(1)
        expect(analizza(intestazione + 'const A = () => <button><svg viewBox="0 0 1 1" /></button>').senzaNome)
            .toHaveLength(1)

        // 2. Il caso «spinner mentre carica»: sempre icona, sempre senza nome.
        expect(
            analizza(intestazione + 'const A = () => <button>{x ? <Loader2 /> : <Send />}</button>').senzaNome,
        ).toHaveLength(1)

        // 3. Chi il nome ce l'ha non viene segnalato — e viene CONTATO.
        for (const buono of [
            '<button aria-label="Chiudi"><X /></button>',
            '<button aria-label={t(\'chiudi\')}><X /></button>',
            '<button aria-labelledby="titolo-modale"><X /></button>',
            '<button title="Aggiorna"><X /></button>',
        ]) {
            const a = analizza(intestazione + `const A = () => ${buono}`)
            expect(a.senzaNome, buono).toHaveLength(0)
            expect(a.conNome, buono).toBe(1)
        }

        // 4. Un attributo VUOTO non è un nome.
        expect(analizza(intestazione + 'const A = () => <button aria-label=""><X /></button>').senzaNome)
            .toHaveLength(1)
        expect(analizza(intestazione + "const A = () => <button aria-label={''}><X /></button>").senzaNome)
            .toHaveLength(1)

        // 5. Chi ha del testo dentro non è un bottone-icona.
        for (const conTesto of [
            '<button><X /> Chiudi</button>',
            "<button><X />{t('chiudi')}</button>",
            '<button>{etichetta}</button>',
        ]) {
            expect(analizza(intestazione + `const A = () => ${conTesto}`).senzaNome, conTesto).toHaveLength(0)
        }

        // 6. `{...props}` — il nome può arrivare dal chiamante: non si può giudicare.
        expect(analizza(intestazione + 'const A = (p) => <button {...p}><X /></button>').senzaNome)
            .toHaveLength(0)

        // 7. Un `Btn` DEFINITO NEL FILE non è l'involucro condiviso: senza questa
        //    distinzione `NewsRichTextEditor.tsx` produrrebbe dieci falsi positivi
        //    (il suo `Btn` l'`aria-label` ce l'ha già, e lo prende da una prop).
        const btnLocale =
            intestazione +
            'function Btn({ children, etichetta }) { return <button aria-label={etichetta}>{children}</button> }\n' +
            'const A = () => <Btn etichetta="Grassetto"><X /></Btn>'
        expect(analizza(btnLocale).senzaNome).toHaveLength(0)

        // 8. …mentre il `Btn` IMPORTATO gira le props al `<button>` vero: lì un uso
        //    a sola icona senza nome è un difetto, ed è giusto vederlo.
        const btnCondiviso =
            intestazione +
            "import { Btn } from '@/components/ui/Btn'\n" +
            'const A = () => <Btn onClick={f}><X /></Btn>'
        expect(analizza(btnCondiviso).senzaNome).toHaveLength(1)

        // 9. Un commento che *cita* `aria-label` non è un `aria-label`.
        expect(
            analizza(intestazione + 'const A = () => <button /* aria-label="Chiudi" */><X /></button>').senzaNome,
        ).toHaveLength(1)

        // 10. I LINK a sola icona: stesso criterio (per axe è `link-name`). Il
        //     `Link` di Next arriva da un import DEFAULT, ed è la forma con cui
        //     compare in tutto il repo.
        expect(analizza(intestazione + 'const A = () => <a href="/x"><ChevronLeft /></a>').senzaNome)
            .toHaveLength(1)
        const linkNext =
            intestazione + "import Link from 'next/link'\nconst A = () => <Link href=\"/x\"><ChevronLeft /></Link>"
        expect(analizza(linkNext).senzaNome).toHaveLength(1)
        const linkConNome =
            intestazione +
            "import Link from 'next/link'\nconst A = () => <Link href=\"/x\" aria-label=\"Torna indietro\"><ChevronLeft /></Link>"
        expect(analizza(linkConNome).senzaNome).toHaveLength(0)
        expect(analizza(linkConNome).conNome).toBe(1)
    })

    it('CONTROLLO POSITIVO: sul repo vero la sonda vede i comandi a sola icona', () => {
        expect(
            MISURA.conNome,
            `Comandi a sola icona CON nome visti dalla sonda: ${MISURA.conNome} (pavimento ` +
                `${PAVIMENTO_CON_NOME}). Sotto il pavimento non è «il repo è migliorato»: è la sonda ` +
                'che non vede più i bottoni, e allora anche l\'elenco dei difetti è vuoto per finta.',
        ).toBeGreaterThanOrEqual(PAVIMENTO_CON_NOME)
    })

    it('l’allowlist esiste, è ben formata, e ogni voce porta la sua ragione', () => {
        expect(
            fs.existsSync(ALLOWLIST),
            'Manca docs/superpowers/bottoni-icona-senza-nome-allowlist.json: è l’elenco del debito ' +
                'residuo, senza il quale il lock non distingue il vecchio dal nuovo.',
        ).toBe(true)

        const a = leggiAllowlist()
        expect(Array.isArray(a.file)).toBe(true)
        for (const v of a.file) {
            expect(typeof v.path, `voce senza path: ${JSON.stringify(v)}`).toBe('string')
            expect(v.path.startsWith('src/'), `path fuori da src/: ${v.path}`).toBe(true)
            expect(Number.isInteger(v.n) && v.n > 0, `voce con n non valido: ${v.path}`).toBe(true)
            expect(fs.existsSync(path.join(RADICE, v.path)), `file sparito: ${v.path} — togli la voce`).toBe(true)
            // Una riga di allowlist è una decisione: chi la aggiunge deve poterla difendere.
            expect(
                (v.motivo ?? '').length,
                `la voce ${v.path} non spiega perché è ancora lì`,
            ).toBeGreaterThan(40)
        }
        const doppi = a.file.map((v) => v.path).filter((p, i, arr) => arr.indexOf(p) !== i)
        expect(doppi, 'stesso file due volte').toEqual([])
        expect(a.totale_file, 'totale_file non combacia con le voci').toBe(a.file.length)
        expect(a.totale_occorrenze, 'totale_occorrenze non combacia con la somma').toBe(
            a.file.reduce((s, v) => s + v.n, 0),
        )
    })

    it('nessun bottone a sola icona FUORI dall’allowlist resta senza nome', () => {
        const noti = new Set(leggiAllowlist().file.map((v) => v.path))
        const nuovi = MISURA.senzaNome
            .filter((b) => !noti.has(b.file))
            .map((b) => `${b.file}:${b.riga} (${b.contenuto})`)

        expect(
            nuovi,
            'Comandi che uno screen reader annuncia «pulsante», senza dire che cosa fanno. ' +
                COME_SI_CORREGGE,
        ).toEqual([])
    })

    it('nei file dell’allowlist il numero può solo SCENDERE', () => {
        const cresciuti: string[] = []
        for (const v of leggiAllowlist().file) {
            const n = PER_FILE.get(v.path) ?? 0
            if (n > v.n) cresciuti.push(`${v.path}: dichiarati ${v.n}, misurati ${n}`)
        }
        expect(cresciuti, `Il debito si smaltisce, non si rifinanzia. ${COME_SI_CORREGGE}`).toEqual([])
    })

    it('ogni nome preso dal catalogo punta a una chiave che ESISTE', () => {
        const mancanti: string[] = []
        for (const rel of sorgenti()) {
            mancanti.push(...chiaviNomeMancanti(fs.readFileSync(path.join(RADICE, rel), 'utf8'), rel))
        }
        expect(
            mancanti,
            'Nomi accessibili agganciati a chiavi i18n inesistenti. next-intl non lascia il nome ' +
                'vuoto: ci mette il PERCORSO della chiave, e lo screen reader legge «namespace punto ' +
                'chiave». Aggiungi la voce in messages/it e messages/en (parità obbligatoria) o ' +
                'correggi il refuso.',
        ).toEqual([])
    })

    it('CONTROLLO POSITIVO: il controllo sulle chiavi vede davvero un refuso', () => {
        // Senza questa prova, un `chiaviNomeMancanti` che tornasse sempre `[]`
        // lascerebbe il test qui sopra verde su qualunque catalogo.
        const finto =
            "import { X } from 'lucide-react'\n" +
            "const A = () => { const t = useTranslations('common'); " +
            "return <button aria-label={t('chiaveCheNonEsisteDavvero')}><X /></button> }"
        expect(chiaviNomeMancanti(finto)).toHaveLength(1)

        // …e tace su una chiave che c'è (`common.chiudi` = «Chiudi»).
        const sano =
            "import { X } from 'lucide-react'\n" +
            "const A = () => { const t = useTranslations('common'); " +
            "return <button aria-label={t('chiudi')}><X /></button> }"
        expect(chiaviNomeMancanti(sano)).toEqual([])

        // E tace anche quando `t` è una PROP: è il caso vero di
        // `ChatConversationMenu.tsx`, dove il namespace lo decide il chiamante.
        // Senza questa distinzione il controllo segnalava un file corretto.
        const tDaProp =
            "import { X } from 'lucide-react'\n" +
            "const A = ({ t }) => { const s = useTranslations('shared'); " +
            "return <button aria-label={t('chiaveDelChiamante')}><X /></button> }"
        expect(chiaviNomeMancanti(tDaProp)).toEqual([])
    })

    it('i tetti scendono e non risalgono', () => {
        const file = new Set(MISURA.senzaNome.map((b) => b.file)).size
        expect(
            file,
            `File con bottoni senza nome: ${file} (tetto ${TETTO_FILE}).`,
        ).toBeLessThanOrEqual(TETTO_FILE)
        expect(
            MISURA.senzaNome.length,
            `Bottoni senza nome: ${MISURA.senzaNome.length} (tetto ${TETTO_OCCORRENZE}).`,
        ).toBeLessThanOrEqual(TETTO_OCCORRENZE)
    })
})
