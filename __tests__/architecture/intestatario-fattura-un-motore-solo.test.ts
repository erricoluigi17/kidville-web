// @vitest-environment node
/**
 * LOCK · CHI intesta la fattura si decide in UN POSTO SOLO, e chi lo MOSTRA usa
 * quello che EMETTE.
 *
 * ─── PERCHÉ ESISTE, ed è la stessa storia della causale ──────────────────────
 * Il 2026-09-03 la FPR 1948/26 è partita con una descrizione diversa da quella
 * configurata, perché il modale «Emetti» la ricalcolava per conto suo: la
 * segreteria approvava un testo e ne partiva un altro. Da lì il lock gemello
 * `causale-fattura-un-motore-solo.test.ts`.
 *
 * L'intestatario è l'altra metà dello stesso documento, e il danno è più grande:
 * una descrizione sbagliata è una frase, un intestatario sbagliato è una fattura
 * emessa a nome di un'altra persona, col suo codice fiscale, trasmessa
 * all'Agenzia delle Entrate — e si corregge solo con una nota di variazione.
 *
 * ─── COSA SORVEGLIA, E COSA NO ──────────────────────────────────────────────
 *  1. `determinaQuoteFatturazione` — la cascata che dice a chi va intestata una
 *     quota — si chiama da un elenco CHIUSO di moduli. In particolare NON dalla
 *     route di anteprima: quella passa da `componiIntestatarioPagamento`, che è
 *     il posto unico.
 *  2. `riconosciOrdinante` (il riconoscimento del genitore dal nome sul bonifico)
 *     ha UN solo chiamante di produzione. Due lo renderebbero due regole.
 *  3. `applicaIntestatarioScelto` — la regola dei genitori separati — si chiama
 *     solo dall'emissione. Se la chiamasse anche qualcun altro, il rifiuto a 409
 *     varrebbe su una strada e non sull'altra.
 *  4. L'anteprima e l'emissione convergono davvero: l'una su
 *     `componiIntestatarioPagamento`, l'altra su `determinaQuoteFatturazione`.
 *  5. Nessun componente client ricalcola nulla di tutto questo. Il browser può
 *     usare `validaCessionario` — è il punto, la stessa regola in tre posti — ma
 *     non può decidere CHI.
 *
 * NON verifica che l'intestatario sia GIUSTO: quello è
 * `__tests__/api/fattura-anteprima-intestatario.test.ts` e
 * `__tests__/lib/aruba/emissione-intestatario-scelto.test.ts`. E non verifica che
 * il cessionario dell'XML resti una persona fisica senza `Denominazione` né
 * `IdFiscaleIVA`: quello si MISURA sul documento generato, in
 * `__tests__/lib/aruba/emissione-intestatario-xsd.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const RADICE = path.join(process.cwd(), 'src')

const INTESTATARI = path.join('src', 'lib', 'pagamenti', 'intestatari.ts')
const ORDINANTE = path.join('src', 'lib', 'pagamenti', 'ordinante-genitore.ts')
const MOTORE = path.join('src', 'lib', 'aruba', 'intestatario-pagamento.ts')
const EMISSIONE = path.join('src', 'lib', 'aruba', 'emissione.ts')
const RICEVUTE = path.join('src', 'lib', 'pagamenti', 'ricevute.ts')
const ANTEPRIMA = path.join('src', 'app', 'api', 'pagamenti', 'fattura', 'anteprima', 'route.ts')

/**
 * Chi può chiedere alla cascata a chi va intestata una quota. `ricevute.ts` c'è
 * perché la ricevuta cartacea deve nominare LA STESSA persona della fattura: è
 * l'opposto di una divergenza, ed è il motivo per cui riusa questa funzione
 * invece di rileggersi `intestatario_fatture` per conto suo.
 */
const AMMESSI_QUOTE = [INTESTATARI, EMISSIONE, RICEVUTE, MOTORE]

