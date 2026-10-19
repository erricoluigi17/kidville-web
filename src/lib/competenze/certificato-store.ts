import type { SupabaseClient } from '@supabase/supabase-js'
import { buildCertificatoPdf, type CertificatoData } from './certificato-pdf'
import { COMPETENZE_CHIAVE, COMPETENZE_SIGNIFICATIVE_CODICE } from './modello'
import { suggerisciLivello, type GiudizioPerMateria } from './livello-mapping'
import { recordSignerSlot } from '@/lib/fea/slots'
import { logFeaEvent } from '@/lib/fea/audit'
import { logEvento } from '@/lib/logging/logger'

export const CERTIFICATI_BUCKET = 'certificati-competenze'

/**
 * UN GUASTO DEL DATABASE NON È UN «NON TROVATO» (fase 11, «errori non ignorati»).
 *
 * PostgREST non lancia: `{ data: null, error }`. Qui il `null` diventava «Sezione non trovata»
 * (404), «nessuno scrutinio chiuso» (409), un anno scolastico vuoto scritto nella chiave di
 * `certificati_competenze`, livelli suggeriti tutti `null` scritti SOPRA quelli già messi, un
 * certificato firmato senza nome del dirigente. Il contratto delle funzioni resta
 * `{ error, status }`: un guasto è `status: 500`, con la sua riga `error` (l'errore vero va nel
 * log, che lo redige; nella risposta solo la frase).
 */
