/**
 * Leggere l'elenco di classe che la segreteria prepara in Excel.
 *
 * ─── LE DUE FORME, MISURATE SUL VERO ────────────────────────────────────────
 * Le segreterie delle tre sedi non preparano lo stesso foglio, e non è un vezzo:
 * è come lavorano. Misurate il 2026-08-16 (Giugliano) e il 2026-08-20 (Cesa):
 *
 *   A · UN FOGLIO PER CLASSE — **il nome del foglio È la classe** (`MICRONIDO`,
 *       `2 ANNI A`, `3 ANNI B `, `4 anni  a`, `I`, `II`…). Dentro, due colonne:
 *         A · il nome dell'alunno, come l'ha scritto la segreteria
 *         B · la retta mensile, che è una cifra oppure un rimando («vedi fratello»)
 *       Così è Giugliano: 16 fogli, 338 righe.
 *
 *   B · LE CLASSI AFFIANCATE IN UN FOGLIO SOLO — un foglio (`Foglio1`) con le
 *       classi una accanto all'altra, **il nome della classe nella RIGA 1**,
 *       sopra la colonna dei nomi, e la retta nella colonna subito a destra.
 *       Così è Cesa: 13 classi in 51 colonne, 255 righe, con a sinistra di ogni
 *       classe una colonna di numeri progressivi e a destra una colonna vuota.
 *
 * La prima riga è sempre l'intestazione. Più in là, in una cella qualsiasi della
 * riga, può esserci un'annotazione tipo `nome classe= sez. delle meraviglie`: è
 * una nota per gli umani, non un dato, e non entra da nessuna parte.
 *
 * ─── COME SI DISTINGUONO ────────────────────────────────────────────────────
 * Una colonna apre una classe quando valgono **tutte e tre**:
 *   1. ha un'intestazione nella riga 1
 *   2. sotto ha almeno **tre nomi** (celle con almeno una lettera)
 *   3. la colonna **subito a destra** ha almeno una **cifra**
 * Il foglio è a classi affiancate se ne trova **due o più non adiacenti** — due
 * classi non possono stare attaccate, perché ognuna occupa già nome + retta. In
 * ogni altro caso è un foglio-classe, cioè la forma A e il comportamento di ieri.
 *
 * ⚠️ DUE REGOLE PIÙ SEMPLICI, ENTRAMBE SBAGLIATE, ENTRAMBE MISURATE:
 *
 *   · «più di un'intestazione in riga 1 ⇒ blocchi» — tutti e 16 i fogli di
 *     Giugliano ne hanno due (`NOME` + `RETTA`): verrebbero letti al contrario,
 *     i nomi presi per rette e le rette per nomi, su 338 bambini.
 *
 *   · «intestazioni fuori dalle prime due colonne ⇒ blocchi» — è la regola che
 *     rompe il giro vero della segreteria. Il file che lei RISCARICA da qui per
 *     correggerlo ha tre colonne, `Alunno | Retta | Stato`, e `Stato` è testo su
 *     ogni riga: verrebbe preso per una classe chiamata «Stato». Ricaricare il
 *     file appena scaricato è il giro previsto, non un caso limite.
 *
 * La condizione (3) regge entrambi i casi: né accanto a `RETTE` né accanto a
 * `Stato` c'è una cifra. La (2) tiene fuori l'annotazione `nome classe= sez. …`,
 * che è una cella sola, mentre il blocco più piccolo di Cesa ne ha dieci.
 *
 * Il TESTO dell'intestazione non si guarda mai: sui fogli veri è `NOME `,
 * `nomedn`, `Colonna 1`, `1`, `RETTE`, `RETTA SETT`. Qualunque regola basata su
 * come è scritta fallirebbe su almeno uno.
 *
 * ─── QUESTO MODULO NON GIUDICA, MISURA ──────────────────────────────────────
 * Non corregge niente e non scarta niente: riporta le righe **come sono** e, di
 * fianco, l'elenco delle difformità. La segreteria deve poter vedere il proprio
 * file com'è — non come si sperava che fosse — perché è lei che lo corregge.
 *
 * L'unica riscrittura è la barra rovescia nel NOME DELLA CLASSE, e viene
 * dichiarata: v. `classeRiscritta`.
 *
 * Le difformità che cerca sono quelle contate sul vero: a Giugliano 30 rette
 * vuote, 36 rimandi, 14 nomi con spazi di troppo, un nome tutto in minuscolo, un
 * `?` al posto della cifra, due alunni ripetuti in due fogli e due omonimi veri;
 * a Cesa 9 rette vuote e una scritta `X`.
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
  | 'colonna-senza-classe'
  | 'classe-riscritta'
  | 'classe-senza-sezione'

export interface Anomalia {
  genere: GenereAnomalia
  classe: string
  /** Il rigo del foglio: serve a ritrovare la riga. */
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

