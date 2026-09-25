import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineCatena, fineParentesi, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * LOCK — OGNI LETTURA DI `student_documents` DICHIARA COSA FA DEL CESTINO.
 *
 * ─── Il guasto che questo lock esiste per impedire ───────────────────────────
 *
 * Dal 2026-09-24 (spec «sei interventi», F1) `student_documents` ha il cestino:
 * «Elimina» e «Sostituisci il file» non cancellano, scrivono `eliminato_il`, e la
 * purga toglie riga e file dopo `GIORNI_CESTINO_REGISTRO` giorni. Quasi tutte le
 * letture passano dal **service-role**, che la RLS non la vede: il filtro va
 * scritto nella query, e basta UNA lettura dimenticata perché un documento
 * sanitario eliminato — una diagnosi, un PEI, un verbale della 104 — riappaia.
 * Non con un errore: riappare, e nessuno lo sa. Nel fascicolo, nell'archivio dei
 * documenti firmati, nel promemoria delle scadenze, o come autorizzazione di una
 * gita che la Segreteria aveva tolto.
 *
 * ─── PERCHÉ «DICHIARA» E NON «FILTRA SEMPRE» ─────────────────────────────────
 *
 * Stesso disegno del lock gemello `cestino-galleria-ogni-lettura-dichiara`: il
 * preventivo dell'oblio (`cosa-distrugge.ts`) deve contare ANCHE i documenti nel
 * cestino, perché l'esecuzione (`obliaFascicoloAlunno`) li cancella tutti. Un
 * preventivo che filtrasse le sole vive annuncerebbe MENO di quanto accade. Quindi
 * il lock non pretende un filtro: pretende una **dichiarazione**, con uno dei tre
 * nomi di `src/lib/primaria/cestino-fascicolo.ts`:
 *
 *   · `fascicoloVivo(q)`                — le sole righe vive;
 *   · `fascicoloNelCestino(q)`          — il cestino (elenco, ripristino, purga);
 *   · `fascicoloAncheNelCestino(q, m)`  — l'identità, con la ragione per esteso.
 *
 * ─── L'UNICA ESENZIONE: L'INSERT ─────────────────────────────────────────────
 *
 * Una catena che comincia con `.insert(` fa NASCERE una riga, e una riga appena
 * nata è viva per costruzione: il `.select()` che la segue legge solo ciò che ha
 * appena scritto. Pretendere un marcatore lì sarebbe rumore, e il rumore è ciò che
 * insegna ad aggiungere marcatori senza pensare. `.upsert(` NON è esente: può
 * aggiornare una riga esistente, e quindi anche una nel cestino.
 *
 * ─── COME MISURA ──────────────────────────────────────────────────────────────
 *
 * Come il gemello: `mascheraSorgente` (commenti spenti, indici invariati) e
 * `fineCatena`; per ogni `.from('student_documents')` si guarda la catena e i
 * WRAPPER che la avvolgono (`fascicoloVivo(supabase.from(…)…)`), risalendo
 * attraverso `await`, parentesi e virgole. Un marcatore vale solo se il file lo
 * IMPORTA dal modulo della regola, senza alias: un omonimo locale che restituisce
 * la query intatta soddisferebbe la stringa e non filtrerebbe niente (la lezione
 * pagata dal gemello il 2026-09-12).
 *
 * Il riconoscitore è una funzione PURA di (percorso, sorgente): la prova «il lock
 * sa ancora distinguere» la esegue su sorgenti finti scritti qui sotto, in modo
 * che una sua cecità diventi rossa invece di silenziosa.
 *
 * ─── IL PERIMETRO, DETTO PRIMA CHE QUALCUNO LO DIA PER TOTALE ─────────────────
 *
 *  · Solo i letterali `from('student_documents')` di `src/`. Due posti la
 *    raggiungono per NOME di tabella in una variabile, e il lock non li vede:
 *    l'oblio (`obliaFascicoloAlunno` → `obliaFileDaTabella`, src/lib/gdpr/esegui.ts),
 *    che DEVE prendere anche il cestino ed è il verso giusto, e l'inventario delle
 *    tracce di un docente (`tracce-docente-voci.ts`), che conta le righe per
 *    `caricato_da` sulla FK e deve contarle tutte.
 *  · Misurato in produzione il 2026-09-25 (sola lettura, `pg_views`/`pg_proc`):
 *    NESSUNA vista e NESSUNA funzione di `public` nomina `student_documents`.
 *    Quando ne nascerà una, la sua decisione sul cestino si prende nella
 *    migrazione: questo file non la vedrà mai.
 *  · Le funzioni edge di `supabase/functions/` NON passano dal riconoscitore dei
 *    marcatori: sono Deno e non possono importare `fascicoloVivo` da `src/`. Hanno
 *    una prova PROPRIA, più rozza e più severa (l'ultima di questo file): ogni
 *    catena `from('student_documents')` che non sia un insert deve scrivere a mano
 *    il filtro del cestino, `.is('eliminato_il', null)` per le vive oppure
 *    `.not('eliminato_il', 'is', null)` per il cestino — lì una deroga «anche nel
 *    cestino» non esiste. Al 2026-09-25 l'unica è `document-expiry-alert`, sostituita
 *    da `notifiche/promemoria` ma ancora distribuibile con `supabase functions
 *    deploy`: filtra a mano `eliminato_il IS NULL`, perché un documento eliminato
 *    non è «in scadenza».
 */

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')

const MARCATORI = ['fascicoloVivo', 'fascicoloNelCestino', 'fascicoloAncheNelCestino'] as const

/** `from('student_documents')`, con o senza spazi, apici singoli o doppi. */
const DA_TABELLA = /\bfrom\s*\(\s*['"]student_documents['"]\s*\)/g

/** Il modulo della regola. Non è sorvegliato da sé stesso. */
const MODULO = 'src/lib/primaria/cestino-fascicolo.ts'

/** L'import NOMINATO dal modulo, in qualunque forma di specificatore. */
const IMPORT_MODULO = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*primaria\/cestino-fascicolo(?:\.[jt]s)?['"]/g

/** Sessanta caratteri: la stessa soglia del gemello. Sotto, è un'etichetta. */
const RAGIONE_MINIMA = 60

function marcatoriImportati(senzaCommenti: string): Set<string> {
  const nomi = new Set<string>()
  IMPORT_MODULO.lastIndex = 0
  for (const m of senzaCommenti.matchAll(IMPORT_MODULO)) {
    for (const pezzo of m[1].split(',')) {
      const nudo = pezzo.replace(/\btype\b/, '').trim()
      // `a as b` NON è contato: `fascicoloAncheNelCestino as fascicoloVivo` direbbe
      // «filtro» su un'identità.
      if (nudo && /^[A-Za-z_$][\w$]*$/.test(nudo)) nomi.add(nudo)
    }
  }
  return nomi
}

// ─────────────────────────────────────────────────────────────────────────────
// Il riconoscitore
// ─────────────────────────────────────────────────────────────────────────────

const IDENT = /[A-Za-z0-9_$]/

function aperturaParentesi(strut: string, chiusura: number): number {
  let livello = 0
  for (let k = chiusura; k >= 0; k--) {
    if (strut[k] === ')') livello++
    else if (strut[k] === '(') {
      livello--
      if (livello === 0) return k
    }
  }
  return 0
}

/** Inizio dell'espressione ricevitore di `.from(` (`supabase`, `createAdminClient()`…). */
function inizioRicevitore(strut: string, puntoFrom: number): number {
  let k = puntoFrom - 1
  const spazi = () => { while (k >= 0 && /\s/.test(strut[k])) k-- }
  spazi()
  for (;;) {
    if (k < 0) break
    if (IDENT.test(strut[k])) { while (k >= 0 && IDENT.test(strut[k])) k-- }
    else if (strut[k] === ')') k = aperturaParentesi(strut, k) - 1
    else if (strut[k] === '!') k--
    else break
    let j = k
    while (j >= 0 && /\s/.test(strut[j])) j--
    if (j >= 0 && strut[j] === '.') { k = j - 1; spazi(); continue }
    break
  }
  return k + 1
}

interface Wrapper { nome: string; apertura: number }

/** I wrapper che avvolgono la catena, dal più interno al più esterno (tetto: 12 giri). */
function wrapperAMonte(strut: string, inizio: number): Wrapper[] {
  const trovati: Wrapper[] = []
  let k = inizio - 1
  const spazi = () => { while (k >= 0 && /\s/.test(strut[k])) k-- }
  for (let giri = 0; giri < 12; giri++) {
    spazi()
    if (k < 0) break
    if (strut[k] === '(') {
      const apertura = k
      k--
      spazi()
      const fineId = k
      while (k >= 0 && IDENT.test(strut[k])) k--
      const nome = strut.slice(k + 1, fineId + 1)
      if (nome) trovati.push({ nome, apertura })
      continue
    }
    if (k >= 4 && strut.slice(k - 4, k + 1) === 'await') { k -= 5; continue }
    if (strut[k] === ',') { k--; continue }
    break
  }
  return trovati
}

interface Occorrenza {
  file: string
  linea: number
  /** `insert`: esente. `lettura`: tutto il resto (select, update, delete, upsert). */
  genere: 'insert' | 'lettura'
  marcatore: string | null
  motivo: string | null
  omonimo: string | null
}

function scandisci(rel: string, src: string): Occorrenza[] {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  const dalModulo = marcatoriImportati(senzaCommenti)
  const out: Occorrenza[] = []
  DA_TABELLA.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DA_TABELLA.exec(senzaCommenti)) !== null) {
    const iFrom = m.index
    let p = iFrom - 1
    while (p >= 0 && /\s/.test(struttura[p])) p--
    if (struttura[p] !== '.') continue
    const fine = fineCatena(struttura, p)

    // Il primo metodo DOPO `.from(…)`: se è `.insert(`, la riga nasce viva.
    const aperturaFrom = struttura.indexOf('(', iFrom)
    const dopoFrom = fineParentesi(struttura, aperturaFrom)
    const genere = /^\s*\.\s*insert\s*\(/.test(struttura.slice(dopoFrom)) ? 'insert' : 'lettura'

    const ric = inizioRicevitore(struttura, p)
    const wrapper = wrapperAMonte(struttura, ric)

    // 1) un marcatore applicato dentro la catena; 2) fra i wrapper che la avvolgono.
    const dentro = senzaCommenti.slice(ric, fine)
    const nellaCatena = MARCATORI.find((n) => new RegExp(`\\b${n}\\s*\\(`).test(dentro)) ?? null
    const nelWrapper = wrapper.find((v) => (MARCATORI as readonly string[]).includes(v.nome)) ?? null
    const trovato = nellaCatena ?? nelWrapper?.nome ?? null

    let marcatore: string | null = null
    let omonimo: string | null = null
    let motivo: string | null = null
    if (trovato !== null) {
      if (dalModulo.has(trovato)) marcatore = trovato
      else omonimo = trovato
    }
    if (marcatore === 'fascicoloAncheNelCestino' && nelWrapper && nellaCatena === null) {
      // Il secondo argomento: da fine catena alla `)` del wrapper.
      const chiusura = fineParentesi(struttura, nelWrapper.apertura)
      motivo = risolviCostante(senzaCommenti, senzaCommenti.slice(fine, Math.max(fine, chiusura - 1)))
    }
    out.push({ file: rel, linea: riga(src, iFrom), genere, marcatore, motivo, omonimo })
  }
  return out
}

/**
 * Se il motivo è il NOME di una costante dello stesso file (`MOTIVO_RECLAMI`), la
 * ragione è il suo valore: una concatenazione di letterali stringa. Senza questo, la
 * forma più leggibile — la ragione lunga scritta una volta, sopra — conterebbe 14
 * caratteri e il lock spingerebbe a ricopiarla in linea. Solo `const` dello STESSO
 * file e solo letterali: un valore calcolato non si legge, e resta «troppo corto».
 */
function risolviCostante(senzaCommenti: string, grezzo: string): string {
  // Via la virgola che la precede e quella (facoltativa) che la segue: `…, MOTIVO,\n)`.
  const nome = grezzo.replace(/^\s*,\s*/, '').replace(/\s*,\s*$/, '').trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(nome)) return grezzo
  const lett = String.raw`(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\`[^\`$]*\`)`
  const re = new RegExp(String.raw`\bconst\s+${nome}\s*(?::\s*string\s*)?=\s*(${lett}(?:\s*\+\s*${lett})*)`)
  const m = re.exec(senzaCommenti)
  return m ? m[1] : grezzo
}

function ragioneNuda(grezzo: string): string {
  return grezzo
    .replace(/^\s*,\s*/, '')
    .replace(/['"`+\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const scoperta = (o: Occorrenza) => o.genere === 'lettura' && o.marcatore === null

const TUTTE: Occorrenza[] = fileSorgente(SRC)
  .map((f) => path.relative(RADICE, f).split(path.sep).join('/'))
  .filter((f) => f !== MODULO)
  .flatMap((f) => scandisci(f, fs.readFileSync(path.join(RADICE, f), 'utf8')))

/**
 * CONTROLLO POSITIVO — letture dichiarate ATTESE, file per file, con zero scoperte.
 * Misura del 2026-09-25, compito F1. Il numero è ESATTO e non un tetto: un `>=`
 * renderebbe invisibile una lettura aggiunta di nascosto in un file che custodisce
 * diagnosi. Chi aggiunge una lettura dichiarata in uno di questi file alza il SUO
 * numero, e solo quello. Gli INSERT non entrano nel conto.
 */
const COPERTE_ATTESE: Record<string, number> = {
  // GET elenco · PATCH: lettura + UPDATE della modifica · DELETE: lettura + UPDATE del cestino
  'src/app/api/primaria/fascicolo/route.ts': 5,
  // lettura del vecchio · la PRESA (vecchio nel cestino) · la compensazione (torna vivo)
  'src/app/api/primaria/fascicolo/sostituisci/route.ts': 3,
  // GET cestino · lettura del documento da ripristinare · UPDATE del ripristino
  'src/app/api/primaria/fascicolo/cestino/route.ts': 3,
  'src/app/api/primaria/fascicolo/file/route.ts': 1,
  'src/app/api/documenti-firmati/route.ts': 1,
  'src/app/api/documenti-firmati/dettaglio/route.ts': 1,
  'src/app/api/notifiche/promemoria/route.ts': 1,
  'src/app/api/teacher/uscite/route.ts': 1,
  'src/app/api/parent/prestampati/route.ts': 2,
  'src/app/api/prestampati/genera/route.ts': 1,
  // `fascicoloAncheNelCestino`: il preventivo dell'oblio (l'esecuzione cancella anche il cestino)
  'src/lib/gdpr/cosa-distrugge.ts': 1,
  // La PURGA del cestino (compito PU1): `fascicoloNelCestino` sulle righe scadute da
  // togliere · `fascicoloAncheNelCestino` sui percorsi ancora citati da una riga VIVA o
  // nel cestino (un file condiviso non si cancella) · `fascicoloNelCestino` sul DELETE.
  'src/app/api/gdpr/retention-cestino-registro/route.ts': 3,
}

/**
 * SOGLIA DI SANITÀ — quante occorrenze (letture + insert) il riconoscitore deve
 * almeno VEDERE in tutto `src/`. Misurate il 2026-09-25: 23 letture dichiarate (le
 * 20 dei file F1 più le 3 della purga del cestino) e 5 insert (caricamento,
 * sostituzione, due archiviazioni dei prestampati, la firma del genitore) = 28. Era 25
 * finché la purga mancava da `COPERTE_ATTESE`: alzata, non abbassata. Se scende, prima
 * si stabilisce se è il riconoscitore a essersi rotto; solo dopo, e scrivendo QUI cosa
 * è cambiato, si abbassa.
 */
const SOGLIA_VISTE = 28

// ─────────────────────────────────────────────────────────────────────────────
// Le funzioni edge (Deno): il filtro del cestino scritto a mano
// ─────────────────────────────────────────────────────────────────────────────

const FUNZIONI_EDGE = path.join(RADICE, 'supabase', 'functions')

/**
 * Il filtro del cestino scritto a mano, nelle sole due forme che significano qualcosa:
 * `.is('eliminato_il', null)` (le vive) e `.not('eliminato_il', 'is', null)` (il cestino).
 * Si cerca sul testo SENZA COMMENTI, e il punto che lo apre deve essere codice anche nella
 * `struttura`: un `eliminato_il` citato in un commento o dentro la stringa di un `select`
 * non filtra niente.
 */
const FILTRO_A_MANO =
  /\.\s*(?:is\s*\(\s*['"]eliminato_il['"]\s*,\s*null\s*\)|not\s*\(\s*['"]eliminato_il['"]\s*,\s*['"]is['"]\s*,\s*null\s*\))/g

interface OccorrenzaEdge {
  file: string
  linea: number
  genere: 'insert' | 'lettura'
  filtrata: boolean
}

/** Funzione PURA di (percorso, sorgente), come `scandisci`: la prova sui finti la esegue. */
function scandisciEdge(rel: string, src: string): OccorrenzaEdge[] {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  const out: OccorrenzaEdge[] = []
  DA_TABELLA.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DA_TABELLA.exec(senzaCommenti)) !== null) {
    const iFrom = m.index
    let p = iFrom - 1
    while (p >= 0 && /\s/.test(struttura[p])) p--
    if (struttura[p] !== '.') continue
    const fine = fineCatena(struttura, p)
    const aperturaFrom = struttura.indexOf('(', iFrom)
    const dopoFrom = fineParentesi(struttura, aperturaFrom)
    const genere = /^\s*\.\s*insert\s*\(/.test(struttura.slice(dopoFrom)) ? 'insert' : 'lettura'
    const catena = senzaCommenti.slice(p, fine)
    let filtrata = false
    FILTRO_A_MANO.lastIndex = 0
    for (const f of catena.matchAll(FILTRO_A_MANO)) {
      // Il `.` del filtro deve essere codice, non il contenuto di una stringa mascherata.
      if (struttura[p + (f.index ?? 0)] === '.') { filtrata = true; break }
    }
    out.push({ file: rel, linea: riga(src, iFrom), genere, filtrata })
  }
  return out
}

const TUTTE_EDGE: OccorrenzaEdge[] = fileSorgente(FUNZIONI_EDGE)
  .map((f) => path.relative(RADICE, f).split(path.sep).join('/'))
  .flatMap((f) => scandisciEdge(f, fs.readFileSync(path.join(RADICE, f), 'utf8')))

/**
 * CONTROLLO POSITIVO delle funzioni edge — letture filtrate ATTESE, file per file.
 * Misura del 2026-09-25: la sola `document-expiry-alert`. Esatto, come `COPERTE_ATTESE`:
 * se il numero scende a 0 il riconoscitore potrebbe non vedere più la cartella, e la prova
 * «nessuna lettura nuda» sarebbe verde perché non guarda niente.
 */
const EDGE_ATTESE: Record<string, number> = {
  'supabase/functions/document-expiry-alert/index.ts': 1,
}

describe('lock — il cestino del fascicolo: ogni lettura di student_documents dichiara', () => {
  it('il modulo della regola esiste ed esporta i tre nomi', () => {
    const percorso = path.join(RADICE, MODULO)
    expect(fs.existsSync(percorso), `Manca ${MODULO}: è l'unico posto dove la regola del cestino del fascicolo esiste.`).toBe(true)
    const sorgente = fs.readFileSync(percorso, 'utf8')
    for (const nome of MARCATORI) {
      expect(
        new RegExp(`export function ${nome}\\b`).test(sorgente),
        `${MODULO} non esporta \`${nome}\`: è il vocabolario che questo lock riconosce.`,
      ).toBe(true)
    }
    // Il filtro VERO, non solo il nome: `fascicoloVivo` deve filtrare `eliminato_il IS NULL`.
    expect(/return\s+q\.is\(\s*'eliminato_il'\s*,\s*null\s*\)/.test(sorgente)).toBe(true)
    expect(/return\s+q\.not\(\s*'eliminato_il'\s*,\s*'is'\s*,\s*null\s*\)/.test(sorgente)).toBe(true)
  })

  it('il riconoscitore DISTINGUE: nuda, dichiarata, omonimo, alias, insert, upsert, commento', () => {
    const imp = "import { fascicoloVivo, fascicoloAncheNelCestino } from '@/lib/primaria/cestino-fascicolo'\n"
    const casi: Array<{ nome: string; src: string; atteso: Partial<Occorrenza> }> = [
      {
        nome: 'lettura nuda',
        src: imp + "const { data } = await supabase.from('student_documents').select('id').eq('student_id', a)",
        atteso: { genere: 'lettura', marcatore: null, omonimo: null },
      },
      {
        nome: 'lettura avvolta da fascicoloVivo importato',
        src: imp + "const { data } = await fascicoloVivo(\n  supabase\n    .from('student_documents')\n    .select('id')\n    .eq('id', x),\n).maybeSingle()",
        atteso: { genere: 'lettura', marcatore: 'fascicoloVivo' },
      },
      {
        nome: 'omonimo locale',
        src: "function fascicoloVivo<T>(q: T): T { return q }\nconst r = await fascicoloVivo(supabase.from('student_documents').select('id'))",
        atteso: { marcatore: null, omonimo: 'fascicoloVivo' },
      },
      {
        nome: 'alias che trasforma l’identità in «filtro»',
        src: "import { fascicoloAncheNelCestino as fascicoloVivo } from '@/lib/primaria/cestino-fascicolo'\nconst r = await fascicoloVivo(supabase.from('student_documents').select('id'))",
        atteso: { marcatore: null, omonimo: 'fascicoloVivo' },
      },
      {
        nome: 'marcatore della GALLERIA su questa tabella',
        src: "import { soloVive } from '@/lib/gallery/cestino'\nconst r = await soloVive(supabase.from('student_documents').select('id'))",
        atteso: { genere: 'lettura', marcatore: null },
      },
      {
        nome: 'insert (esente)',
        src: "const r = await supabase\n  .from('student_documents')\n  .insert({ a: 1 })\n  .select('id')\n  .single()",
        atteso: { genere: 'insert', marcatore: null },
      },
      {
        nome: 'upsert (NON esente)',
        src: "const r = await supabase.from('student_documents').upsert({ a: 1 })",
        atteso: { genere: 'lettura', marcatore: null },
      },
    ]
    const sbagliati: string[] = []
    for (const c of casi) {
      const occ = scandisci('finto.ts', c.src)
      if (occ.length !== 1) { sbagliati.push(`${c.nome}: viste ${occ.length} occorrenze, attesa 1`); continue }
      for (const [k, v] of Object.entries(c.atteso)) {
        const reale = (occ[0] as unknown as Record<string, unknown>)[k]
        if (reale !== v) sbagliati.push(`${c.nome}: ${k} = ${String(reale)}, atteso ${String(v)}`)
      }
    }
    // La ragione scritta in una COSTANTE dello stesso file si legge per valore…
    const perCostante = scandisci(
      'finto.ts',
      imp +
        "const MOTIVO = 'una ragione lunga abbastanza da essere contestata fra sei mesi, ' +\n  'scritta una volta sola sopra la query'\n" +
        "const r = await fascicoloAncheNelCestino(\n  supabase.from('student_documents').select('id'),\n  MOTIVO,\n)",
    )
    if (ragioneNuda(perCostante[0]?.motivo ?? '').length < RAGIONE_MINIMA) {
      sbagliati.push(`costante: letto «${perCostante[0]?.motivo ?? ''}», atteso il suo valore`)
    }
    // …ma un nome che non è una costante di letterali resta il nome (e quindi «corto»).
    const calcolata = scandisci(
      'finto.ts',
      imp + "const MOTIVO = costruisci()\nconst r = await fascicoloAncheNelCestino(supabase.from('student_documents').select('id'), MOTIVO)",
    )
    if (ragioneNuda(calcolata[0]?.motivo ?? '') !== 'MOTIVO') {
      sbagliati.push(`costante calcolata: letto «${calcolata[0]?.motivo ?? ''}», atteso «MOTIVO»`)
    }
    // Una query dentro un COMMENTO non è una query.
    const commentata = scandisci('finto.ts', "// supabase.from('student_documents').select('id')\n/* supabase.from('student_documents') */")
    if (commentata.length !== 0) sbagliati.push(`commento: viste ${commentata.length} occorrenze, attese 0`)
    // La ragione di `fascicoloAncheNelCestino` si LEGGE (serve alla prova delle ragioni).
    const conRagione = scandisci(
      'finto.ts',
      imp + "const r = await fascicoloAncheNelCestino(supabase.from('student_documents').select('id'), 'corta')",
    )
    if (ragioneNuda(conRagione[0]?.motivo ?? '') !== 'corta') {
      sbagliati.push(`motivo letto: «${conRagione[0]?.motivo ?? ''}», atteso «corta»`)
    }
    expect(
      sbagliati,
      'Il riconoscitore di questo lock non distingue più i casi che deve distinguere. Se una di ' +
        'queste prove è rossa, ogni altra prova del file può essere verde per il motivo peggiore: ' +
        'non guarda più niente.',
    ).toEqual([])
  })

  it('il riconoscitore VEDE le occorrenze attese (controllo positivo, conteggio esatto)', () => {
    const sbagliati: string[] = []
    for (const [file, atteso] of Object.entries(COPERTE_ATTESE)) {
      expect(fs.existsSync(path.join(RADICE, file)), `sparito: ${file}`).toBe(true)
      const occ = TUTTE.filter((o) => o.file === file && o.genere === 'lettura')
      const coperte = occ.filter((o) => o.marcatore !== null).length
      const scoperte = occ.length - coperte
      if (coperte !== atteso || scoperte !== 0) {
        sbagliati.push(`${file}: attese ${atteso} coperte e 0 scoperte, misurate ${coperte} e ${scoperte}`)
      }
    }
    expect(
      sbagliati,
      'Il controllo positivo non torna. COPERTE meno delle attese: il riconoscitore si è rotto, o ' +
        'una lettura è sparita (scrivilo qui). Di più: hai aggiunto una lettura dichiarata, alza il ' +
        'numero di QUEL file. SCOPERTE: è il difetto che questo lock esiste per prendere.',
    ).toEqual([])
  })

  it('ogni file con letture dichiarate sta in COPERTE_ATTESE (il conteggio non ha buchi)', () => {
    // La purga del cestino è rimasta fuori dall'elenco senza che niente diventasse rosso:
    // un conteggio «esatto» che non copre tutti i file è esatto solo dove qualcuno ha guardato.
    const fuori = [
      ...new Set(
        TUTTE.filter((o) => o.genere === 'lettura' && o.marcatore !== null && !(o.file in COPERTE_ATTESE)).map(
          (o) => o.file,
        ),
      ),
    ]
    expect(
      fuori,
      'Questi file leggono `student_documents` con un marcatore ma mancano da COPERTE_ATTESE: ' +
        'aggiungili col loro numero e un commento su cosa leggono (e alza SOGLIA_VISTE).',
    ).toEqual([])
  })

  it('il riconoscitore vede almeno la soglia di sanità in tutto src/', () => {
    expect(
      TUTTE.length,
      `Viste ${TUTTE.length} occorrenze di from('student_documents'), soglia ${SOGLIA_VISTE}. La prima ` +
        'ipotesi è una cecità del riconoscitore (regex, maschera, `fineCatena`), non «ne hanno tolte».',
    ).toBeGreaterThanOrEqual(SOGLIA_VISTE)
  })

  it('un marcatore vale solo se viene DAL MODULO (niente omonimi, niente alias)', () => {
    const omonimi = TUTTE.filter((o) => o.omonimo !== null).map(
      (o) => `${o.file}:${o.linea} — \`${o.omonimo}\` non è importato (senza alias) da ${MODULO}`,
    )
    expect(
      omonimi,
      'Un nome giusto su una funzione qualunque non filtra niente. Importa il marcatore vero da ' +
        '`@/lib/primaria/cestino-fascicolo`, oppure chiama la tua funzione in un altro modo.',
    ).toEqual([])
  })

  it('nessuna lettura di `student_documents` resta senza dichiarazione', () => {
    const nude = TUTTE.filter(scoperta).map((o) => `${o.file}:${o.linea}`)
    expect(
      nude,
      'Questa query legge (o aggiorna) `student_documents` senza dire niente del cestino. Scegli il ' +
        'verso e scrivilo: `fascicoloVivo(q)` se un documento eliminato non deve comparire — è quasi ' +
        'sempre questo; `fascicoloNelCestino(q)` per il cestino, il ripristino e la purga; ' +
        '`fascicoloAncheNelCestino(q, motivo)` SOLO se la lettura deve vedere tutto (l’oblio e il suo ' +
        'preventivo), con il motivo per esteso. Una lettura dimenticata non dà errore: fa riapparire ' +
        'la diagnosi di un bambino che qualcuno aveva eliminato.',
    ).toEqual([])
  })

  it('ogni `fascicoloAncheNelCestino` porta una ragione scritta per esteso', () => {
    const povere = TUTTE.filter((o) => o.marcatore === 'fascicoloAncheNelCestino')
      .map((o) => ({ o, testo: ragioneNuda(o.motivo ?? '') }))
      .filter(({ testo }) => testo.length < RAGIONE_MINIMA)
      .map(({ o, testo }) => `${o.file}:${o.linea} (${testo.length} caratteri)`)
    expect(
      povere,
      `Una deroga con meno di ${RAGIONE_MINIMA} caratteri di ragione è un’etichetta. Scrivi cosa ` +
        'succederebbe se questa lettura filtrasse le sole vive.',
    ).toEqual([])
  })

  it('funzioni edge — il riconoscitore DISTINGUE: nuda, filtrata, cestino, commento, stringa, insert', () => {
    const casi: Array<{ nome: string; src: string; atteso: Partial<OccorrenzaEdge> }> = [
      {
        nome: 'lettura nuda',
        src: 'const r = await supabase\n  .from("student_documents")\n  .select("id")\n  .lte("expiry_date", x);',
        atteso: { genere: 'lettura', filtrata: false },
      },
      {
        nome: 'lettura filtrata sulle vive',
        src: 'const r = await supabase\n  .from("student_documents")\n  .select(`id,\n  expiry_date`)\n  .is("eliminato_il", null)\n  .lte("expiry_date", x);',
        atteso: { genere: 'lettura', filtrata: true },
      },
      {
        nome: 'lettura del cestino',
        src: "const r = await supabase.from('student_documents').select('id').not('eliminato_il', 'is', null)",
        atteso: { genere: 'lettura', filtrata: true },
      },
      {
        nome: 'filtro solo in un commento',
        src: 'const r = await supabase\n  .from("student_documents")\n  // .is("eliminato_il", null)\n  .select("id");',
        atteso: { genere: 'lettura', filtrata: false },
      },
      {
        nome: 'filtro solo dentro la stringa del select',
        src: "const r = await supabase.from('student_documents').select(\".is('eliminato_il', null)\")",
        atteso: { genere: 'lettura', filtrata: false },
      },
      {
        nome: 'eliminato_il letto come colonna, non filtrato',
        src: "const r = await supabase.from('student_documents').select('id, eliminato_il').eq('id', x)",
        atteso: { genere: 'lettura', filtrata: false },
      },
      {
        nome: 'insert (esente)',
        src: 'const r = await supabase.from("student_documents").insert({ a: 1 }).select("id");',
        atteso: { genere: 'insert' },
      },
    ]
    const sbagliati: string[] = []
    for (const c of casi) {
      const occ = scandisciEdge('finto.ts', c.src)
      if (occ.length !== 1) { sbagliati.push(`${c.nome}: viste ${occ.length} occorrenze, attesa 1`); continue }
      for (const [k, v] of Object.entries(c.atteso)) {
        const reale = (occ[0] as unknown as Record<string, unknown>)[k]
        if (reale !== v) sbagliati.push(`${c.nome}: ${k} = ${String(reale)}, atteso ${String(v)}`)
      }
    }
    expect(
      sbagliati,
      'Il riconoscitore delle funzioni edge non distingue più i casi che deve distinguere: la prova ' +
        'qui sotto potrebbe essere verde perché non guarda niente.',
    ).toEqual([])
  })

  it('funzioni edge — il riconoscitore VEDE le letture attese (controllo positivo, conteggio esatto)', () => {
    const sbagliati: string[] = []
    for (const [file, atteso] of Object.entries(EDGE_ATTESE)) {
      expect(fs.existsSync(path.join(RADICE, file)), `sparito: ${file}`).toBe(true)
      const filtrate = TUTTE_EDGE.filter((o) => o.file === file && o.genere === 'lettura' && o.filtrata).length
      if (filtrate !== atteso) sbagliati.push(`${file}: attese ${atteso} letture filtrate, misurate ${filtrate}`)
    }
    const fuori = [
      ...new Set(
        TUTTE_EDGE.filter((o) => o.genere === 'lettura' && o.filtrata && !(o.file in EDGE_ATTESE)).map((o) => o.file),
      ),
    ]
    for (const f of fuori) sbagliati.push(`${f}: legge student_documents filtrando il cestino ma manca da EDGE_ATTESE`)
    expect(
      sbagliati,
      'Il controllo positivo delle funzioni edge non torna. Meno delle attese: il riconoscitore si è ' +
        'rotto o una lettura è sparita (scrivilo qui). Un file nuovo: aggiungilo a EDGE_ATTESE.',
    ).toEqual([])
  })

  it('funzioni edge — nessuna lettura di `student_documents` senza il filtro del cestino scritto a mano', () => {
    const nude = TUTTE_EDGE.filter((o) => o.genere === 'lettura' && !o.filtrata).map((o) => `${o.file}:${o.linea}`)
    expect(
      nude,
      'Questa funzione edge legge (o aggiorna) `student_documents` senza filtrare il cestino. È Deno e ' +
        'non può importare `fascicoloVivo`: scrivi il filtro nella catena, `.is("eliminato_il", null)` ' +
        'per le sole vive (quasi sempre) oppure `.not("eliminato_il", "is", null)` per il cestino. ' +
        'Senza, un documento sanitario eliminato torna «in scadenza» o nei promemoria.',
    ).toEqual([])
  })
})
