// @vitest-environment node
/**
 * LOCK · «CHI PUÒ ESSERE IL PAGANTE» SI DECIDE IN UN POSTO SOLO, E LE PORTE SONO DUE.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * `pagamenti_transazioni.pagante_parent_id` è un `parents.id`, e da quell'uuid
 * `src/lib/pagamenti/ricevute.ts` prende NOME e CODICE FISCALE dell'intestatario
 * del documento fiscale. Un id sbagliato non è un campo sbagliato: è una fattura
 * a nome di un estraneo, con la sua detrazione 730 addosso.
 *
 * Su quel permesso si affacciano DUE porte, e fanno cose opposte:
 *   · `…/contesto:GET` — MOSTRA l'elenco dei candidati, e risponde 403 a un
 *     `?pagante=` che non è fra loro;
 *   · la SCRITTURA, che risponde 403 allo stesso modo.
 *
 * ⚠️ LA SECONDA PORTA HA CAMBIATO FILE IL 2026-09-20, e questo lock è stato
 * spostato con lei. Era la rotta `…/componi:POST`; i suoi nove gate — pagante
 * compreso — vivono ora in `src/lib/pagamenti/conciliazione-registra.ts`, perché
 * l'import che concilierà da sé non ha una `Request` e deve attraversare le
 * stesse identiche guardie. Se questo file avesse continuato a leggere la rotta
 * sarebbe rimasto VERDE su un guscio che di paganti non decide più niente: un
 * lock che punta al file da cui il codice è uscito non è severo, è cieco — ed è
 * la specie di cecità che questo repository ha già pagato tre volte.
 * Fino al 2026-09-13 ognuna ne teneva una copia. Erano equivalenti — misurato su
 * 2000 scenari generati: stesse coppie, stessi id, stesse relazioni — ed è
 * esattamente la ragione per cui sono state unite. **Due copie non divergono il
 * giorno in cui nascono: divergono dopo**, e quel giorno la schermata offrirebbe
 * un pagante che la scrittura rifiuta (l'operatrice sbatte contro un 403 su una
 * scelta che il pannello le ha proposto), o il contrario — che è peggio.
 *
 * ─── COSA SORVEGLIA ─────────────────────────────────────────────────────────
 *  1. le due porte chiamano `pagantiAmmessiPerAlunni`;
 *  2. nessuna delle due ricostruisce il PONTE account→`parents`
 *     (`.in('auth_user_id', …)`): è il pezzo che, scritto due volte, fa
 *     divergere gli insiemi;
 *  3. nessuna delle due chiama `getGenitoriDiAlunniEsito`, cioè la sorgente
 *     runtime di questa regola si raggiunge SOLO attraverso il modulo;
 *  4. il modulo non ha una TERZA porta che nessuno ha dichiarato.
 *
 * ⚠️ SI ASSERISCE SUL CODICE SENZA COMMENTI, MAI SUL FILE GREZZO. La prosa di
 * queste due rotte NOMINA tutto ciò che questo lock cerca — `student_parents`,
 * `auth_user_id`, il ponte, perfino la query che lo rifà — perché spiega la
 * regola che il lock sorveglia. È la trappola che questo repository ha già
 * pagato più volte: un lock che legge un file come testo legge anche i commenti,
 * e il commento che descrive la protezione basta a renderlo verde senza la
 * protezione. Il controllo positivo sullo strip è la prima prova qui sotto.
 *
 * ⚠️ COSA NON DIMOSTRA: che la regola sia GIUSTA. Quello lo dicono
 * `__tests__/lib/pagamenti/pagante-ammesso.test.ts` (l'unione dei due ponti, le
 * coppie, `completo`) e i due file di test delle rotte (il 403 e il suo codice).
 * Qui si sorveglia soltanto che la sede resti una.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const RADICE = process.cwd()
const MODULO = join('src', 'lib', 'pagamenti', 'pagante-ammesso.ts')
const CONTESTO = join('src', 'app', 'api', 'pagamenti', 'riconciliazione', '[id]', 'contesto', 'route.ts')
/** La porta che SCRIVE: dal 2026-09-20 è il modulo, non più `…/componi/route.ts`. */
const SCRITTURA = join('src', 'lib', 'pagamenti', 'conciliazione-registra.ts')

/**
 * Le due porte, ognuna con la propria firma: serve al controllo positivo dello
 * strip. Sono due firme di specie diversa perché le porte ormai lo sono — una è
 * una rotta HTTP, l'altra la funzione che i suoi gate li contiene — e appiattirle
 * su una forma sola vorrebbe dire cercare una somiglianza invece della cosa.
 */
const PORTE = [
  { file: CONTESTO, firma: "withRoute(\n  'pagamenti/riconciliazione/[id]/contesto:GET'" },
  { file: SCRITTURA, firma: 'export async function registraConciliazione(' },
]

/** Via i commenti: un lock non deve poter essere né aggirato né innescato da una frase. */
const soloCodice = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const leggi = (f: string) => readFileSync(join(RADICE, f), 'utf8')
const CODICE = new Map(PORTE.map((p) => [p.file, soloCodice(leggi(p.file))]))
const CODICE_MODULO = soloCodice(leggi(MODULO))