function piena(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== ''
}

/**
 * UN NOME SENZA NEMMENO UNA LETTERA NON È UN NOME — ed è la riga che impedisce
 * il guasto peggiore di questo modulo.
 *
 * `normalizzaNome` tiene le cifre (`normalizza.ts:41`, `[^A-Z0-9 ]`), e fa bene:
 * la usano `abbinamento.ts` e la colonna `nome_norm` già scritta su 338 righe.
 * Ma qui dentro quella scelta ha un effetto che nessuno vorrebbe. Il foglio di
 * Cesa ha una colonna di numeri progressivi a sinistra di ogni classe: se il
 * rilevamento della forma sbagliasse anche una volta sola, quei numeri
 * diventerebbero ventisette alunni chiamati «1», «2», «3», la sede risulterebbe
 * ARMATA con un elenco di spazzatura, e ogni domanda vera si fermerebbe con un
 * motivo che non dice la verità.
 *
 * Con questa riga lo stesso sbaglio produce **zero righe**, e la route risponde
 * `ELENCO_CLASSI_ILLEGGIBILE`: un rifiuto rumoroso invece di un danno silenzioso.
 */
function nomeLetto(v: unknown): { nome: string; norm: string } {
  const nome = typeof v === 'string' ? v : v == null ? '' : String(v)
  const norm = normalizzaNome(nome)
  return { nome, norm: /[A-Z]/.test(norm) ? norm : '' }
}

/**
 * Il riferimento della cella in stile Excel (`C2`).
 *
 * Con le classi affiancate «riga 2» non basta a ritrovare niente: la stessa riga
 * porta tredici bambini di tredici classi diverse. Chi deve correggere il foglio
 * ha bisogno della cella, non del rigo.
 */
function cella(col: number, riga: number): string {
  let n = col + 1
  let lettere = ''
  while (n > 0) {
    const resto = (n - 1) % 26
    lettere = String.fromCharCode(65 + resto) + lettere
    n = Math.floor((n - 1) / 26)
  }
  return `${lettere}${riga}`
}

/**
 * Il nome della classe raddrizzato.
 *
 * Sul foglio di Cesa la classe del nido è scritta `NIDO 2026\2027`, con la barra
 * ROVESCIA. In archivio la sezione si chiama `NIDO 2026/2027`, e il confronto che
 * risolve `alunni.section_id` (`sync_alunno_section_id`) toglie solo gli spazi:
 * le due scritture non cadrebbero mai insieme, e quindici bambini resterebbero
 * senza classe **senza che nessun errore lo dica**.
 *
 * Si raddrizza QUI e non nel trigger perché questo testo finisce in
 * `alunni.classe_sezione` ed è **visibile alle famiglie**: dev'essere giusto alla
 * fonte, non aggiustato al momento del confronto. E si dichiara, perché questo
 * modulo non corregge in silenzio.
 */
function classeRiscritta(grezza: string): { classe: string; motivo: string | null } {
  const classe = grezza.replace(/\\/g, '/')
  return classe === grezza
    ? { classe, motivo: null }
    : {
        classe,
        motivo: `La classe è scritta «${grezza}» con la barra rovescia: viene letta come «${classe}», che è la forma con cui la sezione esiste in archivio.`,
      }
}

/** Una classe dentro un foglio: dove stanno i suoi nomi e le sue rette. */
interface Blocco {
  classe: string
  colNome: number
  colRetta: number
}

/**
 * Le classi di un foglio, con le loro colonne.
 *
 * Restituisce sempre almeno un blocco: nella forma «un foglio per classe» è uno
 * solo, con la classe presa dal nome del foglio e le colonne A e B.
 */
