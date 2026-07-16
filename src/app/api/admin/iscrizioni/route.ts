import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { ensureParentIdentity } from '@/lib/auth/parent-identity'
import { sendEmailDetailed, credentialsEmailBody } from '@/lib/email/send'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import { z } from 'zod'
import type { EnrollmentSubmissionData, EnrollmentAdult, EnrollmentChild } from '@/types/database.types'

// Esito bloccante dell'import: impedisce di marcare l'invio 'approved' (a differenza
// dei `warnings`, non bloccanti). `dove` = "Adulto N"/"Bambino N", `messaggio` = testo it.
interface ImportError {
  dove: string
  messaggio: string
}

// Normalizza una provincia (residence/birth) alla sigla ufficiale. Rete di sicurezza per
// gli invii già in coda con la provincia PER ESTESO ("Caserta" → "CE"): senza, l'INSERT su
// parents/alunni (residence_province/birth_province varchar(2)) esplode con Postgres 22001.
//   - assente (null/undefined/'') → { ok, value:null }: la provincia è facoltativa.
//   - riconoscibile (sigla o nome per esteso) → { ok, value:<sigla> }.
//   - non riconoscibile → { ok:false, messaggio }: MAI troncare a caso (art. province.ts).
function normalizzaCampoProvincia(
  raw: unknown,
  etichetta: 'di residenza' | 'di nascita',
): { ok: true; value: string | null } | { ok: false; messaggio: string } {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, value: null }
  }
  const sigla = normalizzaProvincia(raw)
  if (sigla) return { ok: true, value: sigla }
  return { ok: false, messaggio: `Provincia ${etichetta} non valida: usare la sigla, es. NA` }
}

// Traduce un errore PostgREST/Postgres in un messaggio italiano per l'operatore, deducendo
// il campo dal messaggio quando possibile. Il messaggio (che può contenere valori: es. il
// dettaglio di una unique-violation) va SOLO nella risposta HTTP allo staff, MAI in `app_log`
// (dove si logga codice+campo). Ritorna anche `codice`/`campo` per il logging strutturato.
function descriviErroreDb(
  err: { code?: string; message?: string } | null,
): { messaggio: string; campo: string | null; codice: string | null } {
  const codice = err?.code ?? null
  const rawMsg = err?.message ?? 'errore sconosciuto'
  // INSERT nudo: 'column "X"'; PostgREST: "Could not find the 'X' column".
  const m = /column "?([a-z_]+)"?|'([a-z_]+)' column/i.exec(rawMsg)
  const campo = m?.[1] ?? m?.[2] ?? null
  if (codice === '22001') {
    return {
      messaggio: campo
        ? `Valore troppo lungo per il campo "${campo}": verificare i dati e riprovare.`
        : 'Un valore supera la lunghezza massima del database (controllare le province: usare la sigla, es. NA).',
      campo,
      codice,
    }
  }
  if (codice === '23505') {
    return { messaggio: `Record già presente in anagrafica${campo ? ` (campo "${campo}")` : ''}.`, campo, codice }
  }
  if (codice === '23502') {
    return { messaggio: `Manca un dato obbligatorio${campo ? `: "${campo}"` : ''}.`, campo, codice }
  }
  return { messaggio: `Creazione non riuscita: ${rawMsg}`, campo, codice }
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  doc: z.string().optional(), // path storage → signed URL
})

// referenteIndex resta unknown: il codice accetta qualsiasi valore e usa 0
// quando non è un numero (fallback pre-esistente da preservare, niente 400).
const patchBodySchema = z.object({
  id: zUuid,
  action: z.enum(['reject', 'import']),
  assignments: z.record(z.string(), z.string()).nullish(),
  referenteIndex: z.unknown().optional(),
})

// GET: lista invii, oppure ?doc=<path> per ottenere una signed URL del documento.
export const GET = withRoute('admin/iscrizioni:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const docPath = q.data.doc
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
      .in('scuola_id', await resolveScuoleAttive(request, supabase, auth.user))
      .order('created_at', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  } catch (err) {
    logErrore({ operazione: 'admin/iscrizioni:GET', stato: 500 }, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno' }, { status: 500 })
  }
})

