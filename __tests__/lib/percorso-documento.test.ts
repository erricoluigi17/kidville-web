import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COLONNE_DOCUMENTO,
  DOC_PREFISSO,
  DOC_MAX_LUNGHEZZA,
  DOC_ESTENSIONI,
  formaDocumentoAmmessa,
  percorsoDocumentoAmmesso,
} from '@/lib/personale/percorso-documento'
import { PERSONALE_FIELDS } from '@/lib/forms/personale-template'
import {
  ESTENSIONI_ALLEGATO_PUBBLICO,
  MIME_ALLEGATO_PUBBLICO,
  estensioneArchiviata,
} from '@/lib/upload/allegati-pubblici'

// =============================================================================
// LA FORMA DI UN PERCORSO DI DOCUMENTO, E L'ELENCO DELLE COLONNE CHE NE TENGONO UNO.
//
// ── QUESTA SUITE, DA SOLA, NON DIMOSTRA CHE IL GATE GIRI ─────────────────────
//
// Va detto qui, in cima, perché è la lezione pagata il 12/08/2026: fino a quel
// giorno queste prove erano diciotto e tutte verdi su una funzione che NESSUNO
// chiamava più. Il campo del template si era chiamato `documento_path` fino
// all'11/08 e la rotta pubblica leggeva ancora quel nome, che dopo il fronte/retro
// non esisteva più: `percorsoDocumentoAmmesso` riceveva sempre `null` e il ramo di
// rifiuto non entrava mai. Forzata la funzione a `return true` — cioè con la porta
// spalancata a `documenti/../../etc/passwd` — il file di test del suo chiamante dava
// gli stessi identici numeri.
//
// Perciò: la prova che il gate GIRA non sta qui, sta in
// `__tests__/api/personale-post-forma-documento.test.ts`, che passa dalla rotta vera
// e diventa rosso se il chiamante smette di chiamare. Questa suite prova soltanto
// che, QUANDO viene chiamata, la funzione respinge ciò che deve respingere.
//
// ── PERCHÉ IL RIFIUTO DI QUESTA FUNZIONE VALE ────────────────────────────────
//
// Il valore arriva da un ANONIMO (il modulo pubblico non ha login) e diventa la
// chiave con cui la Segreteria si fa firmare un oggetto dello Storage: la fotografia
// della carta d'identità di una dipendente. Ogni rifiuto qui sotto si misura ACCANTO
// al suo controllo positivo — senza, una funzione che rispondesse `false` a qualunque
// cosa passerebbe l'intera suite: verde, e con la porta chiusa anche a chi ha
// compilato il modulo per davvero.
// =============================================================================

/** Due uuid v4 in minuscolo, come li scrive `crypto.randomUUID()` sul server. */
const UUID_CARTELLA = '0f2b1c4e-9a3d-4f61-8b2c-7d5e6a1b0c9d'
const UUID_OGGETTO = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

/** La forma canonica: esattamente ciò che `iscrizione/personale/upload:POST` produce. */
const canonico = (ext = 'pdf'): string => `${DOC_PREFISSO}${UUID_CARTELLA}/${UUID_OGGETTO}.${ext}`

/** Tutte le migrazioni, lette una volta sola: sono la fonte dei vincoli del database. */
const CARTELLA_MIGRAZIONI = join(process.cwd(), 'supabase/migrations')
const MIGRAZIONI = readdirSync(CARTELLA_MIGRAZIONI)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => ({ file: f, sql: readFileSync(join(CARTELLA_MIGRAZIONI, f), 'utf8') }))

/**
 * Il controllo positivo e il rifiuto nella STESSA asserzione.
 *
 * `motivo` finisce nel messaggio di errore perché un rosso su questa suite deve dire
 * da solo quale difesa è caduta: chi lo legge sta guardando un gate di sicurezza, non
 * un test di formato.
 */
function rifiutato(percorso: string, motivo: string): void {
  expect(
    percorsoDocumentoAmmesso(canonico()),
    'il controllo positivo è caduto: la funzione respinge ANCHE la forma canonica, ' +
      'quindi i rifiuti qui sotto non dimostrano niente',
  ).toBe(true)
  expect(percorsoDocumentoAmmesso(percorso), motivo).toBe(false)
}