function blocchiDelFoglio(
  matrice: unknown[][],
  nomeFoglio: string,
): { blocchi: Blocco[]; affiancate: boolean; riscritture: { classe: string; motivo: string }[] } {
  const riga1 = matrice[0] ?? []
  const larghezza = matrice.reduce((n, r) => Math.max(n, (r ?? []).length), 0)

  // Una passata sola su tutto il foglio: per colonna, quanti nomi e quante cifre.
  // Per colonna sarebbero sedici letture del foglio invece di una — sempre poco,
  // ma è la svista facile da fare.
  const nomi = new Array<number>(larghezza).fill(0)
  const cifre = new Array<number>(larghezza).fill(0)
  for (let i = 1; i < matrice.length; i++) {
    const r = matrice[i] ?? []
    for (let c = 0; c < larghezza; c++) {
      const v = r[c]
      if (!piena(v)) continue
      if (nomeLetto(v).norm) nomi[c]++
      if (numeroDaCella(v) !== null) cifre[c]++
    }
  }
  const intestazione = (c: number): boolean => piena(riga1[c])

  // La regola STRETTA: è lei a decidere la forma, e sbagliare qui costa 338 o
  // 255 bambini letti al contrario.
  const strette: number[] = []
  for (let c = 0; c < larghezza; c++) {
    if (intestazione(c) && nomi[c] >= 3 && (cifre[c + 1] ?? 0) >= 1) strette.push(c)
  }
  const adiacenti = strette.some((c, i) => i > 0 && c - strette[i - 1] === 1)
  const affiancate = strette.length >= 2 && !adiacenti

  if (!affiancate) {
    return { blocchi: [{ classe: nomeFoglio, colNome: 0, colRetta: 1 }], affiancate: false, riscritture: [] }
  }

  // Decisa la forma, si ammettono anche i blocchi piccoli: una classe con uno o
  // due bambini non deve sparire in silenzio solo perché è corta.
  const prese = new Set(strette)
  for (let c = 0; c < larghezza; c++) {
    if (prese.has(c) || !intestazione(c) || nomi[c] < 1) continue
    if (prese.has(c - 1) || prese.has(c + 1)) continue
    prese.add(c)
  }

  const blocchi: Blocco[] = []
  const riscritture: { classe: string; motivo: string }[] = []
  for (const c of [...prese].sort((a, b) => a - b)) {
    const grezza = String(riga1[c]).trim()
    const { classe, motivo } = classeRiscritta(grezza)
    if (motivo) riscritture.push({ classe, motivo })
    // La larghezza del blocco non si cabla: la retta è la colonna subito a
    // destra del nome, e dove finisce il blocco lo dice l'intestazione dopo.
    blocchi.push({ classe, colNome: c, colRetta: c + 1 })
  }
  return { blocchi, affiancate: true, riscritture }
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

  for (const nomeFoglio of wb.SheetNames) {
    const foglio = wb.Sheets[nomeFoglio]
    if (!foglio) continue
    const matrice = XLSX.utils.sheet_to_json<unknown[]>(foglio, { header: 1, blankrows: false })

    const { blocchi, affiancate, riscritture } = blocchiDelFoglio(matrice, nomeFoglio)

    for (const r of riscritture) {
      anomalie.push({
        genere: 'classe-riscritta',
        classe: r.classe,
        rigaExcel: 1,
        nome: '',
        dettaglio: r.motivo,
      })
    }

    if (affiancate) anomalie.push(...colonneOrfane(matrice, blocchi))

    for (const b of blocchi) {
      // Dove serve la cella e dove basta il rigo: con le classi affiancate la
      // stessa riga porta tredici bambini, e «riga 2» non indica niente.
      const dove = (col: number, riga: number): string =>
        affiancate ? ` (cella ${cella(col, riga)})` : ''

      let contati = 0
      for (let i = 1; i < matrice.length; i++) {
        const r = matrice[i] ?? []
        const rigaExcel = i + 1
        const grezzo = r[b.colNome]
        const cellaRetta = r[b.colRetta]

        const { nome, norm: nomeNorm } = nomeLetto(grezzo)

        // Riga senza nome: se non c'è nemmeno una retta è una riga vuota di coda e
        // non interessa nessuno; se la retta c'è, è una riga che ha perso il nome.
        if (!nomeNorm) {
          if (piena(cellaRetta)) {
            anomalie.push({
              genere: 'nome-mancante',
              classe: b.classe,
              rigaExcel,
              nome: '',
              dettaglio: `Alla riga ${rigaExcel} c'è una retta (${String(cellaRetta)}) ma manca il nome dell'alunno${dove(b.colNome, rigaExcel)}.`,
            })
          }
          continue
        }
        if (ANNOTAZIONE.test(nome)) continue

        const retta = numeroDaCella(cellaRetta)
        const testo =
          retta === null && piena(cellaRetta) ? String(cellaRetta).trim() : null

        righe.push({ classe: b.classe, nome, nomeNorm, rigaExcel, retta, rettaTesto: testo })
        contati++

        if (nome !== nome.trim() || /\s{2,}/.test(nome.trim())) {
          anomalie.push({
            genere: 'spazi-anomali',
            classe: b.classe,
            rigaExcel,
            nome,
            dettaglio: `«${nome}» ha spazi di troppo: verrà confrontato come «${nomeNorm}»${dove(b.colNome, rigaExcel)}.`,
          })
        }

        if (retta === null && testo === null) {
          anomalie.push({
            genere: 'retta-mancante',
            classe: b.classe,
            rigaExcel,
            nome,
            dettaglio: `Manca la retta di ${nome}: finché la cella resta vuota l'iscrizione non parte${dove(b.colRetta, rigaExcel)}.`,
          })
        } else if (retta === null && testo !== null && !RIMANDO.test(testo)) {
          anomalie.push({
            genere: 'retta-non-numerica',
            classe: b.classe,
            rigaExcel,
            nome,
            dettaglio: `La retta di ${nome} è scritta «${testo}»: non è una cifra né un rimando a un fratello${dove(b.colRetta, rigaExcel)}.`,
          })
        }
      }

      perClasse.push({ classe: b.classe, alunni: contati })
    }
  }

  anomalie.push(...ripetuti(righe), ...fuoriScala(righe))
  return { righe, anomalie, perClasse }
}

