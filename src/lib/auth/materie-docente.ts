import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { haUnRuolo, type AppUser } from '@/lib/auth/predicati-ruolo'
import { logEvento } from '@/lib/logging/logger'

/**
 * Le materie che una docente ha in una classe (`utenti_sezioni_materie`).
 *
 * ⚠️ È UN FILE A SÉ, e non un'aggiunta a `scope.ts` o a `docenti.ts`, per due ragioni misurate:
 *  · decine di test sostituiscono quei due moduli con una factory: un export nuovo lì dentro
 *    sarebbe `undefined` in tutti quei test;
 *  · `materieDiDocenteInSezione` (`src/lib/sezioni/docenti.ts`) restituisce `[]` su un guasto, e
 *    qui `[]` vuol dire «nessuna materia assegnata», cioè 403. Un errore del database non può
 *    diventare un rifiuto: sarebbe una docente che si vede negare il proprio registro per un
 *    guasto nostro, e che non sa riprovare. Qui il guasto dà 500 `LETTURA_FALLITA`.
 *
 * Il controllo è sulla COPPIA (classe, materia), mai sulla sola materia: chi ha Italiano in 2A e
 * Matematica in 2B non ha Italiano in 2B.
 *
 * Lo staff (`admin`, `coordinator`, `segreteria`) non ha assegnazioni da rispettare: passa senza
 * leggere niente. Si guardano i ruoli REALI (`haUnRuolo`), non la veste indossata: una persona
 * `educator` che è anche `segreteria` agisce da segreteria dove la veste lo consente.
 */

const RUOLI_STAFF = ['admin', 'coordinator', 'segreteria'] as const

export type MaterieVisibili =
  | { ok: true; tutte: true }
  | { ok: true; tutte: false; materie: ReadonlySet<string> }
  | { ok: false; response: NextResponse }

/** 403: la materia esiste ma non è fra quelle assegnate a questa docente in questa classe. */
export function rispostaMateriaNonAssegnata(): NextResponse {
  return NextResponse.json(
    { error: 'Questa materia non ti è assegnata in questa classe.', codice: 'MATERIA_NON_ASSEGNATA' },
    { status: 403 },
  )
}

/** 500: la lettura delle assegnazioni è fallita. Mai confusa con un rifiuto. */
function rispostaLetturaFallita(): NextResponse {
  return NextResponse.json(
    { error: 'Verifica delle materie non riuscita. Riprova.', codice: 'LETTURA_FALLITA' },
    { status: 500 },
  )
}

/**
 * Le materie che `user` può vedere e usare, in una classe (`sectionId`) o in tutte (senza).
 * Staff: `{ tutte: true }`, senza leggere. Insegnante: l'insieme degli id delle sue materie,
 * che se non ne ha nessuna è VUOTO (e non «tutte»). Guasto: la risposta 500 pronta.
 */
export async function materieVisibili(
  supabase: SupabaseClient,
  user: AppUser,
  sectionId?: string | null,
): Promise<MaterieVisibili> {
  if (haUnRuolo(user, RUOLI_STAFF)) return { ok: true, tutte: true }

  let query = supabase
    .from('utenti_sezioni_materie')
    .select('section_id, materia_id')
    .eq('utente_id', user.id)
  if (sectionId) query = query.eq('section_id', sectionId)

  const { data, error } = await query
  if (error) {
    logEvento(
      'auth',
      'error',
      { operazione: 'auth/materie-docente', esito: 'materie-docente-non-lette' },
      error,
    )
    return { ok: false, response: rispostaLetturaFallita() }
  }

  const materie = new Set<string>()
  for (const riga of (data ?? []) as { materia_id: string | null }[]) {
    if (riga.materia_id) materie.add(riga.materia_id)
  }
  return { ok: true, tutte: false, materie }
}

/**
 * `null` se `user` può agire su questa materia in questa classe, altrimenti la risposta da
 * restituire: 403 `MATERIA_NON_ASSEGNATA` se non è sua, 500 `LETTURA_FALLITA` se non si è potuto
 * verificare. Senza `materiaId` (un voto senza materia) non c'è niente da verificare: `null`,
 * senza letture.
 */
export async function assertMateriaDelDocente(
  supabase: SupabaseClient,
  user: AppUser,
  sectionId: string,
  materiaId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!materiaId) return null

  const visibili = await materieVisibili(supabase, user, sectionId)
  if (!visibili.ok) return visibili.response
  if (visibili.tutte) return null
  // Una classe vuota è un errore di chi chiama, e `materieVisibili` l'avrebbe letta come «tutte le
  // classi»: la coppia non sarebbe più una coppia. Si nega, invece di lasciar passare.
  if (sectionId && visibili.materie.has(materiaId)) return null

  logEvento('auth', 'warn', {
    operazione: 'auth/materie-docente',
    esito: 'materia-non-assegnata',
    section_id: sectionId,
    materia_id: materiaId,
    error_code: 'MATERIA_NON_ASSEGNATA',
  })
  return rispostaMateriaNonAssegnata()
}
