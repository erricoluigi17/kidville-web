import { z } from 'zod'

// Anagrafica di sede (multi-sede): vive in scuole.config.anagrafica (JSONB,
// colonna già esistente — zero migrazioni). Tutti i campi opzionali: i
// documenti omettono ciò che manca, mai valori inventati.
//
// ⚠️ QUESTO SCHEMA È ANCHE UNA LISTA BIANCA IN SCRITTURA, e per due settimane
// nessuno se n'era accorto. `normalizzaAnagraficaSede` non modifica l'oggetto
// che riceve: lo RICOSTRUISCE dai soli campi elencati qui sotto, e il PATCH di
// `admin/schools` scrive quel nuovo oggetto al posto del precedente. Una chiave
// che i prestampati leggono ma che qui non compare quindi non è soltanto
// «senza campo nel form»: è una chiave che il primo salvataggio dell'anagrafica
// CANCELLA, anche se qualcuno l'avesse scritta a mano nel database.
//
// È esattamente ciò che è accaduto a `legale_rappresentante` e
// `autorizzazione_nido`, letti da `lib/prestampati/prefill.ts` e mai scrivibili
// da nessuna parte: la Segreteria riceveva «aggiungilo nelle impostazioni della
// sede» e nelle impostazioni non c'era niente da aggiungere. Chi aggiunge una
// chiave a `config.anagrafica` la aggiunga QUI, o non esisterà.
export const zAutorizzazioneNido = z.object({
  numero: z.string().max(60).nullish(),
  /** ISO `aaaa-mm-gg`: il modello INPS rifiuta una data che non sa rileggere. */
  data: z.string().max(10).nullish(),
  comune: z.string().max(120).nullish(),
})

export const zAnagraficaSede = z.object({
  denominazione: z.string().max(160).nullish(), // denominazione ufficiale/ragione sociale
  codice_meccanografico: z.string().max(20).nullish(),
  cap: z.string().max(10).nullish(),
  provincia: z.string().max(4).nullish(), // sigla, es. NA
  telefono: z.string().max(30).nullish(),
  email: z.string().max(160).nullish(),
  pec: z.string().max(160).nullish(),
  piva_cf: z.string().max(20).nullish(), // P.IVA / CF ente gestore
  /** Nome e cognome di chi firma i documenti della scuola (§3b impaginazione). */
  legale_rappresentante: z.string().max(120).nullish(),
  /** Estremi dell'autorizzazione comunale al nido: uno per sede, servono al Bonus INPS. */
  autorizzazione_nido: zAutorizzazioneNido.nullish(),
})
export type AnagraficaSede = z.infer<typeof zAnagraficaSede>
export type AutorizzazioneNidoConfig = z.infer<typeof zAutorizzazioneNido>

const CAMPI = [
  'denominazione', 'codice_meccanografico', 'cap', 'provincia',
  'telefono', 'email', 'pec', 'piva_cf', 'legale_rappresentante',
] as const

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim()
  return t.length > 0 ? t : null
}

/**
 * Gli estremi dell'autorizzazione, o `null`.
 *
 * Tre campi vuoti danno `null` e non `{numero:null,data:null,comune:null}`: un
 * oggetto di soli `null` è indistinguibile da un dato presente finché non lo si
 * apre, e `leggiAutorizzazioneNido` (prefill) fa già la stessa scelta in lettura.
 */
function normalizzaAutorizzazioneNido(
  input: AutorizzazioneNidoConfig | null | undefined,
): AutorizzazioneNidoConfig | null {
  const numero = clean(input?.numero)
  const data = clean(input?.data)
  const comune = clean(input?.comune)
  return numero || data || comune ? { numero, data, comune } : null
}

/** Trim; stringhe vuote → null; codice meccanografico e sigla provincia in
 *  maiuscolo (convenzione MIM/ISTAT). */
export function normalizzaAnagraficaSede(input: AnagraficaSede): AnagraficaSede {
  const out: Record<string, unknown> = {}
  for (const k of CAMPI) out[k] = clean(input[k])
  if (out.codice_meccanografico) out.codice_meccanografico = (out.codice_meccanografico as string).toUpperCase()
  if (out.provincia) out.provincia = (out.provincia as string).toUpperCase()
  out.autorizzazione_nido = normalizzaAutorizzazioneNido(input.autorizzazione_nido)
  return out as AnagraficaSede
}

/**
 * Estrazione safe da scuole.config (JSONB non tipizzato dal DB): mai throw.
 *
 * `autorizzazione_nido` si pota dalla lettura quando non è un oggetto, invece di
 * lasciar fallire lo `safeParse`: il fallimento qui non è parziale — restituisce
 * `{}` — e una sola chiave scritta a mano in forma sbagliata farebbe sparire
 * dalla schermata anche denominazione, P.IVA e legale rappresentante, che con
 * quella chiave non c'entrano niente. In SCRITTURA lo schema resta severo
 * (`admin/schools:PATCH` risponde 400): tollerante in lettura, rigido in
 * ingresso.
 */
export function parseAnagraficaSede(config: unknown): AnagraficaSede {
  const raw = (config as { anagrafica?: unknown } | null | undefined)?.anagrafica
  let sanificato = raw
  if (raw && typeof raw === 'object') {
    const copia = { ...(raw as Record<string, unknown>) }
    const aut = copia.autorizzazione_nido
    if (aut !== undefined && aut !== null && (typeof aut !== 'object' || Array.isArray(aut))) {
      delete copia.autorizzazione_nido
    }
    sanificato = copia
  }
  const parsed = zAnagraficaSede.safeParse(sanificato ?? {})
  return normalizzaAnagraficaSede(parsed.success ? parsed.data : {})
}
