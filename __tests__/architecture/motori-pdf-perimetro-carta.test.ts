// @vitest-environment node
/**
 * OGNI MOTORE PDF DELL'APP È DICHIARATO: o sta sulla carta intestata, o è un'eccezione
 * SCRITTA. Nessuna terza possibilità, e soprattutto nessun motore che nessuno ha guardato.
 *
 * ─── PERCHÉ ESISTE ─────────────────────────────────────────────────────────────
 *
 * La spec di questo lavoro (§1.5) promette «una testata sola» e nomina **cinque** motori.
 * Contati sul repository il 2026-08-16, i motori che chiamano `new jsPDF` sono **quindici**,
 * e sei di loro si dipingono ancora una banda verde in cima al foglio con dentro il nome
 * della scuola — cioè, alla lettera, i difetti n. 1 e n. 2 della specifica, quelli per cui il
 * modulo `src/lib/carta/` è nato.
 *
 * Il difetto vero non è che siano sei: è che **nessuno lo aveva scritto da nessuna parte**.
 * Dopo il rilascio, la frase «la testata ce l'ha la carta» sarebbe stata vera per cinque
 * motori e falsa per gli altri dieci, senza che il repository lo dicesse — e la prossima
 * persona che scrive un PDF avrebbe copiato il file sbagliato, perché i file sbagliati sono
 * la maggioranza.
 *
 * ─── COSA SORVEGLIA, ESATTAMENTE ───────────────────────────────────────────────
 *
 *  1. **Completezza.** L'insieme dei motori trovati su disco deve coincidere con l'unione
 *     delle due tabelle qui sotto. Un motore NUOVO — che è il momento in cui la scelta si fa
 *     davvero — fa fallire il test finché qualcuno non lo classifica. Non è una checklist:
 *     è la stessa idea del lock `logging-coverage`, dove una route nuda non rompe niente e
 *     semplicemente sparisce dai log.
 *  2. **I motori sulla carta non se la ridisegnano.** Chi sta in `SULLA_CARTA` legge le
 *     quote da `@/lib/carta/geometria` e non dipinge bande a tutta larghezza.
 *  3. **Le tabelle non marciscono.** Ogni percorso dichiarato deve esistere: un file
 *     rinominato renderebbe questo lock verde senza che sorvegli più niente.
 *
 * ⚠️ **Le righe di `FUORI_PERIMETRO` non sono assoluzioni.** Alcune descrivono un difetto
 * noto e non ancora riparato, e lo dicono. Questo lock non giudica: pretende che la scelta
 * sia stata fatta da qualcuno e sia leggibile.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileSorgente, mascheraSorgente } from '../fixtures/sorgente'

const SRC = path.join(process.cwd(), 'src')

/**
 * I cinque motori del perimetro dichiarato dalla spec: impaginano il solo CONTENUTO e la
 * carta reale la stende `applicaCartaIntestata()`, in un posto solo.
 */
const SULLA_CARTA: Record<string, string> = {
  'src/lib/prestampati/impaginazione.ts': 'i 17 prestampati — il motore di riferimento',
  'src/lib/protocolli/documento-pdf.ts': 'documenti su richiesta, protocollati in uscita',
  'src/lib/fea/receipt-pdf.ts': 'ricevuta di firma FEA (senza pulsante, ma non diverge)',
  'src/lib/presenze/registro-pdf.ts': "registro presenze — l'unico foglio orizzontale",
  'src/lib/merch/pdf.ts': "ordine al fornitore — l'unico che esce verso un terzo",
}

/**
 * Tutto il resto, con il motivo per cui la carta NON gli si applica (ancora).
 *
 * Il criterio che divide le due tabelle non è il gusto: la carta è la carta INTESTATA DELLA
 * SCUOLA, e ha senso sotto un atto che la scuola emette. Sotto una fattura elettronica, una
 * stampa di servizio interna o un export di lavoro non aggiunge nulla e costa 1,1 MB a file.
 */
