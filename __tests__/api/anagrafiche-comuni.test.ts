// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * `GET /api/anagrafiche/comuni` — la tendina a cascata provincia → comune.
 *
 * ─── COSA PROTEGGONO QUESTI TEST ────────────────────────────────────────────────
 * Questa route è il SOLO consumatore di `@/lib/fiscale/comuni`, cioè delle 13.656
 * righe della tabella Belfiore (~294 KB). Il lock
 * `__tests__/architecture/dataset-comuni-fuori-dal-bundle.test.ts` impedisce che
 * quel dataset raggiunga il browser; questi test verificano l'altra metà, cioè che
 * l'endpoint che lo sostituisce risponda davvero — e che la risposta resti PICCOLA.
 *
 * Il peso è un'asserzione di prima classe e non un vezzo: se un giorno la tendina
 * cominciasse a restituire l'intero dataset (una `provincia` ignorata, un filtro
 * saltato), nessun test funzionale se ne accorgerebbe — le tendine funzionerebbero
 * benissimo, e ogni famiglia scaricherebbe 300 KB per scegliere un comune. È lo
 * stesso guasto invisibile che il lock del bundle esiste per fermare, dall'altra
 * parte della rete.
 *
 * ─── I NUMERI VERI, MISURATI IL 2026-08-10 SUL DATASET COMMITTATO ──────────────
 * Sono qui perché una crescita improvvisa si veda a colpo d'occhio, senza rimisurare.
 *
 *   provincia     righe attive   righe totali   peso JSON attivi   peso JSON totale
 *   NA (Napoli)             92            141           6.305 B            9.683 B
 *   TO (Torino)            312            484          21.063 B           32.727 B
 *   EE (estero)            272            335          18.822 B           23.508 B
 *
 * TO è il caso peggiore d'Italia (484 denominazioni fra attive e soppresse) e resta
 * sotto i 33 KB: due ordini di grandezza meno del dataset intero, e — per un utente
 * ANONIMO — una volta sola per provincia scelta, grazie alla cache condivisa di 24
 * ore. La cautela su «anonimo» non è un vezzo: da un browser con una sessione aperta
 * la risposta è `private`, cioè cache del solo browser e non della CDN, ed è il
 * prezzo misurato del `Set-Cookie` che il middleware può attaccare a questa risposta
 * (vedi il blocco «`public` mai insieme a una sessione», più sotto).
 *
 * ⚠️ «Una volta sola per provincia» va detto per intero, perché la piattaforma dà
 * meno di quanto la frase prometta: con `Vary: Cookie` — che questa route dichiara —
 * ogni valore diverso dell'header `Cookie` è una VOCE DI CACHE a sé (RFC 9111 §4.1),
 * quindi la copia CONDIVISA la riusano in pratica le sole richieste che non mandano
 * nessun cookie. Nel wizard pubblico sono la maggioranza, ed è per quelle che vale.
 * Per tutte le altre resta la cache del browser, che è comunque il 99% del beneficio
 * per una famiglia sulla rete mobile.
 *
 * ⚠️ COSA QUESTI TEST NON MISURANO, detto qui perché non lo scopra qualcun altro:
 * chiamano `GET()` NUDA, quindi restano fuori il middleware, gli header di
 * `next.config.ts` e il comportamento di una cache vera. La sola prova su HTTP vero
 * presa in questo lavoro è quella riportata nel blocco «`public` mai insieme a una
 * sessione» — due `curl` contro il `next start` già in ascolto sulla 3100 — e
 * riguarda `/api/health`, non questa route: il build in ascolto è precedente alla
 * nascita di questa route, che infatti lì risponde 404.
 *
 * ⚠️ E LA METÀ CHE MANCAVA: `Vary: Cookie`. Next scrive un `vary` PROPRIO su ogni
 * risposta di route — misurato il 2026-08-10 sulla 3100, `GET /api/health` →
 * `vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch`.
 * Se quello strato sostituisse invece di accodare, il `Vary: Cookie` di questa route
 * sparirebbe in produzione senza che nessun test qui dentro diventi rosso. Misurato
 * il 2026-08-10 sul codice di Next 16.3.0 installato: `sendResponse`
 * (`next/dist/server/send-response.js`) tiene `vary` in un elenco esplicito di
 * intestazioni a valori multipli (insieme a `set-cookie`) e la ACCODA con
 * `res.appendHeader`. Fatto girare su un server HTTP vero con la `Response` di questa
 * route, il client riceve `vary: rsc, …, next-router-segment-prefetch, Cookie`.
 * Quindi `Cookie` sopravvive — ed è la stessa fusione di header che fa arrivare qui
 * il `Set-Cookie` del middleware.
 *
 * Le soglie qui sotto sono BANDE, non uguaglianze: il dataset è generato e può
 * essere rigenerato da una fonte più recente (oggi è ferma al 2022). Una banda
 * stretta cade su un aggiornamento legittimo; una banda che ha per estremi «metà» e
 * «il doppio» della misura cade solo su un cambio di natura — che è ciò che si
 * vuole vedere.
 */

