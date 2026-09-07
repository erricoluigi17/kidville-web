// @vitest-environment node
/**
 * LOCK · «questa riga è fatturata / è da fatturare» si decide in UN POSTO SOLO,
 * e quel posto sta in `src/lib`, non fra i componenti.
 *
 * ─── PERCHÉ ESISTE ─────────────────────────────────────────────────────────────
 * La stessa politica era scritta DUE volte: nel chip della lista
 * (`chipFatturazione`) e dentro la rotta del registro, che si ricalcolava a mano
 * i due bidoni del sottofiltro `?fattura=`. Le due copie non erano identiche, e
 * la differenza stava nel DOCUMENTO SINTETICO: la rotta appende
 * `{ stato: 'da_fatturare', numeri: [] }` a ogni riga abbinata che in
 * `fatture_emesse` non ha nessuna riga, quindi per lei «un documento» c'era
 * SEMPRE e il ripiego sul riassunto (`pagamenti.fattura_stato`) non scattava mai.
 * Il chip invece ci ripiega ogni volta che il documento non dice `emessa` né
 * `scartata`.
 *
 * Il caso in cui si contraddicevano è quello che `src/lib/aruba/emissione.ts`
 * chiama «il caso più velenoso»: fattura partita verso lo SdI, scrittura in
 * `fatture_emesse` fallita, `fattura_stato` fermo a `in_attesa` senza nessun
 * documento accanto. Il chip diceva «In attesa SDI»; il filtro spediva la riga
 * fra le «Da fatturare e scartate» — il bidone in cui non si può fare niente,
 * perché su `in_attesa` il pulsante di emissione non c'è — e la toglieva da
 * «Fatturate e in attesa», che è l'elenco con cui si controlla che le fatture
 * siano davvero uscite. Due schermate dello stesso dato che dicono il contrario,
 * e nessun errore da nessuna parte.
 *
 * ─── PERCHÉ IL MOTORE STA IN `src/lib` E NON FRA I COMPONENTI ──────────────────
 * La prima fusione mise la politica in `riconciliazione-ui.ts` e fece importare
 * la ROTTA da `@/components/…`: era il **primo** import di `src/app/api` da
 * `src/components` di tutto il repository. Nessuna regola lo intercettava
 * (`eslint` esce 0, `tsc --noEmit` passa) e la frontiera RSC la prova soltanto
 * `next build` — cioè il difetto sarebbe caduto in CI, lontano da chi l'ha
 * scritto, e con un messaggio che non nomina la politica di fatturazione.
 * La politica condivisa vive in `src/lib/pagamenti/fatturazione-riga.ts`; la UI
 * resta il posto del CHIP (pelle, etichette, forma), che è roba da schermo.
 *
 * ─── COSA SORVEGLIA ────────────────────────────────────────────────────────────
 *  1. Le tre funzioni del motore hanno UNA definizione sola, e sta nel motore.
 *  2. La rotta le IMPORTA dal motore, e non tiene una seconda tabella di verità.
 *  3. `chipFatturazione` passa dal motore: nel suo corpo non ricompare la scala di
 *     ripiego (`fattura_stato` / `pagamento_stato` letti per conto proprio).
 *  4. Nessun file sotto `src/app/api` importa da `src/components`: è la frontiera
 *     che questa storia ha bucato una volta, e che nient'altro guarda.
 *  5. Il motore resta importabile dal SERVER: niente `use client`, niente React,
 *     niente `next-intl`.
 *  6. La regola della LISTA DI LAVORO — «confermato + abbinato + saldato + da
 *     fatturare» — sta anch'essa nel motore, e né la rotta né il pannello del lotto
 *     la riscrivono. ⚠️ È l'aggiunta del 2026-09-07, e nasce dallo stesso difetto
 *     raccontato qui sopra a un giro di distanza: quel pezzo il motore NON lo
 *     conteneva («è una regola della lista di lavoro, non della fattura», diceva la
 *     rotta nel proprio commento), e il giorno in cui la barra «Emetti tutte» ha
 *     avuto bisogno di spuntare esattamente le righe che il filtro mostra, la
 *     congiunzione è ricomparsa parola per parola dentro `selezionabile`. Le cinque
 *     regole qui sopra non la vedevano: guardano `chipFatturazione` e gli import
 *     della rotta. Mutando SOLO la copia della rotta il lock restava verde.
 *
 * NON verifica che la politica sia GIUSTA: quello è
 * `__tests__/pagamenti/riconciliazione-ui.test.ts` (le 75 combinazioni del
 * prodotto cartesiano, il «caso velenoso» e la partizione dei quattro toni) e
 * `__tests__/api/pagamenti-riconciliazione-fatturazione.test.ts` (il sottofiltro
 * `?fattura=` sulla risposta vera del GET).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const RADICE = path.join(process.cwd(), 'src')
const API = path.join(RADICE, 'app', 'api')

const MOTORE = path.join('src', 'lib', 'pagamenti', 'fatturazione-riga.ts')
const CHIP = path.join('src', 'components', 'features', 'admin', 'pagamenti', 'riconciliazione-ui.ts')
const ROTTA = path.join('src', 'app', 'api', 'pagamenti', 'riconciliazione', 'route.ts')
const PANNELLO = path.join('src', 'components', 'features', 'admin', 'pagamenti', 'RiconciliazionePanel.tsx')

/** Le funzioni che compongono la politica: una definizione a testa, e sta nel motore. */
const FUNZIONI = ['esitoFatturazione', 'fatturaGiaFatta', 'fatturaDaFare']