const FUORI_PERIMETRO: Record<string, string> = {
  // ── Hanno ancora una banda propria: difetto noto, riparazione da decidere ──────
  'src/lib/competenze/certificato-pdf.ts':
    "⚠️ DIFETTO NOTO: dipinge rect(0,0,210,42) verde con barretta gialla e ci scrive dentro " +
    "il nome della scuola in bianco — la banda inventata dal codice che il modulo carta esiste " +
    "per togliere. È un atto che la scuola CONSEGNA e che `POST /api/admin/protocolli/da-documento` " +
    "protocolla, quindi la carta gli andrebbe applicata; fuori dal perimetro di W9 perché la " +
    "spec §1.5 non lo elenca, e perché va verificato che `applicaSegnatura()` non gli " +
    "ridipinga sopra la fascia verde dei documenti ACQUISITI.",
  'src/lib/primaria/pagella-pdf.ts':
    '⚠️ DIFETTO NOTO: stessa banda del certificato competenze (ne è il modello). Stesse ' +
    'ragioni, stessa riparazione da fare.',
  'src/app/(dashboard)/parent/modulistica/page.tsx':
    "⚠️ DIFETTO NOTO E PEGGIORE DEGLI ALTRI: `generateReceiptPDF` gira NEL BROWSER, dipinge " +
    "rect(0,0,210,40) con «KIDVILLE SCHOOLS» — che non è la ragione sociale, non è il marchio " +
    "e non è niente — e stampa sul foglio il CODICE FISCALE del genitore, il suo indirizzo IP, " +
    "lo User-Agent e una marca temporale in ISO UTC. È il gemello nel browser di " +
    "`src/lib/fea/receipt-pdf.ts`, a cui quelle tre righe sono state tolte il 2026-08-16.",
  'src/app/api/forms/export/pdf/route.ts':
    '⚠️ DIFETTO NOTO: rect(0,0,210,48) con barretta gialla. Export delle risposte di un ' +
    'modulo del Sistema B, che questo lavoro sta spegnendo per le gite.',
  'src/lib/pdf/credentials-pdf.ts':
    "⚠️ DIFETTO NOTO: rect(0,0,210,38). Foglio delle credenziali: esce dalla scuola verso una " +
    "famiglia, quindi la carta ci starebbe — ma è un foglio con dentro una password, e va " +
    "deciso insieme a come si consegna.",
  'src/app/api/admin/protocolli/export/route.ts':
    "rect(0,0,297,22) su foglio orizzontale. È l'estratto del REGISTRO di protocollo — una " +
    'stampa di servizio della segreteria, non un atto che la scuola emette: la carta ' +
    'intestata non ci aggiunge niente e costerebbe 1,1 MB a export.',

  // ── Nessuna banda: non hanno una testata da togliere ──────────────────────────
  'src/app/api/pagamenti/fattura/route.ts':
    'fattura elettronica: la forma la detta il tracciato SDI, non la carta della scuola.',
  'src/lib/pagamenti/pdf.ts':
    'ricevute e documenti contabili: stessa ragione della fattura.',
  'src/app/api/forms/export/delibera/route.ts':
    'export di lavoro del Sistema B, uso interno.',
  'src/app/(dashboard)/admin/modulistica/page.tsx':
    'stampa di servizio della segreteria, generata nel browser: la carta non può entrare in ' +
    'un bundle client (lock `carta-fuori-dal-bundle-client`).',
}

