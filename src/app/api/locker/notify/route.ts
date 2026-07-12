import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { docentiDiSezione } from '@/lib/sezioni/docenti'

// Ruoli di plesso avvisati oltre ai docenti della sezione (come panic-alert).
const STAFF_LOCKER = new Set(['segreteria', 'admin', 'coordinator'])

const postBodySchema = z.object({
  alunno_id: zUuid,
  materiale: z.string().trim().min(1).max(80),
})

// POST /api/locker/notify — "Avvisa" dell'armadietto genitore (M5.3): il
// genitore segnala scorte in esaurimento; destinatari = staff della scuola +
// docenti della sezione, via enqueueNotifiche tipo `locker_scorte`.
export async function POST(request: Request) {
  const auth = await requireUser(request)
  if (auth.response) return auth.response
  const { user } = auth

  // Anti-spam: ogni chiamata genera una notifica per TUTTO lo staff del plesso.
  const rl = rateLimit(`locker-notify:${clientIp(request)}`, { limit: 10, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppi avvisi inviati. Riprova tra qualche minuto.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
    )
  }

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { alunno_id: alunnoId, materiale } = b.data

  try {
    const supabase = await createAdminClient()

    // scope: il genitore deve essere collegato all'alunno
    const { data: legame } = await supabase
      .from('legame_genitori_alunni')
      .select('alunno_id')
      .eq('genitore_id', user.id)
      .eq('alunno_id', alunnoId)
      .maybeSingle()
    if (!legame) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })

    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, nome, scuola_id, section_id')
      .eq('id', alunnoId)
      .maybeSingle()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // Destinatari: staff del plesso (schema legacy: ruolo su `role` O `ruolo`)
    // + docenti della sezione (utenti_sezioni; section_id può essere null).
    const destinatari = new Set<string>()
    if (alunno.scuola_id) {
      const { data: staff } = await supabase
        .from('utenti')
        .select('id, role, ruolo')
        .eq('scuola_id', alunno.scuola_id)
      for (const u of staff ?? []) {
        if (STAFF_LOCKER.has(u.role ?? '') || STAFF_LOCKER.has(u.ruolo ?? '')) destinatari.add(u.id)
      }
    }
    if (alunno.section_id) {
      for (const id of await docentiDiSezione(supabase, alunno.section_id)) destinatari.add(id)
    }

    if (destinatari.size > 0) {
      await enqueueNotifiche(supabase, {
        utenteIds: [...destinatari],
        tipo: 'locker_scorte',
        titolo: `Armadietto: scorte basse di ${materiale}`,
        corpo: `Il genitore di ${alunno.nome} segnala scorte in esaurimento: ${materiale}.`,
        entitaTipo: 'armadietto',
        entitaId: alunnoId,
        bufferMin: 0,
        scuolaId: (alunno.scuola_id as string | undefined) ?? null,
      })
    }

    return NextResponse.json({ success: true, destinatari: destinatari.size })
  } catch (err) {
    console.error('Errore POST /api/locker/notify:', err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
}
