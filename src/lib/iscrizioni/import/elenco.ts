/**
 * Leggere l'elenco di classe che la segreteria prepara in Excel.
 *
 * ─── LA FORMA DEL FILE, MISURATA SUL VERO ───────────────────────────────────
 * Un foglio per classe: **il nome del foglio È la classe** (`MICRONIDO`,
 * `2 ANNI A`, `3 ANNI B `, `4 anni  a`, `I`, `II`…). Dentro, due colonne:
 *   A · il nome dell'alunno, come l'ha scritto la segreteria
 *   B · la retta mensile, che è una cifra oppure un rimando («vedi fratello»)
 * La prima riga è l'intestazione. Più in là, in una cella qualsiasi della riga,
 * può esserci un'annotazione tipo `nome classe= sez. delle meraviglie`: è una
 * nota per gli umani, non un dato, e non entra da nessuna parte.
 *
 * ─── QUESTO MODULO NON GIUDICA, MISURA ──────────────────────────────────────
 * Non corregge niente e non scarta niente: riporta le righe **come sono** e, di
 * fianco, l'elenco delle difformità. La segreteria deve poter vedere il proprio
 * file com'è — non come si sperava che fosse — perché è lei che lo corregge.
 *
 * Le difformità che cerca sono quelle contate il 2026-08-16 sul file di
 * Giugliano (338 righe): 30 rette vuote, 36 rimandi, 14 nomi con spazi di
 * troppo, un nome tutto in minuscolo, un `?` al posto della cifra, due alunni
 * ripetuti in due fogli e due omonimi veri.
 */
import * as XLSX from 'xlsx'
import { normalizzaNome } from './normalizza'

export interface RigaLetta {
  classe: string
  nome: string
  nomeNorm: string
  rigaExcel: number
  retta: number | null
  rettaTesto: string | null
}

export type GenereAnomalia =
  | 'nome-mancante'
  | 'retta-mancante'
  | 'retta-non-numerica'
  | 'nome-ripetuto'
  | 'spazi-anomali'
  | 'retta-fuori-scala'

export interface Anomalia {
  genere: GenereAnomalia
  classe: string
  rigaExcel: number
  /** Il nome com'è scritto: serve a ritrovare la riga nel foglio. */
  nome: string
  /** Una frase leggibile da una persona. */
  dettaglio: string
}

export interface ElencoLetto {
  righe: RigaLetta[]
  anomalie: Anomalia[]
  /** Un conteggio per foglio, per far vedere subito le classi troppo piene o vuote. */
  perClasse: { classe: string; alunni: number }[]
}

/** Riconosce il rimando a un fratello, con la stessa regola di `retta.ts`. */
const RIMANDO = /\bvedi\b/i

/** Le annotazioni che la segreteria lascia a lato: non sono dati. */
const ANNOTAZIONE = /nome\s*classe\s*=/i

function numeroDaCella(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    // «300», « 300 », «300,00», «€ 300»: una cifra scritta come testo resta una cifra
    const pulito = v.replace(/[€\s]/g, '').replace(',', '.')
    if (/^\d+(\.\d+)?$/.test(pulito)) return Number(pulito)
  }
  return null
}

/**
 * Legge il file e restituisce righe e difformità.
 *
 * @param dati il contenuto del .xlsx
 */
