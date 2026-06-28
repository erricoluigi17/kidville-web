import type { SupabaseClient } from '@supabase/supabase-js'
import { buildCertificatoPdf, type CertificatoData } from './certificato-pdf'
import { COMPETENZE_CHIAVE, COMPETENZE_SIGNIFICATIVE_CODICE } from './modello'
import { suggerisciLivello, type GiudizioPerMateria } from './livello-mapping'
import { recordSignerSlot } from '@/lib/fea/slots'
import { logFeaEvent } from '@/lib/fea/audit'

export const CERTIFICATI_BUCKET = 'certificati-competenze'

interface ValidaResult {
  ok?: boolean
  scrutinioId?: string
  scuolaId?: string | null
  annoScolastico?: string
  livello?: number
  error?: string
  status?: number
}

/**
 * Verifica che una sezione sia ammessa al Certificato delle Competenze: deve
 * essere **classe quinta primaria** (livello dedotto dal nome sezione) e avere
 * uno **scrutinio finale chiuso** (si assume l'ultimo scrutinio chiuso della
 * sezione). Ritorna gli estremi (scrutinio, scuola, anno) o un errore con status.
 */
export async function validaScrutinioFinaleClasseQuinta(
  supabase: SupabaseClient,
  sectionId: string
): Promise<ValidaResult> {
  const { data: section } = await supabase
    .from('sections')
    .select('id, name, school_type, scuola_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section) return { error: 'Sezione non trovata', status: 404 }
  const livello = Number(section.name?.match(/[1-5]/)?.[0] ?? 0)
  if (section.school_type !== 'primaria' || livello !== 5) {
    return { error: 'Il certificato delle competenze è previsto solo per la classe quinta primaria', status: 422 }
  }
  const { data: scrutinio } = await supabase
    .from('scrutini')
    .select('id, stato, periodo_id')
    .eq('section_id', sectionId)
    .eq('stato', 'chiuso')
    .order('creato_il', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!scrutinio) return { error: 'Nessuno scrutinio finale chiuso per la sezione', status: 409 }
  const { data: periodo } = await supabase
    .from('scrutinio_periodi')
    .select('anno_scolastico')
    .eq('id', scrutinio.periodo_id)
    .maybeSingle()
  return {
    ok: true,
    scrutinioId: scrutinio.id,
    scuolaId: section.scuola_id,
    annoScolastico: periodo?.anno_scolastico ?? '',
    livello,
  }
}

/**
 * Crea (o riallinea) la bozza del certificato per un alunno di classe quinta:
 * upsert idempotente su `(alunno_id, anno_scolastico)` + 8 righe competenza
 * precompilate dai giudizi di scrutinio (suggerimento sovrascrivibile) + riga
 * libera per le competenze significative.
 */
export async function seedCertificato(
  supabase: SupabaseClient,
  sectionId: string,
  alunnoId: string
): Promise<{ certificatoId?: string; error?: string; status?: number }> {
  const v = await validaScrutinioFinaleClasseQuinta(supabase, sectionId)
  if (!v.ok) return { error: v.error, status: v.status }

  const { data: cert, error: certErr } = await supabase
    .from('certificati_competenze')
    .upsert(
      {
        scuola_id: v.scuolaId,
        alunno_id: alunnoId,
        section_id: sectionId,
        scrutinio_id: v.scrutinioId,
        anno_scolastico: v.annoScolastico,
        stato: 'bozza',
      },
      { onConflict: 'alunno_id,anno_scolastico' }
    )
    .select('id')
    .single()
  if (certErr || !cert) return { error: certErr?.message ?? 'Creazione certificato fallita', status: 500 }

  // Giudizi di scrutinio → codici materia per il suggerimento livello.
  const { data: giudizi } = await supabase
    .from('scrutinio_giudizi')
    .select('materia_id, giudizio_sintetico')
    .eq('scrutinio_id', v.scrutinioId)
    .eq('alunno_id', alunnoId)
  const { data: materie } = await supabase
    .from('materie')
    .select('id, codice')
    .eq('section_id', sectionId)
  const codeById = new Map((materie ?? []).map((m: { id: string; codice: string }) => [m.id, m.codice]))
  const giudByCode: GiudizioPerMateria[] = (giudizi ?? []).map((g: { materia_id: string; giudizio_sintetico: string }) => ({
    materia_codice: codeById.get(g.materia_id) ?? '',
    giudizio_sintetico: g.giudizio_sintetico,
  }))

  const rows = COMPETENZE_CHIAVE.map((c, i) => ({
    certificato_id: cert.id,
    competenza_codice: c.codice,
    livello: suggerisciLivello(c.codice, giudByCode),
    ordine: i,
  }))
  rows.push({ certificato_id: cert.id, competenza_codice: COMPETENZE_SIGNIFICATIVE_CODICE, livello: null, ordine: COMPETENZE_CHIAVE.length })
  await supabase.from('certificato_competenza_livelli').upsert(rows, { onConflict: 'certificato_id,competenza_codice' })

  return { certificatoId: cert.id }
}

interface LoadResult {
  data?: CertificatoData
  scuolaId?: string | null
  error?: string
  status?: number
}

/** Assembla i dati del certificato per il PDF (il certificato è già stato validato in seed). */
export async function loadCertificatoData(
  supabase: SupabaseClient,
  certificatoId: string
): Promise<LoadResult> {
  const { data: cert } = await supabase
    .from('certificati_competenze')
    .select('*')
    .eq('id', certificatoId)
    .maybeSingle()
  if (!cert) return { error: 'Certificato non trovato', status: 404 }

  const [{ data: livelli }, { data: alunno }, { data: section }] = await Promise.all([
    supabase
      .from('certificato_competenza_livelli')
      .select('competenza_codice, livello, note, ordine')
      .eq('certificato_id', certificatoId)
      .order('ordine'),
    supabase.from('alunni').select('nome, cognome, data_nascita, codice_fiscale').eq('id', cert.alunno_id).maybeSingle(),
    cert.section_id
      ? supabase.from('sections').select('name, scuola_id').eq('id', cert.section_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  let scuolaNome = 'Istituto'
  if (cert.scuola_id) {
    const { data: s } = await supabase.from('schools').select('nome').eq('id', cert.scuola_id).maybeSingle()
    scuolaNome = (s as { nome?: string } | null)?.nome ?? 'Istituto'
  }

  const livMap = new Map(
    ((livelli ?? []) as { competenza_codice: string; livello: 'A' | 'B' | 'C' | 'D' | null; note: string | null }[]).map((l) => [l.competenza_codice, l])
  )
  const competenze = COMPETENZE_CHIAVE.map((c) => {
    const l = livMap.get(c.codice)
    return { etichetta: c.etichetta, livello: l?.livello ?? null, note: l?.note ?? null }
  })
  const significative = livMap.get(COMPETENZE_SIGNIFICATIVE_CODICE)?.note ?? null

  return {
    scuolaId: cert.scuola_id ?? null,
    data: {
      scuolaNome,
      classe: (section as { name?: string } | null)?.name ?? '',
      anno: cert.anno_scolastico ?? '',
      alunno: `${alunno?.cognome ?? ''} ${alunno?.nome ?? ''}`.trim(),
      alunnoNato: alunno?.data_nascita ?? null,
      codiceFiscale: alunno?.codice_fiscale ?? null,
      competenze,
      competenzeSignificative: significative,
      // Il dirigente firmatario viene iniettato da generaCertificato (utente corrente).
      dirigente: null,
      firmatoIl: cert.generato_il ?? null,
    },
  }
}

/** Archivia il PDF in Storage + marca il certificato firmato + registra lo slot FEA del dirigente. */
export async function persistCertificato(
  supabase: SupabaseClient,
  certificatoId: string,
  pdf: Buffer,
  userId: string,
  data: CertificatoData
): Promise<void> {
  const { data: buckets } = await supabase.storage.listBuckets()
  if (!buckets?.some((b: { name: string }) => b.name === CERTIFICATI_BUCKET)) {
    await supabase.storage.createBucket(CERTIFICATI_BUCKET, {
      public: false,
      allowedMimeTypes: ['application/pdf'],
      fileSizeLimit: 10 * 1024 * 1024,
    })
  }
  const path = `${certificatoId}.pdf`
  await supabase.storage.from(CERTIFICATI_BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true })

  const firmatoIl = data.firmatoIl ?? new Date().toISOString()
  await supabase
    .from('certificati_competenze')
    .update({
      file_url: path,
      stato: 'firmato',
      generato_da: userId,
      generato_il: firmatoIl,
      firma_applicativa: { dirigente: data.dirigente, firmato_il: firmatoIl, metodo: 'firma_applicativa' },
      updated_at: firmatoIl,
    })
    .eq('id', certificatoId)

  // Slot firmatario FEA del dirigente (riusa il ledger DL-007).
  await recordSignerSlot(supabase, {
    entitaTipo: 'certificato_competenze',
    entitaId: certificatoId,
    signerUserId: userId,
    completionPolicy: 'any-one',
    signatureLog: {
      method: 'CONFERMA_APP',
      provider: 'Firma applicativa dirigente',
      email: '',
      ip: '',
      user_agent: '',
      signed_at: firmatoIl,
      timestamp: firmatoIl,
      compliance: 'CAD Art. 20 / DPR 445/2000',
    },
  })
  await logFeaEvent(supabase, {
    entitaTipo: 'certificato_competenze',
    entitaId: certificatoId,
    signerUserId: userId,
    evento: 'signed',
  })
}

/** Genera (e firma) il certificato di un alunno; ritorna il PDF. */
export async function generaCertificato(
  supabase: SupabaseClient,
  certificatoId: string,
  userId: string,
  persist: boolean
): Promise<{ pdf?: Buffer; error?: string; status?: number }> {
  const loaded = await loadCertificatoData(supabase, certificatoId)
  if (loaded.error) return { error: loaded.error, status: loaded.status }

  const { data: u } = await supabase.from('utenti').select('nome, cognome').eq('id', userId).maybeSingle()
  const dirigente = u ? `${u.nome ?? ''} ${u.cognome ?? ''}`.trim() : null
  const firmatoIl = new Date().toISOString()
  const data: CertificatoData = { ...loaded.data!, dirigente, firmatoIl }

  const pdf = buildCertificatoPdf(data)
  if (persist) {
    try {
      await persistCertificato(supabase, certificatoId, pdf, userId, data)
    } catch (e) {
      console.error('persist certificato:', e)
    }
  }
  return { pdf }
}
