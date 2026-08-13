import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PERSONALE_FIELDS,
  PERSONALE_LIMITI,
  CAMPI_VIETATI,
  CONSENSI_PERSONALE_FIELDS,
  TIPI_DOCUMENTO,
} from '@/lib/forms/personale-template'
import { FORMA_CF } from '@/lib/fiscale/tabelle'
import { ESTENSIONI_ALLEGATO_PUBBLICO } from '@/lib/upload/allegati-pubblici'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  IL COLLAUDO CHE `personale-template.ts` CITAVA DUE VOLTE E NON ESISTEVA  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── PERCHÉ NASCE ADESSO, E PERCHÉ NON È UNA FORMALITÀ ───────────────────────
 *
 * Fino al 12/08/2026 `personale-template.ts` nominava questo file DUE volte al
 * presente, in due punti diversi:
 *
 *   riga  98 — «tre dichiarazioni che devono coincidere, e `personale-template.test.ts`
 *              le confronta»            (la forma del codice fiscale)
 *   riga 269 — «`personale-template.test.ts` confronta questa lista con gli `id` e i
 *              `db_mapping` di PERSONALE_FIELDS: chi ne aggiunge uno lo scopre il
 *              giorno in cui lo aggiunge»            (`CAMPI_VIETATI`)
 *
 * Misurato, non dedotto:
 *
 *     find __tests__ -name "*personale-template*"   → nessun risultato
 *     grep -rn CAMPI_VIETATI __tests__/             → nessun risultato
 *
 * Cioè il presidio su IBAN, firma autografa, dati sanitari e casellario giudiziale
 * nel modulo del PERSONALE era **dichiarato e mai scritto**. In un repo che ha
 * pagato due settimane di «pre-lancio, nessun dato reale» mentre arrivavano nove
 * domande l'ora, un documento che descrive una protezione che non c'è è peggio di
 * nessun documento: chi legge quelle righe aggiunge un campo credendo che qualcosa
 * lo fermerà.
 *
 * ── COSA SORVEGLIA, E COSA NO ───────────────────────────────────────────────
 *
 * Qui stanno solo le regole che vivono NEL TEMPLATE. La forma dei percorsi delle
 * scansioni e l'allineamento con `ESTENSIONI_ALLEGATO_PUBBLICO` sono già di
 * `__tests__/lib/percorso-documento.test.ts`, e ripeterli qui sarebbe la stessa
 * regola in due posti — che in questo repo diverge alla prima modifica.
 */

/** Il testo delle due migrazioni che dichiarano le colonne del personale. */
function migrazione(nome: string): string {
  return readFileSync(join(process.cwd(), 'supabase', 'migrations', nome), 'utf8')
}

const CAMPI_FILE = PERSONALE_FIELDS.filter((f) => f.type === 'file')

