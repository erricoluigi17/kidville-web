import { NextResponse } from 'next/server'

/**
 * Guard runtime per le variabili d'ambiente richieste da una route.
 *
 * Sostituisce le asserzioni `process.env.X!` a import-time: un modulo route
 * non deve mai esplodere (o congelare `undefined`) perché manca una env —
 * l'handler risponde 503 "configurazione mancante: <VAR>" e il resto
 * dell'app continua a funzionare.
 *
 * Uso, a inizio handler:
 *   const missingEnv = requireEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY')
 *   if (missingEnv) return missingEnv
 */
export function requireEnv(...names: string[]): NextResponse | null {
  const missing = names.filter((n) => !process.env[n])
  if (missing.length === 0) return null
  return NextResponse.json(
    { error: `configurazione mancante: ${missing.join(', ')}` },
    { status: 503 }
  )
}
