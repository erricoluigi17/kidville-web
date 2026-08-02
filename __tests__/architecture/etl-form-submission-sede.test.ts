import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK — la sede dell'ETL d'iscrizione viene dal DATO, mai da un ordinamento
//
// `public.fn_form_submission_etl()` è il trigger `SECURITY DEFINER` che, quando
// un modulo d'iscrizione passa a `status='completed'`, riversa il payload nelle
// anagrafiche `alunni`/`parents`/`student_parents`. È l'unico punto in cui il
// dato di un minore viene scritto DOPO che il gate applicativo ha finito il suo
// lavoro: l'audit del 30/07 ha verificato 59 route una per una, ma un trigger
// non è una route.
//
// IL DIFETTO (R92, ricognizione del 2026-07-31). La riga era:
//
//     SELECT id INTO c_scuola_id FROM public.schools ORDER BY id LIMIT 1;
//
// con il commento «mono-sede in prod». Dal 2026-07-29 le sedi sono tre, e
// quell'ordinamento restituisce `04accbfd-…` = Kidville Cesa: OGNI minore
// iscritto sarebbe nato a Cesa, qualunque plesso avesse scelto la famiglia —
// mentre `form_submissions.scuola_id`, risolto e scritto dalla route, veniva
// ignorato. Un uuid cablato travestito da query: nessun test lo vedeva, perché
// la funzione non fallisce, archivia solo nel posto sbagliato.
//
// LE REGOLE CHE QUESTO LOCK TIENE FERME.
//  1. La sede si legge da `NEW.scuola_id` (il dato la porta con sé).
//  2. Se manca, si NEGA: `RAISE EXCEPTION`, non un ripiego. Un'anagrafica di
//     minore archiviata nel plesso sbagliato è peggio di un errore visibile.
//  3. La deduplica dell'alunno è vincolata alla sede risolta: senza, un'omonimia
//     (o un CF già presente altrove) fa fare `UPDATE` sul minore di un'ALTRA
//     sede — il caso peggiore, perché tocca note mediche e sezione.
//  4. Nessuna migrazione NUOVA deduce una sede da `FROM schools … ORDER BY …
//     LIMIT 1`: è la forma esatta del difetto, e va riconosciuta ovunque.
//
// Le migrazioni sono immutabili: quelle storiche che contengono la definizione
// difettosa restano come sono e stanno in allowlist. Vale la definizione
// VIGENTE, cioè l'ultima in ordine di timestamp.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')
const FUNZIONE = 'fn_form_submission_etl'

/**
 * «La sede me la scelgo io»: una sede dedotta da un ordinamento di righe.
 * Niente flag `s`: `[^;]` comprende già gli a capo, e il target di compilazione
 * del repo non ammette `dotAll`.
 */
const SEDE_DA_ORDINAMENTO =
  /FROM\s+(?:public\.)?(?:schools|scuole)\b[^;]{0,200}?ORDER\s+BY[^;]{0,120}?LIMIT\s+1/i

/**
 * Migrazioni GIÀ APPLICATE che contengono la deduzione difettosa. Sono storia e
 * non si riscrivono. NON aggiungere qui una migrazione nuova: la sede si prende
 * dal dato (`NEW.scuola_id`, la sezione, l'alunno), mai da un `ORDER BY`.
 */
const STORICHE_CON_IL_DIFETTO = new Set<string>([
  // Sostituiva l'uuid cablato '11111111-…' (sede inesistente) con l'ordinamento:
  // corretta allora, diventata il difetto il 2026-07-29 con la seconda sede.
  '20260706210352_db_hardening_etl_scuola_e_revoke_exec.sql',
])

/**
 * Il codice, senza i commenti. Una migrazione che CITA il difetto per spiegarlo
 * («la riga era: SELECT id … ORDER BY id LIMIT 1») non lo contiene: documentarlo
 * è il modo in cui non torna. Approssimazione consapevole: `--` dentro un
 * letterale stringa verrebbe tagliato, ma in queste migrazioni non ce ne sono.
 */
function soloCodice(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((r) => r.replace(/--.*$/, ''))
    .join('\n')
}

const file = readdirSync(MIGRAZIONI)
  .filter((f) => f.endsWith('.sql'))
  .sort()