describe('personale-template · i campi che NON si chiedono (`CAMPI_VIETATI`)', () => {
  /**
   * ⚠️ IL CONFRONTO È SU `includes`, NON SU `===`, e la differenza è il punto.
   *
   * Le voci vietate sono RADICI, non nomi di colonna: `allerg` copre `allergie`,
   * `allergeni` e `allergie_note`; `contratto` copre `tipo_contratto` e
   * `contratto_scadenza`. Un confronto esatto lascerebbe entrare tutte le varianti,
   * cioè proprio il modo in cui un campo vietato entra davvero — nessuno aggiunge
   * una colonna che si chiama `iban` e basta, si aggiunge `iban_accredito`.
   */
  it('nessun `id` del template contiene una delle radici vietate', () => {
    for (const campo of PERSONALE_FIELDS) {
      for (const vietata of CAMPI_VIETATI) {
        expect(
          campo.id.toLowerCase().includes(vietata),
          `il campo «${campo.id}» del modulo del personale contiene la radice vietata «${vietata}» ` +
            '— le ragioni, una per una, stanno nel blocco sopra `CAMPI_VIETATI`',
        ).toBe(false)
      }
    }
  })

  it('nessun `db_mapping` del template punta a una colonna vietata', () => {
    for (const campo of PERSONALE_FIELDS) {
      const colonna = String(campo.db_mapping ?? '').toLowerCase()
      for (const vietata of CAMPI_VIETATI) {
        expect(
          colonna.includes(vietata),
          `il campo «${campo.id}» archivia in «${campo.db_mapping}», che contiene la radice vietata «${vietata}»`,
        ).toBe(false)
      }
    }
  })

  /**
   * ⚠️ ANCHE I CONSENSI, e non è pignoleria: il testo dei tre blocchi viene CONGELATO
   * in `pratiche_personale.consents_log` e resta la prova, fra dieci anni, di ciò che
   * alla persona è stato dichiarato. Un campo vietato non entra solo come casella:
   * entra anche come frase che promette di raccoglierlo.
   */
  it('nessun `id` di consenso contiene una radice vietata', () => {
    for (const consenso of CONSENSI_PERSONALE_FIELDS) {
      for (const vietata of CAMPI_VIETATI) {
        expect(
          consenso.id.toLowerCase().includes(vietata),
          `il consenso «${consenso.id}» contiene la radice vietata «${vietata}»`,
        ).toBe(false)
      }
    }
  })

  /**
   * La lista serve a qualcosa solo se le sue voci MORDONO. Senza questa prova, un
   * refuso («ibn» invece di `iban`) lascerebbe il lock verde per sempre: nessun campo
   * lo conterrebbe mai, e la protezione sarebbe di nuovo una dichiarazione.
   */
  it('ogni radice vietata respinge davvero un campo che la contiene', () => {
    for (const vietata of CAMPI_VIETATI) {
      expect(vietata, 'una radice vuota respingerebbe qualunque campo').not.toBe('')
      const finto = `${vietata}_accredito`
      expect(
        CAMPI_VIETATI.some((v) => finto.includes(v)),
        `la radice «${vietata}» non riconosce nemmeno «${finto}»`,
      ).toBe(true)
    }
  })
})

