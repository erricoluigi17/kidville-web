/**
 * L'ELENCO DI CLASSE DELLA SEGRETERIA — caricarlo, e vedere subito cosa non torna.
 *
 * ─── PERCHÉ QUESTA PORTA ESISTE ─────────────────────────────────────────────
 * Il form pubblico raccoglie tutto tranne le due cose che decidono un'iscrizione:
 * IN QUALE CLASSE va il bambino e QUANTO paga. Quelle vivono in un foglio Excel
 * per sede, che la segreteria prepara a mano — il nome del foglio è la classe, la
 * cifra accanto al nome è la retta.
 *
 * Senza questa porta il foglio finirebbe in tabella solo per mano di chi ha
 * accesso al database, cioè mai: il giro di ogni mattina girerebbe a vuoto e
 * nessuno saprebbe perché.
 *
 * ─── LE ANOMALIE SI MOSTRANO SUBITO, NON IL GIORNO CHE BLOCCANO UN INVIO ────
 * `leggiElenco` non corregge niente e non scarta niente: riporta le righe come
 * sono e, di fianco, le difformità (rette vuote, rimandi ciechi, nomi ripetuti,
 * cifre fuori scala). La risposta del POST le restituisce TUTTE, all'istante.
 * Misurate sul file vero di Giugliano: 338 righe, 36 rimandi, 29 rette vuote, una
 * non numerica, 4 nomi ripetuti, 46 rette fuori scala. Scoprirle una per volta,
 * settimane dopo, sotto forma di «domanda da controllare», sarebbe lo stesso
 * lavoro fatto nel modo più caro possibile.
 *
 * ─── L'ORDINE DEI PASSI, E PERCHÉ NON SI CAMBIA ─────────────────────────────
 *   1. gate di ruolo          chi bussa
 *   2. sede di scrittura      su quale plesso, DICHIARATA — mai indovinata
 *   3. il corpo               `parseMultipart`, mai `request.formData()` nudo
 *   4. dimensione e tipo      prima di toccare lo Storage
 *   5. lettura del foglio     in memoria: se non si apre, non si carica niente
 *   6. il bucket privato
 *   7. la riga di registro    e se non si scrive, il file si RITIRA
 *   8. le righe
 * Il corpo si legge DOPO il gate: bufferizzare 4 MB da chiunque prima di sapere
 * chi bussa non è una svista di stile, è una porta aperta.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura, resolveScuoleAttive } from '@/lib/auth/scope'
import { parseMultipart, parseData, parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { LIMITE_UPLOAD_BYTE, LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'
import { leggiElenco, type Anomalia } from '@/lib/iscrizioni/import/elenco'

const OPERAZIONE_POST = 'admin/iscrizioni/elenco:POST'
const OPERAZIONE_GET = 'admin/iscrizioni/elenco:GET'
export const BUCKET_ELENCHI = 'iscrizioni_elenchi'

/**
 * I DUE TIPI AMMESSI, copiati dalla migrazione e non «più o meno gli stessi».
 *
 * `supabase/migrations/20260816201223_iscrizioni_import_massivo.sql:183` dichiara
 * esattamente questi due su `storage.buckets.allowed_mime_types`. Una divergenza
 * non si vedrebbe come un errore di configurazione: si vedrebbe come un gate
 * applicativo che dice «va bene» e uno Storage che risponde 500 senza spiegare —
 * ed è già successo su `gallery`, dove il bucket accettava 50 MB e la route 200,
 * per mesi.
 *
 * Nessun gate condiviso copre l'xlsx: `MIME_ALLEGATI_AMMESSI` ha immagini, PDF e
 * Word, `MIME_ALLEGATO_PUBBLICO` solo PDF e immagini. Riusarli qui vorrebbe dire
 * accettare un `.docx` come elenco di classe.
 */
export const MIME_ELENCO = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
] as const

/**
 * Alcuni browser mandano `application/octet-stream` per un `.xlsx` — succede su
 * Windows quando l'associazione di sistema manca. Il tipo dichiarato dal client
 * non è mai una prova: la prova vera è che `leggiElenco` riesca ad aprirlo, e
 * quella arriva due passi più sotto. Qui si scarta ciò che è palesemente altro.
 */
const ESTENSIONI_ELENCO = /\.(xlsx|xls)$/i

const queryScuolaSchema = z.object({
  scuola_id: z.string().uuid().optional(),
})

const fileSchema = z.object({
  file: z.instanceof(File, { error: 'Nessun foglio ricevuto' }),
})

interface RigaElencoDb {
  classe: string
  nome: string
  nome_norm: string
  riga_excel: number
  retta: number | null
  retta_testo: string | null
}

