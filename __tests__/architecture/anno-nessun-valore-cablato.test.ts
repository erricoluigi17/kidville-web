import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, riga } from '../fixtures/sorgente'

/**
 * COMPITO 4.5.12 · IL CODICE DELL'ISCRIZIONE ALL'ANNO PROSSIMO NON CONOSCE NESSUN ANNO.
 *
 * La PR 4.5 prepara e apre l'anno prossimo. Chi lo scrive è tentato di scrivere «2027/28» nel testo di una voce, `-09-01` nel
 * calcolo della scadenza, `-07-31` nella fine di un anno, o «a settembre» come numero di mese nel generatore delle rette: tutti
 * valori che fra un anno saranno falsi, e che nessun test del 2026 vede. L'anno, il suo inizio, la sua fine e i suoi mesi
 * stanno nel database (`anni_sede`, `anno_regole`, il calendario della sede): il codice li LEGGE, non li conosce.
 *
 * Il lock guarda due insiemi, scritti QUI (un test non deve dipendere dalla storia di git):
 *  - le cinque migrazioni M45 (`MIGRAZIONI`: le cinque della 4.5 e le tre della 4.8), lette come SQL senza commenti;
 *  - i file NUOVI di `src/` della PR (`FILE_NUOVI_SRC`), letti come TypeScript mascherato (commenti spenti, stringhe leggibili).
 *
 * Non ammette, fuori dai commenti: `2027`, `2028` (quindi anche `2027/28`), `-09-01`, `-07-31`, né un numero di mese cablato
 * per le rette (`getMonth()`, `EXTRACT(MONTH …)`, `mese >= 9`, un elenco `[9, 10, 11, 12…]`).
 * Vale anche per una STRINGA: in una funzione SQL, in un messaggio, in un nome. Un valore che sta in una stringa è cablato
 * quanto uno che sta in un'espressione.
 *
 * ─── PERCHÉ NON È CIECO ───────────────────────────────────────────────────────
 * Dichiara quanti file ha letto (8 migrazioni e ≥ 8 file di `src/`, la lista ne ha 31) e ha il suo controllo positivo su
 * sorgenti finti: un `'2027'` dentro una funzione SQL e dentro una funzione TypeScript deve far rosso; un commento no.
 *
 * ─── CHE COSA NON VEDE ────────────────────────────────────────────────────────
 *  - un anno costruito a pezzi (`'20' + '27'`) o letto da un file di dati;
 *  - i file di `src/` che la PR TOCCA ma non crea: li guarda `anno-scrittura-coverage` (nessuna soglia d'anno a mano in `src/`);
 *  - le date piene che sono dati (una versione, un'epoca): in queste liste non ce ne sono, e se ne compare una va spiegata.
 */

const CWD = process.cwd()

/** Le cinque migrazioni della PR 4.5, nell'ordine in cui si applicano (M45d prima di M45c). */
const MIGRAZIONI = [
  'supabase/migrations/20261109035209_anno_tick.sql',
  'supabase/migrations/20261109035213_anno_alunno_in_arrivo.sql',
  'supabase/migrations/20261109035216_anno_listino_moduli_sezioni.sql',
  'supabase/migrations/20261109035219_anno_iscrizione_conferma.sql',
  'supabase/migrations/20261109035223_anno_crm_anno_id.sql',
  // Giro 1 della 4.8 (S26): il lock guarda anche le tre migrazioni del passaggio d'anno e i file nuovi di `src/` della 4.8.
  'supabase/migrations/20261109182420_anno_passaggio_anteprima.sql',
  'supabase/migrations/20261109182421_anno_passaggio_didattica.sql',
  'supabase/migrations/20261109182422_anno_passaggio_conferma.sql',
  // PR 4.9 (chiusura A): il tick degli stati e il passaggio da fare.
  'supabase/migrations/20261112181553_anno_stati_automatici.sql',
  'supabase/migrations/20261112181554_anno_passaggio_da_fare.sql',
] as const

