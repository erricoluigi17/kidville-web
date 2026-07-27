import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { consensiMancanti, CONSENSI_RICHIESTI } from '@/lib/onboarding/consensi'
import { VERSIONE_PRIVACY, VERSIONE_TERMINI } from '@/lib/legal/versioni'
import { notificaEvento, nomeUtente } from '@/lib/notifiche/triggers'
import { staffScuola, scuolaUnicaReale } from '@/lib/notifiche/destinatari'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postBodySchema = z.object({
  // Record salvato tal quale in `parents.consensi_gdpr`: valori permissivi
  // (oggi nessun vincolo di tipo sui singoli consensi). L'obbligo dei consensi
  // richiesti resta il 422 semantico dell'handler.
  consensi: z.record(z.string(), z.unknown()).optional(),
  // Permissivo: oggi un valore falsy ('' incluso) viene ignorato e qualsiasi
  // valore truthy con String(v).length >= 8 è accettato; un vincolo
  // z.string().min(8) cambierebbe il comportamento. Il check di lunghezza
  // resta nell'handler.
  password: z.unknown().optional(),
})

// POST /api/parent/onboarding — primo accesso genitore (DL-045):
// accettazione consensi GDPR obbligatori + (opzionale) impostazione password
// Supabase Auth. Marca `parents.onboarded_at`. Prerequisito ingegneristico di
// S13 (sigillo identità): dà al genitore una sessione reale.
export const POST = withRoute('parent/onboarding:POST', async (request: Request) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response

  try {
    const consensi = (b.data.consensi ?? {}) as Record<string, boolean>
    const password = b.data.password as string | undefined

    const mancanti = consensiMancanti(consensi, CONSENSI_RICHIESTI)
    if (mancanti.length > 0) {
      return NextResponse.json({ error: 'Consensi obbligatori mancanti', mancanti }, { status: 422 })
    }
    if (password && String(password).length < 8) {
      return NextResponse.json({ error: 'La password deve avere almeno 8 caratteri' }, { status: 400 })
    }

    const admin = await createAdminClient()
    const { data: parent, error: updateErr } = await admin
      .from('parents')
      .update({ consensi_gdpr: consensi, onboarded_at: new Date().toISOString() })
      .eq('id', auth.user.id)
      .select('id, auth_user_id')
      .maybeSingle()

    // PostgREST non lancia: senza questo controllo un update fallito veniva
    // ignorato e la risposta dichiarava comunque successo. Con il gate C5 in
    // chat/messages (che legge consensi_gdpr.termini) questo non è più solo
    // un dato di onboarding incompleto: è un genitore che crede di aver
    // accettato i Termini e riceve un 403 permanente senza alcuna diagnosi.
    if (updateErr) {
      logErrore({ operazione: 'parent/onboarding:POST', stato: 500, evento: 'db' }, updateErr)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }

    // Imposta la password sulla sessione Supabase Auth solo se il genitore è
    // bindato (auth_user_id) e ha fornito una password.
    if (password && parent?.auth_user_id) {
      await admin.auth.admin.updateUserById(parent.auth_user_id as string, { password: String(password) })
    }

    // C5 — Prova d'accettazione append-only (art. 1341 c.c.): una riga in
    // `consensi_accettazioni` per ogni consenso ACCETTATO fra quelli richiesti, con
    // la VERSIONE decisa SERVER-SIDE (mai dal client: un client datato o malevolo
    // spedirebbe una versione arbitraria, svuotando il valore probatorio) e la data
    // dal DB (default now()). Best-effort: un fallimento NON fa fallire l'onboarding
    // (loggato, mai swallow). PostgREST non lancia → si controlla { error }. Degrada
    // pulito sul DB E2E non migrato (tabella assente → warn, onboarding comunque ok).
    if (parent?.id) {
      const versioni: Record<string, string> = { privacy: VERSIONE_PRIVACY, termini: VERSIONE_TERMINI }
      const righe = CONSENSI_RICHIESTI
        .filter((tipo) => consensi[tipo] === true)
        .map((tipo) => ({ parent_id: parent.id as string, tipo, versione: versioni[tipo] }))
      if (righe.length > 0) {
        const { error: consErr } = await admin.from('consensi_accettazioni').insert(righe)
        if (consErr) {
          logEvento('gdpr', 'warn', {
            operazione: 'parent/onboarding:POST',
            esito: 'prova-consenso-non-registrata',
          }, consErr)
        } else {
          logEvento('gdpr', 'info', {
            operazione: 'parent/onboarding:POST',
            esito: 'prova-consenso-registrata',
            n: righe.length,
          })
        }
      }
    }

    // Notifica alla segreteria: onboarding completato (best-effort).
    try {
      const scuolaId = auth.user.scuola_id ?? (await scuolaUnicaReale(admin))
      const destinatari = await staffScuola(admin, scuolaId, ['admin', 'coordinator', 'segreteria'])
      const nome = await nomeUtente(admin, auth.user.id)
      await notificaEvento(admin, {
        tipo: 'onboarding_completato',
        scuolaId,
        utenteIds: destinatari,
        titolo: 'Onboarding genitore completato',
        corpo: `${nome ?? 'Un genitore'} ha completato la registrazione iniziale.`,
        link: '/admin/students',
        entitaTipo: 'onboarding',
        entitaId: auth.user.id,
        bufferMin: 60,
      })
    } catch (e) {
      logEvento('notifica', 'error', {
        operazione: 'parent/onboarding:POST',
        tipo: 'onboarding_completato',
        esito: 'notifica_non_inviata',
      }, e)
    }

    return NextResponse.json({ success: true, onboarded: true })
  } catch (err) {
    logErrore({ operazione: 'parent/onboarding:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
