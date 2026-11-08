import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppRole } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { sezioniVisibiliConEsito } from '@/lib/sezioni/docenti'
import { logEvento } from '@/lib/logging/logger'

/**
 * RBAC ristretto per il Fascicolo personale (PEI/PDP/documenti sanitari).
 *
 * Accesso ammesso a:
 *  - Dirigenza/Segreteria: ruoli 'admin' / 'coordinator' / 'segreteria', MA solo
 *    per gli alunni del proprio plesso (Direzione: dei plessi associati). Mai cross-tenant.
 *  - Docenti CONTITOLARI della sezione dell'alunno (via `sezioni_visibili_docente`: dirette e per materia).
 * Vietato ai docenti di altre classi e a chiunque altro.
 *
 * Enforcement APPLICATIVO (RLS non attiva — vedi require-staff). L'accesso ai
 * file passa sempre da queste API (service_role) con check qui sotto.
 */

export interface AccessoFascicolo {
  consentito: boolean
  ruolo: string | null
  /**
   * `errore` (fase 11): il database non ha risposto. L'accesso resta NEGATO — fail-closed, mai
   * un fascicolo sanitario aperto per un guasto — ma il motivo non si confonde più con
   * «non è tuo», e la riga `error` dice quale lettura è caduta. Chi chiama può rispondere 500
   * invece del 403 che direbbe a un docente titolare che il fascicolo non è suo.
   */
  motivo: 'staff' | 'contitolare' | 'negato' | 'no-section' | 'cross-tenant' | 'errore'
}

/** Un guasto del gate: negato, con la riga che lo distingue da un diniego vero. */
function negatoPerGuasto(esito: string, ruolo: string | null, error: unknown): AccessoFascicolo {
  logEvento('fascicolo', 'error', { operazione: 'primaria/fascicolo-rbac:puoAccedereFascicolo', esito }, error)
  return { consentito: false, ruolo, motivo: 'errore' }
}

/** Le azioni che SCRIVONO: per un docente valgono solo sulle sezioni dell'anno attivo. */
const AZIONI_DI_SCRITTURA: ReadonlySet<AzioneGate> = new Set<AzioneGate>(['upload', 'delete', 'sostituisci'])

export async function puoAccedereFascicolo(
  supabase: SupabaseClient,
  utenteId: string,
  alunnoId: string,
  azione: AzioneGate = 'view',
): Promise<AccessoFascicolo> {
  // Ruolo + plesso dell'utente.
  const { data: u, error: errUtente } = await supabase
    .from('utenti')
    .select('id, ruolo, role, scuola_id')
    .eq('id', utenteId)
    .maybeSingle()
  if (errUtente) return negatoPerGuasto('utente-non-letto', null, errUtente)
  const ruolo = (u?.role || u?.ruolo) as string | null
  if (!u) return { consentito: false, ruolo: null, motivo: 'negato' }

  // Sezione + plesso dell'alunno.
  const { data: alunno, error: errAlunno } = await supabase
    .from('alunni')
    .select('section_id, scuola_id')
    .eq('id', alunnoId)
    .maybeSingle()
  if (errAlunno) return negatoPerGuasto('alunno-non-letto', ruolo, errAlunno)

  // Dirigenza / Segreteria: ammessa solo entro il proprio/i plesso/i (no cross-tenant).
  if (ruolo === 'admin' || ruolo === 'coordinator' || ruolo === 'segreteria') {
    if (!alunno) return { consentito: false, ruolo, motivo: 'negato' }
    const plessi = await scuoleDiUtente(supabase, {
      id: u.id, role: ruolo as AppRole, scuola_id: u.scuola_id,
    })
    if (alunno.scuola_id && plessi.includes(alunno.scuola_id as string)) {
      return { consentito: true, ruolo, motivo: 'staff' }
    }
    return { consentito: false, ruolo, motivo: 'cross-tenant' }
  }

  const sectionId = alunno?.section_id
  if (!sectionId) return { consentito: false, ruolo, motivo: 'no-section' }

  // Contitolare: assegnazione DIRETTA alla sezione (la riga in `utenti_sezioni`: la regola sta nella funzione dei docenti).
  // LETTURA: basta che la sezione sia fra le VISIBILI (anche in sola lettura di un anno passato; mai una futura).
  // SCRITTURA (upload, delete, sostituisci): solo le sezioni dell'anno attivo, cioè non in sola lettura.
  const visibili = await sezioniVisibiliConEsito(supabase, utenteId)
  if (!visibili.ok) return negatoPerGuasto('contitolarita-non-letta', ruolo, new Error('sezioni-visibili-non-lette'))
  const scrittura = AZIONI_DI_SCRITTURA.has(azione)
  const consentita = visibili.sezioni.some((s) => s.sectionId === sectionId && (!scrittura || !s.solaLettura))
  if (consentita) return { consentito: true, ruolo, motivo: 'contitolare' }

  return { consentito: false, ruolo, motivo: 'negato' }
}