describe('personale-template · la forma del codice fiscale, in TRE dichiarazioni', () => {
  const pattern = PERSONALE_FIELDS.find((f) => f.id === 'fiscal_code')?.validation?.pattern
  const forma = new RegExp(String(pattern))

  it('il campo dichiara un `pattern`, e con esso i due tetti di lunghezza', () => {
    expect(pattern, 'il codice fiscale del personale non ha nessun `pattern`').toBeTruthy()
    const campo = PERSONALE_FIELDS.find((f) => f.id === 'fiscal_code')
    expect(campo?.required).toBe(true)
    expect(campo?.validation?.min_length).toBe(16)
    expect(campo?.validation?.max_length).toBe(16)
  })

  /**
   * DICHIARAZIONE 2 — il CHECK in tabella (migrazione `20260811205643`).
   *
   * Si confronta la STRINGA, ed è l'unico confronto onesto: quella è la copia che
   * Postgres esegue, e una divergenza qui significa un modulo che accetta un codice
   * che l'INSERT poi respinge con `23514` — cioè un 500 opaco su una persona vera.
   * Il CHECK compare DUE volte (`pratiche_personale` e `anagrafica_personale`) e
   * devono essere lo stesso: la pratica diventa il fascicolo per travaso.
   */
  it('coincide, carattere per carattere, con il CHECK delle due tabelle', () => {
    const sql = migrazione('20260811205643_anagrafica_personale.sql')
    const check = [...sql.matchAll(/fiscal_code\s*~\s*\n?\s*'([^']+)'/g)].map((m) => m[1])
    expect(check, 'il CHECK del codice fiscale non compare in entrambe le tabelle').toHaveLength(2)
    for (const dichiarato of check) expect(dichiarato).toBe(pattern)
  })

  /**
   * DICHIARAZIONE 3 — `FORMA_CF` (`@/lib/fiscale/tabelle`), che è la FONTE.
   *
   * ⚠️ NON si confrontano le due `source`, e non è una scorciatoia: `FORMA_CF` ammette
   * anche le minuscole (`[A-Za-z]`) perché chi legge un codice lo normalizza dopo,
   * mentre qui la route normalizza PRIMA di validare e il CHECK in tabella è a
   * maiuscole. Le due stringhe DEVONO essere diverse; a dover coincidere è il
   * VERDETTO su un codice già in maiuscolo, che è l'unica forma che arriva qui.
   */
  it('dà lo stesso verdetto di `FORMA_CF` su ogni codice in maiuscolo', () => {
    const probe = [
      'RSSMRA80A41H501U', // ordinario
      'RSSMRAL0A41H501U', // omocodia sulla prima cifra dell'anno
      'RSSMRA80A41H50NU', // omocodia dentro il codice del comune
      'RSSMRALMAM1H50NU', // omocodia su tutte le posizioni numeriche
      'RSSMRA80Z41H501U', // mese `Z`: non esiste
      'RSSMRA80A41H5011', // ultimo carattere numerico: non è un carattere di controllo
      'RSSMR80A41H501U', // quindici caratteri
      'RSSMRA80A41H501UU', // diciassette caratteri
      '', // vuoto
    ]
    for (const codice of probe) {
      expect(forma.test(codice), `verdetti diversi su «${codice}»`).toBe(FORMA_CF.test(codice))
    }
  })

  /**
   * L'OMOCODIA PASSA, ed è la differenza dichiarata da `enrollment-template.ts` —
   * che usa `[0-9]` e quindi RIFIUTA i codici in cui l'Agenzia ha sostituito le cifre.
   * Sono codici veri, di persone vere: respingerli significa dire a qualcuno che il
   * proprio codice fiscale non esiste.
   */
  it('accetta un codice omocodico, che è la ragione per cui questo pattern è suo', () => {
    expect(forma.test('RSSMRAL0A41H501U')).toBe(true)
    // …e la stessa persona senza omocodia passa comunque: non è un pattern per soli
    // codici omocodici.
    expect(forma.test('RSSMRA80A41H501U')).toBe(true)
  })
})

