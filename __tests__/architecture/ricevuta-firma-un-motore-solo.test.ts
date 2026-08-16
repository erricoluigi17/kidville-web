// @vitest-environment node
/**
 * LOCK · le schermate della FAMIGLIA non disegnano documenti, e non nominano marchi che
 * non esistono.
 *
 * ─── PERCHÉ ESISTE ─────────────────────────────────────────────────────────────
 *
 * Fino al 2026-08-16 `src/app/(dashboard)/parent/modulistica/page.tsx` conteneva
 * `generateReceiptPDF`: un secondo motore PDF, dentro il browser del genitore, gemello di
 * `src/lib/fea/receipt-pdf.ts`. I due erano già divergenti, ed è esattamente ciò che due
 * motori per lo stesso foglio fanno al primo ritocco — il gemello lato server era stato
 * ripulito su questo stesso ramo («il nome del firmatario senza recapiti: mai un'email,
 * mai un indirizzo IP»), e la copia nel browser era rimasta intatta.
 *
 * Che cosa stampava, misurato sul file prima della rimozione:
 *
 *  · una banda verde `rect(0, 0, 210, 40)` disegnata dal codice al posto della carta vera;
 *  · «KIDVILLE SCHOOLS» in giallo — non è la ragione sociale (che è «Scuola dell'infanzia
 *    la favola soc. coop.», e sta stampata nel piede della carta reale), non è il marchio,
 *    non è niente — e «Registro Elettronico & Modulistica Legale AgID», una conformità
 *    che nessuno ha certificato;
 *  · il **codice fiscale** del firmatario, il suo **indirizzo IP** e lo **User Agent**;
 *  · e soprattutto: `log?.ip || '192.168.1.45'` e `log?.provider || 'Aruba SPID'`, cioè
 *    un indirizzo IP e un identity provider **inventati** quando il log non li aveva,
 *    sotto la frase «ricevuta inattaccabile del consenso».
 *
 * ─── COSA SORVEGLIA, E COSA NO ─────────────────────────────────────────────────
 *
 *  1. Nessun file sotto `src/app/(dashboard)/parent/**` costruisce un PDF (`jspdf`).
 *     Il perimetro è la FAMIGLIA e non tutta la dashboard, ed è una misura, non una
 *     preferenza: `src/app/(dashboard)/admin/modulistica/page.tsx` un `jsPDF` ce l'ha
 *     ancora — è la stampa di servizio con cui la segreteria unisce dei moduli, dichiarata
 *     `FUORI_PERIMETRO` in `motori-pdf-perimetro-carta.test.ts`. Un lock che la
 *     comprendesse sarebbe rosso il giorno in cui nasce, cioè non sarebbe un lock.
 *  2. «KIDVILLE SCHOOLS» non compare in nessun CODICE di `src/`. I commenti si tolgono
 *     prima di guardare: questo file e la pagina ripulita la nominano per raccontare che
 *     cosa è stato rimosso, ed è giusto che possano.
 *
 * Non verifica che la ricevuta sia bella né che il gate regga: quelli sono
 * `__tests__/api/fea-receipt.test.ts` e i test del motore.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(process.cwd(), 'src')
const FAMIGLIA = path.join(SRC, 'app/(dashboard)/parent')

/** Ogni `.ts`/`.tsx` sotto una radice, ricorsivamente. */
function sorgenti(radice: string): string[] {
  const trovati: string[] = []
  const cammina = (dir: string): void => {
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, voce.name)
      if (voce.isDirectory()) cammina(completo)
      else if (/\.tsx?$/.test(voce.name)) trovati.push(completo)
    }
  }
  cammina(radice)
  return trovati
}

/**
 * Il codice senza commenti: `/* … *\/` e `// …`.
 *
 * Serve perché la memoria di un difetto va scritta accanto al punto in cui è stato tolto,
 * e un lock che la contasse come una ricaduta costringerebbe a cancellare la spiegazione —
 * cioè a far sparire l'unica cosa che impedisce di rifarlo.
 */
const senzaCommenti = (codice: string): string =>
  codice.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

const relativo = (f: string) => path.relative(process.cwd(), f)

describe('lock architettura · la ricevuta di firma ha un motore solo, e sta sul server', () => {
  it('il lock sta guardando qualcosa: le schermate della famiglia esistono e si leggono', () => {
    const file = sorgenti(FAMIGLIA)
    // Senza questa misura tutte le prove qui sotto sarebbero verdi su una cartella
    // rinominata — che è il modo in cui un lock smette di proteggere senza diventare rosso.
    expect(file.length).toBeGreaterThan(5)
    expect(file.some((f) => f.endsWith('modulistica/page.tsx'))).toBe(true)
  })

  it('nessuna schermata della famiglia costruisce un PDF nel browser', () => {
    const colpevoli = sorgenti(FAMIGLIA)
      .filter((f) => /['"`]jspdf|new jsPDF/.test(senzaCommenti(fs.readFileSync(f, 'utf8'))))
      .map(relativo)
    expect(
      colpevoli,
      'un documento che una famiglia scarica si disegna sul SERVER, dove c’è la carta ' +
        'intestata vera e dove il contenuto non dipende da ciò che il browser sa: qui ' +
        'nasceva la ricevuta con «KIDVILLE SCHOOLS», il codice fiscale e un indirizzo IP ' +
        'inventato. La ricevuta di firma la serve `GET /api/fea/receipt`.',
    ).toEqual([])
  })

  it('«KIDVILLE SCHOOLS» non esiste più in nessun codice', () => {
    const colpevoli = sorgenti(SRC)
      .filter((f) => /KIDVILLE SCHOOLS/i.test(senzaCommenti(fs.readFileSync(f, 'utf8'))))
      .map(relativo)
    expect(
      colpevoli,
      'non è la ragione sociale, non è il marchio e non è niente: sui documenti che escono ' +
        'dalla scuola l’ente si nomina una volta sola e sempre allo stesso modo.',
    ).toEqual([])
  })

  it('la pagina della modulistica chiede la ricevuta alla rotta, e la chiede per la SUA submission', () => {
    const pagina = fs.readFileSync(
      path.join(process.cwd(), 'src/app/(dashboard)/parent/modulistica/page.tsx'),
      'utf8',
    )
    const codice = senzaCommenti(pagina)
    // `entita=forms`: la ricevuta è ancorata alla riga di `forms_submissions`, e la rotta
    // la serve solo al firmatario. Senza `entita` giusta risponderebbe 400, e il pulsante
    // sarebbe un pulsante che non fa niente.
    expect(codice).toMatch(/\/api\/fea\/receipt\?entita=forms&id=/)
    // E l'id non si costruisce a mano: `encodeURIComponent` su un uuid non serve, ma su un
    // valore che un giorno cambierà forma sì — è la riga che si dimentica.
    expect(codice).toMatch(/encodeURIComponent\(submissionId\)/)
  })
})
