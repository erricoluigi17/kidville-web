// @vitest-environment node
/**
 * LOCK · «QUESTO ABBINAMENTO È CERTO» SI DECIDE IN UN POSTO SOLO.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * Dal 2026-09-20 un `auto-singola` non è più un'opinione: è un incasso scritto in
 * contabilità **senza che nessuno clicchi**. La fase in fondo all'import
 * (`riconciliazione-auto-import.ts`) chiude da sé i bonifici che il predicato
 * dichiara certi, e la riga bancaria si marca `abbinato_auto_il`.
 *
 * Un predicato che decide una scrittura di denaro e che esiste in DUE copie non è
 * un rischio teorico in questo repository: è la forma di guasto che ha già
 * prodotto la divergenza fra il chip della fatturazione e il filtro della rotta
 * (`fatturazione-riconciliazione-un-motore-solo.test.ts`), e quella fra le due
 * copie del permesso «chi può essere il pagante»
 * (`pagante-ammesso-un-motore-solo.test.ts`). In tutt'e due i casi le copie erano
 * identiche **il giorno in cui sono nate**. Sono divergute dopo.
 *
 * Qui la divergenza costerebbe più di una schermata che si contraddice. Le due
 * direzioni, e sono entrambe silenziose:
 *
 *  · una seconda copia PIÙ LARGA della prima — «c'è una voce il cui residuo è
 *    pari all'importo, quindi è quella» — sceglie fra due combinazioni che
 *    quadrano allo stesso modo, e sceglie in silenzio: incassa su A e lascia
 *    aperte le due voci di B, cioè fattura a chi non ha pagato e sollecita chi
 *    ha pagato;
 *  · una seconda copia PIÙ STRETTA non scrive niente e non lo dice: i contatori
 *    dell'import (`auto_singole`, `auto_composite`) tornano numeri più piccoli, e
 *    nessuno ha un errore da leggere. «Nessun abbinamento» e «l'automatismo non è
 *    mai partito» hanno lo stesso colore.
 *
 * ─── COSA SORVEGLIA ─────────────────────────────────────────────────────────
 *  1. `valutaCertezza` ha UNA definizione sola, e sta nel motore.
 *  2. I chiamanti sono quelli DICHIARATI qui: un chiamante in più non è vietato,
 *     è un avviso — va dichiarato, perché chi cambia la regola deve sapere quante
 *     scritture di denaro sta muovendo.
 *  3. Il VOCABOLARIO del verdetto (`'auto-singola'`, `'auto-composita'`) non
 *     compare altrove: chi scrive quelle stringhe a mano sta producendo o
 *     interpretando un verdetto fuori dal motore.
 *  4. Le tre manopole (`TETTO_VOCI_CANDIDATE`, `TETTO_IMPORTO`,
 *     `RINUNCIA_SE_RITIRATO`) sono dichiarate una volta sola. Una soglia
 *     ricopiata è un predicato ricopiato con un altro nome: il giorno in cui una
 *     sola delle due si alza, il motore dice «certo» su un importo che la
 *     registrazione rifiuta — o il contrario.
 *  5. Il motore resta PURO: niente Supabase, niente logger, niente orologio. Non
 *     è igiene, è la condizione perché la regola sia collaudabile per intero in
 *     `vitest` invece che osservata in produzione sui bonifici di famiglie vere.
 *
 * ⚠️ SI ASSERISCE SUL CODICE SENZA COMMENTI, MAI SUL FILE GREZZO — e qui la
 * trappola è armata davvero, non in astratto: la testata del motore contiene la
 * frase «nessun `Date.now()`», scritta apposta per spiegare la purezza. Letta sul
 * sorgente grezzo, la regola 5 diventerebbe ROSSA proprio sul file che la
 * rispetta. Il controllo positivo sulla maschera è la prima prova qui sotto.
 *
 * ⚠️ E I COMMENTI SI TOLGONO CON `mascheraSorgente`, NON CON DUE `replace` A MANO.
 * La prima stesura di questo lock usava
 * `t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')`, che non
 * conosce le stringhe: un `/*` dentro un letterale apre un finto commento che si
 * chiude sul primo terminatore successivo e CANCELLA il codice in mezzo. (Il
 * terminatore qui non si scrive: chiuderebbe questa testata — ed è la prova più
 * corta che una coppia di delimitatori non è un dettaglio sintattico.) Misurato su
 * questo albero il 2026-09-20, confrontando i due su tutti i file di `src/`: in
 * **19 file** lo strip a mano vedeva MENO codice della maschera, per ~9.600
 * caratteri non-spazio. Il caso peggiore è
 * `src/components/features/teacher/tasks/TaskCard.tsx`, dove l'attributo
 * `accept="image/*,.pdf,.doc,.docx"` apre tre finti commenti che si mangiano
 * ~180 righe di JSX. Nessuno dei 19 contiene oggi i token sorvegliati qui sotto —
 * cioè non c'era un falso negativo ATTIVO — ma il censimento dichiarava «1.256
 * file» e ne leggeva per intero 1.237: è la stessa cecità che il 2026-09-19 è
 * costata tre lock (`lock-ciechi-audit`), e la differenza fra «oggi non morde» e
 * «non può mordere» è tutta qui.
 *
 * La maschera SOSTITUISCE invece di cancellare — commenti → spazi, stessa
 * lunghezza — quindi non può perdere una riga; e quella proprietà è verificabile,
 * il che la rende il controllo positivo che allo strip a mano mancava: la prima
 * prova qui sotto confronta la lunghezza su TUTTI i file scansionati, non sui due
 * sorvegliati. Era proprio quello il buco: la vecchia guardia sui delimitatori
 * residui girava sui soli file di `FIRME`, cioè mai su nessuno dei 19.
 *
 * ⚠️ COSA NON DIMOSTRA: che il predicato sia GIUSTO. Quello lo dice
 * `__tests__/lib/riconciliazione-auto.test.ts` (l'enumerazione dei sottoinsiemi,
 * i due fratelli che quadrano allo stesso modo, il legame
 * `TETTO_IMPORTO === MAX_IMPORTO_EURO`). Qui si sorveglia soltanto che la sede
 * resti una.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { mascheraSorgente, fileSorgente } from '../fixtures/sorgente'

const RADICE = process.cwd()

/** Il predicato, e l'unico posto in cui «certo» vuol dire qualcosa. */
const MOTORE = join('src', 'lib', 'pagamenti', 'riconciliazione-auto.ts')