function guastoDb(operazione: string, esito: string, error: unknown, tipo: 'lettura' | 'scrittura' = 'lettura') {
  logEvento('competenze', 'error', { operazione, esito }, error)
  return {
    error: tipo === 'scrittura' ? 'Scrittura sul database non riuscita' : 'Lettura dal database non riuscita',
    status: 500,
  }
}

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
  const { data: section, error: errSection } = await supabase
    .from('sections')
    .select('id, name, school_type, scuola_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (errSection) return guastoDb('competenze/valida', 'sezione-non-letta', errSection)
  if (!section) return { error: 'Sezione non trovata', status: 404 }
  const livello = Number(section.name?.match(/[1-5]/)?.[0] ?? 0)
  if (section.school_type !== 'primaria' || livello !== 5) {
    return { error: 'Il certificato delle competenze è previsto solo per la classe quinta primaria', status: 422 }
  }
  const { data: scrutinio, error: errScrutinio } = await supabase
    .from('scrutini')
    .select('id, stato, periodo_id')
    .eq('section_id', sectionId)
    .eq('stato', 'chiuso')
    .order('creato_il', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (errScrutinio) return guastoDb('competenze/valida', 'scrutinio-non-letto', errScrutinio)
  if (!scrutinio) return { error: 'Nessuno scrutinio finale chiuso per la sezione', status: 409 }
  const { data: periodo, error: errPeriodo } = await supabase
    .from('scrutinio_periodi')
    .select('anno_scolastico')
    .eq('id', scrutinio.periodo_id)
    .maybeSingle()
  // L'anno scolastico è metà della chiave di `certificati_competenze` (`alunno_id,anno_scolastico`):
  // un guasto letto come '' scriverebbe una bozza su un anno che non esiste.
  if (errPeriodo) return guastoDb('competenze/valida', 'periodo-non-letto', errPeriodo)
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
  // L'upsert qui sotto RISCRIVE `livello` su righe che possono già esistere: giudizi o materie
  // non letti diventerebbero otto livelli `null` sopra quelli suggeriti la volta prima.
  const { data: giudizi, error: errGiudizi } = await supabase
    .from('scrutinio_giudizi')
    .select('materia_id, giudizio_sintetico')
    .eq('scrutinio_id', v.scrutinioId)
    .eq('alunno_id', alunnoId)
  if (errGiudizi) return guastoDb('competenze/seed', 'giudizi-non-letti', errGiudizi)
  const { data: materie, error: errMaterie } = await supabase
    .from('materie')
    .select('id, codice')
    .eq('section_id', sectionId)
  if (errMaterie) return guastoDb('competenze/seed', 'materie-non-lette', errMaterie)
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
  const { error: errLivelli } = await supabase
    .from('certificato_competenza_livelli')
    .upsert(rows, { onConflict: 'certificato_id,competenza_codice' })
  // La bozza senza le sue righe di competenza non è una bozza: il PDF uscirebbe vuoto.
  if (errLivelli) return guastoDb('competenze/seed', 'livelli-non-scritti', errLivelli, 'scrittura')

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
  const { data: cert, error: errCert } = await supabase
    .from('certificati_competenze')
    .select('*')
    .eq('id', certificatoId)
    .maybeSingle()
  if (errCert) return guastoDb('competenze/load', 'certificato-non-letto', errCert)
  if (!cert) return { error: 'Certificato non trovato', status: 404 }

  // Tutte e tre sono il CONTENUTO di un documento che si firma e si archivia: un guasto non può
  // diventare un certificato senza livelli, senza nome o senza classe.
  const [
    { data: livelli, error: errLivelli },
    { data: alunno, error: errAlunno },
    { data: section, error: errSection },
  ] = await Promise.all([
    supabase
      .from('certificato_competenza_livelli')
      .select('competenza_codice, livello, note, ordine')
      .eq('certificato_id', certificatoId)
      .order('ordine'),
    supabase.from('alunni').select('nome, cognome, data_nascita, codice_fiscale').eq('id', cert.alunno_id).maybeSingle(),
    cert.section_id
      ? supabase.from('sections').select('name, scuola_id').eq('id', cert.section_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (errLivelli) return guastoDb('competenze/load', 'livelli-non-letti', errLivelli)
  if (errAlunno) return guastoDb('competenze/load', 'alunno-non-letto', errAlunno)
  if (errSection) return guastoDb('competenze/load', 'sezione-non-letta', errSection)

  let scuolaNome = 'Istituto'
  if (cert.scuola_id) {
    // Il nome dell'istituto è nell'intestazione del certificato firmato: «Istituto» resta il
    // ripiego di una sede senza nome, non di un database che non ha risposto.
    const { data: s, error: errScuola } = await supabase.from('schools').select('nome').eq('id', cert.scuola_id).maybeSingle()
    if (errScuola) return guastoDb('competenze/load', 'scuola-non-letta', errScuola)
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
  const { error: errUpload } = await supabase.storage
    .from(CERTIFICATI_BUCKET)
    .upload(path, pdf, { contentType: 'application/pdf', upsert: true })
  // Senza il file, marcare «firmato» con `file_url` scritto sarebbe promettere una copia che non
  // esiste. Si lancia: `generaCertificato` lo registra come `certificato-non-archiviato`.
  if (errUpload) throw new Error('Caricamento del PDF del certificato non riuscito', { cause: errUpload })

  const firmatoIl = data.firmatoIl ?? new Date().toISOString()
  const { error: errFirma } = await supabase
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
  // Il certificato non risulta firmato: lo slot FEA e l'evento `signed` qui sotto direbbero il
  // falso. Si lancia, come per il caricamento.
  if (errFirma) throw new Error('Marcatura del certificato come firmato non riuscita', { cause: errFirma })

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

  // Il nome del dirigente È la firma applicativa del documento: un guasto non può produrre un
  // certificato firmato da nessuno.
  const { data: u, error: errDirigente } = await supabase.from('utenti').select('nome, cognome').eq('id', userId).maybeSingle()
  if (errDirigente) return guastoDb('competenze/genera', 'dirigente-non-letto', errDirigente)
  const dirigente = u ? `${u.nome ?? ''} ${u.cognome ?? ''}`.trim() : null
  const firmatoIl = new Date().toISOString()
  const data: CertificatoData = { ...loaded.data!, dirigente, firmatoIl }

  const pdf = buildCertificatoPdf(data)
  if (persist) {
    try {
      await persistCertificato(supabase, certificatoId, pdf, userId, data)
    } catch (e) {
      // Non bloccante: il PDF viene comunque restituito al chiamante, ma NON è
      // stato archiviato — cioè la copia firmata non esiste a sistema. È un
      // errore, non una nota. `data` non va a log: contiene i livelli di
      // competenza dell'alunno (D.M. 14/2024), che sono la sua valutazione.
      logEvento(
        'competenze',
        'error',
        {
          operazione: 'generaCertificato:persist',
          esito: 'certificato-non-archiviato',
          certificato_id: certificatoId,
        },
        e,
      )
    }
  }
  return { pdf }
}
