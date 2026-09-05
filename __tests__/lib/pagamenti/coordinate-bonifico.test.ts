// @vitest-environment node
/**
 * `coordinateBonificoSede` — UN motore solo per «dove mando i soldi e a chi».
 *
 * Le stesse due righe (IBAN e intestatario) compaiono in due posti che oggi non
 * si parlano: il riquadro «Dati per il bonifico» delle email di sollecito e —
 * da adesso — la card «Come pagare» del genitore. Due letture separate della
 * stessa configurazione divergono al primo cambio, e la divergenza si vede solo
 * quando una famiglia manda i soldi all'IBAN che la pagina mostrava e l'email
 * no.
 *
 * ⚠️ UN IBAN SBAGLIATO NON SI MOSTRA MAI: `ibanLeggibile` verifica le cifre di
 * controllo (mod 97) e restituisce `null` se non tornano. Mostrarne uno
 * sbagliato è peggio che ometterlo — l'errore lo scopre la famiglia dopo aver
 * pagato.
 *
 * Il finto client APPLICA i filtri (`__tests__/fixtures/finto-supabase.ts`):
 * chiedere le coordinate della sede A e ricevere quelle della sede B qui è un
 * test ROSSO, non un dettaglio che passa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Il logger vero, con la sola `logEvento` sostituita: `descriviErrore`, la
// redazione e la politica dei livelli restano quelle di produzione, e ciò che si
// misura qui sono le CHIAMATE — evento, livello, campi — non il testo della riga.
const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})

import { creaFintoSupabase, type DBFinto } from '../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'
import { coordinateBonificoSede } from '@/lib/pagamenti/coordinate-bonifico'
// La redazione VERA, non mockata: è lei a decidere cosa di queste righe si legge
// davvero in `app_log`, ed è l'unica misura che valga.
import { redact } from '@/lib/logging/redact'

// IBAN SINTETICO: è l'esempio pubblico della Banca d'Italia, non è di nessuno.
const IBAN_OK = 'IT60X0542811101000000123456'
const IBAN_LEGGIBILE = 'IT60 X054 2811 1010 0000 0123 456'
// Una cifra sola cambiata: la forma è giusta, il mod 97 no.
const IBAN_STORTO = 'IT60X0542811101000000123457'

const ctx = { operazione: 'test:coordinate-bonifico' }

function db(righe: Record<string, unknown>[]): DBFinto {
  return { admin_settings: righe }
}

/** Le chiamate a `logEvento` del gruppo `fiscale`, filtrabili per `esito`. */
type ChiamataLog = [string, string, Record<string, unknown>]
function righe(esito?: string): ChiamataLog[] {
  return (h.logEvento.mock.calls as ChiamataLog[])
    .filter((c) => c[0] === 'fiscale')
    .filter((c) => esito === undefined || c[2]?.esito === esito)
}

beforeEach(() => vi.clearAllMocks())