/** Ogni file di `src/` che costruisce un documento jsPDF, commenti esclusi. */
function motoriPdf(): string[] {
  const trovati: string[] = []
  for (const file of fileSorgente(SRC)) {
    const { senzaCommenti } = mascheraSorgente(fs.readFileSync(file, 'utf8'))
    if (/\bnew\s+jsPDF\s*\(/.test(senzaCommenti)) trovati.push(path.relative(process.cwd(), file))
  }
  return trovati.sort()
}

/** Una banda a tutta larghezza in cima al foglio: `rect(0, 0, <larghezza>, <altezza>)`. */
const BANDA = /\.rect\(\s*0\s*,\s*0\s*,\s*(\d+(?:\.\d+)?)\s*,/g

const MOTORI = motoriPdf()
const DICHIARATI = { ...SULLA_CARTA, ...FUORI_PERIMETRO }

describe('perimetro della carta intestata: ogni motore PDF è classificato', () => {
  it('i motori si trovano davvero (o questo lock è vacuo)', () => {
    expect(MOTORI.length).toBeGreaterThanOrEqual(10)
  })

  it('nessun motore PDF resta senza una riga che dica da che parte sta', () => {
    const orfani = MOTORI.filter((f) => !DICHIARATI[f])
    expect(
      orfani,
      'un motore PDF nuovo: va messo in SULLA_CARTA (e allora legge le quote da ' +
        '@/lib/carta/geometria e non si dipinge una testata) oppure in FUORI_PERIMETRO, con ' +
        'scritto PERCHÉ. Un\'eccezione non dichiarata è quella che il prossimo lavoro ricopia.\n' +
        orfani.join('\n')
    ).toEqual([])
  })

  it('le due tabelle non nominano file che non esistono più', () => {
    const fantasmi = Object.keys(DICHIARATI).filter(
      (f) => !fs.existsSync(path.join(process.cwd(), f)) || !MOTORI.includes(f)
    )
    expect(
      fantasmi,
      'un percorso rinominato o un file che non costruisce più un jsPDF: la riga va tolta, ' +
        'altrimenti questo lock resta verde sorvegliando il nulla.\n' + fantasmi.join('\n')
    ).toEqual([])
  })

  it('i motori sulla carta leggono le quote da @/lib/carta, non se le riscrivono', () => {
    const senzaGeometria = Object.keys(SULLA_CARTA).filter(
      (f) => !/from '@\/lib\/carta(\/geometria)?'/.test(fs.readFileSync(path.join(process.cwd(), f), 'utf8'))
    )
    expect(senzaGeometria).toEqual([])
  })

  it('e non si dipingono più una testata a tutta larghezza', () => {
    const conBanda: string[] = []
    for (const file of Object.keys(SULLA_CARTA)) {
      const { senzaCommenti } = mascheraSorgente(
        fs.readFileSync(path.join(process.cwd(), file), 'utf8')
      )
      for (const [, larghezza] of senzaCommenti.matchAll(BANDA)) {
        // Sopra i 100 mm una `rect` ancorata a (0,0) è una banda di testata, non un riquadro.
        if (Number(larghezza) > 100) conBanda.push(`${file} → rect(0, 0, ${larghezza}, …)`)
      }
    }
    expect(
      conBanda,
      'la testata ce l\'ha la carta: una banda a tutta larghezza ancorata a (0,0) cade sul ' +
        'marchio della scuola.\n' + conBanda.join('\n')
    ).toEqual([])
  })

  it('il rilevatore della banda riconosce una testata vera, altrimenti non ne vedrebbe nessuna', () => {
    // `certificato-pdf.ts` sta in FUORI_PERIMETRO proprio perché la banda ce l'ha ancora:
    // è il campione noto su cui si prova il rilevatore. Se non la vedesse qui, il test
    // «i motori sulla carta non si dipingono una testata» sarebbe verde per sempre — e
    // sarebbe verde anche il giorno in cui la banda rispunta su uno di loro.
    const { senzaCommenti } = mascheraSorgente(
      fs.readFileSync(path.join(process.cwd(), 'src/lib/competenze/certificato-pdf.ts'), 'utf8')
    )
    const bande = [...senzaCommenti.matchAll(BANDA)].map(([, l]) => Number(l)).filter((l) => l > 100)
    expect(bande).toContain(210)
  })

  it('ogni eccezione porta una ragione scritta, non una riga vuota', () => {
    const mute = Object.entries(FUORI_PERIMETRO)
      .filter(([, perche]) => perche.trim().length < 40)
      .map(([f]) => f)
    expect(mute).toEqual([])
  })
})
