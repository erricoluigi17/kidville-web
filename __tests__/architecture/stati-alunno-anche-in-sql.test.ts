import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATI_NON_PIU_ISCRITTO, STATO_SOSPESO } from '@/lib/alunni/stato'

// =============================================================================
// LA STESSA REGOLA VIVE UNA TERZA VOLTA, E NESSUNO LA GUARDAVA: IN SQL.
//
// ─── IL DIFETTO, misurato in produzione il 2026-08-13 ────────────────────────
//
// `src/lib/alunni/stato.ts` esiste per abolire una NEGAZIONE: «non più iscritto»
// non è «tutto tranne iscritto», perché un bambino soltanto SOSPESO frequenta, e
// una negazione lo tirerebbe dentro insieme a ogni stato che qualcuno aggiungerà
// domani. Quel modulo però conta soltanto i filtri scritti in `src/`. L'automa
// notturno `presenze_giustificazioni_retention_tick` decideva così:
//
//     NOT EXISTS (… AND COALESCE(a.stato,'iscritto') = 'iscritto')
//
// cioè con la negazione. Eseguito in sola lettura sul database di produzione:
//
//     stato «sospeso»    → azzera = TRUE   ← un bambino che FREQUENTA
//     stato «trasferito» → azzera = TRUE   ← uno stato mai classificato
//
// e quel che azzerava è `presenze.giustificazione_testo` e `presenze.note_appello`:
// testo libero di natura SANITARIA su un minore. La migrazione che l'aveva scritto
// dichiarava per iscritto l'intenzione opposta («davanti a uno stato che non si sa
// leggere si sceglie di NON cancellare»): il codice faceva il contrario del suo
// stesso commento, e nessun test poteva accorgersene perché nessun test guarda
// dentro l'SQL.
//
// ─── COSA TIENE FERMO QUESTO FILE ────────────────────────────────────────────
//
//  1. l'ALLOWLIST SQL (`public.stati_alunno_non_piu_iscritto()`) dice esattamente
//     ciò che dice `STATI_NON_PIU_ISCRITTO` in TypeScript. Sono due copie perché
//     l'SQL non può importare un modulo TS: questo è il posto in cui si accorgono
//     di essere divergenti;
//  2. l'ULTIMA definizione dell'automa usa quell'allowlist e NON la negazione.
//     Si guarda l'ultima e non tutte: i file di migrazione sono STORIA, e quelli
//     vecchi contengono per forza il predicato di allora. Un lock che li vietasse
//     sarebbe rosso per sempre, cioè andrebbe spento — che è il modo in cui i lock
//     muoiono.
// =============================================================================

const RADICE = process.cwd()
const CARTELLA = join(RADICE, 'supabase', 'migrations')

/** I file di migrazione in ordine di applicazione (il nome porta la `version`). */
function migrazioni(): { nome: string; sql: string }[] {
  return readdirSync(CARTELLA)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((nome) => ({ nome, sql: readFileSync(join(CARTELLA, nome), 'utf8') }))
}

