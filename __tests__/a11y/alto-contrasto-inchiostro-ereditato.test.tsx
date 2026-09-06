import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  creaSonda,
  parseRegole,
  specificita,
  contrasto,
  rgb,
  soglia,
  leggiGlobals,
  GUSCIO_PARENT,
  GUSCIO_CARD_BIANCA,
  GUSCIO_PUBBLICO,
  type Regola,
} from './cascata'

// =============================================================================
// L'ALTO CONTRASTO SCRIVE BIANCO SU CARTA CHIARA — tre difetti, una radice.
//
// ─── PERCHÉ QUESTO LOCK NASCE PRIMA DELLA CORREZIONE ────────────────────────
// `kv-news-onbody` compare ZERO volte in `__tests__/` e in `e2e/`, e la suite di
// accessibilità è verde: 509 test in 6,68 s. Il difetto non è verde perché è
// stato risolto — è verde perché **nessuno lo guarda**. Se il lock lo
// scrivessimo dopo la correzione non sapremmo mai se morde: passerebbe subito,
// e un test che passa subito non ha mai dimostrato niente.
// Perciò questo file è scritto ROSSO, di proposito, e va letto come la
// descrizione eseguibile di tre difetti che oggi esistono.
//
// ─── LA REGOLA DEL POSTO, MISURATA E NON DEDOTTA ────────────────────────────
// `@theme inline` INLINA l'hex dentro le utility Tailwind: ridefinire un token
// sotto `[data-contrast="high"]` NON tocca `.bg-kidville-cream` né nessun'altra
// classe. L'Alto Contrasto è dipinto superficie per superficie in `globals.css`.
// E LA CARTA NON SI RIBALTA CON L'INCHIOSTRO: i tre gusci dell'app
// (`src/app/(dashboard)/{parent,teacher,admin}/layout.tsx`) sono
// `min-h-screen bg-kidville-cream` — #FEF1E4 inlinato — e le card dentro sono
// bianche. Il `body` nero dell'Alto Contrasto sta DIETRO, e non si vede quasi mai.
//
// ─── I TRE DIFETTI ──────────────────────────────────────────────────────────
// D1 · INCHIOSTRO EREDITATO, 1,00:1 — è la radice.
//      In Alto Contrasto l'inchiostro del `body` diventa #FFFFFF e viene
//      EREDITATO da ogni elemento che non dichiari una classe `text-*`. La carta
//      sotto resta crema o bianca. Testo invisibile.
//      ⚠️ La dichiarazione `color:#FFFFFF` dentro `[data-contrast="high"] body`
//      (globals.css:478) è RIDONDANTE: togliendola il colore resta bianco,
//      perché `body { color: var(--color-kidville-green) }` (globals.css:188)
//      legge il token rimappato a #FFFFFF (globals.css:423). Chi tratta la 478
//      come «la radice» conclude che il difetto non esiste. §1.7 lo misura.
// D2 · `.kv-news-onbody` TESTO BIANCO, 1,11:1 (globals.css:733-737). Il commento
//      accanto dichiara «sul body nero»: il fondo reale è #FEF1E4. In luce
//      normale la stessa scritta vale 5,82:1 — l'Alto Contrasto la PEGGIORA di
//      cinque volte.
// D3 · `.kv-news-onbody` LINK GIALLO, 1,15:1 (globals.css:738-741). «TUTTE LE
//      NEWS», «TUTTI I DIGEST», «I MIEI CONTENUTI» e i titoli h2 degli stati
//      vuoti. Raggiungibili col Tab (l'anello di fuoco è a norma), invisibili.
//
// ─── COSA IMPEDISCE A QUESTO LOCK DI ESSERE UN DECORO ───────────────────────
// §0 è la taratura: la sonda deve saper distinguere una coppia sana da una rotta
// PRIMA di essere creduta, e deve riprodurre i numeri che
// `__tests__/a11y/contrasto-cascata.test.tsx` già misura (il motore è lo stesso,
// estratto in `./cascata.ts`, e se i due divergono §0.5 diventa rossa).
// §0.7 è il controllo che smaschera il criterio ingenuo: misurare il fondo
// DICHIARATO NELLA REGOLA STESSA darebbe 21:1 proprio alla regola che causa D1.
// §2 vieta lo SCAMBIO di difetto: portare l'inchiostro ereditato a nero senza
// coprire le superfici che in Alto Contrasto dipingono davvero nero manderebbe
// `.kv-appbar` da 21:1 a 1:1. §2.3 lo dimostra applicando quella correzione
// sbagliata a una copia delle regole.
// §5 chiude il buco che §2 non poteva vedere: i riempimenti scuri che vengono da
// una UTILITY Tailwind e non da una regola dell'Alto Contrasto. Sono TREDICI, si
// calcolano dai token, e §5.5 guarda il CODICE — non il CSS — per pretendere che
// dentro nessuno di loro finisca un testo senza inchiostro proprio.
// =============================================================================

const RADICE = process.cwd()
const CSS = leggiGlobals()
const S = creaSonda(CSS)
const { T, T_HC, REGOLE, REGOLE_CSS } = S

const AA = 4.5
const sorgente = (rel: string) => fs.readFileSync(path.join(RADICE, rel), 'utf8')

/**
 * Le fixture di questo file sono markup COPIATO dalle pagine vere. Una copia
 * invecchia in silenzio: qui si pretende che il pezzo di `className` da cui
 * dipende la misura sia ANCORA nel sorgente. Se qualcuno cambia la pagina, il
 * messaggio dice quale fixture aggiornare invece di lasciar misurare un DOM che
 * non esiste più.
 */
function fixtureViva(file: string, frammento: string) {
  expect(
    sorgente(file).includes(frammento),
    `fixture scaduta: «${frammento}» non è più in ${file} — aggiorna il markup di questo lock`,
  ).toBe(true)
}

/**
 * LA REGOLA CHE CORREGGE D1, riconosciuta dalla sua forma e non dal suo posto:
 * i due selettori in testa al blocco Alto Contrasto che portano a NERO
 * l'inchiostro EREDITATO dentro le due carte chiare dell'app — i tre
 * `[data-kv-shell]` e `.kv-public`.
 * Serve a poterla TOGLIERE e rimisurare: più prove di questo file la filtrano
 * per dimostrare che senza di lei il difetto torna. Il controllo su `color`
 * non è pignoleria — `[data-contrast="high"] .kv-public` esiste anche come
 * regola della CARTA (dipinge il fondo bianco), e quella non va toccata.
 */
const eRegolaInchiostroGusci = (r: Regola) =>
  /^\[data-contrast="high"\] (\[data-kv-shell\]|\.kv-public)$/.test(r.sel) &&
  r.dich.some((d) => d.prop === 'color')

/** Le regole del file SENZA la correzione di D1: com'era prima del 2026-09-06. */
const SENZA_LA_CORREZIONE = REGOLE.filter((r) => !eRegolaInchiostroGusci(r))

afterEach(() => S.pulisci())

// =============================================================================
describe('§0 · la sonda si tara PRIMA di essere creduta', () => {
  it('0.1 la specificità è quella del CSS, non una stima', () => {
    expect(specificita('body')).toEqual([0, 0, 1])
    expect(specificita('[data-contrast="high"] body')).toEqual([0, 1, 1])
    expect(specificita('[data-contrast="high"] .kv-news-onbody')).toEqual([0, 2, 0])
    expect(specificita('[data-contrast="high"] a.kv-news-onbody')).toEqual([0, 2, 1])
    expect(specificita('[data-contrast="high"] .kv-public [class*="text-kidville-"]')).toEqual([0, 3, 0])
    expect(specificita('.kv-tab-giallo .text-white\\/70')).toEqual([0, 2, 0])
  })

  it('0.2 a parità di specificità vince l’ULTIMA regola, e invertendo l’ordine cambia esito', () => {
    const el = S.monta('<span id="sonda" class="a b"></span>', false)
    expect(S.coloreTesto(el, false, parseRegole('.a{color:#111111}.b{color:#222222}'))).toBe('#222222')
    expect(S.coloreTesto(el, false, parseRegole('.b{color:#222222}.a{color:#111111}'))).toBe('#111111')
  })

  it('0.3 una regola NON-layered batte una utility layered anche se meno specifica', () => {
    const util: Regola[] = [
      { sel: '.x.y', dich: [{ prop: 'color', val: '#111111' }], contesto: [], ordine: 0, layer: true, gruppo: '.x.y' },
    ]
    const el = S.monta('<span id="sonda" class="x y z"></span>', false)
    expect(S.coloreTesto(el, false, [...util, ...parseRegole('.z{color:#222222}')])).toBe('#222222')
  })

  it('0.4 le utility dei token sono INLINATE: in Alto Contrasto non si ribaltano da sole', () => {
    const el = S.monta('<span id="sonda" class="text-kidville-green"></span>', true)
    expect(S.coloreTesto(el, true)).toBe(T.green) // la CLASSE resta verde di brand…
    expect(T_HC.green).toBe('#FFFFFF') // …mentre il TOKEN sì che si ribalta
    expect(T.cream).toBe('#FEF1E4')
    expect(T_HC.cream).toBe('#000000')
  })

  it('0.5 TARATURA INCROCIATA: il motore riproduce il difetto storico a 1,28:1', () => {
    // È la misura che `contrasto-cascata.test.tsx` §1.3 già fa con il proprio
    // esemplare del motore. Se i due divergessero, questa riga cadrebbe — ed è
    // l'unica cosa che tiene onesta la convivenza fra le due copie.
    const senzaFix = REGOLE.filter((r) => !/\.bg-kidville-yellow(\.|\s+\.)text-kidville/.test(r.sel))
    expect(senzaFix.length).toBeLessThan(REGOLE.length)
    const m = S.misura(
      '<header class="kv-header-card kv-tab-giallo bg-kidville-yellow">' +
        '<span id="sonda" class="bg-kidville-yellow text-kidville-green">NUOVO</span></header>',
      true,
      senzaFix,
    )
    expect(m.fg).toBe('#FFFFFF')
    expect(m.bg).toBe(T_HC.yellow)
    expect(m.rapporto).toBe(1.28)
  })

  it('0.6 CONTROLLO POSITIVO: sa distinguere il sano dal rotto', () => {
    // Nota BUONA: nero su crema. Deve passare.
    expect(contrasto('#000000', T.cream)).toBe(18.92)
    expect(contrasto('#000000', T.cream)).toBeGreaterThanOrEqual(AA)
    // Nota CATTIVA: bianco su crema — è esattamente D2. Deve NON passare.
    expect(contrasto('#FFFFFF', T.cream)).toBe(1.11)
    expect(contrasto('#FFFFFF', T.cream)).toBeLessThan(AA)
    // E la soglia segue WCAG 1.4.3, non un numero unico.
    expect(soglia(14, 400)).toBe(4.5)
    expect(soglia(20, 700)).toBe(3)
  })

  it('0.7 CONTROLLO POSITIVO: fondo E inchiostro si risalgono, non si leggono dalla regola', () => {
    // È la trappola di D1, e il punto più delicato di tutto il lock.
    // ⚠️ ADEGUATO il 2026-09-06, INSIEME alla correzione, e vale la pena dire
    // perché non è un allentamento. Questa prova calibra UNA cosa: che la sonda
    // risale l'albero invece di leggere ciò che la regola dichiara su sé stessa.
    // Le due misure la dimostravano con numeri (#FFFFFF, 1,11) che erano
    // numeri DEL DIFETTO: corretto il difetto, tenerli avrebbe preteso che il
    // difetto ci fosse ancora. La calibrazione si fa adesso sulla DIFFERENZA
    // fra le due misure, che è ciò che si voleva provare — ed è diventata più
    // stretta, perché adesso differiscono sia il fondo sia l'inchiostro.
    // Il numero storico non si perde: sta qui sotto, misurato togliendo la
    // regola nuova, e serve anche da prova che quella regola morde.
    const nudo = S.misura('<span id="sonda">testo</span>', true)
    const dentro = S.misura(
      GUSCIO_PARENT.replace('></div>', '><span id="sonda">testo</span></div>'),
      true,
    )
    // Stesso `<span>` nudo, due posti: il fondo lo decide il primo antenato
    // DIPINTO (il `body` nero di là, il guscio crema di qua)…
    expect(nudo.bg).toBe('#000000')
    expect(dentro.bg).toBe(T.cream)
    // …e l'inchiostro il primo antenato che lo DICHIARA (il `body` di là, il
    // guscio di qua). Un criterio ingenuo darebbe lo stesso esito due volte.
    expect(nudo.fg).toBe('#FFFFFF')
    expect(dentro.fg).toBe('#000000')
    expect(nudo.rapporto).toBe(21)
    expect(dentro.rapporto).toBe(18.92)
    expect(dentro.rapporto).not.toBe(nudo.rapporto)

    // IL NUMERO STORICO, e la prova che la regola nuova è portante: senza di
    // lei lo stesso `<span>` dentro lo stesso guscio torna a 1,11:1.
    expect(
      SENZA_LA_CORREZIONE.length,
      'la regola nuova esiste ed è stata filtrata',
    ).toBeLessThan(REGOLE.length)
    const prima = S.misura(
      GUSCIO_PARENT.replace('></div>', '><span id="sonda">testo</span></div>'),
      true,
      SENZA_LA_CORREZIONE,
    )
    expect(prima.fg).toBe('#FFFFFF')
    expect(prima.rapporto).toBe(1.11)
  })
})

