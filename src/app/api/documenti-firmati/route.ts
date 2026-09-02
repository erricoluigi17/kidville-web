import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { STATO_ISCRITTO } from '@/lib/alunni/stato'
import { resolveScuoleAttive, restringiSedi, sezioniVisibili, vedeTutteLeClassi } from '@/lib/auth/scope'
import { sezioniContitolari } from '@/lib/primaria/fascicolo-rbac'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import {
  daCertificatoMedico,
  daFascicolo,
  daModuloFirmato,
  filtraPerVisibilita,
  ordinaDocumenti,
  riepilogo,
  type DocumentoAlunno,
} from '@/lib/documenti/registro'
import { withRoute } from '@/lib/logging/with-route'
// La prosa italiana viene dal catalogo condiviso, non scritta qui: è la STESSA
// stringa che legge un utente italiano, e il `codice` accanto è ciò che il client
// traduce per chi guarda l'app in inglese.
import CATALOGO from '../../../../messages/it/shared.json'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * GET /api/documenti-firmati — l'archivio dei documenti dell'alunno.
 *
 * Legge TRE tabelle che esistono già e non ne crea nessuna: i moduli firmati
 * con OTP dal genitore (`forms_submissions`), il fascicolo personale
 * (`student_documents`) e i certificati medici (`certificati_medici`).
 *
 * ─── Chi vede cosa ───────────────────────────────────────────────────────────
 * Il perimetro è a due strati, e il secondo è più stretto del primo:
 *
 *  1. SCOPE ORDINARIO — sede attiva (`resolveScuoleAttive`) e, per l'educator,
 *     le sole sezioni assegnate (`sezioniVisibili`). Vale per tutto.
 *  2. GATE SANITARIO — i documenti sanitari (fascicolo, certificati medici, e i
 *     prestampati sanitari quando arriveranno) sono visibili alla segreteria del
 *     proprio plesso e alle insegnanti contitolari della sezione dell'alunno.
 *     A nessun altro. È la stessa regola di `puoAccedereFascicolo`, applicata in
 *     blocco perché qui gli alunni sono molti.
 *
 * Un educator con sezioni assegnate vede quindi i documenti amministrativi delle
 * proprie sezioni e i sanitari degli stessi bambini; fuori da lì, niente — non
 * una riga oscurata, proprio nessuna riga.
 *
 * ⚠️ Perché il gate sanitario non coincide con lo scope: `sezioniVisibili` legge
 * `utenti_sezioni`, il gate del fascicolo anche `utenti_sezioni_materie`. Un
 * docente assegnato per sola materia passa il secondo e non il primo. Tenerli
 * separati è voluto: il primo decide quali bambini si vedono, il secondo se di
 * quei bambini si vedono anche i documenti sanitari.
 */

