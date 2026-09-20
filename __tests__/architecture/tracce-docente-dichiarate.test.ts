import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sogliaFotografia, posterioriCheContengono, senzaCommenti } from './soglia-fotografia'
import { creaFintoSupabase } from '../fixtures/finto-supabase'
import type { DBFinto } from '../fixtures/finto-supabase'
import {
  TRACCE_DOCENTE,
  VOCI_CHE_PESANO,
  contaTracceDocente,
  decisioneEliminazione,
} from '@/lib/personale/tracce-docente'

/**
 * LOCK · il registro delle tracce di un docente deve coincidere con le CHIAVI
 * ESTERNE VERE, e l'anteprima deve dire ciò che l'esecuzione farà.
 *
 * ─── PERCHÉ ESISTE ────────────────────────────────────────────────────────────
 *
 * `src/lib/personale/tracce-docente-voci.ts` decide se un docente si CANCELLA o si
 * ARCHIVIA leggendo un registro scritto a mano. Un registro scritto a mano invecchia
 * in silenzio, e qui il silenzio costa: `utenti.id` è FK verso `auth.users(id)` con
 * `ON DELETE CASCADE`, quindi una tabella nuova con una FK `CASCADE` verso `utenti`
 * verrebbe SVUOTATA da una cancellazione **senza un errore**, e senza che nessuna
 * riga del registro l'avesse mai nominata.
 *
 * ⚠️ E LA `ON DELETE` CONTA QUANTO L'ESISTENZA DELLA CHIAVE. Oggi
 * `eventi_diario.maestra_id` è `NO ACTION`: blocca la cancellazione, rumorosamente e
 * senza danni. Una migrazione che la portasse a `CASCADE` per comodità
 * trasformerebbe quello stesso caso in «la cancellazione riesce e porta via il
 * diario». È la metà del problema che non si vede, ed è il motivo per cui la
 * fotografia porta `azione` e questo lock la confronta.
 *
 * ─── COME FUNZIONA ────────────────────────────────────────────────────────────
 * Gira OFFLINE. In CI il database di produzione non c'è — e non deve esserci. La
 * verità del database è versionata in `__tests__/fixtures/fk-utenti-snapshot.json`,
 * che si rigenera SOLO da una query su produzione (`fk-utenti-fotografia.mjs`), porta
 * un `sha256` del contenuto normalizzato — così non la si può addomesticare a mano —
 * e un `generato_alle` per non restare verde mentre non sa più niente.
 *
 * ⚠️ RIGENERARE LA FOTOGRAFIA **ARMA** IL LOCK, NON LO SPEGNE: è l'unico momento in
 * cui qualcuno guarda davvero se il registro e il database dicono la stessa cosa.
 *
 * ─── PROVA PER ROTTURA ────────────────────────────────────────────────────────
 * Eseguita il 2026-09-20, una mutazione alla volta su file ripristinati da copia
 * pulita. Un lock che nessuno ha mai visto rosso non è un lock:
 *   • tolta la voce `eventi_diario` dal registro          → 2 test rossi
 *   • dichiarato `avvisi.author_id` come `blocca`          → 1 test rosso
 *   • ritoccata la fotografia a mano (una `azione`)        → 2 test rossi
 *   • fatta inghiottire alla sonda l'errore PostgREST      → 1 test rosso
 *   • tolto `.eq(colonna, utenteId)` dalla sonda           → 1 test rosso
 *
 * L'ultima è la ragione per cui esiste il controllo negativo «la traccia di UN
 * ALTRO docente non conta»: senza, una sonda senza filtro troverebbe le righe
 * dell'intera scuola e direbbe «archivia» su chiunque — restando verde in tutti
 * gli altri casi, perché «archivia» è l'esito che gli altri test si aspettano.
 */

type Foto = {
  generato_il: string
  generato_alle?: string | null
  sha256: string
  fk: { tabella: string; colonna: string; azione: string }[]
}

const PERCORSO_FOTO = join(process.cwd(), '__tests__', 'fixtures', 'fk-utenti-snapshot.json')
const foto = JSON.parse(readFileSync(PERCORSO_FOTO, 'utf8')) as Foto
const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

const chiave = (r: { tabella: string; colonna: string }) => `${r.tabella}.${r.colonna}`