/**
 * Il contesto di «Componi il pagamento» (conciliazione composita, 2026-09-13).
 *
 * ⚠️ È il SECONDO chiamante di `riconosciOrdinante`, e il primo dal 2026-09-03:
 * va detto perché, altrimenti la prossima aggiunta si appoggerà a questa senza
 * sapere a che condizioni è stata concessa.
 *
 * QUESTA ROTTA NON DECIDE CHI INTESTA UNA FATTURA. Risponde a una domanda
 * diversa e più povera: chi ha fatto il bonifico, cioè il PAGANTE dell'incasso
 * (`transazioni_contabili.pagante_parent_id`). Sono due cose che il repository
 * tiene già distinte per un motivo fiscale: `alunni.intestatario_fatture` decide
 * anche a chi va la detrazione del 730, e chi materialmente bonifica può essere
 * un nonno. Conflaterle sarebbe il difetto, non tenerle separate.
 *
 * LA CONDIZIONE CHE RENDE SICURA LA SECONDA CHIAMATA: la rotta passa il solo
 * `ordinante` e i candidati, **senza** `IntestatariNoti`. Non avendo le due
 * fonti del tie-break (la scheda e il default di famiglia), dove il motore della
 * fattura conclude `unico` lei al più conclude `ambiguo` — quindi non può
 * proporre un intestatario DIVERSO da quello del documento: può solo non
 * proporne nessuno e ripiegare sul pagante comune, che è un'altra regola con un
 * altro nome (`motivo: 'pagante_comune'`).
 *
 * ⚠️ QUI C'ERA SCRITTO «visibile all'operatrice», ED ERA FALSO — misurato il
 * 2026-09-13: `pagante_comune` compare in 4 punti (il tipo e l'assegnazione
 * nella rotta, questa riga, un test), **zero** in `src/components/**` e **zero**
 * nei cataloghi di `messages/`; `CHIAVE_MOTIVO_PROPOSTA` copre i quattro motivi
 * della FATTURA e non questo. Nessun componente chiama ancora `/contesto`.
 * Un commento che descrive una protezione inesistente è il difetto che questo
 * repository ha già pagato due volte, e non lo si ripete nel file che esiste per
 * impedirlo. Ciò che è vero oggi: **il motivo viaggia nella risposta** (campo
 * `pagante.proposto.motivo`, sei valori chiusi, fissati da
 * `__tests__/api/pagamenti-riconciliazione-contesto.test.ts`), e **renderlo è un
 * obbligo della fetta che costruisce il pannello** — non di questa.
 *
 * La metà PORTANTE della deroga non è mai stata quella frase: è che la chiamata
 * abbia due argomenti soli, e adesso è MISURATA su ogni chiamata del file (vedi
 * `argomentiDellaChiamata` qui sotto) invece che promessa in prosa.
 *
 * Chi un giorno le passasse `IntestatariNoti` riaprirebbe esattamente il difetto
 * che questo file esiste per chiudere: due cascate, stesso nome, verdetti che si
 * scoprono diversi solo su una fattura già emessa. Quel giorno, questa voce va
 * tolta e la rotta va fatta passare da `componiIntestatarioPagamento`.
 */
const CONTESTO_COMPOSIZIONE = path.join(
  'src', 'app', 'api', 'pagamenti', 'riconciliazione', '[id]', 'contesto', 'route.ts',
)

function fileTs(dir: string, out: string[] = []): string[] {
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, voce.name)
    if (voce.isDirectory()) fileTs(p, out)
    else if (/\.tsx?$/.test(voce.name)) out.push(p)
  }
  return out
}