/** L'ultima migrazione che DEFINISCE la funzione indicata, o `null`. */
function ultimaDefinizione(funzione: string): { nome: string; sql: string } | null {
  const definisce = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${funzione}\\s*\\(`, 'i')
  const trovate = migrazioni().filter((m) => definisce.test(m.sql))
  return trovate.length > 0 ? trovate[trovate.length - 1] : null
}

/**
 * Le voci di un `ARRAY['a','b']::text[]` dentro il corpo di una funzione SQL.
 *
 * Si legge il CORPO e non tutto il file: le stesse stringhe compaiono anche nei
 * commenti della testata (che citano la misura), e un estrattore che le prendesse
 * di lì direbbe «allineato» leggendo una spiegazione invece di una regola.
 */
function allowlistSql(sql: string): string[] | null {
  const corpo = sql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.stati_alunno_non_piu_iscritto[\s\S]*?\$\$([\s\S]*?)\$\$/i)
  if (!corpo) return null
  const array = corpo[1].match(/ARRAY\s*\[([^\]]*)\]/i)
  if (!array) return null
  return array[1]
    .split(',')
    .map((v) => v.trim().replace(/^'|'$/g, ''))
    .filter((v) => v !== '')
}

/**
 * Il file senza i commenti `--`.
 *
 * ⚠️ Serve, e il perché è misurato: la migrazione che CORREGGE la negazione la
 * CITA nella sua testata, per spiegare che cosa stava sbagliando. Un lock che
 * leggesse anche i commenti la troverebbe lì e chiamerebbe difetto la sua stessa
 * correzione — cioè renderebbe conveniente scrivere migrazioni che non spiegano
 * niente. La regola sta nel codice; la prosa è un'altra cosa.
 */
function senzaCommenti(sql: string): string {
  return sql
    .split('\n')
    .map((riga) => riga.replace(/--.*$/, ''))
    .join('\n')
}

/** Il predicato che l'automa NON deve più usare per decidere «non più iscritto». */
const NEGAZIONE = /COALESCE\s*\(\s*a\.stato\s*,\s*'iscritto'\s*\)\s*=\s*'iscritto'/i

describe('lock architettura · l’allowlist degli stati vale anche in SQL', () => {
  it('la funzione SQL esiste e dice ESATTAMENTE quello che dice TypeScript', () => {
    const file = ultimaDefinizione('stati_alunno_non_piu_iscritto')
    expect(
      file,
      'nessuna migrazione definisce `public.stati_alunno_non_piu_iscritto()`: ' +
        'l’allowlist è tornata a essere scritta a mano dentro i predicati.',
    ).not.toBeNull()

    const sql = allowlistSql(file!.sql)
    expect(sql, `non riesco a leggere l’ARRAY in ${file!.nome}`).not.toBeNull()
    expect(
      [...sql!].sort(),
      `L’allowlist SQL (${file!.nome}) e STATI_NON_PIU_ISCRITTO (src/lib/alunni/stato.ts) ` +
        'sono divergenti. Sono la stessa regola in due linguaggi: chi ne sposta una ' +
        'sposti anche l’altra, con una migrazione — altrimenti un bambino è «non più ' +
        'iscritto» per l’applicazione e «iscritto» per l’automa che cancella, o viceversa.',
    ).toEqual([...STATI_NON_PIU_ISCRITTO].sort())
  })

  it('⚠️ «sospeso» NON è nell’allowlist SQL: è un bambino che frequenta', () => {
    // Il caso preciso del difetto, scritto per nome. Se un giorno qualcuno
    // spostasse `sospeso` dalla parte non protetta, il test qui sopra resterebbe
    // verde (le due copie sarebbero comunque allineate) e questo diventerebbe
    // rosso — che è il posto giusto in cui fermarsi e decidere.
    const file = ultimaDefinizione('stati_alunno_non_piu_iscritto')!
    expect(allowlistSql(file.sql)).not.toContain(STATO_SOSPESO)
  })

  it('l’automa della retention decide con l’ALLOWLIST, non con la negazione', () => {
    const file = ultimaDefinizione('presenze_giustificazioni_retention_tick')
    expect(file, 'nessuna migrazione definisce `presenze_giustificazioni_retention_tick`').not.toBeNull()

    expect(
      file!.sql.includes('stati_alunno_non_piu_iscritto'),
      `${file!.nome} ridefinisce l’automa senza passare dall’allowlist: la regola è ` +
        'tornata a vivere in due posti.',
    ).toBe(true)
    expect(
      NEGAZIONE.test(senzaCommenti(file!.sql)),
      `${file!.nome} decide di nuovo con «tutto tranne iscritto». È la forma che azzerava ` +
        'ogni notte il motivo di assenza (testo sanitario di un minore) di un bambino ' +
        'soltanto SOSPESO, che frequenta — misurato in produzione il 2026-08-13.',
    ).toBe(false)
  })

  it('CONTROLLO POSITIVO: i due riconoscitori vedono davvero ciò che cercano', () => {
    // Senza questa prova, un `allowlistSql` che tornasse sempre `null` e una
    // `NEGAZIONE` che non combaciasse mai lascerebbero il lock verde per sempre —
    // che è esattamente come è nato il difetto che sta chiudendo.
    const finta = "CREATE OR REPLACE FUNCTION public.stati_alunno_non_piu_iscritto()\nRETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY['ritirato','trasferito']::text[] $$;"
    expect(allowlistSql(finta)).toEqual(['ritirato', 'trasferito'])
    expect(allowlistSql('CREATE OR REPLACE FUNCTION public.altra_cosa() …')).toBeNull()

    expect(NEGAZIONE.test("AND COALESCE(a.stato, 'iscritto') = 'iscritto'")).toBe(true)
    expect(NEGAZIONE.test("AND COALESCE(a.stato, 'iscritto') = ANY (public.stati_alunno_non_piu_iscritto())")).toBe(false)
    // …e la citazione DENTRO un commento non conta come regola.
    expect(NEGAZIONE.test(senzaCommenti("-- qui c'era COALESCE(a.stato, 'iscritto') = 'iscritto'"))).toBe(false)
    expect(senzaCommenti("SELECT 1; -- nota").trim()).toBe('SELECT 1;')
  })

  it('e la migrazione STORICA con la negazione resta al suo posto, senza far rosso', () => {
    // I file di migrazione sono storia e non si riscrivono: `20260807211157` e
    // `20260808042814` contengono ancora il predicato di allora, ed è giusto così.
    // Questa riga lo dichiara, perché un lettore che trovasse quella stringa
    // grepando il repo penserebbe che il difetto è ancora aperto.
    const storiche = migrazioni().filter((m) => NEGAZIONE.test(senzaCommenti(m.sql)))
    expect(storiche.length, 'nessun file storico contiene più la negazione: aggiorna questa nota').toBeGreaterThan(0)
    const ultima = ultimaDefinizione('presenze_giustificazioni_retention_tick')!
    expect(
      storiche.map((m) => m.nome),
      'la negazione è ricomparsa nell’ULTIMA definizione dell’automa, non solo nello storico',
    ).not.toContain(ultima.nome)
  })
})
