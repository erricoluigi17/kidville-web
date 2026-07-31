import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami'
import { getUserEmail, verifyTicket, codeHash } from '@/lib/auth/otp-ticket'
import { buildSignatureLog, extractRequestMeta } from '@/lib/fea/signature-log'
import { recordSignerSlot } from '@/lib/fea/slots'
import { logFeaEvent } from '@/lib/fea/audit'
import { notificaEvento, nomeUtente } from '@/lib/notifiche/triggers'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// L'identità viene dalla SESSIONE (`requireUser` → `resolveIdentity`), mai dalla
// query: `?userId=` è ignorato. Fino al 2026-07-31 questa route leggeva
// `getRequestUserId` in diretta, cioè scavalcava `ALLOW_HEADER_IDENTITY=false`, e
// una firma con valore legale (CAD art. 20) era apponibile a nome di un genitore
// qualunque da chiunque ne conoscesse l'uuid. Lock: __tests__/api/firma-identita-da-sessione.test.ts.
// notaId permissivo (stringa non vuota): oggi nessun vincolo di formato (un id
// non valido ricade nel 404 "Nota non trovata").
// code/expiry/ticket restano pass-through (z.unknown): il codice li coercizza
// già (String(code ?? ''), Number(expiry ?? 0), String(ticket ?? '')) e la
// verifica autorevole è l'HMAC di verifyTicket, che su valori assenti o
// malformati produce il 400 `verify_failed` CON evento di audit — vincoli di
// tipo nello schema salterebbero quell'evidenza.
const postBodySchema = z.object({
  notaId: z.string({ error: 'notaId obbligatorio' }).min(1, 'notaId obbligatorio'),
  code: z.unknown().optional(),
  expiry: z.unknown().optional(),
  ticket: z.unknown().optional(),
})

// POST /api/parent/primaria/note/firma?userId=
// body: { notaId, code, expiry, ticket }
// Il genitore firma (OTP/FES) la presa visione di una nota disciplinare. Stesso
// pattern della pagella: signature_log in nota_ricezioni + slot + audit immutabile.
export const POST = withRoute('parent/primaria/note/firma:POST', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const userId = auth.user.id

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { notaId, code, expiry, ticket } = b.data

    const supabase = await createAdminClient()

    // Conferma OTP email (FES) prima di registrare la firma.
    const email = await getUserEmail(supabase, userId)
    if (!email) return NextResponse.json({ error: 'Email del genitore non trovata' }, { status: 400 })
    const { ip, userAgent } = extractRequestMeta(request)
    const check = verifyTicket(email, String(code ?? ''), Number(expiry ?? 0), String(ticket ?? ''))
    if (!check.ok) {
      await logFeaEvent(supabase, { entitaTipo: 'nota', entitaId: notaId, signerUserId: userId, email, evento: 'verify_failed', ip, userAgent })
      return NextResponse.json({ error: check.error }, { status: 400 })
    }

    const { data: nota } = await supabase
      .from('note_disciplinari')
      .select('id, alunno_id, richiede_firma')
      .eq('id', notaId)
      .maybeSingle()
    if (!nota) return NextResponse.json({ error: 'Nota non trovata' }, { status: 404 })

    // Solo un genitore COLLEGATO all'alunno della nota può firmarne la presa
    // visione. Unione runtime + anagrafica: col solo legame runtime la firma
    // (che ha valore legale, CAD art. 20) era impossibile proprio a chi doveva
    // apporla, e la nota restava per sempre "non presa in visione".
    const collegato = await genitoreHasFiglio(supabase, userId, nota.alunno_id)
    if (!collegato) {
      return NextResponse.json({ error: 'Accesso negato: alunno non collegato al genitore' }, { status: 403 })
    }

    const firma = buildSignatureLog({
      method: 'OTP_EMAIL',
      email,
      ip,
      userAgent,
      hash: codeHash(email, String(code), Number(expiry)),
    })

    const { data, error } = await supabase
      .from('nota_ricezioni')
      .upsert(
        { nota_id: notaId, alunno_id: nota.alunno_id, genitore_id: userId, firma },
        { onConflict: 'nota_id,genitore_id' }
      )
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Retro-compat con la GET genitore (badge "Firmata"): timestamp + firmatario sulla nota.
    await supabase
      .from('note_disciplinari')
      .update({ firmata_il: new Date().toISOString(), firmata_da: userId })
      .eq('id', notaId)

    // Ledger slot firmatari + audit immutabile (additivi, best-effort).
    if (data?.id) {
      await recordSignerSlot(supabase, {
        entitaTipo: 'nota',
        entitaId: data.id,
        signerUserId: userId,
        signatureLog: firma,
      })
      await logFeaEvent(supabase, {
        entitaTipo: 'nota',
        entitaId: data.id,
        signerUserId: userId,
        email,
        evento: 'signed',
        hash: firma.hash,
        ip,
        userAgent,
      })
    }

    // Notifica al docente autore della nota: firma ricevuta (best-effort).
    try {
      const { data: notaAutore } = await supabase
        .from('note_disciplinari')
        .select('maestra_id')
        .eq('id', notaId)
        .maybeSingle()
      const maestraId = notaAutore?.maestra_id as string | undefined
      if (maestraId && maestraId !== userId) {
        const { data: alunno } = await supabase
          .from('alunni')
          .select('nome, cognome, scuola_id')
          .eq('id', nota.alunno_id)
          .maybeSingle()
        const firmatario = await nomeUtente(supabase, userId)
        await notificaEvento(supabase, {
          tipo: 'firma_ricevuta',
          scuolaId: (alunno?.scuola_id as string | undefined) ?? null,
          utenteIds: [maestraId],
          titolo: 'Nota firmata dal genitore',
          corpo: `${firmatario ?? 'Un genitore'} ha firmato la nota di ${[alunno?.nome, alunno?.cognome].filter(Boolean).join(' ') || 'un alunno'}.`,
          link: '/teacher/primaria',
          entitaTipo: 'nota',
          entitaId: notaId,
        })
      }
    } catch (e) {
      // La firma è registrata (ed è quella che fa fede), ma il docente non ne sarà
      // avvisato: la notifica non verrà riaccodata da nessuno.
      logEvento('notifica', 'error', {
        operazione: 'parent/primaria/note/firma:POST',
        tipo: 'firma_ricevuta',
        esito: 'notifica_non_inviata',
      }, e)
    }

    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'parent/primaria/note/firma:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