// =============================================================================
// §1 — D1. L'INCHIOSTRO EREDITATO, SULLA CARTA REALE DI OGNI GUSCIO.
// =============================================================================

/** I tre gusci dell'app, più la superficie pubblica. Carta reale, non dichiarata. */
const GUSCI: [string, string, string][] = [
  ['guscio genitore/docente/cockpit (crema)', GUSCIO_PARENT, 'src/app/(dashboard)/parent/layout.tsx:20'],
  ['card bianca dentro il guscio', GUSCIO_CARD_BIANCA, 'ogni `rounded-card bg-white` dell’app'],
  ['superficie pubblica `.kv-public`', GUSCIO_PUBBLICO, 'src/app/privacy/page.tsx:87'],
]

describe('§1 · D1 — chi non dichiara un inchiostro eredita il BIANCO su carta chiara', () => {
  it('1.0 i tre gusci dell’app sono davvero `bg-kidville-cream` (se cambiano, cambia il lock)', () => {
    for (const layout of ['parent', 'teacher', 'admin']) {
      const src = sorgente(`src/app/(dashboard)/${layout}/layout.tsx`)
      expect(src, `${layout}/layout.tsx`).toContain('min-h-screen bg-kidville-cream')
      expect(src, `${layout}/layout.tsx`).toContain('data-kv-shell')
    }
  })

  it.each(GUSCI)('1.1 %s — un testo senza classe `text-*` regge AA in Alto Contrasto', (nome, guscio, dove) => {
    const el = S.monta(guscio.replace('></div>', '><p id="sonda">testo</p></div>').replace('></main>', '><p id="sonda">testo</p></main>'), true)
    const m = S.misuraEl(el, true)
    expect(
      m.rapporto,
      `D1 · ${nome} (${dove}): inchiostro EREDITATO ${m.fg} su carta ${m.bg} = ${m.rapporto}:1, ` +
        `serve ≥ ${AA}:1. In Alto Contrasto il testo è invisibile.`,
    ).toBeGreaterThanOrEqual(AA)
  })

  it('1.2 /admin/merchandise — la quantità e le due icone «Diminuisci»/«Aumenta»', () => {
    const F = 'src/app/(dashboard)/admin/merchandise/page.tsx'
    fixtureViva(F, 'rounded-card bg-kidville-white p-4 shadow-sm')
    fixtureViva(F, 'className="w-6 text-center font-maven text-sm font-bold"')
    fixtureViva(F, 'flex h-8 w-8 items-center justify-center rounded-full border border-kidville-line')
    // Markup reale, `merchandise/page.tsx:337-341`. Le icone sono disegnate con
    // `currentColor`: senza inchiostro restano DUE CERCHI VUOTI.
    const riga =
      // Il guscio c'è perché nell'app c'è: la pagina sta dentro `admin/layout.tsx`.
      // Una fixture che monta la card NUDA misurerebbe un DOM che non esiste, e
      // resterebbe rossa anche dopo una correzione che copre `[data-kv-shell]`.
      '<div class="min-h-screen bg-kidville-cream" data-kv-shell>' +
      '<div class="rounded-card bg-kidville-white p-4 shadow-sm">' +
      '<div class="flex flex-wrap items-center gap-2 rounded-input border border-kidville-line p-2">' +
      '<div class="flex items-center gap-1">' +
      '<button type="button" aria-label="Diminuisci" class="flex h-8 w-8 items-center justify-center rounded-full border border-kidville-line"><svg id="icona"></svg></button>' +
      '<span id="sonda" class="w-6 text-center font-maven text-sm font-bold">3</span>' +
      '</div></div></div></div>'
    // Si misurano TUTTI e poi si asserisce una volta sola: un `expect` per
    // ciascuno si fermerebbe al primo, e il messaggio nominerebbe un colpevole
    // su due. Qui il rosso li elenca entrambi.
    S.montaAlbero(riga, true)
    const colpevoli = ([
      ['sonda', 'numero della quantità (merchandise/page.tsx:340)'],
      ['icona', 'icona di «Diminuisci»/«Aumenta», disegnata con currentColor (merchandise/page.tsx:339 e :341)'],
    ] as const)
      .map(([id, che]) => ({ che, m: S.misuraEl(document.getElementById(id)!, true) }))
      .filter((x) => x.m.rapporto < AA)
    expect(
      colpevoli.map((x) => `${x.che}: ${x.m.fg} su ${x.m.bg} = ${x.m.rapporto}:1`),
      `D1 · /admin/merchandise, riga «Nuovo ordine»: serve ≥ ${AA}:1. ` +
        `Spariscono il numero e le due icone — restano due cerchi vuoti.`,
    ).toEqual([])
  })

  it('1.3 /teacher/primaria/[sectionId]/registro — il <select> «Classe» della modale «Firma lezione»', () => {
    const F = 'src/app/(dashboard)/teacher/primaria/[sectionId]/registro/page.tsx'
    fixtureViva(F, 'font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm')
    fixtureViva(F, 'flex max-h-[85dvh] w-full max-w-md flex-col rounded-card bg-white shadow-xl')
    // Il preflight di Tailwind mette `color: inherit` su input/select/textarea:
    // un controllo che non dichiara inchiostro EREDITA, e qui eredita il bianco.
    const modale =
      '<div class="min-h-screen bg-kidville-cream" data-kv-shell>' +
      '<div class="flex max-h-[85dvh] w-full max-w-md flex-col rounded-card bg-white shadow-xl">' +
      '<div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"><div>' +
      '<label class="block font-maven text-xs text-kidville-muted">Classe</label>' +
      '<select class="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm">' +
      '<option id="sonda">1ª A</option></select>' +
      '</div></div></div></div>'
    const m = S.misuraEl(S.monta(modale, true), true)
    expect(
      m.rapporto,
      `D1 · /teacher/primaria/[sectionId]/registro, opzioni del <select> «Classe» ` +
        `(registro/page.tsx:350-351): ${m.fg} su ${m.bg} = ${m.rapporto}:1. Nessuna opzione è ` +
        `leggibile: la lezione si firma alla cieca, e può finire sulla classe sbagliata.`,
    ).toBeGreaterThanOrEqual(AA)
  })

  it('1.4 /teacher/primaria/[sectionId]/scrutinio — le due <textarea> del giudizio', () => {
    const F = 'src/app/(dashboard)/teacher/primaria/[sectionId]/scrutinio/page.tsx'
    fixtureViva(F, 'font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm disabled:bg-kidville-cream')
    const blocco =
      '<div class="min-h-screen bg-kidville-cream" data-kv-shell>' +
      '<div class="rounded-card bg-white p-5 shadow-sm"><div class="rounded-card bg-kidville-cream/30 p-3">' +
      '<textarea id="sonda" class="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm disabled:bg-kidville-cream"></textarea>' +
      '<textarea id="globale" class="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm disabled:bg-kidville-cream"></textarea>' +
      '</div></div></div>'
    S.montaAlbero(blocco, true)
    const colpevoli = ([
      ['sonda', 'scrutinio:364 — giudizio di COMPORTAMENTO'],
      ['globale', 'scrutinio:372 — giudizio GLOBALE'],
    ] as const)
      .map(([id, che]) => ({ che, m: S.misuraEl(document.getElementById(id)!, true) }))
      .filter((x) => x.m.rapporto < AA)
    expect(
      colpevoli.map((x) => `${x.che}: ${x.m.fg} su ${x.m.bg} = ${x.m.rapporto}:1`),
      `D1 · /teacher/primaria/[sectionId]/scrutinio: serve ≥ ${AA}:1. Il docente scrive il ` +
        `giudizio di un bambino senza vedere quello che scrive.`,
    ).toEqual([])
  })

  it('1.5 LA CARTA RESTA CHIARA in tutte e tre, e l’inchiostro ereditato la segue', () => {
    // Non era un difetto di UNA pagina: era la coppia `body bianco` × `carta
    // chiara`, e la metà che NON si può cambiare è la carta.
    // ⚠️ ADEGUATO il 2026-09-06 insieme alla correzione. Prima questa prova
    // asseriva `fg === '#FFFFFF'` su tutte e tre: era il CONTORNO del difetto,
    // cioè la descrizione dello stato di fatto. La metà che valeva davvero — «la
    // carta in Alto Contrasto resta CHIARA, e nessun rimappaggio di token la
    // ribalta» — non è cambiata di una virgola ed è ancora qui: è l'assunto su
    // cui poggia tutta la correzione, e se un giorno cadesse (per esempio
    // perché qualcuno prova a ribaltare i gusci) questa riga lo direbbe subito.
    // L'inchiostro adesso la segue, e la seconda metà della prova lo pretende.
    const carte = [
      ['guscio', GUSCIO_PARENT.replace('></div>', '><i id="sonda"></i></div>'), T.cream],
      ['card bianca', GUSCIO_CARD_BIANCA.replace('></div></div>', '><i id="sonda"></i></div></div>'), '#FFFFFF'],
      ['`.kv-public`', GUSCIO_PUBBLICO.replace('></main>', '><i id="sonda"></i></main>'), '#FFFFFF'],
    ] as const
    for (const [nome, html, atteso] of carte) {
      const m = S.misura(html, true)
      expect(m.bg, `carta di ${nome} in Alto Contrasto: DEVE restare chiara`).toBe(atteso)
      expect(m.fg, `inchiostro ereditato in ${nome}`).toBe('#000000')
      // …e senza la correzione le stesse tre tornano bianche su carta chiara.
      expect(
        S.misura(html, true, SENZA_LA_CORREZIONE).fg,
        `senza la correzione ${nome} tornerebbe bianco: la regola è portante`,
      ).toBe('#FFFFFF')
    }
  })

  it('1.6 su `.kv-public` il testo NUDO è coperto dalla regola nuova, non da quella dei token', () => {
    // `[data-contrast="high"] .kv-public [class*="text-kidville-"]` esisteva già,
    // ed è voluta e giusta: copre il testo TOKENIZZATO. Ma il testo NUDO le
    // sfugge per costruzione — non ha nessuna classe da agganciare — ed era la
    // falla. Adesso lo copre la regola dell'inchiostro ereditato, e questa prova
    // distingue i DUE presidi invece di confonderli: si toglie il secondo e si
    // guarda quale delle due misure cambia.
    const CON = GUSCIO_PUBBLICO.replace('></main>', '><p id="sonda" class="text-kidville-ink">x</p></main>')
    const SENZA = GUSCIO_PUBBLICO.replace('></main>', '><p id="sonda">x</p></main>')

    const conClasse = S.misura(CON, true)
    expect(conClasse.fg, 'il testo TOKENIZZATO è coperto e va a nero').toBe('#000000')
    expect(conClasse.rapporto).toBeGreaterThanOrEqual(AA)

    const senzaClasse = S.misura(SENZA, true)
    expect(senzaClasse.fg, 'il testo NUDO adesso va a nero anche lui').toBe('#000000')
    expect(senzaClasse.rapporto).toBeGreaterThanOrEqual(AA)

    // Il presidio è UNO e si vede quale: tolta la regola nuova, il tokenizzato
    // resta nero (lo tiene la regola vecchia) e il nudo torna bianco.
    expect(S.misura(CON, true, SENZA_LA_CORREZIONE).fg, 'tokenizzato: lo tiene la regola vecchia').toBe('#000000')
    expect(S.misura(SENZA, true, SENZA_LA_CORREZIONE).fg, 'nudo: era la falla, e lo chiude la regola nuova').toBe('#FFFFFF')
  })

  it('1.7 ⚠️ il `color` di `[data-contrast="high"] body` è RIDONDANTE, e la correzione sta altrove', () => {
    // LA TRAPPOLA, e resta una trappola anche a difetto corretto. Chi legge
    // `[data-contrast="high"] body { color:#FFFFFF }` conclude che quella riga è
    // la radice, la cancella e dichiara chiuso. Non chiude niente: il bianco del
    // `body` NON viene da lì, viene dal TOKEN — `body { color:
    // var(--color-kidville-green) }` legge `--color-kidville-green`, rimappato a
    // #FFFFFF. Le due cose vanno affrontate INSIEME, ed è il motivo per cui la
    // correzione non tocca il `body` ma dichiara l'inchiostro accanto alla CARTA.
    //
    // ⚠️ ADEGUATO il 2026-09-06. Prima questa prova misurava DENTRO il guscio, e
    // dopo la correzione il guscio è nero: la misura non avrebbe più potuto
    // vedere il bianco del `body`, che è ciò di cui la prova parla. Si misura
    // quindi sul `body` NUDO, dove il bianco vive davvero, e si toglie la sola
    // DICHIARAZIONE `color` invece dell'intera regola — così il fondo nero resta
    // ed è visibile che a cambiare non è stato il fondo.
    const laRiga = REGOLE_CSS.filter((r) => r.sel === '[data-contrast="high"] body')
    expect(laRiga.length, 'la regola `[data-contrast="high"] body` esiste ancora').toBeGreaterThan(0)
    expect(laRiga.flatMap((r) => r.dich).some((d) => d.prop === 'color')).toBe(true)

    const senzaQuellaDichiarazione = REGOLE.map((r) =>
      r.sel === '[data-contrast="high"] body'
        ? { ...r, dich: r.dich.filter((d) => d.prop !== 'color') }
        : r,
    )
    const m = S.misura('<span id="sonda">x</span>', true, senzaQuellaDichiarazione)
    expect(m.fg, 'tolta quella riga, l’inchiostro del body resta bianco: viene dal TOKEN').toBe('#FFFFFF')
    expect(m.bg, 'il fondo non è cambiato: si è tolto solo il `color`').toBe('#000000')
    // …e la prova che è proprio il token a dirlo:
    expect(T_HC.green).toBe('#FFFFFF')
    expect(CSS).toContain('color: var(--color-kidville-green)')

    // L'ALTRA METÀ, che è quella che corregge davvero: la regola sull'inchiostro
    // dei gusci. Toglierla riporta il difetto esattamente com'era — bianco su
    // crema, 1,11:1 — mentre togliere la riga del `body` non cambia niente.
    // È la differenza fra le due che dice quale delle due è la correzione.
    const tornato = S.misura(
      GUSCIO_PARENT.replace('></div>', '><p id="sonda">x</p></div>'),
      true,
      SENZA_LA_CORREZIONE,
    )
    expect(tornato.fg).toBe('#FFFFFF')
    expect(tornato.rapporto).toBe(1.11)
    // …mentre con la riga del body tolta e la correzione al suo posto, sta bene.
    const sano = S.misura(
      GUSCIO_PARENT.replace('></div>', '><p id="sonda">x</p></div>'),
      true,
      senzaQuellaDichiarazione,
    )
    expect(sano.fg).toBe('#000000')
    expect(sano.rapporto).toBe(18.92)
  })
})

