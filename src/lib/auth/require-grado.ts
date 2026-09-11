import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from './require-staff'
// ⚠️ `haRuolo` si importa DA QUI e non da `require-staff` (che pure lo ri-esporta):
// 296 file di test sostituiscono quel modulo per intero con `vi.mock`, e con lui
// sostituirebbero la regola di autorizzazione. `predicati-ruolo` non fa I/O e
// nessuno lo mocka — è la ragione per cui esiste (vedi la sua testata).
import { haRuolo, type AppUser } from './predicati-ruolo'
import { logEvento } from '@/lib/logging/logger'

export type Grado = 'nido' | 'infanzia' | 'primaria'

/**
 * Gating funzioni Scuola Primaria/Infanzia.
 *
 * Modello (decisione di prodotto):
 * - Ogni docente ha un campo esplicito `utenti.gradi` (multi-valore): un docente
 *   può essere misto (es. infanzia + primaria).
 * - `admin_settings.funzioni_matrice` mappa grado→funzioni abilitate (preset+override),
 *   per scuola. Es: { "primaria": { "registro": true, ... }, "infanzia": { ... } }.
 *
 * Enforcement APPLICATIVO (RLS non attiva, auth app-level — vedi require-staff).
 */

export interface GradoContext {
  userId: string
  gradi: Grado[]
  scuolaId: string | null
  matrice: Record<string, Record<string, boolean>>
}

/** Carica i gradi del docente + la matrice funzioni della sua scuola. */
export async function loadGradoContext(userId: string): Promise<GradoContext | null> {
  const supabase = await createAdminClient()
  const { data: u, error } = await supabase
    .from('utenti')
    .select('id, gradi, scuola_id')
    .eq('id', userId)
    .single()
  // PostgREST non lancia: qui il `null` di ritorno vale 403 per chi chiama, e
  // fino al 2026-09-09 usciva MUTO — «non abilitato» e «non ho potuto leggere»
  // erano la stessa risposta, senza una riga da cercare.
  if (error || !u) {
    logEvento('auth', 'error', {
      tipo: 'grado-contesto-non-letto', azione: 'loadGradoContext', utente: userId,
    }, error)
    return null
  }

  let matrice: Record<string, Record<string, boolean>> = {}
  if (u.scuola_id) {
    const { data: s, error: errMatrice } = await supabase
      .from('admin_settings')
      .select('funzioni_matrice')
      .eq('scuola_id', u.scuola_id)
      .single()
    // Matrice vuota = TUTTE le funzioni disabilitate in `isFunzioneAbilitata`,
    // cioè un 403 su `requireFunzione`. `PGRST116` («nessuna riga») è il caso
    // NORMALE di una sede senza impostazioni e non si logga; tutto il resto è un
    // guasto che nega, e un diniego per guasto va detto.
    if (errMatrice && (errMatrice as { code?: string }).code !== 'PGRST116') {
      logEvento('auth', 'warn', {
        tipo: 'grado-matrice-non-letta', azione: 'loadGradoContext', utente: userId,
      }, errMatrice)
    }
    matrice = (s?.funzioni_matrice as GradoContext['matrice']) ?? {}
  }

  return {
    userId: u.id,
    gradi: (u.gradi ?? []) as Grado[],
    scuolaId: u.scuola_id ?? null,
    matrice,
  }
}

/** True se per almeno un grado del docente la funzione è abilitata in matrice. */
export function isFunzioneAbilitata(ctx: GradoContext, funzione: string): boolean {
  return ctx.gradi.some((g) => ctx.matrice?.[g]?.[funzione] === true)
}

/**
 * Garantisce che la richiesta provenga da un docente abilitato a una funzione
 * del grado indicato (default 'primaria'). Restituisce il contesto o una
 * risposta 401/403 pronta.
 */
export async function requireFunzione(
  request: Request,
  funzione: string,
  grado: Grado = 'primaria'
): Promise<{ ctx: GradoContext; response?: undefined } | { ctx?: undefined; response: NextResponse }> {
  const userId = getRequestUserId(request)
  if (!userId) {
    return { response: NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 }) }
  }
  const ctx = await loadGradoContext(userId)
  if (!ctx) {
    return { response: NextResponse.json({ error: 'Utente non trovato' }, { status: 401 }) }
  }
  if (!ctx.gradi.includes(grado) || !isFunzioneAbilitata(ctx, funzione)) {
    return {
      response: NextResponse.json(
        { error: `Accesso negato: funzione "${funzione}" non abilitata per il grado ${grado}` },
        { status: 403 }
      ),
    }
  }
  return { ctx }
}

