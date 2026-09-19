import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * IL TERZO `throw` DI `parentIdsCheHannoRisposto`: il TETTO DI PAGINE.
 *
 * ─── PERCHÉ ESISTE QUESTO FILE, E PERCHÉ È UN FILE A PARTE ──────────────────
 *
 * La lettura di «chi ha già risposto» ha tre punti d'uscita, e due erano già
 * pinnati (`__tests__/lib/avvisi-promemoria-query.test.ts` per la seconda pagina,
 * `__tests__/api/avvisi-promemoria-adesioni.test.ts` per la pagina vuota col
 * totale ancora alto). Il terzo — il `for` che esce senza aver coperto il totale —
 * era dichiarato scoperto dalla docstring del modulo, con questa motivazione:
 *
 *     «Per esercitarlo servono 20.000 righe di finto».
 *
 * 🔴 NON ERA VERO, E UN DEBITO SPIEGATO CON UN FATTO FALSO È PEGGIO DI UN DEBITO
 * TACIUTO: chiude la discussione invece di aprirla, perché chi legge smette di
 * cercare. I due numeri non sono cablati dentro `promemoria-adesioni.ts`, sono
 * **importati** da `@/lib/avvisi/statistiche` — e un import si sostituisce. Con
 * `MAX_PAGINE: 2` e `RIGHE_PER_PAGINA: 2` il tetto si tocca con CINQUE righe.
 *
 * Sta in un file suo, e non dentro `avvisi-promemoria-adesioni.test.ts`, per una
 * ragione meccanica: `vi.mock` di un modulo vale per l'intero file di test, e lì
 * dentro girano scenari che si appoggiano alle costanti VERE. Un mock globale
 * cambierebbe di nascosto il significato di dodici altri `it`.
 *
 * ─── PERCHÉ LANCIA INVECE DI DEGRADARE ──────────────────────────────────────
 *
 * Una pagina persa qui non produce un numero più basso: produce un SOLLECITO
 * SPEDITO A CHI HA GIÀ ADERITO. Non è un dato mancante, è un dato falso mandato a
 * una famiglia — e una famiglia che riceve ogni notte un promemoria a cui ha già
 * risposto impara a spegnere le notifiche della scuola. Meglio una scansione che
 * si dichiara caduta (500, battito `giro-incompleto`) di una che manda messaggi
 * sbagliati dichiarando «ok».
 *
 * ─── LA PROVA DI ROTTURA, ESEGUITA ──────────────────────────────────────────
 *
 * Un lock mai visto fallire non è un lock. Provata il 2026-09-19: sostituito il
 * `throw` finale di `parentIdsCheHannoRisposto` con `return out` → il primo `it`
 * diventa ROSSO, e il messaggio è esattamente il danno:
 *
 *     promise resolved "{ inviati: 1, saltata: false }" instead of rejecting
 *
 * Quell'`1` è `p-4`, che aveva risposto alla QUINTA riga — l'unica che il tetto
 * di due pagine da due righe taglia via. Ripristinato il `throw` → verde.
 *
 * ⚠️ E IL NUMERO NON ERA 1 PER CASO: fino al 2026-09-19 i destinatari erano i tre
 * del `beforeEach` (`p-0`, `p-1`, `p-2`), tutti dentro le quattro righe che le due
 * pagine coprono, e la stessa rottura produceva `inviati: 0`. La fixture adesso
 * mette un destinatario SULLA riga persa (`p-4`), e ciò che ha comprato è **il
 * MESSAGGIO di fallimento**. I due, misurati il 2026-09-19:
 *
 *   vecchia:  promise resolved "{ inviati: +0, saltata: false }" instead of rejecting
 *   nuova:    promise resolved "{ inviati: 1,  saltata: false }" instead of rejecting
 *
 * Quell'`1` NOMINA il danno — un sollecito spedito a chi aveva già risposto —
 * dove il `+0` si leggeva come innocuo. Un lock che cade dicendo *che cosa* si è
 * rotto vale più di uno che cade e basta.
 *
 * 🔴 CIÒ CHE LA FIXTURE **NON** HA COMPRATO, e che va scritto qui perché la
 * tentazione è di dire il contrario: l'asserzione che diventa rossa è il
 * `rejects.toThrow(…)`, e lo era **anche con la fixture vecchia** — si vede dalle
 * due righe qui sopra, che sono entrambe un fallimento. `rejects` su una promise
 * che RISOLVE fallisce qualunque sia il valore risolto: il valore cambia il
 * messaggio, non il colore. E siccome un `rejects` fallito INTERROMPE l'`it`
 * (verificato: la riga successiva non viene eseguita), la riga
 * `expect(trigger.notificaEvento).not.toHaveBeenCalled()` col codice rotto non
 * viene mai raggiunta: resta decorativa, con la fixture nuova esattamente come con
 * quella vecchia. Scriverla «portante» grazie a `p-4` sarebbe sostituire
 * un'affermazione falsa con un'altra — che è il modo in cui la motivazione
 * «servono 20.000 righe di finto» è sopravvissuta fin qui.
 *
 * Il secondo `it` è il controllo positivo: con quattro righe, che il tetto copre,
 * NON si lancia — senza di lui questo file sarebbe verde anche se
 * `parentIdsCheHannoRisposto` lanciasse sempre.
 */