// =============================================================================
// §2 — LO SCAMBIO DI DIFETTO. Le superfici che il nero lo dipingono DAVVERO.
// =============================================================================

/** L'ultimo fondo dichiarato da una regola, se è un nero pieno. */
function fondoNero(r: Regola): boolean {
  let bg: string | null = null
  for (const d of r.dich) {
    if (d.prop === 'background-color') bg = d.val
    else if (d.prop === 'background' && !/gradient|url\(/i.test(d.val)) {
      const m = d.val.match(/#[0-9A-Fa-f]{3,6}\b/)
      if (m) bg = m[0]
    }
  }
  return bg !== null && /^#(000000|000)$/i.test(bg.trim())
}

/**
 * Le superfici che in Alto Contrasto dipingono un fondo NERO. Si LEGGONO dal
 * CSS, non si elencano a mano: un elenco a mano invecchia alla prima superficie
 * nuova, e una superficie nuova non coperta è esattamente il modo in cui questo
 * repo ha già prodotto due bloccanti.
 * `body` è escluso APPOSTA: il suo nero è coperto dal guscio, ed è D1.
 */
const SUPERFICI_NERE = Array.from(
  new Map(
    REGOLE_CSS.filter(
      (r) =>
        r.contesto.length === 0 &&
        /^\[data-contrast="high"\]/.test(r.sel) &&
        r.sel !== '[data-contrast="high"] body' &&
        fondoNero(r),
    ).map((r) => [r.sel, r]),
  ).values(),
)

describe('§2 · le superfici NERE dell’Alto Contrasto devono restare a inchiostro chiaro', () => {
  it('2.1 il censimento non è cieco: le superfici nere si leggono dal CSS e `.kv-appbar` c’è', () => {
    expect(
      SUPERFICI_NERE.length,
      'nessuna superficie nera trovata: il censimento è rotto, non il CSS',
    ).toBeGreaterThanOrEqual(5)
    expect(SUPERFICI_NERE.map((r) => r.sel)).toContain('[data-contrast="high"] .kv-appbar')
  })

  it.each(SUPERFICI_NERE.map((r) => [r.sel] as const))(
    '2.2 «%s» — un testo nudo dentro la superficie regge AA sul suo nero',
    (sel) => {
      const el = S.montaDaSelettore(sel, true)
      const m = S.misuraEl(el, true)
      expect(m.bg, `la superficie «${sel}» dipinge davvero nero`).toBe('#000000')
      expect(
        m.rapporto,
        `«${sel}»: inchiostro ereditato ${m.fg} su fondo ${m.bg} = ${m.rapporto}:1, serve ≥ ${AA}:1`,
      ).toBeGreaterThanOrEqual(AA)
    },
  )

  it('2.3 CONTROLLO POSITIVO: togliere l’inchiostro dichiarato accanto al nero fa crollare queste superfici', () => {
    // ⚠️ RISCRITTO il 2026-09-06 INSIEME alla correzione, e questa è la nota da
    // leggere prima di giudicarlo un allentamento.
    //
    // Fino a ieri qui si applicava la «correzione ingenua» di D1 — portare a
    // nero il `color` di `[data-contrast="high"] body` — e si pretendeva di
    // veder crollare almeno cinque superfici. Funzionava perché quelle cinque
    // l'inchiostro NON lo dichiaravano: prendevano il bianco per eredità, cioè
    // per caso. La correzione ha chiuso proprio quel caso: adesso ognuna di
    // loro scrive il proprio `color`, e la mutazione di ieri non rompe più
    // niente — MISURATO, zero superfici cadono. Un controllo positivo che non
    // vede più il difetto che sorveglia è una decorazione verde, ed è il modo
    // in cui questo repo ha già perso due volte la fiducia nei propri test.
    //
    // Il presidio si è SPOSTATO, e la mutazione si sposta con lui: si toglie
    // l'inchiostro dichiarato accanto alla carta nera — che è esattamente ciò
    // che la correzione ha aggiunto — e si pretende di vedere le superfici
    // cadere. La mutazione è più stretta di prima, non più larga: prima colpiva
    // UNA riga a caso del file, adesso colpisce il presidio vero, per ognuna
    // delle superfici, senza elencarne nessuna a mano.
    //
    // MISURATO: 23 delle 26 superfici nere cadono a 1:1 senza il proprio
    // inchiostro. Le 3 che reggono lo fanno per un motivo che vale la pena
    // saper distinguere: un ANTENATO nel DOM montato dichiara già un inchiostro
    // chiaro (`.kv-admin-nav a[aria-current="page"]`, i due rami di
    // `.kv-recon-azione-fattura[data-tono="fatturata"]`).
    const seln = new Set(SUPERFICI_NERE.map((r) => r.sel))
    const senzaInchiostro = REGOLE.map((r) =>
      seln.has(r.sel) ? { ...r, dich: r.dich.filter((d) => d.prop !== 'color') } : r,
    )
    const crollate: string[] = []
    for (const r of SUPERFICI_NERE) {
      const el = S.montaDaSelettore(r.sel, true)
      if (S.misuraEl(el, true, senzaInchiostro).rapporto < AA) crollate.push(r.sel)
    }
    expect(
      crollate.length,
      `togliere l’inchiostro accanto al nero non ha rotto niente: §2.2 non sa distinguere ` +
        `e va riscritta. Superfici esaminate: ${SUPERFICI_NERE.length}`,
    ).toBeGreaterThanOrEqual(5)
    expect(crollate, `elenco delle superfici che crollerebbero: ${crollate.join(' · ')}`).toContain(
      '[data-contrast="high"] .kv-appbar',
    )
    // …e con le regole VERE le stesse superfici stanno bene: la differenza è la prova.
    const el = S.montaDaSelettore('[data-contrast="high"] .kv-appbar', true)
    expect(S.misuraEl(el, true).rapporto).toBe(21)

    // IL NUMERO DELLO SCAMBIO DI DIFETTO, detto per esteso e non solo contato:
    // è il motivo per cui la correzione ha dovuto toccare cinque regole invece
    // di una. Senza il proprio inchiostro, `.kv-appbar` eredita il NERO del
    // guscio sul proprio fondo nero — 1:1 esatto, cioè il difetto di partenza
    // spostato di stanza invece che chiuso.
    const appbar = S.montaDaSelettore('[data-contrast="high"] .kv-appbar', true)
    expect(
      S.misuraEl(appbar, true, senzaInchiostro).rapporto,
      'nero su nero: è lo scambio di difetto che le cinque coperture impediscono',
    ).toBe(1)
  })
})

// =============================================================================
// §3 — D2 e D3. `.kv-news-onbody`, cioè gli STATI VUOTI delle news.
// =============================================================================

/** I cinque file che portano la classe. Il PRD ne elenca quattro: ne manca uno. */
const FILE_NEWS = [
  'src/components/features/news/NewsFeedList.tsx', // → /parent/news
  'src/app/(dashboard)/parent/news/[id]/page.tsx',
  'src/app/(dashboard)/parent/news/digest/page.tsx',
  'src/app/(dashboard)/parent/news/digest/[id]/page.tsx',
  'src/app/(dashboard)/teacher/news/page.tsx',
]

/**
 * Lo stato vuoto del feed, copiato da `NewsFeedList.tsx:270-279`. È il caso
 * NORMALE di una scuola che non ha ancora pubblicato: il genitore in Alto
 * Contrasto vede una pagina bianca e non sa se stia caricando o se sia rotta.
 */
const STATO_VUOTO =
  '<div class="min-h-screen bg-kidville-cream" data-kv-shell><div class="px-4 pt-5 pb-28">' +
  '<div role="status" class="kv-news-onbody flex flex-col items-center justify-center py-16 text-center">' +
  '<div class="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-cream text-4xl">N</div>' +
  '<h2 id="titolo" class="mb-1 font-barlow text-xl font-bold uppercase text-kidville-green">Nessuna news</h2>' +
  '<p id="testo" class="max-w-xs font-maven text-sm text-kidville-sub">Torna più tardi</p>' +
  '</div></div></div>'

/** Il back-link «TUTTE LE NEWS», copiato da `parent/news/[id]/page.tsx:53`. */
const BACK_LINK =
  '<div class="min-h-screen bg-kidville-cream" data-kv-shell><div class="px-4 pt-5">' +
  '<a id="sonda" href="/parent/news" class="kv-news-onbody inline-flex items-center gap-1.5 font-barlow text-[12.5px] font-extrabold uppercase tracking-wide text-kidville-green active:scale-95">TUTTE LE NEWS</a>' +
  '</div></div>'

/** Il «chiudi editor» di `/teacher/news`, che è un <button>, non un <a>. */
const BOTTONE_CHIUDI =
  '<div class="min-h-screen bg-kidville-cream" data-kv-shell><div class="px-4 pt-5">' +
  '<button id="sonda" type="button" class="kv-news-onbody mb-4 inline-flex items-center gap-1.5 font-barlow text-[12.5px] font-extrabold uppercase tracking-wide text-kidville-green active:scale-95">I MIEI CONTENUTI</button>' +
  '</div></div>'

describe('§3 · D2/D3 — `.kv-news-onbody` è posato sulla CREMA, non sul body nero', () => {
  it('3.0 il censimento delle rotte: cinque file, non quattro', () => {
    for (const f of FILE_NEWS) {
      expect(sorgente(f), `${f} porta ancora la classe`).toContain('kv-news-onbody')
    }
    const regola = REGOLE_CSS.filter((r) => /\.kv-news-onbody/.test(r.sel))
    expect(regola.length, '`.kv-news-onbody` esiste in globals.css').toBeGreaterThan(0)

    // ⚠️ ADEGUATO il 2026-09-06. Qui c'era `expect(CSS).toContain('sul body
    // nero')`: pinnava il COMMENTO accanto alla regola, che dichiarava una carta
    // che non esiste, ed era la causa di D2/D3. Corretta la regola, il commento
    // è stato riscritto — ma la frase resta nel file come CITAZIONE di ciò che
    // c'era prima (e ce n'è una seconda, storica, accanto a `.kv-come-pagare`).
    // Lasciare quella riga l'avrebbe resa verde per un motivo che non ha niente
    // a che vedere con quello che dice: un test che passa perché ha trovato una
    // virgolettatura. Al suo posto si pinna la COSA, non la sua descrizione —
    // gli inchiostri che le regole scrivono davvero. Il giallo di D3 non deve
    // più comparire da nessuna parte in questo blocco.
    const inchiostri = regola
      .flatMap((r) => r.dich)
      .filter((d) => d.prop === 'color')
      .map((d) => d.val.trim().toUpperCase())
    expect(inchiostri.length, 'il blocco news dichiara degli inchiostri').toBeGreaterThan(0)
    expect(
      inchiostri,
      `il giallo #FFE500 nasceva dalla premessa «sul body nero»: su crema vale ` +
        `${contrasto('#FFE500', T.cream)}:1. Se ricompare, la premessa è tornata.`,
    ).not.toContain('#FFE500')
    expect(inchiostri, 'il testo va a nero pieno').toContain('#000000')
    expect(inchiostri, 'comandi e titoli al verde inchiostro del tema').toContain('#004A42')

    // L'ICONA CON L'ALFA, e il motivo per cui qui è un controllo STRUTTURALE e
    // non una misura. `/teacher/news` è l'unico stato vuoto senza emoji: porta
    // un'icona `text-kidville-green/70`, e `.text-kidville-green` non la
    // aggancia — stessa trappola delle intestazioni della sidebar desktop.
    // Composta sulla crema vale 3,24:1, e dopo la correzione sarebbe rimasta
    // l'unica macchia chiara in mezzo a testo nero. La sonda di questo file NON
    // sa comporre l'alfa (le utility che modella sono a tinta piena), quindi
    // misurarla darebbe un numero falso: si verifica che la regola ci sia.
    fixtureViva('src/app/(dashboard)/teacher/news/page.tsx', 'text-kidville-green/70')
    const conAlfa = REGOLE_CSS.filter((r) => /\.kv-news-onbody .*text-kidville-green\\\//.test(r.sel))
    expect(
      conAlfa.flatMap((r) => r.dich).map((d) => `${d.prop}:${d.val.trim().toUpperCase()}`),
      '`.kv-news-onbody .text-kidville-green\\/70` deve portare il verde inchiostro',
    ).toContain('color:#004A42')
  })

  it('3.1 LA CAUSA: sotto `.kv-news-onbody` il fondo REALE è la crema, non il nero', () => {
    const el = S.monta(STATO_VUOTO.replace('role="status"', 'id="sonda" role="status"'), true)
    expect(S.sfondo(el, true), 'il fondo che l’occhio vede sotto lo stato vuoto').toBe(T.cream)
    expect(S.sfondo(el, true)).not.toBe('#000000')
  })

  it('3.2 D2 — il testo dello stato vuoto (`.text-kidville-sub`) regge AA sulla crema', () => {
    S.montaAlbero(STATO_VUOTO, true)
    const m = S.misuraEl(document.getElementById('testo')!, true)
    const s = soglia(14, 400) // `text-sm`, peso normale
    expect(
      m.rapporto,
      `D2 · /parent/news · /parent/news/[id] · /parent/news/digest · /parent/news/digest/[id] · ` +
        `/teacher/news — testo dello STATO VUOTO (globals.css:733-737): ${m.fg} su ${m.bg} = ` +
        `${m.rapporto}:1, serve ≥ ${s}:1. In luce normale la stessa scritta vale ` +
        `${contrasto(T.sub, T.cream)}:1 — l’Alto Contrasto la PEGGIORA di cinque volte.`,
    ).toBeGreaterThanOrEqual(s)
  })

  it('3.3 D3 — il titolo h2 dello stato vuoto (`.text-kidville-green`) regge la sua soglia', () => {
    S.montaAlbero(STATO_VUOTO, true)
    const m = S.misuraEl(document.getElementById('titolo')!, true)
    const s = soglia(20, 700) // `text-xl font-bold` = testo grande → 3:1
    // ⚠️ ADEGUATO il 2026-09-06: qui c'era `expect(m.fg).toBe('#FFE500')`, che
    // non era un requisito ma la DESCRIZIONE del difetto — il giallo nato dalla
    // premessa «sul body nero». La soglia sotto, che è il requisito vero, non è
    // stata toccata di un decimale: il giallo su crema vale 1,15:1 e la
    // farebbe fallire da sola, quindi il presidio non si è indebolito.
    //
    // ⚠️ MA LEGGI QUESTA RIGA PRIMA DI RITINGERE QUESTO RAMO. La riga qui sotto
    // è un PIN SULL'HEX, non un controllo sulla soglia: morde più della soglia,
    // non meno, e in cambio non distingue una ritintura sbagliata da una
    // legittima. Chi un domani vorrà portare `.kv-news-onbody
    // .text-kidville-green` a un altro colore — un verde più scuro, il nero
    // pieno, qualunque cosa — deve aggiornare ANCHE questa riga, e deve farlo
    // pur vedendo il contrasto continuare a passare: il rosso che troverà non
    // dirà «hai peggiorato l'accessibilità», dirà «hai cambiato una tinta che
    // qualcuno aveva fissato apposta». Aggiornare l'hex è la risposta giusta;
    // cancellare la riga per far tornare verde la suite non lo è, perché
    // riporterebbe questo ramo nella condizione in cui si era rotto — nessuno
    // che guardi QUALE colore ci finisce, e la sola soglia a fare da rete.
    expect(m.fg, 'il ramo `.text-kidville-green` va al verde inchiostro del tema').toBe('#004A42')
    expect(
      m.rapporto,
      `D3 · titolo h2 dello STATO VUOTO: ${m.fg} su ${m.bg} = ` +
        `${m.rapporto}:1, serve ≥ ${s}:1 (testo grande).`,
    ).toBeGreaterThanOrEqual(s)
  })

  it.each([
    ['«TUTTE LE NEWS» (a, parent/news/[id]:53)', BACK_LINK],
    ['«I MIEI CONTENUTI» (button, teacher/news:121)', BOTTONE_CHIUDI],
  ])('3.4 D3 — il comando %s regge AA sulla crema', (nome, html) => {
    const m = S.misura(html, true)
    const s = soglia(12.5, 800)
    expect(
      m.rapporto,
      `D3 · ${nome} (globals.css:738-741): ${m.fg} su ${m.bg} = ${m.rapporto}:1, serve ≥ ${s}:1. ` +
        `Il comando resta raggiungibile col Tab — l’anello di fuoco è a norma — ma a vista non esiste.`,
    ).toBeGreaterThanOrEqual(s)
  })

  it('3.5 anche i rami `.text-kidville-ink` e la radice della classe reggono AA', () => {
    const html = STATO_VUOTO.replace(
      '<p id="testo"',
      '<p id="ink" class="text-kidville-ink">x</p><p id="nudo">y</p><p id="testo"',
    )
    S.montaAlbero(html, true)
    const colpevoli = ([
      ['ink', '`.kv-news-onbody .text-kidville-ink` (globals.css:735)'],
      ['nudo', '`.kv-news-onbody` radice, testo senza classe (globals.css:733)'],
    ] as const)
      .map(([id, ramo]) => ({ ramo, m: S.misuraEl(document.getElementById(id)!, true) }))
      .filter((x) => x.m.rapporto < AA)
    expect(
      colpevoli.map((x) => `${x.ramo}: ${x.m.fg} su ${x.m.bg} = ${x.m.rapporto}:1`),
      `D2 · i rami di \`.kv-news-onbody\` che portano l’inchiostro BIANCO: serve ≥ ${AA}:1 ` +
        `sulla crema #FEF1E4, che è la carta vera del guscio.`,
    ).toEqual([])
  })

  it('3.6 CONTROLLO POSITIVO: in luce NORMALE le stesse scritte reggono — la correzione non le rovini', () => {
    S.montaAlbero(STATO_VUOTO, false)
    const testo = S.misuraEl(document.getElementById('testo')!, false)
    const titolo = S.misuraEl(document.getElementById('titolo')!, false)
    expect(testo.rapporto, `sub su crema: ${testo.fg} su ${testo.bg}`).toBe(5.82)
    expect(titolo.rapporto, `green su crema: ${titolo.fg} su ${titolo.bg}`).toBe(5.86)
    expect(testo.rapporto).toBeGreaterThanOrEqual(AA)
    expect(titolo.rapporto).toBeGreaterThanOrEqual(AA)
    const link = S.misura(BACK_LINK, false)
    expect(link.rapporto).toBeGreaterThanOrEqual(AA)
    // …e in luce normale NON compare nessuna sottolineatura: il rimedio di §4 è
    // acceso solo in Alto Contrasto, e non deve cambiare la pagina di tutti.
    expect(S.vince(S.monta(BACK_LINK, false), 'text-decoration-line')).toBeNull()
  })

  it('3.7 il DISCO dell’emoji: la sua forma resta, e il suo inchiostro è dichiarato', () => {
    // NUOVO il 2026-09-06, e nasce da un buco trovato mutando il CSS: la regola
    // `.kv-news-onbody .bg-kidville-cream { background:#1A1A1A }` esisteva da
    // prima, la correzione le ha aggiunto un `color`, e togliendo quel `color`
    // NESSUN test diventava rosso. Una regola che nessuno guarda è il modo in
    // cui questo repo ha già prodotto due bloccanti, e non si lascia così.
    //
    // LA DECISIONE, presa sulla misura e non sull'ipotesi: il disco resta
    // scuro. Contiene solo un'emoji (📰 / ✉️ — verificato nei tre file che lo
    // montano), che si disegna con i propri colori e non con `currentColor`:
    // non è un problema di contrasto del TESTO in nessuno dei due sensi. Ma è
    // una FORMA, e col token resterebbe crema su crema, cioè 1:1 — sparirebbe.
    // A #1A1A1A vale 15,68:1 contro la carta.
    const html = STATO_VUOTO.replace('class="mb-4 flex', 'id="disco" class="mb-4 flex').replace(
      '>N</div>',
      '><span id="dentro">N</span></div>',
    )
    S.montaAlbero(html, true)
    const disco = document.getElementById('disco')!
    const dentro = document.getElementById('dentro')!

    // 1 · la FORMA: il disco contro la carta su cui è posato (WCAG 1.4.11 → 3:1).
    const fondoDisco = S.vince(disco, 'background-color')
    expect(fondoDisco, 'il disco dichiara il proprio fondo').toBe('#1A1A1A')
    const cartaSotto = S.sfondo(disco.parentElement!, true)
    expect(cartaSotto).toBe(T.cream)
    expect(
      contrasto('#1A1A1A', cartaSotto),
      'il disco deve restare una forma visibile sulla crema',
    ).toBeGreaterThanOrEqual(3)

    // 2 · l'INCHIOSTRO dentro il disco. Prima ci arrivava il bianco del `body`
    // per eredità — cioè per caso — e dopo la correzione di D1 ci arriverebbe
    // il NERO del guscio: 1,21:1 su #1A1A1A. Va dichiarato, come su ogni altra
    // superficie scura di questo file.
    const m = S.misuraEl(dentro, true)
    expect(
      m.rapporto,
      `l’inchiostro dentro il disco scuro: ${m.fg} su ${m.bg} = ${m.rapporto}:1. ` +
        `Senza il \`color\` accanto al \`background\` erediterebbe il nero del guscio.`,
    ).toBeGreaterThanOrEqual(AA)
    expect(m.bg).toBe('#1A1A1A')
    expect(m.fg).toBe('#FFFFFF')
  })
})

// =============================================================================
// §4 — WCAG 1.4.1. Un comando non può distinguersi dal testo per il SOLO colore.
// =============================================================================

/**
 * «Sottolineatura o equivalente»: la riga sotto il testo, un bordo inferiore, o
 * un'ombra che ne fa le veci. Non si pretende UNA soluzione: si pretende che
 * qualcosa, oltre alla tinta, dica che quello è un comando.
 */
function haSottolineatura(el: Element, regole = REGOLE): { si: boolean; come: string } {
  const linea = S.vince(el, 'text-decoration-line', regole)
  if (linea && /underline/i.test(linea)) return { si: true, come: `text-decoration-line: ${linea}` }
  const bordo = S.vince(el, 'border-bottom-width', regole)
  if (bordo && !/^0(px|em|rem)?$/.test(bordo.trim())) return { si: true, come: `border-bottom: ${bordo}` }
  const ombra = S.vince(el, 'box-shadow', regole)
  if (ombra && /inset\s+0\s+-/.test(ombra)) return { si: true, come: `box-shadow: ${ombra}` }
  const classi = Array.from(el.classList)
  const util = classi.find((c) => /^(underline|border-b($|-)|decoration-)/.test(c))
  if (util) return { si: true, come: `classe «${util}»` }
  return { si: false, come: '' }
}

describe('§4 · WCAG 1.4.1 — il colore non può essere l’unico segno che quello è un link', () => {
  it('4.0 lo stato di fatto: `[data-contrast="high"] a, button` dichiara lo SPESSORE, non la RIGA', () => {
    // È la trappola: la regola c'è, sembra riguardare la sottolineatura, e non
    // ne accende nessuna. `text-decoration-thickness` non disegna niente da solo,
    // e il preflight di Tailwind ha già azzerato la sottolineatura nativa di `<a>`.
    expect(CSS).toContain('text-decoration-thickness: from-font')
    const soloSpessore = REGOLE_CSS.filter(
      (r) => /^\[data-contrast="high"\] (a|button)$/.test(r.sel),
    )
    expect(soloSpessore.length, 'la regola esiste').toBeGreaterThan(0)
    expect(
      soloSpessore.flatMap((r) => r.dich).some((d) => /^text-decoration(-line)?$/.test(d.prop)),
      'nessuna delle due dichiara `text-decoration-line`',
    ).toBe(false)
  })

  it.each([
    ['a.kv-news-onbody — «TUTTE LE NEWS» / «TUTTI I DIGEST»', BACK_LINK],
    ['button.kv-news-onbody — «I MIEI CONTENUTI»', BOTTONE_CHIUDI],
  ])('4.1 %s porta una sottolineatura (o equivalente) in Alto Contrasto', (nome, html) => {
    const el = S.monta(html, true)
    const m = S.misuraEl(el, true)
    const u = haSottolineatura(el)
    expect(
      u.si,
      `WCAG 1.4.1 · ${nome}: in Alto Contrasto il comando è ${m.fg} e il testo attorno è ` +
        `#FFFFFF — due tinte, nessun altro segno. Nessuna sottolineatura, nessun bordo ` +
        `inferiore, nessuna ombra: il colore è l’unico portatore dell’informazione. ` +
        `(E le due tinte valgono ${m.rapporto}:1 e 1,11:1 sulla crema, quindi non si vede né ` +
        `l’una né l’altra.)`,
    ).toBe(true)
  })

  it('4.2 CONTROLLO POSITIVO: la sonda riconosce le tre forme, e senza nessuna dice di no', () => {
    // Un controllo che non ha mai visto un vero non è un controllo.
    // ⚠️ ADEGUATO il 2026-09-06, e il motivo è istruttivo: il rimedio scelto è
    // proprio la PRIMA delle tre forme (`text-decoration-line: underline`), che
    // `haSottolineatura` prova per prima. Con le regole vere in tavola tutti e
    // tre i rimedi finti venivano segnalati come «text-decoration-line», perché
    // quello vero c'era già — e l'ultima riga, «senza nessuno dei tre dice di
    // no», era diventata falsa. Il controllo non poteva più vedere il difetto
    // che sorveglia: non perché la sonda sia peggiorata, ma perché misurava
    // sopra la correzione.
    // Si misura quindi su un mondo SENZA il rimedio vero — che è anche la
    // mutazione della regola nuova: tolta la sottolineatura da `globals.css`,
    // la sonda torna a dire di no, ed è la riga in fondo a dirlo.
    const el = S.monta(BACK_LINK, true)
    const SENZA_RIMEDIO = REGOLE.filter(
      (r) => !r.dich.some((d) => /^text-decoration(-line)?$/.test(d.prop) && /underline/i.test(d.val)),
    )
    expect(
      SENZA_RIMEDIO.length,
      'la sottolineatura vera esiste in globals.css ed è stata filtrata',
    ).toBeLessThan(REGOLE.length)

    for (const [css, atteso] of [
      ['[data-contrast="high"] a.kv-news-onbody{text-decoration-line:underline}', 'text-decoration-line'],
      ['[data-contrast="high"] a.kv-news-onbody{border-bottom:2px solid #FFE500}', 'border-bottom'],
      ['[data-contrast="high"] a.kv-news-onbody{box-shadow:inset 0 -2px 0 0 #FFE500}', 'box-shadow'],
    ]) {
      const u = haSottolineatura(el, [...SENZA_RIMEDIO, ...parseRegole(css)])
      expect(u.si, `il rimedio «${css}» dovrebbe bastare`).toBe(true)
      expect(u.come).toContain(atteso)
    }
    // …e senza nessuno dei tre, la stessa sonda dice di no. Sano ≠ rotto.
    expect(haSottolineatura(el, SENZA_RIMEDIO).si).toBe(false)
    // …mentre col foglio di stile VERO dice di sì, e dice anche con che cosa.
    expect(haSottolineatura(el).si).toBe(true)
    expect(haSottolineatura(el).come).toContain('underline')
  })
})

// =============================================================================
// §5 — RISERVA 2. I RIEMPIMENTI SCURI CHE VENGONO DA UNA UTILITY, NON DA UNA
// REGOLA DELL'ALTO CONTRASTO.
//
// ─── PERCHÉ §2 NON BASTA, E NON BASTEREBBE ALLARGANDOLA ─────────────────────
// Il censimento di §2 parte dalle REGOLE di `globals.css`: trova le superfici
// che l'Alto Contrasto dipinge nere e pretende che tengano l'inchiostro chiaro.
// Un riempimento scuro che arriva da una utility Tailwind — `bg-kidville-green`,
// `bg-kidville-ink`, `bg-black` — non è una regola dell'Alto Contrasto, e non lo
// diventa allargando il filtro: quelle classi in `globals.css` non ci sono
// proprio, le emette il compilatore dai token di `@theme inline`. Questa sezione
// parte dall'altro capo: dalle UTILITY.
//
// ─── PERCHÉ LA SORVEGLIANZA SERVE PROPRIO ADESSO ────────────────────────────
// Prima della correzione di D1 un testo NUDO dentro uno di quei riempimenti
// ereditava il #FFFFFF del `body`: bianco su verde, 6,51:1, a posto — ma **per
// caso**, non per progetto. La correzione porta a NERO l'inchiostro ereditato
// dentro i gusci, che sulla carta crema è la cosa giusta (18,92:1); dentro un
// riempimento scuro lo stesso nero vale da 1,00:1 a 4,40:1. §5.2 misura ENTRAMBE
// le direzioni sullo stesso `<span>`, ed è il motivo per cui questa sezione
// nasce insieme alla correzione e non prima: la correzione non ha creato un
// difetto, ha tolto una copertura che c'era per caso, e ciò che copriva va
// adesso sorvegliato per progetto.
//
// ─── COSA NON SI È FATTO, E PERCHÉ NON È UNA DIMENTICANZA ───────────────────
// La correzione ovvia sarebbe una regola CSS: `[data-kv-shell] .bg-kidville-green
// { color: … }`. È stata scartata con la misura in mano, e §5.7 la rifà da capo:
// 150 elementi portano oggi l'inchiostro di brand SULLO STESSO nodo del
// riempimento, e una regola non-layered a 0,3,0 li scavalcherebbe tutti — utility
// e rete di sicurezza sulla coppia comprese. Sarebbe lo scambio di difetto di §2,
// nell'altro verso. Il presidio giusto qui non è una regola: è sapere che quei
// riempimenti esistono, e che dentro non ci finisca mai un testo senza inchiostro.
//
// ─── E OGGI NON C'È UN ROSSO, PERCHÉ NON C'È UN GUASTO ──────────────────────
// Chi ha corretto D1 ha aperto a mano gli elementi che dentro i gusci portano un
// riempimento scuro senza dichiarare un inchiostro, e in ognuno ogni nodo di
// testo il proprio colore ce l'ha. Questa sezione non descrive quindi un difetto
// aperto: descrive un'ASSENZA DI SORVEGLIANZA, e la chiude.
//   ⚠️ Il rapporto di collaudo ne contava 44, la sonda ne conta 48 su 289, e la
//   differenza non è un errore di nessuno dei due: dipende da dove si mette il
//   confine. La sonda conta anche gli elementi AUTOCHIUDENTI col riempimento
//   scuro (il pomello di un interruttore dentro la sua guida verde: nessun testo
//   dentro, ma il riempimento c'è) e le varianti con alfa. Il criterio della
//   sonda sta scritto qui sotto e si può rileggere; un numero contato a mano no,
//   ed è per questo che adesso lo conta un test.
// Il giorno in cui qualcuno scriverà `<div className="bg-kidville-green">Ciao</div>`
// dentro un guscio, §5.5 lo dirà per nome, con file e riga — e §5.6 dimostra, su
// sorgenti finti tenuti in memoria, che quel giorno lo saprebbe riconoscere
// davvero: le stesse nove forme, viste una per una, sane e rotte.
// =============================================================================

/** I sorgenti di `src/` con una data estensione, in ordine stabile. */
function sorgentiSrc(ext: RegExp, dir = path.join(RADICE, 'src'), out: string[] = []): string[] {
  for (const v of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, v.name)
    if (v.isDirectory()) sorgentiSrc(ext, p, out)
    else if (ext.test(v.name)) out.push(path.relative(RADICE, p).split(path.sep).join('/'))
  }
  return out
}

const SORGENTI_TSX = sorgentiSrc(/\.tsx$/)
/** I `.ts` senza JSX: nessun figlio da guardare, ma le classi le costruiscono lo stesso. */
const SORGENTI_TS = sorgentiSrc(/\.ts$/).filter((f) => !f.endsWith('.d.ts'))

/** Il fondo COMPILATO di ogni utility `bg-*`, letto dal motore che poi lo misura. */
const FONDI_UTILITY = S.UTILITY.flatMap((r) => {
  const bg = r.dich.find((d) => d.prop === 'background-color')
  return bg ? [{ nome: r.sel.slice(1), hex: bg.val.toUpperCase(), rapporto: contrasto('#000000', bg.val) }] : []
})

/**
 * LE UTILITY SCURE. Si CALCOLANO dai token, non si elencano a mano: il giorno in
 * cui qualcuno ritinge `--color-kidville-info` di due punti questo elenco cambia
 * da solo, e la tabella dichiarata qui sotto diventa rossa. È il contrario di
 * ciò che è successo a `.kv-news-onbody`, rimasto invisibile per due settimane
 * perché nessun test lo guardava.
 */
const UTILITY_SCURE = FONDI_UTILITY.filter((u) => u.rapporto < AA).sort(
  (a, b) => a.rapporto - b.rapporto || a.nome.localeCompare(b.nome),
)

/**
 * IL CENSIMENTO DICHIARATO: nome · fondo compilato · rapporto con il NERO che
 * oggi si eredita dentro un guscio. Non è un elenco di difetti — è l'elenco
 * delle utility dentro cui un testo nudo NON reggerebbe, messo per iscritto
 * perché qualcuno se ne accorga prima che succeda.
 *
 * ⚠️ MISURATO il 2026-09-06, e la misura ha corretto la premessa da cui era
 * partita: il rapporto di collaudo ne elencava OTTO, e tutte e otto hanno il
 * numero esatto — ma ce ne sono TREDICI. Le cinque in più (`green-ink`,
 * `green-dark`, `info-strong`, `yellow-strong`, `hint`) mancavano perché
 * l'elenco era stato compilato guardando le classi USATE oggi in `src/`, e
 * quelle cinque oggi nessuno le usa come riempimento. Un censimento delle
 * utility che esistono non è la stessa cosa di un censimento delle utility
 * adoperate: la prima è quella che serve a un lock, perché il difetto arriva il
 * giorno in cui qualcuno adopera la classe che ancora non adoperava nessuno.
 */
const CENSIMENTO_UTILITY_SCURE: [string, string, number][] = [
  ['bg-black', '#000000', 1],
  ['bg-kidville-ink', '#1F3D38', 1.78],
  ['bg-kidville-green-ink', '#004A42', 2.06],
  ['bg-kidville-green-dark', '#00544B', 2.37],
  ['bg-kidville-success-strong', '#1B5E20', 2.67],
  ['bg-kidville-info-strong', '#1D4FA8', 2.74],
  ['bg-kidville-green', '#006A5F', 3.23],
  ['bg-kidville-sub', '#55615C', 3.25],
  ['bg-kidville-yellow-strong', '#7A5C00', 3.36],
  ['bg-kidville-error-strong', '#C62828', 3.74],
  ['bg-kidville-warn-strong', '#A64F09', 3.74],
  ['bg-kidville-hint', '#65716C', 4.13],
  ['bg-kidville-info', '#2A6FDB', 4.4],
]

/**
 * Le utility con ALFA (`bg-kidville-green/90`): il loro fondo non è un hex, è il
 * token composto su ciò che sta sotto. Si compongono sulla CREMA del guscio, che
 * è lo sfondo più CHIARO su cui possano davvero posarsi: qualunque altra cosa ci
 * sia sotto le rende più scure, mai più chiare, quindi questo è il caso più
 * generoso — se non regge qui, non regge da nessuna parte.
 */
const componiSuCrema = (hex: string, alfa: number): string => {
  const [f, s] = [rgb(hex), rgb(T.cream)]
  return (
    '#' +
    f.map((v, i) => Math.round(v * alfa + s[i] * (1 - alfa)).toString(16).padStart(2, '0')).join('').toUpperCase()
  )
}

/**
 * Le varianti con alfa ADOPERATE in `src/`, composte sulla crema. Qui l'elenco
 * NON può venire dai token — l'alfa la sceglie chi scrive la classe, non il tema
 * — quindi si legge dal sorgente. È l'unico censimento di questa sezione che
 * parte dall'uso invece che dal catalogo, e il motivo è che il catalogo delle
 * alfe non esiste: `bg-kidville-green/90` è una classe che Tailwind compila su
 * richiesta.
 */
const ALFA_IN_USO = Array.from(
  new Set(
    [...SORGENTI_TSX, ...SORGENTI_TS].flatMap((f) =>
      Array.from(sorgente(f).matchAll(/\bbg-kidville-([a-z-]+)\/(\d{1,3})\b/g)).map(
        (m) => [m[1], Number(m[2])] as [string, number],
      ),
    ).map(([tok, a]) => `${tok}/${a}`),
  ),
)
  .flatMap((chiave) => {
    const [tok, a] = chiave.split('/')
    const hex = T[tok]
    if (!hex) return []
    const composto = componiSuCrema(hex, Number(a) / 100)
    return [{ nome: `bg-kidville-${chiave}`, hex: composto, rapporto: contrasto('#000000', composto) }]
  })
  .filter((u) => u.rapporto < AA)
  .sort((x, y) => x.rapporto - y.rapporto || x.nome.localeCompare(y.nome))

/**
 * ⚠️ MISURATO: delle 72 varianti con alfa adoperate oggi, DUE restano scure. Le
 * altre 70 sono velature chiare (`bg-kidville-green/10`, `bg-kidville-cream/50`)
 * che sulla crema tornano quasi crema: contarle sarebbe stato rumore, non
 * severità.
 */
const UTILITY_SCURE_ALFA: [string, string, number][] = [
  ['bg-kidville-ink/90', '#354F49', 2.37],
  ['bg-kidville-green/90', '#19786C', 3.94],
]

// ── LO SCANNER: guarda il CODICE, non solo il CSS ───────────────────────────
/**
 * Il CSS dice quali riempimenti sono scuri; solo il codice dice se dentro ci
 * finisce del testo. Il sorgente si PARSA col compilatore TypeScript
 * (`ts.createSourceFile`, modalità TSX) come già fa
 * `__tests__/architecture/bottone-icona-con-nome.test.ts`: una grep qui
 * sbaglierebbe in tutti e due i versi — una classe citata in un commento
 * sembrerebbe un riempimento, e un elemento scritto su nove righe non avrebbe
 * mai il suo testo «sulla stessa riga».
 *
 * LA REGOLA: dentro un elemento che porta una utility scura, ogni nodo di testo
 * deve avere il proprio inchiostro dichiarato FRA il testo e il riempimento,
 * estremi compresi. Un inchiostro dichiarato più in ALTO non vale, e non è un
 * cavillo: è stato scelto guardando un'altra carta, senza sapere del fondo scuro
 * che sarebbe arrivato sotto. È letteralmente l'unico caso reale che questa
 * sezione trova — i due `<option className="bg-kidville-ink">` che ereditano il
 * `text-kidville-green` scelto per il `<select>` chiaro che li contiene, 1,81:1.
 */
const NOMI_UTILITY_SCURE = new Set<string>([
  ...UTILITY_SCURE.map((u) => u.nome),
  ...UTILITY_SCURE_ALFA.map(([n]) => n),
])

/** Le classi `kv-*` a cui `globals.css` dichiara un `color`: valgono da inchiostro. */
const KV_CON_INCHIOSTRO = new Set(
  REGOLE_CSS.filter((r) => r.dich.some((d) => d.prop === 'color')).flatMap((r) =>
    Array.from(r.sel.matchAll(/\.(kv-[-\w]+)/g)).map((m) => m[1]),
  ),
)

/** `text-sm`, `text-center`, `text-balance`… non sono inchiostri: sono tutto il resto. */
const TEXT_NON_COLORE =
  /^text-(xs|sm|base|lg|xl|[0-9]xl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|clip|ellipsis|opacity|shadow|\[)/

const eInchiostro = (c: string) => (/^text-/.test(c) && !TEXT_NON_COLORE.test(c)) || KV_CON_INCHIOSTRO.has(c)

/** Le funzioni che si limitano a CONCATENARE classi: non nascondono un inchiostro. */
const FONDONO_CLASSI = new Set(['cn', 'cx', 'clsx', 'twMerge', 'classNames', 'join', 'concat', 'trim', 'filter', 'map'])

type Segnalazione = { file: string; riga: number; utility: string; testo: string }
type Analisi = {
  /** Quanti elementi portano una utility scura: è il PAVIMENTO della sonda. */
  elementi: number
  /** Testo il cui inchiostro non è dichiarato con il riempimento. */
  nudi: Segnalazione[]
  /** Testo sotto un `className` costruito da un helper: indecidibile, non assolto. */
  ignoti: Segnalazione[]
  /**
   * Quanti dei `elementi` NON dichiarano un inchiostro proprio: sono quelli in
   * cui il nero ereditato entra davvero, e quindi i soli su cui §5.5 morde.
   */
  senzaInchiostroProprio: number
  /** Inchiostri gialli dichiarati SULLO STESSO elemento del riempimento verde. */
  gialliSuFondo: number
  /** Inchiostri gialli dichiarati su un DISCENDENTE del riempimento verde. */
  gialliDiscendenti: number
}

function analizzaTsx(file: string, testo: string): Analisi {
  const src = ts.createSourceFile(file, testo, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const rigaDi = (n: ts.Node) => src.getLineAndCharacterOfPosition(n.getStart()).line + 1
  const out: Analisi = {
    elementi: 0,
    nudi: [],
    ignoti: [],
    senzaInchiostroProprio: 0,
    gialliSuFondo: 0,
    gialliDiscendenti: 0,
  }

  const contieneJsx = (x: ts.Node): boolean => {
    let si = false
    const v = (y: ts.Node) => {
      if (si) return
      if (ts.isJsxElement(y) || ts.isJsxSelfClosingElement(y) || ts.isJsxFragment(y)) {
        si = true
        return
      }
      ts.forEachChild(y, v)
    }
    v(x)
    return si
  }

  // I nomi che, in QUESTO file, producono JSX: `{conversationMenu(x)}` è un
  // elemento, non un testo, e senza questa risoluzione sarebbe un falso positivo.
  const NOMI_JSX = new Set<string>()
  const raccogli = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && contieneJsx(n.initializer))
      NOMI_JSX.add(n.name.text)
    if (ts.isFunctionDeclaration(n) && n.name && n.body && contieneJsx(n.body)) NOMI_JSX.add(n.name.text)
    ts.forEachChild(n, raccogli)
  }
  ts.forEachChild(src, raccogli)

  type Attributi = { classi: string[]; inchiostroInline: boolean; opaco: boolean }
  const attributi = (el: ts.JsxElement | ts.JsxSelfClosingElement): Attributi => {
    const props = (ts.isJsxSelfClosingElement(el) ? el.attributes : el.openingElement.attributes).properties
    const classi: string[] = []
    let inchiostroInline = false
    let opaco = false
    for (const a of props) {
      if (!ts.isJsxAttribute(a) || !a.name || !a.initializer) continue
      const nome = a.name.getText()
      if (nome === 'style' && /(^|\W)color\s*:/.test(a.initializer.getText())) inchiostroInline = true
      if (nome !== 'className' && nome !== 'class') continue
      const leggi = (n: ts.Node): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
          classi.push(...n.text.split(/\s+/))
          return
        }
        if (ts.isTemplateExpression(n)) {
          classi.push(...n.head.text.split(/\s+/))
          for (const s of n.templateSpans) {
            classi.push(...s.literal.text.split(/\s+/))
            leggi(s.expression)
          }
          return
        }
        if (ts.isCallExpression(n)) {
          const f = ts.isIdentifier(n.expression)
            ? n.expression.text
            : ts.isPropertyAccessExpression(n.expression)
              ? n.expression.name.text
              : ''
          if (!FONDONO_CLASSI.has(f)) opaco = true
          for (const x of n.arguments) leggi(x)
          return
        }
        if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
          opaco = true
          return
        }
        ts.forEachChild(n, leggi)
      }
      leggi(a.initializer)
    }
    return { classi: classi.filter(Boolean), inchiostroInline, opaco }
  }

  type Stato = 'inchiostro' | 'ignoto' | 'nudo'
  const dentro = (n: ts.Node, stato: Stato, utility: string, verde: boolean) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const { classi, inchiostroInline, opaco } = attributi(n)
      if (verde && (classi.includes('text-kidville-yellow') || classi.includes('text-kidville-yellow-ink')))
        out.gialliDiscendenti++
      let s2 = stato
      if (inchiostroInline || classi.some(eInchiostro)) s2 = 'inchiostro'
      else if (opaco && stato !== 'inchiostro') s2 = 'ignoto'
      if (ts.isJsxElement(n)) for (const ch of n.children) dentro(ch, s2, utility, verde)
      return
    }
    const segna = (testo: string, riga: number) => {
      if (stato === 'inchiostro') return
      ;(stato === 'ignoto' ? out.ignoti : out.nudi).push({ file, riga, utility, testo })
    }
    if (ts.isJsxText(n)) {
      if (n.text.trim()) segna(n.text.trim().slice(0, 40), rigaDi(n))
      return
    }
    if (ts.isJsxFragment(n)) {
      for (const ch of n.children) dentro(ch, stato, utility, verde)
      return
    }
    if (ts.isJsxExpression(n)) {
      const e = n.expression
      if (!e) return
      if (contieneJsx(e)) {
        ts.forEachChild(e, (c) => dentro(c, stato, utility, verde))
        return
      }
      let radice: ts.Node = e
      while (ts.isCallExpression(radice) || ts.isPropertyAccessExpression(radice)) radice = radice.expression
      if (ts.isIdentifier(radice) && NOMI_JSX.has(radice.text)) return
      segna(e.getText().replace(/\s+/g, ' ').slice(0, 50), rigaDi(n))
    }
  }

  const visita = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const { classi, inchiostroInline, opaco } = attributi(n)
      const utility = classi.find((c) => NOMI_UTILITY_SCURE.has(c))
      if (utility) {
        out.elementi++
        const stato: Stato =
          inchiostroInline || classi.some(eInchiostro) ? 'inchiostro' : opaco ? 'ignoto' : 'nudo'
        if (stato !== 'inchiostro') out.senzaInchiostroProprio++
        const verde = utility === 'bg-kidville-green'
        if (verde && (classi.includes('text-kidville-yellow') || classi.includes('text-kidville-yellow-ink')))
          out.gialliSuFondo++
        if (ts.isJsxElement(n)) for (const ch of n.children) dentro(ch, stato, utility, verde)
      }
    }
    ts.forEachChild(n, visita)
  }
  ts.forEachChild(src, visita)
  return out
}

