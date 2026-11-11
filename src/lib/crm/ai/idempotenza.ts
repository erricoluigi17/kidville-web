/**
 * CRM ASSISTENTE FAMIGLIE · IDEMPOTENZA.
 *
 * La chiave identifica un tentativo; l'impronta distingue un nuovo corpo da
 * quello già ricevuto. L'ordine delle proprietà JSON è irrilevante, quello degli
 * array conta. Rifiutiamo ciò che JSON perderebbe in silenzio.
 */

import { createHash } from 'node:crypto'

export const FORMA_CHIAVE_IDEMPOTENZA = /^[A-Za-z0-9_-]{8,128}$/

export function chiaveIdempotenza(request: Request): string | null {
  const chiave = request.headers.get('Idempotency-Key')
  return chiave !== null && FORMA_CHIAVE_IDEMPOTENZA.test(chiave) ? chiave : null
}

function corpoNonJson(): never {
  throw new TypeError('Il corpo deve contenere solo valori JSON')
}

// Legge il valore senza invocare getter e senza ignorare proprietà nascoste.
function valoreProprieta(oggetto: object, chiave: string): unknown {
  const descrittore = Object.getOwnPropertyDescriptor(oggetto, chiave)
  if (!descrittore?.enumerable || !Object.hasOwn(descrittore, 'value')) return corpoNonJson()
  return descrittore.value
}

function jsonCanonico(valore: unknown, antenati: Set<object>): string {
  if (valore === null || typeof valore === 'string' || typeof valore === 'boolean') return JSON.stringify(valore)
  if (typeof valore === 'number' && Number.isFinite(valore)) return JSON.stringify(valore)
  if (typeof valore !== 'object' || valore === null || antenati.has(valore)) return corpoNonJson()

  const chiavi = Reflect.ownKeys(valore)
  const prototipo = Object.getPrototypeOf(valore)
  antenati.add(valore)
  try {
    if (Array.isArray(valore)) {
      // Gli array JSON hanno solo indici contigui e la proprietà interna length.
      if (prototipo !== Array.prototype || chiavi.length !== valore.length + 1) return corpoNonJson()
      const parti: string[] = []
      for (let i = 0; i < valore.length; i++) {
        parti.push(jsonCanonico(valoreProprieta(valore, String(i)), antenati))
      }
      return `[${parti.join(',')}]`
    }

    if (prototipo !== Object.prototype && prototipo !== null) return corpoNonJson()
    const nomi = chiavi.filter((chiave): chiave is string => typeof chiave === 'string')
    if (nomi.length !== chiavi.length) return corpoNonJson()
    // Serializziamo direttamente: ricostruire l'oggetto riordinerebbe le chiavi
    // numeriche e rischierebbe di perdere proprietà come "__proto__".
    const parti = nomi.sort().map((chiave) =>
      `${JSON.stringify(chiave)}:${jsonCanonico(valoreProprieta(valore, chiave), antenati)}`,
    )
    return `{${parti.join(',')}}`
  } finally {
    antenati.delete(valore)
  }
}

/** SHA-256 esadecimale del JSON canonico. Lancia TypeError per valori non JSON. */
export function improntaCorpo(corpo: unknown): string {
  return createHash('sha256').update(jsonCanonico(corpo, new Set())).digest('hex')
}
