import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_FUNZIONI_MATRICE,
  DEFAULT_SOLLECITI_SEDE_NUOVA,
  DEFAULT_AVVISI_CONFIG,
} from '@/lib/scuole/admin-settings-default'
import {
  DEFAULT_GIUDIZI_SCALA,
  TITOLARIO_DEFAULT,
  TABELLE_CORREDO,
  TABELLE_CORREDO_SOLO_SQL,
} from '@/lib/scuole/corredo-sede'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK — il corredo di una sede nuova esiste in DUE copie: che restino gemelle
//
// Il corredo con cui nasce una sede è scritto due volte, e non per sciatteria:
// la RPC `provisiona_corredo_sede` lo applica in SQL (produzione), il ramo di
// fallback di POST /api/admin/schools lo applica in TypeScript (DB E2E, dove la
// RPC non esiste). Due copie che divergono in silenzio significano una sede che
// nasce diversa a seconda di quale ramo l'ha creata — e il ramo lo decide il
// DB, non chi legge il codice.
//
// Questo lock confronta i JSON dentro le migrazioni con i default TypeScript, e
// l'ELENCO DELLE TABELLE toccate dai due rami. Se cambi uno dei due, il test
// dice subito che manca l'altro.
//
// ─── PERCHÉ LA MIGRAZIONE NON È PIÙ SCRITTA A MANO QUI ────────────────────────
// Fino al 2026-07-31 questo file nominava due migrazioni per nome
// (`20260729114316`, `20260731123052`). Le migrazioni sono immutabili, quindi
// una funzione si aggiorna scrivendone un'altra con `CREATE OR REPLACE`: dal
// momento in cui è arrivata la v3 (`20260731211221`, che aggiunge `avvisi_config`
// al corredo), un lock ancorato al nome avrebbe continuato a confrontare i
// default TypeScript con una versione della RPC che in produzione NON ESISTE PIÙ
// — verde, e cieco proprio sul cambiamento appena fatto. È lo stesso modo di
// invecchiare del difetto che il lock sorveglia.
//
// Perciò la definizione si RISOLVE: fra tutte le migrazioni che dichiarano una
// certa funzione vince quella col timestamp più alto, che è l'unica che la
// produzione stia davvero eseguendo.
// ─────────────────────────────────────────────────────────────────────────────

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')

/** I file `.sql` in ordine di timestamp: è l'ordine di applicazione. */
const MIGRAZIONI = readdirSync(CARTELLA)
  .filter((f) => f.endsWith('.sql'))
  .sort()

const testo = (f: string) => readFileSync(join(CARTELLA, f), 'utf8')

/** Le migrazioni che DEFINISCONO una funzione, dalla più vecchia alla più recente. */
function migrazioniCheDefiniscono(nome: string): string[] {
  return MIGRAZIONI.filter((f) => testo(f).includes(`CREATE OR REPLACE FUNCTION public.${nome}`))
}

/** L'ULTIMA definizione di una funzione: quella che gira in produzione. */
function ultimaDefinizione(nome: string): { file: string; sql: string } {
  const files = migrazioniCheDefiniscono(nome)
  expect(files.length, `nessuna migrazione definisce public.${nome}`).toBeGreaterThan(0)
  const file = files[files.length - 1]
  return { file, sql: testo(file) }
}

