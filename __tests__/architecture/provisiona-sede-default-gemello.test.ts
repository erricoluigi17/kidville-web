import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_FUNZIONI_MATRICE,
  DEFAULT_SOLLECITI_SEDE_NUOVA,
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
// Perché due file di migrazione. Le migrazioni sono immutabili: la matrice
// delle funzioni è nata il 29/07 e vive ancora lì (la v2 la riusa chiamando
// `admin_settings_default_matrice()`), il resto del corredo è del 31/07.
// ─────────────────────────────────────────────────────────────────────────────

const migrazione = (nome: string) =>
  readFileSync(join(process.cwd(), 'supabase', 'migrations', nome), 'utf8')

const SQL_MATRICE = migrazione('20260729114316_provisiona_sede_admin_settings.sql')
const SQL_CORREDO = migrazione('20260731123052_provisiona_sede_v2.sql')

/** Il corpo di una funzione plpgsql/sql: da `CREATE … <nome>` al `$$;` che la chiude. */
function corpoFunzione(sql: string, nome: string): string {
  const inizio = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}`)
  expect(inizio, `funzione ${nome} non trovata nella migrazione`).toBeGreaterThanOrEqual(0)
  const fine = sql.indexOf('$$;', inizio)
  expect(fine, `chiusura di ${nome} non trovata`).toBeGreaterThan(inizio)
  return sql.slice(inizio, fine)
}

describe('lock architettura · default sede nuova: SQL e TypeScript gemelli', () => {
  it('la matrice funzioni della RPC è identica a DEFAULT_FUNZIONI_MATRICE', () => {
    // Il corpo di `admin_settings_default_matrice()`: SELECT '<json>'::jsonb;
    const m = SQL_MATRICE.match(/SELECT\s+'(\{[\s\S]*?\})'::jsonb;\s*\$\$/)
    expect(m, 'blocco SELECT …::jsonb non trovato nella migrazione').not.toBeNull()
    const matriceSql = JSON.parse(m![1]) as Record<string, Record<string, boolean>>
    expect(matriceSql).toEqual(DEFAULT_FUNZIONI_MATRICE)
  })

  it('la v2 riusa la matrice invece di riscriverla (una copia sola, non due)', () => {
    const corpo = corpoFunzione(SQL_CORREDO, 'provisiona_corredo_sede')
    expect(corpo).toContain('public.admin_settings_default_matrice()')
  })

  it('i solleciti del corredo nascono con lo stesso valore del default TypeScript', () => {
    const m = SQL_CORREDO.match(
      /VALUES \(p_scuola_id, public\.admin_settings_default_matrice\(\), '([^']+)'::jsonb\)/,
    )
    expect(m, "INSERT di admin_settings non trovato in provisiona_corredo_sede").not.toBeNull()
    expect(JSON.parse(m![1])).toEqual(DEFAULT_SOLLECITI_SEDE_NUOVA)
  })

  it('la scala dei giudizi della RPC è identica a DEFAULT_GIUDIZI_SCALA', () => {
    const corpo = corpoFunzione(SQL_CORREDO, 'giudizi_scala_default')
    const m = corpo.match(/SELECT\s+'(\[[\s\S]*?\])'::jsonb;/)
    expect(m, 'array JSON della scala giudizi non trovato').not.toBeNull()
    expect(JSON.parse(m![1])).toEqual(DEFAULT_GIUDIZI_SCALA.map((g) => ({ ...g })))
  })

  it('il titolario della RPC è identico a TITOLARIO_DEFAULT', () => {
    const corpo = corpoFunzione(SQL_CORREDO, 'titolario_default')
    const m = corpo.match(/SELECT\s+'(\[[\s\S]*?\])'::jsonb;/)
    expect(m, 'array JSON del titolario non trovato').not.toBeNull()
    expect(JSON.parse(m![1])).toEqual([...TITOLARIO_DEFAULT])
  })

  it('i due rami riempiono le STESSE tabelle (più quelle dichiarate solo-SQL)', () => {
    // È la prova che tiene davvero: un pezzo aggiunto alla RPC e dimenticato nel
    // fallback (o viceversa) fa nascere una sede diversa a seconda del database.
    const corpo = corpoFunzione(SQL_CORREDO, 'provisiona_corredo_sede')
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
    const corpo = corpoFunzione(SQL_CORREDO, 'provisiona_corredo_sede')
    const blocchi = corpo.split(/INSERT INTO public\./).slice(1)
    expect(blocchi).toHaveLength(TABELLE_CORREDO.length + TABELLE_CORREDO_SOLO_SQL.length)
    for (const b of blocchi) {
      expect(b, `INSERT senza ON CONFLICT: ${b.slice(0, 60)}`).toMatch(/ON CONFLICT[\s\S]*?DO NOTHING/)
    }
  })

  it('provisiona_sede delega il corredo invece di duplicarlo', () => {
    const corpo = corpoFunzione(SQL_CORREDO, 'provisiona_sede')
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
    expect(SQL_CORREDO).toMatch(/SELECT public\.provisiona_corredo_sede\(s\.id\)[\s\S]*?FROM public\.schools s/)
    expect(SQL_CORREDO).toContain("s.id::text NOT LIKE 'e2e00000%'")
    expect(SQL_CORREDO).toContain("s.nome !~* 'e2e'")
  })
})
