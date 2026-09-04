import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { senzaCommenti } from './soglia-fotografia'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK · rinominare una sezione deve propagare il nome OVUNQUE sia scritto
//
// ─── IL GUASTO, MISURATO ─────────────────────────────────────────────────────
// Il nome di una classe è scritto come TESTO in otto posti diversi. Il trigger
// `trg_sections_propaga_rinomina` (`20260902145538_identita_classe_presidi.sql`)
// ne aggiornava UNO: `alunni.classe_sezione`, e solo per gli alunni che avevano
// già `section_id` valorizzato. Tutto il resto restava al nome vecchio:
//
//   · `registro_orario.classe_sezione` fa parte della chiave di upsert
//     `(scuola_id, classe_sezione, data, ora_lezione)`: dopo una rinomina il
//     registro RIPARTE DA ZERO e lezioni, argomenti, compiti e firme storiche
//     diventano irraggiungibili. È il danno peggiore, ed è già visibile in
//     produzione: 14 righe con `classe_sezione = 'TEST 1A'` e `section_id` che
//     punta a una sezione oggi chiamata «TEST 1A GIU» (misurato il 2026-09-03).
//   · `avvisi`, `news_posts`, `galleria_media_v2`, `forms_templates` tengono i
//     destinatari in `target_classes text[]`, confrontato PER NOME: un avviso
//     già pubblicato smette di arrivare a chiunque, senza errore e senza log.
//     Non è un'ipotesi — è successo, ed è documentato in
//     `20260801104252_avvisi_target_classes_nomi.sql`: dieci alunni, zero
//     destinatari raggiunti.
//   · `mensa_class_menu_assignment.classe` perde il menu della classe, che
//     ricade in silenzio sul menu legacy di sede.
//
// ─── PERCHÉ UN LOCK TESTUALE ────────────────────────────────────────────────
// La migrazione NON viene applicata da chi la scrive — in produzione ci sono
// dati reali di minori e ogni migrazione si fa approvare — e il gate gira
// OFFLINE, senza database. Qui si verifica che il rimedio esista nel repo e
// abbia la forma giusta; l'esecuzione la controlla chi la applica, con i
// conteggi che la funzione stessa scrive in `app_log`. È la stessa scelta, con
// le stesse ragioni scritte, di `app-log-bonifica-pii.test.ts`.
//
// Il testo si legge SENZA COMMENTI (`senzaCommenti`, lo stesso parser dei lock
// sulla fotografia): un commento non arriva a Postgres, e un lock che si può
// soddisfare scrivendo una frase è un lock che paga chi commenta di più.
//
// ─── LA COSA CHE QUESTO LOCK GUARDA PIÙ DI TUTTE ────────────────────────────
// **Ogni UPDATE deve filtrare per `scuola_id`.** L'omonimia fra plessi è lecita
// e voluta: «2 ANNI A» esiste a Giugliano e ad Aversa, «5 ANNI» a Cesa e ad
// Aversa. Una propagazione che dimentica la sede non lascia indietro dei dati:
// li RISCRIVE nel plesso sbagliato, in silenzio. È il difetto opposto a quello
// che la migrazione ripara, ed è peggiore.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

/** I file della migrazione che porta il rimedio. */
const FILE = readdirSync(MIGRAZIONI).filter((f) => /propaga.*rinomina|rinomina.*propaga/i.test(f))
const SQL = FILE.map((f) => readFileSync(join(MIGRAZIONI, f), 'utf8')).join('\n')
/**
 * Le sole ISTRUZIONI: niente commenti, stringhe intatte.
 *
 * ⚠️ SERVONO DUE PASSATE, E LA SECONDA NON È UN DOPPIONE.
 * `senzaCommenti` è il parser condiviso coi lock sulla fotografia: tratta il
 * corpo `$function$ … $function$` come una STRINGA — cosa che per Postgres è —
 * e ci copia dentro tutto, commenti inclusi. Ma il corpo di una funzione
 * PL/pgSQL viene poi eseguito come CODICE, e i suoi `--` sono commenti a tutti
 * gli effetti: non arrivano a nessuna tabella.
 *
 * Senza la seconda passata il lock dà falsi positivi, e il primo l'ha dato su
 * sé stesso: la prova «nel log non finisce nessun dato personale» è diventata
 * rossa per la riga
 *     -- ⚠️ Nel contesto vanno SOLO uuid, conteggi e il nome della CLASSE.
 *     --    Mai nome, cognome o codice fiscale: sono dati di minori.
 * cioè per la frase che PROMETTE di non fare ciò di cui accusava. Un lock che
 * punisce chi scrive perché non farlo insegna a non scriverlo, e la volta dopo
 * qualcuno abbassa il lock invece di correggerlo.
 *
 * Si tolgono solo i `--` che aprono la riga (a meno dell'indentazione): un `--`
 * in mezzo a una stringa SQL resta dov'è, e il rilevatore continua a vedere il
 * codice vero. La prova che morda ancora sta nell'ultimo `it` di questo file.
 */