/**
 * Rifiutato DALLA FORMA, non dall'elenco delle estensioni — e la differenza è stata misurata.
 *
 * Togliendo l'àncora `$` da `DOC_FORMA` (mutazione provata il 12/08/2026) quasi tutti i
 * rifiuti restavano verdi: `documenti/…/….pdf,x` cadeva comunque, ma per il controllo
 * dell'estensione (`pdf,x` non è in elenco), non per la forma. UNO solo diventava verde ed
 * era il peggiore — `….pdf,documento_retro_path.eq.documenti/…/….jpg`, che finisce con
 * un'estensione LEGITTIMA. Cioè: la suite dichiarava difesa una regola che aveva smesso di
 * difendere, tranne che nel caso che conta.
 *
 * Perciò, dove il difetto è la forma, si misura la forma: `formaDocumentoAmmessa` deve dire
 * `false` di suo, prima e indipendentemente dall'elenco delle estensioni. È l'unica ragione
 * per cui quel predicato è esportato, ed è scritta anche nel modulo accanto all'export.
 */
function rifiutatoDallaForma(percorso: string, motivo: string): void {
  rifiutato(percorso, motivo)
  expect(formaDocumentoAmmessa(percorso), `${motivo} — e la FORMA da sola lo lascia passare`).toBe(
    false,
  )
}

describe('COLONNE_DOCUMENTO — quali colonne tengono un percorso di documento', () => {
  it('sono i campi `file` del template, letti per TIPO e non per nome', () => {
    // ⚠️ È LA LETTURA CHE IL RINOMINO NON ROMPE, e il rinomino è già successo:
    // `documento_path` → `documento_fronte_path` + `documento_retro_path`
    // (migrazione `20260812194501`). Un elenco ribattuto a mano — o un
    // `find(f => f.id === 'documento_path')` — sopravvive al rinomino restituendo
    // il nome VECCHIO, e da lì in poi ogni gate interroga una colonna che il
    // database non ha più. Non è un'ipotesi: è ciò che ha lasciato la Segreteria
    // senza poter aprire nessun documento d'identità per mezza giornata.
    const dalTemplate = PERSONALE_FIELDS.filter((c) => c.type === 'file').map((c) => c.id)
    expect([...COLONNE_DOCUMENTO]).toEqual(dalTemplate)
    expect(COLONNE_DOCUMENTO.length, 'nessun campo documento: ogni gate girerebbe a vuoto').toBeGreaterThan(0)
  })

  it('in questo repo l’id del campo È il nome della colonna, e il `db_mapping` lo dice', () => {
    // Da questa uguaglianza dipende tutto il resto: i gate usano `COLONNE_DOCUMENTO`
    // come nomi di COLONNA. Se un domani un id smettesse di coincidere con la sua
    // colonna, le query andrebbero a cercare un nome che non esiste — 42703, e
    // fail-closed, cioè nessuna scansione più firmabile.
    for (const campo of COLONNE_DOCUMENTO) {
      const mapping = PERSONALE_FIELDS.find((c) => c.id === campo)?.db_mapping ?? ''
      expect(mapping, `il campo «${campo}» non dichiara nessuna colonna`).not.toBe('')
      expect(String(mapping).split('.').pop(), `«${campo}» è mappato su una colonna con un altro nome`).toBe(campo)
    }
  })

  it('nessuna migrazione ha RINOMINATO VIA una di queste colonne', () => {
    // IL LOCK CHE SAREBBE SERVITO. Una `rename column X to Y` è retrocompatibile
    // per il database e devastante per il codice: la vecchia colonna sparisce nel
    // silenzio, e ogni `.eq('X', …)` diventa un 42703 che, su un gate fail-closed,
    // si legge come «questo documento non è tuo». Se domani qualcuno rinomina una
    // di queste colonne senza aggiornare il template, questo test è rosso PRIMA
    // del deploy.
    for (const campo of COLONNE_DOCUMENTO) {
      const rinominata = MIGRAZIONI.filter((m) =>
        new RegExp(`rename\\s+column\\s+${campo}\\s+to\\b`, 'i').test(m.sql),
      ).map((m) => m.file)
      expect(rinominata, `«${campo}» è stata rinominata da una migrazione, ma il template la nomina ancora`).toEqual([])
    }
  })

  it('ogni colonna del documento ha in migrazione il suo CHECK di lunghezza, e non è più stretto dell’applicazione', () => {
    // Se l'applicazione ammettesse più caratteri della colonna, il rifiuto arriverebbe
    // dal database come 500 opaco invece che sotto il campo. Il vincolo si legge dalle
    // migrazioni, colonna per colonna: così un campo nuovo senza CHECK si vede subito.
    for (const campo of COLONNE_DOCUMENTO) {
      const limiti = MIGRAZIONI.flatMap((m) => [
        ...m.sql.matchAll(new RegExp(`length\\(${campo}\\)\\s*<=\\s*(\\d+)`, 'g')),
      ]).map((m) => Number(m[1]))

      expect(limiti.length, `nessun CHECK di lunghezza in migrazione per «${campo}»`).toBeGreaterThan(0)
      for (const limite of limiti) {
        expect(
          DOC_MAX_LUNGHEZZA,
          `su «${campo}» il database taglia a ${limite}, l’applicazione a ${DOC_MAX_LUNGHEZZA}`,
        ).toBeLessThanOrEqual(limite)
      }
    }
  })
})

