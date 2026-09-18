import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { mascheraSorgente, riga } from '../fixtures/sorgente'

/**
 * LOCK — nel `matcher` della porta stanno SOLO asset statici, mai un prefisso di rotta.
 *
 * ─── Che cos'è il `matcher`, detto per quello che è ──────────────────────────
 *
 * `src/middleware.ts` finisce con un `export const config` che dichiara su quali
 * percorsi il middleware gira. La forma è una negazione:
 *
 *     '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|…)$).*)'
 *
 * Tutto ciò che sta dentro quel `(?!…)` **non passa dal middleware**. Non «passa
 * senza sessione»: non ci passa affatto. Nessun `x-request-id`, nessun
 * `shouldRedirect`, nessun gate che lo veda. È a tutti gli effetti un SECONDO
 * meccanismo di esenzione dall'autenticazione, accanto a `PUBLIC_PREFIXES` — con
 * la differenza che `PUBLIC_PREFIXES` è un elenco dichiarato, commentato riga per
 * riga e sorvegliato (`prefissi-pubblici.test.ts`), mentre questo è un pezzo di
 * espressione regolare dentro una stringa.
 *
 * ─── PERCHÉ ESISTE QUESTO FILE, con la misura ────────────────────────────────
 *
 * Misurato il 2026-09-16. Un pacchetto installato quel giorno
 * (`workflow@5.0.0-beta.53`, poi rimosso) aveva infilato `\.well-known/workflow/`
 * dentro quella negazione. Due endpoint erano diventati pubblici — non «pubblici
 * per errore di un gate»: pubblici perché il middleware non li vedeva partire.
 *
 * Le reti di sicurezza che il repo aveva già addosso erano TRE, e nessuna delle
 * tre se n'è accorta:
 *
 *  · `prefissi-pubblici.test.ts` guarda `PUBLIC_PREFIXES`, cioè l'elenco
 *    DICHIARATO. Il matcher non è in quell'elenco e non lo è mai stato.
 *  · `gate-coverage.test.ts` e `logging-coverage.test.ts` raccolgono i soli file
 *    che si chiamano `route.ts` (`gate-coverage.test.ts:318`,
 *    `logging-coverage.test.ts:46`). Gli endpoint erano `route.js`: invisibili a
 *    entrambi, non per una svista ma per costruzione.
 *
 * E la prova che il buco fosse di SORVEGLIANZA e non di codice sta in una misura,
 * fatta il 2026-09-16 e da rifare invece che da credere. La parola `matcher`
 * compare in dieci file di `__tests__/`, ma in sette è tutt'altra cosa — i matcher
 * di testing-library, quello della riconciliazione, il matcher CSS di jsdom. Del
 * matcher DELLA PORTA si parla in tre punti soltanto, e tutti e tre sono prosa:
 * `prefissi-pubblici:119`, `header-sicurezza:100`, `middleware-tetto:17`. Nessun
 * test lo LEGGEVA. Tre reti di sicurezza, zero occhi.
 *
 * (La prima stesura di questa testata diceva «compariva soltanto dentro tre
 * commenti», e non era vero: chi l'ha scritta aveva ristretto la `grep` a tre file
 * e aveva riportato il risultato come se fosse il totale. Resta scritto perché è
 * lo stesso errore di misura che questo lock esiste per rendere impossibile: una
 * conta fatta su un sottoinsieme e raccontata come completa.)
 *
 * ─── LA REGOLA ───────────────────────────────────────────────────────────────
 *
 * Nella negazione stanno solo DUE famiglie:
 *   1. i percorsi interni di Next e la favicon — `_next/static`, `_next/image`,
 *      `favicon.ico`, elencati qui sotto per nome;
 *   2. un gruppo di ESTENSIONI, nella forma `.*\.(?:…)$`, con l'àncora di fine e
 *      con estensioni prese da un elenco chiuso.
 *
 * Qualunque altra cosa è un prefisso di rotta, e il posto di un prefisso di rotta
 * è `PUBLIC_PREFIXES` (`src/lib/auth/middleware-rules.ts`): lì una riga nuova
 * chiede una motivazione scritta e trova un lock che la controlla. Qui non
 * chiede niente e non trova nessuno.
 *
 * ─── COSA NON GARANTISCE ─────────────────────────────────────────────────────
 *
 * Non garantisce che le esenzioni di oggi siano giuste: garantisce che non ne
 * compaia una NUOVA senza che qualcuno la scriva due volte — una nel matcher e
 * una qui dentro. L'elenco chiuso delle estensioni serve esattamente a questo: è
 * la fotografia di ciò che c'era il 2026-09-16, non un giudizio su ciò che è
 * «sicuro». Allargarlo è un gesto legittimo; farlo di sfuggita no.
 */

