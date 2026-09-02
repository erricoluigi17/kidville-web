import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fileSorgente, riga } from '../fixtures/sorgente'
import { unitaDiQuery } from './nome-classe-con-sede.test'

/**
 * LOCK DI FORMA — l'identità di una classe è il suo UUID, non il suo nome.
 *
 * ─── IL GUASTO, MISURATO ────────────────────────────────────────────────────
 * `alunni` tiene la classe in due colonne: `section_id` (uuid, la FK vera) e
 * `classe_sezione` (testo). Il trigger `sync_alunno_section_id` va SOLO testo →
 * uuid, confrontando senza spazi né maiuscole: quindi il testo può divergere dal
 * nome della sezione MENTRE `section_id` resta giusto.
 *
 * L'area docente 0-6 cercava i bambini per testo. Il 2026-09-02, in produzione:
 *
 *   4 ANNI A  17 bambini, ne mostrava  0   (testo «4 anni  a», due spazi)
 *   4 ANNI B  19 bambini, ne mostrava  0
 *   3 ANNI B  14 bambini, ne mostrava  1   (testo «3 ANNI B », spazio finale)
 *   5 ANNI A  11 bambini, ne mostrava  1
 *   5 ANNI B  16 bambini, ne mostrava  4
 *
 * Il gate risolveva il nome e passava, quindi la risposta era **200 con `[]`**:
 * nessun errore, nessun log, schermata bianca. Le tre parziali sono le peggiori —
 * una classe vuota fa telefonare, una classe con un bambino su quattordici sembra
 * vera.
 *
 * ─── LA REGOLA ──────────────────────────────────────────────────────────────
 * Nessuna query su `alunni`, sotto `src/`, può selezionare i bambini filtrando
 * per `classe_sezione`. Si filtra per `section_id`, risolvendo il nome con
 * `risolviSezione`/`sezioniDiNome` (`src/lib/sezioni/risoluzione.ts`).
 *
 * Le eccezioni vivono in `AMMESSE`, ognuna con la sua ragione SCRITTA. Non è una
 * lista di comodo: una voce che non serve più fa fallire il test, così
 * l'allowlist si svuota man mano invece di marcire.
 *
 * ⚠️ Questo lock guarda soltanto la SELEZIONE DEI BAMBINI. Scrivere
 * `classe_sezione` (l'import, il riallineamento, la propagazione della rinomina)
 * è un'altra cosa e resta lecita: la colonna esiste ancora, e i destinatari dei
 * broadcast la usano per progetto. Il lock gemello che copre l'isolamento per
 * sede di quei filtri è `nome-classe-con-sede.test.ts`, da cui questo file
 * riusa il ritaglio delle catene invece di riscriverne una copia che divergerebbe.
 */

const SRC = path.join(process.cwd(), 'src')