describe('personale-template · le DUE facce del documento', () => {
  it('sono due, si chiamano come le colonne, e sono entrambe obbligatorie', () => {
    expect(CAMPI_FILE.map((f) => f.id)).toEqual(['documento_fronte_path', 'documento_retro_path'])
    // ⚠️ `required: true` sul RETRO per tutti e tre i tipi (CI · PP · DL): la ragione
    // per esteso sta nel template, e la regola non è condizionale di proposito —
    // vivrebbe in tre posti (client, server, template) e divergerebbe alla prima
    // modifica. Qui si sorveglia che nessuno la «raffini» in un `required: false`.
    for (const faccia of CAMPI_FILE) {
      expect(faccia.required, `la faccia «${faccia.id}» non è obbligatoria`).toBe(true)
      expect(faccia.type).toBe('file')
      expect(faccia.max_size_mb).toBe(PERSONALE_LIMITI.maxDocMb)
    }
    // I tre tipi restano tre: se un giorno se ne aggiungesse un quarto, la frase
    // «obbligatorio per tutti e tre» smetterebbe di descrivere il modulo.
    expect(TIPI_DOCUMENTO.map((t) => t.value)).toEqual(['CI', 'PP', 'DL'])
  })

  /**
   * ⚠️ L'`accept` DEV'ESSERE IDENTICO FRA LE DUE FACCE.
   *
   * Due liste diverse per lo stesso documento sarebbero un fronte accettato e un retro
   * respinto **dallo stesso telefono**: chi compila non ha modo di capire perché la
   * seconda foto non va bene, e la Segreteria riceve una pratica a metà.
   */
  it('accettano esattamente gli stessi formati, e sono quelli del bucket', () => {
    const [fronte, retro] = CAMPI_FILE
    expect(retro.accept, 'fronte e retro accettano formati diversi').toBe(fronte.accept)
    const estensioni = String(fronte.accept ?? '')
      .split(',')
      .map((e) => e.trim().replace(/^\./, '').toLowerCase())
    expect(estensioni.sort()).toEqual([...ESTENSIONI_ALLEGATO_PUBBLICO].sort())
  })

  /**
   * Il rinomino del 12/08/2026 poggia su un'invariante sola: in questo template
   * l'`id` **è** il nome della colonna. Da lì discendono `costruisciRiga`,
   * `CAMPI_DOCUMENTO` e le colonne che le rotte admin interrogano — cioè un `id` che
   * non coincide col `db_mapping` non è un refuso, è una colonna che non esiste.
   */
  it('ogni campo archivia nella colonna che porta il suo nome', () => {
    for (const campo of PERSONALE_FIELDS) {
      expect(campo.db_mapping, `il campo «${campo.id}» non dichiara dove archivia`).toBe(
        `pratiche_personale.${campo.id}`,
      )
    }
  })

  /**
   * E le due colonne esistono davvero, con quel nome, in ENTRAMBE le tabelle: la
   * pratica che le riceve e il fascicolo in cui vengono travasate. È la migrazione
   * `20260812194501`, letta invece che ricordata.
   */
  it('le due colonne stanno nella migrazione che le ha create', () => {
    const sql = migrazione('20260812194501_documento_fronte_retro.sql')
    expect(sql).toContain('rename column documento_path to documento_fronte_path')
    for (const tabella of ['pratiche_personale', 'anagrafica_personale']) {
      expect(
        // `if not exists` è FACOLTATIVO nel confronto, e la ragione va detta perché
        // questo lock ha già sbagliato una volta proprio qui: legge il TESTO della
        // migrazione, quindi diventa rosso su una riscrittura che non cambia lo schema.
        // Il 13/08 la migrazione è stata resa idempotente — `add column if not exists` —
        // perché `.github/workflows/migrate-ci.yml` riapplica gli stessi file al database
        // della CI senza storico, e un file non idempotente fallisce al secondo lancio.
        // Lo schema prodotto è identico; a cambiare era solo la forma.
        new RegExp(
          `alter table public\\.${tabella}\\s+add column (if not exists )?documento_retro_path`,
        ).test(sql),
        `la migrazione non aggiunge «documento_retro_path» a ${tabella}`,
      ).toBe(true)
    }
  })
})

describe('personale-template · i termini promessi sono quelli applicati', () => {
  /**
   * I due termini del terzo consenso sono INTERPOLATI da `PERSONALE_LIMITI`, non
   * ribattuti a mano: sono ciò che viene promesso all'interessata e archiviato in
   * `consents_log`, e devono coincidere con quelli che il cron di conservazione
   * applica. Una promessa non mantenuta qui non è un refuso redazionale: è un
   * documento legale che dice il falso.
   */
  it('il consenso sulla copia del documento cita i termini veri', () => {
    const copia = CONSENSI_PERSONALE_FIELDS.find((c) => c.id === 'presa_visione_copia_documento')
    expect(copia?.text).toContain(`${PERSONALE_LIMITI.mesiDocumentoDopoCessazione} mesi`)
    expect(copia?.text).toContain(`${PERSONALE_LIMITI.giorniPraticaNonApprovata} giorni`)
  })

  it('i tre consensi sono tre, tutti obbligatori e tutti prese visione', () => {
    expect(CONSENSI_PERSONALE_FIELDS).toHaveLength(3)
    for (const consenso of CONSENSI_PERSONALE_FIELDS) {
      expect(consenso.type).toBe('consent')
      expect(consenso.required, `«${consenso.id}» non è obbligatorio`).toBe(true)
      expect(consenso.text, `«${consenso.id}» non ha nessun testo da congelare`).toBeTruthy()
    }
  })
})