// Il logger è silenzioso sotto vitest: si mocka per non dipendere dal suo silenzio.
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

const h = vi.hoisted(() => ({ rl: { ok: true, remaining: 59, retryAfterMs: 0 } }))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn(() => h.rl),
  clientIp: vi.fn(() => 'ip-di-prova'),
}))

import { GET } from '@/app/api/anagrafiche/comuni/route'
import type { Comune } from '@/lib/fiscale/comuni'
import { rateLimit } from '@/lib/security/rate-limit'

interface ComuneRisposta {
  belfiore: string
  nome: string
  sigla: string
  attivo: boolean
}
interface Corpo {
  comuni?: ComuneRisposta[]
  error?: string
  codice?: string
  details?: { path: string; message: string }[]
}

const BASE = 'http://localhost/api/anagrafiche/comuni'

function req(query = '', init?: RequestInit) {
  return new Request(`${BASE}${query}`, init) as unknown as import('next/server').NextRequest
}

/** Il peso VERO della risposta, in byte, come lo riceve il browser. */
async function pesoDi(res: Response): Promise<number> {
  return Buffer.byteLength(await res.text(), 'utf8')
}

beforeEach(() => {
  vi.clearAllMocks()
  h.rl = { ok: true, remaining: 59, retryAfterMs: 0 }
})