describe('coordinateBonificoSede — IBAN e intestatario, dalla stessa sorgente', () => {
  it('IBAN valido → a gruppi di quattro; denominazione da `fiscale_config`', async () => {
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: 'Scuola La Favola soc. coop.', iban: IBAN_OK }, aruba_config: {} }]),
    )
    const out = await coordinateBonificoSede(supabase, SEDE_A, ctx)
    expect(out).toEqual({
      scuola_id: SEDE_A,
      iban: IBAN_LEGGIBILE,
      intestatario: 'Scuola La Favola soc. coop.',
    })
  })

  it('IBAN con spazi e minuscole in configurazione → esce normalizzato', async () => {
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: 'Coop', iban: ' it60 x054 2811 1010 0000 0123 456 ' }, aruba_config: {} }]),
    )
    expect((await coordinateBonificoSede(supabase, SEDE_A, ctx)).iban).toBe(IBAN_LEGGIBILE)
  })

  it('IBAN con una cifra sbagliata → `null`, mai a schermo', async () => {
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: 'Coop', iban: IBAN_STORTO }, aruba_config: {} }]),
    )
    expect((await coordinateBonificoSede(supabase, SEDE_A, ctx)).iban).toBeNull()
  })

  it('IBAN assente → `null` (non è un errore: nessuno l’ha ancora compilato)', async () => {
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: 'Coop' }, aruba_config: {} }]),
    )
    const out = await coordinateBonificoSede(supabase, SEDE_A, ctx)
    expect(out.iban).toBeNull()
    expect(out.intestatario).toBe('Coop')
  })

  it('denominazione vuota → ripiego su `aruba_config.fiscal.ragione_sociale`', async () => {
    const supabase = creaFintoSupabase(
      db([{
        scuola_id: SEDE_A,
        fiscale_config: { denominazione: '', iban: IBAN_OK },
        aruba_config: { fiscal: { ragione_sociale: 'La Favola societa cooperativa', piva: '01234567890' } },
      }]),
    )
    expect((await coordinateBonificoSede(supabase, SEDE_A, ctx)).intestatario).toBe('La Favola societa cooperativa')
  })

  it('denominazione con spazi attorno → trimmata', async () => {
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: '  Coop La Favola  ' }, aruba_config: {} }]),
    )
    expect((await coordinateBonificoSede(supabase, SEDE_A, ctx)).intestatario).toBe('Coop La Favola')
  })

  it('entrambe le sorgenti vuote → intestatario `null` (mai la stringa vuota)', async () => {
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: '   ' }, aruba_config: { fiscal: {} } }]),
    )
    expect((await coordinateBonificoSede(supabase, SEDE_A, ctx)).intestatario).toBeNull()
  })

  it('sede senza riga di impostazioni → tutto `null`, e non lancia', async () => {
    const supabase = creaFintoSupabase(db([]))
    expect(await coordinateBonificoSede(supabase, SEDE_A, ctx)).toEqual({
      scuola_id: SEDE_A, iban: null, intestatario: null,
    })
  })

  it('la configurazione illeggibile degrada a «nessuna coordinata», non lancia', async () => {
    // PostgREST non lancia: ritorna `{ error }`. `getModuleConfig` lo registra e
    // restituisce `{}` — qui si verifica che il degrado arrivi fino in fondo.
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: 'Coop', iban: IBAN_OK } }]),
      [],
      { errori: { admin_settings: { code: '42703', message: 'column does not exist' } } },
    )
    expect(await coordinateBonificoSede(supabase, SEDE_A, ctx)).toEqual({
      scuola_id: SEDE_A, iban: null, intestatario: null,
    })
  })

  it('le coordinate sono DELLA SEDE CHIESTA (due sedi, due conti)', async () => {
    // Il conto è uno solo per la cooperativa, ma la configurazione è PER SEDE:
    // il codice non può darlo per scontato. Se questa asserzione fosse verde con
    // le coordinate dell'altra sede, l'intero motore non starebbe filtrando.
    const supabase = creaFintoSupabase(
      db([
        { scuola_id: SEDE_A, fiscale_config: { denominazione: 'Sede Alfa', iban: IBAN_OK }, aruba_config: {} },
        { scuola_id: SEDE_B, fiscale_config: { denominazione: 'Sede Beta', iban: IBAN_STORTO }, aruba_config: {} },
      ]),
    )
    expect(await coordinateBonificoSede(supabase, SEDE_B, ctx)).toEqual({
      scuola_id: SEDE_B, iban: null, intestatario: 'Sede Beta',
    })
    expect(await coordinateBonificoSede(supabase, SEDE_A, ctx)).toEqual({
      scuola_id: SEDE_A, iban: IBAN_LEGGIBILE, intestatario: 'Sede Alfa',
    })
  })
})

