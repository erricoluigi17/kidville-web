// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * LA BARRA DI FORZA E IL BLOCCO DELLA REGOLA SI VEDONO — sul fondo VERO su cui
 * stanno, non su quello che fa comodo.
 *
 * ─── IL PRIMO DIFETTO CHE QUESTA MISURA HA TROVATO (2026-09-01) ──────────────
 *
 * Le quattro tacche nascevano `bg-kidville-green` quando piene e `bg-kidville-line`
 * quando spente. `line` (#EFE7DC) vale **1,23:1** sul bianco: con una password
 * debole (una tacca su quattro) le tre spente sparivano, e la barra non comunicava
 * «una su quattro» ma un trattino. Cioè spariva la SCALA, che è l’unica cosa che
 * una barra di forza deve dire. Il rimedio è stato il CONTORNO.
 *
 * ─── ⚠️ IL SECONDO DIFETTO È DI QUESTO FILE, E VA DETTO PRIMA DEL RESTO ──────
 *
 * La prima versione di questo lock misurava il contorno delle tacche **contro
 * `#FFFFFF` scritto a mano**, e dichiarava 3,10:1 con `neutral` (#8A958F). Due
 * critici di design, misurando i PIXEL RESI e separatamente l’uno dall’altro,
 * hanno letto 2,35:1 e 2,7:1 — sotto i 3:1 di WCAG 1.4.11.
 *
 * Le due misure non si contraddicono: dicevano due cose diverse.
 *   · 3,10:1 è il rapporto fra due HEX. Vero, e inutile da solo.
 *   · 2,35–2,7:1 è ciò che resta di un contorno da **un pixel** dopo
 *     l’antialiasing, su una schermata catturata e riscalata.
 * Un contorno di 1px al minimo di norma non arriva a norma sullo schermo. E il
 * bianco non era nemmeno il fondo giusto: il blocco è CREMA.
 *
 * Da qui le due regole di questo file, che valgono più dei numeri che contiene:
 *   1. **il fondo si LEGGE dal sorgente**, non si scrive nell’asserzione;
 *   2. **sotto i 3:1 non ci si avvicina**: la soglia dichiarata qui è 4,5:1 anche
 *      dove la norma ne chiede 3, perché il margine è ciò che sopravvive al
 *      rendering. Un numero esatto al limite è un numero che passa in CSS e
 *      fallisce a schermo.
 *
 * ─── ⚠️ IN ALTO CONTRASTO LE UTILITY NON SI RIBALTANO. MISURATO. ────────────
 *
 * `globals.css` rimappa i token dentro `[data-contrast="high"]`, ma quel blocco è
 * inerte per le utility di Tailwind: `@theme inline` INLINA l’hex dentro la classe
 * generata (verificato sul CSS costruito: `.bg-kidville-green{background-color:#006a5f}`,
 * nessun `var()`). Le rimappature agiscono SOLO dove il CSS legge il token con
 * `var()` — `body`, i CSS module (la login) e le regole per-superficie scritte a
 * mano. Conseguenza: in Alto Contrasto questo form resta su carta bianca con
 * inchiostri scuri, come ogni altra carta dell’app, e i numeri qui sotto valgono
 * in entrambe le modalità.
 */

const RADICE = process.cwd()
const CARD = path.join(RADICE, 'src/components/features/account/CambiaPasswordCard.tsx')
const GLOBALS = path.join(RADICE, 'src/app/globals.css')

// ── WCAG 2.x §1.4.3 / §1.4.11 ───────────────────────────────────────────────
const canale = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const luminanza = (hex: string) => {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b)
}
const contrasto = (a: string, b: string) => {
  const [x, y] = [luminanza(a), luminanza(b)]
  const [alto, basso] = x > y ? [x, y] : [y, x]
  return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100
}

/**
 * IL COLORE CHE RESTA quando un tratto copre solo una FRAZIONE del pixel.
 *
 * È la funzione che spiega perché i due giri precedenti hanno alzato il token e il
 * difetto è tornato: un contorno da 1px su una pillola arrotondata, e un tratto SVG
 * da 1,25px, non arrivano a schermo col loro colore — arrivano con quel colore
 * MESCOLATO al fondo, in proporzione a quanto pixel occupano.
 */
function composita(inchiostro: string, fondo: string, copertura: number): string {
  const [a, b] = [inchiostro.replace('#', ''), fondo.replace('#', '')]
  const canali = [0, 2, 4].map((i) =>
    Math.round(parseInt(a.slice(i, i + 2), 16) * copertura + parseInt(b.slice(i, i + 2), 16) * (1 - copertura)),
  )
  return `#${canali.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

const css = fs.readFileSync(GLOBALS, 'utf8')
const sorgente = fs.readFileSync(CARD, 'utf8')

/** Il valore di un token, letto da `@theme inline` in `globals.css`. */
function token(nome: string): string {
  const m = new RegExp(`--color-kidville-${nome}\\s*:\\s*(#[0-9A-Fa-f]{6})`).exec(css)
  if (!m) throw new Error(`token --color-kidville-${nome} non dichiarato in globals.css`)
  return m[1].toUpperCase()
}

/**
 * Le classi di un elemento del sorgente, riconosciuto dal suo attributo-sonda.
 * Prende sia `className="…"` che `className={`…`}` — la seconda forma porta dentro
 * il ternario, ed è giusto così: entrambi i rami sono colori che qualcuno vedrà.
 */
function classiDi(sonda: string): string {
  const re = new RegExp(`${sonda}[\\s\\S]{0,500}?className=(?:"([^"]*)"|\\{\`([^\`]*)\`\\})`)
  const m = re.exec(sorgente)
  if (!m) throw new Error(`non trovo le classi di «${sonda}»: il rilevatore guarda la cosa sbagliata`)
  return m[1] ?? m[2]
}

/** I token `kidville-*` nominati in una stringa di classi, per prefisso di utility. */
function tokenIn(classi: string, prefisso: string): string[] {
  const re = new RegExp(`${prefisso}-kidville-([a-z-]+)`, 'g')
  return [...new Set([...classi.matchAll(re)].map((m) => m[1]))]
}

/** Il valore di una costante di classi dichiarata nel componente. */
function costante(nome: string): string {
  const m = new RegExp(`const ${nome}\\s*=\\s*\\n?\\s*'([^']*)'`).exec(sorgente)
  if (!m) throw new Error(`la costante ${nome} non esiste più nel componente`)
  return m[1]
}

/** Lo spessore in px dichiarato da `border` / `border-2` in una stringa di classi. */
function spessore(classi: string): number {
  if (/(?:^|\s)border-2(?:\s|$)/.test(classi)) return 2
  if (/(?:^|\s)border(?:\s|$)/.test(classi)) return 1
  throw new Error(`«${classi}» non dichiara nessuno spessore di bordo`)
}

/** L'altezza in px dichiarata da `h-N` / `h-N.5` in una stringa di classi. */
function altezza(classi: string): number {
  const m = /(?:^|\s)h-(\d+(?:\.\d+)?)(?:\s|$)/.exec(classi)
  if (!m) throw new Error(`«${classi}» non dichiara nessuna altezza`)
  return Number(m[1]) * 4
}

/**
 * Le proprietà geometriche di un'icona `lucide` dichiarata nel sorgente.
 * `size` e `strokeWidth` sono ciò che decide quanto inchiostro arriva a schermo.
 */
function icona(nome: string): { size: number; strokeWidth: number } {
  const m = new RegExp(`<${nome}\\b([^>]*?)/>`).exec(sorgente)
  if (!m) throw new Error(`l'icona <${nome}> non è più dichiarata nel componente`)
  const size = /\bsize=\{(\d+(?:\.\d+)?)\}/.exec(m[1])
  const tratto = /\bstrokeWidth=\{(\d+(?:\.\d+)?)\}/.exec(m[1])
  if (!size) throw new Error(`<${nome}> non dichiara la propria taglia`)
  if (!tratto) throw new Error(`<${nome}> non dichiara lo spessore del proprio tratto`)
  return { size: Number(size[1]), strokeWidth: Number(tratto[1]) }
}

/**
 * IL TRATTO RESO, in px CSS. `lucide` disegna su un viewBox di 24 e scala a `size`:
 * uno `strokeWidth` di 2 dentro un'icona da 15px arriva a schermo come **1,25px**.
 */
const trattoReso = (i: { size: number; strokeWidth: number }) =>
  Math.round(((i.strokeWidth * i.size) / 24) * 100) / 100

/**
 * IL FONDO VERO del blocco della regola, letto dal sorgente e non scritto qui.
 * È la correzione centrale di questo file: il riquadro è crema, e misurare i suoi
 * inchiostri sul bianco della card dava numeri che nessuno vede mai.
 */
const FONDO_BLOCCO = (() => {
  const [nome] = tokenIn(classiDi('data-regole'), 'bg')
  if (!nome) throw new Error('il blocco della regola non dichiara la propria superficie')
  return { nome, hex: token(nome) }
})()

/** Il fondo dei campi e delle tacche spente: la carta bianca del riempimento. */
const CARTA = () => token('white')

describe('a11y · la sonda legge davvero il sorgente', () => {
  it('senza questa prova, ogni numero del file è inventato', () => {
    expect(sorgente.length).toBeGreaterThan(3000)
    expect(classiDi('data-tacca')).toContain('kidville')
    expect(tokenIn(classiDi('data-tacca'), 'bg').length).toBeGreaterThanOrEqual(2)
    expect(tokenIn(classiDi('data-tacca'), 'border').length).toBeGreaterThanOrEqual(1)
    expect(FONDO_BLOCCO.hex).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('CONTROLLO POSITIVO — la sonda vede davvero un colore sotto soglia', () => {
    // Senza questa riga i divieti qui sotto sarebbero verdi anche con un calcolo
    // rotto che restituisce sempre un numero grande.
    expect(contrasto(token('line'), CARTA())).toBeLessThan(3)
    expect(contrasto(token('muted'), CARTA())).toBeLessThan(4.5)
    expect(contrasto(token('neutral'), FONDO_BLOCCO.hex)).toBeLessThan(3)
  })
})

describe('a11y · le quattro tacche si vedono tutte, sul fondo su cui stanno', () => {
  it('l’alloggiamento di una tacca SPENTA si stacca dal fondo del blocco, con margine', () => {
    const [contorno] = tokenIn(classiDi('data-tacca'), 'border')
    const r = contrasto(token(contorno), FONDO_BLOCCO.hex)
    expect(
      r,
      `Il contorno delle tacche (${contorno} = ${token(contorno)}) vale ${r}:1 sul fondo ` +
      `«${FONDO_BLOCCO.nome}» (${FONDO_BLOCCO.hex}). La norma ne chiede 3, questo lock ne ` +
      'chiede 4,5: un contorno da 1px al minimo di norma arriva a schermo SOTTO la norma ' +
      '(misurato dai critici: 2,35–2,7:1 su un `neutral` che in CSS ne dichiarava 3,10).',
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('…e si stacca anche dal proprio riempimento bianco', () => {
    const [contorno] = tokenIn(classiDi('data-tacca'), 'border')
    const r = contrasto(token(contorno), CARTA())
    expect(r, `il contorno vale ${r}:1 sul riempimento della tacca spenta`).toBeGreaterThanOrEqual(4.5)
  })

  it('una tacca PIENA si distingue da una spenta (≥3:1)', () => {
    const riempimenti = tokenIn(classiDi('data-tacca'), 'bg')
    const coppie = riempimenti.flatMap((a, i) => riempimenti.slice(i + 1).map((b) => [a, b] as const))
    expect(coppie.length, 'le tacche non hanno più due riempimenti diversi').toBeGreaterThanOrEqual(1)
    for (const [a, b] of coppie) {
      const r = contrasto(token(a), token(b))
      expect(
        r,
        `«${a}» e «${b}» distano ${r}:1: chi guarda non può dire quali tacche sono piene. ` +
        'Attenzione a “risolverlo” scurendo il riempimento spento: `neutral` come riempimento ' +
        'vale 3,10:1 sul bianco ma 2,10:1 contro il verde — stesso difetto, girato.',
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('la barra è larga quanto il campo: nessuna tacca porta una larghezza fissa', () => {
    // Non è estetica. A `w-9` le quattro tacche misuravano 4×36 + 3×6 = 162px dentro
    // un campo da 400: si leggevano come un rendering rotto, non come una misura.
    const classi = classiDi('data-tacca')
    expect(classi, 'una tacca ha ancora una larghezza fissa').not.toMatch(/\bw-\d/)
    expect(classi, 'le tacche non si dividono la riga').toMatch(/\bflex-1\b/)
    expect(classiDi('data-tacche'), 'la riga delle tacche non è larga quanto il campo').toMatch(/\bw-full\b/)
  })

  it('la PAROLA accanto alla barra esiste: il colore non è mai l’unica informazione (1.4.1)', () => {
    // Le tacche sono `aria-hidden`; senza l’etichetta testuale la forza resterebbe
    // comunicata SOLO dal colore — e a uno screen reader, da niente.
    expect(sorgente).toContain('data-forza-etichetta')
    expect(sorgente).toContain("t('forzaTitolo')")
    expect(sorgente).toContain("t('forzaNonValutata')")
    expect(sorgente).toMatch(/aria-live="polite"/)
  })
})

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * IL TERZO DIFETTO, ED È GEOMETRICO: L'INCHIOSTRO PIÙ SOTTILE DI DUE PIXEL.
 *
 * ⚠️ QUESTO FILE HA GIÀ SBAGLIATO DUE VOLTE LA STESSA DIAGNOSI, e la terza volta
 * la misura l'ha decisa. Il 2026-09-02 due critici indipendenti hanno riletto la
 * schermata e hanno misurato, ognuno per conto suo, di nuovo sotto soglia:
 *   · il binario delle tacche spente → **2,14–2,65:1**
 *   · i marcatori dei requisiti (i trattini) → **2,20–2,45:1**
 * con i token già portati a `sub` (5,82:1 sul crema) e `ink` (10,61:1). Cioè: il
 * COLORE era a norma da un giro, e il numero misurato non si è mosso.
 *
 * LA CAUSA RADICE, misurata sulla pagina servita (`getComputedStyle`, non dedotta):
 *   · il contorno della tacca è `border-width: 1px` su una pillola ARROTONDATA;
 *   · il marcatore è `<Minus size={15} strokeWidth={2}/>` su un viewBox di 24,
 *     cioè un tratto reso di **1,25px**.
 * Sotto i 2px il tratto non copre un pixel intero: quello che arriva allo schermo
 * non è il token, è il token MESCOLATO al fondo. E l'aritmetica ricostruisce
 * esattamente le due misure dei critici:
 *   · `sub` al 50–63% di copertura sul crema → 2,13–2,67:1  (misurato: 2,14–2,65)
 *   · `ink` al 40–50% di copertura sul crema → 2,16–2,71:1  (misurato: 2,20–2,45)
 * Due modelli indipendenti che cadono sullo stesso numero non sono una coincidenza:
 * sono la diagnosi.
 *
 * PERCHÉ I DUE GIRI PRECEDENTI NON L'HANNO PRESA. Perché hanno cercato il difetto
 * dove sapevano guardare — nella TAVOLOZZA — e la tavolozza era innocente da un
 * pezzo. Un lock che legge solo degli hex è cieco su tutto ciò che decide quanti
 * pixel quell'hex riesce a dipingere. Da qui la regola di questo blocco, che non
 * parla di colori:
 *
 *        NESSUN INCHIOSTRO SOTTO I 2 PX IN QUESTO BLOCCO.
 *
 * ─── ⚠️ E PERCHÉ IL «BINARIO PIENO» PROPOSTO DAI CRITICI NON SI PUÒ FARE ─────
 *
 * Il suggerimento era: riempi la tacca spenta con un tono ≥3:1 sul crema, così non
 * somiglia più a uno scheletro di caricamento. È stato MISURATO e non si regge:
 * `sub` (#55615C) e `green` (#006A5F) hanno luminanza quasi identica e distano
 * **1,01:1**. Qualunque riempimento abbastanza scuro da staccarsi dal crema si
 * avvicina alla luminanza del verde, e le tacche PIENE diventerebbero
 * indistinguibili da quelle vuote: si chiuderebbe 1.4.11 sul fondo aprendolo fra i
 * due stati, che è la stessa falla girata. Il rimedio compatibile con entrambe le
 * adiacenze è quello opposto: nucleo CHIARO (6,51:1 contro il verde) e contorno
 * SPESSO (5,82:1 sul crema, e stavolta reso davvero).
 * ═══════════════════════════════════════════════════════════════════════════════
 */
describe('a11y · l’inchiostro che non arriva a schermo: la geometria, non la tavolozza', () => {
  it('CONTROLLO POSITIVO — il modello ricostruisce le due misure dei critici', () => {
    // Senza questa prova, «l'antialiasing se lo mangia» sarebbe una frase, non una
    // diagnosi: qui si vede che il colore giusto, steso su meno di un pixel, cade
    // esattamente dove i due critici l'hanno letto.
    const binario = contrasto(composita(token('sub'), FONDO_BLOCCO.hex, 0.5), FONDO_BLOCCO.hex)
    const marcatore = contrasto(composita(token('ink'), FONDO_BLOCCO.hex, 0.5), FONDO_BLOCCO.hex)
    expect(binario, `binario a metà copertura: ${binario}:1 (i critici: 2,14–2,65)`).toBeGreaterThanOrEqual(2)
    expect(binario).toBeLessThan(3)
    expect(marcatore, `marcatore a metà copertura: ${marcatore}:1 (i critici: 2,20–2,45)`).toBeLessThan(3)
    // …e a piena copertura gli stessi token sono ampiamente a norma: la tavolozza
    // non era il difetto, e cambiarla una terza volta non avrebbe spostato niente.
    expect(contrasto(token('sub'), FONDO_BLOCCO.hex)).toBeGreaterThanOrEqual(4.5)
    expect(contrasto(token('ink'), FONDO_BLOCCO.hex)).toBeGreaterThanOrEqual(4.5)
  })

  it('CONTROLLO POSITIVO — la sonda vede davvero un tratto troppo sottile', () => {
    // La geometria di PRIMA (`size={15} strokeWidth={2}`) misurata dalla stessa
    // formula che giudica quella di adesso. Se questa riga diventasse verde, il
    // divieto qui sotto sarebbe verde su qualunque cosa.
    expect(trattoReso({ size: 15, strokeWidth: 2 })).toBe(1.25)
    expect(trattoReso({ size: 15, strokeWidth: 2 })).toBeLessThan(2)
  })

  it('il binario di una tacca SPENTA è spesso almeno 2px', () => {
    const s = spessore(classiDi('data-tacca'))
    expect(
      s,
      `il contorno delle tacche vale ${s}px. A 1px il token «sub» (5,82:1 sul crema) arriva ` +
      'a schermo a 2,1–2,7:1, perché su una pillola arrotondata il tratto copre metà pixel. ' +
      'Il rimedio non è un colore più scuro — quello è già a norma — è più inchiostro.',
    ).toBeGreaterThanOrEqual(2)
  })

  it('…e la tacca è alta abbastanza da avere ancora un NUCLEO fra i due contorni', () => {
    // Un contorno da 2px su una pillola da 8px lascia 4px di nucleo: la tacca piena e
    // quella vuota si distinguono per il riempimento, e serve che il riempimento esista.
    const classi = classiDi('data-tacca')
    const nucleo = altezza(classi) - 2 * spessore(classi)
    expect(nucleo, `fra i due contorni restano ${nucleo}px di riempimento`).toBeGreaterThanOrEqual(6)
  })

  it('ogni marcatore dei requisiti dipinge almeno 2px di tratto', () => {
    for (const nome of ['Minus', 'CheckCircle2'] as const) {
      const i = icona(nome)
      const reso = trattoReso(i)
      expect(
        reso,
        `<${nome} size={${i.size}} strokeWidth={${i.strokeWidth}}/> rende un tratto di ${reso}px. ` +
        'Sotto i 2px il marcatore arriva a schermo mescolato al crema: i critici l’hanno ' +
        'misurato a 2,20–2,45:1 mentre il token dichiarava 10,61:1.',
      ).toBeGreaterThanOrEqual(2)
    }
  })

  it('il rimedio «binario pieno» è escluso da una misura, non da un’opinione', () => {
    // Se un giorno qualcuno riproponesse di riempire la tacca spenta di scuro, questo
    // numero è la ragione per cui non si può: le due tacche diventerebbero uguali.
    const r = contrasto(token('sub'), token('green'))
    expect(r, `«sub» e «green» distano ${r}:1: un binario pieno scuro sparirebbe dentro il verde`).toBeLessThan(3)
  })
})

describe('a11y · il testo del blocco è il più importante della schermata, non il meno leggibile', () => {
  /** Ogni inchiostro dichiarato dal blocco: titoli, valore della forza, requisiti. */
  const inchiostri = () => [
    ...tokenIn(classiDi('data-regole'), 'text'),
    ...tokenIn(classiDi('data-forza-etichetta'), 'text'),
    ...tokenIn(classiDi('data-criterio'), 'text'),
    ...tokenIn(classiDi('data-criteri'), 'text'),
  ]

  it('la sonda trova davvero degli inchiostri (senza, il divieto è verde sul vuoto)', () => {
    expect([...new Set(inchiostri())].length).toBeGreaterThanOrEqual(2)
  })

  it('ogni inchiostro del blocco vale ≥4,5:1 sul CREMA del riquadro, non sul bianco della card', () => {
    // ⚠️ È il testo che decide se il genitore riesce a entrare, ed era il meno
    // leggibile della schermata: 3,83–4,4:1 misurati sui pixel dai due critici.
    for (const nome of [...new Set(inchiostri())]) {
      const r = contrasto(token(nome), FONDO_BLOCCO.hex)
      expect(
        r,
        `«${nome}» (${token(nome)}) vale ${r}:1 sul fondo «${FONDO_BLOCCO.nome}» ` +
        `(${FONDO_BLOCCO.hex}). Sotto 4,5:1 non ci va il testo che spiega come scegliere ` +
        'una password: è l’unica riga che, se non si legge, chiude fuori qualcuno.',
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('e il più debole dei due tiene comunque 5:1: il margine è ciò che sopravvive al rendering', () => {
    const minimo = Math.min(...[...new Set(inchiostri())].map((n) => contrasto(token(n), FONDO_BLOCCO.hex)))
    expect(minimo, `l’inchiostro più debole del blocco vale ${minimo}:1`).toBeGreaterThanOrEqual(5)
  })
})

describe('a11y · il bordo dei campi: il riposo non è più il trattamento più forte', () => {
  /**
   * LA CASCATA SI RISOLVE, NON SI INDOVINA. `border-kidville-line` su un `<input>`
   * non resta `line`: una regola NON-layered di `globals.css` lo riscrive, e sotto un
   * antenato `.bg-kidville-cream` — le tre shell dell’app e l’interstiziale del primo
   * accesso lo sono tutte — lo porta a un token più scuro. Il numero vero è quello.
   */
  const risolto = (() => {
    const blocco = /\.bg-kidville-cream input\[class\*="border-kidville-line"\][\s\S]{0,900}?\{([\s\S]*?)\}/.exec(css)
    if (!blocco) throw new Error('la regola che riscrive il bordo dei campi su crema non esiste più')
    const m = /border-color:\s*var\(--color-kidville-([a-z-]+)\)/.exec(blocco[1])
    if (!m) throw new Error('la regola non dichiara più un token di bordo')
    return m[1]
  })()

  const RIPOSO = () => costante('CAMPO_A_RIPOSO')
  const ERRORE = () => costante('CAMPO_IN_ERRORE')

  it('la sonda risolve davvero la cascata (e non legge la sola utility)', () => {
    expect(risolto, 'il bordo dei campi su crema non è più risolto a un token').toBeTruthy()
    expect(RIPOSO()).toContain('border-kidville-line')
    expect(token(risolto)).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('a riposo il bordo resta VISIBILE (≥3:1) ma vale UN pixel', () => {
    const r = contrasto(token(risolto), CARTA())
    expect(r, `il bordo a riposo (${risolto} = ${token(risolto)}) vale ${r}:1 sul campo bianco`).toBeGreaterThanOrEqual(3)
    expect(spessore(RIPOSO()), 'il bordo a riposo è ancora di 2px').toBe(1)
  })

  it('l’ERRORE è più spesso del riposo, e resta a norma', () => {
    const [tinta] = tokenIn(ERRORE(), 'border')
    const r = contrasto(token(tinta), CARTA())
    expect(r, `il bordo d’errore (${tinta} = ${token(tinta)}) vale ${r}:1`).toBeGreaterThanOrEqual(3)
    expect(
      spessore(ERRORE()),
      'il bordo d’errore non è più spesso del riposo: con entrambi a 2px l’errore era ' +
      '*meno* evidente dello stato normale (4,23:1 contro 6,46:1)',
    ).toBeGreaterThan(spessore(RIPOSO()))
    // …e in errore la classe che la cascata riscrive NON c’è: quella regola dichiara
    // di non toccare i bordi di stato, e ci riesce solo se `line` in quel momento manca.
    expect(ERRORE(), 'in errore resta la classe che la cascata riscriverebbe').not.toContain('border-kidville-line')
  })

  it('il FUOCO aggiunge un anello: il riposo non ne ha nessuno', () => {
    expect(RIPOSO()).toMatch(/focus:border-kidville-green/)
    expect(RIPOSO(), 'il fuoco è ancora un solo cambio di tinta').toMatch(/focus:ring-2/)
    expect(RIPOSO(), 'l’anello del fuoco esiste già a riposo').not.toMatch(/(?:^|\s)ring-2(?:\s|$)/)
    const [anello] = tokenIn(RIPOSO(), 'focus:ring')
    const r = contrasto(token(anello), CARTA())
    expect(r, `l’anello del fuoco (${anello}) vale ${r}:1 sulla carta`).toBeGreaterThanOrEqual(3)
  })
})

describe('a11y · le due premesse su cui poggiano tutti i numeri di questo file', () => {
  it('i token sono ancora dichiarati con `@theme inline` (se no, in Alto Contrasto si ribaltano)', () => {
    // Se un giorno `@theme inline` diventasse `@theme`, le utility comincerebbero a
    // leggere i token con `var()` e in Alto Contrasto il verde diventerebbe BIANCO su
    // carta bianca — tacche piene invisibili, con questo file ancora verde.
    expect(css, 'i token non sono più dichiarati con `@theme inline`').toMatch(/@theme\s+inline\s*\{/)
  })

  it('…e il blocco di Alto Contrasto esiste davvero', () => {
    // Senza, la frase qui sopra starebbe descrivendo una protezione che non c'è più.
    expect(css).toMatch(/\[data-contrast="high"\]\s*\{/)
  })
})