/**
 * I file di `src/` NUOVI della PR 4.5, misurati il 2026-11-09 con `git diff --name-only --diff-filter=A origin/main HEAD -- src`
 * (20 file). È una lista scritta, non calcolata: un file nuovo di un'altra PR non deve cambiare l'esito di questo lock. Un file
 * nuovo della 4.5 che si aggiunge si scrive qui.
 */
const FILE_NUOVI_SRC = [
  'src/app/(dashboard)/admin/students/conferme/ConfermeClient.tsx',
  'src/app/(dashboard)/admin/students/conferme/page.tsx',
  'src/app/api/admin/anni/[annoSedeId]/conferme/non-rinnova/route.ts',
  'src/app/api/admin/anni/[annoSedeId]/conferme/route.ts',
  'src/app/api/admin/anni/[annoSedeId]/moduli-mancanti/route.ts',
  'src/app/api/admin/anni/[annoSedeId]/moduli/route.ts',
  'src/app/api/admin/anni/[annoSedeId]/posti/route.ts',
  'src/app/api/admin/anni/[annoSedeId]/quote/route.ts',
  'src/app/api/admin/anni/[annoSedeId]/sezioni/route.ts',
  'src/app/api/admin/frequenze/[frequenzaId]/moduli/route.ts',
  'src/app/api/admin/iscrizioni/sposta-anno/route.ts',
  'src/app/api/iscrizione/anni/route.ts',
  'src/components/features/admin/settings/AnnoConfigurazione.tsx',
  'src/components/features/crm/schede/SelettoreAnnoScheda.tsx',
  'src/components/features/public/wizard/use-anni-pubblici.ts',
  'src/lib/anno/domanda-anno-prossimo.ts',
  'src/lib/anno/iscrizione-anno.ts',
  'src/lib/anno/lettura-a-blocchi.ts',
  'src/lib/crm/anno-scheda.ts',
  'src/lib/prestampati/firma-per-anno.ts',
  // PR 4.8 (S26): la pagina, le sette route e le due librerie del passaggio d'anno.
  'src/app/(dashboard)/admin/students/passaggio/PassaggioClient.tsx',
  'src/app/(dashboard)/admin/students/passaggio/page.tsx',
  'src/app/api/admin/anni/[annoSedeId]/passaggio/route.ts',
  'src/app/api/admin/anni/[annoSedeId]/passaggio/righe/route.ts',
  'src/app/api/admin/anni/[annoSedeId]/passaggio/docenti/route.ts',
  'src/app/api/admin/anni/[annoSedeId]/passaggio/conferma/route.ts',
  'src/app/api/admin/anni/[annoSedeId]/passaggio/annulla/route.ts',
  'src/app/api/admin/anni/[annoSedeId]/passaggio/conferma-tardiva/route.ts',
  'src/app/api/admin/anni/[annoSedeId]/passaggio/nomi/route.ts',
  'src/lib/anno/passaggio.ts',
  'src/lib/anno/passaggio-risposte.ts',
  // PR 4.9 (chiusura A): il dialogo della correzione e le sue librerie.
  'src/components/features/anno/CorrezioneAnnoDialog.tsx',
  'src/components/features/anno/useCorrezioneAnno.tsx',
  'src/lib/anno/anno-della-riga.ts',
  'src/lib/anno/correzione.ts',
  'src/lib/ui/correzione-fetch.ts',
] as const

const MINIMO_MIGRAZIONI = 8
const MINIMO_FILE_SRC = 8

interface Divieto { nome: string; re: RegExp }

/** I valori vietati, uguali per SQL e TypeScript. L'anno ha il lookbehind: `20271` non è l'anno 2027. */
const VALORI: Divieto[] = [
  { nome: '2027', re: /(?<!\d)2027(?!\d)/g },
  { nome: '2028', re: /(?<!\d)2028(?!\d)/g },
  { nome: '-09-01', re: /-09-01/g },
  { nome: '-07-31', re: /-07-31/g },
]