describe('GET /api/anagrafiche/comuni — elenco per provincia', () => {
  it('?provincia=NA da anonimo: 200 con un elenco NON vuoto e ordinato per nome', async () => {
    const res = await GET(req('?provincia=NA'))
    expect(res.status).toBe(200)
    const json = (await res.json()) as Corpo
    const comuni = json.comuni ?? []
    expect(comuni.length).toBeGreaterThan(50)

    // Napoli c'è, con il suo Belfiore vero.
    expect(comuni.find((c) => c.nome === 'NAPOLI')?.belfiore).toBe('F839')
    // Ogni riga porta i quattro campi dichiarati, e SOLO quelli.
    for (const c of comuni.slice(0, 5)) {
      expect(Object.keys(c).sort()).toEqual(['attivo', 'belfiore', 'nome', 'sigla'])
      expect(c.sigla).toBe('NA')
    }
    // Ordine alfabetico stabile (confronto sui codepoint, come nella libreria).
    const nomi = comuni.map((c) => c.nome)
    expect(nomi).toEqual([...nomi].sort())
  })

  it('di default i soppressi NON ci sono: un genitore non sceglie un comune che non esiste più', async () => {
    const res = await GET(req('?provincia=NA'))
    const { comuni = [] } = (await res.json()) as Corpo
    expect(comuni.every((c) => c.attivo)).toBe(true)
    // `BARRA` (A675) è una denominazione soppressa di NA: senza il flag non deve uscire.
    expect(comuni.some((c) => c.belfiore === 'A675')).toBe(false)
  })

  it('?includiSoppressi cambia il risultato: chi è nato nel 1978 ritrova il suo comune', async () => {
    const soloAttivi = ((await (await GET(req('?provincia=NA'))).json()) as Corpo).comuni ?? []
    const conStorici =
      ((await (await GET(req('?provincia=NA&includiSoppressi'))).json()) as Corpo).comuni ?? []

    expect(conStorici.length).toBeGreaterThan(soloAttivi.length)
    expect(conStorici.some((c) => c.belfiore === 'A675' && c.attivo === false)).toBe(true)

    // Gli ATTIVI stanno davanti: la tendina mostra prima ciò che si sceglie oggi.
    const primoSoppresso = conStorici.findIndex((c) => !c.attivo)
    expect(primoSoppresso).toBeGreaterThan(0)
    expect(conStorici.slice(0, primoSoppresso).every((c) => c.attivo)).toBe(true)
    expect(conStorici.slice(primoSoppresso).every((c) => !c.attivo)).toBe(true)

    // …e dentro ciascun blocco, l'ordine resta alfabetico.
    const attivi = conStorici.slice(0, primoSoppresso).map((c) => c.nome)
    const soppressi = conStorici.slice(primoSoppresso).map((c) => c.nome)
    expect(attivi).toEqual([...attivi].sort())
    expect(soppressi).toEqual([...soppressi].sort())
  })

  it('`includiSoppressi=1` e `=true` valgono quanto il flag nudo; `=0` e `=false` lo spengono', async () => {
    const n = async (q: string) => (((await (await GET(req(q))).json()) as Corpo).comuni ?? []).length
    const nudo = await n('?provincia=NA&includiSoppressi')
    expect(await n('?provincia=NA&includiSoppressi=1')).toBe(nudo)
    expect(await n('?provincia=NA&includiSoppressi=true')).toBe(nudo)
    const spento = await n('?provincia=NA')
    expect(await n('?provincia=NA&includiSoppressi=0')).toBe(spento)
    expect(await n('?provincia=NA&includiSoppressi=false')).toBe(spento)
  })

  it('un valore che NON è booleano è 400, non un «forse» interpretato a caso', async () => {
    const res = await GET(req('?provincia=NA&includiSoppressi=forse'))
    expect(res.status).toBe(400)
  })

  it('?provincia=EE dà gli stati esteri (chi è nato fuori dall’Italia)', async () => {
    const res = await GET(req('?provincia=EE'))
    expect(res.status).toBe(200)
    const { comuni = [] } = (await res.json()) as Corpo
    expect(comuni.length).toBeGreaterThan(100)
    expect(comuni.every((c) => c.sigla === 'EE')).toBe(true)
    // Gli stati esteri hanno il Belfiore che comincia per Z: è come si riconoscono.
    expect(comuni.every((c) => c.belfiore.startsWith('Z'))).toBe(true)
    expect(comuni.some((c) => c.belfiore === 'Z404')).toBe(true) // Stati Uniti d'America
  })

  it('accetta le sigle STORICHE presenti nel dataset (PL, ZA): non un elenco cablato', async () => {
    for (const sigla of ['PL', 'ZA']) {
      const res = await GET(req(`?provincia=${sigla}&includiSoppressi`))
      expect(res.status, `sigla storica ${sigla}`).toBe(200)
      const { comuni = [] } = (await res.json()) as Corpo
      expect(comuni.length, `sigla storica ${sigla}`).toBeGreaterThan(0)
    }
  })

  it('la sigla si accetta minuscola: dal form arriva come l’ha scritta l’utente', async () => {
    const res = await GET(req('?provincia=na'))
    expect(res.status).toBe(200)
    const { comuni = [] } = (await res.json()) as Corpo
    expect(comuni.every((c) => c.sigla === 'NA')).toBe(true)
  })

  it('?provincia=XX ⇒ 400 di zod: due lettere ma nessuna provincia', async () => {
    const res = await GET(req('?provincia=XX'))
    expect(res.status).toBe(400)
    const json = (await res.json()) as Corpo
    expect(json.error).toBe('Dati non validi')
    expect(json.details?.[0]?.path).toBe('provincia')
  })

  it('senza parametri ⇒ 400: non si risponde con l’Italia intera', async () => {
    const res = await GET(req(''))
    expect(res.status).toBe(400)
  })
})