describe('la fotografia è autentica', () => {
  it("porta l'impronta del proprio contenuto, e non è stata ritoccata a mano", () => {
    // Stessa normalizzazione del generatore: ordine stabile, campi in ordine fisso.
    const normalizzata = {
      fk: foto.fk
        .map((r) => ({
          tabella: String(r.tabella),
          colonna: String(r.colonna),
          azione: String(r.azione),
        }))
        .sort((a, b) => a.tabella.localeCompare(b.tabella) || a.colonna.localeCompare(b.colonna)),
    }
    const atteso = createHash('sha256').update(JSON.stringify(normalizzata)).digest('hex')
    expect(
      foto.sha256,
      'La fotografia non corrisponde al proprio sha256: è stata modificata a mano. ' +
        'Rigenerala con `node __tests__/fixtures/fk-utenti-fotografia.mjs`.',
    ).toBe(atteso)
  })

  it('dichiara quando è stata scattata', () => {
    expect(foto.generato_alle, 'manca `generato_alle`: rigenera la fotografia').toBeTruthy()
    expect(sogliaFotografia(foto)).toMatch(/^\d{14}$/)
  })
})

describe('il registro copre le chiavi esterne vere', () => {
  it('ogni FK verso utenti(id) è CENSITA nel registro', () => {
    const dichiarate = new Set(TRACCE_DOCENTE.map(chiave))
    const mancanti = foto.fk.filter((r) => !dichiarate.has(chiave(r))).map(chiave)
    expect(
      mancanti,
      'Chiavi esterne verso `utenti(id)` che il registro non nomina. Aggiungile a ' +
        'TRACCE_DOCENTE dicendo se PESANO (con una `chiave` i18n) o no (con un `perche`). ' +
        "Finché restano fuori, l'anteprima può dire «si cancella» su un docente che non si cancella.",
    ).toEqual([])
  })

  it('il registro non INVENTA chiavi che il database non ha', () => {
    const vere = new Set(foto.fk.map(chiave))
    const inventate = TRACCE_DOCENTE.filter((v) => !vere.has(chiave(v))).map(chiave)
    expect(
      inventate,
      'Voci del registro senza una FK corrispondente in produzione: una sonda su una ' +
        'colonna che non esiste degrada a «schema assente» e conta ZERO in silenzio.',
    ).toEqual([])
  })

  it("l'ON DELETE dichiarata coincide con quella del database, voce per voce", () => {
    const vera = new Map(foto.fk.map((r) => [chiave(r), r.azione]))
    const divergenti = TRACCE_DOCENTE.filter((v) => vera.get(chiave(v)) !== v.azioneFk).map(
      (v) => `${chiave(v)}: registro «${v.azioneFk}», database «${vera.get(chiave(v))}»`,
    )
    expect(
      divergenti,
      "Una `ON DELETE` cambiata sotto i piedi del registro. Se è passata a `cascade`, " +
        'quella riga ora viene DISTRUTTA da una cancellazione invece di bloccarla: ' +
        'rivedi `pesa` prima di allineare `azioneFk`.',
    ).toEqual([])
  })
})

describe('la fotografia non è cieca a ciò che è successo dopo', () => {
  it('nessuna migrazione posteriore tocca le chiavi esterne verso utenti', () => {
    // Una fotografia è cieca a ciò che accade DOPO lo scatto. Si guardano quindi le
    // migrazioni più recenti, e si grida al lupo su qualunque cosa somigli a una FK
    // verso `utenti`: un falso allarme si chiude rigenerando la fotografia, un
    // silenzio non si chiude mai.
    // ⚠️ SI CERCANO LE DUE FORME CHE POSSONO CAMBIARE UNA FK, non la parola
    // «on delete». Il primo filtro diceva anche `/\bon\s+delete\b/i`, e il
    // 2026-09-20 ha sparato sulla migrazione di questo stesso lavoro: la frase
    // stava in un commento DENTRO il corpo `$$` di una funzione, e `senzaCommenti`
    // — giustamente — non tocca il contenuto delle stringhe dollar-quoted, dove un
    // `--` è testo e non un commento SQL.
    //
    // `add constraint` / `drop constraint` restano perché cambiare la `ON DELETE`
    // di una chiave esistente si fa SOLO così: la si lascia cadere e la si
    // riscrive. Il filtro è ancora largo — una migrazione che tocca un vincolo
    // qualunque fa gridare al lupo — ed è il verso giusto in cui sbagliare: un
    // falso allarme si chiude rigenerando la fotografia, un silenzio non si chiude.
    const sospette = posterioriCheContengono(MIGRAZIONI, sogliaFotografia(foto), (sql) => {
      const s = senzaCommenti(sql)
      return (
        /references\s+(public\.)?utenti\b/i.test(s) || /\b(add|drop)\s+constraint\b/i.test(s)
      )
    })
    expect(
      sospette,
      'Migrazioni applicate dopo lo scatto che nominano `utenti` o una `ON DELETE`. ' +
        'Rigenera la fotografia: `node __tests__/fixtures/fk-utenti-fotografia.mjs --sql`, ' +
        'esegui su produzione, poi passa la risposta allo stesso script.',
    ).toEqual([])
  })
})