/**
 * I chiamanti DICHIARATI. Oggi è uno: la fase automatica in fondo al `POST`
 * dell'import, che è anche l'unico punto del repository in cui un verdetto di
 * questo predicato diventa un incasso senza che nessuno guardi.
 */
const CHIAMANTI = [join('src', 'lib', 'pagamenti', 'riconciliazione-auto-import.ts')]

/**
 * Le firme dei sorvegliati: servono al controllo positivo della maschera. Un
 * percorso sbagliato, un file svuotato o una maschera impazzita renderebbero
 * VERDE ogni regola qui sotto — «zero file letti» e «zero violazioni» hanno lo
 * stesso colore.
 */
const FIRME: Record<string, string> = {
  [MOTORE]: 'export function valutaCertezza(',
  [CHIAMANTI[0]]: 'export async function abbinaImportAutomaticamente(',
}

/** Le manopole del predicato: una dichiarazione a testa, e sta nel motore. */
const MANOPOLE = ['TETTO_VOCI_CANDIDATE', 'TETTO_IMPORTO', 'RINUNCIA_SE_RITIRATO']

/**
 * Il vocabolario del verdetto. Sono le due risposte che fanno SCRIVERE: le altre
 * due (`suggerito`, `da_abbinare`) sono i colori che la coda ha già da mesi e
 * vivono legittimamente anche nella UI e nello schema.
 */
const VERDETTI_CHE_SCRIVONO = ['auto-singola', 'auto-composita']

