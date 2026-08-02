import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK · nessuna tabella di collaudo sopravvive nel database
//
// IL DIFETTO. `public.test_table` — due colonne, zero righe, RLS attiva e nessuna
// policy — stava nel database di PRODUZIONE dal primo giorno, dentro il baseline.
// Non faceva niente e non rompeva niente: per questo era ancora lì un anno dopo.
//
// PERCHÉ NON È INNOCUA. Una tabella vuota che nessuno rivendica è un invito: prima
// o poi qualcuno ci scrive «giusto una prova», e da quel momento c'è un pezzo di
// dato in produzione fuori da ogni inventario — fuori dalla mappa dello schema,
// fuori dall'audit per sede, fuori dalle regole di conservazione. In un database
// che contiene i codici fiscali di 152 minori, «non sappiamo cosa c'è dentro» è il
// difetto, anche quando dentro non c'è niente.
//
// COME FUNZIONA. Ricostruisce dalle migrazioni le tabelle vive (CREATE TABLE meno
// DROP TABLE) e fallisce se ne resta una che si chiama come un residuo di prova.
// Il nome è l'unico segnale disponibile, ed è volutamente stretto: l'underscore è
// obbligatorio, così `tempo_scuola` — che è una tabella vera — non viene scambiata
// per una temporanea.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

/** Nomi che dichiarano da soli di non essere strutture definitive. */
const DA_RESIDUO = [
  /^(test|tmp|temp|prova|dummy|scratch|backup|copia)_/i,
  /_(bak|backup|old|copy|copia|tmp|temp|deprecated)$/i,
]

/**
 * Eccezioni: una tabella che SEMBRA un residuo ma non lo è si dichiara qui, con la
 * ragione accanto. Vuota, e sarebbe bene che restasse tale.
 */
const ALLOWLIST: Record<string, string> = {}

const senzaSchema = (t: string) => (t.includes('.') ? t.split('.').pop()! : t).toLowerCase()

/** Le tabelle vive secondo le migrazioni, in ordine di applicazione. */
function tabelleVive(): Map<string, string> {
  const vive = new Map<string, string>() // nome → file che l'ha creata
  const re =
    /(CREATE|DROP)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+|IF\s+EXISTS\s+)?((?:[A-Za-z_][\w$]*\.)?[A-Za-z_][\w$]*)/gi

  for (const file of readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRAZIONI, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
    for (const m of sql.matchAll(re)) {
      const nome = senzaSchema(m[2])
      if (m[1].toUpperCase() === 'DROP') vive.delete(nome)
      else vive.set(nome, file)
    }
  }
  return vive
}

const VIVE = tabelleVive()

describe('lock architettura · residui di collaudo nel database', () => {
  it('il parser vede davvero le tabelle delle migrazioni (sanity)', () => {
    // Senza questo, un parser rotto renderebbe il lock verde su un elenco vuoto.
    expect(VIVE.size).toBeGreaterThan(80)
    for (const attesa of ['pagamenti', 'alunni', 'presenze']) {
      expect(VIVE.has(attesa), `manca ${attesa}: il parser non sta leggendo le migrazioni`).toBe(true)
    }
  })

  it('nessuna tabella con nome da residuo di prova è ancora viva', () => {
    const colpevoli = [...VIVE.entries()]
      .filter(([nome]) => DA_RESIDUO.some((re) => re.test(nome)))
      .filter(([nome]) => !ALLOWLIST[nome])
      .map(([nome, file]) => `${nome} (creata in ${file})`)
    expect(
      colpevoli,
      'Tabelle di prova ancora presenti. Droppale con una migrazione dedicata (dopo aver ' +
        'verificato che siano vuote e che nessuno le referenzi), oppure — se il nome inganna ' +
        'e la tabella è vera — dichiarale nell\'ALLOWLIST di questo file CON LA RAGIONE.',
    ).toEqual([])
  })

  it('ogni voce dell’ALLOWLIST ha una ragione scritta, non un segnaposto', () => {
    for (const [nome, motivo] of Object.entries(ALLOWLIST)) {
      expect(motivo.length, `L'eccezione «${nome}» non ha una ragione scritta.`).toBeGreaterThan(30)
    }
  })
})
