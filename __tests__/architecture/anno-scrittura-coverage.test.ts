import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineParentesi, fileSorgente, riga, type SorgenteMascherato } from '../fixtures/sorgente'
import { ESENTI } from '@/lib/anno/frequenze'
import { COPPIE_OBLIO_AMMESSE } from '@/lib/gdpr/oblio-registro'

/**
 * COVERAGE-LOCK della regola di scrittura dell'anno scolastico (PR 3, Compito 3.9; specifica §4.4.6, §4.5, §4.16,
 * §4.17, §4.19, §4.20).
 *
 * Il registro dell'anno ha 46 tabelle. Dalla PR 3 ogni scrittura che le riguarda deve dichiarare l'anno (o passare
 * da un'unica strada autorizzata), e questo lock tiene ferme le sette cose che nessun test di route vede da solo:
 *
 *  1. lo SCANNER, provato su sorgenti finti (senza di lui il lock sarebbe verde anche se non leggesse niente);
 *  2. le scritture sulle tabelle DICHIARATE portano l'anno (`anno_id`) e lo ricavano da un helper;
 *  3. la ZONA OBLIO scrive il registro solo da `scriviOblio` / `svuotaOblio` / `.rpc`;
 *  4. la DOPPIA SCRITTURA `alunni` → `frequenze` passa da `scriviFrequenza` (o è in `ESENTI`, col suo motivo);
 *  5. nessun CALCOLO DELL'ANNO A MANO fuori dal modulo dell'anno (con l'elenco di quelli di oggi e il tetto);
 *  6. l'SQL: ogni funzione che scrive il registro ha una classe, e le funzioni di oblio hanno l'interruttore
 *     nella loro ULTIMA definizione (non nella prima che capita);
 *  7. i MINIMI: un lock che scansiona zero file è verde. È già successo tre volte in questo repo.
 *
 * ─── Come è fatto ────────────────────────────────────────────────────────────
 * Legge `src/` come testo MASCHERATO (`fixtures/sorgente.ts`: commenti spenti, stringhe riconoscibili), perché un
 * lock che legge il testo grezzo si immunizza con i propri commenti. La scansione si fa UNA volta per file di test
 * (`ANALISI`), non una volta per caso. L'helper di maschera è quello condiviso, non una seconda copia.
 *
 * ─── Le fonti NON sono copiate qui ───────────────────────────────────────────
 *  - tabelle del registro e loro modo → `__tests__/fixtures/tabelle-anno.json` (generata dal database);
 *  - funzioni SQL che scrivono il registro e la loro classe → `__tests__/fixtures/funzioni-scrivono-registro.json`;
 *  - siti `alunni` esentati dalla doppia scrittura → `ESENTI` di `src/lib/anno/frequenze.ts` (importato);
 *  - le 15 colonne che il trigger copia nella frequenza → il testo della migrazione `…_anno_strumenti.sql`
 *    (`campiFrequenzaDaAlunno` non esporta l'elenco: se ne legge il testo per CONFRONTARLO, vedi sezione 4);
 *  - l'allowlist dell'oblio → `COPPIE_OBLIO_AMMESSE` di `src/lib/gdpr/oblio-registro.ts` (importata).
 *
 * ─── Cosa NON vede (limiti dichiarati) ───────────────────────────────────────
 *  - una scrittura fatta su un client salvato in una variabile (`const q = supabase.from('t'); q.insert(…)`): la
 *    scansione cerca `.from(…)` seguito SUBITO da `.insert|upsert|update|delete(`;
 *  - una data piena scritta a mano (`'2027-08-01'`): è una data, non un confine calcolato (sezione 5);
 *  - una `rpc` che scrive il registro: ci pensano la guardia in database e la sezione 6;
 *  - `getMonth()` conta solo se confrontato DIRETTAMENTE con 7, 8 o 9: `const m = d.getMonth(); if (m >= 8)` e
 *    `getUTCMonth()` sfuggono (li chiude la PR 4.1, che toglie tutto il calcolo a mano);
 *  - nella finestra dei `pagamenti` basta che `scadenza` o `periodo_competenza` siano NOMINATE, anche in una stringa;
 *  - per `.insert(variabile)` il controllo dell'anno resta a livello di FILE, ristretto a `anno_id:` / `conAnno(` /
 *    `annoDelBambino(`: non dice che quella variabile specifica porti l'anno.
 */

const CWD = process.cwd()
const RADICE_SRC = path.join(CWD, 'src')
const DIR_MIGRAZIONI = path.join(CWD, 'supabase', 'migrations')

const rel = (f: string) => path.relative(CWD, f).split(path.sep).join('/')

// ───────────────────────── fonti generate ─────────────────────────

interface TabellaAnno { tabella: string; modo: 'data' | 'madre' | 'dichiarato' }
interface FunzioneRegistro { funzione: string; tabelle: string[]; classe?: string }

const FIXTURE_TABELLE = JSON.parse(fs.readFileSync(path.join(CWD, '__tests__/fixtures/tabelle-anno.json'), 'utf8')) as {
  _come_si_rigenera: string
  tabelle: TabellaAnno[]
}
const FIXTURE_FUNZIONI = JSON.parse(
  fs.readFileSync(path.join(CWD, '__tests__/fixtures/funzioni-scrivono-registro.json'), 'utf8'),
) as { _come_si_rigenera: string; funzioni: FunzioneRegistro[] }

const REGISTRO = new Set(FIXTURE_TABELLE.tabelle.map((t) => t.tabella))
const DICHIARATE = new Set(FIXTURE_TABELLE.tabelle.filter((t) => t.modo === 'dichiarato').map((t) => t.tabella))

// ───────────────────────── lo scanner ─────────────────────────

type OpScrittura = 'insert' | 'upsert' | 'update' | 'delete'

interface Scrittura {
  /** Il nome della tabella (letterale, o `const NOME = 'tabella'` con una sola dichiarazione), o `null`: tabella non leggibile. */
  tabella: string | null
  op: OpScrittura
  riga: number
  /** Il testo (senza commenti) dell'argomento di `insert(...)`/`update(...)`: serve a leggere i nomi delle colonne. */
  argomento: string
}

interface Analisi {
  percorso: string
  m: SorgenteMascherato
  scritture: Scrittura[]
}

/** Le `const NOME = 'stringa'` del file che hanno UNA sola dichiarazione: `.from(NOME)` si legge come `.from('stringa')`. */
function costantiStringa(m: SorgenteMascherato): Map<string, string> {
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*(?:as\s+const)?\s*[;\n,]/g
  const valori = new Map<string, string>()
  let h: RegExpExecArray | null
  while ((h = re.exec(m.senzaCommenti)) !== null) valori.set(h[1], h[3])
  const tutte = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g
  const conta = new Map<string, number>()
  while ((h = tutte.exec(m.senzaCommenti)) !== null) conta.set(h[1], (conta.get(h[1]) ?? 0) + 1)
  return new Map([...valori].filter(([k]) => conta.get(k) === 1))
}