/** I numeri di mese cablati per le rette, nelle due lingue. */
const MESI_SQL: Divieto[] = [
  { nome: 'EXTRACT(MONTH …)', re: /\bextract\s*\(\s*month\b/gi },
  { nome: "date_part('month', …)", re: /\bdate_part\s*\(\s*'month'/gi },
  { nome: 'mese <op> numero', re: /\b(?:mese|month)\s*(?:>=|<=|<>|!=|=|>|<)\s*\d{1,2}\b/gi },
  { nome: 'generate_series di numeri di mese', re: /\bgenerate_series\s*\(\s*(?:[1-9]|1[0-2])\s*,\s*(?:[1-9]|1[0-2])\b/gi },
]
const MESI_TS: Divieto[] = [
  { nome: 'getMonth()', re: /\.getMonth\s*\(/g },
  { nome: 'getUTCMonth()', re: /\.getUTCMonth\s*\(/g },
  { nome: 'mese <op> numero', re: /(?<![\w$.])(?:mese|meseOggi|month)\s*(?:>=|<=|===|!==|>|<)\s*\d{1,2}\b/g },
  { nome: 'elenco di mesi [9, 10, 11, …]', re: /\[\s*(?:9|10)\s*,\s*(?:10|11)\s*,\s*(?:11|12)\b/g },
]

/** SQL senza commenti (di riga e di blocco), con la lunghezza invariata: gli indici restano quelli veri. */
function sqlSenzaCommenti(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
}

interface Trovato { file: string; riga: number; valore: string }

function cerca(file: string, originale: string, pulito: string, divieti: Divieto[]): Trovato[] {
  const out: Trovato[] = []
  for (const d of divieti) {
    d.re.lastIndex = 0
    let h: RegExpExecArray | null
    while ((h = d.re.exec(pulito)) !== null) out.push({ file, riga: riga(originale, h.index), valore: d.nome })
  }
  return out
}

const trovatiSql = (file: string, testo: string) => cerca(file, testo, sqlSenzaCommenti(testo), [...VALORI, ...MESI_SQL])
const trovatiTs = (file: string, testo: string) => cerca(file, testo, mascheraSorgente(testo).senzaCommenti, [...VALORI, ...MESI_TS])

const descrivi = (v: Trovato[]) => v.map((t) => `${t.file}:${t.riga} — ${t.valore}`)
const elenco = (v: string[]) => (v.length ? '\n  - ' + v.join('\n  - ') : '')

function violazioniMinimi(migrazioni: number, fileSrc: number): string[] {
  const out: string[] = []
  if (migrazioni < MINIMO_MIGRAZIONI) out.push(`migrazioni M45 lette: ${migrazioni} < minimo ${MINIMO_MIGRAZIONI}`)
  if (fileSrc < MINIMO_FILE_SRC) out.push(`file nuovi di src/ letti: ${fileSrc} < minimo ${MINIMO_FILE_SRC}`)
  return out
}

const LETTI_SQL = MIGRAZIONI.filter((f) => fs.existsSync(path.join(CWD, f)))
const LETTI_SRC = FILE_NUOVI_SRC.filter((f) => fs.existsSync(path.join(CWD, f)))
const leggi = (f: string) => fs.readFileSync(path.join(CWD, f), 'utf8')

describe('anno-nessun-valore-cablato — il controllo positivo, su sorgenti finti', () => {
  it('SQL: un anno, una data di confine o un mese in una funzione fanno rosso; in un commento no', () => {
    const funzione = (corpo: string) => `CREATE OR REPLACE FUNCTION public.f() RETURNS text LANGUAGE sql AS $$ ${corpo} $$;`
    expect(trovatiSql('x.sql', funzione("SELECT '2027'"))).toHaveLength(1)
    expect(trovatiSql('x.sql', funzione("SELECT 'Iscrizione 2027/28'"))).toHaveLength(1)
    expect(trovatiSql('x.sql', funzione("SELECT '2028'"))).toHaveLength(1)
    expect(trovatiSql('x.sql', funzione("SELECT d + date '2026-09-01'")).map((t) => t.valore)).toEqual(['-09-01'])
    expect(trovatiSql('x.sql', funzione("SELECT '2026-07-31'::date")).map((t) => t.valore)).toEqual(['-07-31'])
    expect(trovatiSql('x.sql', funzione('SELECT extract(month FROM d)')).map((t) => t.valore)).toEqual(['EXTRACT(MONTH …)'])
    expect(trovatiSql('x.sql', funzione('SELECT 1 WHERE mese >= 9')).map((t) => t.valore)).toEqual(['mese <op> numero'])
    expect(trovatiSql('x.sql', "-- l'anno 2027/28 parte il 2027-09-01\n/* e finisce il 2028-07-31 */\nSELECT 1")).toEqual([])
  })

  it('TypeScript: un anno o una soglia in una funzione fanno rosso, anche dentro una stringa; in un commento no', () => {
    expect(trovatiTs('x.ts', "export function f() { return '2027' }")).toHaveLength(1)
    expect(trovatiTs('x.ts', 'export const messaggio = `Iscrizione 2027/28`')).toHaveLength(1)
    expect(trovatiTs('x.ts', "const scade = `${anno}-09-01`").map((t) => t.valore)).toEqual(['-09-01'])
    expect(trovatiTs('x.ts', "const fine = anno + '-07-31'").map((t) => t.valore)).toEqual(['-07-31'])
    expect(trovatiTs('x.ts', 'const m = d.getMonth()').map((t) => t.valore)).toEqual(['getMonth()'])
    expect(trovatiTs('x.ts', 'if (mese >= 9) return 1').map((t) => t.valore)).toEqual(['mese <op> numero'])
    expect(trovatiTs('x.ts', 'const MESI = [9, 10, 11, 12, 1, 2]').map((t) => t.valore)).toEqual(['elenco di mesi [9, 10, 11, …]'])
    expect(trovatiTs('x.ts', "// l'anno 2027/28 e il 2027-09-01\n/* 2028-07-31 */\nconst a = 1")).toEqual([])
  })

  it('un numero che contiene un anno non scatta (`20271`, `12027`)', () => {
    expect(trovatiTs('x.ts', 'const n = 20271 + 12027')).toEqual([])
  })

  it('zero file letti non passano per verdi: il minimo li ferma', () => {
    expect(violazioniMinimi(0, 0)).toHaveLength(2)
    expect(violazioniMinimi(8, 8)).toEqual([])
    expect(violazioniMinimi(7, 20)).toHaveLength(1)
  })
})

describe('anno-nessun-valore-cablato — le cinque migrazioni M45 e i file nuovi di src/', () => {
  it('ha letto tutto ciò che deve: 8 migrazioni e almeno 8 file di src/ (la lista ne ha 31)', () => {
    expect(violazioniMinimi(LETTI_SQL.length, LETTI_SRC.length)).toEqual([])
    // la lista non perde file in silenzio: ogni voce deve esistere (un file spostato va aggiornato qui)
    const mancanti = [...MIGRAZIONI, ...FILE_NUOVI_SRC].filter((f) => !fs.existsSync(path.join(CWD, f)))
    expect(mancanti, 'file della lista che non esistono più: aggiornala' + elenco(mancanti)).toEqual([])
  })

  it('le migrazioni non scrivono nessun anno, nessun confine d’anno e nessun mese: li leggono dal database', () => {
    const v = LETTI_SQL.flatMap((f) => descrivi(trovatiSql(f, leggi(f))))
    expect(
      v,
      `Valori d'anno cablati nelle migrazioni M45 (${v.length}). L'anno, il suo inizio e la sua fine stanno in anni_sede / anno_regole: ` +
        `la funzione li legge, non li conosce.` + elenco(v),
    ).toEqual([])
  })

  it('i file nuovi di src/ non scrivono nessun anno, nessun confine d’anno e nessun mese', () => {
    const v = LETTI_SRC.flatMap((f) => descrivi(trovatiTs(f, leggi(f))))
    expect(
      v,
      `Valori d'anno cablati nei file nuovi di src/ (${v.length}). L'anno si legge dalla sede (lib/anno, lib/anno-scolastico.ts), ` +
        `non si scrive.` + elenco(v),
    ).toEqual([])
  })
})