// =============================================================================
// L'ASSENZA DELL'IBAN NON PUÒ ESSERE SILENZIOSA (collaudo 2026-09-05, rilievo a)
//
// Il motore restituiva `null` in tre casi diversi senza scrivere una riga: IBAN
// mai compilato, IBAN compilato ma con le cifre di controllo sbagliate,
// configurazione non leggibile. A schermo escono tutti e tre uguali — «chiedile
// in segreteria» — e in produzione l'IBAN c'è su UNA sede su tre: cioè due
// famiglie su tre leggono il ripiego e nessuno, dentro l'azienda, ha modo di
// saperlo.
//
// I tre casi non pesano uguale, e per questo non hanno lo stesso livello:
//  · IBAN assente     → `warn`: nessuno l'ha ancora compilato. Da fare, non rotto.
//  · IBAN SBAGLIATO   → `error`: qualcuno l'ha scritto credendo di aver finito, e
//                       il prodotto lo sta scartando in silenzio.
//  · lettura fallita  → `warn`: guasto di lettura, il prodotto degrada da solo.
//
// ⚠️ IL VALORE DELL'IBAN NON ENTRA NEI LOG, mai — nemmeno quello sbagliato: è una
// coordinata bancaria della cooperativa. Ne esce la LUNGHEZZA, che è ciò che
// distingue «due cifre in più» da «campo riempito a caso».
// =============================================================================
describe('coordinateBonificoSede — il vuoto si vede nei log, e i tre vuoti sono diversi', () => {
  it('IBAN mai compilato → `warn` iban-non-configurato con la sede', async () => {
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: 'Coop', piva: '01234567890' }, aruba_config: {} }]),
    )
    await coordinateBonificoSede(supabase, SEDE_A, ctx)
    expect(h.logEvento).toHaveBeenCalledWith(
      'fiscale',
      'warn',
      expect.objectContaining({
        operazione: ctx.operazione,
        esito: 'iban-non-configurato',
        scuola_id: SEDE_A,
      }),
    )
  })

  it('IBAN con una cifra sbagliata → `error` iban-non-valido, con la LUNGHEZZA e mai il valore', async () => {
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: 'Coop', piva: '01234567890', iban: IBAN_STORTO }, aruba_config: {} }]),
    )
    await coordinateBonificoSede(supabase, SEDE_A, ctx)
    const riga = righe('iban-non-valido')
    expect(riga).toHaveLength(1)
    expect(riga[0][1]).toBe('error')
    expect(riga[0][2]).toMatchObject({
      operazione: ctx.operazione,
      esito: 'iban-non-valido',
      scuola_id: SEDE_A,
      lunghezza: IBAN_STORTO.length,
    })
    // Nessuna traccia del numero: né intero, né a pezzi.
    const tutto = JSON.stringify(h.logEvento.mock.calls)
    expect(tutto).not.toContain(IBAN_STORTO)
    expect(tutto).not.toContain('0542811101')
  })

  it('la lunghezza è quella delle CIFRE, non degli spazi con cui è stato digitato', async () => {
    // `IT60 X054 …` scritto a gruppi di quattro sono 33 caratteri, ma le cifre
    // restano 27. La lunghezza serve a rispondere «gliene manca una o ne ha una
    // di troppo?»: contando gli spazi non risponderebbe a niente.
    const conSpazi = IBAN_STORTO.replace(/(.{4})/g, '$1 ').trim()
    expect(conSpazi.length).not.toBe(IBAN_STORTO.length)
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: 'Coop', piva: '01234567890', iban: conSpazi }, aruba_config: {} }]),
    )
    await coordinateBonificoSede(supabase, SEDE_A, ctx)
    expect(righe('iban-non-valido')[0][2]).toMatchObject({ lunghezza: IBAN_STORTO.length })
  })

  it('IBAN valido e struttura completa → NESSUNA riga (il rumore spegne l’allarme)', async () => {
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: 'Coop', piva: '01234567890', iban: IBAN_OK }, aruba_config: {} }]),
    )
    await coordinateBonificoSede(supabase, SEDE_A, ctx)
    expect(righe()).toEqual([])
  })

  it('configurazione illeggibile → `warn` coordinate-non-leggibili, e NIENTE riga sull’IBAN', async () => {
    // Se la config non si è letta, «l'IBAN non è configurato» è una deduzione
    // falsa: non lo sappiamo. Dedurla manderebbe la segreteria a compilare un
    // campo che potrebbe essere già compilato.
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: 'Coop', iban: IBAN_OK } }]),
      [],
      { errori: { admin_settings: { code: '42703', message: 'column does not exist' } } },
    )
    const out = await coordinateBonificoSede(supabase, SEDE_A, ctx)
    expect(out).toEqual({ scuola_id: SEDE_A, iban: null, intestatario: null })
    const riga = righe('coordinate-non-leggibili')
    expect(riga).toHaveLength(1)
    expect(riga[0][1]).toBe('warn')
    expect(riga[0][2]).toMatchObject({ operazione: ctx.operazione, scuola_id: SEDE_A })
    expect(righe('iban-non-configurato')).toEqual([])
    expect(righe('iban-non-valido')).toEqual([])
    expect(righe('dati-struttura-mancanti')).toEqual([])
  })

  // ─── LA LETTURA INFORMATIVA DEL GENITORE NON È UN'EMISSIONE (rilievo b) ─────
  // `datiStruttura` alza un `error` quando mancano denominazione o P.IVA, ed è
  // giusto per chi EMETTE un documento: quel documento esce anonimo. Qui invece
  // si compone una riga informativa che il genitore legge a ogni apertura della
  // pagina, anche per sedi che in `admin_settings` la riga non ce l'hanno nemmeno
  // (Demo, E2E). Un `error` al giorno per sede su un percorso che degrada
  // benissimo non è un allarme: è ciò che insegna a ignorare gli allarmi.
  it('struttura incompleta → la riga esce a livello `info`, non `error`', async () => {
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { iban: IBAN_OK }, aruba_config: {} }]),
    )
    await coordinateBonificoSede(supabase, SEDE_A, ctx)
    const riga = righe('dati-struttura-mancanti')
    expect(riga).toHaveLength(1)
    expect(riga[0][1]).toBe('info')
    expect(riga[0][2]).toMatchObject({ operazione: ctx.operazione, scuola_id: SEDE_A })
    // E in tutta l'esecuzione non deve esserci NESSUN `error`: l'IBAN c'è ed è valido.
    expect(righe().filter((r) => r[1] === 'error')).toEqual([])
  })

  it('sede senza riga di impostazioni → nessun `error`, e l’IBAN mancante lo dice comunque', async () => {
    const supabase = creaFintoSupabase(db([]))
    await coordinateBonificoSede(supabase, SEDE_A, ctx)
    expect(righe().filter((r) => r[1] === 'error')).toEqual([])
    expect(righe('iban-non-configurato')).toHaveLength(1)
  })

  // ⚠️ UNA RIGA CHE ESCE REDATTA È UNA RIGA CHE NON RISPONDE. `redact()` è a
  // lista bianca PER CHIAVE: un campo fuori lista diventa `[redatto:str/13]`, e
  // in tabella non si distinguerebbe più QUALE configurazione non si è letta.
  // Qui si passano i campi veri alla redazione vera, non a un'idea di come
  // dovrebbe comportarsi.
  it('i campi della riga sopravvivono alla redazione (altrimenti non dicono niente)', async () => {
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: 'Coop', iban: IBAN_OK } }]),
      [],
      { errori: { admin_settings: { code: '42703', message: 'column does not exist' } } },
    )
    await coordinateBonificoSede(supabase, SEDE_A, ctx)
    const redatti = redact(righe('coordinate-non-leggibili')[0][2]) as Record<string, unknown>
    expect(redatti.esito).toBe('coordinate-non-leggibili')
    expect(redatti.operazione).toBe(ctx.operazione)
    expect(redatti.scuola_id).toBe(SEDE_A)
    // Quale delle due configurazioni è caduta: qui sono entrambe (la tabella è
    // una sola e l'errore è iniettato su di lei).
    expect(redatti.tipo).toBe('fiscale_config+aruba_config')
  })

  it('anche la lunghezza dell’IBAN sopravvive: è un numero, e i numeri non si redigono', async () => {
    const supabase = creaFintoSupabase(
      db([{ scuola_id: SEDE_A, fiscale_config: { denominazione: 'Coop', piva: '01234567890', iban: IBAN_STORTO }, aruba_config: {} }]),
    )
    await coordinateBonificoSede(supabase, SEDE_A, ctx)
    const redatti = redact(righe('iban-non-valido')[0][2]) as Record<string, unknown>
    expect(redatti.lunghezza).toBe(IBAN_STORTO.length)
    expect(redatti.esito).toBe('iban-non-valido')
  })
})
