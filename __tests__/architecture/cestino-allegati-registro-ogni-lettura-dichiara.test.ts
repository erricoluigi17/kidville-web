import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineCatena, fineParentesi, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * LOCK — OGNI LETTURA DI `allegati_registro` DICHIARA COSA FA DEL CESTINO.
 *
 * ─── Il guasto che questo lock esiste per impedire ───────────────────────────
 *
 * Dal 2026-09-24 (spec «sei interventi», R2) `allegati_registro` ha il cestino:
 * «Elimina», «Sostituisci il file» e l'eliminazione della lezione non cancellano,
 * scrivono `eliminato_il`, e la purga toglie riga e file dopo
 * `GIORNI_CESTINO_REGISTRO` giorni. Tutte le letture passano dal **service-role**,
 * che la RLS non la vede: il filtro va scritto nella query, e basta UNA lettura
 * dimenticata perché un allegato eliminato — la foto di una lavagna, una verifica coi
 * nomi dei bambini — riappaia. Non con un errore: riappare, nel registro del docente,
 * nei compiti della classe o nelle lezioni che legge il genitore, con un link firmato.
 *
 * ─── PERCHÉ «DICHIARA» E NON «FILTRA SEMPRE» ─────────────────────────────────
 *
 * Stesso disegno dei gemelli `cestino-galleria-ogni-lettura-dichiara` e
 * `cestino-fascicolo-ogni-lettura-dichiara`: il cestino e la purga leggono DENTRO il
 * cestino, e la domanda della purga «un'altra riga nomina ancora questo file?» deve
 * vedere tutto. Quindi il lock pretende una **dichiarazione**, con uno dei nomi di
 * `src/lib/primaria/cestino-allegati-registro.ts`:
 *
 *   · `allegatiRegistroVivi(q)`                — i soli allegati vivi;
 *   · `allegatiRegistroNelCestino(q)`          — il cestino (elenco, ripristino, purga);
 *   · `allegatiRegistroAncheNelCestino(q, m)`  — l'identità, con la ragione per esteso.
 *
 * ─── LE LETTURE ANNIDATE (embed) ─────────────────────────────────────────────
 *
 * Tre route leggono gli allegati DENTRO la lezione: `registro_orario.select('…,
 * allegati_registro(…)')`. Lì il filtro si applica in codice (la ragione sta nel
 * modulo della regola), e il lock pretende due cose per ogni embed:
 *   1. la lista di colonne dell'embed nomina `eliminato_il` — senza, il filtro non
 *      avrebbe niente da guardare e lascerebbe passare tutto;
 *   2. il file IMPORTA `allegatiRegistroViviDalJoin` dal modulo e lo CHIAMA almeno
 *      tante volte quanti sono i suoi embed.
 * Un embed con alias (`x:allegati_registro(…)`) non è riconosciuto come dichiarato:
 * il lock lo segnala, perché lì anche il campo della riga si chiama diversamente.
 *
 * ─── L'UNICA ESENZIONE: L'INSERT ─────────────────────────────────────────────
 *
 * Una catena che comincia con `.insert(` fa NASCERE una riga, viva per costruzione.
 * `.upsert(` NON è esente: può aggiornare una riga esistente, anche nel cestino.
 *
 * ─── IL PERIMETRO, DETTO PRIMA CHE QUALCUNO LO DIA PER TOTALE ─────────────────
 *
 *  · Solo i letterali `from('allegati_registro')` e gli embed scritti in una stringa
 *    di `src/`. Due posti raggiungono la tabella per NOME in una variabile, e il lock
 *    non li vede: lo sblocco della Direzione (`primaria/sblocca`, `TABELLA_DI`), che
 *    filtra il cestino da sé con un ripiego dichiarato per il DB non migrato, e
 *    l'inventario delle tracce di un docente (`tracce-docente-voci.ts`), che conta le
 *    righe per `caricato_da` e deve contarle tutte.
 *  · Misurato in produzione il 2026-09-25 (sola lettura, `pg_views`/`pg_proc`):
 *    NESSUNA vista e NESSUNA funzione di `public` nomina `allegati_registro`.
 */

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')

