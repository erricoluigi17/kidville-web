import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import { mascheraSorgente, fineCatena, fineParentesi, fileSorgente, type SorgenteMascherato } from '../fixtures/sorgente'

/**
 * COVERAGE-LOCK · ciò che vede una famiglia passa dalle funzioni SQL (PR 4.4, Compito 4.4.7).
 *
 * La PR 4.4 ha portato in SQL la risposta a «che cosa vede questa famiglia»: un figlio che lascia la scuola o cambia classe
 * non lascia più foto, avvisi e conversazioni appesi. Il difetto che resta possibile è muto: una route nuova, o una route
 * riscritta, legge di nuovo i contenuti in un ramo genitore senza chiedere alle funzioni. La lista direbbe una cosa, la
 * route un'altra, e nessun test sarebbe rosso. Le prove delle route provano le route che esistono oggi: questo lock parla
 * di quelle che verranno.
 *
 * ─── La regola ───────────────────────────────────────────────────────────────
 * Per ogni HANDLER (non per file: in `chat/threads` il GET passa e il POST no) che legge una delle tabelle di `PASSAGGIO`
 * e ha un ramo genitore: fra ciò che raggiunge deve comparire il NOME della funzione SQL di quella tabella, oppure la coppia
 * handler-tabella sta in `ESENTI` con la sua ragione. Il nome è quello SQL e non quello dell'helper, così svuotare
 * `esitoThread` fa cadere le route che lo usano, e il passaggio per la funzione di un'altra tabella non vale.
 *
 * Che cos'è «raggiunge»: il corpo dell'handler, le funzioni e le costanti del file che nomina, e via via quelle importate
 * da `src/lib` e dai moduli non-route di `src/app/api`. `require-parent.ts` non si attraversa: il suo ramo `soloAttivo` lo
 * percorre solo chi lo chiede, quindi vale `{ soloAttivo: true }` scritto nella chiamata.
 *
 * Che cos'è una lettura: un `.from('tabella')` senza `.insert/.upsert/.update/.delete` nella catena, oppure una relazione
 * incorporata in un `.select` (`pagamenti ( … )`, `pagamenti!inner(…)`, `pagamenti:pagamento_id ( … )`), anche quando la
 * colonna sta in una costante del file.
 *
 * ─── Il ramo genitore: che cosa il criterio prende ───────────────────────────
 * Si guarda il testo dell'handler e delle funzioni del SUO file, senza commenti. La porta è di famiglia se c'è:
 *  · un gate o un predicato di famiglia: `requireParentOfStudent`, `agisceComeGenitore`, `eFamiglia`, `haRuolo(…'genitore')`,
 *    `role|ruolo === 'genitore'`;
 *  · una domanda sui figli: `genitoreHasFiglio`, `verificaLegameGenitore`, `getFigli*`, `figliAttiviDi`,
 *    `caricaFigliConTarget`;
 *  · una funzione della PR 4.4: `leggiVisibilita`, `esitoThread`, `esitoFiglioAttivo`, `paginaGalleriaFamiglia`;
 *  · una porta aperta a chiunque sia autenticato (`requireUser`, `requireSessioneAuth`, `resolveIdentity`, `loadAppUser`,
 *    `auth.getUser`): una famiglia ci entra anche senza nessun predicato, ed è il caso più severo di quello che chiede il
 *    piano, che parla di `requireUser` SEGUITO da un predicato.
 *
 * `requireStaff`, `requireDocente`, `requireKitchenRead`, `requireFunzione`, `requireCrm` senza nessuno di questi segnali è
 * «lavoro»; `CRON_SECRET`, `sealDangerous`, `eseguiSalute` è «macchina». Un handler che legge le tabelle con un gate che il
 * lock non conosce è «ignota» e fa cadere il lock: in dubbio si ferma, invece di scegliere da solo «non è una famiglia».
 *
 * ─── Che cosa si lascia sfuggire, dichiarato ─────────────────────────────────
 *  · PRESENZA, NON DOMINANZA. Il lock vede che il nome c'è, non che stia sul ramo della lettura né che l'esito venga usato.
 *    Un `leggiVisibilita` chiamato e ignorato è verde: lo provano `pagamenti-anno`, `chat-sola-lettura`,
 *    `gallery-visibilita-anno`, `avvisi-visibilita-anno`, `mensa-figlio-attivo`, `news-feed-anno`.
 *  · `figli_attivi` risponde a «chi è attivo», non a «questo contenuto è visibile»: per news e mensa il lock non prova che il
 *    filtro sia applicato alla riga.
 *  · Le letture che il testo non mostra: `.rpc()` che legge da sola, una vista, `.from(variabile)`. Quest'ultima oggi legge
 *    queste tabelle solo negli adattatori degli storici (`src/lib/storici/adattatori`), raggiunti da `admin/storici/*`, che non è
 *    una porta di famiglia. Le letture dal browser non passano di qui: le governano le policy (M44b).
 *  · Una porta di lavoro con un predicato di famiglia nuovo, che i segnali qui sopra non nominano, resta «lavoro».
 *  · Le chiamate che lo scanner non segue: `oggetto.metodo()`, `import * as`, `await import()`, una funzione ricevuta come
 *    parametro.
 *
 * ─── Il minimo ───────────────────────────────────────────────────────────────
 * Un lock che scansiona zero file è verde. È già successo tre volte in questo repo: per questo il test dichiara che cosa ha
 * guardato e ha un minimo per ciascun numero. Se scendono, qualcuno ha tolto le route dalla vista dello scanner.
 */

