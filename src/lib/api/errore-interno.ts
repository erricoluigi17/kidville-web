import { NextResponse } from 'next/server'
import { logErrore } from '@/lib/logging/logger'

/**
 * UN'ECCEZIONE IN UNA ROUTE: al chiamante il codice, al log l'errore intero.
 * (Sessione 13 della seconda serie di robustezza, «bordo pubblico» — 2026-10-20.)
 *
 * PERCHÉ ESISTE. Il 20/10 nove risposte di quattro porte anonime (`/api/iscrizione`, `/api/iscrizione/sedi`,
 * `/api/forms/submit`, `/api/public/forms/[token]/submit`) mandavano a chiunque il `message` dell'errore: il testo
 * di PostgREST o di un'eccezione interna, con nomi di tabelle e di vincoli e a volte `Key (…)=(…)`. Per una
 * famiglia è rumore incomprensibile; per chi bussa alle porte una dopo l'altra è una descrizione dello schema.
 *
 * DUE FORME, come in `src/lib/db/guasto.ts` (che resta la strada per i guasti del database):
 *   · `rispostaErroreInterno(operazione, err)` — nel `catch` di una route: scrive `logErrore` e risponde 500
 *     `ERRORE_INTERNO`;
 *   · `rispostaErroreInternoGiaRegistrato()` — la stessa risposta quando la riga l'ha già scritta chi chiama,
 *     con un `esito` più preciso.
 *
 * Il lock `__tests__/architecture/porte-anonime-senza-errori-interni.test.ts` vieta `.message` nelle risposte
 * delle porte anonime; `errori-con-codice` controlla che `ERRORE_INTERNO` sia dichiarato e tradotto.
 */

export function rispostaErroreInterno(operazione: string, err: unknown): NextResponse {
  logErrore({ operazione, stato: 500 }, err)
  return rispostaErroreInternoGiaRegistrato()
}

export function rispostaErroreInternoGiaRegistrato(): NextResponse {
  // Letterali, non costanti: il lock `errori-con-codice` controlla solo ciò che sa leggere.
  return NextResponse.json(
    { error: 'Si è verificato un errore imprevisto. Riprova fra poco.', codice: 'ERRORE_INTERNO' },
    { status: 500 },
  )
}