describe('percorsoDocumentoAmmesso — la forma che la rotta di caricamento produce', () => {
  it('accetta la forma canonica per OGNI estensione ammessa', () => {
    for (const ext of ESTENSIONI_ALLEGATO_PUBBLICO) {
      expect(percorsoDocumentoAmmesso(canonico(ext)), `estensione «${ext}» respinta`).toBe(true)
    }
  })

  it('l’elenco delle estensioni è quello del gate pubblico, non una lista sua', () => {
    // Il confronto è con la FONTE (`ESTENSIONI_ALLEGATO_PUBBLICO`), non con una
    // stringa ribattuta qui. È anche il lock che regge il RINOMINO del campo del
    // template: se la lettura del template smettesse di trovare i campi `file`,
    // questa lista arriverebbe vuota e `percorsoDocumentoAmmesso` respingerebbe
    // TUTTO — cioè il modulo pubblico si chiuderebbe in silenzio.
    expect([...DOC_ESTENSIONI].sort()).toEqual([...ESTENSIONI_ALLEGATO_PUBBLICO].sort())
    expect(DOC_ESTENSIONI.length, 'elenco vuoto: nessun percorso sarebbe più ammesso').toBeGreaterThan(0)
  })

  it('accetta ciò che la rotta di caricamento archivia DAVVERO, tipo per tipo', () => {
    // Le due estremità della stessa catena: `estensioneArchiviata` decide con che
    // estensione l'oggetto resta nel bucket, questo gate decide se quel percorso è
    // dichiarabile. Se divergessero — `jpeg` di là, solo `jpg` di qua — il file
    // sarebbe caricato per davvero e il modulo rifiuterebbe il percorso del PROPRIO
    // allegato, su una porta pubblica, senza che nessun test delle due parti se ne
    // accorga. Il difetto è possibile solo guardandole insieme, cioè qui.
    for (const mime of MIME_ALLEGATO_PUBBLICO) {
      const ext = estensioneArchiviata(mime)
      expect(ext, `«${mime}» non produce nessuna estensione`).toBeTruthy()
      expect(
        percorsoDocumentoAmmesso(canonico(ext ?? '')),
        `un file «${mime}» viene archiviato come «.${ext}», e questo gate lo respinge`,
      ).toBe(true)
    }
  })
})