// I due numeri arrivano da qui, e sono l'unica ragione per cui il tetto è
// raggiungibile in un test: 2 pagine da 2 righe coprono 4 righe, non 5.
vi.mock('@/lib/avvisi/statistiche', () => ({ MAX_PAGINE: 2, RIGHE_PER_PAGINA: 2 }))

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

/**
 * ⚠️ LA SPIA PRENDE LA FIRMA VERA, PER RIFERIMENTO — non una copia.
 *
 * Un `vi.fn(async () => undefined)` non dichiara argomenti: TypeScript deduce
 * `mock.calls` come tupla VUOTA, e `calls[0][1]` non esiste nemmeno come
 * possibilità — `tsc --noEmit` cade con TS2493 anche se a runtime il valore c'è.
 * L'`?.` non serve a niente lì: il problema non è il `undefined`, è il TIPO.
 *
 * La via corta sarebbe un `as any` sul payload, e spegnerebbe il controllo
 * proprio sul campo che questo file verifica: `utenteIds` e `corpo` smetterebbero
 * di essere confrontati con una forma, e un refuso in un nome di chiave
 * passerebbe inosservato.
 *
 * 🔴 MA LA VIA MEDIA — RISCRIVERE LA FIRMA A MANO — NON È PIÙ SICURA: è la stessa
 * cosa di un numero copiato, e diverge nello stesso modo. Fino al 2026-09-19 qui
 * stava un `type PayloadNotifica` battuto a mano, e già divergeva da
 * `NotificaEventoParams`: **mancava `titolo`** (che nel tipo vero è OBBLIGATORIO,
 * e che il codice sotto prova manda davvero), e `utenteIds`/`corpo` erano
 * dichiarati obbligatori mentre nel tipo vero sono opzionali. Un duplicato così
 * non protegge dal refuso: lo *autorizza*, perché il compilatore confronta il
 * payload con la copia e non con l'originale. `typeof import(…)` invece segue il
 * modulo: il giorno in cui `notificaEvento` cambia forma, questo file lo sa.
 */
const trigger = vi.hoisted(() => ({
  notificaEvento: vi.fn<typeof import('@/lib/notifiche/triggers').notificaEvento>(async () => undefined),
}))
vi.mock('@/lib/notifiche/triggers', () => trigger)

const destinatari = vi.hoisted(() => ({
  genitoriDiAlunni: vi.fn(async () => [] as string[]),
  genitoriDiClassi: vi.fn(async () => [] as string[]),
  genitoriDiScuola: vi.fn(async () => [] as string[]),
  staffScuola: vi.fn(async () => [] as string[]),
}))
vi.mock('@/lib/notifiche/destinatari', () => destinatari)

import { promemoriaAdesioni } from '@/lib/avvisi/promemoria-adesioni'

const SEDE = '11111111-1111-1111-1111-11111111000a'
const AVVISO = '22222222-2222-2222-2222-222222222221'
const ADESSO = '2026-09-21T07:00:00.000Z'
/** Le 18:00 italiane di due giorni dopo: dentro la finestra della sede (3 giorni). */
const SCADENZA = '2026-09-23T16:00:00.000Z'

/** Le pagine chieste a `avvisi_risposte`, in ordine: la prova che il ciclo ha girato. */
let pagine: Array<[number, number]> = []

/**
 * Un finto client minimo. NON filtra: qui non si prova il filtro (ha i suoi test),
 * si prova che cosa succede quando il `count` del server resta più alto di quanto
 * le pagine coprano — che è esattamente ciò che PostgREST fa con `db-max-rows`.
 */