describe('GET /api/anagrafiche/comuni — risoluzione di un singolo Belfiore', () => {
  it('?belfiore=H501 risolve Roma', async () => {
    const res = await GET(req('?belfiore=H501'))
    expect(res.status).toBe(200)
    const { comuni = [] } = (await res.json()) as Corpo
    expect(comuni).toEqual([{ belfiore: 'H501', nome: 'ROMA', sigla: 'RM', attivo: true }])
  })

  it('un Belfiore SOPPRESSO si risolve lo stesso: è il valore già in archivio che va mostrato', async () => {
    const res = await GET(req('?belfiore=D206')) // CUNEVO (TN), comune estinto
    expect(res.status).toBe(200)
    const { comuni = [] } = (await res.json()) as Corpo
    expect(comuni).toEqual([{ belfiore: 'D206', nome: 'CUNEVO', sigla: 'TN', attivo: false }])
  })

  it('un Belfiore inesistente è un elenco VUOTO, non un errore', async () => {
    const res = await GET(req('?belfiore=A000'))
    expect(res.status).toBe(200)
    expect(((await res.json()) as Corpo).comuni).toEqual([])
  })

  it('una forma che non è un Belfiore ⇒ 400', async () => {
    for (const v of ['H50', 'HH01', '1501', 'H5011']) {
      expect((await GET(req(`?belfiore=${v}`))).status, v).toBe(400)
    }
  })

  it('provincia e belfiore insieme ⇒ 400: la richiesta chiede due cose diverse', async () => {
    const res = await GET(req('?provincia=RM&belfiore=H501'))
    expect(res.status).toBe(400)
  })
})

const CACHE_CONDIVISA = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800'
const CACHE_PRIVATA = 'private, max-age=86400, stale-while-revalidate=604800'

/** Un cookie di sessione `@supabase/ssr` come lo manda un browser autenticato. */
const COOKIE_SESSIONE = 'sb-uimulkjyekgemjakmepp-auth-token=base64-eyJhIjoxfQ'

describe('GET /api/anagrafiche/comuni — cache condivisa', () => {
  it('da anonimo porta Cache-Control condiviso (con `s-maxage`), un ETag e il Content-Type', async () => {
    const res = await GET(req('?provincia=NA'))
    expect(res.headers.get('Cache-Control')).toBe(CACHE_CONDIVISA)
    // Il tipo va dichiarato, e va protetto: `res.json()`/`res.text()` dei test lo
    // ignorano, quindi togliendolo la suite restava verde. Su una risposta destinata
    // a una cache CONDIVISA per 24 ore, un tipo sbagliato lo prendono tutti i client
    // per un giorno intero.
    expect(res.headers.get('Content-Type')).toMatch(/^application\/json/)
    // `s-maxage` è la direttiva che il proxy di Vercel consuma: senza, «una volta
    // sola per provincia grazie alla cache» varrebbe per la sola cache del browser.
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=86400')
    const etag = res.headers.get('ETag')
    expect(etag).toBeTruthy()
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/)
  })

  it('l’ETag è STABILE a parità di richiesta e DIVERSO al cambiare della risposta', async () => {
    const na1 = (await GET(req('?provincia=NA'))).headers.get('ETag')
    const na2 = (await GET(req('?provincia=NA'))).headers.get('ETag')
    const naStorici = (await GET(req('?provincia=NA&includiSoppressi'))).headers.get('ETag')
    const to = (await GET(req('?provincia=TO'))).headers.get('ETag')

    expect(na1).toBe(na2)
    expect(na1).not.toBe(naStorici)
    expect(na1).not.toBe(to)
  })

  it('If-None-Match con l’ETag corrente ⇒ 304 senza corpo, ma con le stesse intestazioni', async () => {
    const primo = await GET(req('?provincia=NA'))
    const etag = primo.headers.get('ETag') as string

    const secondo = await GET(req('?provincia=NA', { headers: { 'If-None-Match': etag } }))
    expect(secondo.status).toBe(304)
    expect(await secondo.text()).toBe('')
    expect(secondo.headers.get('ETag')).toBe(etag)
    expect(secondo.headers.get('Cache-Control')).toBe(CACHE_CONDIVISA)
    expect(secondo.headers.get('Vary')).toBe('Cookie')
  })

  it('un ETag diverso NON dà 304: la risposta è cambiata e il client deve riceverla', async () => {
    const res = await GET(req('?provincia=NA', { headers: { 'If-None-Match': '"vecchio"' } }))
    expect(res.status).toBe(200)
  })

  it('regge il marcatore debole `W/` e l’elenco di ETag che i proxy mandano', async () => {
    const etag = (await GET(req('?provincia=NA'))).headers.get('ETag') as string

    for (const valore of [`W/${etag}`, `"altro", ${etag}`, `W/"altro",  W/${etag}`]) {
      const res = await GET(req('?provincia=NA', { headers: { 'If-None-Match': valore } }))
      expect(res.status, valore).toBe(304)
    }
  })

  it('`*` e le intestazioni che non si riconoscono danno 200: nel dubbio si SPEDISCE', async () => {
    // Un 304 sbagliato lascerebbe al browser una tendina vecchia — comuni che non
    // esistono più — senza che nessuno se ne accorga. Un 200 di troppo costa 6 KB.
    for (const valore of ['*', 'W/', '', 'roba a caso']) {
      const res = await GET(req('?provincia=NA', { headers: { 'If-None-Match': valore } }))
      expect(res.status, valore).toBe(200)
    }
  })
})