/**
 * Le sezioni di cui l'utente è CONTITOLARE — assegnazione diretta (`utenti_sezioni`):
 * la riga per materia (`utenti_sezioni_materie`) dice quali discipline insegna, non se la classe è sua. La regola sta
 * nella funzione SQL `sezioni_visibili_docente`, qui non si rileggono le tabelle.
 *
 * È la stessa condizione che `puoAccedereFascicolo` verifica una sezione alla
 * volta, qui raccolta in blocco: serve agli ELENCHI, dove chiedere il gate per
 * ognuno dei trentatré alunni significherebbe sessantasei query per disegnare
 * una pagina.
 *
 * ⚠️ Le due funzioni devono restare d'accordo, e con loro `sezioniAnagraficaVisibili`
 * (`src/lib/anagrafiche/docente/visibilita.ts`). Se un giorno nasce un'altra
 * tabella di assegnazione, va aggiunta in tutte e tre — un elenco più generoso del
 * gate mostrerebbe righe che poi non si aprono; più severo, nasconderebbe
 * documenti a chi ha diritto di vederli e nessuno se ne accorgerebbe.
 * Il lock `__tests__/architecture/assegnazioni-docente-coerenti.test.ts` verifica
 * che le tre funzioni chiamino la funzione di visibilità e che questa legga la riga diretta (fino al 2026-10-04 questo commento citava un
 * file che non è mai esistito).
 */
export async function sezioniContitolari(
  supabase: SupabaseClient,
  utenteId: string,
): Promise<string[]> {
  // LETTURA: tutte le sezioni VISIBILI (anche in sola lettura); la funzione conta la riga diretta.
  // Se è lei a fallire, la riga `error` l'ha già scritta lei: l'elenco è vuoto (fail-closed).
  const visibili = await sezioniVisibiliConEsito(supabase, utenteId)
  return visibili.ok ? [...new Set(visibili.sezioni.map((s) => s.sectionId))] : []
}

export type AzioneFascicolo = 'list' | 'view' | 'download' | 'upload' | 'delete'
/** Il gate distingue anche la sostituzione di un documento (scrittura, con il suo audit a parte). */
export type AzioneGate = AzioneFascicolo | 'sostituisci'

/** Registra un accesso al fascicolo nel log immodificabile. Best-effort. */
export async function logAccessoFascicolo(
  supabase: SupabaseClient,
  opts: {
    alunnoId: string
    utenteId: string | null
    azione: AzioneFascicolo
    documentoId?: string | null
    finalita?: string | null
    request?: Request
  }
): Promise<void> {
  try {
    const ip = opts.request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
    const userAgent = opts.request?.headers.get('user-agent') || null
    // PostgREST NON lancia: senza questo controllo un audit rifiutato spariva
    // del tutto. È il registro degli accessi al fascicolo (PEI/PDP, documenti
    // sanitari): se non viene scritto, va saputo.
    const res = await supabase.from('fascicolo_accessi_audit').insert({
      alunno_id: opts.alunnoId,
      documento_id: opts.documentoId ?? null,
      utente_id: opts.utenteId,
      azione: opts.azione,
      finalita: opts.finalita ?? null,
      ip,
      user_agent: userAgent,
    })
    if (res?.error) segnalaAuditFascicoloFallito(opts.azione, opts.alunnoId, res.error)
  } catch (e) {
    segnalaAuditFascicoloFallito(opts.azione, opts.alunnoId, e)
  }
}

/**
 * A log vanno SOLO l'azione e l'id dell'alunno (uuid, canale strutturato).
 * Restano fuori `finalita` (testo libero scritto dall'operatore), `documentoId`
 * — che direbbe QUALE documento del fascicolo — e ip/user-agent. Serve sapere
 * quale accesso è rimasto non tracciato, non cosa contenesse.
 */
function segnalaAuditFascicoloFallito(azione: AzioneFascicolo, alunnoId: string, err: unknown): void {
  logEvento(
    'fascicolo',
    'error',
    { operazione: 'logAccessoFascicolo', azione, esito: 'audit-non-registrato', alunno_id: alunnoId },
    err,
  )
}