/** Via i commenti: un lock non si aggira — né si innesca — con una frase. */
const soloCodice = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function fileTs(dir: string, out: string[] = []): string[] {
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, voce.name)
    if (voce.isDirectory()) fileTs(p, out)
    else if (/\.tsx?$/.test(voce.name)) out.push(p)
  }
  return out
}

const FILE = fileTs(RADICE).map((assoluto) => ({
  relativo: path.relative(process.cwd(), assoluto),
  codice: soloCodice(fs.readFileSync(assoluto, 'utf-8')),
}))

const di = (relativo: string) => FILE.find((f) => f.relativo === relativo)
const sottoApi = FILE.filter((f) => f.relativo.startsWith(path.relative(process.cwd(), API) + path.sep))

/**
 * IL CORPO DI UNA FUNZIONE ESPORTATA — dalla firma alla SUA chiusura, mai alla
 * fine del file.
 *
 * ⚠️ La prima stesura di questa fetta era `codice.slice(indexOf(firma))`, cioè da
 * lì in avanti fino all'ultimo byte del sorgente. Mordeva per caso: finché dopo
 * `chipFatturazione` non c'era nessun'altra funzione, «il corpo» e «il resto del
 * file» coincidevano. Il giorno in cui si aggiungesse in coda una funzione che
 * chiama il motore, l'asserzione resterebbe verde anche se il chip si fosse
 * ricostruito la sua copia della scala di ripiego — cioè il lock si sfilerebbe da
 * solo, in silenzio, senza che nessuno tocchi questo file.
 *
 * La chiusura è la prima `}` a COLONNA ZERO: dentro il corpo ogni graffa è
 * rientrata. Se un giorno non ci fosse (funzione non chiusa, file troncato) ci si
 * ferma comunque alla dichiarazione di primo livello successiva.
 */
function corpoDi(codice: string, nome: string): string {
  const inizio = codice.indexOf(`export function ${nome}`)
  if (inizio < 0) return ''
  const resto = codice.slice(inizio)
  const candidati = [
    resto.indexOf('\n}'),
    resto.search(/\n(?:export|const|function|type|interface|class)\s/),
  ].filter((i) => i > 0)
  return candidati.length > 0 ? resto.slice(0, Math.min(...candidati) + 2) : resto
}

/** Gli specificatori importati da un file: `import`, `import type`, `import()` ed `export … from`. */
function specificatori(codice: string): string[] {
  const trovati: string[] = []
  for (const [, s] of codice.matchAll(/^[ \t]*import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)) trovati.push(s)
  for (const [, s] of codice.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)) trovati.push(s)
  for (const [, s] of codice.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) trovati.push(s)
  for (const [, s] of codice.matchAll(/^[ \t]*export\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)) trovati.push(s)
  return trovati
}