/**
 * IL PREDICATO DEL GRADO, IN UN POSTO SOLO.
 *
 * Fino al 2026-09-09 questo controllo era scritto a mano, identico, in DUE
 * route — `primaria/classe/[sectionId]:GET` (righe 43-48) e `primaria/classi:GET`
 * (32-37) — e MANCAVA nella terza, `primaria/registro:POST`, che è l'unica delle
 * tre che SCRIVE. L'effetto misurato: un docente senza il grado `primaria` non
 * poteva LEGGERE la classe (403 su entrambe le letture, quindi modale senza
 * materie né alunni) ma poteva FIRMARE il registro. Scrivere dove non si può
 * leggere non è un permesso in più: è una scrittura fatta alla cieca.
 *
 * ⚠️ NON È `requireFunzione`, ed è un'altra domanda. Quella pretende ANCHE che la
 * funzione sia accesa in `admin_settings.funzioni_matrice`; questa chiede solo
 * «questo docente insegna a questo grado?», che è ciò che le due route sorelle
 * verificano oggi. Cambiare la domanda mentre la si sposta avrebbe fatto passare
 * per «estrazione» un cambio di comportamento su 15 docenti.
 *
 * ⚠️ NON SOSTITUISCE LO SCOPE. Dice a che grado insegna la persona, non a quali
 * classi può accedere: quello resta ad `assertSezioneInScope` /
 * `assertSezionePrimariaFirmabile`, e i due gate girano SEMPRE insieme.
 *
 * Deroga per admin/coordinator/segreteria: agiscono sull'intera scuola e il
 * grado non li riguarda. È la stessa deroga già scritta nelle due route sorelle,
 * qui detta una volta invece che tre.
 *
 * 🔴 LA DEROGA SI CHIEDE A `haRuolo`, NON A `user.role`, e la differenza è tutta.
 * `user.role` è la VESTE: `require-staff.ts:341-348` (`conRuoloAttivo`) ci scrive
 * sopra il cookie `kv-active-role` prima che la route veda l'utente. Fino al
 * 2026-09-09 questo predicato chiedeva `user.role !== 'educator'`, quindi la
 * maestra che è anche mamma, guardando l'app in veste di genitore, non veniva
 * tenuta fuori: veniva fatta entrare COME SE FOSSE la Segreteria, cioè saltando
 * il gate del grado per intero. Sulla strada che SCRIVE il registro
 * (`primaria/registro:POST`) quel salto vale una firma a database.
 *
 * MISURATO in produzione il 2026-09-09 (sole SELECT, nessun dato personale): 67
 * educator, di cui **9 col ponte `parents`** — cioè due ruoli reali, cioè
 * `conRuoloAttivo` si applica; **8 dei 9 non hanno 'primaria' in `gradi`**; **5 di
 * quegli 8 stanno in una sede che ha classi di primaria**. Cinque persone che, con
 * il permesso allargato dalla supplenza, avrebbero potuto firmare il registro di
 * qualunque classe della loro sede cambiando veste.
 *
 * La regola sta scritta in `predicati-ruolo.ts:43-46` (AUTORIZZAZIONE = `haRuolo`,
 * PRESENTAZIONE = `user.role`), `risolviValutatore` la applica già nella STESSA
 * route, e la route sorella `primaria/classe/[sectionId]:GET` è stata corretta
 * proprio così. Chi tornasse a `user.role` renda prima rossi i due casi «VESTE ≠
 * RUOLO» di `__tests__/api/primaria-registro-supplenza.test.ts`.
 *
 * Fail-closed: `loadGradoContext` torna `null` anche quando la lettura fallisce,
 * e da lì si nega. È una SCRITTURA sul registro di un minore — «non lo so» non
 * autorizza — e da oggi quel guasto lascia una riga `error` invece del silenzio.
 */
const MESSAGGIO_GRADO: Record<Grado, string> = {
  // ⚠️ La frase della primaria è LETTERALMENTE quella già in bocca alle due route
  // sorelle: due prose diverse per lo stesso diniego sono due messaggi che, il
  // giorno che uno cambia, divergono.
  primaria: 'Docente non abilitato alla primaria',
  infanzia: "Docente non abilitato all'infanzia",
  nido: 'Docente non abilitato al nido',
}

/** `null` se il docente è abilitato al grado, altrimenti un 403 pronto. */
export async function assertGradoDocente(
  user: AppUser,
  grado: Grado = 'primaria',
): Promise<NextResponse | null> {
  if (!haRuolo(user, 'educator')) return null
  const ctx = await loadGradoContext(user.id)
  if (!ctx || !ctx.gradi.includes(grado)) {
    logEvento('auth', 'warn', {
      tipo: 'grado-non-abilitato', azione: 'assertGradoDocente',
      // `ruolo` è la veste indossata, `grado` la domanda: servono entrambi per
      // riconoscere a posteriori un diniego arrivato con la veste di genitore.
      utente: user.id, ruolo: user.role, grado,
    })
    return NextResponse.json(
      { error: MESSAGGIO_GRADO[grado], codice: 'GRADO_NON_ABILITATO' },
      { status: 403 },
    )
  }
  return null
}
