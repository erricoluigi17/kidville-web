import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'
import { sendEmail, credentialsEmailBody } from '@/lib/email/send'
import type { EnrollmentSubmissionData, EnrollmentAdult, EnrollmentChild } from '@/types/database.types'

const DEFAULT_SCUOLA_ID = '11111111-1111-1111-1111-111111111111'

// GET: lista invii, oppure ?doc=<path> per ottenere una signed URL del documento.
export async function GET(request: NextRequest) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const { searchParams } = new URL(request.url)
    const docPath = searchParams.get('doc')
    const supabase = await createAdminClient()

    if (docPath) {
      const { data, error } = await supabase.storage
        .from('form_attachments')
        .createSignedUrl(docPath, 60 * 10) // 10 minuti
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ url: data.signedUrl })
    }

    const { data, error } = await supabase
      .from('enrollment_submissions')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 })
  }
}

// PATCH: rifiuto o import nelle anagrafiche.
// Body import: { id, action:'import', assignments: { [childIndex]: classe }, referenteIndex }
// Body reject: { id, action:'reject' }
export async function PATCH(request: NextRequest) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const body = await request.json()
    const { id, action } = body
    if (!id || !action) {
      return NextResponse.json({ error: 'id e action obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    if (action === 'reject') {
      const { data, error } = await supabase
        .from('enrollment_submissions')
        .update({ status: 'rejected', updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      await logScrittura(supabase, {
        attore: auth.user,
        entitaTipo: 'iscrizione',
        entitaId: id,
        azione: 'update',
        valoreDopo: { status: 'rejected' },
      })
      return NextResponse.json(data)
    }

    if (action !== 'import') {
      return NextResponse.json({ error: 'Azione non valida' }, { status: 400 })
    }

    const assignments: Record<string, string> = body.assignments || {}
    const referenteIndex: number = typeof body.referenteIndex === 'number' ? body.referenteIndex : 0

    // 1. Carica l'invio
    const { data: sub, error: subErr } = await supabase
      .from('enrollment_submissions')
      .select('*')
      .eq('id', id)
      .single()
    if (subErr || !sub) {
      return NextResponse.json({ error: 'Invio non trovato' }, { status: 404 })
    }

    const data = sub.data as EnrollmentSubmissionData
    const scuolaId = sub.scuola_id || DEFAULT_SCUOLA_ID
    const children = data.children || []
    const adults = data.adults || []

    // Ogni figlio deve avere una classe assegnata
    for (let i = 0; i < children.length; i++) {
      if (!assignments[String(i)]) {
        return NextResponse.json({ error: `Assegnare una classe al bambino ${i + 1}` }, { status: 400 })
      }
    }

    const warnings: string[] = []
    let credentials: { email: string; password: string } | null = null
    let credentialsEmailSent = false

    // 2. ADULTI → parents (dedup per CF) + account per il referente
    const parentLinks: { parentId: string; role: string; isReferente: boolean }[] = []

    for (let ai = 0; ai < adults.length; ai++) {
      const a = adults[ai] as EnrollmentAdult
      const isReferente = ai === referenteIndex
      let parentId: string | null = null

      // Dedup per codice fiscale
      if (a.fiscal_code) {
        const { data: existing } = await supabase
          .from('parents')
          .select('id')
          .eq('fiscal_code', a.fiscal_code)
          .maybeSingle()
        if (existing) parentId = existing.id
      }

      // Crea il genitore se non esiste (mirror di /api/admin/parents create_parent: insert senza id)
      if (!parentId) {
        const parentRecord: Record<string, unknown> = {
          first_name: a.first_name ?? null,
          last_name: a.last_name ?? null,
          fiscal_code: a.fiscal_code ?? null,
          birth_date: a.birth_date || null,
          birth_city: a.birth_place ?? null,
          birth_province: a.birth_province ?? null,
          residence_address: a.address ?? null,
          residence_city: a.residence_city ?? null,
          zip_code: a.zip_code ?? null,
          emails: a.email ? [a.email] : [],
          phone_numbers: a.phone ? [a.phone] : [],
          document_type: a.document_type ?? null,
          document_number: a.document_number ?? null,
          documento_path: a.documento_path ?? null,
        }
        const { data: newParent, error: pErr } = await supabase
          .from('parents')
          .insert(parentRecord)
          .select('id')
          .single()
        if (pErr || !newParent) {
          warnings.push(`Adulto ${ai + 1}: ${pErr?.message ?? 'creazione fallita'}`)
          continue
        }
        parentId = newParent.id
        await logScrittura(supabase, {
          attore: auth.user,
          entitaTipo: 'genitori',
          entitaId: parentId,
          azione: 'insert',
          scuolaId,
          valoreDopo: parentRecord,
        })
      }

      // Account di accesso per il referente (se ha email)
      const adultEmail = a.email ? String(a.email) : ''
      if (isReferente && adultEmail) {
        const tempPassword = 'Kidville_' + Math.random().toString(36).substring(2, 9)
        const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
          email: adultEmail,
          password: tempPassword,
          email_confirm: true,
          user_metadata: { first_name: a.first_name, last_name: a.last_name, role: 'parent' },
        })
        let userId: string | null = null
        if (authErr) {
          if (authErr.message.includes('already') || authErr.message.includes('exists')) {
            const { data: u } = await supabase.from('utenti').select('id').eq('email', adultEmail).maybeSingle()
            userId = u?.id ?? null
            credentials = { email: adultEmail, password: '(account già esistente)' }
          } else {
            warnings.push(`Account referente: ${authErr.message}`)
          }
        } else {
          userId = authData.user.id
          credentials = { email: adultEmail, password: tempPassword }
        }
        if (userId) {
          await supabase.from('utenti').upsert({
            id: userId,
            email: adultEmail,
            password_segreta: credentials?.password ?? tempPassword,
            nome: a.first_name,
            cognome: a.last_name,
            cellulare: a.phone ?? null,
            ruolo: 'genitore',
            scuola_id: scuolaId,
            attivo: true,
          })

          // Invio automatico delle credenziali (solo per un account appena creato)
          if (!authErr) {
            credentialsEmailSent = await sendEmail({
              to: adultEmail,
              subject: 'Le tue credenziali di accesso — Kidville',
              text: credentialsEmailBody(a.first_name != null ? String(a.first_name) : null, adultEmail, tempPassword),
            })
            if (!credentialsEmailSent) {
              warnings.push('Email credenziali non inviata (provider non configurato) — comunicarle manualmente al referente.')
            }
          }
        }
      }

      if (parentId) parentLinks.push({ parentId, role: a.ruolo || 'delegate', isReferente })
    }

    // 3. FIGLI → alunni (dedup per CF) + collegamento a tutti gli adulti
    const createdStudents: { id: string; nome: string }[] = []

    for (let ci = 0; ci < children.length; ci++) {
      const c = children[ci] as EnrollmentChild
      const classe = assignments[String(ci)]
      let studentId: string | null = null

      if (c.codice_fiscale) {
        const { data: existing } = await supabase
          .from('alunni')
          .select('id')
          .eq('codice_fiscale', c.codice_fiscale)
          .maybeSingle()
        if (existing) {
          studentId = existing.id
          await supabase.from('alunni').update({ classe_sezione: classe }).eq('id', studentId)
          await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'alunni',
            entitaId: studentId,
            azione: 'update',
            scuolaId,
            valoreDopo: { classe_sezione: classe },
          })
        }
      }

      if (!studentId) {
        const childRecord: Record<string, unknown> = {
          scuola_id: scuolaId,
          nome: c.nome ?? null,
          cognome: c.cognome ?? null,
          data_nascita: c.data_nascita || null,
          gender: c.gender ?? null,
          codice_fiscale: c.codice_fiscale ?? null,
          birth_city: c.birth_city ?? null,
          birth_province: c.birth_province ?? null,
          residence_address: c.residence_address ?? null,
          residence_city: c.residence_city ?? null,
          zip_code: c.zip_code ?? null,
          allergies: c.allergies ?? null,
          note_mediche: c.note_mediche ?? null,
          documento_path: c.documento_path ?? null,
          classe_sezione: classe,
          stato: 'iscritto',
        }
        const { data: newChild, error: cErr } = await supabase
          .from('alunni')
          .insert(childRecord)
          .select('id, nome')
          .single()
        if (cErr || !newChild) {
          warnings.push(`Bambino ${ci + 1}: ${cErr?.message ?? 'creazione fallita'}`)
          continue
        }
        studentId = newChild.id
        createdStudents.push({ id: newChild.id, nome: newChild.nome })
        await logScrittura(supabase, {
          attore: auth.user,
          entitaTipo: 'alunni',
          entitaId: studentId,
          azione: 'insert',
          scuolaId,
          valoreDopo: childRecord,
        })
      }

      // Collega tutti gli adulti a questo figlio
      for (const link of parentLinks) {
        await supabase.from('student_parents').upsert(
          {
            student_id: studentId,
            parent_id: link.parentId,
            relation_type: link.role,
            is_primary: link.isReferente,
          },
          { onConflict: 'student_id,parent_id', ignoreDuplicates: false }
        )
        await logScrittura(supabase, {
          attore: auth.user,
          entitaTipo: 'legame',
          entitaId: `${studentId}:${link.parentId}`,
          azione: 'insert',
          scuolaId,
          valoreDopo: { student_id: studentId, parent_id: link.parentId, relation_type: link.role },
        })
      }
    }

    // 4. Aggiorna l'invio
    const { error: updErr } = await supabase
      .from('enrollment_submissions')
      .update({
        status: 'approved',
        assigned_classes: assignments,
        credentials,
        imported_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
    if (updErr) warnings.push(`Aggiornamento invio: ${updErr.message}`)

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'iscrizione',
      entitaId: id,
      azione: 'update',
      scuolaId,
      valoreDopo: { status: 'approved', created_students: createdStudents.length, linked_parents: parentLinks.length },
    })

    return NextResponse.json({
      success: true,
      credentials,
      credentialsEmailSent,
      created_students: createdStudents,
      linked_parents: parentLinks.length,
      warnings,
    })
  } catch (err: any) {
    console.error('Errore PATCH /api/admin/iscrizioni:', err)
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 })
  }
}