const RE_FROM = /\.\s*from\s*\(/g
// `.from(x).insert(` e anche `(supabase.from(x) as unknown as T).insert(` (la forma del ripiego di oblio-registro.ts)
const RE_OP = /^(?:\s*as\s+[\w$.<>[\]|, ]+?\))?\s*\.\s*(insert|upsert|update|delete)\s*\(/

/**
 * Tutte le `.from(<x>).insert|upsert|update|delete(` del file. L'analisi è sul testo `struttura` (nessuna parentesi
 * dentro una stringa) e legge l'argomento di `from` dal testo `senzaCommenti` (le stringhe restano leggibili).
 */
function analizza(percorso: string, sorgente: string): Analisi {
  const m = mascheraSorgente(sorgente)
  const scritture: Scrittura[] = []
  const costanti = costantiStringa(m)
  RE_FROM.lastIndex = 0
  let hit: RegExpExecArray | null
  while ((hit = RE_FROM.exec(m.struttura)) !== null) {
    const apertura = hit.index + hit[0].length - 1
    const fine = fineParentesi(m.struttura, apertura)
    // si salta il bianco (i commenti sono già spazi, anche lunghi) prima di cercare il metodo
    let dopo = fine
    while (dopo < m.struttura.length && /\s/.test(m.struttura[dopo])) dopo++
    const op = RE_OP.exec(m.struttura.slice(dopo, dopo + 80))
    if (!op) continue
    const arg = m.senzaCommenti.slice(apertura + 1, fine - 1).trim()
    const lett = /^(['"`])([A-Za-z_][A-Za-z0-9_]*)\1$/.exec(arg)
    // `const TABELLA = 'armadietto_richieste'` e poi `.from(TABELLA)`: la tabella è leggibile lo stesso
    const viaCostante = !lett && /^[A-Za-z_$][\w$]*$/.test(arg) ? (costanti.get(arg) ?? null) : null
    const aperturaOp = dopo + op[0].length - 1
    const fineOp = fineParentesi(m.struttura, aperturaOp)
    scritture.push({
      tabella: lett ? lett[2] : viaCostante,
      op: op[1] as OpScrittura,
      riga: riga(m.originale, hit.index),
      argomento: m.senzaCommenti.slice(aperturaOp + 1, fineOp - 1),
    })
  }
  return { percorso, m, scritture }
}

const dentroUnaStringa = (m: SorgenteMascherato, idx: number) => m.struttura[idx] !== m.senzaCommenti[idx]

// ───────────────────────── sezione 2: le scritture dichiarate ─────────────────────────

const HELPER_ANNO = ['resolveAnnoScrittura', 'annoDellaData', 'annoPerScritturaPubblica'] as const

/** Le righe `import … from '…'` del file (senza commenti): servono a leggere cosa il file importa. */
const RE_IMPORT = /import\s[^;]*?from\s*['"][^'"]+['"]/g
function importi(a: Analisi): string {
  return a.m.senzaCommenti.match(RE_IMPORT)?.join('\n') ?? ''
}
/** Il file senza le righe di import: «scrive `anno_id`» non può essere dimostrato dal nome di un import. */
const senzaImport = (a: Analisi) => a.m.senzaCommenti.replace(RE_IMPORT, '')

/**
 * ESENTATA DALL'HELPER: `pagamenti`. Il motivo (D3): la riserva sta NEL DATABASE (`anno_tabelle.riserva_permanente`),
 * perché una voce di cassa non deve mai fallire per l'anno, e l'anno di una voce è già fissato dalla sua DATA
 * (`scadenza` / `periodo_competenza`, PR 1). Al posto dell'helper il lock chiede che ogni file con un `insert` su
 * `pagamenti` nomini una delle due colonne entro 40 righe dall'`insert`.
 */
const ESENTI_PER_DATA: Record<string, string> = {
  pagamenti:
    'la riserva sta nel database (D3, anno_tabelle.riserva_permanente) e l’anno di una voce lo fissa la sua data: il lock verifica che l’insert nomini scadenza o periodo_competenza',
}
const FINESTRA_PAGAMENTI = 40

/**
 * Due indirezioni DICHIARATE (Compiti 3.5-2 e 3.5-1), ognuna col suo motivo e con la sua prova di vita (sezione 2):
 * senza di loro il lock chiederebbe a un file di chiamare un helper che non gli serve.
 *  - `risolviAnniBambini` (src/lib/crm/anno-bambini.ts): avvolge `resolveAnnoScrittura`/`annoDellaData` e decide l'anno
 *    di OGNI bambino (`in_corso`, `prossimo`…); la riga si scrive con `annoDelBambino(...)`, che dà `{ anno_id }`.
 *  - `certificato-store.ts` RICEVE l'esito dalla route (`esito: EsitoAnno`, cioè il ritorno di `resolveAnnoScrittura`)
 *    e scrive `conAnno(esito)`: l'helper lo chiama la route, il file che scrive non ha niente da risolvere.
 */
const HELPER_INDIRETTI: Record<string, { file: string; motivo: string }> = {
  risolviAnniBambini: {
    file: 'src/lib/crm/anno-bambini.ts',
    motivo: 'avvolge resolveAnnoScrittura/annoDellaData e risolve l’anno di ogni bambino; la riga scrive annoDelBambino(…)',
  },
}
const RICEVONO_L_ESITO: Record<string, string> = {
  'src/lib/competenze/certificato-store.ts':
    'seedCertificato riceve `esito: EsitoAnno` dalla route admin/competenze (che chiama resolveAnnoScrittura) e scrive conAnno(esito)',
}
const SCRIVE_ANNO_ID = /\banno_id\b|\bconAnno\s*\(|\bannoDelBambino\s*\(/

/**
 * `anno_id` NELLA chiamata: nell'oggetto, oppure via uno spread `...nome` dove `nome` è dichiarato nel file con
 * `anno_id` sulla stessa riga (`const dichiaraAnno = pubblico.annoId ? { anno_id: … } : {}`, come in iscrizione/route.ts).
 */
function scriveAnnoNellaChiamata(a: Analisi, argomento: string): boolean {
  if (SCRIVE_ANNO_ID.test(argomento)) return true
  for (const sp of argomento.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\s*[,}\n)]/g)) {
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${sp[1].replace(/\$/g, '\\$')}\\b[^\\n]*\\banno_id\\b`)
    if (decl.test(senzaImport(a))) return true
  }
  return false
}

/** Le chiamate `nome(…)` (non la definizione `function nome(`) con il numero di argomenti al livello più esterno. */
function chiamate(a: Analisi, nome: string): { riga: number; argomenti: number }[] {
  const out: { riga: number; argomenti: number }[] = []
  const re = new RegExp(`(?<!function\\s)\\b${nome}\\s*\\(`, 'g')
  const st = a.m.struttura
  let h: RegExpExecArray | null
  while ((h = re.exec(st)) !== null) {
    const ap = h.index + h[0].length - 1
    const fine = fineParentesi(st, ap)
    const corpo = st.slice(ap + 1, fine - 1)
    let liv = 0
    let n = corpo.trim() === '' ? 0 : 1
    for (const c of corpo) {
      if ('([{'.includes(c)) liv++
      else if (')]}'.includes(c)) liv--
      else if (c === ',' && liv === 0) n++
    }
    if (corpo.trim().endsWith(',')) n-- // virgola finale
    out.push({ riga: riga(a.m.originale, h.index), argomenti: n })
  }
  return out
}
const contaChiamate = (a: Analisi, nome: string) => chiamate(a, nome).length
function chiamateSenzaEsito(files: Analisi[], nome: string, minimoArgomenti: number): { testo: string }[] {
  const out: { testo: string }[] = []
  for (const a of files) {
    if (a.percorso === 'src/lib/competenze/certificato-store.ts') continue // la definizione
    for (const c of chiamate(a, nome)) if (c.argomenti < minimoArgomenti) out.push({ testo: `${a.percorso}:${c.riga} — ${nome}( con ${c.argomenti} argomenti` })
  }
  return out
}

function violazioniDichiarate(files: Analisi[], inVariabile: { file: string }[] = TABELLE_IN_VARIABILE): string[] {
  const out: string[] = []
  // i file con una tabella in variabile DICHIARATA li controlla `violazioniNonLeggibili` (tetto, tabelle non dichiarate)
  const dichiarati = new Set(inVariabile.map((d) => d.file))
  for (const a of files) {
    const imp = importi(a)
    // l'helper si CHIAMA (un import rimasto dopo che la chiamata è stata tolta non è una prova)
    const haHelper =
      [...HELPER_ANNO, ...Object.keys(HELPER_INDIRETTI)].some((h) => new RegExp(`\\b${h}\\s*\\(`).test(a.m.struttura)) ||
      (a.percorso in RICEVONO_L_ESITO && /\bEsitoAnno\b/.test(imp))
    // `anno_id` come PROPRIETÀ di oggetto (non in una stringa tipo `.select('anno_id')`), per le variabili nude
    const annoIdNelFile = /\banno_id\s*:|\bconAnno\s*\(|\bannoDelBambino\s*\(/.test(senzaImport(a))
    const righe = a.m.senzaCommenti.split('\n')
    for (const s of a.scritture) {
      if (s.op !== 'insert' && s.op !== 'upsert') continue
      if (s.tabella === null) {
        if (!dichiarati.has(a.percorso)) {
          out.push(`${a.percorso}:${s.riga} — tabella non leggibile (\`.from(variabile).${s.op}\`): non si sa se è del registro`)
        }
        continue
      }
      if (!DICHIARATE.has(s.tabella)) continue
      if (s.tabella === 'frequenze') {
        if (a.percorso !== 'src/lib/anno/frequenze.ts') {
          out.push(`${a.percorso}:${s.riga} — \`frequenze\` si scrive solo da scriviFrequenza (src/lib/anno/frequenze.ts)`)
        }
        continue
      }
      if (s.tabella in ESENTI_PER_DATA) {
        const da = Math.max(0, s.riga - 1 - FINESTRA_PAGAMENTI)
        const finestra = righe.slice(da, s.riga + FINESTRA_PAGAMENTI).join('\n')
        if (!/\b(scadenza|periodo_competenza)\b/.test(finestra)) {
          out.push(`${a.percorso}:${s.riga} — ${s.op} su \`${s.tabella}\` senza \`scadenza\` né \`periodo_competenza\` entro ${FINESTRA_PAGAMENTI} righe`)
        }
        continue
      }
      if (!haHelper) {
        out.push(`${a.percorso}:${s.riga} — ${s.op} su \`${s.tabella}\` in un file che non chiama ${HELPER_ANNO.join(' | ')}`)
      } else if (!(/^\s*[{[]/.test(s.argomento) ? scriveAnnoNellaChiamata(a, s.argomento) : annoIdNelFile)) {
        // oggetto/array letterale: `anno_id` deve stare NELLA chiamata (un altro insert del file non lo copre);
        // variabile nuda (`.insert(record)`): ripiego sul file, ma solo `anno_id:` / conAnno(, non una stringa
        out.push(`${a.percorso}:${s.riga} — ${s.op} su \`${s.tabella}\`: il file ricava l'anno ma non scrive \`anno_id\` (manca \`...conAnno(esito)\`)`)
      }
    }
  }
  return out
}

/**
 * `.from(variabile)` con una scrittura: la tabella non si legge. Non passa in silenzio: ogni file con un sito così è
 * qui, con le tabelle che la variabile può assumere e il NUMERO di siti (un tetto che può solo scendere). Il lock
 * rifiuta una voce che nomina una tabella DICHIARATA (sarebbe un modo per schivare la sezione 2) e una voce morta.
 */
const TABELLE_IN_VARIABILE: { file: string; tabelle: string[]; n: number; motivo: string }[] = [
  {
    file: 'src/app/api/admin/anagrafica-personale/scansione/route.ts',
    tabelle: ['caricamenti_personale'],
    n: 2,
    motivo: 'TABELLA_CARICAMENTI è la costante importata di lib/personale/caricamenti.ts: una tabella del personale, fuori dal registro',
  },
  {
    file: 'src/app/api/admin/primaria/giudizi/route.ts',
    tabelle: ['giudizi_sintetici_scala', 'giudizio_template'],
    n: 1,
    motivo: 'ternario fra due tabelle di configurazione dei giudizi (scala / template): nessuna è nel registro',
  },
  {
    file: 'src/app/api/admin/staff/eliminazione/route.ts',
    tabelle: ['utenti_sezioni', 'utenti_sezioni_materie', 'utenti_scuole', 'push_subscriptions'],
    n: 1,
    motivo: 'sgancio dei poteri di un account: DELETE di tabelle di assegnazione per utente_id (utenti_sezioni è un registro «madre», non dichiarato)',
  },
  {
    file: 'src/app/api/admin/staff/riporta-a-genitore/route.ts',
    tabelle: ['utenti_sezioni', 'utenti_sezioni_materie', 'utenti_scuole'],
    n: 1,
    motivo: 'sgancio dei poteri di un docente che torna genitore: DELETE per utente_id sulle tre tabelle di assegnazione',
  },
  {
    file: 'src/app/api/primaria/sblocca/route.ts',
    tabelle: ['registro_orario', 'valutazioni'],
    n: 1,
    motivo: 'sblocco di una firma: UPDATE di locked_il = null su due tabelle in modo `data` (non dichiarate: l’anno lo fissa la data della riga)',
  },
  {
    file: 'src/lib/gdpr/esegui.ts',
    tabelle: ['certificati_medici'],
    n: 1,
    motivo: 'cancellaDiretta: il ramo delle tabelle FUORI dal registro (le altre passano da scriviOblio, vedi TABELLE_OBLIO_REGISTRO)',
  },
  {
    file: 'src/lib/gdpr/oblio-registro.ts',
    // l'elenco delle tabelle NON è copiato: viene dall'allowlist importata (COPPIE_OBLIO_AMMESSE)
    tabelle: [...new Set(COPPIE_OBLIO_AMMESSE.map((c) => c.split('|')[1]))],
    n: 2,
    motivo: 'il ripiego di scriviOblio/svuotaOblio: `supabase.from(tabella)` con la tabella dell’allowlist, solo UPDATE/DELETE (eccezione già dichiarata in ECCEZIONI_ZONA_OBLIO)',
  },
  {
    file: 'src/lib/scuole/corredo-sede.ts',
    tabelle: ['admin_settings', 'giudizi_sintetici_scala', 'protocolli_categorie'],
    n: 1,
    motivo: 'il corredo di una sede nuova: INSERT del CORREDO (tre tabelle di configurazione, nessuna nel registro)',
  },
]

function violazioniNonLeggibili(files: Analisi[], dichiarate = TABELLE_IN_VARIABILE): string[] {
  const out: string[] = []
  const perFile = new Map(dichiarate.map((d) => [d.file, d]))
  const visti = new Set<string>()
  for (const a of files) {
    const nl = a.scritture.filter((s) => s.tabella === null)
    if (nl.length === 0) continue
    visti.add(a.percorso)
    const d = perFile.get(a.percorso)
    if (!d) {
      for (const s of nl) out.push(`${a.percorso}:${s.riga} — tabella non leggibile (\`.from(variabile).${s.op}\`): dichiararla in TABELLE_IN_VARIABILE con le tabelle possibili`)
      continue
    }
    if (nl.length > d.n) out.push(`${a.percorso} — ${nl.length} siti con tabella in variabile, il tetto dichiarato è ${d.n}`)
    if (nl.length < d.n) out.push(`${a.percorso} — ${nl.length} siti con tabella in variabile, il tetto dichiarato è ${d.n}: abbassalo`)
    // un INSERT/UPSERT con la tabella in variabile non può nominare una dichiarata: schiverebbe la sezione 2
    const dich = d.tabelle.filter((t) => DICHIARATE.has(t))
    if (dich.length > 0 && nl.some((s) => s.op === 'insert' || s.op === 'upsert')) {
      out.push(`${a.percorso} — insert/upsert con tabella in variabile che può essere dichiarata (${dich.join(', ')}): schiverebbe la sezione 2`)
    }
  }
  for (const d of dichiarate) {
    if (!visti.has(d.file)) out.push(`${d.file} — voce di TABELLE_IN_VARIABILE senza più siti: toglila`)
  }
  return out
}

// ───────────────────────── sezione 3: la zona oblio ─────────────────────────

const ZONA_OBLIO = [/^src\/lib\/gdpr\//, /^src\/app\/api\/gdpr\/retention-[^/]+\//, /^src\/app\/api\/admin\/wipe\//]
/**
 * L'UNICA eccezione: il ripiego di `scriviOblio`/`svuotaOblio` (Compito 3.6). Il database della CI non ha le RPC
 * `anno_oblio_*`: senza ripiego l'oblio non girerebbe lì. Il ripiego è dichiarato qui per NOME DI FILE.
 */
const ECCEZIONI_ZONA_OBLIO: Record<string, string> = {
  'src/lib/gdpr/oblio-registro.ts':
    'è il ripiego di scriviOblio/svuotaOblio per il DB della CI (che non ha le RPC anno_oblio_*): scrive diretto solo quando l’RPC manca',
}
const inZonaOblio = (p: string) => ZONA_OBLIO.some((re) => re.test(p))

/** `new Set(['a','b'])` o `['a','b']` di sole stringhe, tutte tabelle del registro. */
function haElencoLetteraleDiRegistro(a: Analisi): boolean {
  const re = /\[\s*((?:(['"])[A-Za-z_][A-Za-z0-9_]*\2\s*,?\s*)+)\]/g
  let h: RegExpExecArray | null
  while ((h = re.exec(a.m.senzaCommenti)) !== null) {
    const nomi = [...h[1].matchAll(/['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)].map((x) => x[1])
    if (nomi.length > 0 && nomi.every((n) => REGISTRO.has(n))) return true
  }
  return false
}

function violazioniOblio(files: Analisi[]): string[] {
  const out: string[] = []
  for (const a of files) {
    if (!inZonaOblio(a.percorso)) continue
    const eccezione = a.percorso in ECCEZIONI_ZONA_OBLIO
    const elenco = haElencoLetteraleDiRegistro(a)
    for (const s of a.scritture) {
      // l'eccezione copre SOLO i `.from(variabile)` del ripiego; una `.from('presenze').update` letterale resta rossa
      if (eccezione && s.tabella === null) continue
      if (s.tabella === null) {
        if (!elenco) {
          out.push(`${a.percorso}:${s.riga} — \`.from(variabile).${s.op}\` nella zona oblio senza un elenco letterale di tabelle di registro nel file`)
        }
        continue
      }
      if (REGISTRO.has(s.tabella) && s.op !== 'insert') {
        out.push(`${a.percorso}:${s.riga} — \`.from('${s.tabella}').${s.op}\` diretto nella zona oblio: solo scriviOblio / svuotaOblio / .rpc`)
      }
    }
  }
  return out
}

// ───────────────────────── sezione 4: la doppia scrittura ─────────────────────────

const MIGRAZIONE_SPECCHIO = '20261107012110_anno_strumenti.sql'

/**
 * Le colonne che il trigger `alunni_specchio_frequenza` copia nella frequenza: l'ARRAY della migrazione M1, letto come
 * testo. `scuola_id` è nell'elenco del trigger ma NON è una colonna da copiare (la sede di una frequenza è quella del
 * suo anno, `frequenze.ts`): la tolgo, altrimenti ogni `insert` su `alunni` (che scrive sempre `scuola_id`) conterebbe.
 */
function colonneCopiate(testoMigrazione: string): string[] {
  const h = /ARRAY\[\s*'scuola_id'\s*,([^\]]*)\]/.exec(testoMigrazione)
  if (!h) return []
  return [...h[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
}

function sitiAlunniConColonneCopiate(files: Analisi[], colonne: string[]): { a: Analisi; s: Scrittura }[] {
  const out: { a: Analisi; s: Scrittura }[] = []
  if (colonne.length === 0) return out
  const re = new RegExp(`\\b(${colonne.join('|')})\\b`)
  for (const a of files) {
    for (const s of a.scritture) {
      if (s.tabella !== 'alunni' || s.op === 'delete') continue
      // l'oggetto nomina una colonna copiata; se l'argomento è una variabile (`.update(daScrivere)`) il nome sta nel
      // file, non nella chiamata: si guarda il file intero (un file che non nomina mai una colonna copiata non copia)
      const letterale = /^\s*\{/.test(s.argomento)
      if (re.test(letterale ? s.argomento : senzaImport(a))) out.push({ a, s })
    }
  }
  return out
}

function violazioniDoppiaScrittura(
  files: Analisi[],
  colonne: string[],
  esenti: readonly { file: string; motivo: string }[],
): string[] {
  const out: string[] = []
  const nelleEsenti = new Set(esenti.map((e) => e.file))
  for (const { a, s } of sitiAlunniConColonneCopiate(files, colonne)) {
    // la CHIAMATA, non l'import: togliere la chiamata lasciando l'import non deve far passare il lock
    if (/\bscriviFrequenza\s*\(/.test(a.m.struttura)) continue
    if (nelleEsenti.has(a.percorso)) continue
    out.push(`${a.percorso}:${s.riga} — \`.from('alunni').${s.op}\` con colonne copiate in un file che non chiama scriviFrequenza e non è in ESENTI`)
  }
  return out
}

// ───────────────────────── sezione 5: l'anno calcolato a mano ─────────────────────────

type ModelloAnno =
  | 'annoScolasticoCorrente('
  | '-08-01'
  | '-07-31'
  | '-09-01'
  | '-08-31'
  | 'getMonth()'
  | 'getUTCMonth()'
  | 'mese >= soglia'
  | 'annoScolasticoDelGiorno'
  | 'annoScolasticoDiData'
  | 'periodoDaSettembre'
  | 'annoScolasticoDiCompetenza'
  | 'annoScolasticoAmbiguo'
  | 'MESE_INIZIO_ANNO_SCOLASTICO'
  | 'MESE_RIPIEGO_AMBIGUO'

// I nomi delle vecchie regole d'anno e le due costanti di soglia: chi le nomina (le chiama, le importa, le definisce)
// ha ancora una regola d'anno sua. Si cercano nel testo `struttura`, come identificatore intero.
const NOMI_VECCHI_ANNO = [
  'annoScolasticoDelGiorno',
  'annoScolasticoDiData',
  'periodoDaSettembre',
  'annoScolasticoDiCompetenza',
  'annoScolasticoAmbiguo',
  'MESE_INIZIO_ANNO_SCOLASTICO',
  'MESE_RIPIEGO_AMBIGUO',
] as const
// `periodoDaSettembre` è la scorciatoia «da settembre» delle statistiche CRM: la regola sta nel file che la DEFINISCE
// (crm/statistiche.ts, censimento R10); chi si limita a chiamarla (StatisticheCrm.tsx, un pulsante) non ha soglie
// sue, e il censimento non lo conta. Per questo nome si cerca solo la definizione.
const SOLO_DEFINIZIONE = new Set<string>(['periodoDaSettembre'])
// Un mese (identificatore intero, non una proprietà `x.m`) confrontato con la soglia 7/8/9 da >=, >, <, <=.
// L'uguaglianza (`=== mese`) non conta: mostrare o filtrare un mese non è un calcolo d'anno.
const RE_MESE_SOGLIA = /(?<![\w$.])(?:mese|meseOggi|month|m)\s*(?:>=|<=|>|<)\s*[789]\b/

// Il «modulo dell'anno» sono `src/lib/anno/`, `src/lib/auth/scope.ts` e (dal compito 4.1.1) `src/lib/anno-scolastico.ts`:
// quest'ultimo è il posto dove le soglie vivono, quindi lì i letterali sono la definizione, non un calcolo a mano.
const FUORI_DAL_MODULO_ANNO = (p: string) =>
  !p.startsWith('src/lib/anno/') && p !== 'src/lib/auth/scope.ts' && p !== 'src/lib/anno-scolastico.ts'

/**
 * I modelli di calcolo dell'anno presenti nel file. Le chiamate si cercano nel testo `struttura`; i letterali
 * `-08-01` / `-07-31` nelle STRINGHE (testo con i commenti spenti ma non le stringhe), e solo se non sono la coda di
 * una data PIENA (`2026-07-31` è una data, una versione, una frase: non un confine calcolato come `${fine}-07-31`).
 * `getMonth()` conta solo se confrontato col mese di confine (7, 8, 9): per MOSTRARE un mese non è un calcolo.
 */
function modelliAnnoNelFile(a: Analisi): ModelloAnno[] {
  const out: ModelloAnno[] = []
  if (/\bannoScolasticoCorrente\s*\(/.test(a.m.struttura)) out.push('annoScolasticoCorrente(')
  if (/\.getMonth\s*\(\s*\)\s*(?:\+\s*1\s*)?(?:>=|<=|>|<|===|!==)\s*[789]\b/.test(a.m.struttura)) out.push('getMonth()')
  if (/\.getUTCMonth\s*\(\s*\)\s*(?:\+\s*1\s*)?(?:>=|<=|>|<|===|!==)\s*[789]\b/.test(a.m.struttura)) out.push('getUTCMonth()')
  if (RE_MESE_SOGLIA.test(a.m.struttura)) out.push('mese >= soglia')
  for (const nome of NOMI_VECCHI_ANNO) {
    const prefisso = SOLO_DEFINIZIONE.has(nome) ? '\\b(?:function|const|let)\\s+' : '(?<![\\w$])'
    if (new RegExp(`${prefisso}${nome}(?![\\w$])`).test(a.m.struttura)) out.push(nome)
  }
  for (const lett of ['-08-01', '-07-31', '-09-01', '-08-31'] as const) {
    let da = 0
    for (;;) {
      const i = a.m.senzaCommenti.indexOf(lett, da)
      if (i < 0) break
      if (dentroUnaStringa(a.m, i + 1) && !/\d/.test(a.m.senzaCommenti[i - 1] ?? '')) { out.push(lett); break }
      da = i + 1
    }
  }
  return out
}

/**
 * I file che oggi calcolano l'anno a mano, ognuno col suo motivo. Li toglie TUTTI la PR 4.1 (il modulo dell'anno
 * diventa l'unico a decidere l'anno di un giorno). Il lock fallisce se un file NUOVO compare qui fuori, se un file
 * dell'elenco non contiene più un suo modello (niente eccezioni morte), e se l'elenco CRESCE.
 */
const ANNO_A_MANO_DI_OGGI: { file: string; modelli: ModelloAnno[]; motivo: string }[] = [
  {
    file: 'src/lib/crm/quota-anno.ts',
    modelli: ['annoScolasticoCorrente('],
    motivo: 'l’anno di apertura della quota CRM viene da annoScolasticoCorrente(adesso); la PR 4.1 lo legge dall’anno `corrente` della sede, e lo toglie',
  },
  {
    file: 'src/app/(dashboard)/teacher/primaria/[sectionId]/compiti/page.tsx',
    modelli: ['annoScolasticoCorrente(', '-08-01'],
    motivo: 'il filtro «compiti di quest’anno» parte da `${anno}-08-01`; la PR 4.1 lo legge dall’inizio dell’anno della classe, e lo toglie',
  },
  {
    file: 'src/components/features/parent/LezioniCompitiSections.tsx',
    modelli: ['annoScolasticoCorrente(', '-08-01'],
    motivo: 'il filtro «lezioni e compiti dell’anno in corso» parte da `${anno}-08-01`; la PR 4.1 lo legge dall’anno del figlio, e lo toglie',
  },
  {
    file: 'src/components/features/admin/pagamenti/GeneratoreRette.tsx',
    modelli: ['annoScolasticoCorrente(', 'getMonth()'],
    motivo: 'ha una SUA annoScolasticoCorrente() locale (getMonth()+1 >= 9, confine al 1° settembre, nel fuso del browser): diverge dalla regola del server. La PR 4.1 la sostituisce con l’anno della sede, e la toglie',
  },
  {
    file: 'src/components/features/admin/primaria/ScrutinioPeriodiManager.tsx',
    modelli: ['getMonth()'],
    motivo: 'l’anno proposto per i periodi di scrutinio è `getMonth() >= 8 ? y : y - 1` (fuso del browser); la PR 4.1 lo prende dall’anno corrente della sede, e lo toglie',
  },
  {
    file: 'src/app/(dashboard)/teacher/primaria/[sectionId]/appello/page.tsx',
    modelli: ['mese >= soglia', '-09-01'],
    motivo: 'l’inizio dell’anno dell’appello è `${anno}-09-01` con `meseOggi >= 9` (fuso del browser); la PR 4.1 lo legge dal calendario della sede, e lo toglie',
  },
  {
    file: 'src/lib/primaria/periodo.ts',
    modelli: ['mese >= soglia', 'annoScolasticoDiData'],
    motivo: 'annoScolasticoDiData decide l’anno con `m >= 8`; la PR 4.1 la sostituisce con il modulo dell’anno, e la toglie',
  },
  {
    file: 'src/lib/crm/quota.ts',
    modelli: ['-09-01'],
    motivo: 'competenzaDellaQuota fissa la competenza al `${anno}-09-01`, scritto a mano; la PR 4.1 lo prende dall’inizio dell’anno della sede, e lo toglie',
  },
  {
    file: 'src/lib/fatturazione/sezionale.ts',
    modelli: ['annoScolasticoDiCompetenza', 'annoScolasticoAmbiguo', 'MESE_INIZIO_ANNO_SCOLASTICO', 'MESE_RIPIEGO_AMBIGUO'],
    motivo: 'il sezionale delle fatture ha le sue costanti di soglia (settembre, ripiego agosto) e annoScolasticoDiCompetenza/annoScolasticoAmbiguo; la PR 4.1 le sostituisce con il modulo dell’anno, e le toglie',
  },
  {
    file: 'src/lib/aruba/emissione.ts',
    modelli: ['annoScolasticoDiCompetenza', 'annoScolasticoAmbiguo'],
    motivo: 'l’emissione chiama annoScolasticoDiCompetenza e legge annoScolasticoAmbiguo del sezionale; la PR 4.1 le sostituisce con il modulo dell’anno, e le toglie',
  },
  {
    file: 'src/lib/pagamenti/selezione-voci.ts',
    modelli: ['mese >= soglia'],
    motivo: 'periodoDi (`mese >= 9`) e annoScolasticoDi (`meseDi(oggi) >= 9`) decidono l’anno con la soglia di settembre; la PR 4.1 le sostituisce con il modulo dell’anno, e le toglie',
  },
  {
    file: 'src/lib/storici/periodi.ts',
    modelli: ['mese >= soglia', '-09-01'],
    motivo: 'l’inizio dell’anno degli storici è `${mese >= 9 ? anno : anno - 1}-09-01`; la PR 4.1 lo prende dal calendario della sede, e lo toglie',
  },
  {
    file: 'src/lib/crm/statistiche.ts',
    modelli: ['mese >= soglia', 'periodoDaSettembre'],
    motivo: 'periodoDaSettembre decide l’anno con `mese >= 9`; la PR 4.1 la sostituisce con il modulo dell’anno, e la toglie',
  },
]
/**
 * Il tetto è il numero di file di oggi (13) e può solo SCENDERE.
 * Era 10 (misurato 2026-11-07). Sceso a 9 l'08/11/2026, PR 4.1 compito 4.1.1: `src/lib/anno-scolastico.ts` è
 * diventato il modulo dell'anno ed è esente (lì le soglie sono la definizione); non era un file che calcola a mano.
 * Salito da 9 a 17 l'08/11/2026, PR 4.1 compito 4.1.L: il lock ora vede anche le soglie al 1° settembre, che la PR 3
 * non vedeva; i file sono quelli del censimento della PR 4.1; ogni compito di sostituzione lo abbassa, l'ultimo lo
 * porta a 0.
 * Sceso da 17 a 13 l'08/11/2026 (−4: prestampati e documenti sul modulo dell'anno, compito 4.1.S1):
 * prefill.ts, banco.ts, banco-famiglia.ts e genera-documento/route.ts non calcolano più l'anno a mano.
 */
const TETTO_ANNO_A_MANO = 13

function violazioniAnnoAMano(files: Analisi[], elenco = ANNO_A_MANO_DI_OGGI, tetto = TETTO_ANNO_A_MANO): string[] {
  const out: string[] = []
  const perFile = new Map(elenco.map((e) => [e.file, e]))
  const trovati = new Map<string, ModelloAnno[]>()
  for (const a of files) {
    if (!FUORI_DAL_MODULO_ANNO(a.percorso)) continue
    const mod = modelliAnnoNelFile(a)
    if (mod.length > 0) trovati.set(a.percorso, mod)
  }
  for (const [file, mod] of trovati) {
    const e = perFile.get(file)
    if (!e) { out.push(`${file} — calcola l'anno a mano (${mod.join(', ')}) fuori da src/lib/anno/, src/lib/auth/scope.ts e src/lib/anno-scolastico.ts: usa il modulo dell'anno`); continue }
    const nuovi = mod.filter((m) => !e.modelli.includes(m))
    if (nuovi.length > 0) out.push(`${file} — nuovo modello di calcolo a mano: ${nuovi.join(', ')}`)
  }
  for (const e of elenco) {
    const mod = trovati.get(e.file)
    if (!mod) { out.push(`${e.file} — voce di ANNO_A_MANO_DI_OGGI che non contiene più nessun modello: toglila`); continue }
    const morti = e.modelli.filter((m) => !mod.includes(m))
    if (morti.length > 0) out.push(`${e.file} — la voce dichiara ${morti.join(', ')} ma il file non lo contiene più: toglilo dalla voce`)
    if (!/PR 4\.1/.test(e.motivo)) out.push(`${e.file} — il motivo deve dire quale PR lo toglie (PR 4.1)`)
  }
  if (elenco.length > tetto) out.push(`ANNO_A_MANO_DI_OGGI ha ${elenco.length} file, il tetto è ${tetto}: l'elenco può solo scendere`)
  return out
}

// ───────────────────────── sezione 6: l'SQL ─────────────────────────

interface Migrazione { nome: string; testo: string }

const CLASSI_AMMESSE = ['corrente', 'dichiara', 'esente-colonne', 'oblio', 'macchina-a-stati']
const togliCommentiSql = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

/** L'ULTIMA definizione di `nome`: nel file con la version più alta che la contiene, l'ultima del file. */
function ultimaDefinizione(nome: string, migrazioni: Migrazione[]): { migrazione: string; corpo: string } | null {
  const ordinate = [...migrazioni].sort((x, y) => (x.nome < y.nome ? 1 : x.nome > y.nome ? -1 : 0))
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+(?:[a-z_]+\\.)?${nome}\\s*\\(`, 'ig')
  for (const mig of ordinate) {
    const t = togliCommentiSql(mig.testo)
    let ultimo: RegExpExecArray | null = null
    let h: RegExpExecArray | null
    re.lastIndex = 0
    while ((h = re.exec(t)) !== null) ultimo = h
    if (!ultimo) continue
    const dopo = t.slice(ultimo.index + ultimo[0].length)
    // il corpo sta fra `AS $tag$` e il `$tag$` che lo chiude (anche dentro un `EXECUTE $def$ … $def$` di un DO)
    const as = /\bas\s+(\$[A-Za-z_0-9]*\$)/i.exec(dopo)
    if (!as) return { migrazione: mig.nome, corpo: '' }
    const inizio = as.index + as[0].length
    const fine = dopo.indexOf(as[1], inizio)
    return { migrazione: mig.nome, corpo: dopo.slice(inizio, fine < 0 ? undefined : fine) }
  }
  return null
}

const RE_INTERRUTTORE = /anno_oblio_attiva|set_config\(\s*'anno_chiuso\.oblio'/i

/**
 * Le cinque funzioni `video_*` di classe `oblio` che passano la guardia ACCESA senza interruttore: via (i) di P32.
 * Scrivono solo `video_jobs` (`anno_tabelle.guardia = 'nessuna'`) e `video_intents` (`solo_contenuto`: gli UPDATE sono
 * esenti, e loro non fanno né INSERT né DELETE). Una guardia che non le guarda non ha bisogno dell'interruttore.
 */
const OBLIO_VIA_SENZA_INTERRUTTORE: Record<string, string> = {
  video_intent_oblio_alunno: 'UPDATE su video_intents (solo_contenuto) e video_jobs (nessuna): né INSERT né DELETE',
  video_intenti_minimizza: 'UPDATE su video_intents (solo_contenuto): tag_alunni svuotato, nessun INSERT né DELETE',
  video_retention_originale_rimosso: 'scrive solo video_jobs, guardia = nessuna',
  video_retention_scadenze: 'scrive solo video_jobs, guardia = nessuna',
  video_retention_uscita_rimossa: 'scrive solo video_jobs, guardia = nessuna',
}

/**
 * PROVA DEL ROSSO n. 5. Una migrazione FINTA, con una version più alta di tutte, che ridefinisce una funzione di oblio
 * SENZA l'interruttore. Resta VUOTA; per la prova la si riempie (vedi il rapporto del 3.9), si guarda la sezione 6
 * diventare rossa, e la si svuota. Non tocca il disco, quindi non c'è un file da togliere.
 */
const INIEZIONE_PROVA_ROSSO_SQL: Migrazione[] = []

function leggiMigrazioni(): Migrazione[] {
  return fs
    .readdirSync(DIR_MIGRAZIONI)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((nome) => ({ nome, testo: fs.readFileSync(path.join(DIR_MIGRAZIONI, nome), 'utf8') }))
}

function violazioniSql(funzioni: FunzioneRegistro[], migrazioni: Migrazione[]): string[] {
  const out: string[] = []
  for (const f of funzioni) {
    if (!f.classe || !CLASSI_AMMESSE.includes(f.classe)) {
      out.push(`${f.funzione} — senza classe (o classe sconosciuta: ${String(f.classe)}). Classi ammesse: ${CLASSI_AMMESSE.join(', ')}`)
    }
  }
  for (const f of funzioni.filter((x) => x.classe === 'oblio')) {
    if (f.funzione in OBLIO_VIA_SENZA_INTERRUTTORE) continue
    const d = ultimaDefinizione(f.funzione, migrazioni)
    if (!d) continue // l'ultima definizione sta solo in produzione: la riporta il rapporto, il lock non la vede
    if (!RE_INTERRUTTORE.test(d.corpo)) {
      out.push(`${f.funzione} (classe oblio) — l'ultima definizione, in ${d.migrazione}, non accende l'interruttore (anno_oblio_attiva / set_config('anno_chiuso.oblio'))`)
    }
  }
  return out
}

// ───────────────────────── sezione 7: i minimi ─────────────────────────

interface Misure {
  fileLetti: number
  fileEsaminati: number
  scritture: number
  dichiarateNonPagamenti: number
  pagamenti: number
  sitiAlunni: number
  funzioni: number
}

function misura(files: Analisi[], colonne: string[], funzioni: FunzioneRegistro[]): Misure {
  let scritture = 0
  let fileEsaminati = 0
  let dichiarateNonPagamenti = 0
  let pagamenti = 0
  for (const a of files) {
    const mie = a.scritture.filter((s) => s.tabella !== null && REGISTRO.has(s.tabella))
    if (mie.length > 0) fileEsaminati++
    scritture += mie.length
    for (const s of mie) {
      if (s.op !== 'insert' && s.op !== 'upsert') continue
      if (s.tabella === 'pagamenti') pagamenti++
      else if (DICHIARATE.has(s.tabella!) && s.tabella !== 'frequenze') dichiarateNonPagamenti++
    }
  }
  return {
    fileLetti: files.length,
    fileEsaminati,
    scritture,
    dichiarateNonPagamenti,
    pagamenti,
    sitiAlunni: sitiAlunniConColonneCopiate(files, colonne).length,
    funzioni: funzioni.length,
  }
}

/** insert/upsert per tabella dichiarata (esclusa `frequenze`): ogni tabella deve avere il suo sito, o il lock è cieco su di lei. */
function insertPerDichiarata(files: Analisi[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const a of files) {
    for (const s of a.scritture) {
      if ((s.op === 'insert' || s.op === 'upsert') && s.tabella && DICHIARATE.has(s.tabella) && s.tabella !== 'frequenze') {
        m.set(s.tabella, (m.get(s.tabella) ?? 0) + 1)
      }
    }
  }
  return m
}

/**
 * I MINIMI. Ogni numero ha accanto il MISURATO e la DATA. Il minimo è il misurato (2026-11-07, dopo i compiti
 * 3.5-3.8), mai sotto la bozza del 3.9 (90 / 190 / 9 / 12 / 12 / 55 → P13: ≥ 60) tranne dove la riga dice perché.
 * Un numero che scende si abbassa SCRIVENDO perché sulla stessa riga: altrimenti un lock cieco è verde.
 */
const MINIMI: { chiave: keyof Misure; minimo: number; nota: string }[] = [
  // Il totale dei file letti non è un contratto: serve solo a escludere la cartella vuota. Per questo il minimo sta
  // SOTTO il misurato (1677): scende se si cancellano file, e non deve far rosso a ogni PR che ne toglie qualcuno.
  { chiave: 'fileLetti', minimo: 1600, nota: 'misurati 1677 il 2026-11-07; minimo sotto il misurato apposta (escludere solo la cartella vuota)' },
  { chiave: 'fileEsaminati', minimo: 96, nota: 'misurati 96 il 2026-11-07 (bozza: 90 su 97, con gallery_photo_uploads, uscita dal registro il 07/11)' },
  { chiave: 'scritture', minimo: 198, nota: 'misurate 198 il 2026-11-07 (bozza: 190 su 202 contate con 47 tabelle e gallery_photo_uploads)' },
  { chiave: 'dichiarateNonPagamenti', minimo: 9, nota: 'misurate 9 il 2026-11-07 (crm 2, enrollment 2, elenco 1, scrutinio 1, sections 1, votazioni 1, certificati 1)' },
  { chiave: 'pagamenti', minimo: 12, nota: 'misurate 12 il 2026-11-07' },
  { chiave: 'sitiAlunni', minimo: 20, nota: 'misurati 20 il 2026-11-07 (bozza: 12; la misura conta anche i file con l’oggetto in una variabile)' },
  { chiave: 'funzioni', minimo: 65, nota: 'misurate 65 il 2026-11-07 (bozza 55, poi P13: 60; la fotografia ne ha 65)' },
]
/** Per ogni tabella dichiarata (esclusa `frequenze` e `pagamenti`) misurati il 2026-11-07: crm_bambini 2, enrollment_submissions 2, il resto 1. */
const MINIMI_PER_TABELLA: Record<string, number> = {
  crm_bambini: 2,
  enrollment_submissions: 2,
  iscrizioni_elenco_caricamenti: 1,
  scrutinio_periodi: 1,
  sections: 1,
  votazioni: 1,
  certificati_competenze: 1,
}

function violazioniMinimi(m: Misure, perTabella: Map<string, number>, minimi = MINIMI, minimiTabella = MINIMI_PER_TABELLA): string[] {
  const out = minimi.filter((x) => m[x.chiave] < x.minimo).map((x) => `${x.chiave}: ${m[x.chiave]} < minimo ${x.minimo} (${x.nota})`)
  for (const [t, min] of Object.entries(minimiTabella)) {
    const n = perTabella.get(t) ?? 0
    if (n < min) out.push(`insert/upsert su ${t}: ${n} < minimo ${min}`)
  }
  return out
}

// ───────────────────────── la scansione, UNA volta ─────────────────────────

const T0 = performance.now()
const ANALISI: Analisi[] = fileSorgente(RADICE_SRC).map((f) => analizza(rel(f), fs.readFileSync(f, 'utf8')))
const MS_SCANSIONE = Math.round(performance.now() - T0)
const PER_PERCORSO = new Map(ANALISI.map((a) => [a.percorso, a]))

const MIGRAZIONI = [...leggiMigrazioni(), ...INIEZIONE_PROVA_ROSSO_SQL]
const TESTO_SPECCHIO = fs.readFileSync(path.join(DIR_MIGRAZIONI, MIGRAZIONE_SPECCHIO), 'utf8')
const COLONNE_COPIATE = colonneCopiate(TESTO_SPECCHIO)

const elenco = (v: string[]) => (v.length ? '\n  - ' + v.join('\n  - ') : '')
const COME_SI_RIGENERA_FUNZIONI = FIXTURE_FUNZIONI._come_si_rigenera

// ───────────────────────── i test ─────────────────────────

/** Un sorgente finto, analizzato come se stesse a `percorso`. */
const finto = (percorso: string, codice: string) => analizza(percorso, codice)

describe('anno-scrittura-coverage — 1. lo scanner, provato su sorgenti finti', () => {
  it('un insert su `sections` senza helper è segnalato', () => {
    const v = violazioniDichiarate([finto('src/app/api/x/route.ts', "await supabase.from('sections').insert({ name: 'A', scuola_id })")])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('sections')
  })

  it('con resolveAnnoScrittura e conAnno è pulito', () => {
    const v = violazioniDichiarate([
      finto(
        'src/app/api/x/route.ts',
        `import { resolveAnnoScrittura } from '@/lib/auth/scope'
         import { conAnno } from '@/lib/anno/tipi'
         const esito = await resolveAnnoScrittura(request, supabase, user, scuolaId)
         await supabase.from('sections').insert({ name: 'A', ...conAnno(esito) })`,
      ),
    ])
    expect(v).toEqual([])
  })

  it('l’helper chiamato ma senza `anno_id` nel payload è segnalato (è la rottura 1 della prova del rosso)', () => {
    const v = violazioniDichiarate([
      finto(
        'src/app/api/x/route.ts',
        `import { resolveAnnoScrittura } from '@/lib/auth/scope'
         import { conAnno } from '@/lib/anno/tipi'
         const esito = await resolveAnnoScrittura(request, supabase, user, scuolaId)
         await supabase.from('votazioni').insert({ titolo: 'x' })`,
      ),
    ])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('anno_id')
  })

  it('due insert su tabelle dichiarate nello stesso file: quello con conAnno non copre quello senza', () => {
    const v = violazioniDichiarate([
      finto(
        'src/app/api/x/route.ts',
        `import { resolveAnnoScrittura } from '@/lib/auth/scope'
         import { conAnno } from '@/lib/anno/tipi'
         const esito = await resolveAnnoScrittura(request, supabase, user, scuolaId)
         await supabase.from('sections').insert({ name: 'A', ...conAnno(esito) })
         await supabase.from('votazioni').insert({ titolo: 'x' })`,
      ),
    ])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('votazioni')
    // e `anno_id` in una stringa (`.select('anno_id')`) non è una scrittura di `anno_id`
    const inStringa = violazioniDichiarate([
      finto(
        'src/app/api/x/route.ts',
        `const e = await resolveAnnoScrittura(request, supabase, user, scuolaId)
         await supabase.from('sections').select('anno_id').eq('anno_id', 1)
         await supabase.from('sections').insert({ name: 'A' })`,
      ),
    ])
    expect(inStringa).toHaveLength(1)
  })

  it('una chiamata a seedCertificato senza esito è segnalata, con esito no', () => {
    const senza = finto('src/app/api/x/route.ts', 'await seedCertificato(supabase, sectionId, alunnoId)')
    expect(chiamateSenzaEsito([senza], 'seedCertificato', 4)).toHaveLength(1)
    const con = finto('src/app/api/x/route.ts', 'await seedCertificato(supabase, body.sectionId, alunnoId, esito)')
    expect(chiamateSenzaEsito([con], 'seedCertificato', 4)).toEqual([])
    const annidata = finto('src/app/api/x/route.ts', 'await seedCertificato(supabase, f(a, b), alunnoId)')
    expect(chiamateSenzaEsito([annidata], 'seedCertificato', 4)).toHaveLength(1)
  })

  it('un commento lungo fra `.from(…)` e `.insert(` non nasconde la scrittura', () => {
    const commento = '// ' + 'x'.repeat(200)
    const a = finto('src/app/api/x/route.ts', `await supabase.from('sections')\n  ${commento}\n  .insert({ name: 'A' })`)
    expect(a.scritture).toEqual([expect.objectContaining({ tabella: 'sections', op: 'insert' })])
  })

  it('un insert dentro un commento o dentro una stringa è ignorato', () => {
    const a = finto(
      'src/app/api/x/route.ts',
      "// await supabase.from('sections').insert({ a: 1 })\n/* supabase.from('votazioni').insert({}) */\nconst s = \"supabase.from('sections').insert({})\"\nconst t = `.from('sections').insert({})`",
    )
    expect(a.scritture).toEqual([])
    expect(violazioniDichiarate([a])).toEqual([])
  })

  it('`supabase.from(tabella)` con nome variabile è segnalato come «tabella non leggibile»', () => {
    const a = finto('src/app/api/x/route.ts', 'await supabase.from(tabella).insert({ a: 1 })')
    expect(a.scritture).toEqual([expect.objectContaining({ tabella: null, op: 'insert' })])
    const v = violazioniDichiarate([a])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('tabella non leggibile')
    // e senza una voce in TABELLE_IN_VARIABILE non passa nemmeno la regola dedicata
    expect(violazioniNonLeggibili([a], [])).toHaveLength(1)
  })

  it('una costante `const TABELLA = "…"` con una sola dichiarazione rende la tabella leggibile', () => {
    const a = finto('src/lib/x.ts', "const TABELLA = 'armadietto_richieste'\nawait admin.from(TABELLA).insert({ a: 1 })")
    expect(a.scritture[0].tabella).toBe('armadietto_richieste')
    const doppia = finto('src/lib/x.ts', "const T = 'a'\nfunction f() { const T = 'b' }\nawait admin.from(T).insert({})")
    expect(doppia.scritture[0].tabella).toBeNull()
  })

  it('anche `(supabase.from(x) as unknown as T).delete(` è una scrittura (la forma del ripiego di oblio)', () => {
    const a = finto('src/lib/x.ts', 'await (supabase.from(tabella) as unknown as TabellaDiretta).delete({ count: "exact" }).neq("id", 1)')
    expect(a.scritture).toEqual([expect.objectContaining({ tabella: null, op: 'delete' })])
  })

  it('`.rpc("anno_oblio_scrivi")` è pulito: una rpc non è una scrittura diretta', () => {
    const a = finto(
      'src/lib/gdpr/x.ts',
      "await supabase.rpc('anno_oblio_scrivi', { p_azione: 'update', p_tabella: 'presenze' })",
    )
    expect(a.scritture).toEqual([])
    expect(violazioniOblio([a])).toEqual([])
  })

  it('`getMonth()` che decide l’anno fuori dal modulo dell’anno è segnalato; per mostrare un mese no', () => {
    const calcolo = finto('src/lib/x.ts', 'const inizio = d.getMonth() >= 8 ? y : y - 1')
    const v = violazioniAnnoAMano([calcolo], [], 0)
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('getMonth()')
    const mostra = finto('src/lib/y.ts', "const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`")
    expect(violazioniAnnoAMano([mostra], [], 0)).toEqual([])
    // dentro il modulo dell'anno è ammesso
    expect(violazioniAnnoAMano([finto('src/lib/anno/x.ts', 'const m = d.getMonth() >= 8')], [], 0)).toEqual([])
    expect(violazioniAnnoAMano([finto('src/lib/auth/scope.ts', 'const m = d.getMonth() >= 8')], [], 0)).toEqual([])
  })

  it('i letterali `-08-01` e `-07-31` contano nelle stringhe, non nei commenti né in una data piena', () => {
    expect(violazioniAnnoAMano([finto('src/lib/x.ts', 'const inizio = `${anno}-08-01`')], [], 0)).toHaveLength(1)
    expect(violazioniAnnoAMano([finto('src/lib/x.ts', "const fine = fine + '-07-31'")], [], 0)).toHaveLength(1)
    expect(violazioniAnnoAMano([finto('src/lib/x.ts', '// vale dal `${anno}-08-01`')], [], 0)).toEqual([])
    expect(violazioniAnnoAMano([finto('src/lib/x.ts', "export const VERSIONE = '2026-07-31'")], [], 0)).toEqual([])
    expect(violazioniAnnoAMano([finto('src/lib/x.ts', 'const a = annoScolasticoCorrente(new Date())')], [], 0)).toHaveLength(1)
  })

  it('i pagamenti: l’insert deve nominare scadenza o periodo_competenza entro 40 righe', () => {
    const senza = finto('src/lib/x.ts', "await s.from('pagamenti').insert({ importo: 10, alunno_id })")
    expect(violazioniDichiarate([senza])).toHaveLength(1)
    const con = finto('src/lib/x.ts', "await s.from('pagamenti').insert({ importo: 10, scadenza: giorno })")
    expect(violazioniDichiarate([con])).toEqual([])
    const lontano = finto('src/lib/x.ts', "const scadenza = 1\n" + '\n'.repeat(60) + "await s.from('pagamenti').insert({ importo: 10 })")
    expect(violazioniDichiarate([lontano])).toHaveLength(1)
  })

  it('`frequenze` si scrive solo da scriviFrequenza', () => {
    const fuori = finto('src/app/api/x/route.ts', "await s.from('frequenze').insert({ alunno_id })")
    expect(violazioniDichiarate([fuori])).toHaveLength(1)
    const dentro = finto('src/lib/anno/frequenze.ts', "await s.from('frequenze').insert({ alunno_id })")
    expect(violazioniDichiarate([dentro])).toEqual([])
  })

  it('zona oblio: un update diretto su una tabella del registro è segnalato; il ripiego dichiarato no; `.from(variabile)` solo con elenco letterale', () => {
    const diretto = finto('src/lib/gdpr/esegui.ts', "await supabase.from('presenze').update({ nota: null }).eq('alunno_id', id)")
    expect(violazioniOblio([diretto])).toHaveLength(1)
    const ripiego = finto('src/lib/gdpr/oblio-registro.ts', "await supabase.from(o.tabella).update({ nota: null })")
    expect(violazioniOblio([ripiego])).toEqual([])
    // l'eccezione del ripiego vale per i `.from(variabile)`, non per tutto il file: un letterale resta rosso
    const letteraleNelRipiego = finto('src/lib/gdpr/oblio-registro.ts', "await supabase.from('presenze').update({ nota: null })")
    expect(violazioniOblio([letteraleNelRipiego])).toHaveLength(1)
    const fuoriZona = finto('src/lib/altro/x.ts', "await supabase.from('presenze').update({ nota: null })")
    expect(violazioniOblio([fuoriZona])).toEqual([])
    const nonRegistro = finto('src/lib/gdpr/y.ts', "await supabase.from('certificati_medici').delete().in('id', ids)")
    expect(violazioniOblio([nonRegistro])).toEqual([])
    const variabileNuda = finto('src/lib/gdpr/z.ts', 'await supabase.from(t).delete().in("id", ids)')
    expect(violazioniOblio([variabileNuda])).toHaveLength(1)
    const variabileConElenco = finto(
      'src/lib/gdpr/z.ts',
      "const OK = new Set(['pagelle', 'student_documents'])\nawait supabase.from(t).delete().in('id', ids)",
    )
    expect(violazioniOblio([variabileConElenco])).toEqual([])
    const retention = finto('src/app/api/gdpr/retention-galleria/route.ts', "await s.from('galleria_media_v2').delete().eq('id', 1)")
    expect(violazioniOblio([retention])).toHaveLength(1)
    const wipe = finto('src/app/api/admin/wipe/route.ts', "await s.from('presenze').delete().neq('id', 0)")
    expect(violazioniOblio([wipe])).toHaveLength(1)
  })

  it('doppia scrittura: `alunni` con colonne copiate vuole la CHIAMATA a scriviFrequenza (l’import non basta) o ESENTI', () => {
    const colonne = ['sospeso', 'section_id']
    const nuda = finto('src/lib/x.ts', "await s.from('alunni').update({ sospeso: true }).eq('id', id)")
    expect(violazioniDoppiaScrittura([nuda], colonne, [])).toHaveLength(1)
    const conChiamata = finto(
      'src/lib/x.ts',
      "import { scriviFrequenza } from '@/lib/anno/frequenze'\nawait s.from('alunni').update({ sospeso: true })\nawait scriviFrequenza(s, {})",
    )
    expect(violazioniDoppiaScrittura([conChiamata], colonne, [])).toEqual([])
    const soloImport = finto(
      'src/lib/x.ts',
      "import { scriviFrequenza } from '@/lib/anno/frequenze'\nawait s.from('alunni').update({ sospeso: true })",
    )
    expect(violazioniDoppiaScrittura([soloImport], colonne, [])).toHaveLength(1)
    expect(violazioniDoppiaScrittura([nuda], colonne, [{ file: 'src/lib/x.ts', motivo: 'm' }])).toEqual([])
    const anagrafica = finto('src/lib/y.ts', "await s.from('alunni').update({ nome: 'x' })")
    expect(violazioniDoppiaScrittura([anagrafica], colonne, [])).toEqual([])
    const variabile = finto('src/lib/y.ts', "const daScrivere = { sospeso: false }\nawait s.from('alunni').update(daScrivere)")
    expect(violazioniDoppiaScrittura([variabile], colonne, [])).toHaveLength(1)
  })

  it('SQL: una ridefinizione più recente di una funzione di oblio senza interruttore è segnalata; con l’interruttore no; un commento non salva', () => {
    const f: FunzioneRegistro[] = [{ funzione: 'elimina_alunno_definitivo', tabelle: ['presenze'], classe: 'oblio' }]
    const buona: Migrazione = {
      nome: '20260101000000_a.sql',
      testo: "CREATE OR REPLACE FUNCTION public.elimina_alunno_definitivo(p uuid)\nRETURNS void LANGUAGE plpgsql AS $$\nBEGIN PERFORM set_config('anno_chiuso.oblio','on',true); DELETE FROM presenze; END $$;",
    }
    expect(violazioniSql(f, [buona])).toEqual([])
    const finta: Migrazione = {
      nome: '29990101000000_finta.sql',
      testo: '-- anno_oblio_attiva() qui nel commento non conta\nCREATE OR REPLACE FUNCTION public.elimina_alunno_definitivo(p uuid)\nRETURNS void LANGUAGE plpgsql AS $$\nBEGIN DELETE FROM presenze; END $$;',
    }
    const v = violazioniSql(f, [buona, finta])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('29990101000000_finta.sql')
    // un'ultima definizione dentro un `DO … EXECUTE $def$ … AS $function$ … $function$ … $def$` si legge lo stesso
    const nidificata: Migrazione = {
      nome: '29990102000000_do.sql',
      testo: "DO $do$ BEGIN EXECUTE $def$ CREATE OR REPLACE FUNCTION public.elimina_alunno_definitivo(p uuid) RETURNS void LANGUAGE plpgsql AS $function$ BEGIN PERFORM public.anno_oblio_attiva(); END $function$; $def$; END $do$;",
    }
    expect(violazioniSql(f, [buona, finta, nidificata])).toEqual([])
    // e una funzione senza classe è segnalata
    expect(violazioniSql([{ funzione: 'nuova_fn', tabelle: ['presenze'] }], [])).toHaveLength(1)
  })

  it('zero file letti fanno rosso i minimi (la cecità)', () => {
    const vuoto = misura([], COLONNE_COPIATE, FIXTURE_FUNZIONI.funzioni)
    expect(vuoto.fileEsaminati).toBe(0)
    const v = violazioniMinimi(vuoto, insertPerDichiarata([]))
    expect(v.length).toBeGreaterThanOrEqual(6)
  })
})

describe('anno-scrittura-coverage — 2. le scritture dichiarate portano l’anno', () => {
  it('ogni insert/upsert su una tabella dichiarata ricava l’anno da un helper e scrive anno_id', () => {
    const v = violazioniDichiarate(ANALISI)
    expect(
      v,
      `Scritture sul registro dell'anno senza l'anno dichiarato (${v.length}). Chiama resolveAnnoScrittura/annoDellaData/` +
        `annoPerScritturaPubblica e scrivi \`...conAnno(esito)\` nel payload; per \`pagamenti\` nomina scadenza o periodo_competenza.` +
        elenco(v),
    ).toEqual([])
  })

  it('le tabelle dichiarate sono quelle del database (fixture), `pagamenti` e `frequenze` incluse', () => {
    expect([...DICHIARATE].sort()).toEqual(expect.arrayContaining(['pagamenti', 'frequenze', 'sections', 'votazioni']))
    expect(Object.keys(ESENTI_PER_DATA).every((t) => DICHIARATE.has(t))).toBe(true)
  })

  it('ogni indirezione dichiarata è viva: il file chiama davvero un helper primario / riceve l’esito', () => {
    for (const [nome, d] of Object.entries(HELPER_INDIRETTI)) {
      const a = PER_PERCORSO.get(d.file)
      expect(a, `${nome}: ${d.file} non esiste più`).toBeDefined()
      expect(HELPER_ANNO.some((h) => new RegExp(`\\b${h}\\s*\\(`).test(a!.m.struttura)), `${d.file} non chiama nessun helper primario`).toBe(true)
      expect(new RegExp(`export\\s+(async\\s+)?function\\s+${nome}\\b`).test(a!.m.senzaCommenti), `${nome} non è più definita in ${d.file}`).toBe(true)
      const chiamanti = ANALISI.filter((x) => x.percorso !== d.file && new RegExp(`\\b${nome}\\s*\\(`).test(x.m.struttura))
      expect(chiamanti.length, `${nome} non ha più chiamanti: togli la voce`).toBeGreaterThan(0)
    }
    for (const file of Object.keys(RICEVONO_L_ESITO)) {
      const a = PER_PERCORSO.get(file)
      expect(a, `${file} non esiste più`).toBeDefined()
      expect(/\bEsitoAnno\b/.test(importi(a!)), `${file} non importa più EsitoAnno`).toBe(true)
      expect(a!.scritture.some((s) => s.tabella && DICHIARATE.has(s.tabella) && (s.op === 'insert' || s.op === 'upsert')), `${file} non scrive più una tabella dichiarata`).toBe(true)
    }
  })

  it('`seedCertificato` ha `esito` OBBLIGATORIO nel tipo e ogni chiamata in src/ passa l’argomento dell’esito', () => {
    const def = PER_PERCORSO.get('src/lib/competenze/certificato-store.ts')!
    expect(/\besito\s*:\s*EsitoAnno\b/.test(def.m.struttura), 'in certificato-store.ts `esito` deve essere `esito: EsitoAnno` (non `esito?:`)').toBe(true)
    expect(/\besito\s*\?\s*:/.test(def.m.struttura)).toBe(false)
    const mancanti = chiamateSenzaEsito(ANALISI, 'seedCertificato', 4)
    expect(mancanti, 'chiamate a seedCertificato senza il 4° argomento (esito):' + elenco(mancanti.map((m) => m.testo))).toEqual([])
    const chiamate = ANALISI.reduce((n, a) => n + contaChiamate(a, 'seedCertificato'), 0)
    expect(chiamate, 'nessuna chiamata a seedCertificato trovata: il controllo sarebbe cieco').toBeGreaterThanOrEqual(1)
  })

  it('le tabelle in variabile sono tutte dichiarate, con il loro tetto, e nessuna è una dichiarata', () => {
    const v = violazioniNonLeggibili(ANALISI)
    expect(v, 'Una scrittura con `.from(variabile)` non si legge: dichiarala in TABELLE_IN_VARIABILE con le tabelle possibili.' + elenco(v)).toEqual([])
  })
})

describe('anno-scrittura-coverage — 3. la zona oblio scrive il registro solo dalle RPC', () => {
  it('nessun update/delete/upsert diretto su una tabella del registro in src/lib/gdpr, retention-*, admin/wipe', () => {
    const v = violazioniOblio(ANALISI)
    expect(
      v,
      `Scritture dirette sul registro nella zona oblio (${v.length}): passano da scriviOblio / svuotaOblio (RPC con l'interruttore), ` +
        `altrimenti a guardia accesa riceverebbero 409 ANNO_CHIUSO.` +
        elenco(v),
    ).toEqual([])
  })

  it('l’unica eccezione, il ripiego di oblio-registro.ts, esiste e scrive davvero in diretta', () => {
    for (const file of Object.keys(ECCEZIONI_ZONA_OBLIO)) {
      const a = PER_PERCORSO.get(file)
      expect(a, `${file} non esiste più: togli l'eccezione`).toBeDefined()
      expect(a!.scritture.some((s) => s.tabella === null && s.op !== 'insert'), `${file} non scrive più in diretta: togli l'eccezione`).toBe(true)
    }
  })

  it('la zona esiste ed è letta (non vuota)', () => {
    expect(ANALISI.filter((a) => inZonaOblio(a.percorso)).length).toBeGreaterThanOrEqual(5)
    expect(ANALISI.some((a) => /^src\/app\/api\/gdpr\/retention-/.test(a.percorso))).toBe(true)
    expect(ANALISI.some((a) => /^src\/app\/api\/admin\/wipe\//.test(a.percorso))).toBe(true)
  })

  it('l’allowlist dell’oblio (COPPIE_OBLIO_AMMESSE) nomina solo tabelle del registro', () => {
    const tabelle = new Set(COPPIE_OBLIO_AMMESSE.map((c) => c.split('|')[1]))
    const fuori = [...tabelle].filter((t) => !REGISTRO.has(t))
    expect(fuori, `tabelle dell'allowlist non nel registro (tabelle-anno.json): ${fuori.join(', ')}`).toEqual([])
  })
})

describe('anno-scrittura-coverage — 4. la doppia scrittura alunni → frequenze', () => {
  it('le colonne copiate si leggono dalla migrazione e coincidono con quelle di campiFrequenzaDaAlunno', () => {
    expect(COLONNE_COPIATE.length).toBe(14) // le 15 del trigger meno scuola_id
    const ts = fs.readFileSync(path.join(CWD, 'src/lib/anno/frequenze.ts'), 'utf8')
    const daTs = [...ts.matchAll(/\bha\(patch,\s*'([a-z_]+)'\)/g)].map((x) => x[1])
    expect([...new Set(daTs)].sort(), 'campiFrequenzaDaAlunno e il trigger copiano colonne diverse: alunni_specchio_frequenza (M1) vs frequenze.ts').toEqual([...COLONNE_COPIATE].sort())
  })

  it('ogni scrittura di `alunni` con colonne copiate chiama scriviFrequenza o sta in ESENTI', () => {
    const v = violazioniDoppiaScrittura(ANALISI, COLONNE_COPIATE, ESENTI)
    expect(
      v,
      `Scritture di alunni con colonne copiate senza scriviFrequenza (${v.length}). Chiama scriviFrequenza dopo la scrittura, ` +
        `oppure aggiungi il file a ESENTI di src/lib/anno/frequenze.ts con il motivo.` +
        elenco(v),
    ).toEqual([])
  })

  it('ogni voce di ESENTI è viva: il file scrive `alunni` e NON chiama scriviFrequenza', () => {
    for (const e of ESENTI) {
      const a = PER_PERCORSO.get(e.file)
      expect(a, `${e.file} non esiste più: togli la voce da ESENTI`).toBeDefined()
      expect(a!.scritture.some((s) => s.tabella === 'alunni' && s.op !== 'delete'), `${e.file} non scrive più alunni: togli la voce`).toBe(true)
      expect(/\bscriviFrequenza\s*\(/.test(a!.m.struttura), `${e.file} chiama scriviFrequenza: non è più un'eccezione`).toBe(false)
      expect(e.motivo.length, `${e.file}: ESENTI vuole un motivo`).toBeGreaterThan(20)
    }
  })
})

describe('anno-scrittura-coverage — 5. l’anno non si calcola a mano', () => {
  it('fuori da src/lib/anno/, src/lib/auth/scope.ts e src/lib/anno-scolastico.ts nessun annoScolasticoCorrente(, -08-01, -07-31, getMonth() dell’anno, se non nell’elenco di oggi', () => {
    const v = violazioniAnnoAMano(ANALISI)
    expect(
      v,
      `Calcolo dell'anno a mano fuori dal modulo dell'anno (${v.length}). Usa annoDellaData / resolveAnnoScrittura. ` +
        `L'elenco ANNO_A_MANO_DI_OGGI può solo scendere (tetto ${TETTO_ANNO_A_MANO}, la PR 4.1 lo svuota).` +
        elenco(v),
    ).toEqual([])
  })

  it('esamina tutto src/ (almeno 1.500 file .ts/.tsx: oggi sono ~1.680) e non è cieco', () => {
    expect(ANALISI.length, `Il lock dell'anno a mano ha esaminato ${ANALISI.length} file di src/: ne servono almeno 1500`).toBeGreaterThanOrEqual(1500)
    // lo stesso insieme di file del minimo `fileLetti` della sezione 7
    expect(ANALISI.length).toBe(misura(ANALISI, COLONNE_COPIATE, FIXTURE_FUNZIONI.funzioni).fileLetti)
  })

  it('campione fisso: 6 frammenti di codice veri sono riconosciuti, 6 sosia no', () => {
    const modelli = (codice: string) => modelliAnnoNelFile(finto('src/lib/x/campione.ts', codice))
    const positivi = [
      'function f() { return `${fine}-07-31` }',
      'const q = { from: `${anno}-09-01` }',
      'function g(mese, anno) { return mese >= 9 ? anno : anno + 1 }',
      'const start = d.getMonth() >= 8 ? y : y - 1',
      'const ok = n.getMonth() + 1 >= 9',
      'const MESE_RIPIEGO_AMBIGUO = MESE_INIZIO_ANNO_SCOLASTICO - 1',
    ]
    const negativi = [
      'const ok = d.getMonth() + 1 === mese',
      "const CONSENSI_VERSIONE = '2026-07-31'",
      '// il 1° settembre: ${anno}-09-01\nconst a = 1',
      'for (let m = 1; m <= 12; m++) { somma += m }',
      'const etichetta = `${a}/${a + 1}`',
      'const mm = meseCivile(istante).slice(5, 7)',
    ]
    for (const c of positivi) expect(modelli(c), c).not.toEqual([])
    for (const c of negativi) expect(modelli(c), c).toEqual([])
  })

  it('il tetto è il numero di oggi e ogni voce dice quale PR la toglie', () => {
    expect(ANNO_A_MANO_DI_OGGI.length).toBeLessThanOrEqual(TETTO_ANNO_A_MANO)
    expect(TETTO_ANNO_A_MANO).toBeLessThanOrEqual(13) // 10 il 2026-11-07, 9 dall'08/11 (anno-scolastico.ts esente), 17 dall'08/11 (4.1.L: vede anche le soglie al 1° settembre), 13 dall'08/11 (4.1.S1: −4, prestampati e documenti sul modulo dell'anno); scende, non sale
    expect(ANNO_A_MANO_DI_OGGI.every((e) => /PR 4\.1/.test(e.motivo))).toBe(true)
  })
})

describe('anno-scrittura-coverage — 6. SQL', () => {
  it('ogni funzione che scrive il registro ha una classe, e le funzioni di oblio accendono l’interruttore nella loro ULTIMA definizione', () => {
    const v = violazioniSql(FIXTURE_FUNZIONI.funzioni, MIGRAZIONI)
    expect(
      v,
      `SQL del registro dell'anno (${v.length}). Una funzione nuova in funzioni-scrivono-registro.json vuole una \`classe\`; ` +
        `una funzione di oblio vuole anno_oblio_attiva() / set_config('anno_chiuso.oblio','on',true) nella sua ultima definizione. ` +
        `Il fixture si rigenera così (il catalogo non è in PGlite): ${COME_SI_RIGENERA_FUNZIONI}` +
        elenco(v),
    ).toEqual([])
  })

  it('le cinque video_* senza interruttore sono davvero di classe oblio (nessuna eccezione morta)', () => {
    for (const nome of Object.keys(OBLIO_VIA_SENZA_INTERRUTTORE)) {
      const f = FIXTURE_FUNZIONI.funzioni.find((x) => x.funzione === nome)
      expect(f, `${nome} non è più nel fixture: togli l'eccezione`).toBeDefined()
      expect(f!.classe).toBe('oblio')
    }
  })

  it('le funzioni di oblio che richiedono l’interruttore hanno una definizione nelle migrazioni (e quali no, lo dice il rapporto)', () => {
    const richiedono = FIXTURE_FUNZIONI.funzioni.filter((f) => f.classe === 'oblio' && !(f.funzione in OBLIO_VIA_SENZA_INTERRUTTORE))
    expect(richiedono.length).toBeGreaterThanOrEqual(3)
    for (const f of richiedono) expect(ultimaDefinizione(f.funzione, MIGRAZIONI), `${f.funzione}: nessuna definizione nelle migrazioni`).not.toBeNull()
  })

  it('la prova del rosso 5 non è rimasta accesa: l’iniezione di test è vuota', () => {
    expect(INIEZIONE_PROVA_ROSSO_SQL).toEqual([])
  })
})

describe('anno-scrittura-coverage — 7. i minimi (un lock cieco è verde)', () => {
  const misure = misura(ANALISI, COLONNE_COPIATE, FIXTURE_FUNZIONI.funzioni)

  it('la scansione ha letto abbastanza: file, scritture, dichiarate, pagamenti, siti alunni, funzioni', () => {
    const v = violazioniMinimi(misure, insertPerDichiarata(ANALISI))
    expect(v, `Il lock ha letto troppo poco (${JSON.stringify(misure)}): lo scanner è cieco, o è sparita una scrittura legittima (abbassa il minimo SCRIVENDO perché).` + elenco(v)).toEqual([])
  })

  it('ogni minimo porta accanto il misurato e la data', () => {
    for (const m of MINIMI) expect(m.nota, m.chiave).toMatch(/2026-11-07/)
  })

  it('la tabella delle funzioni nel fixture è quella generata (ha una data e un comando per rigenerarla)', () => {
    expect(COME_SI_RIGENERA_FUNZIONI).toMatch(/funzioni-registro-fotografia/)
    expect(FIXTURE_TABELLE._come_si_rigenera).toMatch(/tabelle-anno-fotografia/)
    expect(REGISTRO.size).toBe(46)
  })

  it('la scansione di src/ è una sola per file di test', () => {
    // ANALISI è calcolata una volta a livello di modulo; MS_SCANSIONE è il suo costo (riportato nel rapporto del 3.9)
    expect(MS_SCANSIONE).toBeGreaterThanOrEqual(0)
    expect(ANALISI.length).toBe(misure.fileLetti)
  })
})