/**
 * ─── LA CACHE CONDIVISA E IL `Set-Cookie` DEL MIDDLEWARE ───────────────────────
 *
 * IL FATTO, MISURATO il 2026-08-10 sul `next start` in ascolto sulla 3100 (non
 * dedotto dal codice, non simulato qui dentro):
 *
 *   $ curl -sS -o /dev/null -D - http://localhost:3100/api/health
 *   HTTP/1.1 503 …                                        ← nessun set-cookie
 *
 *   $ curl -sS -o /dev/null -D - \
 *       -H 'Cookie: sb-uimulkjyekgemjakmepp-auth-token=base64-eyJhIjoxfQ' \
 *       http://localhost:3100/api/health
 *   HTTP/1.1 503 …
 *   set-cookie: sb-uimulkjyekgemjakmepp-auth-token=; Path=/; Max-Age=0; SameSite=lax
 *
 * Il `Set-Cookie` lo scrive il MIDDLEWARE (`setAll` di `@supabase/ssr`, sul rinnovo
 * o sulla cancellazione della sessione) e Next lo fonde nella risposta della ROUTE,
 * che quel cookie non l'ha mai toccato. Su `/api/health` non fa danno: risponde
 * `no-store`. Su QUESTA route, che è l'unica del progetto a rispondere `public`,
 * significherebbe un token di sessione dentro una cache condivisa.
 *
 * Questi test chiamano `GET()` e il middleware non c'è: quello che tengono fermo non
 * è la fusione degli header — quella è misurata sopra — ma la SOLA metà che dipende
 * da questo file, cioè che `public` non esca mai quando la richiesta porta un cookie
 * che il middleware potrebbe rinnovare.
 */