const SCANSIONE = SORGENTI_TSX.reduce<Analisi>(
  (acc, f) => {
    const a = analizzaTsx(f, sorgente(f))
    return {
      elementi: acc.elementi + a.elementi,
      nudi: [...acc.nudi, ...a.nudi],
      ignoti: [...acc.ignoti, ...a.ignoti],
      senzaInchiostroProprio: acc.senzaInchiostroProprio + a.senzaInchiostroProprio,
      gialliSuFondo: acc.gialliSuFondo + a.gialliSuFondo,
      gialliDiscendenti: acc.gialliDiscendenti + a.gialliDiscendenti,
    }
  },
  {
    elementi: 0,
    nudi: [],
    ignoti: [],
    senzaInchiostroProprio: 0,
    gialliSuFondo: 0,
    gialliDiscendenti: 0,
  },
)

/** Il conteggio si dichiara come `file · utility · quanti`: la RIGA cambia a ogni ritocco. */
const conta = (s: Segnalazione[]) => {
  const m = new Map<string, number>()
  for (const x of s) m.set(`${x.file} · ${x.utility}`, (m.get(`${x.file} · ${x.utility}`) ?? 0) + 1)
  return Array.from(m.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} × ${n}`)
}

/**
 * PAVIMENTO della sonda: quanti elementi con riempimento scuro deve continuare a
 * vedere. Misurati 289 il 2026-09-06 (275 `bg-kidville-green`, 3 `bg-black`, 3
 * `bg-kidville-ink`, 3 `bg-kidville-info`, 2 `bg-kidville-error-strong`, 2
 * `bg-kidville-warn-strong`, 1 `bg-kidville-ink/90`). Il margine è largo di
 * proposito: serve a distinguere «il repo è cambiato» da «la sonda non vede più
 * niente», non a inseguire il conteggio. Senza questa riga, il giorno in cui una
 * modifica al parser la rendesse cieca, l'elenco dei difetti resterebbe vuoto e
 * il file verde per sempre — che è il modo in cui questo repo ha già perso due
 * volte la fiducia nei propri test.
 */
const PAVIMENTO_ELEMENTI_SCURI = 200

/**
 * L'UNICO caso reale, misurato: due `<option className="bg-kidville-ink">` dentro
 * il costruttore di moduli. L'inchiostro c'è, ma è dichiarato sul `<select>` che
 * sta SOPRA (`text-kidville-green`, #006A5F): scelto per la crema del campo, non
 * per il fondo scuro dell'opzione. Verde su #1F3D38 vale **1,81:1**, e non è un
 * difetto dell'Alto Contrasto — vale identico in luce normale, perché entrambe le
 * tinte sono utility inlinate.
 *
 * ⚠️ Sta in un elenco DICHIARATO e non in un rosso perché la tendina di un
 * `<select>` nativo, su iOS e su Android, la disegna il sistema operativo e non
 * il CSS: la correzione vera non è una classe qui, è decidere se quel controllo
 * debba restare nativo. L'elenco può solo ACCORCIARSI. Una voce che non
 * corrisponde più a niente fa fallire questo test tanto quanto una voce nuova:
 * è la disciplina delle allowlist di questo repo, e serve a impedire che
 * l'elenco sopravviva al difetto che descriveva.
 */
const NUDI_DICHIARATI = ['src/components/features/admin/forms/builder/PropertiesPanel.tsx · bg-kidville-ink × 2']

/**
 * INDECIDIBILI: il `className` arriva da un helper e il sorgente, da solo, non
 * può dire che inchiostro contenga. L'unico caso è `ChunkErrorBoundary`, che usa
 * `btnClass('secondary', 'lg')`. Aperto a mano: quella variante è
 * `bg-kidville-yellow text-kidville-green-ink` (`src/components/ui/Btn.tsx:80`),
 * cioè non solo dichiara il proprio inchiostro — si ridipinge pure la carta
 * chiara sotto, quindi sul verde non ci sta nemmeno. Resta qui perché la SONDA
 * non lo sa, non perché il codice sia dubbio: segnalarlo come difetto sarebbe un
 * falso positivo, e un lock che segnala chi ha fatto la cosa giusta viene
 * disattivato nel giro di un ciclo.
 */
const IGNOTI_DICHIARATI = ['src/components/providers/ChunkErrorBoundary.tsx · bg-kidville-green × 1']

describe('§5 · RISERVA 2 — le UTILITY che dipingono scuro, censite e sorvegliate', () => {
  it('5.1 il censimento si CALCOLA dai token e combacia con quello dichiarato', () => {
    expect(
      UTILITY_SCURE.map((u) => [u.nome, u.hex, u.rapporto]),
      'le utility con riempimento scuro sono cambiate: qualcuno ha ritinto un token o ne ha ' +
        'aggiunto uno. Aggiorna la tabella E riguarda gli elementi che portano la classe nuova.',
    ).toEqual(CENSIMENTO_UTILITY_SCURE)
    expect(UTILITY_SCURE.length, 'tredici, non otto: le cinque in più oggi nessuno le usa').toBe(13)
  })

  it('5.2 il numero è MISURATO nel guscio vero, e senza la correzione di D1 si ribalta', () => {
    for (const [nome, hex, atteso] of CENSIMENTO_UTILITY_SCURE) {
      const html = GUSCIO_PARENT.replace(
        '></div>',
        `><div class="${nome}"><span id="sonda">testo</span></div></div>`,
      )
      const m = S.misura(html, true)
      expect(m.bg, `«${nome}» dipinge davvero ${hex}`).toBe(hex)
      expect(m.fg, `dentro un guscio l’inchiostro EREDITATO è il nero della correzione di D1`).toBe('#000000')
      expect(
        m.rapporto,
        `«${nome}»: un testo nudo dentro questo riempimento vale ${m.rapporto}:1 (serve ≥ ${AA}:1). ` +
          `Non è un difetto aperto — è il motivo per cui §5.5 sorveglia il codice.`,
      ).toBe(atteso)

      // …e PRIMA della correzione lo stesso `<span>` ereditava il bianco del
      // `body`. È la prova che la copertura c'era per CASO: nessuna riga di CSS
      // l'aveva scelta, e infatti se n'è andata correggendo tutt'altro.
      const prima = S.misura(html, true, SENZA_LA_CORREZIONE)
      expect(prima.fg, `«${nome}» prima del 2026-09-06 ereditava il bianco`).toBe('#FFFFFF')
    }
  })

  it('5.3 le varianti con ALFA si leggono da `src/`, si compongono sulla crema, e due restano scure', () => {
    expect(
      ALFA_IN_USO.map((u) => [u.nome, u.hex, u.rapporto]),
      'le varianti `bg-token/alfa` scure adoperate in `src/` sono cambiate: qualcuno ha scritto ' +
        'una velatura più coprente, o ne ha tolta una. Riguardala e aggiorna la tabella.',
    ).toEqual(UTILITY_SCURE_ALFA)

    // CONTROLLO POSITIVO: la composizione non dice «scuro» a tutto. Le velature
    // leggere sullo stesso token tornano quasi crema, e devono restare fuori.
    expect(contrasto('#000000', componiSuCrema(T.green, 0.1))).toBeGreaterThan(AA)
    expect(contrasto('#000000', componiSuCrema(T.ink, 0.4))).toBeGreaterThan(AA)
    // …e la composizione a piena opacità deve restituire il token intatto.
    expect(componiSuCrema(T.green, 1)).toBe(T.green)
    expect(componiSuCrema(T.green, 0)).toBe(T.cream)
  })

  it('5.4 CONTROLLO POSITIVO: il censimento sa distinguere lo scuro dal chiaro', () => {
    // Un censimento che dicesse «scuro» a tutto sarebbe verde e inutile.
    const chiare = FONDI_UTILITY.filter((u) => u.rapporto >= AA).map((u) => u.nome)
    for (const sana of ['bg-white', 'bg-kidville-cream', 'bg-kidville-yellow', 'bg-kidville-yellow-light'])
      expect(chiare, `«${sana}» non può stare fra le scure`).toContain(sana)
    expect(UTILITY_SCURE.map((u) => u.nome)).not.toContain('bg-kidville-cream')
    // …e il conto torna: nessuna utility è finita in tutte e due le liste.
    expect(chiare.length + UTILITY_SCURE.length).toBe(FONDI_UTILITY.length)
    expect(FONDI_UTILITY.length, 'la sonda legge davvero le utility del tema').toBeGreaterThan(30)
  })

  it('5.5 nel CODICE, dentro un riempimento scuro ogni testo dichiara il proprio inchiostro', () => {
    expect(
      SCANSIONE.elementi,
      `la sonda vede solo ${SCANSIONE.elementi} elementi con riempimento scuro: non è il repo ` +
        `che è cambiato, è il parser che non vede più. Erano 289 il 2026-09-06.`,
    ).toBeGreaterThanOrEqual(PAVIMENTO_ELEMENTI_SCURI)

    // I 289 non sono tutti esposti: 241 l'inchiostro se lo dichiarano da soli, e
    // dentro quelli il nero ereditato non arriva mai. Gli ESPOSTI sono gli altri
    // 48 — l'AppBar, le due topbar del cockpit, le intestazioni delle due chat,
    // `ClasseShell`, `BulkAssignBar`, `ChunkErrorBoundary`, `BiometricGate`,
    // `MediaGrid` e altri — e la riga qui sotto pretende che dentro ognuno di
    // loro ogni testo il proprio colore ce l'abbia. Il numero si dichiara perché
    // se scendesse a zero l'assertion successiva diventerebbe vera per il motivo
    // sbagliato: non «nessuno è rotto», ma «non sto più guardando nessuno».
    expect(
      SCANSIONE.senzaInchiostroProprio,
      `elementi con riempimento scuro che NON dichiarano un inchiostro proprio: ` +
        `${SCANSIONE.senzaInchiostroProprio} su ${SCANSIONE.elementi}. Erano 48 su 289 il ` +
        `2026-09-06. Se sono diventati zero, la sonda non li riconosce più.`,
    ).toBeGreaterThanOrEqual(25)

    expect(
      conta(SCANSIONE.nudi),
      'testo NUDO dentro un riempimento scuro: dentro un guscio eredita il #000000 della ' +
        'correzione di D1, e su questi fondi vale fra 1,00:1 e 4,40:1 (§5.1). Dichiara ' +
        'l’inchiostro sull’elemento che porta il riempimento, o sul testo stesso. ' +
        `Righe esatte: ${SCANSIONE.nudi.map((x) => `${x.file}:${x.riga} «${x.testo}»`).join(' · ')}`,
    ).toEqual(NUDI_DICHIARATI)

    expect(
      conta(SCANSIONE.ignoti),
      'testo sotto un `className` costruito da un helper dentro un riempimento scuro: la sonda ' +
        'non può leggerne l’inchiostro. Verificalo a mano e mettilo in IGNOTI_DICHIARATI con la ' +
        `ragione. Righe esatte: ${SCANSIONE.ignoti.map((x) => `${x.file}:${x.riga}`).join(' · ')}`,
    ).toEqual(IGNOTI_DICHIARATI)
  })

  it('5.6 CONTROLLO POSITIVO: su sorgenti finti la sonda vede il rotto e assolve il sano', () => {
    // ⚠️ È LA RIGA CHE RENDE VERO §5.5. Con zero difetti nel repo, una sonda
    // rotta e una sonda sana danno lo stesso elenco vuoto: l'unica differenza
    // visibile è darle un caso rotto e guardarla diventare rossa.
    const casi: [string, string, 'nudo' | 'sano' | 'ignoto'][] = [
      [
        'testo letterale dentro il riempimento',
        '<div data-kv-shell><div className="bg-kidville-green">Ciao</div></div>',
        'nudo',
      ],
      [
        'testo tradotto dentro il riempimento',
        '<div data-kv-shell><span className="bg-kidville-ink">{t("saluto")}</span></div>',
        'nudo',
      ],
      [
        'inchiostro dichiarato SUL riempimento',
        '<div data-kv-shell><div className="bg-kidville-green text-white">Ciao</div></div>',
        'sano',
      ],
      [
        'inchiostro dichiarato sul testo',
        '<div className="bg-kidville-green"><span className="text-kidville-yellow">Ciao</span></div>',
        'sano',
      ],
      [
        'inchiostro dichiarato inline',
        '<div className="bg-kidville-green" style={{ color: "#FDC400" }}>Ciao</div>',
        'sano',
      ],
      [
        'inchiostro dichiarato da una classe `kv-*` che globals.css dipinge',
        '<div className="bg-kidville-green kv-appbar">Ciao</div>',
        'sano',
      ],
      [
        'nessun riempimento scuro: il testo nudo non riguarda questa sezione',
        '<div className="bg-kidville-cream">Ciao</div>',
        'sano',
      ],
      [
        'il riempimento è solo un `hover:`, lo stato a riposo è un altro',
        '<div className="hover:bg-kidville-green">Ciao</div>',
        'sano',
      ],
      [
        '`className` costruito da un helper: indecidibile, non assolto',
        '<div className="bg-kidville-green"><span className={stile("x")}>Ciao</span></div>',
        'ignoto',
      ],
    ]
    for (const [nome, jsx, atteso] of casi) {
      const a = analizzaTsx('finto.tsx', `export const C = () => (${jsx})\n`)
      const visto = a.nudi.length > 0 ? 'nudo' : a.ignoti.length > 0 ? 'ignoto' : 'sano'
      expect(visto, `«${nome}» — la sonda dice «${visto}», doveva dire «${atteso}»`).toBe(atteso)
    }

    // Un elemento che RENDE JSX non è un nodo di testo: senza questa risoluzione
    // `{conversationMenu(trigger)}` sarebbe un falso positivo in due pagine vere.
    const conRinvio =
      'const menu = <b className="text-white">x</b>\n' +
      'export const C = () => (<div className="bg-kidville-green">{menu}</div>)\n'
    expect(analizzaTsx('finto.tsx', conRinvio).nudi, 'un rinvio a JSX non è testo').toEqual([])
  })

  it('5.7 la regola CSS scartata: quali inchiostri perderebbe, e quali no', () => {
    // La correzione «ovvia» — dipingere l'inchiostro sul riempimento con
    // `[data-contrast="high"] [data-kv-shell] .bg-kidville-green { color: … }` —
    // è stata scartata, e non per gusto: qui si misura esattamente che danno fa.
    //
    // ⚠️ E la misura ha CORRETTO la premessa da cui era partita, che diceva
    // «scavalcherebbe i 131 `text-kidville-yellow` e i 16 `text-kidville-yellow-ink`
    // che quel fondo porta oggi». Vero per la grande maggioranza, falso per il
    // resto, e il perché vale più dei numeri: una regola posata sul CONTENITORE
    // arriva ai figli solo per EREDITARIETÀ, e l'ereditarietà perde contro
    // qualunque dichiarazione fatta sul figlio stesso, a qualsiasi specificità.
    // Quindi:
    //   · giallo sullo STESSO elemento del riempimento → perso (la regola vince);
    //   · giallo su un DISCENDENTE → salvo (l'ereditarietà non batte una
    //     dichiarazione), qualunque cifra abbia la specificità.
    // Misurati il 2026-09-06: **150** sullo stesso elemento, **18** su un
    // discendente. La conclusione del collaudo regge — la regola resta scartata,
    // 150 inchiostri di brand sono un prezzo che non si paga — ma il motivo per
    // cui regge è più stretto di come era stato scritto.
    //
    // Terzo fatto, trovato misurando: sotto quel fondo il giallo di brand non è
    // nemmeno l'hex della utility. Dal 2026-08-01 `globals.css` porta una rete di
    // sicurezza sulla COPPIA (`globals.css:1061` e `:1083`) che lo ritinge in
    // `yellow-ink`. È anch'essa non-layered, a 0,2,0: la regola scartata, a
    // 0,3,0, scavalcherebbe pure quella — cioè la correzione di un bloccante.
    expect(specificita('[data-contrast="high"] [data-kv-shell] .bg-kidville-green')).toEqual([0, 3, 0])
    expect(specificita('.bg-kidville-green.text-kidville-yellow')).toEqual([0, 2, 0])
    expect(specificita('.bg-kidville-green .text-kidville-yellow')).toEqual([0, 2, 0])

    const conLaRegolaScartata = [
      ...REGOLE,
      ...parseRegole('[data-contrast="high"] [data-kv-shell] .bg-kidville-green{color:#FFFFFF}'),
    ]
    const dentroIlGuscio = (dentro: string) => GUSCIO_PARENT.replace('></div>', `>${dentro}</div>`)

    // (a) STESSO ELEMENTO — l'inchiostro si perde. Sono 150 su 168.
    for (const giallo of ['text-kidville-yellow', 'text-kidville-yellow-ink']) {
      const html = dentroIlGuscio(`<div id="sonda" class="bg-kidville-green ${giallo}">x</div>`)
      expect(S.misura(html, true).fg, `oggi «${giallo}» sul riempimento vale il giallo inchiostro`).toBe(
        T['yellow-ink'],
      )
      expect(
        S.misura(html, true, conLaRegolaScartata).fg,
        `con la regola scartata «${giallo}» sparirebbe: 0,3,0 batte sia la utility layered sia la ` +
          `rete di sicurezza sulla coppia, che sta a 0,2,0`,
      ).toBe('#FFFFFF')
    }

    // (b) DISCENDENTE — l'inchiostro NON si perde, e non è la specificità a
    //     salvarlo: è che una dichiarazione sul figlio batte sempre l'eredità.
    const figlio = dentroIlGuscio(
      '<div class="bg-kidville-green"><span id="sonda" class="text-kidville-yellow">x</span></div>',
    )
    expect(S.misura(figlio, true).fg).toBe(T['yellow-ink'])
    expect(
      S.misura(figlio, true, conLaRegolaScartata).fg,
      'l’ereditarietà non batte una dichiarazione: questi 18 la regola non li toccherebbe',
    ).toBe(T['yellow-ink'])

    // (c) …e il testo NUDO invece sì: è l'unico che la regola raggiungerebbe,
    //     ed è il motivo per cui la tentazione di scriverla esiste.
    const nudo = dentroIlGuscio('<div class="bg-kidville-green"><span id="sonda">x</span></div>')
    expect(S.misura(nudo, true).fg).toBe('#000000')
    expect(S.misura(nudo, true, conLaRegolaScartata).fg).toBe('#FFFFFF')

    // I due numeri che rendono la scelta una misura e non un'opinione.
    expect(
      SCANSIONE.gialliSuFondo,
      'inchiostri gialli posati SULLO STESSO elemento di un `bg-kidville-green`: sono loro il ' +
        'prezzo che la regola scartata farebbe pagare. Misurati 150 il 2026-09-06.',
    ).toBeGreaterThanOrEqual(120)
    expect(
      SCANSIONE.gialliDiscendenti,
      'inchiostri gialli su un DISCENDENTE: la regola scartata non li toccherebbe. Misurati 18.',
    ).toBeGreaterThanOrEqual(10)
  })

  it('5.8 IL BUCO DICHIARATO: le stringhe di classi costruite nei file `.ts`', () => {
    // Lo scanner guarda il JSX. Una stringa di classi assemblata in un `.ts` non
    // ha figli da guardare: l'elemento che la riceverà sta in un altro file, e in
    // quel file il riempimento non si vede — arriva da un identificatore, ed è
    // proprio la forma che §5.5 classifica «indecidibile». Il buco non si chiude
    // leggendo il sorgente; si può però NOMINARE e CONTARE, così una stringa
    // nuova costringe qualcuno a guardarla invece di passare in silenzio.
    //
    // Il controllo che si riesce a fare è più debole di quello del JSX, e va
    // detto: si guarda se la DICHIARAZIONE che contiene la stringa nomina, da
    // qualche parte, un inchiostro. Per `btnPrimary` è la stringa stessa; per la
    // tabella degli stati della riconciliazione è l'oggetto accanto (`bg:` e
    // `testo:` sono due proprietà sorelle). Prova che qualcuno ci ha pensato, non
    // che l'inchiostro finisca sull'elemento giusto.
    const stringhe = SORGENTI_TS.flatMap((rel) => {
      const src = ts.createSourceFile(rel, sorgente(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const trovate: string[] = []
      const visita = (n: ts.Node) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
          const utility = n.text.split(/\s+/).find((c) => NOMI_UTILITY_SCURE.has(c))
          if (utility) {
            let dich: ts.Node | undefined = n
            while (dich && !ts.isVariableStatement(dich)) dich = dich.parent
            const conInchiostro = (dich ?? n)
              .getText()
              .split(/[\s'"`]+/)
              .some((c) => /^text-/.test(c) && !TEXT_NON_COLORE.test(c))
            trovate.push(`${rel} · ${utility} · inchiostro nella dichiarazione: ${conInchiostro}`)
          }
        }
        ts.forEachChild(n, visita)
      }
      ts.forEachChild(src, visita)
      return trovate
    })

    expect(
      stringhe.sort(),
      'una stringa di classi con riempimento scuro costruita in un `.ts`: lo scanner JSX non la ' +
        'vede, perché nel `.tsx` che la usa il riempimento arriva da un identificatore. Apri il ' +
        'punto in cui viene usata, verifica che il testo dentro dichiari un inchiostro, e ' +
        'aggiorna questo elenco — che può anche accorciarsi.',
    ).toEqual([
      'src/components/features/admin/pagamenti/riconciliazione-ui.ts · bg-kidville-error-strong · inchiostro nella dichiarazione: true',
      'src/components/features/admin/pagamenti/riconciliazione-ui.ts · bg-kidville-green · inchiostro nella dichiarazione: true',
      'src/components/features/admin/pagamenti/ui.ts · bg-kidville-green · inchiostro nella dichiarazione: true',
      'src/components/features/admin/pagamenti/ui.ts · bg-kidville-green · inchiostro nella dichiarazione: true',
      'src/components/features/admin/settings/ui.ts · bg-kidville-green · inchiostro nella dichiarazione: true',
    ])

    // CONTROLLO POSITIVO: la sonda dei `.ts` non è cieca — vede l'inchiostro
    // quando c'è e la sua assenza quando manca. Senza queste due righe, un
    // refuso nel filtro produrrebbe un elenco vuoto identico a un repo pulito.
    expect(SORGENTI_TS.length, 'la sonda legge davvero i `.ts` di src/').toBeGreaterThan(100)
    expect(stringhe.every((x) => x.endsWith('true')), 'oggi nessuna delle cinque è senza inchiostro').toBe(true)
  })
})