const RADICE = process.cwd()

/**
 * I NOMI CHE LA PORTA PUÒ AVERE, e perché sono quattro.
 *
 * In Next 16 `middleware.js` è **deprecato e rinominato `proxy.js`**
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md`,
 * che rimanda a `proxy.md` e offre pure il codemod `middleware-to-proxy`). Un
 * lock legato al nome `middleware.ts` smetterebbe di guardare qualunque cosa il
 * giorno in cui qualcuno esegue quel codemod — e resterebbe VERDE, che è il modo
 * peggiore di spegnersi. Si cerca il file, non il nome.
 */
const CANDIDATI = ['src/middleware.ts', 'src/proxy.ts', 'middleware.ts', 'proxy.ts']

/** I file-porta presenti. Vuoto = il lock non sta leggendo niente, e lo dice. */
function portePresenti(radice: string = RADICE): string[] {
  const trovati = CANDIDATI.map((c) => path.join(radice, c)).filter((f) => fs.existsSync(f))
  if (trovati.length === 0) {
    throw new Error(
      `nessun file-porta trovato sotto ${radice}: cercati ${CANDIDATI.join(', ')}. ` +
        'Se il file è stato rinominato (Next 16: `middleware` → `proxy`), il nome nuovo va ' +
        'aggiunto a CANDIDATI: finché non c’è, questo lock non sorveglia più niente.',
    )
  }
  return trovati
}

// ──────────────────────────────────────────────────────────────────────────────
// Lettura del `matcher` dal SORGENTE
// ──────────────────────────────────────────────────────────────────────────────

/** Una voce del `matcher`: la stringa `source` e, se è in forma d'oggetto, le sue chiavi. */
interface Voce {
  source: string
  /** Le chiavi dichiarate quando la voce è un oggetto (`source`, `has`, `missing`, …). */
  chiavi: string[]
  oggetto: boolean
  /** Riga del sorgente, per il messaggio d'errore. */
  riga: number
}

/** Indice DOPO la parentesi/graffa/quadra che chiude quella aperta in `apertura`. */
function fineBlocco(strut: string, apertura: number, apre: string, chiude: string): number {
  let livello = 0
  for (let k = apertura; k < strut.length; k++) {
    if (strut[k] === apre) livello++
    else if (strut[k] === chiude) {
      livello--
      if (livello === 0) return k + 1
    }
  }
  return strut.length
}

/** `\\` → `\`, `\'` → `'`. È ciò che distingue il TESTO del sorgente dal VALORE della stringa. */
function disescape(c: string): string {
  if (c === 'n') return '\n'
  if (c === 't') return '\t'
  if (c === 'r') return '\r'
  return c
}

/** La stringa che comincia in `i` (apice, doppio apice o backtick), col suo VALORE. */
function leggiStringa(src: string, i: number): { valore: string; fine: number } | null {
  const q = src[i]
  if (q !== "'" && q !== '"' && q !== '`') return null
  let valore = ''
  let k = i + 1
  while (k < src.length && src[k] !== q) {
    if (src[k] === '\\') {
      valore += disescape(src[k + 1])
      k += 2
      continue
    }
    valore += src[k]
    k++
  }
  return { valore, fine: k + 1 }
}

/**
 * Indice del VALORE della chiave `nome` al primo livello dell'oggetto aperto in
 * `apertura`. Si lavora sulla `struttura` (commenti spenti, contenuto delle
 * stringhe sostituito): né una graffa dentro una stringa né un `matcher:` dentro
 * un commento possono spostare il conteggio.
 */
function valoreChiave(strut: string, apertura: number, fine: number, nome: string): number {
  let livello = 0
  for (let k = apertura; k < fine; k++) {
    const c = strut[k]
    if (c === '{' || c === '[' || c === '(') {
      livello++
      continue
    }
    if (c === '}' || c === ']' || c === ')') {
      livello--
      continue
    }
    if (livello !== 1) continue
    // Mai in mezzo a un identificatore: `xmatcher:` non è `matcher:`.
    if (k > apertura && /[A-Za-z0-9_$]/.test(strut[k - 1])) continue
    const m = new RegExp(`^['"]?${nome}['"]?\\s*:`).exec(strut.slice(k, k + nome.length + 4))
    if (m) {
      let j = k + m[0].length
      while (j < fine && /\s/.test(strut[j])) j++
      return j
    }
  }
  return -1
}