describe('GET /api/anagrafiche/comuni — `public` mai insieme a una sessione', () => {
  it('con un cookie di sessione Supabase la risposta è `private`, MAI `public`', async () => {
    const res = await GET(req('?provincia=NA', { headers: { Cookie: COOKIE_SESSIONE } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe(CACHE_PRIVATA)
    expect(res.headers.get('Cache-Control')).not.toContain('public')
    expect(res.headers.get('Cache-Control')).not.toContain('s-maxage')
    // Il beneficio per la famiglia resta: il browser di CHI ha chiesto la tiene.
    expect(res.headers.get('Cache-Control')).toContain('max-age=86400')
  })

  it('vale anche per il cookie SPEZZATO (`.0`/`.1`) e per il token oltre i 4 KB', async () => {
    for (const nome of [
      'sb-uimulkjyekgemjakmepp-auth-token.0',
      'sb-uimulkjyekgemjakmepp-auth-token.1',
      'sb-abc-def-auth-token',
    ]) {
      const res = await GET(req('?provincia=NA', { headers: { Cookie: `${nome}=x` } }))
      expect(res.headers.get('Cache-Control'), nome).toBe(CACHE_PRIVATA)
    }
  })

  it('il cookie di sessione si riconosce anche in mezzo agli altri, in qualunque ordine', async () => {
    for (const cookie of [
      `KV_LOCALE=it; ${COOKIE_SESSIONE}; altro=1`,
      `${COOKIE_SESSIONE}; KV_LOCALE=it`,
      `KV_LOCALE=it;${COOKIE_SESSIONE}`,
    ]) {
      const res = await GET(req('?provincia=NA', { headers: { Cookie: cookie } }))
      expect(res.headers.get('Cache-Control'), cookie).toBe(CACHE_PRIVATA)
    }
  })

  it('un cookie che NON è una sessione non spegne la cache condivisa', async () => {
    // Il criterio guarda il NOME del cookie, non la sua presenza, per una ragione
    // strutturale: a scrivere il `Set-Cookie` è `setAll` di `@supabase/ssr`, che si
    // accende sui soli `sb-<ref>-auth-token`. Su un cookie qualunque non c'è nessun
    // `Set-Cookie` da proteggere.
    //
    // ⚠️ Fino al 2026-08-10 qui il primo caso era `NEXT_LOCALE=it`, con il commento
    // «nel wizard pubblico un `NEXT_LOCALE` c'è quasi sempre». `NEXT_LOCALE` in
    // questa applicazione NON ESISTE: il cookie della lingua è `KV_LOCALE`
    // (`src/i18n/config.ts:11`) e lo scrive solo `LanguageSwitcher.tsx:12`, quando
    // l'utente cambia lingua a mano. Il caso ora è quello vero, non quello di
    // un'altra applicazione.
    for (const cookie of ['KV_LOCALE=it', 'ph_session=abc; _ga=GA1.1.2', 'sb-qualcosa=1']) {
      const res = await GET(req('?provincia=NA', { headers: { Cookie: cookie } }))
      expect(res.headers.get('Cache-Control'), cookie).toBe(CACHE_CONDIVISA)
    }
  })

  it('il criterio è quello CANONICO di `session-cookie.ts`, non una copia di questa route', async () => {
    // La regola che decide sta in `src/lib/auth/session-cookie.ts`
    // (`haCookieSessioneNellIntestazione`, `/^sb-.+-auth-token(\.\d+)?$/`), lo stesso
    // file che `withRoute` importa alla sua prima riga. Fino al 2026-08-10 la route
    // ne portava una copia con `[A-Za-z0-9_.-]+` al posto di `.+`, e le due
    // DIVERGEVANO già: su questi due nomi la copia diceva «non è una sessione» e
    // mandava su `public` una richiesta che la regola canonica manda su `private`.
    for (const nome of ['sb-a b-auth-token', 'sb-%C3%A8-auth-token']) {
      const res = await GET(req('?provincia=NA', { headers: { Cookie: `${nome}=x` } }))
      expect(res.headers.get('Cache-Control'), nome).toBe(CACHE_PRIVATA)
    }
  })

  it('`Vary: Cookie` c’è su ENTRAMBE le strade, 200 e 304', async () => {
    // Senza, una cache che ha già in mano la copia pubblica potrebbe servirla a una
    // richiesta con cookie diversi — e viceversa.
    const anonimo = await GET(req('?provincia=NA'))
    expect(anonimo.headers.get('Vary')).toBe('Cookie')

    const conSessione = await GET(req('?provincia=NA', { headers: { Cookie: COOKIE_SESSIONE } }))
    expect(conSessione.headers.get('Vary')).toBe('Cookie')

    const etag = anonimo.headers.get('ETag') as string
    const trecento4 = await GET(
      req('?provincia=NA', { headers: { Cookie: COOKIE_SESSIONE, 'If-None-Match': etag } }),
    )
    expect(trecento4.status).toBe(304)
    expect(trecento4.headers.get('Vary')).toBe('Cookie')
    expect(trecento4.headers.get('Cache-Control')).toBe(CACHE_PRIVATA)
  })

  it('il CORPO non cambia con la sessione: a cambiare è solo l’intestazione', async () => {
    // La ragione per cui questa route può stare in cache resta vera. Se un giorno il
    // corpo cominciasse a dipendere da chi chiama, `Vary: Cookie` non basterebbe più
    // e questa deroga andrebbe ridiscussa da capo.
    const anonimo = await (await GET(req('?provincia=NA'))).text()
    const autenticato = await (
      await GET(req('?provincia=NA', { headers: { Cookie: COOKIE_SESSIONE } }))
    ).text()
    expect(autenticato).toBe(anonimo)
  })
})

describe('GET /api/anagrafiche/comuni — tetto di frequenza', () => {
  it('la route chiede il tetto PRIMA di rispondere, con una chiave per IP', async () => {
    await GET(req('?provincia=NA'))
    expect(rateLimit).toHaveBeenCalledTimes(1)
    expect(vi.mocked(rateLimit).mock.calls[0][0]).toContain('ip-di-prova')
    // La chiave è PREFISSATA: senza il prefisso questa route dividerebbe il
    // contatore con qualunque altra pubblica che usi lo stesso IP.
    expect(vi.mocked(rateLimit).mock.calls[0][0]).toContain('anagrafiche-comuni:')
  })

  it('il tetto è 60 in 10 minuti — il numero che `PUBBLICHE` dichiara come perimetro', async () => {
    // Non è un dettaglio di taratura: `gate-coverage.test.ts` (voce `PUBBLICHE`,
    // `'anagrafiche/comuni:GET'`) scrive «Perimetro: tetto 60/10 min per IP», ed è
    // METÀ della ragione per cui questa route può stare senza gate d'identità. Fino
    // al 2026-08-10 nessun test leggeva il secondo argomento di `rateLimit`:
    // sostituendolo con `{ limit: 1_000_000, windowMs: 1 }` la suite restava verde e
    // tre documenti continuavano a dichiarare un perimetro che non c'era più.
    await GET(req('?provincia=NA'))
    const opzioni = vi.mocked(rateLimit).mock.calls[0][1]
    expect(opzioni.limit).toBe(60)
    expect(opzioni.windowMs).toBe(10 * 60 * 1000)
  })

  it('tetto superato ⇒ 429 con codice traducibile e Retry-After', async () => {
    h.rl = { ok: false, remaining: 0, retryAfterMs: 42_000 }
    const res = await GET(req('?provincia=NA'))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('42')
    const json = (await res.json()) as Corpo
    expect(json.codice).toBe('TROPPE_RICHIESTE')
    expect(json.error).toBeTruthy()
    // Una risposta di rifiuto non si mette in cache pubblica.
    expect(res.headers.get('Cache-Control')).not.toContain('public')
  })
})

/**
 * ─── LA PROIEZIONE, TENUTA FERMA DA FUORI ──────────────────────────────────────
 *
 * `proietta()` esiste per una ragione dichiarata nella route: «se domani la libreria
 * aggiungesse un campo, uno spread lo spedirebbe a ogni famiglia». Fino al
 * 2026-08-10 quella promessa non era protetta da niente — sostituendo il corpo con
 * `return { ...c }` la suite restava interamente verde, perché l'asserzione
 * `Object.keys(c).sort()` verifica il PRESENTE (oggi `Comune` ha esattamente quei
 * quattro campi) e non la REGOLA.
 *
 * Il test qui sotto verifica la regola: si sostituisce la libreria con una che
 * restituisce `Comune` con due campi in più, e si pretende che dalla risposta non
 * escano. Con lo spread è rosso.
 */
describe('GET /api/anagrafiche/comuni — un campo NUOVO del dataset non esce dalla risposta', () => {
  type ModuloComuni = typeof import('@/lib/fiscale/comuni')

  /** La route ricaricata sopra una libreria che ha imparato due campi nuovi. */
  async function routeConDatasetPiuRicco() {
    vi.resetModules()
    const vero = await vi.importActual<ModuloComuni>('@/lib/fiscale/comuni')
    const arricchisci = (c: Comune) => ({
      ...c,
      notaInterna: 'RISERVATO — non deve uscire',
      fonte: '/percorsi/interni/belfiore.csv',
    })
    vi.doMock('@/lib/fiscale/comuni', () => ({
      ...vero,
      comuniDiProvincia: (sigla: string, opzioni?: { soppressi?: boolean }) =>
        vero.comuniDiProvincia(sigla, opzioni).map(arricchisci),
      comunePerBelfiore: (codice: string) => {
        const c = vero.comunePerBelfiore(codice)
        return c === null ? null : arricchisci(c)
      },
    }))
    return (await import('@/app/api/anagrafiche/comuni/route')).GET
  }

  afterEach(() => {
    vi.doUnmock('@/lib/fiscale/comuni')
    vi.resetModules()
  })

  it('elenco per provincia: solo i quattro campi dichiarati, e nel testo grezzo nessuna traccia', async () => {
    const GETarricchito = await routeConDatasetPiuRicco()
    const res = await GETarricchito(req('?provincia=NA'))
    expect(res.status).toBe(200)

    const testo = await res.text()
    // Il controllo che conta davvero: il campo nuovo non è nel corpo SPEDITO.
    expect(testo).not.toContain('notaInterna')
    expect(testo).not.toContain('RISERVATO')
    expect(testo).not.toContain('fonte')
    expect(testo).not.toContain('belfiore.csv')

    const { comuni = [] } = JSON.parse(testo) as Corpo
    expect(comuni.length).toBeGreaterThan(50)
    for (const c of comuni) {
      expect(Object.keys(c).sort()).toEqual(['attivo', 'belfiore', 'nome', 'sigla'])
    }
  })

  it('risoluzione di un singolo Belfiore: stessa regola, altra strada', async () => {
    // `proietta` è chiamata da DUE punti: se un giorno solo uno dei due la usasse,
    // il test qui sopra resterebbe verde e questa strada perderebbe la protezione.
    const GETarricchito = await routeConDatasetPiuRicco()
    const res = await GETarricchito(req('?belfiore=H501'))
    const testo = await res.text()
    expect(testo).not.toContain('notaInterna')
    expect(JSON.parse(testo)).toEqual({
      comuni: [{ belfiore: 'H501', nome: 'ROMA', sigla: 'RM', attivo: true }],
    })
  })
})

/**
 * ─── IL PESO ───────────────────────────────────────────────────────────────────
 * Misure del 2026-08-10 (dataset committato, fonte ferma al ~2022):
 *   NA attivi 6.305 B · NA con soppressi 9.683 B
 *   TO attivi 21.063 B · TO con soppressi 32.727 B (484 denominazioni: il caso peggiore)
 *   EE attivi 18.822 B
 * Il dataset INTERO pesa ~294 KB: la risposta più grossa è un nono di quello, e non
 * viaggia mai per intero verso il browser.
 */
describe('GET /api/anagrafiche/comuni — la risposta pesa quanto ci si aspetta', () => {
  it('NA: ~6,3 KB solo attivi, ~9,7 KB con i soppressi', async () => {
    const attivi = await pesoDi(await GET(req('?provincia=NA')))
    const conStorici = await pesoDi(await GET(req('?provincia=NA&includiSoppressi')))
    expect(attivi).toBeGreaterThan(3_000)
    expect(attivi).toBeLessThan(13_000)
    expect(conStorici).toBeGreaterThan(4_800)
    expect(conStorici).toBeLessThan(20_000)
  })

  it('TO (484 denominazioni, il caso peggiore): ~21 KB solo attivi, ~33 KB con i soppressi', async () => {
    const attivi = await GET(req('?provincia=TO'))
    const conStorici = await GET(req('?provincia=TO&includiSoppressi'))

    const nAttivi = (((await attivi.clone().json()) as Corpo).comuni ?? []).length
    const nTutti = (((await conStorici.clone().json()) as Corpo).comuni ?? []).length
    expect(nAttivi).toBe(312)
    expect(nTutti).toBe(484)

    const pAttivi = await pesoDi(attivi)
    const pTutti = await pesoDi(conStorici)
    expect(pAttivi).toBeGreaterThan(10_000)
    expect(pAttivi).toBeLessThan(43_000)
    expect(pTutti).toBeGreaterThan(16_000)
    expect(pTutti).toBeLessThan(66_000)
  })

  it('nessuna risposta si avvicina al dataset intero (~294 KB): il filtro c’è davvero', async () => {
    // Il controllo che conta: se un giorno il filtro per provincia saltasse, la
    // risposta più grande sarebbe di colpo dieci volte tanto e questo test cadrebbe.
    const massimo = Math.max(
      await pesoDi(await GET(req('?provincia=TO&includiSoppressi'))),
      await pesoDi(await GET(req('?provincia=EE&includiSoppressi'))),
      await pesoDi(await GET(req('?provincia=RM&includiSoppressi'))),
    )
    expect(massimo).toBeLessThan(80_000)
  })
})
