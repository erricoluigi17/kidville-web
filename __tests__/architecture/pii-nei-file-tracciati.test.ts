import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK · nessun dato personale di una famiglia vera dentro un file TRACCIATO
//
// ─── IL DIFETTO, MISURATO IL 2026-08-08 ────────────────────────────────────
// In `e2e/collaudo-giornata/FINDINGS-CORREZIONE.md` — file TRACCIATO di un
// repository PUBBLICO — c'erano il nome e il cognome per esteso di una persona
// che in produzione risulta ALUNNA ISCRITTA (codice fiscale, data di nascita
// 2025, `note_mediche` valorizzate), insieme al valore della sua colonna
// `allergies`: un dato relativo alla salute, categoria particolare ex art. 9
// GDPR, di una bambina. Erano lì da mesi, leggibili da chiunque su internet.
// La stessa anagrafica, con lo stesso difetto di formato che ha in tabella
// (minuscolo, doppio spazio), era finita anche in una fixture di test e in un
// commento di `src/`: segno che era stata presa dal vivo, non inventata.
//
// Alla prima passata di questo lock ne è saltato fuori un SECONDO, nello stesso
// file e mai notato da nessuno: alla riga 25 il nome proprio di un'altra bambina,
// dentro il corpo di una risposta HTTP catturata con una GET ANONIMA sulla
// produzione. Misurato prima di toccarlo: `select count(*) from public.alunni
// where nome ilike '…'` → 1 riga, `stato='iscritto'`; lo stesso nome compare in
// 8 domande di iscrizione. Non era un nome di fantasia.
//
// ─── COSA NON HA FUNZIONATO, ED È LA PARTE CHE CONTA ───────────────────────
// La regola giusta ESISTEVA GIÀ, a metà: `.gitignore` esclude
// `docs/collaudo/risultati/` proprio perché lì i tester incollano estratti del
// database di produzione. Ma gli esiti di collaudo escono da PIÙ DI UNA strada, e
// la seconda — `e2e/collaudo-giornata/` — non era coperta: il suo `.gitignore`
// locale nasconde `run/`, `.auth/` e `run-credentials.json`, cioè gli artefatti
// dell'esecuzione, e lascia passare il REPORT. Misura del giorno in cui è stato
// scritto questo lock:
//     git check-ignore -q docs/collaudo/risultati/tester-01-x.md   → 0 (ignorato)
//     git check-ignore -q e2e/collaudo-giornata/FINDINGS-NUOVO.md  → 1 (NO)
// «Una regola valida per due strade viveva su una sola.» Nessun controllo del
// gate — 76 lock di architettura, eslint, tsc, vitest, build — guardava quel file.
//
// ─── COSA FA QUESTO LOCK, E COME ───────────────────────────────────────────
// Gira OFFLINE, dentro `vitest`, senza database: non può sapere come si chiamano
// i bambini veri, quindi non cerca QUEL nome. Cerca la FORMA del difetto, su tre
// piani indipendenti:
//
//  P1 · LE STRADE. Ogni percorso in cui un collaudo deposita i suoi esiti deve
//       essere chiuso da `.gitignore`, verificato con `git check-ignore` su un
//       nome di file d'esempio. È la regola che mancava: chiude la strada invece
//       di sperare che nessuno ci passi.
//  P2 · I FILE. Nessun file di esito di collaudo è tracciato. Le eccezioni si
//       dichiarano qui con la ragione e con la data, non si aggiungono al volo.
//  P3 · IL CARICO. In nessun DOCUMENTO tracciato compare un valore letterale
//       accanto al nome di una colonna che contiene dati personali
//       (`allergies`, `note_mediche`, `codice_fiscale`, `giustificazione_testo`,
//       …). È la forma esatta dell'output di una query incollato in un report.
//
// ─── COSA NON COPRE, DETTO PRIMA CHE QUALCUNO CI CONTI ─────────────────────
// Un lock che promette più di quel che fa è peggio di nessun lock. Questo NON
// vede:
//  · un nome e cognome scritti in prosa, senza il nome di una colonna accanto
//    («la bambina Tal dei Tali risulta iscritta due volte»). Per quello serve la
//    prova incrociata col database, che è `scripts/pii-nel-repo.mjs` e gira A MANO
//    perché ha bisogno delle credenziali di produzione;
//  · i sorgenti e le fixture di test (`.ts`, `.tsx`, `.mjs`): là dentro la stessa
//    forma compare 174 volte, tutte legittime (`select('id, allergies')`, zod,
//    fixture con valori palesemente finti come «CF-ALFA-A»), e un lock con 174
//    falsi positivi è un lock che qualcuno spegne. Il perimetro è i DOCUMENTI,
//    dove quella forma è quasi sempre output incollato;
//  · le immagini: uno screenshot con un elenco di alunni passa indisturbato;
//  · la STORIA di git: ciò che è già stato pubblicato resta pubblicato, e questo
//    lock non lo riscrive. Serve una decisione del titolare, non un test.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd()