/**
 * Via i commenti — con la maschera CONDIVISA del repository (`../fixtures/sorgente`,
 * la stessa che usano `isolamento-sede-coverage` e, in questo stesso lotto,
 * `annullo-in-blocco-solo-le-auto`), non con due `replace` scritti qui.
 *
 * Non è una preferenza di stile: la maschera conosce stringhe, template e regex,
 * quindi un `/*` dentro un letterale non le apre un commento; e sostituisce con
 * spazi invece di cancellare, quindi il testo ripulito ha la STESSA lunghezza del
 * grezzo e non può aver perso una riga. Il perché sta nella testata, col numero:
 * 19 file e ~9.600 caratteri di codice invisibili allo strip che c'era prima.
 */
const senzaCommenti = (t: string): string => mascheraSorgente(t).senzaCommenti

const SORGENTI = fileSorgente(join(RADICE, 'src')).map((a) => {
  const grezzo = readFileSync(a, 'utf8')
  return { relativo: relative(RADICE, a), grezzo, codice: senzaCommenti(grezzo) }
})

const di = (relativo: string) => SORGENTI.find((f) => f.relativo === relativo)

describe('LOCK · un solo predicato per «questo abbinamento è certo»', () => {
  it('controllo positivo: i sorgenti si leggono, e la maschera non ha divorato il codice', () => {
    expect(SORGENTI.length, 'i sorgenti di `src/` non si leggono più').toBeGreaterThan(500)

    for (const [file, firma] of Object.entries(FIRME)) {
      const f = di(file)
      expect(f, `${file} non è stato letto: il lock sorveglia un file che non c'è più`).toBeDefined()
      expect(
        f!.codice,
        `${file} non contiene più la sua firma (${firma}): o il file è stato svuotato, o la ` +
          'maschera ha divorato il corpo. In tutt\'e due i casi le regole qui sotto non guardano ' +
          'più niente.',
      ).toContain(firma)
    }

    // ⚠️ QUESTA È LA GUARDIA CHE PRIMA MANCAVA, ed è l'unica cosa che distingue
    // «1.256 file scansionati» da «1.256 file letti per intero».
    //
    // Girava sui soli 2 file di `FIRME`, cioè mai su nessuno dei 19 in cui lo
    // strip a mano si mangiava il codice: una cecità che, per costruzione, non
    // poteva accorgersi di sé. Ora la prova sta su TUTTI i file scansionati e
    // non costa niente, perché la maschera garantisce un invariante misurabile:
    // sostituisce i commenti con spazi, quindi il testo ripulito è lungo esatto
    // come il grezzo. Un solo file più corto vuol dire codice sparito dal
    // censimento — e allora ogni `.toEqual([])` qui sotto sarebbe verde per la
    // ragione sbagliata.
    const accorciati = SORGENTI.filter((f) => f.codice.length !== f.grezzo.length).map(
      (f) => `${f.relativo} (${f.grezzo.length} → ${f.codice.length})`,
    )
    expect(
      accorciati,
      'La maschera ha ACCORCIATO un sorgente: da qualche parte ha cancellato invece di ' +
        'sostituire, e il codice sparito non è più sotto nessuna delle regole di questo lock. ' +
        'È esattamente il guasto misurato il 2026-09-20 sullo strip scritto a mano (19 file, ' +
        '~9.600 caratteri): non correggerlo qui allargando la tolleranza — la maschera va ' +
        'riparata in `__tests__/fixtures/sorgente.ts`, dove se ne appoggiano altri sei lock.\n' +
        accorciati.join('\n'),
    ).toEqual([])

    // La maschera serve DAVVERO, e questa è la prova che morde: la testata del
    // motore nomina `Date.now()` per spiegare che non lo usa. Sul sorgente
    // grezzo la regola della purezza sarebbe rossa sul file che la rispetta.
    expect(di(MOTORE)!.grezzo).toContain('Date.now()')
    expect(di(MOTORE)!.codice).not.toContain('Date.now()')
  })

  it('🔴 `valutaCertezza` ha UNA definizione sola, e sta nel motore', () => {
    const definizioni = SORGENTI.filter((f) => /export\s+function\s+valutaCertezza\b/.test(f.codice))
      .map((f) => f.relativo)
    expect(
      definizioni,
      `Il predicato deve essere definito una volta sola, in ${MOTORE}. Una seconda definizione ` +
        'è la divergenza che questo lock esiste per impedire: due copie che oggi coincidono e ' +
        'che il giorno in cui una cambia scrivono due contabilità diverse, senza un errore.',
    ).toEqual([MOTORE])
  })

  it('🔴 i chiamanti sono quelli dichiarati, e non uno di più', () => {
    const chiamanti = SORGENTI.filter(
      (f) => f.relativo !== MOTORE && /\bvalutaCertezza\s*\(/.test(f.codice),
    ).map((f) => f.relativo)
    expect(
      [...chiamanti].sort(),
      'I chiamanti di `valutaCertezza` sono cambiati. Non è un divieto: è un AVVISO. Una porta ' +
        'in più va bene, ma va DICHIARATA in `CHIAMANTI` qui sopra e nella testata del motore, ' +
        'perché chi tocca la regola deve sapere quante scritture di denaro sta muovendo — e ' +
        'perché la porta nuova va provata, non dedotta.',
    ).toEqual([...CHIAMANTI].sort())
  })

  it('🔴 nessuno scrive a mano il vocabolario del verdetto', () => {
    const ammessi = new Set([MOTORE, ...CHIAMANTI])
    const colpevoli: string[] = []
    for (const f of SORGENTI) {
      if (ammessi.has(f.relativo)) continue
      for (const v of VERDETTI_CHE_SCRIVONO) {
        if (f.codice.includes(`'${v}'`) || f.codice.includes(`"${v}"`)) colpevoli.push(`${f.relativo} → ${v}`)
      }
    }
    expect(
      colpevoli,
      'Qui si sta producendo — o interpretando — un verdetto di certezza fuori dal motore. ' +
        '`auto-singola` e `auto-composita` sono le DUE risposte che fanno scrivere denaro senza ' +
        'che nessuno clicchi: chi le nomina altrove o sta riscrivendo il predicato, o sta ' +
        'costruendo una seconda tabella di verità su ciò che quel predicato ha deciso.\n' +
        colpevoli.join('\n'),
    ).toEqual([])
  })

  it('🔴 le manopole sono dichiarate una volta sola', () => {
    for (const nome of MANOPOLE) {
      const re = new RegExp(`export\\s+const\\s+${nome}\\b`)
      const dichiarazioni = SORGENTI.filter((f) => re.test(f.codice)).map((f) => f.relativo)
      expect(
        dichiarazioni,
        `${nome} deve essere dichiarata una volta sola, in ${MOTORE}. Una soglia ricopiata è un ` +
          'predicato ricopiato con un altro nome: il giorno in cui si alza una sola delle due ' +
          'copie, il motore dice «certo» su un caso che la registrazione rifiuta — o il ' +
          'contrario — e nessuno dei due file se ne accorge.',
      ).toEqual([MOTORE])
    }
  })

  it('🔴 il motore resta puro: niente Supabase, niente logger, niente orologio', () => {
    const codice = di(MOTORE)!.codice
    // La purezza non è igiene: è la condizione perché ogni ramo del predicato sia
    // collaudabile in `vitest`. Il giorno in cui questo file leggesse il database
    // o guardasse l'orologio, «stesso ingresso → stesso esito» smetterebbe di
    // essere vero e la regola si potrebbe solo osservare in produzione, sui
    // bonifici di famiglie vere.
    expect(codice, 'il motore ha imparato a leggere il database').not.toMatch(/\bsupabase\b|SupabaseClient/)
    expect(codice, 'il motore ha imparato a loggare').not.toMatch(/\blog(?:Ok|Errore|Evento|Scrittura)\s*\(/)
    expect(codice, 'il motore guarda l’orologio: stesso ingresso, esito diverso').not.toMatch(/\bDate\.now\s*\(|\bnew\s+Date\s*\(/)
    // Gli import ammessi sono tre, tutti puri. Un import in più che porti I/O
    // trascinerebbe qui dentro ciò che le tre righe sopra vietano, per interposta
    // persona.
    const sorgenti = [...codice.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(
      [...new Set(sorgenti)].sort(),
      'Gli import del motore sono cambiati. Ognuno di questi tre è una funzione PURA; il quarto ' +
        'va dichiarato qui solo dopo aver verificato che non porti I/O con sé.',
    ).toEqual(['./codice-voce', './riconciliazione', './transazioni-quadratura'])
  })
})