/** I file che (ri)definiscono il trigger ETL, in ordine di applicazione. */
const definizioni = file.filter((f) =>
  new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${FUNZIONE}\\b`, 'i').test(
    readFileSync(join(MIGRAZIONI, f), 'utf8'),
  ),
)

/**
 * Il corpo dell'ULTIMA definizione: è quella che gira davvero. Restituito senza
 * commenti, così le asserzioni guardano ciò che il database esegue — un commento
 * che dice «la sede viene da NEW.scuola_id» non farebbe passare niente.
 */
function corpoVigente(): { file: string; sql: string } {
  const ultimo = definizioni[definizioni.length - 1]
  const testo = soloCodice(readFileSync(join(MIGRAZIONI, ultimo), 'utf8'))
  const inizio = testo.search(
    new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${FUNZIONE}\\b`, 'i'),
  )
  const fine = testo.indexOf('$$;', inizio)
  return { file: ultimo, sql: fine > inizio ? testo.slice(inizio, fine) : testo.slice(inizio) }
}

describe('lock architettura · ETL iscrizione, la sede viene dal dato', () => {
  it('esiste almeno una migrazione che definisce il trigger ETL (sanity)', () => {
    expect(definizioni.length).toBeGreaterThan(0)
  })

  it('la definizione vigente prende la sede da NEW.scuola_id', () => {
    const { file: f, sql } = corpoVigente()
    expect(
      /c_scuola_id\s*:=\s*NEW\.scuola_id/i.test(sql),
      `${f}: la sede dell'ETL non viene da NEW.scuola_id. Il dato la porta con sé — ` +
        `la route l'ha risolta e scritta su form_submissions.scuola_id: dedurla di nuovo ` +
        `significa contraddire chi la sapeva.`,
    ).toBe(true)
  })

  it('la definizione vigente NON deduce la sede da un ordinamento di schools', () => {
    const { file: f, sql } = corpoVigente()
    expect(
      SEDE_DA_ORDINAMENTO.test(sql),
      `${f}: la sede è dedotta con «FROM schools … ORDER BY … LIMIT 1». È un uuid cablato ` +
        `travestito da query: in produzione restituisce Kidville Cesa, e ogni minore iscritto ` +
        `nascerebbe lì qualunque plesso abbia scelto la famiglia.`,
    ).toBe(false)
  })

  it('la definizione vigente NEGA quando la sede manca, invece di inventarla', () => {
    const { file: f, sql } = corpoVigente()
    const ramo = /c_scuola_id\s+IS\s+NULL\s+THEN[\s\S]{0,600}?RAISE\s+EXCEPTION/i
    expect(
      ramo.test(sql),
      `${f}: senza sede l'ETL deve sollevare, non proseguire. Scope vuoto ⇒ nega: ` +
        `un'anagrafica di minore archiviata nel plesso sbagliato è peggio di un errore visibile.`,
    ).toBe(true)
  })

  it('la deduplica dell alunno è vincolata alla sede risolta', () => {
    const { file: f, sql } = corpoVigente()
    const vincoli = sql.match(/scuola_id\s*=\s*c_scuola_id/gi) ?? []
    expect(
      vincoli.length,
      `${f}: le due ricerche di un alunno già esistente (per codice fiscale e per ` +
        `nome+cognome+data di nascita) devono filtrare per sede. Senza, un'omonimia fra plessi ` +
        `fa eseguire UPDATE su sezione e note mediche del minore di un'ALTRA sede.`,
    ).toBeGreaterThanOrEqual(2)
  })

  for (const f of file) {
    if (STORICHE_CON_IL_DIFETTO.has(f)) continue
    it(`${f} non deduce una sede da un ordinamento di righe`, () => {
      const sql = soloCodice(readFileSync(join(MIGRAZIONI, f), 'utf8'))
      expect(
        SEDE_DA_ORDINAMENTO.test(sql),
        `${f} contiene «FROM schools/scuole … ORDER BY … LIMIT 1». La sede si riceve ` +
          `(parametro, colonna del dato) o si deriva dall'oggetto (sezione, alunno): un ordinamento ` +
          `di uuid non è una risoluzione, è una scelta arbitraria che nessuno rilegge.`,
      ).toBe(false)
    })
  }
})