export const POST = withRoute('admin/iscrizioni/elenco:POST', async (request: NextRequest) => {
  // ── 1. CHI BUSSA ────────────────────────────────────────────────────────
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const supabase = await createAdminClient()

  // ── 2. SU QUALE SEDE ────────────────────────────────────────────────────
  // Dichiarata, mai indovinata: un elenco di classe archiviato nel plesso
  // sbagliato manderebbe interi bambini nelle sezioni di un'altra scuola, in
  // silenzio. Con tre sedi `resolveScuolaScrittura` risponde 400 se nessuna è
  // indicata, ed è la risposta giusta.
  const q = parseQuery(request, queryScuolaSchema)
  if ('response' in q) return q.response
  const sw = await resolveScuolaScrittura(request, supabase, auth.user, q.data.scuola_id)
  if (sw.response) return sw.response
  const scuolaId = sw.scuolaId
  if (!scuolaId) {
    logEvento('multi_sede', 'error', { operazione: OPERAZIONE_POST, esito: 'sede-non-risolta' })
    return NextResponse.json(
      { error: 'Specificare la sede di cui si sta caricando l’elenco', codice: 'SEDE_DA_SPECIFICARE' },
      { status: 400 },
    )
  }

  // ── 3. IL CORPO ─────────────────────────────────────────────────────────
  const form = await parseMultipart(request)
  if ('response' in form) return form.response
  const parsed = parseData(fileSchema, { file: form.data.get('file') })
  if ('response' in parsed) return parsed.response
  const { file } = parsed.data

  // ── 4. DIMENSIONE E TIPO ────────────────────────────────────────────────
  if (file.size > LIMITE_UPLOAD_BYTE) {
    logEvento('storage', 'warn', {
      operazione: OPERAZIONE_POST,
      esito: 'foglio-oltre-limite',
      bucket: BUCKET_ELENCHI,
      sede_id: scuolaId,
      byte: file.size,
    })
    return NextResponse.json(
      { error: `Il foglio è troppo grande: può pesare al massimo ${LIMITE_UPLOAD_MB} MB`, codice: 'ELENCO_CLASSI_TROPPO_GRANDE' },
      { status: 413 },
    )
  }

  const tipoDichiarato = (file.type || '').toLowerCase()
  const nomeAmmesso = ESTENSIONI_ELENCO.test(file.name || '')
  if (!nomeAmmesso && !(MIME_ELENCO as readonly string[]).includes(tipoDichiarato)) {
    logEvento('storage', 'warn', {
      operazione: OPERAZIONE_POST,
      esito: 'foglio-tipo-non-ammesso',
      bucket: BUCKET_ELENCHI,
      sede_id: scuolaId,
      // Il TIPO sì, il NOME del file no: un elenco di classe si chiama spesso col
      // nome del plesso e dell'anno, ma non è detto — e non è un dato da loggare.
      mime: tipoDichiarato || 'assente',
    })
    return NextResponse.json(
      { error: 'Serve un foglio di calcolo Excel (.xlsx o .xls)', codice: 'ELENCO_CLASSI_TIPO_NON_AMMESSO' },
      { status: 415 },
    )
  }

  // ── 5. SI APRE? ─────────────────────────────────────────────────────────
  // Prima dello Storage, di proposito: un file che non si apre non deve
  // lasciare un oggetto nel bucket, e la segreteria deve saperlo subito — non
  // domani, quando il giro non troverà nessuna classe.
  const dati = await file.arrayBuffer()
  let letto
  try {
    letto = leggiElenco(dati)
  } catch (err) {
    logEvento('iscrizione', 'warn', {
      operazione: OPERAZIONE_POST,
      esito: 'foglio-illeggibile',
      sede_id: scuolaId,
      byte: file.size,
    }, err)
    return NextResponse.json(
      { error: 'Il file è arrivato ma non si apre come foglio di calcolo', codice: 'ELENCO_CLASSI_ILLEGGIBILE' },
      { status: 400 },
    )
  }

  if (letto.righe.length === 0) {
    // Non è un guasto ed è un rifiuto: un elenco vuoto SOSTITUIREBBE quello
    // buono e spegnerebbe il giro di domani senza che nessun errore lo dica.
    logEvento('iscrizione', 'warn', {
      operazione: OPERAZIONE_POST,
      esito: 'foglio-senza-righe',
      sede_id: scuolaId,
    })
    return NextResponse.json(
      { error: 'Il foglio non contiene nessun alunno: controlla che sia il file giusto', codice: 'ELENCO_CLASSI_ILLEGGIBILE' },
      { status: 400 },
    )
  }

  // ── 6. IL BUCKET PRIVATO ────────────────────────────────────────────────
  // Il percorso lo genera il SERVER: un nome scelto dal client permetterebbe di
  // sovrascrivere l'elenco di un'altra sede. Il nome originale resta nella riga
  // di registro, dove serve a far riconoscere il file alla segreteria.
  const estensione = ESTENSIONI_ELENCO.exec(file.name || '')?.[1]?.toLowerCase() ?? 'xlsx'
  const path = `${scuolaId}/${crypto.randomUUID()}.${estensione}`
  const { error: erroreUpload } = await supabase.storage.from(BUCKET_ELENCHI).upload(path, dati, {
    upsert: false,
    contentType: MIME_ELENCO[0],
  })
  if (erroreUpload) {
    logEvento('storage', 'error', {
      operazione: OPERAZIONE_POST,
      esito: 'foglio-non-caricato',
      bucket: BUCKET_ELENCHI,
      sede_id: scuolaId,
    }, erroreUpload)
    return NextResponse.json(
      { error: 'Non è stato possibile salvare il foglio', codice: 'ELENCO_CLASSI_NON_SALVATO' },
      { status: 500 },
    )
  }

  /** Toglie l'oggetto appena caricato: un file che nessuna riga nomina è un
   *  orfano invisibile con centinaia di nomi di minori dentro. */
  const ritira = async () => {
    const { error } = await supabase.storage.from(BUCKET_ELENCHI).remove([path])
    if (error) {
      logEvento('storage', 'error', {
        operazione: OPERAZIONE_POST,
        esito: 'foglio-non-ritirato',
        bucket: BUCKET_ELENCHI,
        sede_id: scuolaId,
      }, error)
    }
  }

  // ── 7. LA RIGA DI REGISTRO ──────────────────────────────────────────────
  // L'elenco precedente si spegne PRIMA: l'indice unico parziale
  // `(scuola_id) where attivo` rifiuterebbe il secondo con un 23505, e un solo
  // elenco vivo per sede è precisamente ciò che impedisce al giro di scegliere
  // da solo quale delle due classi valga.
  const { error: erroreSpegni } = await supabase
    .from('iscrizioni_elenco_caricamenti')
    .update({ attivo: false })
    .eq('scuola_id', scuolaId)
    .eq('attivo', true)
  if (erroreSpegni) {
    await ritira()
    logEvento('db', 'error', {
      operazione: OPERAZIONE_POST,
      esito: 'elenco-precedente-non-spento',
      sede_id: scuolaId,
      error_code: (erroreSpegni as { code?: string }).code ?? null,
    }, erroreSpegni)
    return NextResponse.json(
      { error: 'Non è stato possibile sostituire l’elenco precedente', codice: 'ELENCO_CLASSI_NON_SALVATO' },
      { status: 500 },
    )
  }

  const { data: caricamento, error: erroreCaricamento } = await supabase
    .from('iscrizioni_elenco_caricamenti')
    .insert({
      scuola_id: scuolaId,
      storage_path: path,
      nome_file: file.name || `elenco.${estensione}`,
      righe_totali: letto.righe.length,
      anomalie: letto.anomalie,
      caricato_da: auth.user.id,
      attivo: true,
    })
    .select('id, caricato_il')
    .single()
  if (erroreCaricamento || !caricamento) {
    await ritira()
    logEvento('db', 'error', {
      operazione: OPERAZIONE_POST,
      esito: 'elenco-non-registrato',
      sede_id: scuolaId,
      error_code: (erroreCaricamento as { code?: string } | null)?.code ?? null,
    }, erroreCaricamento)
    return NextResponse.json(
      { error: 'L’elenco caricato non è stato salvato', codice: 'ELENCO_CLASSI_NON_SALVATO' },
      { status: 500 },
    )
  }

  const caricamentoId = (caricamento as { id: string }).id

  // ── 8. LE RIGHE ─────────────────────────────────────────────────────────
  // A blocchi: 338 righe in un solo INSERT passano, 900 in tre sedi no, e il
  // limite non si scopre in produzione il giorno del caricamento vero.
  const BLOCCO = 200
  const righeDb: RigaElencoDb[] = letto.righe.map((r) => ({
    classe: r.classe,
    nome: r.nome,
    nome_norm: r.nomeNorm,
    riga_excel: r.rigaExcel,
    retta: r.retta,
    retta_testo: r.rettaTesto,
  }))
  for (let i = 0; i < righeDb.length; i += BLOCCO) {
    const { error } = await supabase
      .from('iscrizioni_elenco_righe')
      .insert(righeDb.slice(i, i + BLOCCO).map((r) => ({ ...r, caricamento_id: caricamentoId, scuola_id: scuolaId })))
    if (error) {
      // A metà strada: si disfa tutto. Un elenco caricato per tre quarti è
      // peggio di nessun elenco — il giro di domani assegnerebbe le classi che
      // conosce e manderebbe alla segreteria tutto il resto, senza che il
      // motivo vero (un INSERT caduto) compaia da nessuna parte.
      await supabase.from('iscrizioni_elenco_caricamenti').delete().eq('id', caricamentoId)
      await ritira()
      logEvento('db', 'error', {
        operazione: OPERAZIONE_POST,
        esito: 'righe-elenco-non-scritte',
        sede_id: scuolaId,
        n: righeDb.length,
        error_code: (error as { code?: string }).code ?? null,
      }, error)
      return NextResponse.json(
        { error: 'L’elenco caricato non è stato salvato', codice: 'ELENCO_CLASSI_NON_SALVATO' },
        { status: 500 },
      )
    }
  }

  // Il SUCCESSO si logga: senza, «l'elenco non è mai stato caricato» e «è stato
  // caricato e non è successo niente» sarebbero la stessa assenza di righe.
  logEvento('iscrizione', 'info', {
    operazione: OPERAZIONE_POST,
    esito: 'elenco-caricato',
    entita_id: caricamentoId,
    sede_id: scuolaId,
    n: righeDb.length,
  })

  return NextResponse.json({
    success: true,
    caricamentoId,
    nomeFile: file.name || null,
    caricatoIl: (caricamento as { caricato_il: string }).caricato_il,
    righeTotali: righeDb.length,
    perClasse: letto.perClasse,
    anomalie: letto.anomalie,
  })
})