describe("l'anteprima e l'esecuzione decidono nello stesso modo", () => {
  /** Un database finto con una riga sola sulla voce indicata. */
  function dbCon(tabella: string, colonna: string, utenteId: string): DBFinto {
    const db: DBFinto = { parents: [] }
    // Ogni tabella del registro deve esistere nel finto, o la lettura degraderebbe
    // a «schema assente» e conterebbe zero — cioè il verde sbagliato.
    for (const v of VOCI_CHE_PESANO) db[v.tabella] = db[v.tabella] ?? []
    db[tabella] = [{ [colonna]: utenteId }]
    return db
  }

  const UTENTE = '11111111-1111-4111-8111-111111111111'

  it('una traccia su QUALUNQUE voce del registro porta ad archivia — tutte e 44', async () => {
    // Non una voce campione: tutte. Una voce che il registro dichiara ma che la
    // funzione di conteggio non interroga resterebbe altrimenti invisibile.
    for (const v of VOCI_CHE_PESANO) {
      const supabase = creaFintoSupabase(dbCon(v.tabella, v.colonna, UTENTE))
      const esito = await contaTracceDocente(supabase, UTENTE, 'test')
      const verdetto = decisioneEliminazione(esito)
      expect(verdetto.decisione, `${chiave(v)} non è stata interrogata`).toBe('archivia')
      expect(verdetto.motivi.map(chiave)).toContain(chiave(v))
    }
  })

  it("la traccia di UN ALTRO docente non conta: il filtro c'è davvero", async () => {
    // Controllo negativo. Senza, una sonda che dimenticasse `.eq(colonna, utenteId)`
    // troverebbe le righe dell'intera scuola e direbbe «archivia» su chiunque —
    // restando verde in tutti gli altri casi, perché l'esito «archivia» è quello
    // che i test principali si aspettano.
    const ALTRO = '22222222-2222-4222-8222-222222222222'
    const db: DBFinto = { parents: [] }
    for (const v of VOCI_CHE_PESANO) db[v.tabella] = []
    db.eventi_diario = [{ maestra_id: ALTRO }]
    db.presenze = [{ registrato_da: ALTRO }]
    const esito = await contaTracceDocente(creaFintoSupabase(db), UTENTE, 'test')
    expect(decisioneEliminazione(esito).decisione).toBe('cancella')
  })

  it('nessuna traccia e nessun ponte → cancella', async () => {
    const db: DBFinto = { parents: [] }
    for (const v of VOCI_CHE_PESANO) db[v.tabella] = []
    const esito = await contaTracceDocente(creaFintoSupabase(db), UTENTE, 'test')
    expect(decisioneEliminazione(esito).decisione).toBe('cancella')
  })

  it('nessuna traccia ma ponte genitore → profilo-doppio', async () => {
    const db: DBFinto = { parents: [{ id: 'p1', auth_user_id: UTENTE }] }
    for (const v of VOCI_CHE_PESANO) db[v.tabella] = []
    const esito = await contaTracceDocente(creaFintoSupabase(db), UTENTE, 'test')
    expect(decisioneEliminazione(esito).decisione).toBe('profilo-doppio')
  })

  it('una sonda che fallisce NON diventa zero: si dice non-deciso', async () => {
    // ⚠️ È il caso che separa questo lock da un mock piatto. PostgREST non lancia:
    // senza il controllo di `{ error }` una lettura fallita diventerebbe una lista
    // vuota, cioè «nessuna traccia», e l'anteprima direbbe «si cancella» su un
    // docente che ha scritto il registro per un anno.
    const db: DBFinto = { parents: [] }
    for (const v of VOCI_CHE_PESANO) db[v.tabella] = []
    const supabase = creaFintoSupabase(db, [], {
      errori: { 'eventi_diario:select': { code: '57014', message: 'statement timeout' } },
    })
    const esito = await contaTracceDocente(supabase, UTENTE, 'test')
    expect(decisioneEliminazione(esito).decisione).toBe('non-deciso')
  })

  it('uno schema assente NON è un guasto: la tabella che non c\'è conta zero', async () => {
    // Il DB E2E della CI non è migrato. `42P01` è la risposta giusta, non un errore:
    // se la tabella non esiste, di righe non ce n'è nessuna.
    const db: DBFinto = { parents: [] }
    for (const v of VOCI_CHE_PESANO) db[v.tabella] = []
    const supabase = creaFintoSupabase(db, [], {
      errori: { 'video_jobs:select': { code: '42P01', message: 'relation does not exist' } },
    })
    const esito = await contaTracceDocente(supabase, UTENTE, 'test')
    expect(decisioneEliminazione(esito).decisione).toBe('cancella')
  })
})