/** I file tracciati da git, una volta sola: `git ls-files` costa. */
function fileTracciati(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
}

const TRACCIATI = fileTracciati()

/** `git check-ignore`: 0 = il percorso è ignorato, 1 = no. Non tocca il disco. */
function eIgnorato(percorso: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', percorso], { cwd: ROOT })
    return true
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// P1 · LE STRADE DA CUI ESCONO GLI ESITI DI COLLAUDO
//
// Ogni riga è una strada VERA, cioè un posto in cui qualcuno ha davvero scritto
// (o è documentato che scriverà) l'esito di una campagna di collaudo. Il campo
// `esempio` è un nome di file plausibile su quella strada: `git check-ignore` non
// pretende che il file esista, quindi la prova non dipende da cosa c'è su disco
// nel momento in cui il test gira.
// ─────────────────────────────────────────────────────────────────────────────
const STRADE_DEGLI_ESITI: { esempio: string; chi: string }[] = [
  {
    esempio: 'docs/collaudo/risultati/tester-07-frontend.md',
    chi: 'i venti tester del collaudo manuale (docs/collaudo/README.md): leggono il DB di produzione',
  },
  {
    esempio: 'docs/collaudo/risultati-2026-08-08/tester-01-gate.md',
    chi: 'la variante datata della stessa cartella, usata quando si tiene più di una campagna',
  },
  {
    esempio: 'e2e/collaudo-giornata/FINDINGS-NUOVA-CAMPAGNA.md',
    chi:
      'il collaudo «giornata»/«360» (e2e/collaudo-giornata/README.md): gira su app.kidville.it ' +
      'con account TEST e incolla nei findings ciò che legge in produzione — è la strada da cui ' +
      'è passato il nome della bambina',
  },
  {
    esempio: 'e2e/collaudo-giornata/RISULTATI-2026-08.md',
    chi: 'stessa strada, altro nome: chi scrive un report non sceglie sempre la stessa parola',
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// P2 · I FILE DI ESITO CHE NON DEVONO ESSERE TRACCIATI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Come si riconosce un esito di collaudo dal suo nome. Volutamente STRETTO: i
 * PROMPT dei tester (`docs/collaudo/prompt/*.md`), il modello di report e la
 * sintesi sono documenti di metodo, non contengono dati, e restano versionati.
 * Qui si prende solo ciò che, per come è chiamato, È il risultato di una corsa.
 */
const NOMI_DA_ESITO = [
  /(^|\/)FINDINGS[-_.]/i,
  /(^|\/)RISULTATI[-_.]/i,
  /(^|\/)risultati\//i,
  /[-_]findings\.(md|txt|json|html)$/i,
  /(^|\/)report-tester[-_]/i,
]

/**
 * Eccezioni. Ogni riga porta la ragione e la data: un'eccezione senza storia è
 * un permesso che nessuno saprà più perché è stato dato.
 */
const ESITI_TRACCIATI_AMMESSI: Record<string, string> = {
  'e2e/collaudo-giornata/FINDINGS-CORREZIONE.md':
    'È IL FILE DA CUI VIENE QUESTO LOCK. Tracciato dal 2026-07-24; il 2026-08-08 è stato ' +
    'bonificato due volte (nome e cognome + valore di `allergies` di un\'alunna iscritta alla ' +
    'riga 202; nome proprio di un\'altra bambina dentro una risposta HTTP catturata, riga 25). ' +
    'Resta qui e non è cancellato perché documenta tre vulnerabilità vere e il loro rimedio, ed ' +
    'è citato da altri documenti del repo. NON è esente da P3: il suo contenuto passa dal ' +
    'controllo come tutti gli altri, ed è così che il secondo dato è saltato fuori. ' +
    'IL RIMEDIO DEFINITIVO NON È QUESTA RIGA: è togliere il file dall\'indice ' +
    '(`git rm --cached`) lasciandolo su disco, ora che P1 chiude la strada. Serve un comando ' +
    'git, che l\'esecutore di questo lavoro non ha il permesso di dare: è lavoro di chi fa il ' +
    'commit. Quando sarà fatto, questa riga va tolta.',
}

// ─────────────────────────────────────────────────────────────────────────────
// P3 · IL CARICO: UN VALORE LETTERALE ACCANTO A UNA COLONNA DI DATI PERSONALI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I nomi di colonna che, in questo schema, portano dati personali di minori o
 * delle loro famiglie. P4 verifica che descrivano ancora lo schema vero: un
 * registro che nomina colonne inesistenti è un lock che non guarda niente.
 */
const COLONNE_PERSONALI = [
  'allergies',
  'allergie',
  'note_mediche',
  'intolleranze',
  'diagnosi',
  'certificato_medico',
  'giustificazione_testo',
  'note_appello',
  'codice_fiscale',
  'data_nascita',
  'luogo_nascita',
  'nome_alunno',
  'cognome_alunno',
  'telefono',
  'indirizzo',
]

/** Solo i DOCUMENTI: è lì che un valore accanto a una colonna è output incollato. */
const ESTENSIONI_DOCUMENTO = new Set(['.md', '.txt'])

/**
 * `colonna: "valore"` · `colonna='valore'` · `"colonna": "valore"`.
 * Il separatore è solo `:` o `=` — le frecce (`→`, `->`) allargavano la presa a
 * frasi di prosa che passano di lì per caso, e un falso positivo in più è un
 * motivo in più per spegnere il lock.
 */
const VALORE_ACCANTO_ALLA_COLONNA = new RegExp(
  String.raw`\b(${COLONNE_PERSONALI.join('|')})\b\s*[:=]\s*(['"‘’“”\`])([^'"‘’“”\`\n]{1,120})\2`,
  'gi',
)

type RiscontroPii = { file: string; riga: number; colonna: string; valore: string }

/** Tutti i riscontri della forma «colonna = valore» nei documenti tracciati. */
export function riscontriNeiDocumenti(files: string[]): RiscontroPii[] {
  const fuori: RiscontroPii[] = []
  for (const f of files) {
    if (!ESTENSIONI_DOCUMENTO.has(extname(f))) continue
    const percorso = join(ROOT, f)
    if (!existsSync(percorso)) continue
    readFileSync(percorso, 'utf8')
      .split('\n')
      .forEach((riga, i) => {
        for (const m of riga.matchAll(VALORE_ACCANTO_ALLA_COLONNA)) {
          fuori.push({ file: f, riga: i + 1, colonna: m[1].toLowerCase(), valore: m[3] })
        }
      })
  }
  return fuori
}

/**
 * Valori DICHIARATI inventati. La chiave è `file → colonna → valore`, non il
 * numero di riga: le righe si spostano a ogni modifica del documento, e
 * un'eccezione che scade da sola quando qualcuno aggiunge un paragrafo non
 * protegge niente.
 */
const VALORI_INVENTATI: { file: string; colonna: string; valore: string; perche: string }[] = [
  {
    file: 'docs/superpowers/plans/2026-07-12-logging-strutturato.md',
    colonna: 'allergie',
    valore: 'arachidi e crostacei',
    perche:
      'Campione del test di redazione del logger: è l\'elenco dei valori che NON devono uscire ' +
      'in chiaro nei log. Inventato — sta accanto a «Mario Rossi» e «Via Roma 1» nello stesso ' +
      'oggetto CAMPIONE.',
  },
  {
    file: 'docs/superpowers/plans/2026-07-12-logging-strutturato.md',
    colonna: 'diagnosi',
    valore: 'disturbo specifico apprendimento',
    perche: 'Stesso oggetto CAMPIONE: è la definizione di una categoria, non la diagnosi di qualcuno.',
  },
  {
    file: 'docs/superpowers/plans/2026-07-12-logging-strutturato.md',
    colonna: 'certificato_medico',
    valore: 'cert-2026-0031.pdf',
    perche: 'Stesso oggetto CAMPIONE: nome di file d\'esempio, non un documento esistente.',
  },
  {
    file: 'docs/superpowers/plans/2026-07-12-logging-strutturato.md',
    colonna: 'codice_fiscale',
    valore: 'RSSMRA80A01H501U',
    perche:
      'Stesso oggetto CAMPIONE: è il codice fiscale canonico di «Mario Rossi», l\'esempio che ' +
      'compare in ogni manuale italiano. Nessuna persona reale.',
  },
  {
    file: 'docs/superpowers/plans/2026-07-12-logging-strutturato.md',
    colonna: 'indirizzo',
    valore: 'Via Roma 1',
    perche:
      'Stesso oggetto CAMPIONE: l\'indirizzo d\'esempio che accompagna «Mario Rossi» in ogni ' +
      'manuale. Nessuna sede Kidville è in via Roma.',
  },
  {
    file: 'docs/superpowers/plans/2026-07-12-logging-strutturato.md',
    colonna: 'telefono',
    valore: '3331234567',
    perche: 'Stesso oggetto CAMPIONE: numero d\'esempio, cifre in scala.',
  },
  {
    file: 'docs/superpowers/plans/2026-07-10-dehardcode-sezioni.md',
    colonna: 'telefono',
    valore: '081 123',
    perche:
      'Argomento di un test unitario citato nel piano (`normalizzaAnagraficaSede`): un prefisso ' +
      'e tre cifre, non è un numero componibile.',
  },
]

const eInventato = (r: RiscontroPii) =>
  VALORI_INVENTATI.some((v) => v.file === r.file && v.colonna === r.colonna && v.valore === r.valore)

describe('lock architettura · dati personali nei file tracciati', () => {
  it('P0 · lo scanner sta davvero leggendo i file (controllo positivo)', () => {
    // Senza questo, un errore dello strumento si legge «zero riscontri» e il lock diventa
    // verde perché non sta guardando. È successo davvero, nel collaudo del 2026-08-07:
    // le prime scansioni PII usavano `timeout`, che su macOS non esiste, e ogni comando
    // usciva con `command not found` restituendo «0 occorrenze». Erano falsi negativi
    // dello strumento, non un risultato.
    expect(TRACCIATI.length, 'git ls-files non ha restituito niente').toBeGreaterThan(500)
    expect(TRACCIATI, 'manca un file che c\'è di sicuro: la lista non è quella vera').toContain(
      'AGENTS.md',
    )
    // La regex trova ciò che deve trovare, su una riga costruita qui e mai scritta su disco.
    const finto = join(ROOT, 'README.md')
    expect(existsSync(finto)).toBe(true)
    const prova = `- **Anagrafica**: roster duplicato, una con \`allergies='sedano e senape'\``
    expect([...prova.matchAll(VALORE_ACCANTO_ALLA_COLONNA)].map((m) => m[3])).toEqual([
      'sedano e senape',
    ])
  })

  it('P1 · ogni strada da cui escono esiti di collaudo è chiusa da .gitignore', () => {
    const aperte = STRADE_DEGLI_ESITI.filter((s) => !eIgnorato(s.esempio)).map(
      (s) => `${s.esempio} — ${s.chi}`,
    )
    expect(
      aperte,
      'Strada APERTA: un `git add -A` dopo una campagna di collaudo porta dentro il repository ' +
        '— che è PUBBLICO — un file scritto leggendo il database di produzione. È esattamente ' +
        'com\'è entrato il nome di una bambina iscritta insieme al valore della sua colonna ' +
        '`allergies`. La regola c\'era per una strada e non per l\'altra: aggiungi la riga in ' +
        '.gitignore, non l\'eccezione qui.',
    ).toEqual([])
  })

  it('P2 · nessun esito di collaudo è tracciato da git', () => {
    const colpevoli = TRACCIATI.filter((f) => NOMI_DA_ESITO.some((re) => re.test(f)))
      .filter((f) => !f.endsWith('.gitkeep'))
      .filter((f) => !ESITI_TRACCIATI_AMMESSI[f])
    expect(
      colpevoli,
      'Un esito di collaudo è finito nell\'indice di git. Toglilo (`git rm --cached`, il file ' +
        'resta su disco) — oppure, se davvero deve restare nel repository, bonificalo e ' +
        'dichiaralo in ESITI_TRACCIATI_AMMESSI con la ragione e la data.',
    ).toEqual([])
  })

  it('P2b · ogni eccezione dichiarata esiste ancora e ha una ragione scritta', () => {
    for (const [file, motivo] of Object.entries(ESITI_TRACCIATI_AMMESSI)) {
      expect(
        TRACCIATI,
        `${file}: l'eccezione non serve più (il file non è più tracciato). Toglila.`,
      ).toContain(file)
      expect(motivo.length, `${file}: la ragione va scritta per esteso`).toBeGreaterThan(80)
    }
  })

  it('P3 · nessun documento tracciato porta un valore accanto a una colonna di dati personali', () => {
    const colpevoli = riscontriNeiDocumenti(TRACCIATI)
      .filter((r) => !eInventato(r))
      .map((r) => `${r.file}:${r.riga} → ${r.colonna} = ${JSON.stringify(r.valore)}`)
    expect(
      colpevoli,
      'Un valore accanto al nome di una colonna che contiene dati personali: è la forma ' +
        'dell\'output di una query incollato in un documento. Sostituiscilo con l\'uuid, con un ' +
        'conteggio o con un segnaposto fra virgolette angolari — e se il valore è inventato, ' +
        'dichiaralo in VALORI_INVENTATI spiegando perché lo è. Il repository è PUBBLICO e in ' +
        'produzione ci sono i dati di centinaia di minori.',
    ).toEqual([])
  })

  it('P4 · il registro delle colonne descrive lo schema vero', () => {
    // Controllo di SCADENZA: se una colonna viene rinominata, P3 smette di guardarla e
    // nessuno se ne accorge. Si cerca nelle migrazioni e in `src/`, che sono le due fonti
    // in cui un nome di colonna vive per forza.
    const fonti = TRACCIATI.filter(
      (f) => f.startsWith('supabase/migrations/') || f.startsWith('src/'),
    ).map((f) => readFileSync(join(ROOT, f), 'utf8'))
    const testo = fonti.join('\n')
    const sconosciute = COLONNE_PERSONALI.filter((c) => !new RegExp(`\\b${c}\\b`).test(testo))
    expect(
      sconosciute,
      'Colonna dichiarata che nello schema non esiste più: o è stata rinominata (e allora P3 ' +
        'sta guardando un nome morto), o non è mai esistita. In entrambi i casi il registro ' +
        'mente su cosa protegge.',
    ).toEqual([])
  })

  it('P4b · ogni valore dichiarato inventato è ancora nel suo file', () => {
    // Un\'eccezione che non corrisponde più a niente è un permesso lasciato aperto.
    const orfane = VALORI_INVENTATI.filter((v) => {
      const p = join(ROOT, v.file)
      return !existsSync(p) || !readFileSync(p, 'utf8').includes(v.valore)
    }).map((v) => `${v.file} → ${v.colonna} = ${JSON.stringify(v.valore)}`)
    expect(orfane, 'Eccezione senza più un riscontro: toglila.').toEqual([])
    for (const v of VALORI_INVENTATI) {
      expect(v.perche.length, `${v.file}/${v.colonna}: la ragione va scritta`).toBeGreaterThan(30)
    }
  })
})