/** Un filtro di SELEZIONE — non una `select` di colonne, non una scrittura. */
const FILTRO_CLASSE = /\.(?:eq|in|neq|not|filter|is|ilike|like)\s*\(\s*['"`](?:[A-Za-z_]+\.)?classe_sezione['"`]/g

/**
 * Query che selezionano bambini per NOME e possono restare, con la ragione.
 * Chiave: `<percorso relativo>:<tabella>`.
 */
const AMMESSE: Record<string, string> = {
  'src/app/api/admin/students/route.ts:alunni':
    'Filtro di SEGRETERIA, non di docente: il valore arriva da un menu a tendina ' +
    'popolato con i `classe_sezione` distinti degli alunni stessi, quindi è ' +
    'auto-consistente per costruzione — non può divergere da sé. Va comunque ' +
    'migrato quando la UI passerà a `section_id`.',
  'src/app/api/documenti-firmati/route.ts:alunni':
    'Come sopra: filtro di segreteria su un elenco costruito dagli stessi alunni.',
  'src/app/api/pagamenti/genera/route.ts:alunni':
    'Generazione rette per classe, scelta dalla segreteria su un elenco ' +
    'auto-consistente. Toccarla significa toccare la generazione dei pagamenti, ' +
    'che è un intervento a sé.',
  'src/app/api/chat/contacts/route.ts:alunni':
    'DEDUCE la classe dal `classe_sezione` di un bambino taggato e filtra sullo ' +
    'stesso valore: auto-consistente, le due letture cambiano insieme. Dedurre ' +
    'la classe dal tag di una foto è un difetto suo, diverso da questo.',
  'src/app/api/register/lessons/route.ts:registro_orario':
    'NON è una selezione di bambini: filtra `registro_orario.classe_sezione`, ' +
    'colonna DI QUELLA TABELLA, scritta canonicamente da `sections.name` nella ' +
    'stessa route. Migrarla vuol dire migrare `registro_orario` e la sua chiave ' +
    'di conflitto (`src/lib/registro/chiave-orario.ts`): intervento a sé. ' +
    'Il lock la vede perché guarda il NOME della colonna, non la tabella — ed è ' +
    'giusto così: restringerlo ad `alunni` gli farebbe perdere i filtri sulle ' +
    'risorse embedded (`presenze` → `alunni.classe_sezione`), che sono il caso vero.',
  'src/lib/notifiche/destinatari.ts:alunni':
    'Destinatari di un broadcast: `avvisi.target_classes` e ' +
    '`news_posts.target_classes` contengono NOMI per progetto (migrazione ' +
    '`20260801104252_avvisi_target_classes_nomi`), quindi il confronto per nome è ' +
    'la chiave giusta finché quelle colonne restano nomi.',
}

const FILES = fileSorgente(SRC)

/** Ogni filtro `classe_sezione` di selezione, con la query a cui appartiene. */
function filtriDiSelezione(src: string) {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  const unita = unitaDiQuery(senzaCommenti, struttura)
  const trovati: { riga: number; tabella: string }[] = []
  FILTRO_CLASSE.lastIndex = 0
  for (const m of senzaCommenti.matchAll(FILTRO_CLASSE)) {
    const u = unita.find((x) => x.tratti.some((t) => m.index >= t.a && m.index < t.b))
    trovati.push({ riga: riga(src, m.index), tabella: u?.tabella ?? '?' })
  }
  return trovati
}

const rel = (f: string) => path.relative(process.cwd(), f)

describe("lock di forma — l'identità di una classe è il suo uuid", () => {
  it('ci sono file da controllare (se cade, il test si sta autoingannando)', () => {
    expect(FILES.length).toBeGreaterThan(200)
  })

  it('il rilevatore trova davvero dei filtri (il lock non gira a vuoto)', () => {
    // Verde perché non trova violazioni ≠ verde perché non guarda più niente.
    // Se un domani il ritaglio delle catene si rompesse, questo conteggio cade
    // prima che il lock diventi una decorazione.
    const totale = FILES.reduce((n, f) => n + filtriDiSelezione(fs.readFileSync(f, 'utf8')).length, 0)
    expect(totale).toBeGreaterThanOrEqual(5)
  })

  it('nessuna query seleziona i bambini per NOME di classe senza una ragione scritta', () => {
    const colpevoli: string[] = []
    for (const f of FILES) {
      for (const t of filtriDiSelezione(fs.readFileSync(f, 'utf8'))) {
        // Il filtro può stare su `alunni` direttamente o su una risorsa
        // embedded (`presenze` → `alunni.classe_sezione`): in entrambi i casi
        // è una selezione di bambini per nome.
        if (AMMESSE[`${rel(f)}:${t.tabella}`]) continue
        colpevoli.push(`${rel(f)}:${t.riga} (query su \`${t.tabella}\`)`)
      }
    }
    expect(
      colpevoli,
      'Questa query seleziona i bambini per NOME di classe. `alunni.classe_sezione` è ' +
        'testo scritto dall\'import e può divergere da `sections.name` senza che niente lo ' +
        'dica: la risposta esce 200 con l\'elenco vuoto. Usa `risolviSezione` ' +
        '(src/lib/sezioni/risoluzione.ts) e filtra `section_id`. Se il nome è davvero la ' +
        'chiave giusta, dichiaralo in AMMESSE con la ragione.',
    ).toEqual([])
  })

  it("l'allowlist non contiene voci che non servono più", () => {
    // Una dichiarazione che sopravvive al suo motivo è un'allowlist che marcisce:
    // il giorno in cui una di queste route passa a `section_id`, la sua voce
    // qui deve sparire — e questo test lo pretende.
    const vive = new Set<string>()
    for (const f of FILES) {
      for (const t of filtriDiSelezione(fs.readFileSync(f, 'utf8'))) {
        vive.add(`${rel(f)}:${t.tabella}`)
      }
    }
    const morte = Object.keys(AMMESSE).filter((k) => !vive.has(k))
    expect(morte, 'Voce in AMMESSE senza più un filtro che la giustifichi: va tolta.').toEqual([])
  })
})
