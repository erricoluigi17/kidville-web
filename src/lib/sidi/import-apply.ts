import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'
import { logEvento } from '@/lib/logging/logger'
import type { SidiDomandaRecord } from './zip-parser'

export interface ApplyResult {
  matched: number
  creati: number
  aggiornati: number
  warnings: string[]
}

/**
 * Applica i record SIDI alle anagrafiche (alunni + parents + student_parents).
 * Matching: ① numero domanda (chiave primaria persistente), ② fallback codice
 * fiscale (stampa il numero domanda sull'alunno), ③ creazione. Genitori dedup su
 * `parents.fiscal_code`. Idempotente (riusa la logica di upsert di /iscrizioni).
 */
export async function applySidiRecords(
  supabase: SupabaseClient,
  records: SidiDomandaRecord[],
  scuolaId: string,
  attore: AppUser
): Promise<ApplyResult> {
  let matched = 0
  let creati = 0
  let aggiornati = 0
  const warnings: string[] = []

  for (const rec of records) {
    let studentId: string | null = null

    // ① match su numero domanda (persistente, per scuola).
    const { data: byNum, error: errNum } = await supabase
      .from('alunni')
      .select('id')
      .eq('scuola_id', scuolaId)
      .eq('numero_domanda_sidi', rec.numero_domanda)
      .maybeSingle()
    if (errNum) {
      // PostgREST non lancia: senza questo controllo una lettura fallita
      // proseguiva al ramo ② e poi al ③, creando un DOPPIONE dell'alunno.
      logEvento('sidi', 'error', { operazione: 'applySidiRecords', tipo: 'import', esito: 'match-numero-domanda-fallito' }, errNum)
      warnings.push(`Domanda ${rec.numero_domanda}: verifica del numero domanda non riuscita, riga non applicata`)
      continue
    }
    if (byNum) {
      studentId = byNum.id
      matched++
    }

    // ② fallback su codice fiscale → stampa il numero domanda.
    //
    // ⚠️ ISOLAMENTO FRA SEDI (2026-07-31). Questa lettura era senza `scuola_id`,
    // e il CF a DB è UNICO su TUTTE le sedi (`alunni_codice_fiscale_key`,
    // vincolo voluto): un pacchetto SIDI di Aversa contenente il CF di un
    // bambino di Giugliano gli timbrava sopra il numero domanda di Aversa e ci
    // agganciava i genitori del pacchetto — cioè mescolava due anagrafi reali,
    // in silenzio, contando la riga fra gli «aggiornati».
    // Un bambino già iscritto ALTROVE non si riusa e non si duplica (l'INSERT
    // sbatterebbe comunque sull'UNIQUE): la riga si scarta e lo si dice, perché
    // il caso vero è un TRASFERIMENTO fra plessi, che è una decisione umana.
    if (!studentId && rec.alunno.codice_fiscale) {
      const { data: byCf, error: errCf } = await supabase
        .from('alunni')
        .select('id, scuola_id')
        .eq('codice_fiscale', rec.alunno.codice_fiscale)
        .maybeSingle()
      if (errCf) {
        logEvento('sidi', 'error', { operazione: 'applySidiRecords', tipo: 'import', esito: 'match-cf-fallito' }, errCf)
        warnings.push(`Domanda ${rec.numero_domanda}: verifica del codice fiscale non riuscita, riga non applicata`)
        continue
      }
      if (byCf && byCf.scuola_id !== scuolaId) {
        logEvento('sidi', 'warn', {
          operazione: 'applySidiRecords', tipo: 'import', esito: 'cf-altra-sede',
          scuola_id: scuolaId,
        })
        warnings.push(
          `Domanda ${rec.numero_domanda}: il codice fiscale risulta già iscritto in un'altra sede — serve un trasferimento, riga non applicata`
        )
        continue
      }
      if (byCf) {
        studentId = byCf.id
        aggiornati++
        await supabase.from('alunni').update({ numero_domanda_sidi: rec.numero_domanda }).eq('id', studentId)
        await logScrittura(supabase, {
          attore,
          entitaTipo: 'alunni',
          entitaId: studentId,
          azione: 'update',
          scuolaId,
          valoreDopo: { numero_domanda_sidi: rec.numero_domanda },
        })
      }
    }

    // ③ creazione (mirror dello shape di /api/admin/iscrizioni).
    if (!studentId) {
      const childRecord: Record<string, unknown> = {
        scuola_id: scuolaId,
        nome: rec.alunno.nome ?? null,
        cognome: rec.alunno.cognome ?? null,
        data_nascita: rec.alunno.data_nascita || null,
        gender: rec.alunno.sesso ?? null,
        codice_fiscale: rec.alunno.codice_fiscale ?? null,
        birth_city: rec.alunno.comune_nascita ?? null,
        birth_province: rec.alunno.provincia_nascita ?? null,
        numero_domanda_sidi: rec.numero_domanda,
        stato: 'iscritto',
      }
      const { data: newChild, error } = await supabase.from('alunni').insert(childRecord).select('id').single()
      if (error || !newChild) {
        warnings.push(`Domanda ${rec.numero_domanda}: ${error?.message ?? 'creazione alunno fallita'}`)
        continue
      }
      studentId = newChild.id
      creati++
      await logScrittura(supabase, {
        attore,
        entitaTipo: 'alunni',
        entitaId: studentId,
        azione: 'insert',
        scuolaId,
        valoreDopo: childRecord,
      })
    }

    // Genitori: dedup su fiscal_code, poi link student_parents.
    for (const g of rec.genitori) {
      let parentId: string | null = null
      if (g.codice_fiscale) {
        const { data: ex } = await supabase.from('parents').select('id').eq('fiscal_code', g.codice_fiscale).maybeSingle()
        if (ex) parentId = ex.id
      }
      if (!parentId) {
        const parentRecord: Record<string, unknown> = {
          first_name: g.nome ?? null,
          last_name: g.cognome ?? null,
          fiscal_code: g.codice_fiscale ?? null,
          emails: g.email ? [g.email] : [],
          phone_numbers: g.telefono ? [g.telefono] : [],
        }
        const { data: np, error } = await supabase.from('parents').insert(parentRecord).select('id').single()
        if (error || !np) {
          warnings.push(`Domanda ${rec.numero_domanda}: genitore non creato (${error?.message ?? 'errore'})`)
          continue
        }
        parentId = np.id
        await logScrittura(supabase, {
          attore,
          entitaTipo: 'genitori',
          entitaId: parentId,
          azione: 'insert',
          scuolaId,
          valoreDopo: parentRecord,
        })
      }
      await supabase.from('student_parents').upsert(
        { student_id: studentId, parent_id: parentId, relation_type: g.relazione || 'genitore', is_primary: false },
        { onConflict: 'student_id,parent_id', ignoreDuplicates: false }
      )
      await logScrittura(supabase, {
        attore,
        entitaTipo: 'legame',
        entitaId: studentId,
        azione: 'insert',
        scuolaId,
        valoreDopo: { student_id: studentId, parent_id: parentId },
      })
    }
  }

  return { matched, creati, aggiornati, warnings }
}