describe('percorsoDocumentoAmmesso — i caratteri che riscrivono un filtro PostgREST', () => {
  it('la VIRGOLA è rifiutata: in `.or(…)` separa le condizioni', () => {
    rifiutatoDallaForma(`${canonico()},x`, 'una virgola nel valore aggiunge una condizione al filtro')
  })

  it('il payload che ruberebbe il documento di un’altra sede è rifiutato', () => {
    // Il caso concreto, scritto per esteso perché non resti un'ipotesi: dentro un
    // `.or('documento_fronte_path.eq.<X>,documento_retro_path.eq.<X>')` questo valore
    // aggiungerebbe una condizione invece di essere confrontato. Oggi in questo repo
    // nessun gate scrive un `.or(…)` — si interroga una colonna per volta con `.eq()`,
    // che percent-encoda la virgola — ma la forma si valida comunque PRIMA, perché è
    // il giorno in cui qualcuno passerà al filtro composto che questa riga difende.
    rifiutatoDallaForma(
      `${canonico()},documento_retro_path.eq.${canonico('jpg')}`,
      'il filtro `.or(…)` si lascia riscrivere da questo valore',
    )
  })

  it('le PARENTESI sono rifiutate: in PostgREST raggruppano', () => {
    rifiutatoDallaForma(`${canonico()})`, 'una parentesi chiude il gruppo del filtro')
    rifiutatoDallaForma(`(${canonico()}`, 'una parentesi apre un gruppo nel filtro')
    rifiutatoDallaForma(`documenti/or(id.gt.0)/${UUID_OGGETTO}.pdf`, 'un gruppo intero infilato nel percorso')
  })

  it('gli APICI sono rifiutati, singoli e doppi', () => {
    rifiutatoDallaForma(`${canonico()}'`, 'un apice singolo chiude una stringa quotata')
    rifiutatoDallaForma(`${canonico()}"`, 'un apice doppio chiude un valore quotato di PostgREST')
    rifiutatoDallaForma(`documenti/"${UUID_CARTELLA}"/${UUID_OGGETTO}.pdf`, 'segmento quotato')
  })

  it('gli SPAZI sono rifiutati, compresi quelli invisibili di fine riga', () => {
    rifiutatoDallaForma(`${canonico()} `, 'uno spazio in coda')
    rifiutatoDallaForma(` ${canonico()}`, 'uno spazio in testa')
    rifiutatoDallaForma(`documenti/${UUID_CARTELLA}/${UUID_OGGETTO}.p df`, 'uno spazio dentro l’estensione')
    rifiutatoDallaForma(`${canonico()}\t`, 'una tabulazione in coda')
    // ⚠️ IL FINE RIGA HA UNA STORIA. In JavaScript `$` senza il flag `m` àncora alla
    // fine dell'INPUT (misurato: `/^a$/.test('a\n') === false`), a differenza di Perl
    // e Python dove `$` accetta un a capo finale. Il giorno in cui qualcuno
    // aggiungesse il flag `m` alla regex della forma — per un motivo qualunque —
    // questa riga diventerebbe rossa. Senza, la regressione sarebbe invisibile.
    rifiutatoDallaForma(`${canonico()}\n`, 'un a capo in coda')
    rifiutatoDallaForma(`${canonico()}\nqualsiasi.cosa`, 'una seconda riga dopo un percorso valido')
  })

  it('il PUNTO E VIRGOLA e gli altri metacaratteri non passano', () => {
    for (const metacarattere of [';', '&', '|', '=', '*', '%', '#', '?', '<', '>', '\\', '`', '$', '{', '}', '[', ']']) {
      rifiutatoDallaForma(`${canonico()}${metacarattere}`, `il metacarattere «${metacarattere}» è passato`)
    }
  })
})

describe('percorsoDocumentoAmmesso — il percorso che punta altrove', () => {
  it('`..` è rifiutato ovunque compaia', () => {
    rifiutatoDallaForma('documenti/../../etc/passwd', 'traversal esplicito')
    rifiutatoDallaForma(`documenti/${UUID_CARTELLA}/../${UUID_OGGETTO}.pdf`, 'traversal in mezzo ai due uuid')
    rifiutatoDallaForma(`documenti/${UUID_CARTELLA}/${UUID_OGGETTO}..pdf`, 'doppio punto prima dell’estensione')
    rifiutatoDallaForma(`${canonico()}/..`, 'traversal in coda')
  })

  it('un PREFISSO diverso è rifiutato, anche quando è un bucket vero del repo', () => {
    // `candidature/` è il prefisso della porta gemella (`iscrizione/insegnanti`) e
    // `form_attachments` è il bucket dei documenti dei MINORI: sono esattamente i
    // percorsi che non devono poter entrare da qui.
    rifiutatoDallaForma(`candidature/${UUID_CARTELLA}/${UUID_OGGETTO}.pdf`, 'prefisso della porta gemella')
    rifiutatoDallaForma(`form_attachments/${UUID_CARTELLA}/${UUID_OGGETTO}.pdf`, 'bucket dei minori')
    rifiutatoDallaForma(`${UUID_CARTELLA}/${UUID_OGGETTO}.pdf`, 'nessun prefisso')
    rifiutatoDallaForma(`/${canonico()}`, 'percorso assoluto')
    rifiutatoDallaForma(`documenti//${UUID_CARTELLA}/${UUID_OGGETTO}.pdf`, 'doppia barra dopo il prefisso')
    rifiutatoDallaForma(`Documenti/${UUID_CARTELLA}/${UUID_OGGETTO}.pdf`, 'prefisso con la maiuscola')
    rifiutatoDallaForma(`altro/${canonico()}`, 'il prefisso giusto ma non in testa')
  })

  it('la forma a DUE uuid non si negozia', () => {
    rifiutatoDallaForma(`documenti/${UUID_OGGETTO}.pdf`, 'un solo uuid')
    rifiutatoDallaForma(`documenti/${UUID_CARTELLA}/${UUID_OGGETTO}/${UUID_OGGETTO}.pdf`, 'un segmento in più')
    rifiutatoDallaForma(`documenti/${UUID_CARTELLA.slice(0, 30)}/${UUID_OGGETTO}.pdf`, 'uuid troncato')
    rifiutatoDallaForma(`documenti/${UUID_CARTELLA.toUpperCase()}/${UUID_OGGETTO}.pdf`, 'uuid in maiuscolo')
    rifiutatoDallaForma(`documenti/${UUID_CARTELLA}/${UUID_OGGETTO}`, 'senza estensione')
    rifiutatoDallaForma('', 'stringa vuota')
    rifiutatoDallaForma(DOC_PREFISSO, 'il solo prefisso')
  })
})