/** Via i commenti: un lock non deve poter essere aggirato — né innescato — da una frase. */
function soloCodice(testo: string): string {
  return testo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const FILE = fileTs(RADICE).map((assoluto) => ({
  relativo: path.relative(process.cwd(), assoluto),
  codice: soloCodice(fs.readFileSync(assoluto, 'utf-8')),
}))

/**
 * Gli argomenti di UNA chiamata, a partire dall'indice della sua `(`.
 *
 * Serve un contatore di parentesi e non una regex: una regex `[^)]*` legge «due
 * argomenti» su `f(a, b.map((x) => x), c)`, che ne ha tre — ed è esattamente il
 * modo in cui un terzo argomento passava sotto a questo lock. Le stringhe si
 * saltano, o una `)` dentro un messaggio d'errore chiuderebbe la chiamata.
 */
function argomentiDellaChiamata(codice: string, apertura: number): string[] {
  const args: string[] = []
  let profondita = 0
  let corrente = ''
  let stringa: string | null = null
  for (let i = apertura; i < codice.length; i += 1) {
    const c = codice[i]
    if (stringa !== null) {
      corrente += c
      if (c === '\\') { corrente += codice[i + 1] ?? ''; i += 1; continue }
      if (c === stringa) stringa = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { stringa = c; corrente += c; continue }
    if (c === '(' || c === '[' || c === '{') {
      profondita += 1
      if (profondita > 1) corrente += c
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      profondita -= 1
      if (profondita === 0) {
        if (corrente.trim() !== '') args.push(corrente.trim())
        return args
      }
      corrente += c
      continue
    }
    if (c === ',' && profondita === 1) { args.push(corrente.trim()); corrente = ''; continue }
    corrente += c
  }
  throw new Error('chiamata non chiusa: il sorgente non è leggibile come lo legge questo lock')
}

function chiamano(nome: string): string[] {
  const re = new RegExp(`\\b${nome}\\s*\\(`)
  return FILE.filter((f) => re.test(f.codice)).map((f) => f.relativo)
}

describe('LOCK · un solo motore per l’intestatario della fattura', () => {
  it('la misura vede davvero i sorgenti (controllo positivo)', () => {
    // Senza questo, un percorso sbagliato renderebbe VERDI tutte le regole qui
    // sotto: «zero file letti» e «zero violazioni» hanno lo stesso colore.
    expect(FILE.length).toBeGreaterThan(500)
    expect(FILE.map((f) => f.relativo)).toContain(EMISSIONE)
    expect(FILE.map((f) => f.relativo)).toContain(MOTORE)
  })

  it('il contatore di parentesi conta davvero (controllo positivo sull’attrezzo)', () => {
    // Un lock che misura con un attrezzo rotto è verde per il motivo sbagliato, e
    // questo attrezzo esiste proprio perché il precedente — una regex — lo era.
    // Le tre righe qui sotto sono i casi su cui la regex sbagliava.
    expect(argomentiDellaChiamata('f(a, b)', 1)).toEqual(['a', 'b'])
    expect(argomentiDellaChiamata('f(a, b.map((x) => ({ y: x })), c)', 1)).toHaveLength(3)
    expect(argomentiDellaChiamata('f(a, "uno, due) tre")', 1)).toHaveLength(2)
    expect(argomentiDellaChiamata('f()', 1)).toEqual([])
  })

  it('`determinaQuoteFatturazione` si chiama solo dai moduli ammessi', () => {
    const colpevoli = chiamano('determinaQuoteFatturazione').filter((f) => !AMMESSI_QUOTE.includes(f))
    expect(
      colpevoli,
      'Chi vuole sapere a chi è intestata una quota passa da `determinaQuoteFatturazione`, ' +
        'non se la ricalcola: due cascate divergono, e la divergenza si vede solo su una fattura emessa.',
    ).toEqual([])
  })

  it('`riconosciOrdinante` ha due chiamanti, e il secondo NON può proporre un intestatario', () => {
    const chiamanti = chiamano('riconosciOrdinante').filter((f) => f !== ORDINANTE)
    expect([...chiamanti].sort()).toEqual([CONTESTO_COMPOSIZIONE, MOTORE].sort())

    // La condizione dichiarata sopra, MISURATA e non promessa: il contesto della
    // composizione chiama con due argomenti soli. Col terzo — `IntestatariNoti` —
    // tornerebbe a esistere una seconda cascata dell'intestatario, e questa
    // eccezione andrebbe tolta invece che allargata.
    //
    // ⚠️ SI CONTANO TUTTE LE CHIAMATE DEL FILE, E GLI ARGOMENTI SI CONTANO CON UN
    // CONTATORE DI PARENTESI. La stesura precedente faceva
    // `/riconosciOrdinante\s*\(([^)]*)\)/.exec(codice)`, ed era cieca due volte —
    // misurato il 2026-09-13 mutando la rotta:
    //   · `exec` ritorna SOLO il primo match: una seconda chiamata a tre argomenti
    //     aggiunta ACCANTO a questa lasciava 12 test su 12 verdi. E `chiamano()`
    //     non poteva vederla: conta i FILE che chiamano, non le chiamate.
    //   · `[^)]*` si ferma alla prima `)`: una sola chiamata a tre argomenti col
    //     secondo scritto inline (`candidati.map((c) => ({ … }))`) veniva letta
    //     come «due argomenti» — 12 su 12 verdi, con `IntestatariNoti` passato.
    const codice = FILE.find((f) => f.relativo === CONTESTO_COMPOSIZIONE)?.codice ?? ''
    expect(codice, 'il contesto della composizione non è stato letto').not.toBe('')
    const chiamate = [...codice.matchAll(/\briconosciOrdinante\s*\(/g)]
    const arita = chiamate.map((m) => argomentiDellaChiamata(codice, m.index + m[0].length - 1).length)
    expect(
      arita.filter((n) => n !== 2),
      'una chiamata a `riconosciOrdinante` nel contesto della composizione passa un terzo ' +
        'argomento: con `IntestatariNoti` diventerebbe una SECONDA cascata dell’intestatario ' +
        'della fattura. Le arità trovate: ' + JSON.stringify(arita),
    ).toEqual([])
    expect(
      arita.length,
      'il contesto della composizione chiama `riconosciOrdinante` un numero di volte diverso da ' +
        'UNA. Zero: il lock cerca dove non c’è più (e le due righe qui sopra sarebbero verdi a ' +
        'vuoto). Due o più: la condizione va riverificata su ognuna, perché è la SINGOLA chiamata ' +
        'a due argomenti che rende sicura la deroga, non il file.',
    ).toBe(1)
  })

  it('`applicaIntestatarioScelto` si chiama solo dall’emissione', () => {
    const chiamanti = chiamano('applicaIntestatarioScelto').filter((f) => f !== INTESTATARI)
    expect(
      chiamanti,
      'La regola dei genitori separati (409, non si scavalca) vale solo se esiste in un posto solo.',
    ).toEqual([EMISSIONE])
  })

  it('«chi sono i genitori di questo bambino» ha UNA definizione sola', () => {
    // L'anteprima la usa per PROPORRE, l'emissione per RIFIUTARE (via
    // `adultoEGenitoreDi`). Se i due insiemi divergessero, l'anteprima
    // offrirebbe un adulto che l'emissione poi respinge: l'operatore leggerebbe
    // un rifiuto su una scelta che gli avevamo messo davanti noi.
    const chiamanti = chiamano('identitaGenitoriDiAlunno').filter((f) => f !== INTESTATARI)
    expect(chiamanti).toEqual([MOTORE])
    expect(chiamano('adultoEGenitoreDi').filter((f) => f !== INTESTATARI)).toEqual([EMISSIONE])
  })

  it('l’anteprima e l’emissione convergono davvero', () => {
    expect(chiamano('componiIntestatarioPagamento')).toContain(ANTEPRIMA)
    expect(chiamano('determinaQuoteFatturazione')).toContain(EMISSIONE)
    expect(chiamano('determinaQuoteFatturazione')).toContain(MOTORE)
  })

  it('nessun componente client decide CHI intesta la fattura', () => {
    // ⚠️ `propostaApplicabile` e `intestatarioAutomaticoDelLotto` NON stanno in
    // questo elenco, ed è una decisione, non una dimenticanza: sono chiamate DAL
    // BROWSER per progetto — è il punto, la stessa regola applicata dove l'utente
    // la vede. Quello che il browser non deve fare è *calcolarsela*: la regola
    // vive nel modulo puro, e le tre prove qui sopra impediscono che se ne
    // riscriva una copia. Chi in futuro «riparasse» questo elenco aggiungendoci i
    // due nomi nuovi romperebbe entrambe le strade.
    const client = FILE.filter(
      (f) =>
        /^\s*['"]use client['"]/m.test(f.codice) &&
        /\b(riconosciOrdinante|determinaQuoteFatturazione|applicaIntestatarioScelto|componiIntestatarioPagamento)\s*\(/.test(
          f.codice,
        ),
    ).map((f) => f.relativo)
    expect(client).toEqual([])
  })

  // ── LA PROPOSTA DEL BONIFICO, DA QUANDO ANCHE IL LOTTO LA USA ──────────────
  //
  // «Questo bonifico l'ha fatto Rossi Maria, e Rossi Maria è la mamma» è una
  // decisione su un documento fiscale. La prendeva solo l'emissione singola,
  // sotto gli occhi di chi premeva; ora la prende anche il lotto, dodici volte di
  // fila. Le due strade devono applicare LE STESSE condizioni: due copie che
  // divergono si scoprono su una fattura già partita, e una fattura si corregge
  // solo con una nota di variazione.
  const PROPOSTA = path.join('src', 'lib', 'pagamenti', 'proposta-intestatario.ts')
  const BOTTONE = path.join('src', 'components', 'features', 'admin', 'pagamenti', 'FatturaButton.tsx')
  const PANNELLO_LOTTO = path.join('src', 'components', 'features', 'admin', 'pagamenti', 'LottoFatturePanel.tsx')
  const MOTORE_LOTTO = path.join('src', 'lib', 'pagamenti', 'lotto-fatture.ts')

  it('`propostaApplicabile` è definita in UN posto e la usano le due strade', () => {
    const definizioni = FILE.filter((f) => /export function propostaApplicabile\b/.test(f.codice)).map((f) => f.relativo)
    expect(definizioni).toEqual([PROPOSTA])
    const chiamanti = chiamano('propostaApplicabile').filter((f) => f !== PROPOSTA)
    expect(
      chiamanti.sort(),
      'La preselezione dell’intestatario è una regola sola: se una delle due strade se la riscrive, ' +
        'divergono su CHI riceve il documento.',
    ).toEqual([BOTTONE].sort())
  })

  it('`intestatarioAutomaticoDelLotto` la usa solo il lotto, e passa dal motore condiviso', () => {
    const definizioni = FILE.filter((f) => /export function intestatarioAutomaticoDelLotto\b/.test(f.codice)).map((f) => f.relativo)
    expect(definizioni).toEqual([PROPOSTA])
    const chiamanti = chiamano('intestatarioAutomaticoDelLotto').filter((f) => f !== PROPOSTA)
    expect(
      chiamanti.sort(),
      'Le due guardie in più del lotto — pagamento ripartito, proposto non fatturabile — valgono ' +
        'solo se nessun altro emette saltandole.',
    ).toEqual([MOTORE_LOTTO, PANNELLO_LOTTO].sort())
  })

  it('`propostaBloccataDaiDati` è definita in UN posto, e la usa solo il pannello del lotto', () => {
    // La domanda «perché questa riga NON è entrata nel lotto» è diversa da «a chi si
    // intesta»: la prima sceglie una frase, la seconda un documento fiscale. Tenerle
    // separate è ciò che permette al lock qui sopra di restare stretto — il pannello
    // NON chiama `propostaApplicabile`, che resta della sola emissione singola.
    //
    // Ma la diagnosi va composta col motore condiviso, non riscritta: «l'app sa chi ha
    // pagato ma non gli si può intestare» è vero solo se lo dicono le stesse due
    // funzioni che decidono l'ingresso nel lotto. Una copia locale direbbe la frase
    // sbagliata il giorno in cui una delle due condizioni cambia.
    const definizioni = FILE.filter((f) => /export function propostaBloccataDaiDati\b/.test(f.codice)).map((f) => f.relativo)
    expect(definizioni).toEqual([PROPOSTA])
    expect(chiamano('propostaBloccataDaiDati').filter((f) => f !== PROPOSTA)).toEqual([PANNELLO_LOTTO])
  })

  it('le frasi dei quattro motivi non esistono in copia', () => {
    // Con una copia locale dei quattro nomi, un quinto motivo aggiunto in
    // `ordinante-genitore.ts` non farebbe rompere niente: `tsc` resta verde e a
    // schermo la proposta sparisce in silenzio.
    const definizioni = FILE.filter((f) => /CHIAVE_MOTIVO_PROPOSTA\s*:\s*Record</.test(f.codice)).map((f) => f.relativo)
    expect(definizioni).toEqual([PROPOSTA])
  })

  it('i due motivi del PAGANTE non entrano nel catalogo dei motivi della FATTURA', () => {
    // Il 2026-09-13 la testata di questo file dichiarava `pagante_comune`
    // «visibile all'operatrice»: falso — quattro occorrenze in tutto il repo, tutte
    // nella rotta e nei suoi test, zero nei componenti e zero nei cataloghi. La
    // frase è stata corretta; questa riga è ciò che la SOSTITUISCE, perché una
    // correzione di prosa non impedisce niente.
    //
    // Cosa impedisce: che i due motivi del PAGANTE (`pagante_comune` = «è l'unico
    // genitore legato a tutti i bambini del bonifico», `scelto` = «l'ha indicato
    // l'operatrice») finiscano nel Record che spiega i motivi dell'INTESTATARIO.
    // Sono due domande diverse — chi ha bonificato, e a chi va il documento con la
    // detrazione del 730 — e l'unico modo di riconflaterle senza che `tsc` dica
    // niente è allargare questo Record. Il giorno in cui il pannello mostrerà il
    // motivo del pagante, quelle frasi vanno in un catalogo suo.
    const proposta = FILE.find((f) => f.relativo === PROPOSTA)?.codice ?? ''
    expect(proposta, 'il motore della proposta non è stato letto').not.toBe('')
    const mappa = /CHIAVE_MOTIVO_PROPOSTA[^{]*\{([^}]*)\}/.exec(proposta)?.[1] ?? ''
    expect(mappa, '`CHIAVE_MOTIVO_PROPOSTA` non è più un oggetto letterale: la misura è cieca').not.toBe('')
    expect(
      mappa,
      'un motivo del PAGANTE è entrato nel catalogo dei motivi dell’INTESTATARIO: sono due ' +
        'decisioni diverse, e l’unico posto in cui si possono confondere senza un errore di ' +
        'compilazione è questo Record.',
    ).not.toMatch(/pagante_comune|\bscelto\b/)
  })

  it('la forma dell’intestatario scelto non porta né `Denominazione` né `IdFiscaleIVA`', () => {
    // Fuori scope per decisione del titolare: qui si intesta a una persona
    // fisica. Il divieto vive nello schema (unione discriminata + oggetti
    // stretti); questa riga impedisce che rientri da una scorciatoia nel modulo.
    const forma = FILE.find((f) => f.relativo === path.join('src', 'lib', 'fatturazione', 'intestatario-scelto.ts'))!
    expect(forma.codice).not.toMatch(/denominazione/i)
    expect(forma.codice).not.toMatch(/id_?fiscale_?iva/i)
  })
})
