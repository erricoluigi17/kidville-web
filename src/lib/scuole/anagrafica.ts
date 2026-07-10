import { z } from 'zod'

// Anagrafica di sede (multi-sede): vive in scuole.config.anagrafica (JSONB,
// colonna già esistente — zero migrazioni). Tutti i campi opzionali: i
// documenti omettono ciò che manca, mai valori inventati.
export const zAnagraficaSede = z.object({
  denominazione: z.string().max(160).nullish(), // denominazione ufficiale/ragione sociale
  codice_meccanografico: z.string().max(20).nullish(),
  cap: z.string().max(10).nullish(),
  provincia: z.string().max(4).nullish(), // sigla, es. NA
  telefono: z.string().max(30).nullish(),
  email: z.string().max(160).nullish(),
  pec: z.string().max(160).nullish(),
  piva_cf: z.string().max(20).nullish(), // P.IVA / CF ente gestore
})
export type AnagraficaSede = z.infer<typeof zAnagraficaSede>

const CAMPI = ['denominazione', 'codice_meccanografico', 'cap', 'provincia', 'telefono', 'email', 'pec', 'piva_cf'] as const

/** Trim; stringhe vuote → null; codice meccanografico e sigla provincia in
 *  maiuscolo (convenzione MIM/ISTAT). */
export function normalizzaAnagraficaSede(input: AnagraficaSede): AnagraficaSede {
  const clean = (v: string | null | undefined): string | null => {
    const t = (v ?? '').trim()
    return t.length > 0 ? t : null
  }
  const out: Record<string, string | null> = {}
  for (const k of CAMPI) out[k] = clean(input[k])
  if (out.codice_meccanografico) out.codice_meccanografico = out.codice_meccanografico.toUpperCase()
  if (out.provincia) out.provincia = out.provincia.toUpperCase()
  return out as AnagraficaSede
}

/** Estrazione safe da scuole.config (JSONB non tipizzato dal DB): mai throw. */
export function parseAnagraficaSede(config: unknown): AnagraficaSede {
  const raw = (config as { anagrafica?: unknown } | null | undefined)?.anagrafica
  const parsed = zAnagraficaSede.safeParse(raw ?? {})
  return normalizzaAnagraficaSede(parsed.success ? parsed.data : {})
}
