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
import { describe, it, expect } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'
import { coordinateBonificoSede } from '@/lib/pagamenti/coordinate-bonifico'

// IBAN SINTETICO: è l'esempio pubblico della Banca d'Italia, non è di nessuno.
const IBAN_OK = 'IT60X0542811101000000123456'
const IBAN_LEGGIBILE = 'IT60 X054 2811 1010 0000 0123 456'
// Una cifra sola cambiata: la forma è giusta, il mod 97 no.
const IBAN_STORTO = 'IT60X0542811101000000123457'

const ctx = { operazione: 'test:coordinate-bonifico' }

function db(righe: Record<string, unknown>[]): DBFinto {
  return { admin_settings: righe }
}

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
