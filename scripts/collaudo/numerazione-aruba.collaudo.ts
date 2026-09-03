import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { arubaSignin, arubaUltimiNumeriFattura } from '@/lib/aruba/client'

/**
 * IL PROGRESSIVO LETTO DA ARUBA, COL CODICE VERO E CONTRO L'API VERA. Sola lettura.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────────────
 * Il 2026-09-02 un'emissione si è fermata su «Impossibile leggere l'ultimo numero della
 * serie FPR». La causa: `findByUsername` restituisce DOCUMENTI, e il numero della fattura
 * sta nell'array `invoices` annidato dentro ciascuno — non su `.number` dell'involucro,
 * che è dove il codice lo cercava. Su 3.311 documenti del 2026 il valore era `undefined`
 * su tutti e 3.311.
 *
 * La correzione ha un test unitario (`__tests__/lib/aruba/numerazione-sezionale.test.ts`)
 * costruito sulla forma misurata. Ma un test unitario prova che il codice legge la fixture
 * che gli abbiamo scritto noi — ed è esattamente l'errore che ha causato il guasto: i mock
 * precedenti assumevano la forma che avrebbero dovuto dimostrare, e sono rimasti verdi
 * mentre in produzione non si leggeva niente. Questo collaudo chiude quel cerchio: chiama
 * la funzione DI PRODUZIONE contro l'API DI PRODUZIONE.
 *
 * ─── COSA NON FA ────────────────────────────────────────────────────────────────────
 * Non emette, non carica, non scrive: `findByUsername` è una GET. Non stampa nessun dato
 * personale — i documenti contengono `receiver.fiscalCode` di genitori reali, e qui esce
 * solo un intero per serie.
 *
 * ─── QUANTO COSTA, E PERCHÉ IL 2026-09-02 NON BASTÒ ─────────────────────────────────
 * La prima esecuzione prese `429`, e NON alla prima chiamata: `signin` passò, l'intero
 * scorrimento di «Asilo» passò, e il muro arrivò sulla prima pagina di «FPR» — otto
 * richieste accettate in **4,2 secondi**, la nona no. Due cose si impararono:
 *
 *  · il limite di Aruba punisce la FREQUENZA, non un monte-ore. «~60 richieste all'ora»
 *    non spiega otto chiamate accettate in quattro secondi e la nona rifiutata;
 *  · leggere le due serie separatamente scaricava **due volte le stesse pagine**, perché
 *    la richiesta a `findByUsername` non contiene il sezionale. Metà del costo era un
 *    duplicato esatto, ed è la metà che prese il `429`.
 *
 * Ora si usa `arubaUltimiNumeriFattura`, che scorre UNA volta sola per entrambe le
 * serie e mette una pausa fra una pagina e l'altra. Costo: **1 signin + 7 GET** su
 * 3.311 documenti, invece di 1 + 14.
 *
 * ESECUZIONE — come PRIMA cosa della sessione, senza altre chiamate ad Aruba prima.
 *
 *   COLLAUDO_REALE=1 npx vitest run --config vitest.collaudo.config.ts \
 *     scripts/collaudo/numerazione-aruba.collaudo.ts
 *
 * ⚠️ Il nome del file NON è pleonastico. L'`include` della configurazione è
 * `scripts/collaudo/**\/*.collaudo.ts`, quindi il comando senza argomento tira dentro
 * anche `fattura-reale.collaudo.ts` — che non chiama Aruba (solo `SELECT` e generazione
 * in memoria, verificato), ma attraversa l'anagrafica di PRODUZIONE e pretende una
 * `SUPABASE_SERVICE_ROLE_KEY` valida. Sono due collaudi diversi con due prerequisiti
 * diversi: qui ne serve uno solo, e questa è l'unica chiamata ad Aruba che si vuole
 * spendere.
 */

function envLocale(nome: string): string {
  const diretta = process.env[nome]
  if (diretta) return diretta
  try {
    const testo = readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
    const m = testo.match(new RegExp(`^\\s*${nome}\\s*=\\s*(.*)$`, 'm'))
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}

const ATTIVO = process.env.COLLAUDO_REALE === '1'
const USERNAME = envLocale('ARUBA_USERNAME')
const PASSWORD = envLocale('ARUBA_PASSWORD')

describe.skipIf(!ATTIVO || !USERNAME || !PASSWORD)('numerazione Aruba — il codice vero, l\'API vera', () => {
  it('legge un progressivo PLAUSIBILE per entrambe le serie, e non zero', async () => {
    const anno = new Date().getFullYear()
    const { accessToken } = await arubaSignin('production', { username: USERNAME, password: PASSWORD })

    // UNA lettura per entrambe le serie. Il 2026-09-02 erano due, e la seconda
    // richiedeva ad Aruba le stesse identiche pagine della prima.
    const massimi = await arubaUltimiNumeriFattura('production', accessToken, {
      username: USERNAME, anno, sezionali: ['Asilo', 'FPR'],
    })
    const asilo = massimi.get('Asilo') ?? 0
    const fpr = massimi.get('FPR') ?? 0

    // ⚠️ `process.stdout.write` E NON `console.log`. Non è un vezzo: **vitest intercetta
    // `console.*` e in questa configurazione lo INGHIOTTE**, mentre lascia passare la
    // scrittura diretta. Misurato il 2026-09-03 con un file di prova che stampava le due
    // cose una accanto all'altra: usciva solo la seconda.
    //
    // È costato DUE letture contro l'API vera, entrambe «passate» e entrambe mute. La
    // prima volta la colpa fu data a un `| grep` nel comando; la seconda è stata catturata
    // su file, senza nessun filtro, ed erano assenti lo stesso. La spiegazione comoda era
    // sbagliata, e ha fatto spendere un secondo secchio per riscoprire la stessa cosa.
    //
    // Qui un valore non stampato è un valore PERSO: esiste solo durante la chiamata, e
    // rivederlo costa un'altra finestra da un'ora.
    //
    // Si stampa PRIMA di asserire, per la stessa ragione: il 2026-09-02 le due righe
    // stavano dopo entrambe le letture, la seconda lanciò, e il numero della prima — già
    // pagato in richieste — andò perso.
    //
    // Solo numeri: nessun nome, nessun codice fiscale.
    process.stdout.write(`\n  Asilo ${anno}: ultimo numero letto = ${asilo}\n`)
    process.stdout.write(`  FPR   ${anno}: ultimo numero letto = ${fpr}\n\n`)

    // ZERO è il valore che il difetto produceva quando la guardia non c'era, ed è il
    // valore che farebbe emettere «FPR 1/26» su una serie da millenovecento documenti.
    // Su serie vive da anni non è un numero plausibile: è il sintomo.
    expect(asilo, 'la serie Asilo esiste da anni: uno zero qui è il difetto, non un dato').toBeGreaterThan(1000)
    expect(fpr, 'idem per FPR').toBeGreaterThan(1000)

    // E non devono essere lo STESSO numero: fino al 2026-08-09 il parser mescolava le
    // due serie in un mucchio solo, ed è il difetto che produce una collisione fiscale.
    expect(asilo).not.toBe(fpr)
  })
})