const CODICE = senzaCommenti(SQL).replace(/^[ \t]*--.*$/gm, '')

/** Le tabelle che tengono il nome della classe come testo e che la rinomina deve raggiungere. */
const TABELLE_DA_PROPAGARE = [
  'alunni',
  'registro_orario',
  'avvisi',
  'news_posts',
  'galleria_media_v2',
  'forms_templates',
  'mensa_class_menu_assignment',
] as const

/**
 * Le tabelle che possono NON esistere sul database E2E della CI, che è un
 * progetto separato e non migrato. `alunni` non è fra queste: se mancasse lei,
 * non ci sarebbe nessun registro elettronico da collaudare.
 */
const TABELLE_FORSE_ASSENTI = [
  'registro_orario',
  'avvisi',
  'news_posts',
  'galleria_media_v2',
  'forms_templates',
  'mensa_class_menu_assignment',
] as const

/** Le tabelle il cui nome di classe vive dentro un `text[]`. */
const TABELLE_AD_ARRAY = ['avvisi', 'news_posts', 'galleria_media_v2', 'forms_templates'] as const

/**
 * Le istruzioni SQL, una per `;`. Dentro un corpo `$function$ … $function$` i
 * `;` separano le istruzioni del trigger, che è esattamente ciò che si vuole
 * ispezionare: la granularità giusta è la singola istruzione, non il file.
 */
const ISTRUZIONI = CODICE.split(';')

/** Le istruzioni che aggiornano una tabella, con il nome della tabella aggiornata. */
function aggiornamenti(): { tabella: string; testo: string }[] {
  const out: { tabella: string; testo: string }[] = []
  for (const istruzione of ISTRUZIONI) {
    // `DO UPDATE SET …` dell'ON CONFLICT non entra: lì dopo `update` non c'è `public.`.
    for (const m of istruzione.matchAll(/\bupdate\s+public\.([a-z0-9_]+)/gi)) {
      out.push({ tabella: m[1].toLowerCase(), testo: istruzione })
    }
  }
  return out
}

/** L'istruzione che scrive la riga di log. */
function insertNelLog(): string {
  return ISTRUZIONI.find((i) => /\binsert\s+into\s+public\.app_log\b/i.test(i)) ?? ''
}