/** Le chiavi dichiarate al primo livello dell'oggetto `[da, a)`. */
function chiaviOggetto(strut: string, da: number, a: number): string[] {
  const out: string[] = []
  let livello = 0
  for (let k = da; k < a; k++) {
    const c = strut[k]
    if (c === '{' || c === '[' || c === '(') {
      livello++
      continue
    }
    if (c === '}' || c === ']' || c === ')') {
      livello--
      continue
    }
    if (livello !== 1) continue
    if (k > da && /[A-Za-z0-9_$]/.test(strut[k - 1])) continue
    const m = /^['"]?([A-Za-z_$][\w$]*)['"]?\s*:/.exec(strut.slice(k, k + 48))
    if (m) {
      out.push(m[1])
      k += m[0].length - 1
    }
  }
  return out
}

/**
 * Le voci del `matcher` di un sorgente. `null` significa «`config` non dichiara
 * `matcher`», che in Next vuol dire che il middleware gira su TUTTO: copertura
 * massima, nessuna esenzione, e per questo lock va bene.
 *
 * Lancia — rumorosamente — quando non riesce a leggere: un lock che non trova
 * ciò che deve sorvegliare deve CADERE, non passare.
 */
function vociMatcher(src: string, dove: string): Voce[] | null {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  const m = /export\s+const\s+config\b[^=]*=\s*\{/.exec(struttura)
  if (!m) {
    throw new Error(
      `${dove}: nessun \`export const config = { … }\`. Se la configurazione è stata spostata ` +
        'o scritta in un’altra forma, questo lock va adeguato: così com’è non legge più niente.',
    )
  }
  const apertura = m.index + m[0].length - 1
  const fine = fineBlocco(struttura, apertura, '{', '}')
  const valore = valoreChiave(struttura, apertura, fine, 'matcher')
  if (valore < 0) return null

  const voce = (indice: number): Voce => {
    const s = leggiStringa(senzaCommenti, indice)
    if (!s) {
      throw new Error(
        `${dove}:${riga(src, indice)}: una voce di \`matcher\` non è una stringa costante. ` +
          'Next analizza il matcher a build-time e IGNORA i valori dinamici (doc `proxy.md`, ' +
          '«The matcher values need to be constants»): una variabile qui non è una ' +
          'configurazione, è un matcher che non esiste — e questo lock diventerebbe cieco.',
      )
    }
    return { source: s.valore, chiavi: ['source'], oggetto: false, riga: riga(src, indice) }
  }

  if (struttura[valore] !== '[') return [voce(valore)]

  const chiusa = fineBlocco(struttura, valore, '[', ']')
  const out: Voce[] = []
  let k = valore + 1
  while (k < chiusa - 1) {
    const c = struttura[k]
    if (/[\s,]/.test(c)) {
      k++
      continue
    }
    if (c === '{') {
      const f = fineBlocco(struttura, k, '{', '}')
      const dentro = valoreChiave(struttura, k, f, 'source')
      const s = dentro >= 0 ? leggiStringa(senzaCommenti, dentro) : null
      out.push({
        source: s ? s.valore : '',
        chiavi: chiaviOggetto(struttura, k, f),
        oggetto: true,
        riga: riga(src, k),
      })
      k = f
      continue
    }
    const v = voce(k)
    out.push(v)
    k = leggiStringa(senzaCommenti, k)!.fine
  }
  return out
}

// ──────────────────────────────────────────────────────────────────────────────
// Analisi di una voce
// ──────────────────────────────────────────────────────────────────────────────

/**
 * I percorsi interni ammessi nella negazione, per nome. Non sono rotte: sono le
 * strade che Next serve da sé (`_next/static`, `_next/image`) e la favicon, che
 * il browser chiede fuori da qualunque sessione.
 */
const INTERNI_NEXT = new Set(['_next/static', '_next/image', 'favicon.ico'])

/**
 * LE ESTENSIONI AMMESSE — la fotografia del 2026-09-16, non un giudizio.
 *
 * `woff2?` sta qui nella forma in cui è scritta nel matcher (il `?` vale sul `2`:
 * copre `woff` e `woff2`), perché questo elenco si confronta con ciò che c'è
 * scritto davvero, non con ciò che vorremmo leggere.
 *
 * ⚠️ `html` NON c'è, ed è una decisione, non una dimenticanza: è scritta nel
 * commento di `PUBLIC_PREFIXES` accanto a `/google8a174b25967018e2.html` («il
 * matcher esclude le estensioni statiche ma **non `.html`**»). Vedi il test
 * dedicato in fondo.
 */
const ESTENSIONI_AMMESSE = new Set([
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico',
  'css', 'js', 'map', 'txt', 'webmanifest', 'woff2?',
])

/** `.*\.(?:svg|png)$` — la forma canonica del gruppo di estensioni. */
const GRUPPO_ESTENSIONI = /^\.[*+]\\\.\((?:\?:)?([^()]*)\)\$$/

/** La forma «copre tutto»: ciò che resta di una voce quando si tolgono le negazioni. */
const SCHELETRI_TOTALI = new Set(['/(.*)', '/:path*'])

/** Un percorso letterale (una voce che RESTRINGE, legittima solo se un'altra copre tutto). */
const LETTERALE = /^\/[A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)*(?:\/:path\*)?$/

/** Indice DOPO la `)` che chiude quella aperta in `apertura`, dentro una regex. */
function fineTonda(re: string, apertura: number): number {
  let livello = 0
  let inClasse = false
  for (let k = apertura; k < re.length; k++) {
    const c = re[k]
    if (c === '\\') {
      k++
      continue
    }
    if (inClasse) {
      if (c === ']') inClasse = false
      continue
    }
    if (c === '[') {
      inClasse = true
      continue
    }
    if (c === '(') livello++
    else if (c === ')') {
      livello--
      if (livello === 0) return k + 1
    }
  }
  return re.length
}

/** Le negazioni `(?!…)` di una regex, coi loro estremi. Escape e classi non ingannano. */
function negazioni(re: string): { da: number; a: number; corpo: string }[] {
  const out: { da: number; a: number; corpo: string }[] = []
  let inClasse = false
  for (let i = 0; i < re.length; i++) {
    const c = re[i]
    if (c === '\\') {
      i++
      continue
    }
    if (inClasse) {
      if (c === ']') inClasse = false
      continue
    }
    if (c === '[') {
      inClasse = true
      continue
    }
    if (c === '(' && re.startsWith('(?!', i)) {
      const a = fineTonda(re, i)
      out.push({ da: i, a, corpo: re.slice(i + 3, a - 1) })
      i = a - 1
    }
  }
  return out
}

/** Le alternative di primo livello di `a|b|c`. */
function alternative(corpo: string): string[] {
  const out: string[] = []
  let livello = 0
  let inClasse = false
  let inizio = 0
  for (let i = 0; i < corpo.length; i++) {
    const c = corpo[i]
    if (c === '\\') {
      i++
      continue
    }
    if (inClasse) {
      if (c === ']') inClasse = false
      continue
    }
    if (c === '[') {
      inClasse = true
      continue
    }
    if (c === '(') livello++
    else if (c === ')') livello--
    else if (c === '|' && livello === 0) {
      out.push(corpo.slice(inizio, i))
      inizio = i + 1
    }
  }
  out.push(corpo.slice(inizio))
  return out
}

/** Ciò che resta della voce tolte le negazioni: deve essere uno scheletro riconosciuto. */
function residuo(source: string): string {
  let out = source
  for (const n of [...negazioni(source)].reverse()) out = out.slice(0, n.da) + out.slice(n.a)
  return out
}

/** True se la voce, da sola, fa passare dal middleware ogni percorso non esentato. */
function copreTutto(v: Voce): boolean {
  return SCHELETRI_TOTALI.has(residuo(v.source))
}

const DOVE_INVECE =
  'Il posto di un prefisso di rotta è PUBLIC_PREFIXES in `src/lib/auth/middleware-rules.ts`: ' +
  'lì la riga si scrive con la sua motivazione e c’è `prefissi-pubblici.test.ts` a controllarla. ' +
  'Qui non chiede niente a nessuno e non la guarda nessuno.'

/** I difetti di UNA alternativa dentro la negazione. */
function difettiAlternativa(alt: string): string[] {
  const a = alt.trim()
  if (a === '') {
    return [
      'c’è un’alternativa VUOTA nella negazione (`(?!a||b)`): un ramo vuoto combacia con ' +
        'qualunque cosa, quindi la negazione diventa vera sempre e il middleware non gira più ' +
        'da nessuna parte. È un `|` di troppo, e non se ne accorge nessuno.',
    ]
  }
  if (INTERNI_NEXT.has(a)) return []

  const gruppo = GRUPPO_ESTENSIONI.exec(a)
  if (gruppo) {
    const guai: string[] = []
    for (const grezza of gruppo[1].split('|')) {
      const e = grezza.trim()
      if (ESTENSIONI_AMMESSE.has(e)) continue
      if (e.includes('/')) {
        guai.push(
          `«${e}» sta nel gruppo delle estensioni ma contiene una barra: è un PERCORSO travestito ` +
            `da estensione. Lì dentro non lo cerca nessuno, ed è il punto. ${DOVE_INVECE}`,
        )
        continue
      }
      guai.push(
        `«${e}» non è fra le estensioni ammesse (${[...ESTENSIONI_AMMESSE].join(', ')}). ` +
          'Se è davvero un asset statico, va aggiunta all’elenco di questo lock con la data e il ' +
          'perché: doverla scrivere due volte è tutta la protezione che c’è. Se invece è una ' +
          `ROTTA con un’estensione addosso, l’esenzione è vera e silenziosa. ${DOVE_INVECE}`,
      )
    }
    return guai
  }

  if (/^\.[*+]\\\./.test(a)) {
    return [
      `«${a}» esenta per estensione ma non è nella forma ancorata \`.*\\.(?:…)$\`. Senza il ` +
        '`$` finale la negazione vale per ogni percorso che CONTENGA quel pezzo, non per quelli ' +
        'che ci finiscono: `/api/admin.png/qualunque-cosa` smetterebbe di passare dal ' +
        'middleware. L’àncora non è una rifinitura — è ciò che distingue «finisce con .png» da ' +
        '«ha un .png dentro».',
    ]
  }

  // `api` merita una riga sua: è l'esempio che la documentazione di Next mette
  // per primo, quindi è la forma che ha più probabilità di arrivare per copia.
  const nota =
    a === 'api' || a.startsWith('api/')
      ? ' ⚠️ È l’esempio della documentazione di Next (`proxy.md`), e qui non si può copiare: ' +
        'esentare le API non toglierebbe un redirect (le API non sono mai redirette — ' +
        '`shouldRedirect` esce prima), toglierebbe l’`x-request-id` che questo file conia e su ' +
        'cui `withRoute` apre il contesto di log. Cioè: la correlazione dei log di TUTTE le ' +
        'route del progetto, spenta in silenzio e con la suite verde.'
      : ''
  return [
    `«${a}» non è né un percorso interno di Next né un gruppo di estensioni: è un PREFISSO DI ` +
      'ROTTA, e ciò che sta dentro questa negazione non passa dal middleware. Non «passa senza ' +
      `sessione»: non ci passa affatto, quindi nessun gate lo vede partire. ${DOVE_INVECE}${nota}`,
  ]
}

/** Tutti i difetti di una voce del matcher. */
function analizzaVoce(v: Voce): string[] {
  const guai: string[] = []

  if (v.oggetto) {
    const extra = v.chiavi.filter((c) => c !== 'source')
    if (extra.length > 0) {
      guai.push(
        `la voce è in forma d’oggetto e dichiara ${extra.map((c) => `\`${c}\``).join(', ')} oltre ` +
          'a `source`. `has` e `missing` accendono o spengono il middleware a seconda di un ' +
          'header, di un cookie o di un parametro — cioè di qualcosa che SCEGLIE CHI CHIAMA. È ' +
          'la forma più pericolosa di esenzione proprio perché non si vede leggendo il percorso: ' +
          'il matcher sembra coprire tutto, e non copre. Nel matcher va la sola `source`; se una ' +
          'rotta deve essere raggiungibile senza sessione, il posto è PUBLIC_PREFIXES in ' +
          '`src/lib/auth/middleware-rules.ts`, che è dichiarato e sorvegliato.',
      )
    }
    if (v.source === '') {
      guai.push(
        'la voce è in forma d’oggetto ma non ha una `source` leggibile: il lock non sa che cosa ' +
          'sta sorvegliando, e un lock che non legge niente non va lasciato passare.',
      )
    }
  }

  for (const n of negazioni(v.source)) {
    for (const alt of alternative(n.corpo)) guai.push(...difettiAlternativa(alt))
  }

  const r = residuo(v.source)
  if (!SCHELETRI_TOTALI.has(r) && !LETTERALE.test(r)) {
    guai.push(
      `tolte le negazioni, la voce «${v.source}» si riduce a «${r}», che non è una forma ` +
        'riconosciuta. Un’esclusione si può scrivere anche senza `(?!`: un lookbehind ' +
        '`(?<!api)`, una classe negata `[^a]`, un gruppo condizionale. Sarebbe la stessa ' +
        'esenzione, scritta in un modo che nessuno pensa di cercare. Le forme ammesse sono il ' +
        'catch-all `/((?!…).*)` e un percorso letterale.',
    )
  }

  return guai
}

/** I difetti di tutte le voci di un sorgente, con la riga davanti. */
function difetti(src: string, dove: string): string[] {
  const voci = vociMatcher(src, dove)
  if (voci === null) return []
  return voci.flatMap((v) => analizzaVoce(v).map((d) => `${dove}:${v.riga} ${d}`))
}

// ──────────────────────────────────────────────────────────────────────────────
// I casi di prova: le FAMIGLIE di forme con cui si può esentare una rotta
// ──────────────────────────────────────────────────────────────────────────────

/** Un sorgente di porta finto, con il `matcher` che gli si passa. */
function porta(matcher: string, commento = ''): string {
  return `import { NextResponse } from 'next/server';
${commento}
export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: ${matcher},
};
`
}

/** Il matcher VERO del 2026-09-16, che è anche il controllo negativo dei casi qui sotto. */
const MATCHER_DI_OGGI = String.raw`'/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|webmanifest|woff2?)$).*)'`

interface Caso {
  nome: string
  sorgente: string
  /** Un frammento che il messaggio d'errore deve contenere. */
  atteso: string
}

const ATTACCHI: Caso[] = [
  {
    nome: 'F1 · un prefisso di rotta infilato nella negazione (l’incidente del 16/09)',
    sorgente: porta(
      String.raw`['/((?!_next/static|_next/image|favicon.ico|\\.well-known/workflow/|.*\\.(?:svg|png)$).*)']`,
    ),
    atteso: 'well-known',
  },
  {
    nome: 'F2 · `api` nella negazione, copiato dall’esempio della documentazione di Next',
    sorgente: porta(String.raw`['/((?!api|_next/static|_next/image|.*\\.(?:png)$).*)']`),
    atteso: 'api',
  },
  {
    nome: 'F3 · una rotta travestita da estensione dentro il gruppo',
    sorgente: porta(String.raw`['/((?!_next/static|.*\\.(?:svg|png|api/health)$).*)']`),
    atteso: 'api/health',
  },
  {
    nome: 'F4 · un’estensione che non è un asset (`php`) aggiunta al gruppo',
    sorgente: porta(String.raw`['/((?!_next/static|.*\\.(?:svg|png|php)$).*)']`),
    atteso: 'php',
  },
  {
    nome: 'F5 · il gruppo di estensioni senza l’àncora di fine',
    sorgente: porta(String.raw`['/((?!_next/static|.*\\.(?:svg|png)).*)']`),
    atteso: 'ancorat',
  },
  {
    nome: 'F6 · la forma a oggetto con `missing`: il middleware salta se il chiamante manda un header',
    sorgente: porta(
      String.raw`[{ source: '/((?!_next/static).*)', missing: [{ type: 'header', key: 'x-interno' }] }]`,
    ),
    atteso: 'missing',
  },
  {
    nome: 'F7 · la forma a oggetto con `has`: stessa leva, segno opposto',
    sorgente: porta(
      String.raw`[{ source: '/((?!_next/static).*)', has: [{ type: 'cookie', key: 'salta' }] }]`,
    ),
    atteso: 'has',
  },
  {
    nome: 'F8 · una SECONDA voce sporca, con la prima pulita',
    sorgente: porta(`[\n    ${MATCHER_DI_OGGI},\n    '/((?!api/interno).*)',\n  ]`),
    atteso: 'api/interno',
  },
  {
    nome: 'F9 · l’esclusione scritta senza `(?!` (lookbehind)',
    sorgente: porta(String.raw`['/(?<!api)(.*)']`),
    atteso: 'forma',
  },
  {
    nome: 'F10 · l’esclusione scritta con una classe di caratteri',
    sorgente: porta(String.raw`['/([^a].*)']`),
    atteso: 'forma',
  },
  {
    nome: 'F11 · il matcher vero sporco, con un esempio PULITO in un commento',
    sorgente: porta(String.raw`['/((?!_next/static|\\.well-known/interno/).*)']`,
      `// Esempio: matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']`),
    atteso: 'well-known',
  },
]

describe('lock — nel matcher della porta stanno solo asset statici', () => {
  it('il lock legge davvero il matcher del file vero (controllo positivo)', () => {
    const porte = portePresenti()
    expect(porte.length, 'nessun file-porta').toBeGreaterThan(0)
    let viste = 0
    for (const f of porte) {
      const voci = vociMatcher(fs.readFileSync(f, 'utf8'), path.relative(RADICE, f))
      if (voci === null) continue
      viste += voci.length
      expect(
        voci.some((v) => v.source.includes('_next/static')),
        `${path.relative(RADICE, f)}: il matcher letto non contiene `
          + '`_next/static` — o il file è cambiato, o questo lock sta leggendo la stringa sbagliata',
      ).toBe(true)
    }
    expect(viste, 'nessuna voce di matcher letta: il lock non sta provando niente').toBeGreaterThan(0)
  })

  it('il lock CADE se il file-porta non si trova (niente verde per cecità)', () => {
    // Se un giorno `middleware.ts` diventa `proxy.ts` (Next 16 lo deprecata e
    // offre il codemod) e nessuno aggiorna CANDIDATI, deve essere rumoroso.
    expect(() => portePresenti(path.join(RADICE, '__tests__'))).toThrow(/nessun file-porta/)
  })

  it('nessuna voce del matcher esenta una ROTTA', () => {
    const guai = portePresenti().flatMap((f) =>
      difetti(fs.readFileSync(f, 'utf8'), path.relative(RADICE, f)),
    )
    expect(guai, 'esenzioni dall’autenticazione scritte nel matcher').toEqual([])
  })

  it('almeno una voce copre TUTTO: il catch-all non si restringe in silenzio', () => {
    for (const f of portePresenti()) {
      const dove = path.relative(RADICE, f)
      const voci = vociMatcher(fs.readFileSync(f, 'utf8'), dove)
      if (voci === null) continue // nessun matcher = il middleware gira su tutto
      expect(
        voci.some(copreTutto),
        `${dove}: nessuna voce del matcher copre tutti i percorsi. ` +
          'Restringere il matcher a due o tre aree non «disattiva una regola»: toglie il ' +
          'middleware da tutto il resto del sito, in silenzio e senza che nessun 404 lo dica.',
      ).toBe(true)
    }
  })

  it('il matcher NON esenta i file `.html`', () => {
    expect(ESTENSIONI_AMMESSE.has('html'), 'html fra le estensioni ammesse').toBe(false)
    expect(ESTENSIONI_AMMESSE.has('htm'), 'htm fra le estensioni ammesse').toBe(false)
    for (const f of portePresenti()) {
      const voci = vociMatcher(fs.readFileSync(f, 'utf8'), path.relative(RADICE, f)) ?? []
      for (const v of voci) {
        expect(
          /\bhtml?\b/.test(v.source),
          `${path.relative(RADICE, f)}: il matcher nomina \`html\`. È deliberatamente ESCLUSO ` +
            'dalle esenzioni: `/google8a174b25967018e2.html` (la prova di titolarità per Search ' +
            'Console) è pubblico passando da PUBLIC_PREFIXES, cioè dal meccanismo sorvegliato. ' +
            'Metterlo qui renderebbe pubblico ogni `.html` presente e futuro, e farebbe sembrare ' +
            'rimovibile quella riga di PUBLIC_PREFIXES.',
        ).toBe(false)
      }
    }
  })

  it.each(ATTACCHI)('$nome', ({ sorgente, atteso }) => {
    const guai = difetti(sorgente, 'finto/middleware.ts')
    expect(guai.length, 'nessun difetto trovato su una forma che esenta una rotta').toBeGreaterThan(0)
    expect(guai.join(' | ')).toContain(atteso)
  })

  it('F12 · il catch-all ristretto a due aree — e perché serve un SECONDO controllo', () => {
    // Questa famiglia non ha niente di sporco da trovare: non c'è nessuna
    // negazione, nessun prefisso, nessuna estensione. Restringere il matcher a
    // `/admin` e `/parent` non esenta una rotta: esenta TUTTO IL RESTO, che è la
    // stessa cosa scritta al contrario. L'analisi delle negazioni qui è cieca per
    // costruzione, ed è il motivo per cui il lock ha due controlli e non uno.
    const sorgente = porta(String.raw`['/admin/:path*', '/parent/:path*']`)
    expect(
      difetti(sorgente, 'finto/middleware.ts'),
      'l’analisi delle negazioni dovrebbe essere cieca su questa forma: se trova qualcosa, ' +
        'il commento qui sopra è diventato falso',
    ).toEqual([])
    const voci = vociMatcher(sorgente, 'finto/middleware.ts')!
    expect(voci.some(copreTutto), 'nessuna voce copre tutto, e il lock non se n’è accorto').toBe(false)
  })

  it('F13 · un matcher che non è una costante fa CADERE il lock, non passare', () => {
    // Next analizza il matcher a build-time e IGNORA i valori dinamici: una
    // variabile qui non è una configurazione da leggere, è una configurazione che
    // non esiste — e questo lock, che legge il sorgente, diventerebbe cieco senza
    // dirlo. Meglio rumoroso.
    expect(() => difetti(porta('MATCHER_ESTERNO'), 'finto/middleware.ts')).toThrow(/costante/)
  })

  it('F14 · un file-porta senza `export const config` fa CADERE il lock', () => {
    expect(() =>
      difetti('export function middleware() { return null; }\n', 'finto/middleware.ts'),
    ).toThrow(/config/)
  })

  it('un `config` SENZA `matcher` non è un difetto: in Next vuol dire «gira su tutto»', () => {
    // Il verso opposto va detto, altrimenti il lock chiederebbe di tenere
    // un'esenzione che non serve. Senza matcher il middleware gira su ogni
    // richiesta, asset compresi: copertura massima, zero esenzioni.
    expect(difetti(`export const config = { runtime: 'nodejs' };\n`, 'finto/middleware.ts')).toEqual([])
  })

  it('la copia di controllo è ANCORA quella vera (una copia che invecchia smette di controllare)', () => {
    // `MATCHER_DI_OGGI` serve da controllo negativo agli attacchi qui sopra: è la
    // forma buona, e deve passare. Ma è una COPIA, e una copia si stacca
    // dall'originale senza fare rumore — è lo stesso modo in cui, in
    // `prefissi-pubblici`, una deroga è sopravvissuta alla ragione che l'aveva
    // scritta. Se questo test cade, il matcher vero è cambiato: vanno aggiornate
    // insieme la copia qui sotto e, se l'elenco delle estensioni si è allargato,
    // ESTENSIONI_AMMESSE — con la data e il perché.
    const copia = vociMatcher(porta(`[${MATCHER_DI_OGGI}]`), 'finto/middleware.ts')![0].source
    const vere = portePresenti().flatMap(
      (f) => vociMatcher(fs.readFileSync(f, 'utf8'), path.relative(RADICE, f)) ?? [],
    )
    expect(
      vere.map((v) => v.source),
      'la copia di controllo non combacia più con nessuna voce del matcher vero',
    ).toContain(copia)
  })

  it('il matcher di oggi passa (se cadesse, il lock sarebbe rosso e basta)', () => {
    // Il controllo negativo degli attacchi qui sopra: la stessa analisi, sulla
    // forma vera, non deve trovare niente. Un lock che colora di rosso qualunque
    // cosa non distingue più il difetto dal normale.
    expect(difetti(porta(`[${MATCHER_DI_OGGI}]`), 'finto/middleware.ts')).toEqual([])
  })

  it('un esempio sporco dentro un COMMENTO non accende il lock', () => {
    // Il verso opposto di F11, e va provato perché questo file legge del TESTO:
    // `src/middleware.ts` nomina `matcher` in tre punti, due dei quali sono prosa.
    const src = porta(
      `[${MATCHER_DI_OGGI}]`,
      `/* Non si scrive così: matcher: ['/((?!\\\\.well-known/workflow/).*)'] */`,
    )
    expect(difetti(src, 'finto/middleware.ts')).toEqual([])
  })

  it('il meccanismo verso cui il messaggio manda è ancora sorvegliato', () => {
    // I messaggi di questo file dicono «mettilo in PUBLIC_PREFIXES». Se quel lock
    // sparisse, manderebbero la gente verso una porta senza guardia.
    expect(fs.existsSync(path.join(RADICE, '__tests__/architecture/prefissi-pubblici.test.ts'))).toBe(true)
    expect(
      fs.readFileSync(path.join(RADICE, 'src/lib/auth/middleware-rules.ts'), 'utf8'),
    ).toContain('PUBLIC_PREFIXES')
  })
})
