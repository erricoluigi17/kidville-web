import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * ─── LOCK — IL VOCABOLARIO DELL'ETICHETTA VIVE IN TRE LINGUE E DEVE COINCIDERE ─
 *
 * ── PERCHÉ QUESTO FILE ESISTE, E COME CI SI È ARRIVATI ──────────────────────
 *
 * L'intestazione di `filtri-candidature.ts` prometteva testualmente che i tre
 * elenchi «si tengono allineati da un lock, non dalla buona volontà». **Quel lock
 * non esisteva.** Il file che il commento citava —
 * `etichetta-candidatura-senza-email.test.ts` — cammina sul grafo degli import e
 * non ha mai letto un vocabolario. Misurato in revisione il 2026-09-06: togliendo
 * `in_valutazione` dal CHECK della migrazione, la suite restava **tutta verde**.
 *
 * Era la forma di difetto peggiore che questo repository conosca — una protezione
 * descritta da un commento e da nessuna riga — perché costa zero crederci: chi
 * aggiunge una sesta etichetta legge «c'è un lock», la scrive in due posti su tre
 * e si fida del verde.
 *
 * ── E COSA SUCCEDE DAVVERO SE DIVERGONO ────────────────────────────────────
 *
 * I tre elenchi non sono tre copie per pigrizia: sono tre linguaggi che non
 * possono condividere una costante, e ognuno difende un varco diverso.
 *
 *   · il CHECK della migrazione difende la TABELLA, anche da chi scrive da `psql`;
 *   · lo `z.enum` della rotta difende la PORTA HTTP;
 *   · l'array in `filtri-candidature.ts` è l'unico che il BROWSER può leggere,
 *     ed è quello che disegna il menu.
 *
 * Ogni divergenza ha una faccia sua, e nessuna di esse è rumorosa:
 *   · voce nel menu ma non nel CHECK → il database RIFIUTA la scrittura, e la
 *     Direzione vede un'etichetta selezionabile che non si salva mai;
 *   · voce nel CHECK e nel menu ma non nello `z.enum` → 400 «Dati non validi» su
 *     una voce che l'interfaccia offre;
 *   · voce nel CHECK e nello `z.enum` ma non nel menu → una riga etichettata da
 *     `psql` o da una versione più nuova mostra un menu che NON contiene il suo
 *     valore, cioè un `<select>` che si disegna su un'etichetta diversa da quella
 *     che la riga ha davvero. È l'unica delle tre che non dà nemmeno un errore.
 *
 * ── PERCHÉ LA MIGRAZIONE SI CERCA PER SUFFISSO E NON PER NOME ──────────────
 *
 * Perché `apply_migration` sceglie il PROPRIO timestamp: questa stessa migrazione
 * è nata `20260905220500_…` sul disco ed è stata registrata dal database come
 * `20260906013119_…`, e il file è stato rinominato per farli coincidere. Un nome
 * scritto a mano qui dentro sarebbe diventato un percorso inesistente al primo
 * riallineamento — e un lock che non trova il proprio file è un lock verde per
 * cecità. Perciò il file si cerca per suffisso, e «non trovato» (o «trovati due»)
 * è un FALLIMENTO, non un salto.
 *
 * ── LA PROVA CHE IL LETTORE LEGGE ──────────────────────────────────────────
 *
 * Tre parser che ritornano `[]` renderebbero uguali tre elenchi vuoti: sarebbe il
 * modo più elegante di essere verdi senza guardare niente. Il primo test qui sotto
 * pretende che ognuno dei tre abbia trovato QUALCOSA, e che i valori abbiano la
 * forma dei token del vocabolario. Se cade quello, il verde degli altri non vale.
 */

const RADICE = process.cwd()

/** L'array che il BROWSER legge: l'unico modulo che il pannello può importare. */
const FILE_CLIENT = 'src/components/features/admin/iscrizioni/filtri-candidature.ts'
/** Lo `z.enum` che difende la porta HTTP. */
const FILE_ROTTA = 'src/app/api/admin/candidature-insegnanti/etichetta/route.ts'
/** Il pannello, per le etichette a schermo delle cinque voci. */
const FILE_PANNELLO = 'src/components/features/admin/iscrizioni/CandidatureInsegnanti.tsx'

const CARTELLA_MIGRAZIONI = 'supabase/migrations'
/** ⚠️ Il SUFFISSO, mai il nome intero: vedi l'intestazione (`apply_migration`). */
const SUFFISSO_MIGRAZIONE = '_candidature_etichetta_selezione.sql'

/** Il nome della costante che porta il vocabolario, in TypeScript. */
const NOME_COSTANTE = 'ETICHETTE_CANDIDATURA'

const sorgente = (rel: string) => fs.readFileSync(path.join(RADICE, rel), 'utf8')