describe('lock architettura · la rinomina di una sezione propaga ovunque, e solo nella sua sede', () => {
  it('la migrazione esiste nel repo', () => {
    expect(
      FILE,
      'Nessuna migrazione che propaga la rinomina di una sezione. Finché non c’è, ' +
        'rinominare una classe rende invisibile il suo registro storico e spegne gli ' +
        'avvisi già pubblicati, senza un errore da nessuna parte.',
    ).not.toEqual([])
  })

  it('sostituisce la funzione del trigger, senza reinventare il trigger', () => {
    expect(
      /create\s+or\s+replace\s+function\s+public\.propaga_rinomina_sezione\b/i.test(CODICE),
      'Il rimedio deve essere un `CREATE OR REPLACE FUNCTION public.propaga_rinomina_sezione()`: ' +
        'il trigger `trg_sections_propaga_rinomina` esiste già e resta agganciato alla funzione ' +
        'sostituita. Una funzione nuova con un nome nuovo lascerebbe in vita quella vecchia.',
    ).toBe(true)
  })

  it('il rilevatore trova davvero degli UPDATE (il lock non gira a vuoto)', () => {
    // Verde perché non trova violazioni ≠ verde perché non guarda più niente.
    // Se lo spezzettamento delle istruzioni si rompesse, questo conteggio cade
    // prima che tutte le prove qui sotto diventino decorazione.
    expect(
      aggiornamenti().length,
      'Meno di otto UPDATE riconosciuti: o la migrazione non propaga a tutte le tabelle, ' +
        'o il rilevatore ha smesso di riconoscerle e le prove qui sotto non guardano più niente.',
    ).toBeGreaterThanOrEqual(8)
  })

  it('OGNI update filtra per `scuola_id` (l’omonimia fra plessi è lecita e voluta)', () => {
    const senzaSede = aggiornamenti()
      .filter((a) => !/scuola_id\s*=\s*new\.scuola_id/i.test(a.testo))
      .map((a) => a.tabella)
    expect(
      [...new Set(senzaSede)].sort(),
      'Questi UPDATE non sono legati alla sede della sezione rinominata. «2 ANNI A» esiste a ' +
        'Giugliano e ad Aversa: senza `scuola_id = NEW.scuola_id` la rinomina fatta in un plesso ' +
        'riscrive i dati dell’altro, in silenzio e senza modo di accorgersene. ' +
        'Il filtro può stare nella WHERE dell’UPDATE o nella CTE che ne sceglie le righe: ' +
        'purché sia nella stessa istruzione.',
    ).toEqual([])
  })

  it('raggiunge tutte le tabelle che tengono il nome della classe per testo', () => {
    const toccate = new Set(aggiornamenti().map((a) => a.tabella))
    const dimenticate = TABELLE_DA_PROPAGARE.filter((t) => !toccate.has(t))
    expect(
      dimenticate,
      'Queste tabelle tengono il nome della classe come testo e la rinomina non le raggiunge. ' +
        '`registro_orario` è la più grave: il suo `classe_sezione` è parte della chiave di ' +
        'upsert, e un nome che cambia fa ripartire il registro da zero.',
    ).toEqual([])
  })

  it('negli array sostituisce l’ELEMENTO, non l’intero array', () => {
    for (const tabella of TABELLE_AD_ARRAY) {
      const istruzioni = aggiornamenti().filter((a) => a.tabella === tabella)
      expect(istruzioni.length, `nessun UPDATE su \`${tabella}\``).toBeGreaterThan(0)
      for (const { testo } of istruzioni) {
        expect(
          /unnest\s*\(|array_replace\s*\(/i.test(testo),
          `L’UPDATE su \`${tabella}\` deve ricostruire \`target_classes\` elemento per elemento ` +
            `(\`unnest\` o \`array_replace\`), conservando ogni altra classe destinataria.`,
        ).toBe(true)
        expect(
          /target_classes\s*=\s*array\s*\[/i.test(testo),
          `L’UPDATE su \`${tabella}\` assegna un array LETTERALE a \`target_classes\`: ` +
            `cancellerebbe tutte le altre classi destinatarie dell’avviso. Un avviso che perde ` +
            `metà dei destinatari è peggio di uno che tiene un nome vecchio, perché nessuno lo vede.`,
        ).toBe(false)
        expect(
          /where[\s\S]*unnest/i.test(testo),
          `L’UPDATE su \`${tabella}\` non ha una condizione che cerchi il nome vecchio DENTRO ` +
            `l’array: riscriverebbe righe che non c’entrano niente con la sezione rinominata.`,
        ).toBe(true)
      }
    }
  })

  it('raggiunge anche gli alunni con `section_id` NULL, per forma normalizzata', () => {
    // Il ramo che mancava. `WHERE section_id = NEW.id` non vede l’alunno il cui
    // `section_id` non è mai stato risolto — il caso dei 73 bambini di Aversa del
    // 31/08, iscritti e invisibili a ogni appello. Si riconoscono per FORMA
    // NORMALIZZATA, cioè con la stessa espressione dell’indice unico
    // `sections_forma_normalizzata_per_sede`.
    const suAlunni = aggiornamenti().filter((a) => a.tabella === 'alunni')
    const ramoOrfani = suAlunni.filter((a) => /section_id\s+is\s+null/i.test(a.testo))
    expect(
      ramoOrfani.length,
      'Nessun UPDATE su `alunni` raggiunge chi ha `section_id` NULL: quegli alunni restano col ' +
        'nome vecchio e fuori da ogni registro, che è esattamente il guasto da cui questo trigger è nato.',
    ).toBeGreaterThan(0)
    for (const { testo } of ramoOrfani) {
      expect(
        /lower\s*\(\s*replace\s*\(/i.test(testo),
        'Il ramo degli alunni senza `section_id` deve combaciare per FORMA NORMALIZZATA ' +
          "(`lower(replace(…, ' ', ''))`), la stessa espressione dell’indice unico " +
          '`sections_forma_normalizzata_per_sede` e del trigger `sync_alunno_section_id`. ' +
          'Un confronto esatto non vedrebbe «4 anni  a» contro «4 ANNI A», che è la divergenza vera.',
      ).toBe(true)
    }
  })

  it('la forma normalizzata è la STESSA dell’indice unico, in un posto solo', () => {
    // Due normalizzazioni diverse per la stessa domanda sono due risposte diverse
    // il giorno in cui divergono: l’indice garantisce l’unicità su una forma, il
    // trigger deve cercare su quella.
    const forme = [...CODICE.matchAll(/lower\s*\(\s*replace\s*\(([^)]*)\)\s*\)/gi)].map((m) =>
      m[1].replace(/\s+/g, ' ').trim(),
    )
    expect(forme.length, 'nessuna normalizzazione del nome trovata').toBeGreaterThan(0)
    const separatori = [...new Set(forme.map((f) => f.slice(f.indexOf(','))))]
    expect(
      separatori,
      `La normalizzazione del nome non è una sola: ${separatori.join(' · ')}. ` +
        "L’unica ammessa è `lower(replace(<nome>, ' ', ''))` — quella dell’indice " +
        '`sections_forma_normalizzata_per_sede`.',
    ).toEqual([", ' ', ''"])
  })

  it('non esplode se una tabella non esiste (il DB E2E della CI non è migrato)', () => {
    expect(
      /to_regclass/i.test(CODICE),
      'Serve una guardia sull’esistenza delle tabelle: il database E2E della CI è un progetto ' +
        'separato e non migrato, e una tabella assente farebbe fallire la rinomina con `42P01`.',
    ).toBe(true)
    for (const tabella of TABELLE_FORSE_ASSENTI) {
      const bandiera = new RegExp(`\\bv_ha_${tabella}\\b`, 'gi')
      const occorrenze = [...CODICE.matchAll(bandiera)].length
      expect(
        occorrenze,
        `\`${tabella}\` non ha una guardia \`v_ha_${tabella}\` dichiarata E usata: la guardia va ` +
          `calcolata una volta (\`to_regclass\` + le colonne che servono) e poi messa davanti ` +
          `all’UPDATE. Senza, sul DB E2E la rinomina fallisce invece di degradare in modo pulito.`,
      ).toBeGreaterThanOrEqual(2)
    }
  })

  it('scrive in `app_log` quante righe ha toccato, tabella per tabella', () => {
    const log = insertNelLog()
    expect(log, 'La funzione non scrive niente in `app_log`.').not.toBe('')
    expect(
      /jsonb_build_object/i.test(log),
      'Il contesto del log va costruito con `jsonb_build_object`, come già fa la funzione oggi.',
    ).toBe(true)
    const senzaConteggio = TABELLE_DA_PROPAGARE.filter((t) => !new RegExp(`'${t}'`, 'i').test(log))
    expect(
      senzaConteggio,
      'Il log non dice quante righe ha toccato in queste tabelle. Con un conteggio solo, ' +
        '«nessuna riga» non distingue «erano già allineate» da «quel ramo non è mai partito»: ' +
        'è la regola 5 di AGENTS.md, e questo trigger nasce da un guasto che il silenzio ha ' +
        'nascosto per settimane.',
    ).toEqual([])
    expect(
      /'info'/i.test(log),
      'Il log deve uscire anche quando è andato tutto bene: gli eventi critici loggano il SUCCESSO.',
    ).toBe(true)
  })

  it('nel log non finisce nessun dato personale', () => {
    const log = insertNelLog()
    const vietati = [/\bcognome\b/i, /codice_fiscale/i, /data_nascita/i, /\bemail\b/i, /alunno_id/i]
    const trovati = vietati.filter((r) => r.test(log)).map((r) => r.source)
    expect(
      trovati,
      'Nel contesto del log finiscono dati personali. Qui passano solo uuid, conteggi e il nome ' +
        'della CLASSE: sono dati di minori, e `app_log` è interrogabile da chiunque abbia accesso ' +
        'al database.',
    ).toEqual([])
  })
})