const MARCATORI = ['allegatiRegistroVivi', 'allegatiRegistroNelCestino', 'allegatiRegistroAncheNelCestino'] as const
const FILTRO_JOIN = 'allegatiRegistroViviDalJoin'

/** `from('allegati_registro')`, con o senza spazi, apici singoli o doppi. */
const DA_TABELLA = /\bfrom\s*\(\s*['"]allegati_registro['"]\s*\)/g

/** Un embed: `allegati_registro(`, `allegati_registro!hint(`, `alias:allegati_registro(`. */
const EMBED = /(\w+\s*:\s*)?\ballegati_registro\s*(?:!\s*\w+\s*)?\(/g

/** Il modulo della regola. Non è sorvegliato da sé stesso. */
const MODULO = 'src/lib/primaria/cestino-allegati-registro.ts'

/** L'import NOMINATO dal modulo, in qualunque forma di specificatore. */
const IMPORT_MODULO = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*primaria\/cestino-allegati-registro(?:\.[jt]s)?['"]/g

/** Sessanta caratteri: la stessa soglia dei gemelli. Sotto, è un'etichetta. */
const RAGIONE_MINIMA = 60

function importatiDalModulo(senzaCommenti: string): Set<string> {
  const nomi = new Set<string>()
  IMPORT_MODULO.lastIndex = 0
  for (const m of senzaCommenti.matchAll(IMPORT_MODULO)) {
    for (const pezzo of m[1].split(',')) {
      const nudo = pezzo.replace(/\btype\b/, '').trim()
      // `a as b` NON è contato: `allegatiRegistroAncheNelCestino as allegatiRegistroVivi`
      // direbbe «filtro» su un'identità.
      if (nudo && /^[A-Za-z_$][\w$]*$/.test(nudo)) nomi.add(nudo)
    }
  }
  return nomi
}

// ─────────────────────────────────────────────────────────────────────────────
// Il riconoscitore (stessa meccanica del gemello del fascicolo)
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

/** Inizio dell'espressione ricevitore di `.from(` (`supabase`, `s`, `createAdminClient()`…). */
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
  /** `insert`: esente. `lettura`: select/update/delete/upsert. `embed`: dentro un'altra select. */
  genere: 'insert' | 'lettura' | 'embed'
  marcatore: string | null
  motivo: string | null
  omonimo: string | null
  /** Solo embed: la lista di colonne nomina `eliminato_il`. */
  colonnaCestino?: boolean
  /** Solo embed: scritto con un alias (`x:allegati_registro(…)`). */
  alias?: boolean
}

interface Scansione {
  occorrenze: Occorrenza[]
  /** Quante volte il file CHIAMA `allegatiRegistroViviDalJoin(` (0 se non lo importa dal modulo). */
  chiamateFiltroJoin: number
}

function scandisci(rel: string, src: string): Scansione {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  const dalModulo = importatiDalModulo(senzaCommenti)
  const out: Occorrenza[] = []

  // ── 1. `from('allegati_registro')` ─────────────────────────────────────────
  DA_TABELLA.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DA_TABELLA.exec(senzaCommenti)) !== null) {
    const iFrom = m.index
    // Dentro una stringa (es. un messaggio) non è una query.
    if (struttura[iFrom] === 'x') continue
    let p = iFrom - 1
    while (p >= 0 && /\s/.test(struttura[p])) p--
    if (struttura[p] !== '.') continue
    const fine = fineCatena(struttura, p)

    const aperturaFrom = struttura.indexOf('(', iFrom)
    const dopoFrom = fineParentesi(struttura, aperturaFrom)
    const genere = /^\s*\.\s*insert\s*\(/.test(struttura.slice(dopoFrom)) ? 'insert' : 'lettura'

    const ric = inizioRicevitore(struttura, p)
    const wrapper = wrapperAMonte(struttura, ric)

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
    if (marcatore === 'allegatiRegistroAncheNelCestino' && nelWrapper && nellaCatena === null) {
      const chiusura = fineParentesi(struttura, nelWrapper.apertura)
      motivo = risolviCostante(senzaCommenti, senzaCommenti.slice(fine, Math.max(fine, chiusura - 1)))
    }
    out.push({ file: rel, linea: riga(src, iFrom), genere, marcatore, motivo, omonimo })
  }

  // ── 2. Gli embed dentro una stringa di select ──────────────────────────────
  EMBED.lastIndex = 0
  while ((m = EMBED.exec(senzaCommenti)) !== null) {
    const inizioNome = m.index + (m[1]?.length ?? 0)
    // Solo DENTRO una stringa: fuori è un tipo, un campo (`r.allegati_registro`), codice.
    if (struttura[inizioNome] !== 'x') continue
    const apertura = m.index + m[0].length - 1
    // La lista delle colonne: fino alla `)` che chiude, contata sul testo (dentro la
    // stringa le parentesi dell'embed sono vere, e `struttura` le ha mascherate).
    let livello = 0
    let chiusa = apertura
    for (let k = apertura; k < senzaCommenti.length; k++) {
      if (senzaCommenti[k] === '(') livello++
      else if (senzaCommenti[k] === ')') { livello--; if (livello === 0) { chiusa = k; break } }
    }
    const colonne = senzaCommenti.slice(apertura + 1, chiusa)
    const annidate = colonne.replace(/\([^()]*\)/g, '')
    out.push({
      file: rel,
      linea: riga(src, inizioNome),
      genere: 'embed',
      marcatore: null,
      motivo: null,
      omonimo: null,
      colonnaCestino: /(^|[\s,])eliminato_il(\s*(,|$))/.test(annidate.trim()),
      alias: Boolean(m[1]),
    })
  }

  const chiamateFiltroJoin = dalModulo.has(FILTRO_JOIN)
    ? [...senzaCommenti.matchAll(new RegExp(`\\b${FILTRO_JOIN}\\s*\\(`, 'g'))].filter(
        (x) => struttura[x.index] !== 'x',
      ).length
    : 0

  return { occorrenze: out, chiamateFiltroJoin }
}

/**
 * Se il motivo è il NOME di una costante dello stesso file, la ragione è il suo
 * valore (concatenazione di letterali). Stessa regola del gemello del fascicolo.
 */
function risolviCostante(senzaCommenti: string, grezzo: string): string {
  const nome = grezzo.replace(/^\s*,\s*/, '').replace(/\s*,\s*$/, '').trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(nome)) return grezzo
  const lett = String.raw`(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\`[^\`$]*\`)`
  const re = new RegExp(String.raw`\bconst\s+${nome}\s*(?::\s*string\s*)?=\s*(${lett}(?:\s*\+\s*${lett})*)`)
  const r = re.exec(senzaCommenti)
  return r ? r[1] : grezzo
}

function ragioneNuda(grezzo: string): string {
  return grezzo
    .replace(/^\s*,\s*/, '')
    .replace(/['"`+\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Un embed è dichiarato se nomina la colonna, non ha alias e il file ha abbastanza filtri. */
function embedDichiarati(s: Scansione): { dichiarati: Occorrenza[]; scoperti: Occorrenza[] } {
  const embed = s.occorrenze.filter((o) => o.genere === 'embed')
  const bastano = s.chiamateFiltroJoin >= embed.length
  const dichiarati = embed.filter((o) => o.colonnaCestino && !o.alias && bastano)
  return { dichiarati, scoperti: embed.filter((o) => !dichiarati.includes(o)) }
}

const SCANSIONI = new Map<string, Scansione>(
  fileSorgente(SRC)
    .map((f) => path.relative(RADICE, f).split(path.sep).join('/'))
    .filter((f) => f !== MODULO)
    .map((f) => [f, scandisci(f, fs.readFileSync(path.join(RADICE, f), 'utf8'))] as const),
)
const TUTTE: Occorrenza[] = [...SCANSIONI.values()].flatMap((s) => s.occorrenze)

const letturaScoperta = (o: Occorrenza) => o.genere === 'lettura' && o.marcatore === null

/**
 * CONTROLLO POSITIVO — occorrenze dichiarate ATTESE, file per file, con zero scoperte.
 * Misura del 2026-09-25, compito R2. Il numero è ESATTO e non un tetto: un `>=`
 * renderebbe invisibile una lettura aggiunta di nascosto. Chi aggiunge una lettura
 * dichiarata in uno di questi file alza il SUO numero, e solo quello. Gli INSERT non
 * entrano nel conto; gli embed sì (`embed`).
 */
const COPERTE_ATTESE: Record<string, { letture: number; embed: number }> = {
  // GET elenco vivi · PATCH: UPDATE della rinomina · DELETE: UPDATE del cestino
  'src/app/api/primaria/allegati/route.ts': { letture: 3, embed: 0 },
  // la PRESA (vecchio nel cestino) · la compensazione (torna vivo)
  'src/app/api/primaria/allegati/sostituisci/route.ts': { letture: 2, embed: 0 },
  // GET cestino della classe · lettura dell'allegato da ripristinare · UPDATE del ripristino
  'src/app/api/primaria/allegati/cestino/route.ts': { letture: 3, embed: 0 },
  // la lettura dell'allegato VIVO da gestire (rinomina, eliminazione, sostituzione)
  'src/lib/primaria/allegati-registro.ts': { letture: 1, embed: 0 },
  // GET: l'embed della lezione · DELETE della lezione: il cestino degli allegati, il
  // conteggio sul DB non migrato (`AncheNelCestino`), l'annullamento del cestino
  'src/app/api/primaria/registro/route.ts': { letture: 3, embed: 1 },
  'src/app/api/primaria/compiti/route.ts': { letture: 0, embed: 1 },
  'src/app/api/parent/primaria/route.ts': { letture: 0, embed: 1 },
  // La PURGA (compito PU1): le scadute · chi reclama ancora i percorsi (`AncheNelCestino`) · il DELETE
  'src/app/api/gdpr/retention-cestino-registro/route.ts': { letture: 3, embed: 0 },
}

/**
 * SOGLIA DI SANITÀ — quante occorrenze (letture + insert + embed) il riconoscitore deve
 * almeno VEDERE in tutto `src/`. Misurate il 2026-09-25: 15 letture dichiarate, 3 embed
 * e 2 insert (caricamento, sostituzione) = 20. Se scende, prima si stabilisce se è il
 * riconoscitore a essersi rotto; solo dopo, e scrivendo QUI cosa è cambiato, si abbassa.
 */
const SOGLIA_VISTE = 20

describe('lock — il cestino degli allegati del registro: ogni lettura di allegati_registro dichiara', () => {
  it('il modulo della regola esiste, esporta i nomi e filtra DAVVERO', () => {
    const percorso = path.join(RADICE, MODULO)
    expect(fs.existsSync(percorso), `Manca ${MODULO}: è l'unico posto dove la regola esiste.`).toBe(true)
    const sorgente = fs.readFileSync(percorso, 'utf8')
    for (const nome of [...MARCATORI, FILTRO_JOIN]) {
      expect(
        new RegExp(`export function ${nome}\\b`).test(sorgente),
        `${MODULO} non esporta \`${nome}\`: è il vocabolario che questo lock riconosce.`,
      ).toBe(true)
    }
    expect(/return\s+q\.is\(\s*'eliminato_il'\s*,\s*null\s*\)/.test(sorgente)).toBe(true)
    expect(/return\s+q\.not\(\s*'eliminato_il'\s*,\s*'is'\s*,\s*null\s*\)/.test(sorgente)).toBe(true)
    expect(/\.eliminato_il\s*==\s*null/.test(sorgente)).toBe(true)
  })

  it('il riconoscitore DISTINGUE: nuda, dichiarata, omonimo, alias, insert, upsert, commento, embed', () => {
    const imp =
      "import { allegatiRegistroVivi, allegatiRegistroAncheNelCestino, allegatiRegistroViviDalJoin } from '@/lib/primaria/cestino-allegati-registro'\n"
    const casi: Array<{ nome: string; src: string; atteso: Partial<Occorrenza> }> = [
      {
        nome: 'lettura nuda',
        src: imp + "const { data } = await supabase.from('allegati_registro').select('id').eq('registro_id', a)",
        atteso: { genere: 'lettura', marcatore: null, omonimo: null },
      },
      {
        nome: 'lettura avvolta dal marcatore importato',
        src: imp + "const { data } = await allegatiRegistroVivi(\n  supabase\n    .from('allegati_registro')\n    .select('id')\n    .eq('id', x),\n).maybeSingle()",
        atteso: { genere: 'lettura', marcatore: 'allegatiRegistroVivi' },
      },
      {
        nome: 'omonimo locale',
        src: "function allegatiRegistroVivi<T>(q: T): T { return q }\nconst r = await allegatiRegistroVivi(supabase.from('allegati_registro').select('id'))",
        atteso: { marcatore: null, omonimo: 'allegatiRegistroVivi' },
      },
      {
        nome: 'alias che trasforma l’identità in «filtro»',
        src: "import { allegatiRegistroAncheNelCestino as allegatiRegistroVivi } from '@/lib/primaria/cestino-allegati-registro'\nconst r = await allegatiRegistroVivi(supabase.from('allegati_registro').select('id'))",
        atteso: { marcatore: null, omonimo: 'allegatiRegistroVivi' },
      },
      {
        nome: 'marcatore del FASCICOLO su questa tabella',
        src: "import { fascicoloVivo } from '@/lib/primaria/cestino-fascicolo'\nconst r = await fascicoloVivo(supabase.from('allegati_registro').select('id'))",
        atteso: { genere: 'lettura', marcatore: null },
      },
      {
        nome: 'insert (esente)',
        src: "const r = await supabase\n  .from('allegati_registro')\n  .insert({ a: 1 })\n  .select('id')\n  .single()",
        atteso: { genere: 'insert', marcatore: null },
      },
      {
        nome: 'upsert (NON esente)',
        src: "const r = await supabase.from('allegati_registro').upsert({ a: 1 })",
        atteso: { genere: 'lettura', marcatore: null },
      },
      {
        nome: 'embed che nomina la colonna del cestino',
        src: imp + "const r = await supabase.from('registro_orario').select(`id, allegati_registro(id, file_url, eliminato_il)`)",
        atteso: { genere: 'embed', colonnaCestino: true, alias: false },
      },
      {
        nome: 'embed SENZA la colonna del cestino',
        src: "const r = await supabase.from('registro_orario').select('id, allegati_registro(id, file_url)')",
        atteso: { genere: 'embed', colonnaCestino: false },
      },
      {
        nome: 'embed con alias',
        src: "const r = await supabase.from('registro_orario').select('id, allegati:allegati_registro(id, eliminato_il)')",
        atteso: { genere: 'embed', alias: true },
      },
    ]
    const sbagliati: string[] = []
    for (const c of casi) {
      const occ = scandisci('finto.ts', c.src).occorrenze
      if (occ.length !== 1) { sbagliati.push(`${c.nome}: viste ${occ.length} occorrenze, attesa 1`); continue }
      for (const [k, v] of Object.entries(c.atteso)) {
        const reale = (occ[0] as unknown as Record<string, unknown>)[k]
        if (reale !== v) sbagliati.push(`${c.nome}: ${k} = ${String(reale)}, atteso ${String(v)}`)
      }
    }

    // Un embed con la colonna ma senza NESSUNA chiamata al filtro resta scoperto…
    const senzaFiltro = scandisci(
      'finto.ts',
      imp + "const r = await supabase.from('registro_orario').select('id, allegati_registro(id, eliminato_il)')",
    )
    if (embedDichiarati(senzaFiltro).scoperti.length !== 1) sbagliati.push('embed senza filtro: non segnalato')
    // …e diventa dichiarato quando il file lo chiama.
    const conFiltro = scandisci(
      'finto.ts',
      imp +
        "const r = await supabase.from('registro_orario').select('id, allegati_registro(id, eliminato_il)')\n" +
        'const vivi = allegatiRegistroViviDalJoin(r.data?.[0]?.allegati_registro)',
    )
    if (embedDichiarati(conFiltro).dichiarati.length !== 1) sbagliati.push('embed con filtro: non riconosciuto')
    // Un filtro omonimo (non importato) non conta.
    const filtroOmonimo = scandisci(
      'finto.ts',
      "const allegatiRegistroViviDalJoin = (x: unknown[]) => x\nconst r = await supabase.from('registro_orario').select('id, allegati_registro(id, eliminato_il)')\nallegatiRegistroViviDalJoin([])",
    )
    if (embedDichiarati(filtroOmonimo).scoperti.length !== 1) sbagliati.push('filtro omonimo: contato come vero')
    // Il nome della tabella fuori da una stringa (un tipo, un campo) non è un embed.
    const campo = scandisci('finto.ts', 'type R = { allegati_registro?: A[] }\nconst n = r.allegati_registro(1)')
    if (campo.occorrenze.length !== 0) sbagliati.push(`campo/tipo: viste ${campo.occorrenze.length} occorrenze, attese 0`)
    // Una query dentro un COMMENTO non è una query.
    const commentata = scandisci(
      'finto.ts',
      "// supabase.from('allegati_registro').select('id')\n/* select('allegati_registro(id)') */",
    )
    if (commentata.occorrenze.length !== 0) sbagliati.push(`commento: viste ${commentata.occorrenze.length} occorrenze, attese 0`)
    // La ragione in una COSTANTE si legge per valore.
    const perCostante = scandisci(
      'finto.ts',
      imp +
        "const MOTIVO = 'una ragione lunga abbastanza da essere contestata fra sei mesi, ' +\n  'scritta una volta sola sopra la query'\n" +
        "const r = await allegatiRegistroAncheNelCestino(\n  supabase.from('allegati_registro').select('id'),\n  MOTIVO,\n)",
    )
    if (ragioneNuda(perCostante.occorrenze[0]?.motivo ?? '').length < RAGIONE_MINIMA) {
      sbagliati.push(`costante: letto «${perCostante.occorrenze[0]?.motivo ?? ''}», atteso il suo valore`)
    }
    const conRagione = scandisci(
      'finto.ts',
      imp + "const r = await allegatiRegistroAncheNelCestino(supabase.from('allegati_registro').select('id'), 'corta')",
    )
    if (ragioneNuda(conRagione.occorrenze[0]?.motivo ?? '') !== 'corta') {
      sbagliati.push(`motivo letto: «${conRagione.occorrenze[0]?.motivo ?? ''}», atteso «corta»`)
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
      const s = SCANSIONI.get(file)
      const occ = (s?.occorrenze ?? []).filter((o) => o.genere === 'lettura')
      const coperte = occ.filter((o) => o.marcatore !== null).length
      const scoperte = occ.length - coperte
      const emb = s ? embedDichiarati(s) : { dichiarati: [], scoperti: [] }
      if (coperte !== atteso.letture || scoperte !== 0 || emb.dichiarati.length !== atteso.embed || emb.scoperti.length !== 0) {
        sbagliati.push(
          `${file}: attese ${atteso.letture} letture e ${atteso.embed} embed dichiarati, 0 scoperti; ` +
            `misurate ${coperte}/${scoperte} letture e ${emb.dichiarati.length}/${emb.scoperti.length} embed`,
        )
      }
    }
    expect(
      sbagliati,
      'Il controllo positivo non torna. COPERTE meno delle attese: il riconoscitore si è rotto, o ' +
        'una lettura è sparita (scrivilo qui). Di più: hai aggiunto una lettura dichiarata, alza il ' +
        'numero di QUEL file. SCOPERTE: è il difetto che questo lock esiste per prendere.',
    ).toEqual([])
  })

  it('ogni file con letture o embed dichiarati sta in COPERTE_ATTESE (il conteggio non ha buchi)', () => {
    const fuori = [...SCANSIONI.entries()]
      .filter(([f, s]) => !(f in COPERTE_ATTESE) && (s.occorrenze.some((o) => o.genere !== 'insert')))
      .map(([f]) => f)
    expect(
      fuori,
      'Questi file leggono `allegati_registro` ma mancano da COPERTE_ATTESE: aggiungili col loro ' +
        'numero e un commento su cosa leggono (e alza SOGLIA_VISTE).',
    ).toEqual([])
  })

  it('il riconoscitore vede almeno la soglia di sanità in tutto src/', () => {
    expect(
      TUTTE.length,
      `Viste ${TUTTE.length} occorrenze di allegati_registro, soglia ${SOGLIA_VISTE}. La prima ipotesi ` +
        'è una cecità del riconoscitore (regex, maschera, `fineCatena`), non «ne hanno tolte».',
    ).toBeGreaterThanOrEqual(SOGLIA_VISTE)
  })

  it('un marcatore vale solo se viene DAL MODULO (niente omonimi, niente alias)', () => {
    const omonimi = TUTTE.filter((o) => o.omonimo !== null).map(
      (o) => `${o.file}:${o.linea} — \`${o.omonimo}\` non è importato (senza alias) da ${MODULO}`,
    )
    expect(omonimi).toEqual([])
  })

  it('nessuna lettura di `allegati_registro` resta senza dichiarazione', () => {
    const nude = TUTTE.filter(letturaScoperta).map((o) => `${o.file}:${o.linea}`)
    expect(
      nude,
      'Questa query legge (o aggiorna) `allegati_registro` senza dire niente del cestino. Scegli il ' +
        'verso e scrivilo: `allegatiRegistroVivi(q)` se un allegato eliminato non deve comparire — è ' +
        'quasi sempre questo; `allegatiRegistroNelCestino(q)` per il cestino, il ripristino e la purga; ' +
        '`allegatiRegistroAncheNelCestino(q, motivo)` SOLO se la lettura deve vedere tutto, con il ' +
        'motivo per esteso. Una lettura dimenticata non dà errore: fa riapparire un allegato eliminato.',
    ).toEqual([])
  })

  it('nessun embed `allegati_registro(…)` resta senza filtro del cestino', () => {
    const scoperti = [...SCANSIONI.values()].flatMap((s) =>
      embedDichiarati(s).scoperti.map(
        (o) =>
          `${o.file}:${o.linea}` +
          (o.alias ? ' (alias non ammesso)' : !o.colonnaCestino ? ' (manca `eliminato_il` fra le colonne)' : ' (manca la chiamata a `allegatiRegistroViviDalJoin`)'),
      ),
    )
    expect(
      scoperti,
      'Un embed di `allegati_registro` porta alla lezione ANCHE gli allegati nel cestino. Aggiungi ' +
        '`eliminato_il` alle sue colonne e passa le righe annidate da `allegatiRegistroViviDalJoin` ' +
        '(importato da `@/lib/primaria/cestino-allegati-registro`) prima di usarle.',
    ).toEqual([])
  })

  it('ogni `allegatiRegistroAncheNelCestino` porta una ragione scritta per esteso', () => {
    const povere = TUTTE.filter((o) => o.marcatore === 'allegatiRegistroAncheNelCestino')
      .map((o) => ({ o, testo: ragioneNuda(o.motivo ?? '') }))
      .filter(({ testo }) => testo.length < RAGIONE_MINIMA)
      .map(({ o, testo }) => `${o.file}:${o.linea} (${testo.length} caratteri)`)
    expect(
      povere,
      `Una deroga con meno di ${RAGIONE_MINIMA} caratteri di ragione è un’etichetta. Scrivi cosa ` +
        'succederebbe se questa lettura filtrasse i soli vivi.',
    ).toEqual([])
  })
})