function fileTs(dir: string, out: string[] = []): string[] {
  for (const voce of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, voce.name)
    if (voce.isDirectory()) fileTs(p, out)
    else if (/\.tsx?$/.test(voce.name)) out.push(p)
  }
  return out
}
const SORGENTI = fileTs(join(RADICE, 'src')).map((a) => ({
  relativo: relative(RADICE, a),
  codice: soloCodice(readFileSync(a, 'utf8')),
}))

describe('LOCK · un solo motore per «chi può essere il pagante»', () => {
  it('controllo positivo: i sorgenti si leggono, e lo strip non ha divorato il codice', () => {
    // Senza questo blocco, un percorso sbagliato o uno strip impazzito
    // renderebbero VERDE ogni regola qui sotto: «zero file letti» e «zero
    // violazioni» hanno lo stesso colore.
    expect(SORGENTI.length, 'i sorgenti di `src/` non si leggono più').toBeGreaterThan(500)
    for (const { file, firma } of PORTE) {
      const c = CODICE.get(file)!
      expect(c, `lo strip ha divorato il corpo di ${file}`).toContain(firma)
      const residui = c.match(/\/\*|\*\//g) ?? []
      expect(
        residui,
        `in ${file} restano delimitatori di commento dopo la pulizia (${residui.join(' ')}): ` +
          'o un commento è sopravvissuto, o lo strip si è disallineato su un letterale che li ' +
          'contiene. In entrambi i casi le asserzioni qui sotto non leggono più il solo codice.',
      ).toEqual([])
    }
    expect(
      CODICE_MODULO,
      'il modulo non contiene più il PONTE account→`parents`: le regole qui sotto ' +
        'starebbero vietando alle rotte una cosa che nessuno fa più da nessuna parte.',
    ).toContain(".in('auth_user_id'")
    expect(CODICE_MODULO).toContain("from('student_parents')")
  })

  it('🔴 le DUE porte passano dal modulo condiviso', () => {
    const senza = PORTE.filter(({ file }) => !/\bpagantiAmmessiPerAlunni\s*\(/.test(CODICE.get(file)!))
    expect(
      senza.map((p) => p.file),
      'Questa rotta decide chi può essere il pagante senza passare da ' +
        '`pagantiAmmessiPerAlunni`: o si è riscritta la regola in casa, o l’ha persa. ' +
        'Le due porte — quella che MOSTRA i candidati e quella che SCRIVE l’incasso — ' +
        'devono dare lo stesso verdetto sullo stesso genitore, e l’unico modo perché ' +
        'non possano divergere è che sia la stessa funzione.',
    ).toEqual([])
  })

  it('🔴 nessuna delle due ricostruisce il ponte account→`parents`', () => {
    const colpevoli = PORTE.filter(({ file }) => CODICE.get(file)!.includes(".in('auth_user_id'"))
    expect(
      colpevoli.map((p) => p.file),
      'Qui si sta rifacendo il ponte `parents.auth_user_id` che `pagante-ammesso.ts` ' +
        'già fa. È il pezzo esatto da cui nasce la divergenza: 4 legami veri stanno nel ' +
        'SOLO runtime e 81 nella sola anagrafica, e due traduzioni diverse di quel ponte ' +
        'producono due insiemi diversi di paganti ammessi.',
    ).toEqual([])
  })

  it('🔴 la sorgente RUNTIME di questa regola si raggiunge solo attraverso il modulo', () => {
    const colpevoli = PORTE.filter(({ file }) => /\bgetGenitoriDiAlunniEsito\b/.test(CODICE.get(file)!))
    expect(
      colpevoli.map((p) => p.file),
      '`getGenitoriDiAlunniEsito` è metà della regola «chi può pagare»: chiamarlo qui ' +
        'vuol dire ricomporre l’unione per conto proprio. Passa dal modulo. ' +
        '(`getFigliDiGenitoreEsito`, che è un’altra domanda — i figli di UN genitore — ' +
        'resta legittimo: è la composizione dell’elenco dei bambini, non un permesso.)',
    ).toEqual([])
  })

  it('🔴 non è spuntata una TERZA porta che nessuno ha dichiarato', () => {
    const chiamanti = SORGENTI.filter(
      (f) => f.relativo !== MODULO && /\bpagantiAmmessiPerAlunni\s*\(/.test(f.codice),
    ).map((f) => f.relativo)
    expect(
      [...chiamanti].sort(),
      'I chiamanti di `pagantiAmmessiPerAlunni` sono cambiati. Non è un divieto: è un ' +
        'avviso. Una terza porta va bene, ma va DICHIARATA qui e nella testata del ' +
        'modulo, perché chi cambia la regola deve sapere quante schermate sta muovendo — ' +
        'e perché la porta nuova va provata, non dedotta.',
    ).toEqual([SCRITTURA, CONTESTO].sort())
  })
})