/** Il corpo di una funzione plpgsql/sql: da `CREATE … <nome>` al `$$;` che la chiude. */
function corpoFunzione(nome: string): string {
  const { file, sql } = ultimaDefinizione(nome)
  const inizio = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}`)
  expect(inizio, `funzione ${nome} non trovata in ${file}`).toBeGreaterThanOrEqual(0)
  const fine = sql.indexOf('$$;', inizio)
  expect(fine, `chiusura di ${nome} non trovata in ${file}`).toBeGreaterThan(inizio)
  return sql.slice(inizio, fine)
}

describe('lock architettura · default sede nuova: SQL e TypeScript gemelli', () => {
  it('il lock legge l’ULTIMA definizione della RPC, non la prima (autoinganno)', () => {
    // Se questa prova cade, tutte le altre stanno confrontando i default con una
    // versione della funzione che la produzione ha già sostituito.
    const versioni = migrazioniCheDefiniscono('provisiona_corredo_sede')
    expect(
      versioni.length,
      'la RPC del corredo è stata riscritta almeno una volta: il lock deve saper scegliere fra più definizioni',
    ).toBeGreaterThan(1)
    expect(ultimaDefinizione('provisiona_corredo_sede').file).toBe(versioni[versioni.length - 1])
  })

  it('la matrice funzioni della RPC è identica a DEFAULT_FUNZIONI_MATRICE', () => {
    // Il corpo di `admin_settings_default_matrice()`: SELECT '<json>'::jsonb;
    const m = corpoFunzione('admin_settings_default_matrice').match(/SELECT\s+'(\{[\s\S]*?\})'::jsonb;/)
    expect(m, 'blocco SELECT …::jsonb non trovato nella migrazione').not.toBeNull()
    const matriceSql = JSON.parse(m![1]) as Record<string, Record<string, boolean>>
    expect(matriceSql).toEqual(DEFAULT_FUNZIONI_MATRICE)
  })

  it('il corredo riusa la matrice invece di riscriverla (una copia sola, non due)', () => {
    expect(corpoFunzione('provisiona_corredo_sede')).toContain(
      'public.admin_settings_default_matrice()',
    )
  })

  it('la riga admin_settings del corredo porta gli STESSI default del TypeScript', () => {
    // Una sola INSERT, tre default: funzioni, solleciti, avvisi. Si guarda lo
    // statement, non il file, così un default aggiunto altrove non passa per
    // buono.
    const insert = corpoFunzione('provisiona_corredo_sede').match(
      /INSERT INTO public\.admin_settings[\s\S]*?ON CONFLICT/,
    )
    expect(insert, "INSERT di admin_settings non trovato in provisiona_corredo_sede").not.toBeNull()
    const statement = insert![0]

    expect(statement).toContain('public.admin_settings_default_matrice()')
    expect(
      statement,
      'la sede deve nascere con `avvisi_config`: senza, la segreteria non può pubblicare (backend F3)',
    ).toContain('public.avvisi_config_default()')

    const solleciti = statement.match(/'(\{[^']*"enabled"[^']*\})'::jsonb/)
    expect(solleciti, 'valore di solleciti_config non trovato nella INSERT').not.toBeNull()
    expect(JSON.parse(solleciti![1])).toEqual(DEFAULT_SOLLECITI_SEDE_NUOVA)
  })

  it('la configurazione avvisi della RPC è identica a DEFAULT_AVVISI_CONFIG', () => {
    const m = corpoFunzione('avvisi_config_default').match(/SELECT\s+'(\{[\s\S]*?\})'::jsonb;/)
    expect(m, 'JSON della configurazione avvisi non trovato').not.toBeNull()
    expect(JSON.parse(m![1])).toEqual(DEFAULT_AVVISI_CONFIG)
  })

  it('il corredo RIPARA una sede che la riga ce l’ha già ma senza `ruoli_pubblicazione`', () => {
    // È il pezzo che recupera Aversa e Cesa: la loro riga `admin_settings`
    // esiste, quindi la INSERT con `ON CONFLICT DO NOTHING` non le tocca. Senza
    // questo UPDATE la migrazione servirebbe solo alla sede numero quattro,
    // mentre il guasto è sulle sedi di oggi.
    const corpo = corpoFunzione('provisiona_corredo_sede')
    const update = corpo.match(/UPDATE public\.admin_settings[\s\S]*?;/)
    expect(update, 'nessun UPDATE di riparazione: le sedi già esistenti resterebbero senza').not.toBeNull()
    expect(update![0]).toContain('public.avvisi_config_default()')
    // …e solo dove la chiave MANCA: un elenco vuoto è una decisione della
    // Direzione, non un buco da riempire.
    expect(update![0]).toMatch(/NOT\s+jsonb_exists\([\s\S]*?'ruoli_pubblicazione'\)/)
  })

  it('la scala dei giudizi della RPC è identica a DEFAULT_GIUDIZI_SCALA', () => {
    const m = corpoFunzione('giudizi_scala_default').match(/SELECT\s+'(\[[\s\S]*?\])'::jsonb;/)
    expect(m, 'array JSON della scala giudizi non trovato').not.toBeNull()
    expect(JSON.parse(m![1])).toEqual(DEFAULT_GIUDIZI_SCALA.map((g) => ({ ...g })))
  })

  it('il titolario della RPC è identico a TITOLARIO_DEFAULT', () => {
    const m = corpoFunzione('titolario_default').match(/SELECT\s+'(\[[\s\S]*?\])'::jsonb;/)
    expect(m, 'array JSON del titolario non trovato').not.toBeNull()
    expect(JSON.parse(m![1])).toEqual([...TITOLARIO_DEFAULT])
  })

  it('i due rami riempiono le STESSE tabelle (più quelle dichiarate solo-SQL)', () => {
    // È la prova che tiene davvero: un pezzo aggiunto alla RPC e dimenticato nel
    // fallback (o viceversa) fa nascere una sede diversa a seconda del database.
    const corpo = corpoFunzione('provisiona_corredo_sede')
    const tabelleSql = [...corpo.matchAll(/INSERT INTO public\.([a-z_]+)/g)].map((m) => m[1])
    expect(new Set(tabelleSql)).toEqual(
      new Set([...TABELLE_CORREDO, ...TABELLE_CORREDO_SOLO_SQL]),
    )
    // Il fallback non deve dichiarare tabelle che la RPC non tocca.
    for (const t of TABELLE_CORREDO) expect(tabelleSql).toContain(t)
  })

  it('ogni INSERT del corredo è idempotente (ON CONFLICT … DO NOTHING)', () => {
    // La funzione è richiamabile su una sede esistente — è così che Aversa e
    // Cesa sono state recuperate. Un INSERT senza ON CONFLICT la farebbe fallire
    // al secondo giro, e il recupero della terza sede si fermerebbe a metà.
    const corpo = corpoFunzione('provisiona_corredo_sede')
    const blocchi = corpo.split(/INSERT INTO public\./).slice(1)
    expect(blocchi).toHaveLength(TABELLE_CORREDO.length + TABELLE_CORREDO_SOLO_SQL.length)
    for (const b of blocchi) {
      expect(b, `INSERT senza ON CONFLICT: ${b.slice(0, 60)}`).toMatch(/ON CONFLICT[\s\S]*?DO NOTHING/)
    }
  })

  it('provisiona_sede delega il corredo invece di duplicarlo', () => {
    const corpo = corpoFunzione('provisiona_sede')
    expect(corpo).toMatch(/PERFORM public\.provisiona_corredo_sede\(v_id\)/)
    // …e non riscrive a mano nessuna delle tabelle del corredo.
    for (const t of TABELLE_CORREDO) {
      expect(corpo, `provisiona_sede scrive ${t} da sé: è il corredo, va delegato`).not.toContain(
        `INSERT INTO public.${t}`,
      )
    }
  })

  it('il recupero delle sedi esistenti sceglie per INSIEME e lascia fuori il collaudo', () => {
    // Mai per uuid (lock `migrazioni-senza-sede-cablata`), e mai sulla sede
    // finta della CI: `isScuolaE2E` in SQL è il prefisso dell'id o «e2e» nel nome.
    // Si controlla la migrazione che porta l'ULTIMA versione del corredo: è
    // quella il cui backfill ha appena girato sulle sedi vere.
    const sql = ultimaDefinizione('provisiona_corredo_sede').sql
    expect(sql).toMatch(/SELECT public\.provisiona_corredo_sede\(s\.id\)[\s\S]*?FROM public\.schools s/)
    expect(sql).toContain("s.id::text NOT LIKE 'e2e00000%'")
    expect(sql).toContain("s.nome !~* 'e2e'")
  })
})