describe('percorsoDocumentoAmmesso — la lunghezza e l’estensione', () => {
  it('il percorso PIÙ LUNGO che questo gate ammette sta sotto il tetto della colonna', () => {
    // ⚠️ QUI NON C'È NESSUN CONTROLLO DI LUNGHEZZA DA MISURARE, e il perché è la
    // correzione del 12/08/2026: `if (percorso.length > DOC_MAX_LUNGHEZZA)` era un
    // ramo IRRAGGIUNGIBILE (mutazione provata: rimosso, suite verde 18/18). Un
    // percorso che passa la forma è lungo 10+36+1+36+1 = 84 più l'estensione, e per
    // superare 200 servirebbe un'estensione di 117 caratteri, che in
    // `DOC_ESTENSIONI` non c'è né ci può stare.
    //
    // Il tetto non si controlla: si DIMOSTRA. Questa misura resta l'unica cosa che
    // lega la forma al CHECK della colonna, e diventa rossa il giorno in cui la forma
    // si allargasse (più segmenti) o l'elenco delle estensioni ne guadagnasse una
    // lunghissima — cioè esattamente quando il ramo, se ci fosse, servirebbe.
    const piuLunga = [...DOC_ESTENSIONI].sort((a, b) => b.length - a.length)[0]
    const piuLungo = canonico(piuLunga)
    expect(percorsoDocumentoAmmesso(piuLungo), `l’estensione più lunga («${piuLunga}») è respinta`).toBe(true)
    expect(
      piuLungo.length,
      `il percorso più lungo ammesso è ${piuLungo.length} caratteri e la colonna ne tiene ${DOC_MAX_LUNGHEZZA}`,
    ).toBeLessThanOrEqual(DOC_MAX_LUNGHEZZA)
  })

  it('una coda lunghissima è rifiutata — dalla FORMA, che è la difesa che agisce davvero', () => {
    rifiutato(`documenti/${UUID_CARTELLA}/${UUID_OGGETTO}.${'a'.repeat(DOC_MAX_LUNGHEZZA)}`, 'estensione lunghissima')
    rifiutatoDallaForma(`${canonico()}${'/x'.repeat(DOC_MAX_LUNGHEZZA)}`, 'coda lunghissima')
  })

  it('un’estensione FUORI elenco è rifiutata anche con la forma giusta', () => {
    // È il caso più insidioso: forma perfetta, due uuid veri, prefisso giusto — e un
    // eseguibile. La forma da sola non basta mai.
    for (const ext of ['exe', 'html', 'svg', 'php', 'js', 'bin', 'zip']) {
      rifiutato(canonico(ext), `l’estensione «${ext}» è passata`)
    }
  })

  it('l’estensione in MAIUSCOLO resta ammessa (normalizzata), ed è una scelta', () => {
    // Non è una svista dell'estrazione: era già il comportamento della rotta pubblica
    // e resta identico. Chi vorrà stringerlo lo farà come decisione, con questa riga
    // davanti — non scoprendo per caso che una pratica vera veniva respinta.
    expect(percorsoDocumentoAmmesso(canonico('PDF'))).toBe(true)
    expect(percorsoDocumentoAmmesso(canonico('JpG'))).toBe(true)
  })
})

describe('formaDocumentoAmmessa — il predicato non ha memoria fra due chiamate', () => {
  it('lo stesso percorso vale lo stesso, chiamata dopo chiamata', () => {
    // ⚠️ SI MISURA IL COMPORTAMENTO, NON I FLAG DELLA REGEX, e la differenza conta:
    // una regex con `g` o `y` è STATEFUL (`lastIndex` sopravvive fra due `.test()`),
    // quindi lo stesso percorso valido risulterebbe valido, poi non valido, poi
    // valido. Su un gate di sicurezza è un difetto che si manifesta una richiesta su
    // due — e leggerlo dai flag lo proverebbe solo per la regex di oggi, mentre così
    // vale per qualunque implementazione futura.
    for (let giro = 0; giro < 3; giro++) {
      expect(formaDocumentoAmmessa(canonico()), `giro ${giro}: la forma canonica è stata respinta`).toBe(true)
      expect(percorsoDocumentoAmmesso(canonico()), `giro ${giro}: il gate ha respinto la forma canonica`).toBe(true)
    }
  })
})