// PATCH: rifiuto o import nelle anagrafiche.
// Body import: { id, action:'import', assignments: { [childIndex]: classe }, referenteIndex }
// Body reject: { id, action:'reject' }
export const PATCH = withRoute('admin/iscrizioni:PATCH', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, action } = b.data

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

      // Esito al genitore SOLO se un account esiste già (match best-effort per
      // email degli adulti dell'invio): la pre-iscrizione può essere anonima.
      try {
        const adulti = ((data as { data?: EnrollmentSubmissionData })?.data?.adults ?? []) as EnrollmentAdult[]
        const emails = adulti.map((a) => a.email).filter((e): e is string => Boolean(e))
        if (emails.length > 0) {
          const { data: utenti } = await supabase.from('utenti').select('id').in('email', emails)
          const destinatari = (utenti ?? []).map((u) => u.id as string)
          await notificaEvento(supabase, {
            tipo: 'iscrizione_esito',
            scuolaId: ((data as { scuola_id?: string })?.scuola_id as string | undefined) ?? null,
            utenteIds: destinatari,
            titolo: 'Esito domanda di iscrizione',
            corpo: 'La domanda di iscrizione non è stata accolta. Contatta la segreteria per i dettagli.',
            link: '/parent',
            entitaTipo: 'iscrizione',
            entitaId: id,
            bufferMin: 0,
          })
        }
      } catch (e) {
        // `error`, non `warn`, benché la richiesta risponda 200: la notifica non è stata
        // accodata, quindi il genitore non saprà MAI che la domanda è stata rifiutata.
        // È una scrittura persa in silenzio, e va contata.
        logEvento('notifica', 'error', {
          operazione: 'admin/iscrizioni:PATCH',
          esito: 'notifica-rifiuto-non-inviata',
          tipo: 'iscrizione_esito',
        }, e)
      }

      return NextResponse.json(data)
    }

    // action === 'import' garantito dallo schema (enum reject|import)
    const assignments: Record<string, string> = b.data.assignments || {}
    const referenteIndex: number = typeof b.data.referenteIndex === 'number' ? b.data.referenteIndex : 0

    // 1. Carica l'invio
    const { data: sub, error: subErr } = await supabase
      .from('enrollment_submissions')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (subErr || !sub) {
      return NextResponse.json({ error: 'Invio non trovato' }, { status: 404 })
    }

    const data = sub.data as EnrollmentSubmissionData
    // scuola_id: risolto dallo scope dell'admin (una sola sede), preferendo
    // quella dell'invio se accessibile.
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, sub.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string
    const children = data.children || []
    const adults = data.adults || []

    // Ogni figlio deve avere una classe assegnata
    for (let i = 0; i < children.length; i++) {
      if (!assignments[String(i)]) {
        return NextResponse.json({ error: `Assegnare una classe al bambino ${i + 1}` }, { status: 400 })
      }
    }

    // Bloccanti (impediscono l'approvazione) vs warnings (non bloccanti).
    const errors: ImportError[] = []
    const warnings: string[] = []

    // ─── PRE-FLIGHT province: valida TUTTI i record PRIMA di qualsiasi scrittura ───
    // Così una provincia per esteso non riconoscibile non lascia mai anagrafiche a metà:
    // niente insert parziali, l'invio resta 'pending' e l'operatore corregge e riprova.
    // Le sigle normalizzate vengono riusate negli INSERT sotto (una sola normalizzazione).
    const adultProv: { residence: string | null; birth: string | null }[] = []
    for (let ai = 0; ai < adults.length; ai++) {
      const a = adults[ai] as EnrollmentAdult
      const res = normalizzaCampoProvincia(a.residence_province, 'di residenza')
      const bir = normalizzaCampoProvincia(a.birth_province, 'di nascita')
      if (!res.ok) {
        errors.push({ dove: `Adulto ${ai + 1}`, messaggio: res.messaggio })
        logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'provincia-non-valida', entita: 'adulto', indice: ai + 1, campo: 'residence_province' })
      }
      if (!bir.ok) {
        errors.push({ dove: `Adulto ${ai + 1}`, messaggio: bir.messaggio })
        logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'provincia-non-valida', entita: 'adulto', indice: ai + 1, campo: 'birth_province' })
      }
      adultProv.push({ residence: res.ok ? res.value : null, birth: bir.ok ? bir.value : null })
    }
    const childProv: { residence: string | null; birth: string | null }[] = []
    for (let ci = 0; ci < children.length; ci++) {
      const c = children[ci] as EnrollmentChild
      const res = normalizzaCampoProvincia(c.residence_province, 'di residenza')
      const bir = normalizzaCampoProvincia(c.birth_province, 'di nascita')
      if (!res.ok) {
        errors.push({ dove: `Bambino ${ci + 1}`, messaggio: res.messaggio })
        logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'provincia-non-valida', entita: 'bambino', indice: ci + 1, campo: 'residence_province' })
      }
      if (!bir.ok) {
        errors.push({ dove: `Bambino ${ci + 1}`, messaggio: bir.messaggio })
        logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'provincia-non-valida', entita: 'bambino', indice: ci + 1, campo: 'birth_province' })
      }
      childProv.push({ residence: res.ok ? res.value : null, birth: bir.ok ? bir.value : null })
    }
    if (errors.length > 0) {
      logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'import-bloccato-preflight', bloccanti: errors.length })
      return NextResponse.json({ success: false, errors, warnings }, { status: 200 })
    }

    let credentials: { email: string; password: string } | null = null
    let credentialsEmailSent = false
    let referenteUserId: string | null = null

    // 2. ADULTI → parents (dedup per CF) + account per il referente
    const parentLinks: { parentId: string; role: string; isReferente: boolean }[] = []

    for (let ai = 0; ai < adults.length; ai++) {
      const a = adults[ai] as EnrollmentAdult
      const isReferente = ai === referenteIndex
      let parentId: string | null = null
      let parentAuthId: string | null = null

      // Dedup per codice fiscale
      if (a.fiscal_code) {
        const { data: existing } = await supabase
          .from('parents')
          .select('id, auth_user_id')
          .eq('fiscal_code', a.fiscal_code)
          .maybeSingle()
        if (existing) {
          parentId = existing.id
          parentAuthId = (existing as { auth_user_id?: string | null }).auth_user_id ?? null
        }
      }

      // Crea il genitore se non esiste (mirror di /api/admin/parents create_parent: insert senza id)
      if (!parentId) {
        const parentRecord: Record<string, unknown> = {
          first_name: a.first_name ?? null,
          last_name: a.last_name ?? null,
          fiscal_code: a.fiscal_code ?? null,
          birth_date: a.birth_date || null,
          birth_city: a.birth_place ?? null,
          birth_nation: a.birth_nation ?? null,
          citizenship: a.citizenship ?? null,
          residence_address: a.address ?? null,
          residence_street_number: a.residence_street_number ?? null,
          residence_city: a.residence_city ?? null,
          residence_province: adultProv[ai].residence,
          birth_province: adultProv[ai].birth,
          zip_code: a.zip_code ?? null,
          emails: a.email ? [a.email] : [],
          phone_numbers: a.phone ? [a.phone] : [],
          document_type: a.document_type ?? null,
          document_number: a.document_number ?? null,
          documento_path: a.documento_path ?? null,
        }
        // Insert resiliente alla colonna mancante: se il DB non ha ancora una colonna
        // del record (es. progetto E2E CI privo della migrazione 20260706105201 →
        // residence_province/residence_street_number) la rimuove e riprova. Un INSERT
        // PostgREST con colonna assente torna PGRST204 ("Could not find the 'X' column
        // ... in the schema cache"). In prod le colonne esistono → nessun retry. Senza
        // questo l'insert falliva e il `continue` sotto saltava la creazione dell'account
        // referente (credenziali mai emesse → test degrado email rosso).
        let pRes = await supabase.from('parents').insert(parentRecord).select('id').single()
        let pAttempts = 0
        while (pRes.error && ['PGRST204', '42703'].includes((pRes.error as { code?: string }).code ?? '') && pAttempts < 6) {
          const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(pRes.error.message)
          const col = m?.[1] ?? m?.[2]
          if (!col || !(col in parentRecord)) break
          delete parentRecord[col]
          pRes = await supabase.from('parents').insert(parentRecord).select('id').single()
          pAttempts++
        }
        const { data: newParent, error: pErr } = pRes
        if (pErr || !newParent) {
          // Fallimento BLOCCANTE: senza referente/adulto in anagrafica l'import non è
          // completo. Niente più degrado a `warning` con 'approved' fasullo (il bug 22001).
          const d = descriviErroreDb(pErr)
          errors.push({ dove: `Adulto ${ai + 1}`, messaggio: d.messaggio })
          logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'insert-adulto-fallito', entita: 'adulto', indice: ai + 1, campo: d.campo, codice: d.codice })
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

      // Account di accesso per il referente (se ha email) — S6bis: identità
      // COMPLETA (auth.users + riga `utenti` + ponte parents.auth_user_id) via
      // helper condiviso. Il vecchio blocco creava solo auth+utenti senza ponte
      // (genitore che entrava ma non risolveva i figli) e upsertava `utenti` con
      // una colonna inesistente in prod (password_segreta → PGRST204 silenzioso)
      // rischiando pure di sovrascrivere il ruolo di uno staff omonimo.
      const adultEmail = a.email ? String(a.email) : ''
      if (isReferente && adultEmail && parentId) {
        const identita = await ensureParentIdentity(supabase, {
          id: parentId,
          auth_user_id: parentAuthId,
          emails: [adultEmail],
          first_name: a.first_name != null ? String(a.first_name) : null,
          last_name: a.last_name != null ? String(a.last_name) : null,
          phone: a.phone != null ? String(a.phone) : null,
        }, { scuolaId })
        if (identita.ok) {
          referenteUserId = identita.authUserId
          credentials = { email: adultEmail, password: identita.password ?? '(account già esistente)' }

          // Invio automatico delle credenziali (solo per un account appena creato)
          if (identita.createdAuth && identita.password) {
            const invio = await sendEmailDetailed({
              to: adultEmail,
              subject: 'Le tue credenziali di accesso — Kidville',
              text: credentialsEmailBody(a.first_name != null ? String(a.first_name) : null, adultEmail, identita.password),
            })
            credentialsEmailSent = invio.ok
            if (!invio.ok) {
              warnings.push(`Email credenziali NON inviata a ${adultEmail}: ${invio.error ?? 'motivo sconosciuto'} — comunicarle manualmente al referente.`)
            }
          }
        } else if (identita.reason !== 'no_email') {
          warnings.push(`Account referente: ${identita.message}`)
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

      // Dedup SOFT per gli alunni SENZA codice fiscale (nome+cognome+data_nascita+scuola).
      // Serve al RE-IMPORT dopo un fallimento parziale: senza CF non c'è chiave forte, e un
      // secondo import ricreerebbe lo stesso bambino. Guardia stretta — attiva SOLO con tutti
      // e tre i campi identificativi presenti — per non fondere per errore due bambini omonimi
      // privi di data di nascita. `limit(1)` protegge `maybeSingle` da eventuali duplicati già
      // in tabella. Se la colonna non esistesse nel DB E2E (42703) l'errore è ignorato e si
      // procede all'insert (comportamento invariato: al più un doppione in E2E, mai in prod).
      if (!studentId && !c.codice_fiscale && c.nome && c.cognome && c.data_nascita) {
        const { data: soft, error: softErr } = await supabase
          .from('alunni')
          .select('id')
          .eq('scuola_id', scuolaId)
          .eq('nome', c.nome)
          .eq('cognome', c.cognome)
          .eq('data_nascita', c.data_nascita)
          .limit(1)
          .maybeSingle()
        if (softErr) {
          logEvento('db', 'info', { operazione: 'admin/iscrizioni:PATCH', esito: 'dedup-soft-non-disponibile', entita: 'bambino', indice: ci + 1, codice: (softErr as { code?: string }).code ?? null })
        } else if (soft) {
          studentId = soft.id
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
          birth_province: childProv[ci].birth,
          birth_nation: c.birth_nation ?? null,
          citizenship: c.citizenship ?? null,
          residence_address: c.residence_address ?? null,
          residence_street_number: c.residence_street_number ?? null,
          residence_city: c.residence_city ?? null,
          residence_province: childProv[ci].residence,
          zip_code: c.zip_code ?? null,
          allergies: c.allergies ?? null,
          note_mediche: c.note_mediche ?? null,
          documento_path: c.documento_path ?? null,
          classe_sezione: classe,
          stato: 'iscritto',
        }
        // Insert resiliente alla colonna mancante (come per i parents sopra): DB E2E
        // senza le colonne della migrazione 20260706105201 → PGRST204 → le rimuove e riprova.
        let cRes = await supabase.from('alunni').insert(childRecord).select('id, nome').single()
        let cAttempts = 0
        while (cRes.error && ['PGRST204', '42703'].includes((cRes.error as { code?: string }).code ?? '') && cAttempts < 6) {
          const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(cRes.error.message)
          const col = m?.[1] ?? m?.[2]
          if (!col || !(col in childRecord)) break
          delete childRecord[col]
          cRes = await supabase.from('alunni').insert(childRecord).select('id, nome').single()
          cAttempts++
        }
        const { data: newChild, error: cErr } = cRes
        if (cErr || !newChild) {
          // Fallimento BLOCCANTE: un figlio non creato = iscrizione incompleta.
          const d = descriviErroreDb(cErr)
          errors.push({ dove: `Bambino ${ci + 1}`, messaggio: d.messaggio })
          logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'insert-bambino-fallito', entita: 'bambino', indice: ci + 1, campo: d.campo, codice: d.codice })
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

    // 4. Esito. Se durante gli INSERT c'è stato ALMENO un errore bloccante (referente o un
    // figlio non creati), l'invio NON passa ad 'approved': resta 'pending', così l'operatore
    // vede il problema e riprova (il re-import è deduplicato per CF e, senza CF, dalla dedup
    // soft sopra). È il cuore del fix del bug 22001: prima si marcava 'approved' comunque e la
    // UI diceva "Importata" mentre in anagrafica non c'era nulla.
    if (errors.length > 0) {
      logEvento('db', 'error', {
        operazione: 'admin/iscrizioni:PATCH',
        esito: 'import-incompleto',
        bloccanti: errors.length,
        creati: createdStudents.length,
        agganciati: parentLinks.length,
      })
      return NextResponse.json(
        {
          success: false,
          errors,
          warnings,
          created_students: createdStudents,
          linked_parents: parentLinks.length,
        },
        { status: 200 },
      )
    }

    // 5. Import completo → aggiorna l'invio a 'approved'.
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

    // Esito al referente (best-effort): domanda accolta. Solo se l'import ha
    // creato/agganciato un account utente.
    try {
      if (referenteUserId) {
        await notificaEvento(supabase, {
          tipo: 'iscrizione_esito',
          scuolaId,
          utenteIds: [referenteUserId],
          titolo: 'Iscrizione accolta',
          corpo: 'La domanda di iscrizione è stata accolta: benvenuti a Kidville!',
          link: '/parent',
          entitaTipo: 'iscrizione',
          entitaId: id,
          bufferMin: 0,
        })
      }
    } catch (e) {
      // Come sopra: l'import è andato a buon fine (200), ma il referente non riceverà
      // l'avviso di accoglimento. Notifica mai inviata = dato perduto → `error`.
      logEvento('notifica', 'error', {
        operazione: 'admin/iscrizioni:PATCH',
        esito: 'notifica-accoglimento-non-inviata',
        tipo: 'iscrizione_esito',
      }, e)
    }

    return NextResponse.json({
      success: true,
      credentials,
      credentialsEmailSent,
      created_students: createdStudents,
      linked_parents: parentLinks.length,
      warnings,
    })
  } catch (err) {
    logErrore({ operazione: 'admin/iscrizioni:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno' }, { status: 500 })
  }
})