/**
 * Applica un batch già parsato (`sidi_import_batches.parsed_payload`) e ne
 * aggiorna lo stato. Idempotente: un batch già `applied` non viene riapplicato.
 */
export async function applySidiBatch(
  supabase: SupabaseClient,
  batchId: string,
  attore: AppUser
): Promise<ApplyResult & { error?: string; status?: number; alreadyApplied?: boolean }> {
  const { data: batch, error: errBatch } = await supabase.from('sidi_import_batches').select('*').eq('id', batchId).maybeSingle()
  if (errBatch) {
    // PostgREST non lancia: senza questo controllo un guasto di lettura usciva
    // come 404 «Batch non trovato», cioè come un errore dell'operatore.
    logEvento('sidi', 'error', { operazione: 'applySidiBatch', tipo: 'import', esito: 'batch-non-letto' }, errBatch)
    return { matched: 0, creati: 0, aggiornati: 0, warnings: [], error: 'Lettura del batch non riuscita', status: 500 }
  }
  if (!batch) return { matched: 0, creati: 0, aggiornati: 0, warnings: [], error: 'Batch non trovato', status: 404 }
  if (batch.stato === 'applied') {
    return { matched: batch.matched ?? 0, creati: batch.creati ?? 0, aggiornati: 0, warnings: [], alreadyApplied: true }
  }
  const payload = batch.parsed_payload
  const records: SidiDomandaRecord[] = Array.isArray(payload) ? payload : (payload?.records ?? [])
  const res = await applySidiRecords(supabase, records, batch.scuola_id, attore)
  const { error: errStato } = await supabase
    .from('sidi_import_batches')
    .update({
      stato: 'applied',
      matched: res.matched,
      creati: res.creati,
      warnings: res.warnings,
      applied_at: new Date().toISOString(),
    })
    .eq('id', batchId)
  if (errStato) {
    // Le anagrafiche sono GIÀ state scritte: non è un fallimento
    // dell'operazione, ma il batch resta `parsed` e chi guarda vede un import
    // «non applicato» che invece è avvenuto. Va detto a schermo e a log.
    logEvento('sidi', 'error', { operazione: 'applySidiBatch', tipo: 'import', esito: 'batch-non-marcato' }, errStato)
    res.warnings.push('Import eseguito, ma lo stato del batch non è stato aggiornato: non ripetere l\'operazione senza verificare.')
  }
  return res
}