/**
 * Le colonne che contengono dati ma non appartengono a nessuna classe.
 *
 * È la guardia contro il guasto peggiore di questa forma: un blocco a cui manca
 * l'intestazione non verrebbe riconosciuto, e i suoi bambini sparirebbero
 * dall'elenco **senza che il conteggio delle righe lo dica** — la segreteria
 * leggerebbe «255 righe» convinta che ci siano tutti.
 *
 * Le colonne dei numeri progressivi non sono orfane: sono la numerazione che la
 * segreteria mette a sinistra di ogni classe, e si riconoscono dal fatto che
 * contengono SOLO numeri.
 */
function colonneOrfane(matrice: unknown[][], blocchi: Blocco[]): Anomalia[] {
  const attribuite = new Set<number>()
  for (const b of blocchi) {
    attribuite.add(b.colNome)
    attribuite.add(b.colRetta)
  }

  const larghezza = matrice.reduce((n, r) => Math.max(n, (r ?? []).length), 0)
  const out: Anomalia[] = []
  for (let c = 0; c < larghezza; c++) {
    if (attribuite.has(c)) continue
    // Solo i NOMI contano: una colonna di numeri progressivi o di rette avanzate
    // non è un blocco perduto, è la numerazione che la segreteria mette a lato.
    const valori = matrice
      .filter((_, i) => i > 0)
      .map((r) => (r ?? [])[c])
      .filter((v) => piena(v) && nomeLetto(v).norm !== '')
    if (valori.length === 0) continue
    out.push({
      genere: 'colonna-senza-classe',
      classe: '',
      rigaExcel: 1,
      nome: '',
      dettaglio: `La colonna ${cella(c, 1).replace(/\d+$/, '')} contiene ${valori.length} valori ma sopra non c'è nessun nome di classe: quei nomi non entrerebbero nell'elenco. Scrivere la classe nella riga 1 di quella colonna.`,
    })
  }
  return out
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