function client(risposte: Array<{ parent_id: string }>) {
  const righe: Record<string, Array<Record<string, unknown>>> = {
    admin_settings: [{ scuola_id: SEDE, avvisi_config: { promemoria_giorni_prima: 3 } }],
    avvisi: [{
      id: AVVISO,
      titolo: 'Gita al museo',
      scuola_id: SEDE,
      target_scope: 'globale',
      target_classes: null,
      scadenza_adesione: SCADENZA,
    }],
    notifiche: [],
  }

  return {
    from(tabella: string) {
      const b: Record<string, unknown> = {}
      let conConteggio = false
      b.select = (_c?: string, o?: { count?: string }) => { if (o?.count) conConteggio = true; return b }
      for (const m of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'order', 'limit']) {
        b[m] = () => b
      }
      b.range = async (da: number, a: number) => {
        pagine.push([da, a])
        return {
          data: risposte.slice(da, a + 1),
          // `count: 'exact'` è il totale VERO lato server, indipendente da quante
          // righe la pagina restituisce: è il numero che fa girare il ciclo.
          count: conConteggio ? risposte.length : null,
          error: null,
        }
      }
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve({ data: righe[tabella] ?? [], count: null, error: null }).then(ok, ko)
      return b
    },
  }
}

function risposteDi(n: number): Array<{ parent_id: string }> {
  return Array.from({ length: n }, (_, i) => ({ parent_id: `p-${i}` }))
}

beforeEach(() => {
  vi.clearAllMocks()
  pagine = []
  destinatari.genitoriDiScuola.mockResolvedValue(['p-0', 'p-1', 'p-2'])
})

describe('promemoriaAdesioni — il tetto di `MAX_PAGINE` non si supera in silenzio', () => {
  it('🔑 cinque risposte con 2 pagine da 2 righe → la scansione LANCIA, e nessuno viene sollecitato', async () => {
    // 🔑 `p-4` HA RISPOSTO ALLA QUINTA RIGA — quella che il tetto taglia via.
    // Non serve a rendere «portante» l'ultima asserzione di questo `it`, e sarebbe
    // falso dirlo: l'asserzione che cade è il `rejects.toThrow` qui sotto, che era
    // rosso anche con i tre destinatari del `beforeEach` (`inviati: 0` è comunque
    // un `resolve` dove si attende un `reject`), e un `rejects` fallito interrompe
    // l'`it` — quindi col codice rotto alla riga `not.toHaveBeenCalled()` non ci si
    // arriva nemmeno. Serve invece a far NOMINARE IL DANNO al messaggio di
    // fallimento: rompendo il `throw` si legge `inviati: 1`, cioè un sollecito a
    // chi aveva già risposto, invece di un innocuo `inviati: 0`.
    destinatari.genitoriDiScuola.mockResolvedValue(['p-0', 'p-1', 'p-4'])
    const supabase = client(risposteDi(5)) as never

    await expect(promemoriaAdesioni(supabase, ADESSO)).rejects.toThrow(/troncata al tetto di 2 pagine/)

    // Le due pagine sono state chieste davvero: senza questa riga il test sarebbe
    // verde anche se il ciclo non fosse mai partito (per esempio perché l'avviso
    // non entrava in finestra), cioè misurerebbe il finto invece del codice.
    expect(pagine).toEqual([[0, 1], [2, 3]])
    // E la prova che conta: un insieme INCOMPLETO non è diventato un elenco di
    // destinatari. `p-4` ha risposto e non deve ricevere niente.
    expect(trigger.notificaEvento).not.toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO: quattro risposte — che il tetto copre — non lanciano', async () => {
    // Senza questo `it`, il precedente sarebbe verde anche con un
    // `parentIdsCheHannoRisposto` che lancia SEMPRE: «l'eccezione c'è» e «l'eccezione
    // c'è al punto giusto» hanno lo stesso colore.
    const supabase = client(risposteDi(4)) as never

    const esito = await promemoriaAdesioni(supabase, ADESSO)

    expect(esito.saltata).toBe(false)
    expect(pagine).toEqual([[0, 1], [2, 3]])
    // I tre destinatari hanno tutti risposto (p-0, p-1, p-2 sono fra le quattro
    // righe lette): nessun sollecito, e per la ragione giusta.
    expect(esito.inviati).toBe(0)
    expect(trigger.notificaEvento).not.toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO: chi NON ha risposto riceve (il ciclo non sta solo svuotando l’elenco)', async () => {
    // Tre righe lette su tre, e un quarto genitore che non c'è dentro: se questa
    // asserzione non ci fosse, «zero invii» qui sopra potrebbe voler dire «la
    // scansione non manda mai niente» invece di «ha guardato e non serviva».
    destinatari.genitoriDiScuola.mockResolvedValue(['p-0', 'p-1', 'p-2', 'p-nuovo'])
    const supabase = client(risposteDi(3)) as never

    const esito = await promemoriaAdesioni(supabase, ADESSO)

    expect(esito.inviati).toBe(1)
    const payload = trigger.notificaEvento.mock.calls[0][1]
    expect(payload.utenteIds).toEqual(['p-nuovo'])
    expect(payload.corpo).toBe('Mancano 2 giorni per aderire a «Gita al museo».')
  })
})