const RADICE = path.resolve(__dirname, '../..')
const API = path.join(RADICE, 'src', 'app', 'api')
const MIGRAZIONI = path.join(RADICE, 'supabase', 'migrations')
const LAYOUT_FAMIGLIA = path.join(RADICE, 'src', 'app', '(dashboard)', 'parent', 'layout.tsx')

/**
 * La funzione SQL che risponde per ogni tabella. Il piano ne nominava quattro: `avvisi` e `chat_messages` li ha coperti la
 * 4.4.6, `mensa_prenotazioni` entra perché il criterio la regge (i suoi tre handler di famiglia passano da un helper del file).
 */
const PASSAGGIO = {
  galleria_media_v2: ['galleria_pagina_genitore'],
  chat_threads: ['thread_visibili', 'thread_e_visibile'],
  chat_messages: ['thread_visibili', 'thread_e_visibile'],
  news_posts: ['figli_attivi'],
  avvisi: ['avvisi_visibili_genitore'],
  pagamenti: ['voci_visibili_genitore'],
  mensa_prenotazioni: ['figli_attivi'],
} as const
type Tabella = keyof typeof PASSAGGIO
const TABELLE = Object.keys(PASSAGGIO) as Tabella[]
const FUNZIONI_SQL = [...new Set<string>(Object.values(PASSAGGIO).flat())]

const METODI = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

