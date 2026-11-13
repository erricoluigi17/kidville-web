import { normalizzaTelefono } from '@/lib/crm/contatti'

/** Il recapito originale può finire in scheda. Accetta solo caratteri di un numero formattato. */
export function normalizzaTelefonoAi(telefono: string): string | null {
  if (/[^\d+()./\p{Zs}-]/u.test(telefono)) return null
  return normalizzaTelefono(telefono)
}