export const GET = withRoute('admin/iscrizioni/elenco:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const supabase = await createAdminClient()

  // In LETTURA si guardano le sedi attive, non una sola: la segreteria multi-sede
  // deve poter vedere quali plessi hanno già il loro elenco e quali no.
  const sedi = await resolveScuoleAttive(request, supabase, auth.user)
  // Uno scope vuoto NEGA, non toglie il filtro: senza questo ritorno una
  // segretaria senza plessi vedrebbe gli elenchi di tutte e tre le sedi.
  if (sedi.length === 0) return NextResponse.json({ elenchi: [] })

  const { data, error } = await supabase
    .from('iscrizioni_elenco_caricamenti')
    .select('id, scuola_id, nome_file, righe_totali, anomalie, caricato_il')
    .in('scuola_id', sedi)
    .eq('attivo', true)
    .order('caricato_il', { ascending: false })
  if (error) {
    const codice = (error as { code?: string }).code ?? ''
    // Il DB E2E della CI non conosce queste tabelle: non è un guasto, è un
    // ambiente in cui non c'è nessun elenco. Si degrada a vuoto, non a 500.
    if (['42P01', 'PGRST205', '42703', 'PGRST204'].includes(codice)) {
      logEvento('iscrizione', 'info', { operazione: OPERAZIONE_GET, esito: 'schema-assente' }, error)
      return NextResponse.json({ elenchi: [] })
    }
    logEvento('db', 'error', { operazione: OPERAZIONE_GET, esito: 'elenchi-non-letti', error_code: codice }, error)
    return NextResponse.json(
      { error: 'Non è stato possibile leggere gli elenchi', codice: 'ELENCO_CLASSI_NON_LETTO' },
      { status: 500 },
    )
  }

  const elenchi = await Promise.all(
    (data ?? []).map(async (r) => {
      const riga = r as {
        id: string; scuola_id: string; nome_file: string
        righe_totali: number; anomalie: Anomalia[] | null; caricato_il: string
      }
      const { data: perClasse } = await supabase
        .from('iscrizioni_elenco_righe')
        .select('classe')
        .eq('caricamento_id', riga.id)
      const conteggio = new Map<string, number>()
      for (const c of (perClasse ?? []) as { classe: string }[]) {
        conteggio.set(c.classe, (conteggio.get(c.classe) ?? 0) + 1)
      }
      return {
        id: riga.id,
        scuolaId: riga.scuola_id,
        nomeFile: riga.nome_file,
        righeTotali: riga.righe_totali,
        caricatoIl: riga.caricato_il,
        anomalie: riga.anomalie ?? [],
        perClasse: [...conteggio].map(([classe, alunni]) => ({ classe, alunni })),
      }
    }),
  )

  return NextResponse.json({ elenchi })
})