/** Via i commenti TS: `/*…*\/` e `//…`, lasciando in pace gli `://` degli URL. */
function senzaCommentiTs(testo: string): string {
  return testo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Via i commenti SQL (`--…`): il CHECK vero è l'unico che deve contare. */
function senzaCommentiSql(testo: string): string {
  return testo.replace(/--[^\n]*/g, ' ')
}

/** Le stringhe fra apici dentro un pezzo di sorgente, nell'ordine in cui stanno. */
function stringheDi(pezzo: string): string[] {
  return [...pezzo.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2])
}

/**
 * L'array letterale assegnato a `const <nome> = [ … ]`, come elenco di stringhe.
 *
 * Ritorna `null` quando la costante non c'è: «assente» e «vuota» sono due fatti
 * diversi, e confonderli è il modo in cui questo lock diventerebbe cieco.
 */
function arrayLetterale(testo: string, nome: string): string[] | null {
  const inizio = new RegExp(`\\bconst\\s+${nome}\\s*(?::[^=]+)?=\\s*\\[`).exec(testo)
  if (!inizio) return null
  const apertura = inizio.index + inizio[0].length
  const chiusura = testo.indexOf(']', apertura)
  if (chiusura < 0) return null
  return stringheDi(testo.slice(apertura, chiusura))
}

/**
 * I vocabolari di TUTTI gli `z.enum(...)` di un file, risolti.
 *
 * `z.enum(X)` riceve quasi sempre un IDENTIFICATORE, non un letterale: qui si
 * risolve nello stesso file (`const X = [...] as const`). Fermarsi al nome
 * vorrebbe dire non leggere niente; pretendere il letterale inline vorrebbe dire
 * imporre alla rotta una forma che non ha.
 */
function enumiZod(testo: string): string[][] {
  const fuori: string[][] = []
  for (const m of testo.matchAll(/\bz\s*\.\s*enum\s*\(\s*([^)]*?)\s*\)/g)) {
    const argomento = m[1].trim()
    if (argomento.startsWith('[')) {
      fuori.push(stringheDi(argomento))
      continue
    }
    const risolto = arrayLetterale(testo, argomento.replace(/[^A-Za-z0-9_$]/g, ''))
    if (risolto) fuori.push(risolto)
  }
  return fuori
}

/** I valori ammessi dal CHECK: quelli dentro `etichetta in ( … )`. */
function valoriDelCheck(sql: string): string[] | null {
  const m = /\betichetta\s+in\s*\(([^)]*)\)/i.exec(senzaCommentiSql(sql))
  return m ? stringheDi(m[1]) : null
}

/** L'unico file di migrazione dell'etichetta, cercato per suffisso. */
function fileMigrazione(): string[] {
  return fs
    .readdirSync(path.join(RADICE, CARTELLA_MIGRAZIONI))
    .filter((n) => n.endsWith(SUFFISSO_MIGRAZIONE))
    .sort()
}

// ─── le tre letture, fatte una volta sola ────────────────────────────────────

const MIGRAZIONI = fileMigrazione()
const SORGENTE_CLIENT = senzaCommentiTs(sorgente(FILE_CLIENT))
const SORGENTE_ROTTA = senzaCommentiTs(sorgente(FILE_ROTTA))

const DAL_CLIENT = arrayLetterale(SORGENTE_CLIENT, NOME_COSTANTE)
const ENUMI_ROTTA = enumiZod(SORGENTE_ROTTA)
const DAL_SQL =
  MIGRAZIONI.length === 1
    ? valoriDelCheck(sorgente(path.join(CARTELLA_MIGRAZIONI, MIGRAZIONI[0])))
    : null

/** Confronto per INSIEME e non per ordine: `in (…)` di SQL non ne ha uno. */
const insieme = (v: readonly string[] | null) => [...(v ?? [])].sort()

const COME_SI_CORREGGE =
  'Una voce del vocabolario si aggiunge (o si toglie) in TRE posti, sempre insieme: ' +
  `l'array \`${NOME_COSTANTE}\` di ${FILE_CLIENT}, lo \`z.enum\` di ${FILE_ROTTA} ` +
  `e il CHECK della migrazione ${CARTELLA_MIGRAZIONI}/*${SUFFISSO_MIGRAZIONE}. ` +
  'La migrazione è già applicata in produzione: una voce nuova richiede una migrazione NUOVA ' +
  'che rifaccia il CHECK, non una modifica a quella vecchia.'

