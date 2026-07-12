import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { getUserEmail, verifyTicket, codeHash } from '@/lib/auth/otp-ticket'
import { buildSignatureLog, extractRequestMeta } from '@/lib/fea/signature-log'
import { recordSignerSlot } from '@/lib/fea/slots'
import { logFeaEvent } from '@/lib/fea/audit'
import { getModuleConfig } from '@/lib/settings/module-config'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { docentiDiSezione } from '@/lib/sezioni/docenti'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `data` resta stringa permissiva (oggi il DB accetta anche formati non YYYY-MM-DD);
// `motivo` permissivo: oggi qualunque tipo è accettato (i non-string diventano null).
// code/expiry/ticket: oggi possono mancare o arrivare come numero — la verifica
// vera la fa verifyTicket (HMAC), e solo se l'OTP è richiesto dalle impostazioni.
const postBodySchema = z.object({
  studentId: zUuid,
  data: z.string().min(1),
  motivo: z.unknown().optional(),
  code: z.unknown().optional(),
  expiry: z.unknown().optional(),
  ticket: z.unknown().optional(),
})

// POST /api/parent/presenze/giustifica?userId=
// body: { studentId, data, motivo, code, expiry, ticket }
// Il genitore giustifica un'assenza/ritardo/uscita del figlio. Solo primaria.
// Protetta da conferma OTP email (FES): richiedi prima l'OTP via /giustifica/otp.
export async function POST(request: NextRequest) {
  try {
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { studentId, data, motivo, code, expiry, ticket } = b.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response
    const userId = auth.user.id

    const supabase = await createAdminClient()

    // Gating primaria: la giustifica genitore è ammessa solo per la scuola primaria.
    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, section_id, scuola_id')
      .eq('id', studentId)
      .maybeSingle()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    const presenzeCfg = await getModuleConfig<{
      giustifica_max_giorni_retroattivi: number
      giustifica_richiede_firma_otp: boolean
    }>(supabase, 'presenze_config', alunno.scuola_id)

    // Finestra retroattiva configurabile dall'admin (default 5 giorni).
    const maxGiorni = Number(presenzeCfg.giustifica_max_giorni_retroattivi ?? 5)
    const giorniPassati = Math.floor((Date.now() - new Date(data).getTime()) / 86_400_000)
    if (giorniPassati > maxGiorni) {
      return NextResponse.json(
        { error: `Giustifica non più possibile: sono passati più di ${maxGiorni} giorni. Contatta la segreteria.` },
        { status: 403 }
      )
    }

    const richiedeOtp = presenzeCfg.giustifica_richiede_firma_otp !== false

    // Conferma OTP email (FES) prima di procedere (se richiesta dalle impostazioni).
    const email = await getUserEmail(supabase, userId)
    if (!email) return NextResponse.json({ error: 'Email del genitore non trovata' }, { status: 400 })
    const { ip, userAgent } = extractRequestMeta(request)
    if (richiedeOtp) {
      const check = verifyTicket(email, String(code ?? ''), Number(expiry ?? 0), String(ticket ?? ''))
      if (!check.ok) {
        await logFeaEvent(supabase, { entitaTipo: 'giustifica', signerUserId: userId, email, evento: 'verify_failed', ip, userAgent })
        return NextResponse.json({ error: check.error }, { status: 400 })
      }
    }

    let schoolType: string | null = null
    if (alunno.section_id) {
      const { data: sez } = await supabase.from('sections').select('school_type').eq('id', alunno.section_id).maybeSingle()
      schoolType = sez?.school_type ?? null
    }
    if (schoolType !== 'primaria') {
      return NextResponse.json({ error: 'Giustifica disponibile solo per la scuola primaria' }, { status: 403 })
    }

    const firma = richiedeOtp
      ? buildSignatureLog({
          method: 'OTP_EMAIL',
          email,
          ip,
          userAgent,
          hash: codeHash(email, String(code), Number(expiry)),
        })
      : buildSignatureLog({ method: 'CONFERMA_APP', email, ip, userAgent })

    // Aggiorna la riga presenza del giorno (deve esistere: appello registrato dal docente).
    const { data: updated, error } = await supabase
      .from('presenze')
      .update({
        giustificata: true,
        giustificazione_testo: typeof motivo === 'string' ? motivo.trim() || null : null,
        giustificata_da: userId,
        giustificata_il: new Date().toISOString(),
        giustificazione_firma: firma,
        // Una nuova giustifica azzera l'eventuale presa visione precedente.
        giust_vista_il: null,
        giust_vista_da: null,
      })
      .eq('alunno_id', studentId)
      .eq('data', data)
      .select()
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!updated) return NextResponse.json({ error: 'Nessuna assenza registrata per quella data' }, { status: 404 })

    // Ledger slot firmatari (additivo, best-effort).
    if (updated?.id) {
      await recordSignerSlot(supabase, {
        entitaTipo: 'giustifica',
        entitaId: updated.id,
        signerUserId: userId,
        signatureLog: firma,
      })
      await logFeaEvent(supabase, {
        entitaTipo: 'giustifica',
        entitaId: updated.id,
        signerUserId: userId,
        email,
        evento: 'signed',
        hash: firma.hash,
        ip,
        userAgent,
      })
    }

    // Notifica ai docenti della sezione (best-effort): giustifica ricevuta.
    try {
      const { data: anagrafica } = await supabase
        .from('alunni')
        .select('nome, cognome')
        .eq('id', studentId)
        .maybeSingle()
      const docenti = (await docentiDiSezione(supabase, alunno.section_id as string)).filter((id) => id !== userId)
      const nomeAlunno = [anagrafica?.nome, anagrafica?.cognome].filter(Boolean).join(' ') || 'un alunno'
      await notificaEvento(supabase, {
        tipo: 'giustifica_ricevuta',
        scuolaId: (alunno.scuola_id as string | undefined) ?? null,
        utenteIds: docenti,
        titolo: 'Giustifica ricevuta',
        corpo: `Il genitore di ${nomeAlunno} ha giustificato l'assenza del ${data}.`,
        link: `/teacher/primaria/${alunno.section_id}/appello`,
        entitaTipo: 'presenza',
        entitaId: (updated as { id?: string })?.id ?? null,
      })
    } catch (e) {
      console.error('Notifica giustifica fallita (non bloccante):', e)
    }

    return NextResponse.json({ success: true, data: updated })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