const RAMO_GENITORE =
  /\b(?:requireParentOfStudent|agisceComeGenitore|eFamiglia|genitoreHasFiglio|verificaLegameGenitore|getFigli[A-Za-z]*|figliAttiviDi|caricaFigliConTarget|esitoThread|esitoFiglioAttivo|leggiVisibilita|paginaGalleriaFamiglia)\s*(?:<[^()]*>\s*)?\(|\b(?:role|ruolo)\s*[!=]==\s*['"]genitore['"]|\bhaRuolo\([^)]*['"]genitore['"]/
const GATE_APERTO = /\b(?:requireUser|requireSessioneAuth|resolveIdentity|loadAppUser)\s*\(|\.auth\.getUser\s*\(/
const GATE_LAVORO = /\b(?:requireStaff|requireDocente|requireKitchenRead|requireFunzione|requireCrm)\s*\(/
// `eseguiSalute`: i tre endpoint di salute sono pubblici per un monitor esterno, e ne escono solo nomi di controllo e numeri.
const GATE_MACCHINA = /\bCRON_SECRET\b|\bsealDangerous\s*\(|\beseguiSalute\s*\(/

type Porta = 'famiglia' | 'lavoro' | 'macchina' | 'ignota'
function portaDi(testo: string): Porta {
  if (RAMO_GENITORE.test(testo) || GATE_APERTO.test(testo)) return 'famiglia'
  if (GATE_LAVORO.test(testo)) return 'lavoro'
  if (GATE_MACCHINA.test(testo)) return 'macchina'
  return 'ignota'
}

// ─── Lo scanner ──────────────────────────────────────────────────────────────

interface Dichiarazione {
  da: number
  a: number
  riferimenti: string[]
}
interface Modulo {
  m: SorgenteMascherato
  dichiarazioni: Map<string, Dichiarazione>
  importati: Map<string, { spec: string; nome: string }>
}

const RE_IMPORT = /^(import|export)\s+(type\s+)?([^'"\n]*(?:\{[^}]*\})?[^'"\n]*?)\s*from\s*['"]([^'"]+)['"]/gm
const RE_INIZIO = /^[ \t]*((?:export|const|let|var|function|async|type|interface|class|import|enum|declare)\b)/gm
const RE_NOME = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/
// Non un `typeof`: `ReturnType<typeof paginaGalleriaFamiglia>` nomina l'helper in un tipo, e tolta la chiamata il lock restava
// verde. L'ha trovato la prima prova del rosso.
const RE_RIFERIMENTO = /(?<![\w$.])(?<!\btypeof\s+)[A-Za-z_$][\w$]*/g

/**
 * Tiene gli indici che stanno fuori da ogni parentesi. Sul testo `struttura`, dove nessuna parentesi vive in una stringa. Se la
 * maschera sbagliasse, le dichiarazioni si perderebbero: scende il numero di handler, e il minimo lo dice ad alta voce.
 */
function aProfonditaZero(struttura: string, indici: number[]): number[] {
  const out: number[] = []
  let livello = 0
  let k = 0
  for (const i of indici) {
    for (; k < i; k++) {
      const c = struttura[k]
      if (c === '(' || c === '{' || c === '[') livello++
      else if (c === ')' || c === '}' || c === ']') livello--
    }
    if (livello === 0) out.push(i)
  }
  return out
}

function creaModulo(src: string): Modulo {
  const m = mascheraSorgente(src)
  const importati = new Map<string, { spec: string; nome: string }>()
  for (const i of m.senzaCommenti.matchAll(RE_IMPORT)) {
    if (i[2]) continue
    const graffe = /\{([^}]*)\}/.exec(i[3])
    for (const voce of (graffe?.[1] ?? '').split(',')) {
      const v = voce.trim()
      if (!v || v.startsWith('type ')) continue
      const [originale, alias] = v.split(/\s+as\s+/)
      importati.set((alias ?? originale).trim(), { spec: i[4], nome: originale.trim() })
    }
    const predefinito = /^([A-Za-z_$][\w$]*)/.exec(i[3].trim())
    if (predefinito && i[1] === 'import') importati.set(predefinito[1], { spec: i[4], nome: 'default' })
  }
  const inizi = aProfonditaZero(m.struttura, [...m.struttura.matchAll(RE_INIZIO)].map((x) => x.index + x[0].length - x[1].length))
  const dichiarazioni = new Map<string, Dichiarazione>()
  inizi.forEach((da, k) => {
    const a = inizi[k + 1] ?? m.struttura.length
    const nome = RE_NOME.exec(m.struttura.slice(da, Math.min(a, da + 200)))?.[1]
    if (!nome) return
    const riferimenti = [...new Set(m.struttura.slice(da, a).match(RE_RIFERIMENTO) ?? [])].filter((r) => r !== nome)
    dichiarazioni.set(nome, { da, a, riferimenti })
  })
  return { m, dichiarazioni, importati }
}

const RE_FROM = /\.from\(\s*['"`]([a-z_0-9]+)['"`]\s*\)/g
const RE_SELECT = /\.select\s*\(/g

function incorporate(testo: string): Tabella[] {
  return TABELLE.filter((t) => new RegExp(`(?:^|[\\s,'"\`(:])${t}(?:!\\w+)?(?::\\w+(?:!\\w+)?)?\\s*\\(`).test(testo))
}

/** Le letture sulle tabelle in uno span del sorgente. */
function lettureIn(mod: Modulo, da: number, a: number): Tabella[] {
  const { m } = mod
  const out = new Set<Tabella>()
  for (const t of m.senzaCommenti.slice(da, a).matchAll(RE_FROM)) {
    const i = da + t.index
    if (!m.struttura.startsWith('.from', i)) continue
    const fine = fineCatena(m.struttura, i)
    if (/\.(?:insert|upsert|update|delete)\s*\(/.test(m.senzaCommenti.slice(i, fine))) continue
    if (TABELLE.includes(t[1] as Tabella)) out.add(t[1] as Tabella)
    for (const s of m.struttura.slice(i, fine).matchAll(RE_SELECT)) {
      const aperta = i + s.index + s[0].length - 1
      const argomento = m.senzaCommenti.slice(aperta + 1, fineParentesi(m.struttura, aperta) - 1)
      // `.select(SEL_VOCI)`: le colonne stanno in una costante del file.
      const costante = mod.dichiarazioni.get(/^\s*([A-Za-z_$][\w$]*)/.exec(argomento)?.[1] ?? '')
      for (const x of incorporate(costante ? m.senzaCommenti.slice(costante.da, costante.a) : argomento)) out.add(x)
    }
  }
  return [...out]
}

interface EsitoHandler {
  id: string
  porta: Porta
  dirette: Tabella[]
  viaLibreria: Tabella[]
  funzioni: Set<string>
}

const NON_SI_ATTRAVERSA = /^src\/lib\/(?:auth\/require-parent|logging\/|supabase\/|validation\/)/
const SI_SEGUE = /^src\/(?:lib|app\/api)\//
const SOLO_ATTIVO = /\brequireParentOfStudent\([^()]*?\bsoloAttivo\s*:\s*true/

function creaAnalisi(leggi: (rel: string) => string | null) {
  const moduli = new Map<string, Modulo | null>()
  const modulo = (rel: string): Modulo | null => {
    if (!moduli.has(rel)) {
      const src = leggi(rel)
      moduli.set(rel, src === null ? null : creaModulo(src))
    }
    return moduli.get(rel) ?? null
  }
  const risolvi = (da: string, spec: string): string | null => {
    const base = spec.startsWith('@/')
      ? path.posix.join('src', spec.slice(2))
      : spec.startsWith('.')
        ? path.posix.join(path.posix.dirname(da), spec)
        : null
    if (!base) return null
    for (const c of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (modulo(c)) return c
    return null
  }
  /** Il punto dove il nome è dichiarato: `require-staff.ts` ri-esporta i predicati. */
  const origine = (rel: string, nome: string, giri = 0): { rel: string; nome: string } | null => {
    const mod = modulo(rel)
    if (!mod) return null
    if (mod.dichiarazioni.has(nome)) return { rel, nome }
    const imp = mod.importati.get(nome)
    const t = imp && giri < 5 ? risolvi(rel, imp.spec) : null
    return t && imp ? origine(t, imp.nome, giri + 1) : null
  }

  function analizza(rel: string, nome: string): EsitoHandler {
    const dirette = new Set<Tabella>()
    const viaLibreria = new Set<Tabella>()
    const funzioni = new Set<string>()
    let proprio = ''
    const viste = new Set<string>()
    const coda: { rel: string; nome: string }[] = [{ rel, nome }]
    while (coda.length > 0) {
      const v = coda.pop()!
      const chiave = `${v.rel}#${v.nome}`
      if (viste.has(chiave)) continue
      viste.add(chiave)
      const mod = modulo(v.rel)
      const dich = mod?.dichiarazioni.get(v.nome)
      if (!mod || !dich) continue
      const testo = mod.m.senzaCommenti.slice(dich.da, dich.a)
      const nelFile = v.rel === rel
      if (nelFile) proprio += `\n${testo}`
      for (const t of lettureIn(mod, dich.da, dich.a)) (nelFile ? dirette : viaLibreria).add(t)
      for (const f of FUNZIONI_SQL) if (new RegExp(`['"\`]${f}['"\`]`).test(testo)) funzioni.add(f)
      if (SOLO_ATTIVO.test(testo)) funzioni.add('figli_attivi')
      for (const r of dich.riferimenti) {
        if (mod.dichiarazioni.has(r)) {
          coda.push({ rel: v.rel, nome: r })
          continue
        }
        const imp = mod.importati.get(r)
        const t = imp ? risolvi(v.rel, imp.spec) : null
        if (!imp || !t || !SI_SEGUE.test(t) || NON_SI_ATTRAVERSA.test(t)) continue
        const o = origine(t, imp.nome)
        if (o) coda.push(o)
      }
    }
    const percorso = rel.replace(/^src\/app\/api\//, '').replace(/\/route\.tsx?$/, '')
    return {
      id: `${percorso}:${nome}`,
      porta: portaDi(proprio),
      dirette: [...dirette],
      viaLibreria: [...viaLibreria].filter((t) => !dirette.has(t)),
      funzioni,
    }
  }
  const handlerDi = (rel: string): string[] =>
    [...(modulo(rel)?.dichiarazioni.keys() ?? [])].filter((n) => METODI.has(n))
  return { analizza, handlerDi }
}

/** Le tabelle che l'handler legge senza passare dalla funzione SQL che risponde per ciascuna. */
function scoperte(e: EsitoHandler): Tabella[] {
  return [...e.dirette, ...e.viaLibreria].filter((t) => !PASSAGGIO[t].some((f) => e.funzioni.has(f)))
}

/** `GuardiaSenzaFigli` importata dal suo modulo, e `children` che passa soltanto da lei. */
function guardiaMontata(sorgente: string): boolean {
  const { senzaCommenti } = mascheraSorgente(sorgente)
  return (
    /import\s*\{\s*GuardiaSenzaFigli\s*\}\s*from\s*['"]@\/components\/features\/parent\/GuardiaSenzaFigli['"]/.test(senzaCommenti) &&
    /<GuardiaSenzaFigli>\s*\{children\}\s*<\/GuardiaSenzaFigli>/.test(senzaCommenti) &&
    (senzaCommenti.match(/\{children\}/g) ?? []).length === 1
  )
}

// ─── Le eccezioni ────────────────────────────────────────────────────────────

/**
 * Handler con un ramo genitore che leggono una tabella senza la sua funzione. Una voce che non corrisponde più a niente, o che
 * nomina una tabella in più o in meno, fa fallire il lock: l'elenco non può invecchiare in silenzio. Qui stanno solo letture da cui
 * non esce un contenuto che la funzione nasconderebbe, o porte che alla famiglia sono chiuse. Non ci sta una route da correggere.
 *
 * `pagamenti/ticket`, `parent/submissions` e `forms/signed-pdf` non ci sono perché non leggono queste tabelle (`ticket_mensa`,
 * `forms_submissions`): sarebbero voci morte.
 */
const ESENTI: readonly { handler: string; tabelle: Tabella[]; motivo: string }[] = [
  {
    handler: 'chat/contacts:GET',
    tabelle: ['chat_threads'],
    motivo: "Legge i partecipanti delle proprie conversazioni per non riproporre un contatto già aperto: dai thread non esce niente, e i contatti vengono da `figliAttiviDi` (`rubricaDiFamiglia`).",
  },
  {
    handler: 'chat/messages/read:PATCH',
    tabelle: ['chat_messages', 'chat_threads'],
    motivo: 'Segna letti i messaggi dei thread di cui si è partecipanti: legge id e partecipanti e risponde con un conteggio, nessun contenuto esce.',
  },
  {
    handler: 'chat/threads/[id]/sospendi:POST',
    tabelle: ['chat_threads'],
    motivo: 'La sospensione è la tutela del partecipante contro un contenuto e resta possibile anche su un thread nascosto: legge i partecipanti, non i messaggi.',
  },
  {
    handler: 'chat/threads/consegnati:POST',
    tabelle: ['chat_messages', 'chat_threads'],
    motivo: 'Marca consegnati i messaggi dei propri thread: legge solo id e risponde con un esito, nessun contenuto esce.',
  },
  {
    handler: 'chat/threads:POST',
    tabelle: ['chat_threads'],
    motivo: "Cerca il doppione prima di creare e restituisce solo l'id: la porta è `abbinamentoConsentito`, che ha già guardato le frequenze con `figli_attivi`.",
  },
  {
    handler: 'pagamenti/famiglia:GET',
    tabelle: ['pagamenti'],
    motivo: 'È `requireStaff`, la cassa della segreteria: `getFigliDiGenitore` raccoglie i fratelli, e nascondere una voce vorrebbe dire non poterla incassare.',
  },
  {
    handler: 'pagamenti/fattura/esito:POST',
    tabelle: ['pagamenti'],
    motivo: 'Registra l’esito di un download: legge `id, scuola_id, alunno_id` della voce per il gate `assertFatturaInScope` e risponde 204.',
  },
  {
    handler: 'pagamenti/fattura/list:GET',
    tabelle: ['pagamenti'],
    motivo: 'Legge la voce per il gate `assertFatturaInScope` (legame col bambino): esce il registro delle fatture emesse, documenti fiscali della famiglia che non dipendono dalla visibilità della voce.',
  },
  {
    handler: 'pagamenti/fattura:GET',
    tabelle: ['pagamenti'],
    motivo: 'Legge la voce per il gate `assertFatturaInScope` (legame col bambino): esce il PDF di una fattura emessa, documento fiscale della famiglia che non dipende dalla visibilità della voce.',
  },
  {
    handler: 'pagamenti/riconciliazione/[id]/contesto:GET',
    tabelle: ['pagamenti'],
    motivo: 'È `requireStaff`, lo sportello dei bonifici: `getFigliDiGenitoreEsito` trova i figli di chi paga, e l’arretrato di un bambino che ha lasciato va incassato.',
  },
  {
    handler: 'pagamenti/sospensione-stato:GET',
    tabelle: ['pagamenti'],
    motivo: 'Il banner della propria sospensione: somma lo scaduto di tutti i figli legati, perché il dovuto aperto di un ritirato resta dovuto, e ne escono un booleano e un totale.',
  },
  {
    handler: 'segnalazioni:POST',
    tabelle: ['chat_messages', 'chat_threads', 'galleria_media_v2'],
    motivo: 'Verifica che chi segnala abbia un rapporto col contenuto: legge partecipanti e tag senza restituirli, e chi ha ricevuto un contenuto deve poterlo segnalare anche dopo.',
  },
  {
    handler: 'teacher/uscite:GET',
    tabelle: ['pagamenti'],
    motivo: 'Il ramo genitore è il rifiuto: `agisceComeGenitore` risponde 403 prima di ogni lettura, e il resto è il semaforo delle gite per chi insegna.',
  },
]

// ─── Le prove dello scanner, su sorgenti finti ───────────────────────────────

const ROUTE = 'src/app/api/prova/route.ts'
function suFinti(file: Record<string, string>) {
  return creaAnalisi((rel) => file[rel] ?? null)
}
function esito(sorgente: string, metodo = 'GET', altri: Record<string, string> = {}): EsitoHandler {
  return suFinti({ [ROUTE]: sorgente, ...altri }).analizza(ROUTE, metodo)
}
const handler = (corpo: string, metodo = 'GET') => `export const ${metodo} = withRoute('prova:${metodo}', async (request) => {\n${corpo}\n})\n`

describe('visibilita-genitore-coverage · lo scanner', () => {
  it('una lettura in un ramo genitore senza la funzione è scoperta', () => {
    const e = esito(handler("const a = await requireUser(request)\nconst r = await db.from('pagamenti').select('id')"))
    expect(e.porta).toBe('famiglia')
    expect(scoperte(e)).toEqual(['pagamenti'])
  })

  it('una riga interna a colonna 0 non spezza l’handler', () => {
    const e = esito(handler("const a = await requireUser(request)\nconst r = await db.from('pagamenti').select('id')"))
    expect(e.dirette).toEqual(['pagamenti'])
  })

  it('la funzione della tabella la copre, quella di un’altra tabella no', () => {
    const corpo = (f: string) => `await requireUser(request)\nawait leggiVisibilita(db, '${f}', u)\nawait db.from('pagamenti').select('id')`
    expect(scoperte(esito(handler(corpo('voci_visibili_genitore'))))).toEqual([])
    expect(scoperte(esito(handler(corpo('thread_visibili'))))).toEqual(['pagamenti'])
  })

  it('un nome in un commento non è un passaggio, e una lettura in un commento non è una lettura', () => {
    const nome = handler("await requireUser(request)\n// leggiVisibilita(db, 'voci_visibili_genitore', u)\nawait db.from('pagamenti').select('id')")
    expect(scoperte(esito(nome))).toEqual(['pagamenti'])
    const lettura = handler("await requireUser(request)\n// await db.from('pagamenti').select('id')")
    expect(esito(lettura).dirette).toEqual([])
  })

  it('una scrittura non è una lettura', () => {
    for (const verbo of ["insert({ a: 1 }).select('id')", 'upsert({ a: 1 })', "update({ a: 1 }).eq('id', i)", "delete().eq('id', i)"]) {
      expect(esito(handler(`await requireUser(request)\nawait db.from('pagamenti').${verbo}`)).dirette).toEqual([])
    }
  })

  it('una relazione incorporata è una lettura, in tutte le sue forme', () => {
    for (const colonne of ['id, pagamenti ( descrizione )', 'id, pagamenti!inner(scuola_id)', 'pagamenti:pagamento_id ( descrizione )', 'voce:pagamenti(id)']) {
      const e = esito(handler(`await requireUser(request)\nawait db.from('incassi').select('${colonne}')`))
      expect(e.dirette, colonne).toEqual(['pagamenti'])
    }
    const inCostante = `const SEL = 'id, pagamenti ( descrizione )'\n${handler("await requireUser(request)\nawait db.from('incassi').select(SEL)")}`
    expect(esito(inCostante).dirette).toEqual(['pagamenti'])
  })

  it('una colonna che somiglia a una tabella non è una relazione', () => {
    const e = esito(handler("await requireUser(request)\nawait db.from('incassi').select('id, pagamenti_id, pagamento_id')"))
    expect(e.dirette).toEqual([])
  })

  it('riconosce la porta: famiglia, lavoro, macchina, e non sceglie su un gate che non conosce', () => {
    expect(portaDi('await requireUser(request)')).toBe('famiglia')
    expect(portaDi('await requireParentOfStudent(request, id)')).toBe('famiglia')
    expect(portaDi('await requireStaff(request); if (agisceComeGenitore(user)) x()')).toBe('famiglia')
    expect(portaDi('await requireStaff(request); await getFigliDiGenitore(db, p)')).toBe('famiglia')
    expect(portaDi("if (user.role === 'genitore') x()")).toBe('famiglia')
    expect(portaDi("if (haRuolo(user, 'genitore')) x()")).toBe('famiglia')
    expect(portaDi('await leggiVisibilita<Riga>(db, x, u)')).toBe('famiglia')
    expect(portaDi('await requireStaff(request)')).toBe('lavoro')
    expect(portaDi('await requireDocente(request)')).toBe('lavoro')
    expect(portaDi('await requireCrm(request)')).toBe('lavoro')
    expect(portaDi('process.env.CRON_SECRET')).toBe('macchina')
    expect(portaDi('await requirePortaNuova(request)')).toBe('ignota')
  })

  it('una route requireStaff pura che legge non è un ramo genitore', () => {
    const e = esito(handler("await requireStaff(request)\nawait db.from('pagamenti').select('id')"))
    expect(e.porta).toBe('lavoro')
  })

  it('un predicato di famiglia in un commento non fa un ramo genitore', () => {
    const e = esito(handler("await requireStaff(request)\n// agisceComeGenitore(user)\nawait db.from('pagamenti').select('id')"))
    expect(e.porta).toBe('lavoro')
  })

  it('guarda l’handler, non il file: il GET che passa non copre il POST', () => {
    const sorgente =
      handler("await requireUser(request)\nawait leggiVisibilita(db, 'thread_visibili', u)\nawait db.from('chat_threads').select('id')") +
      handler("await requireUser(request)\nawait db.from('chat_threads').select('id')", 'POST')
    expect(scoperte(esito(sorgente, 'GET'))).toEqual([])
    expect(scoperte(esito(sorgente, 'POST'))).toEqual(['chat_threads'])
  })

  it('segue le funzioni del file che l’handler nomina, e solo quelle', () => {
    const conAiuto = (chiamata: string) =>
      `async function lista(db) {\n  await leggiVisibilita(db, 'voci_visibili_genitore', u)\n  return db.from('pagamenti').select('id')\n}\n` +
      `async function altra(db) {\n  return db.from('avvisi').select('id')\n}\n` +
      handler(`await requireUser(request)\n${chiamata}`)
    const e = esito(conAiuto('return lista(db)'))
    expect(e.dirette).toEqual(['pagamenti'])
    expect(scoperte(e)).toEqual([])
    expect(esito(conAiuto('return 1')).dirette).toEqual([])
  })

  it('una lettura spostata in una libreria si vede, e un passaggio dentro una libreria vale fino in fondo', () => {
    const route = `import { voci } from '@/lib/prova/voci'\n${handler('await requireUser(request)\nreturn voci(db)')}`
    const senza = esito(route, 'GET', { 'src/lib/prova/voci.ts': "export async function voci(db) {\n  return db.from('pagamenti').select('id')\n}\n" })
    expect(senza.viaLibreria).toEqual(['pagamenti'])
    expect(scoperte(senza)).toEqual(['pagamenti'])

    const conPassaggio = esito(route, 'GET', {
      'src/lib/prova/voci.ts':
        "import { chiedi } from './chiedi'\nexport async function voci(db) {\n  await chiedi(db)\n  return db.from('pagamenti').select('id')\n}\n",
      'src/lib/prova/chiedi.ts': "export function chiedi(db) {\n  return leggiVisibilita(db, 'voci_visibili_genitore', u)\n}\n",
    })
    expect(scoperte(conPassaggio)).toEqual([])
  })

  it('un helper nominato in un tipo non è un passaggio', () => {
    const route = `import { voci } from '@/lib/prova/voci'\n${handler("await requireUser(request)\nlet p: ReturnType<typeof voci> | null = null\nawait db.from('pagamenti').select('id')")}`
    const e = esito(route, 'GET', { 'src/lib/prova/voci.ts': "export function voci(db) {\n  return leggiVisibilita(db, 'voci_visibili_genitore', u)\n}\n" })
    expect(scoperte(e)).toEqual(['pagamenti'])
  })

  it('il nome in una libreria non vale se sta in un tipo, in un commento o in una funzione non chiamata', () => {
    const route = `import { voci } from '@/lib/prova/voci'\n${handler('await requireUser(request)\nreturn voci(db)')}`
    const libreria =
      "export type Nome = 'voci_visibili_genitore'\n" +
      "export function altra(db) {\n  return leggiVisibilita(db, 'voci_visibili_genitore', u)\n}\n" +
      "export async function voci(db) {\n  // leggiVisibilita(db, 'voci_visibili_genitore', u)\n  return db.from('pagamenti').select('id')\n}\n"
    expect(scoperte(esito(route, 'GET', { 'src/lib/prova/voci.ts': libreria }))).toEqual(['pagamenti'])
  })

  it('segue una ri-esportazione', () => {
    const route = `import { chiedi } from '@/lib/prova/ponte'\n${handler("await requireUser(request)\nawait chiedi(db)\nawait db.from('pagamenti').select('id')")}`
    const e = esito(route, 'GET', {
      'src/lib/prova/ponte.ts': "export { chiedi } from './vero'\n",
      'src/lib/prova/vero.ts': "export function chiedi(db) {\n  return leggiVisibilita(db, 'voci_visibili_genitore', u)\n}\n",
    })
    expect(scoperte(e)).toEqual([])
  })

  it('`requireParentOfStudent` vale per il figlio attivo solo se lo chiede, e il suo corpo non conta', () => {
    const corpo = (argomenti: string) => `await requireParentOfStudent(request, id${argomenti})\nawait db.from('mensa_prenotazioni').select('id')`
    const conGate = (argomenti: string) => `import { requireParentOfStudent } from '@/lib/auth/require-parent'\n${handler(corpo(argomenti))}`
    const gate = { 'src/lib/auth/require-parent.ts': "export async function requireParentOfStudent() {\n  return leggiVisibilita(db, 'figli_attivi', u)\n}\n" }
    expect(scoperte(esito(conGate(''), 'GET', gate))).toEqual(['mensa_prenotazioni'])
    expect(scoperte(esito(conGate(', { soloAttivo: true }'), 'GET', gate))).toEqual([])
  })

  it('un file senza handler non ha handler, e la funzione di un altro nome non è un handler', () => {
    const an = suFinti({ [ROUTE]: "export const dynamic = 'force-dynamic'\nexport function GETTA() {}\n" })
    expect(an.handlerDi(ROUTE)).toEqual([])
    expect(suFinti({}).handlerDi(ROUTE)).toEqual([])
  })

  it('la guardia: riconosce il montaggio, e non lo confonde con un commento o con un `children` nudo', () => {
    const imp = "import { GuardiaSenzaFigli } from '@/components/features/parent/GuardiaSenzaFigli';\n"
    expect(guardiaMontata(`${imp}<main><GuardiaSenzaFigli>{children}</GuardiaSenzaFigli></main>`)).toBe(true)
    expect(guardiaMontata(`${imp}<main>{children}</main>`)).toBe(false)
    expect(guardiaMontata(`${imp}<main>{/* <GuardiaSenzaFigli>{children}</GuardiaSenzaFigli> */}{children}</main>`)).toBe(false)
    expect(guardiaMontata('<main><GuardiaSenzaFigli>{children}</GuardiaSenzaFigli></main>')).toBe(false)
    expect(guardiaMontata(`${imp}<GuardiaSenzaFigli>{children}</GuardiaSenzaFigli>{children}`)).toBe(false)
  })
})

// ─── Il codice di src/ ───────────────────────────────────────────────────────

const dalDisco = (rel: string): string | null => {
  const p = path.join(RADICE, rel)
  return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null
}

interface Censimento {
  file: string[]
  handler: EsitoHandler[]
  perFile: Map<string, EsitoHandler[]>
}
let cache: Censimento | null = null
function censimento(): Censimento {
  if (cache) return cache
  const an = creaAnalisi(dalDisco)
  const file = fileSorgente(API)
    .filter((f) => /[/\\]route\.tsx?$/.test(f))
    .map((f) => path.relative(RADICE, f).split(path.sep).join('/'))
  const perFile = new Map<string, EsitoHandler[]>()
  for (const rel of file) perFile.set(rel, an.handlerDi(rel).map((h) => an.analizza(rel, h)))
  cache = { file, handler: [...perFile.values()].flat(), perFile }
  return cache
}
const leggeQualcosa = (e: EsitoHandler) => e.dirette.length + e.viaLibreria.length > 0
const diFamiglia = (e: EsitoHandler) => e.porta === 'famiglia' && leggeQualcosa(e)
const coppia = (handlerId: string, t: string) => `${handlerId} · ${t}`

/** I secondi di sotto bastano anche sotto il carico della suite intera, che fa girare i lock in parallelo. */
const TEMPO = 60_000

describe('visibilita-genitore-coverage · il codice di src/', () => {
  it('i MINIMI: lo scanner ha guardato abbastanza', () => {
    const { file, handler: tutti, perFile } = censimento()
    const routeCon = (f: (e: EsitoHandler) => boolean) => [...perFile.values()].filter((hs) => hs.some(f)).length
    const coppie = tutti.filter(diFamiglia).flatMap(scoperte)

    // Al 09/11/2026: 401 file di route e 611 handler. 94 route leggono una delle sette tabelle: 69 nel proprio file (66 sulle
    // sei del brief, più le 3 che leggono solo `mensa_prenotazioni`) e 33 via libreria, con 8 che fanno tutte e due. 23 hanno un
    // ramo genitore su quella lettura, per 27 handler: 14 passano dalle funzioni (in 11 route), 13 stanno in ESENTI con 17 coppie
    // handler-tabella. I minimi sono esatti di proposito: se scendono, scrivi accanto al numero PERCHÉ.
    expect(file.length, 'file di route letti').toBeGreaterThanOrEqual(401)
    expect(tutti.length, 'handler letti').toBeGreaterThanOrEqual(611)
    expect(routeCon(leggeQualcosa), 'route che leggono una tabella').toBeGreaterThanOrEqual(94)
    expect(routeCon((e) => e.dirette.length > 0), 'route che la leggono nel proprio file').toBeGreaterThanOrEqual(69)
    expect(routeCon(diFamiglia), 'route con un ramo genitore').toBeGreaterThanOrEqual(23)
    expect(tutti.filter(diFamiglia).length, 'handler con un ramo genitore').toBeGreaterThanOrEqual(27)
    const passano = (e: EsitoHandler) => diFamiglia(e) && scoperte(e).length === 0
    expect(tutti.filter(passano).length, 'handler che passano dalle funzioni').toBeGreaterThanOrEqual(14)
    expect(routeCon(passano), 'route che passano dalle funzioni').toBeGreaterThanOrEqual(11)

    // Le eccezioni non crescono senza che qualcuno riscriva questa riga: il tetto può solo scendere.
    expect(ESENTI.length, 'voci in ESENTI').toBeLessThanOrEqual(13)
    expect(coppie.length).toBe(ESENTI.reduce((n, e) => n + e.tabelle.length, 0))
  }, TEMPO)

  it('ogni file di route ha almeno un handler riconosciuto', () => {
    const { file, perFile } = censimento()
    expect(file.length).toBeGreaterThan(0)
    expect(file.filter((f) => (perFile.get(f) ?? []).length === 0)).toEqual([])
  }, TEMPO)

  it('nessuna route che legge queste tabelle ha una porta che il lock non conosce', () => {
    const ignote = censimento().handler.filter((e) => leggeQualcosa(e) && e.porta === 'ignota').map((e) => e.id)
    expect(ignote, 'nuovo gate: aggiungilo a RAMO_GENITORE, GATE_LAVORO o GATE_MACCHINA, dopo aver letto chi fa entrare').toEqual([])
  }, TEMPO)

  it('ogni lettura in un ramo genitore passa dalla sua funzione o sta in ESENTI', () => {
    const trovate = censimento().handler.filter(diFamiglia).flatMap((e) => scoperte(e).map((t) => coppia(e.id, t)))
    const dichiarate = ESENTI.flatMap((e) => e.tabelle.map((t) => coppia(e.handler, t)))
    expect(
      trovate.filter((c) => !dichiarate.includes(c)),
      'lettura in un ramo genitore senza la funzione SQL: passa da `@/lib/anno/visibilita-genitore`, o scrivi in ESENTI perché non esce un contenuto',
    ).toEqual([])
    expect(dichiarate.filter((c) => !trovate.includes(c)), 'voce di ESENTI che non corrisponde più a niente: toglila').toEqual([])
  }, TEMPO)

  it('ESENTI: una voce per handler, con una ragione di una riga', () => {
    expect(new Set(ESENTI.map((e) => e.handler)).size).toBe(ESENTI.length)
    for (const e of ESENTI) {
      expect(e.motivo.length, e.handler).toBeGreaterThan(40)
      expect(e.motivo, e.handler).not.toMatch(/\n/)
    }
  })

  it('le funzioni che il lock nomina esistono davvero nelle migrazioni', () => {
    // Il piano citava `figliAttivi` e `visibilitaGenitore`, che non esistono: un lock su un nome inventato non scatta mai.
    const sql = fs.readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql')).map((f) => fs.readFileSync(path.join(MIGRAZIONI, f), 'utf8')).join('\n')
    for (const f of FUNZIONI_SQL) expect(sql, f).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${f}\\s*\\(`))
  }, TEMPO)

  it('ogni ponte di `src/lib` arriva davvero alla sua funzione SQL', () => {
    const an = creaAnalisi(dalDisco)
    const ponti: [string, string, string][] = [
      ['src/lib/anno/visibilita-genitore.ts', 'figliAttiviDi', 'figli_attivi'],
      ['src/lib/anno/visibilita-genitore.ts', 'esitoFiglioAttivo', 'figli_attivi'],
      ['src/lib/anno/visibilita-genitore.ts', 'esitoThread', 'thread_visibili'],
      ['src/lib/gallery/pagina-famiglia.ts', 'paginaGalleriaFamiglia', 'galleria_pagina_genitore'],
      ['src/lib/anagrafiche/legami.ts', 'getFigliAttiviDiGenitore', 'figli_attivi'],
      ['src/lib/auth/require-parent.ts', 'requireParentOfStudent', 'figli_attivi'],
      ['src/lib/news/target.ts', 'caricaFigliConTarget', 'figli_attivi'],
    ]
    for (const [rel, nome, funzione] of ponti) {
      expect([...an.analizza(rel, nome).funzioni], `${nome} non arriva a ${funzione}`).toContain(funzione)
    }
    // `leggiVisibilita` riceve il nome come argomento: qui si guarda che lo porti davvero al database.
    const leggi = mascheraSorgente(fs.readFileSync(path.join(RADICE, 'src/lib/anno/visibilita-genitore.ts'), 'utf8')).senzaCommenti
    expect(leggi).toMatch(/\.rpc\(funzione,\s*\{\s*p_utente:\s*utente/)
  }, TEMPO)

  it('la galleria chiede al gate anche il figlio attivo, oltre alla pagina', () => {
    const galleria = mascheraSorgente(fs.readFileSync(path.join(API, 'gallery', 'route.ts'), 'utf8')).senzaCommenti
    expect(galleria).toMatch(SOLO_ATTIVO)
  })
})

describe('visibilita-genitore-coverage · la guardia delle otto pagine', () => {
  it('`GuardiaSenzaFigli` è montata nel layout dell’area genitore, e tutte le pagine passano da lei', () => {
    // La revisione del 4.4.6 l'ha trovata scoperta: togliendola le prove restano verdi, perché montano la guardia da sole, e le
    // otto pagine tornano a restare in caricamento per un genitore con zero figli attivi.
    expect(guardiaMontata(fs.readFileSync(LAYOUT_FAMIGLIA, 'utf8'))).toBe(true)
  })
})
