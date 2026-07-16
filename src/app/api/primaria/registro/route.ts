import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { risolviValutatore } from '@/lib/audit/valutatore'
import { isOltreScadenza } from '@/lib/primaria/timelock'
import { enqueueNotifichePerAlunni, notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const getQuerySchema = z.object({
  sectionId: zUuid,
  data: zDataYMD,
})

// oraLezione: i client inviano il numero d'ordine della campanella; storicamente
// bastava un valore truthy (0/'' → 400), quindi union permissiva senza range.
// dataConsegnaCompiti resta stringa libera: '' ricade su null via `||` come oggi.
// tipoCompresenza senza enum: il codice attuale non lo vincola (confronta solo 'sostegno').
const postBodySchema = z.object({
  sectionId: zUuid,
  data: zDataYMD,
  oraLezione: z.union([z.number(), z.string()]).refine((v) => !!v, 'oraLezione obbligatoria'),
  materiaId: zUuid.nullish(),
  argomento: z.string().nullish(),
  compiti: z.string().nullish(),
  dataConsegnaCompiti: z.string().nullish(),
  tipoCompresenza: z.string().default('principale'),
  argomentoProprio: z.string().nullish(),
  compitiPropri: z.string().nullish(),
  destinatariIds: z.array(zUuid).nullish().transform((v) => v ?? []),
  // Segreteria/Direzione: docente titolare a cui attribuire la firma (risolviValutatore).
  docenteId: zUuid.nullish(),
  daOrario: z.boolean().nullish(),
})

// ISO date → giorno_settimana 1..6 (Lun..Sab); domenica (0) → 7 (fuori range).
function giornoSettimana(dataIso: string): number {
  const d = new Date(dataIso + 'T00:00:00').getDay() // 0=Dom..6=Sab
  return d === 0 ? 7 : d
}

// GET /api/primaria/registro?sectionId=&data=&userId=
// Restituisce la griglia del giorno: campanelle (con orario pre-compilato) +
// righe di registro firmate (con firme, contenuti propri e destinatari).
export const GET = withRoute('primaria/registro:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId, data } = q.data

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    const giorno = giornoSettimana(data)

    // NB: niente embed `utenti(...)` nei join — la relazione firme_docenti/
    // orario_settimanale → utenti non è nel cache PostgREST e farebbe fallire
    // l'intera query (la firma non comparirebbe). I nomi docente si risolvono a parte.
    const [{ data: campanelle }, { data: orarioCelle }, { data: righe }] = await Promise.all([
      supabase
        .from('campanelle')
        .select('id, ordine, ora_inizio, ora_fine, tipo')
        .eq('section_id', sectionId)
        .eq('giorno_settimana', giorno)
        .order('ordine'),
      supabase
        .from('orario_settimanale')
        .select('campanella_id, materia_id, docente_id, materie(nome, codice)')
        .eq('section_id', sectionId)
        .eq('giorno_settimana', giorno),
      supabase
        .from('registro_orario')
        .select(`
          id, ora_lezione, materia, materia_id, argomento, compiti, data_consegna_compiti, locked_il,
          materie(nome, codice),
          firme_docenti(id, maestra_id, tipo_compresenza, argomento_proprio, compiti_propri, firmato_il),
          registro_destinatari(id, firma_id, alunno_id),
          allegati_registro(id, ambito, tipo, file_url, file_name)
        `)
        .eq('section_id', sectionId)
        .eq('data', data)
        .order('ora_lezione'),
    ])

    // Risoluzione nomi docente (firme + orario) senza dipendere dalle FK del cache.
    const docenteIds = new Set<string>()
    for (const c of orarioCelle ?? []) if (c.docente_id) docenteIds.add(c.docente_id as string)
    for (const r of righe ?? []) for (const f of (r.firme_docenti ?? []) as { maestra_id: string }[]) if (f.maestra_id) docenteIds.add(f.maestra_id)
    const nomiById = new Map<string, { nome: string; cognome: string }>()
    if (docenteIds.size) {
      const { data: docenti } = await supabase.from('utenti').select('id, nome, cognome').in('id', [...docenteIds])
      for (const d of docenti ?? []) nomiById.set(d.id, { nome: d.nome, cognome: d.cognome })
    }
    const orarioConNomi = (orarioCelle ?? []).map((c) => ({ ...c, utenti: c.docente_id ? nomiById.get(c.docente_id as string) ?? null : null }))
    const righeConNomi = (righe ?? []).map((r) => ({
      ...r,
      firme_docenti: ((r.firme_docenti ?? []) as { maestra_id: string }[]).map((f) => ({ ...f, utenti: nomiById.get(f.maestra_id) ?? null })),
    }))

    return NextResponse.json({
      success: true,
      data: { giorno, campanelle: campanelle ?? [], orarioCelle: orarioConNomi, righe: righeConNomi },
    })
  } catch (err) {
    logErrore({ operazione: 'primaria/registro:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/primaria/registro?userId=
// Firma/salva una lezione. Gestisce cofirma e firma indipendente (destinatari).
export const POST = withRoute('primaria/registro:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const {
      sectionId,
      data,
      oraLezione,
      materiaId,
      argomento,
      compiti,
      dataConsegnaCompiti,
      tipoCompresenza,
      argomentoProprio,
      compitiPropri,
      destinatariIds,
      docenteId,
      daOrario,
    } = b.data

    const supabase = await createAdminClient()

    // Scope per tenant/classe (educator: solo sezioni assegnate; staff/segreteria: plesso).
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // I destinatari (oscuramento firma indipendente) devono essere alunni della sezione.
    if (destinatariIds.length > 0) {
      const alunniErr = await assertAlunniInSezione(supabase, destinatariIds, sectionId)
      if (alunniErr) return alunniErr
    }

    // La FIRMA del registro deve restare del docente (vincolo FEA). educator → sé
    // stesso; segreteria → docente titolare indicato in body.docenteId, altrimenti 422.
    const vr = await risolviValutatore(supabase, auth.user, sectionId, { docenteId, materiaId })
    if (vr.response) return vr.response
    const firmaUserId = vr.valutatoreId

    // Risolve scuola + nome classe (classe_sezione per compat con il vincolo unico).
    const { data: section } = await supabase
      .from('sections')
      .select('id, name, scuola_id')
      .eq('id', sectionId)
      .maybeSingle()
    if (!section) return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 })

    // Riga registro esistente per questo slot?
    const { data: esistente } = await supabase
      .from('registro_orario')
      .select('id')
      .eq('section_id', sectionId)
      .eq('data', data)
      .eq('ora_lezione', oraLezione)
      .maybeSingle()

    // Vincolo temporale: registro di classe = 'classe_orale' (default 2 giorni).
    const lock = await isOltreScadenza(supabase, section.scuola_id, data, 'classe_orale')
    if (lock.locked) {
      // Override solo se il dirigente ha sbloccato questa riga.
      let overridden = false
      if (esistente) {
        const { data: sblocco } = await supabase
          .from('sblocchi_audit')
          .select('id')
          .eq('entita_tipo', 'registro')
          .eq('entita_id', esistente.id)
          .limit(1)
          .maybeSingle()
        overridden = !!sblocco
      }
      if (!overridden) {
        return NextResponse.json(
          { error: `Registrazione bloccata: superato il termine di ${lock.giorniLimite} giorni. Richiedi lo sblocco al dirigente.`, locked: true },
          { status: 423 }
        )
      }
    }

    // P7/B1 — due condizioni DISTINTE (prima erano fuse in `isIndipendente`):
    //  · haDestinatari  = l'assegnazione è mirata ad alunni selezionati → si scrivono i
    //    contenuti "propri" (argomento_proprio/compiti_propri) e si popola
    //    registro_destinatari. Vale per QUALSIASI tipo firma, non solo il sostegno.
    //  · sopprimeCondivisi = QUALSIASI assegnazione mirata NON deve toccare i contenuti
    //    CONDIVISI di classe (argomento/compiti/materia della riga registro_orario). La riga è
    //    CONDIVISA fra i docenti (upsert onConflict classe_sezione,data,ora_lezione): quando un
    //    docente non-titolare assegna ai soli alunni selezionati, il client non mostra nemmeno i
    //    textarea condivisi, che arriverebbero VUOTI — scriverli AZZERAREBBE l'argomento/compiti
    //    del titolare (REGRESSIONE ciclo-1 B1, qui corretta). Il sostegno resta un caso
    //    particolare del generale: comportamento invariato, i suoi condivisi non si toccano mai.
    const haDestinatari = destinatariIds.length > 0
    const sopprimeCondivisi = haDestinatari

    // UPSERT della riga registro. I contenuti CONDIVISI si scrivono SOLO per l'assegnazione a
    // TUTTA la classe (nessun destinatario). DIFESA IN PROFONDITÀ: non includiamo MAI nell'upsert
    // un campo condiviso con valore VUOTO. Sull'UPDATE di una riga già firmata dal titolare,
    // scrivere argomento:null/compiti:null AZZERA il dato esistente; OMETTERE la chiave lo lascia
    // intatto (e in INSERT vale comunque il default null della colonna). Così anche un payload
    // anomalo con condivisi vuoti non può cancellare i contenuti di classe.
    const sharedFields: {
      materia_id?: string
      argomento?: string
      compiti?: string
      data_consegna_compiti?: string
    } = {}
    if (!sopprimeCondivisi) {
      if (materiaId) sharedFields.materia_id = materiaId
      if (argomento) sharedFields.argomento = argomento
      if (compiti) sharedFields.compiti = compiti
      if (dataConsegnaCompiti) sharedFields.data_consegna_compiti = dataConsegnaCompiti
    }

    const { data: registroRow, error: regErr } = await supabase
      .from('registro_orario')
      .upsert(
        {
          scuola_id: section.scuola_id,
          section_id: sectionId,
          classe_sezione: section.name,
          data,
          ora_lezione: oraLezione,
          da_orario: daOrario ?? false,
          ...sharedFields,
        },
        { onConflict: 'classe_sezione,data,ora_lezione' }
      )
      .select()
      .single()
    if (regErr) return NextResponse.json({ error: regErr.message }, { status: 500 })

    // Una sola firma "principale" per ora/materia: un secondo docente non può
    // firmare come principale la stessa riga (usare compresenza/cofirma). Il
    // vincolo è ribadito a DB da un indice parziale unico (migr. 20260708),
    // ma il guard applicativo copre anche il DB E2E non migrato e dà un messaggio chiaro.
    if (tipoCompresenza === 'principale') {
      const { data: altraPrincipale } = await supabase
        .from('firme_docenti')
        .select('id')
        .eq('registro_id', registroRow.id)
        .eq('tipo_compresenza', 'principale')
        .neq('maestra_id', firmaUserId)
        .limit(1)
        .maybeSingle()
      if (altraPrincipale) {
        return NextResponse.json(
          { error: 'Esiste già una firma principale per questa ora. Firma come compresenza o cofirma.' },
          { status: 409 }
        )
      }
    }

    // UPSERT firma del docente.
    const { data: firmaRow, error: firmaErr } = await supabase
      .from('firme_docenti')
      .upsert(
        {
          registro_id: registroRow.id,
          maestra_id: firmaUserId,
          tipo_compresenza: tipoCompresenza,
          argomento_proprio: haDestinatari ? argomentoProprio || null : null,
          compiti_propri: haDestinatari ? compitiPropri || null : null,
        },
        { onConflict: 'registro_id,maestra_id' }
      )
      .select()
      .single()
    if (firmaErr) return NextResponse.json({ error: firmaErr.message }, { status: 500 })

    // Destinatari (assegnazione mirata): sostituisce quelli della firma. Solo quando
    // l'assegnazione è mirata ad alunni selezionati (haDestinatari); l'assegnazione di
    // classe non tocca la tabella. PostgREST non lancia: controlla ogni ritorno.
    if (haDestinatari && firmaRow) {
      const { error: delDestErr } = await supabase.from('registro_destinatari').delete().eq('firma_id', firmaRow.id)
      if (delDestErr) {
        logErrore({ operazione: 'primaria/registro:POST', evento: 'db', stato: 500 }, delDestErr)
        return NextResponse.json({ error: delDestErr.message }, { status: 500 })
      }
      const rows = destinatariIds.map((alunnoId) => ({
        registro_id: registroRow.id,
        firma_id: firmaRow.id,
        alunno_id: alunnoId,
      }))
      if (rows.length) {
        const { error: insDestErr } = await supabase.from('registro_destinatari').insert(rows)
        if (insDestErr) {
          logErrore({ operazione: 'primaria/registro:POST', evento: 'db', stato: 500 }, insDestErr)
          return NextResponse.json({ error: insDestErr.message }, { status: 500 })
        }
      }
    }

    // Notifica compiti (buffer). Due destinatari distinti, SENZA doppioni allo stesso
    // genitore: gli alunni selezionati ricevono il testo "proprio"; il RESTO della classe
    // (esclusi i selezionati) riceve il testo condiviso, ma solo se quest'ultimo è stato
    // scritto (non soppresso). Best-effort: un fallimento non blocca il salvataggio, ma
    // NON è muto — si logga (uuid, mai i testi dei compiti).
    try {
      const notificaCompiti = {
        tipo: 'compiti',
        titolo: 'Nuovi compiti assegnati',
        link: '/parent/compiti',
        entitaTipo: 'registro',
        entitaId: registroRow.id,
        scuolaId: section.scuola_id,
      }
      // 1) Alunni selezionati → testo proprio.
      if (haDestinatari && compitiPropri) {
        await enqueueNotifichePerAlunni(supabase, {
          ...notificaCompiti,
          alunnoIds: destinatariIds,
          corpo: compitiPropri.slice(0, 140),
        })
      }
      // 2) Resto della classe → testo condiviso (solo se non soppresso).
      if (compiti && !sopprimeCondivisi) {
        const { data: classe, error: classeErr } = await supabase.from('alunni').select('id').eq('section_id', sectionId)
        if (classeErr) {
          logEvento('push', 'warn', {
            operazione: 'primaria/registro:POST',
            esito: 'notifica_compiti_classe_non_risolta',
            sezione: sectionId,
            entita_id: registroRow.id,
          }, classeErr)
        } else {
          const esclusi = new Set(destinatariIds)
          const target = (classe ?? []).map((a) => a.id).filter((id) => !esclusi.has(id))
          if (target.length) {
            await enqueueNotifichePerAlunni(supabase, {
              ...notificaCompiti,
              alunnoIds: target,
              corpo: compiti.slice(0, 140),
            })
          }
        }
      }
    } catch (err) {
      // Il catch NON risponde 500 (best-effort), quindi withRoute non lo vedrebbe: si logga qui.
      logEvento('push', 'warn', {
        operazione: 'primaria/registro:POST',
        esito: 'notifica_compiti_fallita',
        sezione: sectionId,
        entita_id: firmaRow?.id ?? registroRow.id,
      }, err)
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'registro',
      entitaId: registroRow.id,
      azione: 'update',
      scuolaId: section.scuola_id,
      sectionId,
      valoreDopo: { registro: registroRow, firma: firmaRow },
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, scuolaId: section.scuola_id, area: 'registro', link: `/teacher/primaria/${sectionId}/registro` })

    return NextResponse.json({ success: true, data: { registro: registroRow, firma: firmaRow } })
  } catch (err) {
    logErrore({ operazione: 'primaria/registro:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