const getQuerySchema = z.object({
  scuolaId: zUuid.optional(),
  sectionId: zUuid.optional(),
  alunnoId: zUuid.optional(),
  /** Nome della classe/sezione come scritto in anagrafica (`alunni.classe_sezione`). */
  classe: z.string().trim().min(1).max(120).optional(),
  categoria: z.enum(['sanitario', 'amministrativo']).optional(),
  soloFirmati: z.enum(['0', '1']).optional(),
  ricerca: z.string().trim().min(1).max(120).optional(),
  /** La segreteria può chiedere anche i non più iscritti: i documenti si conservano dieci anni. */
  includiNonIscritti: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

interface AlunnoScope {
  id: string
  nome: string | null
  cognome: string | null
  classe_sezione: string | null
  section_id: string | null
  scuola_id: string | null
}

export const GET = withRoute('documenti-firmati:GET', async (request: NextRequest) => {
  try {
    // Gate di ruolo: personale docente e segreteria. Esclude genitore e cuoca —
    // nel modello app-level un genitore ha un userId valido, e senza questa riga
    // gli basterebbe chiamare la route con il proprio id.
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const user = auth.user

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { scuolaId, sectionId, alunnoId, classe, categoria, soloFirmati, ricerca, limit, includiNonIscritti } =
      q.data

    const supabase = await createAdminClient()

    // ── 1. Gli alunni che questo utente può vedere ───────────────────────────
    const plessi = await resolveScuoleAttive(request, supabase, user)
    if (plessi.length === 0) {
      return NextResponse.json({ success: true, data: [], alunni: [], riepilogo: riepilogo([]) })
    }
    /**
     * La sede chiesta dal filtro deve essere fra quelle accessibili: un uuid
     * scritto a mano nella query non allarga il perimetro.
     *
     * ⚠️ QUI C'ERA UN `p === scuolaId`, cioè un confronto CON DISTINZIONE DI
     * MAIUSCOLE, ed è il difetto per cui `formaConfronto` esiste. In Postgres
     * `uuid` è un TIPO: `'AAAA-…'` e `'aaaa-…'` sono lo stesso valore e la riga
     * si trova; in JavaScript sono due stringhe diverse. Misurato sui dati veri
     * il 2026-07-31: chi chiedeva la PROPRIA sede in maiuscolo si prendeva un
     * **403**, e insieme al diniego accendeva un contatore nato come segnale di
     * sicurezza. Due danni, e il secondo è quello che dura — una lettura negata
     * la si vede, un segnale riempito di falsi positivi no.
     *
     * `restringiSedi` fa l'intersezione senza maiuscole e restituisce la forma
     * CANONICA del database, non la stringa arrivata dal client; `null` è «hai
     * chiesto un plesso che non è tuo», ed è l'unico caso che si rifiuta.
     */
    const plessiEffettivi = restringiSedi(plessi, scuolaId)
    if (plessiEffettivi === null || plessiEffettivi.length === 0) {
      return rifiutoSede('SEDE_NON_ACCESSIBILE')
    }

    // Le sezioni PRIMA della query, non dopo: un educator senza sezioni assegnate
    // esce di qui senza aver chiesto niente al database. Costruire la query e poi
    // scartarla funzionerebbe lo stesso, ma lascia in mezzo al codice un oggetto
    // che sembra pronto per essere eseguito — ed è il tipo di riga che un domani
    // qualcuno esegue davvero.
    const mieSezioni = await sezioniVisibili(supabase, user)
    if (mieSezioni !== null && mieSezioni.length === 0) {
      return NextResponse.json({ success: true, data: [], alunni: [], riepilogo: riepilogo([]) })
    }

    let queryAlunni = supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, section_id, scuola_id')
      .in('scuola_id', plessiEffettivi)
      .is('anonimizzato_il', null)

    if (mieSezioni !== null) queryAlunni = queryAlunni.in('section_id', mieSezioni)

    // Di norma l'elenco parla di chi è iscritto ORA. La segreteria — e solo lei —
    // può chiedere anche gli archiviati: il fascicolo di un bambino ritirato non
    // sparisce con lui, si conserva dieci anni, e cercarlo è una cosa che capita.
    const ancheNonIscritti = includiNonIscritti === '1' && vedeTutteLeClassi(user)
    if (!ancheNonIscritti) queryAlunni = queryAlunni.eq('stato', STATO_ISCRITTO)
    if (sectionId) queryAlunni = queryAlunni.eq('section_id', sectionId)
    if (classe) queryAlunni = queryAlunni.eq('classe_sezione', classe)
    if (alunnoId) queryAlunni = queryAlunni.eq('id', alunnoId)
    if (ricerca) {
      const term = ricerca.replace(/[%,()]/g, ' ').trim()
      if (term) queryAlunni = queryAlunni.or(`nome.ilike.%${term}%,cognome.ilike.%${term}%`)
    }

    // PostgREST non lancia: il valore di ritorno va controllato, sempre.
    const { data: alunniRaw, error: erroreAlunni } = await queryAlunni
      .order('cognome', { ascending: true })
      .limit(1000)
    if (erroreAlunni) {
      logErrore(
        { operazione: 'documenti-firmati:GET', evento: `alunni:${erroreAlunni.code ?? 'ignoto'}` },
        erroreAlunni,
      )
      return NextResponse.json(
        { error: CATALOGO.erroreDocumentiElencoNonLetto, codice: 'DOCUMENTI_ELENCO_NON_LETTO' },
        { status: 500 },
      )
    }

    const alunni = (alunniRaw ?? []) as AlunnoScope[]
    if (alunni.length === 0) {
      return NextResponse.json({ success: true, data: [], alunni: [], riepilogo: riepilogo([]) })
    }
    const idAlunni = alunni.map((a) => a.id)

    // ── 2. Chi ha accesso ai SANITARI, fra questi alunni ─────────────────────
    // Staff: tutti quelli del proprio plesso (già filtrati sopra). Educator: i
    // bambini delle sezioni di cui è contitolare, per assegnazione o per materia.
    let conAccessoSanitario: Set<string>
    if (vedeTutteLeClassi(user)) {
      conAccessoSanitario = new Set(idAlunni)
    } else {
      const sezioni = new Set(await sezioniContitolari(supabase, user.id))
      conAccessoSanitario = new Set(
        alunni.filter((a) => a.section_id && sezioni.has(a.section_id)).map((a) => a.id),
      )
    }

    // ── 3. Le tre fonti ──────────────────────────────────────────────────────
    const [moduli, fascicolo, certificati] = await Promise.all([
      supabase
        .from('forms_submissions')
        .select('id, student_id, form_id, is_signed, signature_log, created_at, origine')
        .in('student_id', idAlunni),
      supabase
        .from('student_documents')
        .select('id, student_id, document_type, descrizione, file_name, expiry_date, created_at')
        .in('student_id', idAlunni),
      supabase
        .from('certificati_medici')
        .select('id, alunno_id, data_inizio, data_fine, stato, creato_il')
        .in('alunno_id', idAlunni),
    ])

    // Una fonte che fallisce non deve svuotare l'elenco in silenzio: si registra
    // quale è caduta e si prosegue con le altre, dichiarandolo nella risposta.
    const fontiCadute: string[] = []
    for (const [nome, res] of [
      ['forms_submissions', moduli],
      ['student_documents', fascicolo],
      ['certificati_medici', certificati],
    ] as const) {
      if (res.error) {
        fontiCadute.push(nome)
        logErrore(
          { operazione: 'documenti-firmati:GET', evento: `${nome}:${res.error.code ?? 'ignoto'}` },
          res.error,
        )
      }
    }

    // Titoli dei modelli, per dare un nome ai moduli firmati.
    const idModelli = [
      ...new Set(
        ((moduli.data ?? []) as { form_id: string | null }[])
          .map((m) => m.form_id)
          .filter((id): id is string => !!id),
      ),
    ]
    const titoli = new Map<string, string>()
    if (idModelli.length > 0) {
      const { data: modelli, error: erroreModelli } = await supabase
        .from('forms_templates')
        .select('id, title, form_type')
        .in('id', idModelli)
      if (erroreModelli) {
        logErrore(
          { operazione: 'documenti-firmati:GET', evento: `forms_templates:${erroreModelli.code ?? 'ignoto'}` },
          erroreModelli,
        )
      }
      for (const m of (modelli ?? []) as { id: string; title: string | null }[]) {
        if (m.title) titoli.set(m.id, m.title)
      }
    }

    // ── 4. Un elenco solo ────────────────────────────────────────────────────
    let documenti: DocumentoAlunno[] = [
      ...((moduli.data ?? []) as Parameters<typeof daModuloFirmato>[0][])
        .map((r) => daModuloFirmato(r, r.form_id ? (titoli.get(r.form_id) ?? null) : null))
        .filter((d): d is DocumentoAlunno => d !== null),
      ...((fascicolo.data ?? []) as Parameters<typeof daFascicolo>[0][]).map(daFascicolo),
      ...((certificati.data ?? []) as Parameters<typeof daCertificatoMedico>[0][]).map(
        daCertificatoMedico,
      ),
    ]

    documenti = filtraPerVisibilita(documenti, conAccessoSanitario)
    if (categoria) documenti = documenti.filter((d) => d.categoria === categoria)
    if (soloFirmati === '1') documenti = documenti.filter((d) => d.firmato)
    documenti = ordinaDocumenti(documenti)

    const totale = documenti.length
    const troncato = totale > limit
    if (troncato) documenti = documenti.slice(0, limit)

    // Successo loggato: senza, «nessun log» non distingue «tutto ok» da «non è
    // mai partito niente». Solo conteggi e uuid — mai un titolo, mai un nome.
    logEvento('fascicolo', 'info', {
      operazione: 'documenti-firmati:GET',
      utente: user.id,
      ruolo: user.role,
      alunni: alunni.length,
      documenti: totale,
      sanitari_visibili: conAccessoSanitario.size,
      fonti_cadute: fontiCadute.length,
      troncato,
    })

    return NextResponse.json({
      success: true,
      data: documenti,
      alunni: alunni.map((a) => ({
        id: a.id,
        nome: a.nome,
        cognome: a.cognome,
        classe_sezione: a.classe_sezione,
        section_id: a.section_id,
        scuola_id: a.scuola_id,
      })),
      riepilogo: riepilogo(documenti),
      totale,
      troncato,
      fonti_cadute: fontiCadute,
    })
  } catch (err) {
    // Il messaggio interno resta nel log: su una rotta che elenca documenti
    // sanitari di minori, il testo di un'eccezione può nominare tabelle e
    // vincoli. Al client basta sapere che il guasto è nostro.
    logErrore({ operazione: 'documenti-firmati:GET', stato: 500 }, err)
    return NextResponse.json(
      { error: CATALOGO.erroreDocumentiElencoNonLetto, codice: 'DOCUMENTI_ELENCO_NON_LETTO' },
      { status: 500 },
    )
  }
})
