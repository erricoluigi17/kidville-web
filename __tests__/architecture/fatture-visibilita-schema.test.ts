import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRAZIONE = join(
  process.cwd(),
  'supabase/migrations/20260916120000_fatture_visibilita_snapshot.sql',
)
const SQL = existsSync(MIGRAZIONE) ? readFileSync(MIGRAZIONE, 'utf8') : ''

const senzaCommenti = SQL
  .replace(/--.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')

describe('schema fatture visibili ai genitori', () => {
  it('versiona una migrazione dedicata senza dedurre o riscrivere lo storico', () => {
    expect(existsSync(MIGRAZIONE), 'manca la migrazione dello snapshot di visibilità').toBe(true)
    expect(senzaCommenti).not.toMatch(/\bupdate\s+public\.fatture_emesse\b/i)
  })

  it('aggiunge la modalità nullable alla fattura e la data di attivazione per sede', () => {
    expect(senzaCommenti).toMatch(
      /alter table public\.fatture_emesse add column if not exists modalita_emissione text/i,
    )
    expect(senzaCommenti).toMatch(
      /check\s*\(\s*modalita_emissione\s+is\s+null\s+or\s+modalita_emissione\s+in\s*\(\s*'ordinaria'\s*,\s*'quote_separate'\s*\)\s*\)/i,
    )
    expect(senzaCommenti).toMatch(
      /alter table public\.admin_settings add column if not exists fatture_visibilita_attiva_il timestamptz/i,
    )
    expect(senzaCommenti).not.toMatch(/fatture_visibilita_attiva_il\s+timestamptz\s+not\s+null/i)
    expect(senzaCommenti).not.toMatch(/fatture_visibilita_attiva_il\s+timestamptz\s+default/i)
  })

  it('registra la revisione 1:1 con vocabolario, riferimenti e quota coerenti', () => {
    expect(senzaCommenti).toMatch(
      /create table if not exists public\.fatture_visibilita_revisioni\s*\([\s\S]*?fattura_id uuid primary key references public\.fatture_emesse\s*\(\s*id\s*\)/i,
    )
    expect(senzaCommenti).toMatch(
      /modalita text not null[\s\S]*?check\s*\(\s*modalita\s+in\s*\(\s*'ordinaria'\s*,\s*'quote_separate'\s*,\s*'irrisolta'\s*\)\s*\)/i,
    )
    expect(senzaCommenti).toMatch(
      /parent_registry_id uuid references public\.parents\s*\(\s*id\s*\)/i,
    )
    expect(senzaCommenti).toMatch(
      /verificata_da uuid references public\.utenti\s*\(\s*id\s*\)/i,
    )
    expect(senzaCommenti).toMatch(/verificata_il timestamptz/i)
    expect(senzaCommenti).toMatch(
      /check\s*\(\s*modalita\s*<>\s*'quote_separate'\s+or\s+parent_registry_id\s+is\s+not\s+null\s*\)/i,
    )
  })

  it('chiude la tabella ai client e concede al service role la bozza correggibile', () => {
    expect(senzaCommenti).toMatch(
      /alter table public\.fatture_visibilita_revisioni enable row level security/i,
    )
    expect(senzaCommenti).toMatch(
      /revoke all on table public\.fatture_visibilita_revisioni from public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role/i,
    )
    expect(senzaCommenti).toMatch(
      /grant select\s*,\s*insert\s*,\s*update on table public\.fatture_visibilita_revisioni to service_role/i,
    )
    expect(senzaCommenti).not.toMatch(/create policy\s+\S+\s+on\s+public\.fatture_visibilita_revisioni/i)
  })

  it('rifiuta lo snapshot nuovo nullo quando il flag della sede è valorizzato', () => {
    expect(senzaCommenti).toMatch(/if tg_op = 'insert'[\s\S]*?new\.modalita_emissione is null/i)
    expect(senzaCommenti).toMatch(
      /from public\.admin_settings[\s\S]*?scuola_id\s*=\s*new\.scuola_id[\s\S]*?fatture_visibilita_attiva_il\s+is\s+not\s+null/i,
    )
    expect(senzaCommenti).not.toMatch(/fatture_visibilita_attiva_il\s*<=\s*now\s*\(\s*\)/i)
  })

  it('rende immutabile lo snapshot, inclusa l’identità del genitore', () => {
    expect(senzaCommenti).toMatch(
      /new\.modalita_emissione is distinct from old\.modalita_emissione[\s\S]*?new\.parent_registry_id is distinct from old\.parent_registry_id/i,
    )
    expect(senzaCommenti).toMatch(/old\.modalita_emissione is null/i)
    expect(senzaCommenti).toMatch(/new\.modalita_emissione is not null/i)
    expect(senzaCommenti).toMatch(
      /current_setting\s*\(\s*'app\.fatture_visibilita_finalizza_storico'\s*,\s*true\s*\)/i,
    )
    expect(senzaCommenti).toMatch(/current_user\s*=\s*'service_role'/i)
    expect(senzaCommenti).not.toMatch(/auth\.role\s*\(/i)
    expect(senzaCommenti).toMatch(/set search_path\s*=\s*public\s*,\s*pg_temp/i)
  })
})