describe('LOCK · un motore solo per lo stato di fatturazione della riga', () => {
  it('la misura vede davvero i sorgenti (controllo positivo)', () => {
    // Senza questo, un percorso sbagliato renderebbe VERDI tutte le regole qui
    // sotto: «zero file letti» e «zero violazioni» hanno lo stesso colore.
    expect(FILE.length).toBeGreaterThan(500)
    for (const atteso of [MOTORE, CHIP, ROTTA, PANNELLO]) {
      expect(FILE.map((f) => f.relativo), atteso).toContain(atteso)
    }
    expect(sottoApi.length, 'nessun file letto sotto src/app/api').toBeGreaterThan(200)
  })

  it('le tre funzioni del motore hanno UNA definizione sola, e sta nel motore', () => {
    for (const nome of FUNZIONI) {
      const re = new RegExp(`export\\s+function\\s+${nome}\\b`)
      const definizioni = FILE.filter((f) => re.test(f.codice)).map((f) => f.relativo)
      expect(
        definizioni,
        `${nome} deve essere definita una volta sola, in ${MOTORE}: una seconda copia ` +
          'è la divergenza che questo lock esiste per impedire.',
      ).toEqual([MOTORE])
    }
  })

  it('la rotta IMPORTA i due predicati dal motore, invece di riscriverli', () => {
    // UNO PER BIDONE del sottofiltro `?fattura=`. ⚠️ Dal 2026-09-07 il bidone «da
    // fatturare» non passa più da `fatturaDaFare` nudo ma da
    // `daFatturareInListaDiLavoro`, che è quello STESSO predicato più le tre
    // condizioni della lista di lavoro (movimento confermato, pagamento abbinato e
    // saldato). La rotta le riscriveva a mano, e il pannello del lotto le ha
    // ricopiate: v. la regola qui sopra.
    const codice = di(ROTTA)!.codice
    for (const nome of ['daFatturareInListaDiLavoro', 'fatturaGiaFatta']) {
      expect(
        codice,
        `la rotta deve importare ${nome} da @/lib/pagamenti/fatturazione-riga`,
      ).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${nome}\\b[^}]*\\}\\s*from\\s*'@/lib/pagamenti/fatturazione-riga'`))
    }
  })

  it('la regola della LISTA DI LAVORO ha UNA definizione sola, e sta nel motore', () => {
    // ⚠️ LA QUARTA REGOLA, ed è nata da una copia vera. «Questa riga sta nella
    // lista di lavoro» è `stato === 'confermato' && pagamento_id &&
    // pagamento_stato === 'pagato' && fatturaDaFare(…)`: la parte che il motore
    // NON conteneva, e che la rotta dichiarava nel proprio commento come «una
    // regola della LISTA DI LAVORO, non della fattura». Il 2026-09-07 la stessa
    // congiunzione è comparsa, parola per parola, dentro `selezionabile` del
    // pannello — perché la barra del lotto deve spuntare esattamente le righe che
    // il filtro «Da fatturare» mostra. Due copie che oggi coincidono e che il
    // giorno in cui una cambia divergono in silenzio: è letteralmente la storia
    // che questo lock racconta di sé stesso, e le tre regole qui sopra non la
    // vedevano — sorvegliano `chipFatturazione` e gli import della rotta.
    const definizioni = FILE.filter((f) => /export\s+function\s+daFatturareInListaDiLavoro\b/.test(f.codice))
      .map((f) => f.relativo)
    expect(
      definizioni,
      `daFatturareInListaDiLavoro deve essere definita una volta sola, in ${MOTORE}.`,
    ).toEqual([MOTORE])

    for (const chiamante of [ROTTA, PANNELLO]) {
      expect(
        di(chiamante)!.codice,
        `${chiamante} deve importare daFatturareInListaDiLavoro da @/lib/pagamenti/fatturazione-riga`,
      ).toMatch(/import\s*\{[^}]*\bdaFatturareInListaDiLavoro\b[^}]*\}\s*from\s*'@\/lib\/pagamenti\/fatturazione-riga'/)
    }
  })

  it('né la rotta né il pannello riscrivono per conto proprio «il pagamento è saldato»', () => {
    // È la METÀ della regola che il motore non aveva, e la sola che si può
    // sorvegliare per forma: chi la riscrive sta ricostruendo la seconda copia.
    for (const chiamante of [ROTTA, PANNELLO]) {
      expect(
        di(chiamante)!.codice,
        `${chiamante} ricostruisce la regola della lista di lavoro invece di chiamarla`,
      ).not.toMatch(/pagamento_stato\s*===\s*'pagato'/)
    }
  })

  it('la rotta non tiene una SECONDA tabella di verità', () => {
    const codice = di(ROTTA)!.codice
    // Le due liste che duplicavano la politica, e il confronto sul documento.
    expect(codice, 'liste di stati fattura nella rotta').not.toMatch(/FATTURA_(FATTA|DA_FARE)\b/)
    expect(codice, 'confronto su fattura_stato nella rotta').not.toMatch(/fattura_stato\s*===/)
    expect(codice, 'confronto sullo stato del DOCUMENTO nella rotta').not.toMatch(/\.stato\s*[!=]==\s*'emessa'/)
  })

  it('la fetta del corpo si ferma alla funzione, non alla fine del file', () => {
    // Il controllo positivo del taglio: senza, l'asserzione qui sotto guarderebbe
    // tutto il resto del sorgente e passerebbe per la ragione sbagliata.
    const codice = di(CHIP)!.codice
    const corpo = corpoDi(codice, 'chipFatturazione')
    const daLiInPoi = codice.slice(codice.indexOf('export function chipFatturazione'))
    expect(corpo.length, 'il corpo di chipFatturazione non è stato trovato').toBeGreaterThan(200)
    expect(corpo.length, 'la fetta arriva a fine file: non è il corpo').toBeLessThan(daLiInPoi.length)
    expect(corpo.trimEnd().endsWith('}')).toBe(true)
    // `FILTRI_FATTURA` è dichiarato DOPO la funzione: sta nel resto e non nel corpo.
    expect(daLiInPoi).toContain('FILTRI_FATTURA')
    expect(corpo).not.toContain('FILTRI_FATTURA')
  })

  it('il chip passa dal motore: nessuna copia della scala di ripiego nel suo corpo', () => {
    const corpo = corpoDi(di(CHIP)!.codice, 'chipFatturazione')
    expect(corpo).toMatch(/esitoFatturazione\(/)
    // La scala di ripiego vive nel motore: se il chip torna a leggersi il riassunto
    // (`fattura_stato`) o la regola del pagamento saldato (`pagamento_stato`), le
    // copie sono di nuovo due — ed è esattamente così che sono divergute.
    expect(corpo, 'il chip rilegge il riassunto per conto suo').not.toMatch(/fattura_stato/)
    expect(corpo, 'il chip rilegge lo stato del pagamento per conto suo').not.toMatch(/pagamento_stato/)
    expect(corpo, 'il chip si ricostruisce la mappa dei toni').not.toMatch(/TONO_DA_FATTURA/)
  })

  it('nessun file sotto `src/app/api` importa da `src/components`', () => {
    const colpevoli: string[] = []
    for (const f of sottoApi) {
      for (const s of specificatori(f.codice)) {
        if (s.startsWith('@/components') || /(^|\/)\.\.?\/.*\/components\//.test(s)) {
          colpevoli.push(`${f.relativo} → ${s}`)
        }
      }
    }
    expect(
      colpevoli,
      'Una rotta che importa da `src/components` attraversa la frontiera RSC: `eslint` non lo ' +
        'vede, `tsc --noEmit` nemmeno, e a dirlo è solo `next build` — in CI, lontano da chi ha ' +
        'scritto la riga. La logica condivisa fra schermata e rotta sta in `src/lib`.\n' +
        colpevoli.join('\n'),
    ).toEqual([])
  })

  it('il motore resta importabile dal SERVER: niente `use client`, niente React', () => {
    // La rotta lo importa: il giorno in cui questo file diventasse un modulo client
    // la build della rotta cadrebbe, e cadrebbe lontano da qui.
    const testo = fs.readFileSync(path.join(process.cwd(), MOTORE), 'utf-8')
    expect(testo).not.toMatch(/^\s*['"]use client['"]/m)
    expect(soloCodice(testo)).not.toMatch(/from\s*'(react|next\/|next-intl)/)
  })
})