export function leggiElenco(dati: ArrayBuffer | Uint8Array): ElencoLetto {
  const wb = XLSX.read(dati, { type: 'array' })
  const righe: RigaLetta[] = []
  const anomalie: Anomalia[] = []
  const perClasse: { classe: string; alunni: number }[] = []

  for (const classe of wb.SheetNames) {
    const foglio = wb.Sheets[classe]
    if (!foglio) continue
    const matrice = XLSX.utils.sheet_to_json<unknown[]>(foglio, { header: 1, blankrows: false })

    let contati = 0
    for (let i = 1; i < matrice.length; i++) {
      const r = matrice[i] ?? []
      const rigaExcel = i + 1
      const grezzo = r[0]
      const cellaRetta = r[1]

      const nome = typeof grezzo === 'string' ? grezzo : grezzo == null ? '' : String(grezzo)
      const nomeNorm = normalizzaNome(nome)

      // Riga senza nome: se non c'è nemmeno una retta è una riga vuota di coda e
      // non interessa nessuno; se la retta c'è, è una riga che ha perso il nome.
      if (!nomeNorm) {
        if (cellaRetta != null && String(cellaRetta).trim() !== '') {
          anomalie.push({
            genere: 'nome-mancante',
            classe,
            rigaExcel,
            nome: '',
            dettaglio: `Alla riga ${rigaExcel} c'è una retta (${String(cellaRetta)}) ma manca il nome dell'alunno.`,
          })
        }
        continue
      }
      if (ANNOTAZIONE.test(nome)) continue

      const retta = numeroDaCella(cellaRetta)
      const testo =
        retta === null && cellaRetta != null && String(cellaRetta).trim() !== ''
          ? String(cellaRetta).trim()
          : null

      righe.push({ classe, nome, nomeNorm, rigaExcel, retta, rettaTesto: testo })
      contati++

      if (nome !== nome.trim() || /\s{2,}/.test(nome.trim())) {
        anomalie.push({
          genere: 'spazi-anomali',
          classe,
          rigaExcel,
          nome,
          dettaglio: `«${nome}» ha spazi di troppo: verrà confrontato come «${nomeNorm}».`,
        })
      }

      if (retta === null && testo === null) {
        anomalie.push({
          genere: 'retta-mancante',
          classe,
          rigaExcel,
          nome,
          dettaglio: `Manca la retta di ${nome}: finché la cella resta vuota l'iscrizione non parte.`,
        })
      } else if (retta === null && testo !== null && !RIMANDO.test(testo)) {
        anomalie.push({
          genere: 'retta-non-numerica',
          classe,
          rigaExcel,
          nome,
          dettaglio: `La retta di ${nome} è scritta «${testo}»: non è una cifra né un rimando a un fratello.`,
        })
      }
    }

    perClasse.push({ classe, alunni: contati })
  }

  anomalie.push(...ripetuti(righe), ...fuoriScala(righe))
  return { righe, anomalie, perClasse }
}

/** Lo stesso nome due volte: nello stesso foglio o in due fogli diversi. */
function ripetuti(righe: RigaLetta[]): Anomalia[] {
  const per = new Map<string, RigaLetta[]>()
  for (const r of righe) {
    const l = per.get(r.nomeNorm) ?? []
    l.push(r)
    per.set(r.nomeNorm, l)
  }
  const out: Anomalia[] = []
  for (const [, gruppo] of per) {
    if (gruppo.length < 2) continue
    const dove = gruppo.map((g) => `${g.classe} (riga ${g.rigaExcel})`).join(', ')
    for (const g of gruppo) {
      out.push({
        genere: 'nome-ripetuto',
        classe: g.classe,
        rigaExcel: g.rigaExcel,
        nome: g.nome,
        dettaglio: `«${g.nome}» compare ${gruppo.length} volte: ${dove}. Se sono due bambini diversi va bene, ma nessuna iscrizione con questo nome potrà essere assegnata da sola.`,
      })
    }
  }
  return out
}

/**
 * Rette lontane da quella prevalente del foglio.
 *
 * Non è un errore — su 16 fogli veri le rette fuori scala sono 46 e quasi tutte
 * legittime (part-time, sconti, nido dentro una sezione infanzia). È una cosa da
 * far VEDERE, non da bloccare: per questo non impedisce mai un invio.
 */
function fuoriScala(righe: RigaLetta[]): Anomalia[] {
  const perClasse = new Map<string, RigaLetta[]>()
  for (const r of righe) {
    const l = perClasse.get(r.classe) ?? []
    l.push(r)
    perClasse.set(r.classe, l)
  }

  const out: Anomalia[] = []
  for (const [classe, gruppo] of perClasse) {
    const cifre = gruppo.map((g) => g.retta).filter((v): v is number => v !== null)
    if (cifre.length < 4) continue // troppo poche per parlare di «prevalente»

    const conteggio = new Map<number, number>()
    for (const c of cifre) conteggio.set(c, (conteggio.get(c) ?? 0) + 1)
    let moda = cifre[0]
    let max = 0
    for (const [v, n] of conteggio) if (n > max) [moda, max] = [v, n]
    if (max < cifre.length / 2) continue // nessuna retta davvero prevalente

    for (const g of gruppo) {
      if (g.retta === null || g.retta === moda) continue
      out.push({
        genere: 'retta-fuori-scala',
        classe,
        rigaExcel: g.rigaExcel,
        nome: g.nome,
        dettaglio: `${g.nome} paga ${g.retta} € mentre in ${classe} quasi tutti pagano ${moda} €. Non blocca niente: è solo da guardare.`,
      })
    }
  }
  return out
}