describe('LOCK — il vocabolario dell’etichetta di selezione, nelle sue tre lingue', () => {
  it('i tre elenchi si LEGGONO davvero (se cade, il resto è verde per cecità)', () => {
    expect(
      MIGRAZIONI,
      `atteso UN solo file ${CARTELLA_MIGRAZIONI}/*${SUFFISSO_MIGRAZIONE}, trovati: ${MIGRAZIONI.join(', ') || 'nessuno'}. ` +
        'Se la migrazione è stata rinominata o divisa in due, questo lock sta leggendo il file sbagliato.',
    ).toHaveLength(1)
    expect(DAL_CLIENT, `\`${NOME_COSTANTE}\` non trovata in ${FILE_CLIENT}`).not.toBeNull()
    expect(DAL_SQL, `nessun \`etichetta in (…)\` nel CHECK di ${MIGRAZIONI[0]}`).not.toBeNull()
    // Tre elenchi vuoti sarebbero «uguali»: è il modo elegante di non guardare niente.
    expect(DAL_CLIENT?.length ?? 0, "l'array del client è vuoto: il parser non sta leggendo").toBeGreaterThan(1)
    expect(DAL_SQL?.length ?? 0, 'il CHECK non elenca niente: il parser non sta leggendo').toBeGreaterThan(1)
    expect(ENUMI_ROTTA.length, `nessun \`z.enum\` risolto in ${FILE_ROTTA}`).toBeGreaterThan(0)
    // E i valori hanno la forma dei token: se il parser pescasse messaggi o
    // percorsi, qui si vedrebbe invece di passare per caso.
    for (const v of [...(DAL_CLIENT ?? []), ...(DAL_SQL ?? [])]) {
      expect(v, `«${v}» non ha la forma di un token del vocabolario`).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('🔴 lo `z.enum` della rotta dice ESATTAMENTE il vocabolario del client', () => {
    // Ogni enum della rotta che nomina anche UNA voce del vocabolario deve
    // nominarle tutte: è la rete che prende la voce tolta a uno solo dei due
    // schemi (query e corpo) senza dare fastidio a un `z.enum` futuro che parli
    // d'altro — quello non condivide nessuna parola e resta fuori.
    const atteso = insieme(DAL_CLIENT)
    const parlanti = ENUMI_ROTTA.filter((e) => e.some((v) => atteso.includes(v)))
    expect(
      parlanti.length,
      `In ${FILE_ROTTA} nessuno \`z.enum\` nomina il vocabolario delle etichette: ` +
        `la porta HTTP non lo sta più difendendo. ${COME_SI_CORREGGE}`,
    ).toBeGreaterThan(0)
    for (const e of parlanti) {
      expect(insieme(e), `\`z.enum\` divergente in ${FILE_ROTTA}. ${COME_SI_CORREGGE}`).toEqual(atteso)
    }
  })

  it('🔴 il CHECK della migrazione dice ESATTAMENTE lo stesso vocabolario', () => {
    expect(
      insieme(DAL_SQL),
      `Il CHECK di ${MIGRAZIONI[0]} e l'array di ${FILE_CLIENT} divergono: ` +
        'il menu offre una voce che la tabella rifiuta, oppure la tabella ammette un valore ' +
        `che il menu non sa disegnare. ${COME_SI_CORREGGE}`,
    ).toEqual(insieme(DAL_CLIENT))
  })

  it('🔴 e ogni voce ha un NOME a schermo, in italiano e in inglese', () => {
    // Un vocabolario allineato in tre linguaggi ma senza etichetta i18n si vede
    // a schermo come una chiave grezza (o come `undefined` passato a `t()`): il
    // menu resta pieno di token, che è il difetto che il vocabolario chiuso
    // esiste per evitare.
    // La costante è un `Record`, non un array: si legge il suo corpo `{ … }`.
    const corpo = /const\s+CHIAVE_ETICHETTA[^=]*=\s*\{([\s\S]*?)\n\}/.exec(senzaCommentiTs(sorgente(FILE_PANNELLO)))
    expect(corpo, `CHIAVE_ETICHETTA non trovata in ${FILE_PANNELLO}`).not.toBeNull()
    const mappa = new Map<string, string>()
    for (const m of (corpo?.[1] ?? '').matchAll(/([A-Za-z0-9_]+)\s*:\s*'([^']+)'/g)) mappa.set(m[1], m[2])

    const it = JSON.parse(sorgente('messages/it/adminAltro.json')) as Record<string, string>
    const en = JSON.parse(sorgente('messages/en/adminAltro.json')) as Record<string, string>
    for (const voce of DAL_CLIENT ?? []) {
      const chiave = mappa.get(voce)
      expect(chiave, `«${voce}» non ha una chiave i18n in CHIAVE_ETICHETTA (${FILE_PANNELLO})`).toBeTruthy()
      expect(it[chiave as string], `«${chiave}» manca in messages/it/adminAltro.json`).toBeTruthy()
      expect(en[chiave as string], `«${chiave}» manca in messages/en/adminAltro.json`).toBeTruthy()
    }
  })

  it('🔴 i commenti che citano la migrazione la citano col nome che ha DAVVERO', () => {
    // `apply_migration` rinomina, e un commento che punta al nome di ieri manda
    // il prossimo lettore a cercare un file che non c'è — che è la stessa
    // categoria di bugia del «lock» che questo file è venuto a scrivere.
    for (const rel of [FILE_CLIENT, FILE_ROTTA]) {
      const citati = [...sorgente(rel).matchAll(/(\d{8,14}_candidature_etichetta_selezione\.sql)/g)].map((m) => m[1])
      for (const citato of citati) {
        expect(
          citato,
          `${rel} cita la migrazione come «${citato}», ma sul disco si chiama «${MIGRAZIONI[0]}».`,
        ).toBe(MIGRAZIONI[0])
      }
    }
  })
})
