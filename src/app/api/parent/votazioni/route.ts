import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi'
import { figliAttiviConClasse, nomiGenitori } from '@/lib/votazioni/aventi-diritto'
import {
  ammessoAllIstituto,
  ammessoInClasse,
  candidatiDellaClasse,
  formaId,
  leggiAmmissione,
} from '@/lib/votazioni/ammissione-genitore'
import { rispostaErroreDbVotazioni, schemaVotazioniAssente } from '@/lib/votazioni/errori'
import { statoVotazione } from '@/lib/votazioni/stato'
import type { SchedaGenitore, SchedeGenitoreRisposta } from '@/lib/votazioni/tipi'

/**
 * GET /api/parent/votazioni · LE SCHEDE DA COMPILARE DI UN GENITORE.
 *
 * Una scheda per ogni votazione APERTA (non chiusa a mano e con la scadenza nel futuro) in cui l'elettore è
 * ammesso:
 *  · una scheda di CLASSE per ogni classe della votazione in cui ha un figlio — due figli nella stessa classe
 *    sono UNA scheda, perché le classi si leggono da `votazioni_classi` (una riga per classe) e non dai figli;
 *  · una scheda d'ISTITUTO se la votazione l'ha acceso e l'elettore ha figli in quella sede. Con figli in due
 *    sedi con l'istituto aperto in tutte e due sono due schede, ognuna coi candidati della propria sede.
 *
 * ── L'IDENTITÀ E LA REGOLA ───────────────────────────────────────────────────
 *
 * L'elettore è `auth.user.id`, la sessione: la route non legge nessun parametro. Chi è ammesso lo decide
 * `@/lib/votazioni/ammissione-genitore`, la STESSA regola che applica il POST del voto: una scheda mostrata qui
 * è una scheda che il POST accetta, e viceversa. Nessun controllo di morosità (decisione del titolare).
 *
 * ── I GUASTI ─────────────────────────────────────────────────────────────────
 *
 * PostgREST non lancia: ogni `{ error }` si guarda. Un guasto NON è «nessuna scheda»: l'elenco vuoto fa sparire
 * la card in home e il genitore crede che non ci sia niente da votare. Quindi:
 *  · le tabelle `votazioni*` assenti (DB della CI, finestra fra deploy e migrazione) → 200
 *    `{ disponibile: false, schede: [] }`, e un `warn`;
 *  · qualunque altro guasto, comprese le letture di figli, genitori e nomi → 500
 *    `VOTAZIONE_OPERAZIONE_NON_RIUSCITA`. Una scheda con meno candidati di quelli veri è peggio di un errore.
 *
 * ── L'ORDINE ─────────────────────────────────────────────────────────────────
 *
 * Per votazione, dalla scadenza più vicina (a parità, dalla più vecchia); dentro la votazione prima le classi,
 * per nome, e poi l'istituto.
 *
 * Il successo non si logga: sono letture, il battito di successo sta nel POST che scrive.
 */

const querySchema = z.object({})

interface RigaVotazioneAperta {
  id: string
  scuola_id: string
  titolo: string
  scadenza: string
  chiusa_il: string | null
  rappresentante_istituto: boolean
  creata_il: string
}

const FALLBACK_NOME = '—'

/** Un istante come ISO UTC (PostgREST rende i `timestamptz` con `+00:00`); illeggibile resta com'è. */
function istanteIso(valore: string): string {
  const t = Date.parse(valore)
  return Number.isNaN(t) ? valore : new Date(t).toISOString()
}

/**
 * Un guasto delle tabelle `votazioni*`: schema assente → il modulo non c'è su questo ambiente (200, non un
 * errore); altrimenti 500.
 */
function guastoVotazioni(error: { code?: string; message?: string }, operazione: string): NextResponse {
  if (schemaVotazioniAssente(error)) {
    logEvento('votazioni', 'warn', { operazione, esito: 'schema-votazioni-assente' }, error)
    const corpo: SchedeGenitoreRisposta = { disponibile: false, schede: [] }
    return NextResponse.json(corpo)
  }
  return rispostaErroreDbVotazioni(error, operazione)
}

/**
 * Un guasto di una tabella che NON è delle votazioni (figli, genitori, nomi, classi, sedi): è sempre un 500,
 * anche se il suo codice è fra quelli di «schema assente» — quel codice qui dice un'altra cosa.
 */
function guastoAltraLettura(errore: unknown, operazione: string): NextResponse {
  return rispostaErroreDbVotazioni(Object.assign(new Error('lettura-non-riuscita'), { cause: errore }), operazione)
}

export const GET = withRoute('parent/votazioni:GET', async (request: Request) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response
  const utenteId = auth.user.id

  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response

  const operazione = 'parent/votazioni:GET'
  const supabase = await createAdminClient()

  // 1. I figli ancora a scuola: da qui le sedi e le classi.
  const figli = await figliAttiviConClasse(supabase, utenteId)
  if (!figli.completo) return guastoAltraLettura(figli.errore, operazione)
  const sedi = [...new Set(figli.valore.map((f) => formaId(f.scuolaId)))]
  const classiDeiFigli = [...new Set(figli.valore.map((f) => formaId(f.sectionId)))]
  if (sedi.length === 0) return NextResponse.json({ disponibile: true, schede: [] } satisfies SchedeGenitoreRisposta)

  // 2. Le votazioni aperte delle sedi dei figli. Il filtro sta nella query (`chiusa_il IS NULL`, scadenza futura)
  //    e si ripete in codice con `statoVotazione`, la funzione che usa anche il POST: una regola sola.
  const adesso = new Date()
  const { data: righeVotazioni, error: erroreVotazioni } = await supabase
    .from('votazioni')
    .select('id, scuola_id, titolo, scadenza, chiusa_il, rappresentante_istituto, creata_il')
    .in('scuola_id', sedi)
    .is('chiusa_il', null)
    .gt('scadenza', adesso.toISOString())
  if (erroreVotazioni) return guastoVotazioni(erroreVotazioni, operazione)

  const votazioni = ((righeVotazioni ?? []) as unknown as RigaVotazioneAperta[])
    .filter((v) => statoVotazione({ scadenza: v.scadenza, chiusaIl: v.chiusa_il }, adesso) === 'aperta')
    .sort(
      (a, b) =>
        Date.parse(a.scadenza) - Date.parse(b.scadenza) ||
        Date.parse(a.creata_il) - Date.parse(b.creata_il) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
  if (votazioni.length === 0) return NextResponse.json({ disponibile: true, schede: [] } satisfies SchedeGenitoreRisposta)

  const idVotazioni = votazioni.map((v) => v.id)
  const idConIstituto = votazioni.filter((v) => v.rappresentante_istituto).map((v) => v.id)
  const sediConVotazioni = [...new Set(votazioni.map((v) => formaId(v.scuola_id)))]

  // 3. In parallelo: le classi delle votazioni (solo quelle dei figli), l'ammissione, i voti già dati
  //    dall'elettore e i candidati d'istituto. Ogni lettura filtra la sede.
  const [lettureClassi, ammissione, letturaVoti, letturaCandidati] = await Promise.all([
    Promise.all(
      aBlocchi(idVotazioni, ID_PER_QUERY).map((blocco) =>
        supabase
          .from('votazioni_classi')
          .select('votazione_id, scuola_id, section_id')
          .in('scuola_id', sedi)
          .in('votazione_id', blocco)
          .in('section_id', classiDeiFigli),
      ),
    ),
    leggiAmmissione(supabase, utenteId, { figli: figli.valore, sedi: sediConVotazioni }),
    Promise.all(
      aBlocchi(idVotazioni, ID_PER_QUERY).map((blocco) =>
        supabase
          .from('votazioni_voti')
          .select('votazione_id, ambito, section_id, candidato_id')
          .eq('elettore_id', utenteId)
          .in('scuola_id', sedi)
          .in('votazione_id', blocco),
      ),
    ),
    Promise.all(
      aBlocchi(idConIstituto, ID_PER_QUERY).map((blocco) =>
        supabase
          .from('votazioni_candidati')
          .select('votazione_id, utente_id')
          .in('scuola_id', sedi)
          .in('votazione_id', blocco),
      ),
    ),
  ])

  const righeClassi: { votazione_id: string; scuola_id: string; section_id: string }[] = []
  for (const { data, error } of lettureClassi) {
    if (error) return guastoVotazioni(error, operazione)
    righeClassi.push(...((data ?? []) as unknown as typeof righeClassi))
  }
  const righeVoti: { votazione_id: string; ambito: string; section_id: string | null; candidato_id: string }[] = []
  for (const { data, error } of letturaVoti) {
    if (error) return guastoVotazioni(error, operazione)
    righeVoti.push(...((data ?? []) as unknown as typeof righeVoti))
  }
  const righeCandidati: { votazione_id: string; utente_id: string }[] = []
  for (const { data, error } of letturaCandidati) {
    if (error) return guastoVotazioni(error, operazione)
    righeCandidati.push(...((data ?? []) as unknown as typeof righeCandidati))
  }
  // Un'ammissione a metà farebbe sparire schede vere con l'aria di un «non sei ammesso».
  if (!ammissione.completo) return guastoAltraLettura(ammissione.errore, operazione)

  // 4. Quali schede esistono davvero (votazione × classe, votazione × istituto), prima dei nomi.
  const sedeDi = new Map(votazioni.map((v) => [v.id, formaId(v.scuola_id)]))
  const classiPerVotazione = new Map<string, string[]>()
  for (const r of righeClassi) {
    // Una riga di classe con una sede diversa da quella della votazione è incoerente: non vale.
    if (sedeDi.get(r.votazione_id) !== formaId(r.scuola_id)) continue
    const sede = sedeDi.get(r.votazione_id) as string
    if (!ammessoInClasse(ammissione.valore, sede, r.section_id)) continue
    const classi = classiPerVotazione.get(r.votazione_id) ?? []
    if (!classi.some((c) => formaId(c) === formaId(r.section_id))) classi.push(r.section_id)
    classiPerVotazione.set(r.votazione_id, classi)
  }
  const candidatiIstitutoPerVotazione = new Map<string, string[]>()
  for (const r of righeCandidati) {
    const lista = candidatiIstitutoPerVotazione.get(r.votazione_id) ?? []
    if (!lista.includes(r.utente_id)) lista.push(r.utente_id)
    candidatiIstitutoPerVotazione.set(r.votazione_id, lista)
  }
  const votazioniConIstituto = votazioni.filter(
    (v) => v.rappresentante_istituto && ammessoAllIstituto(ammissione.valore, v.scuola_id),
  )

  // 5. I nomi: delle sedi e delle classi con una scheda, e dei candidati d'istituto (solo account attivi).
  const sediConSchede = [
    ...new Set(
      votazioni
        .filter((v) => (classiPerVotazione.get(v.id)?.length ?? 0) > 0 || votazioniConIstituto.includes(v))
        .map((v) => formaId(v.scuola_id)),
    ),
  ]
  if (sediConSchede.length === 0) return NextResponse.json({ disponibile: true, schede: [] } satisfies SchedeGenitoreRisposta)
  const classiConSchede = [...new Set([...classiPerVotazione.values()].flat().map(formaId))]
  const idCandidatiIstituto = [
    ...new Set(votazioniConIstituto.flatMap((v) => candidatiIstitutoPerVotazione.get(v.id) ?? [])),
  ]

  const [lettSedi, lettClassi, candidatiAttivi] = await Promise.all([
    supabase.from('schools').select('id, nome').in('id', sediConSchede),
    classiConSchede.length > 0
      ? supabase.from('sections').select('id, name').in('scuola_id', sediConSchede).in('id', classiConSchede)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    nomiGenitori(supabase, idCandidatiIstituto),
  ])
  if (lettSedi.error) return guastoAltraLettura(lettSedi.error, operazione)
  if (lettClassi.error) return guastoAltraLettura(lettClassi.error, operazione)
  if (!candidatiAttivi.completo) return guastoAltraLettura(candidatiAttivi.errore, operazione)

  const nomeSede = new Map(
    ((lettSedi.data ?? []) as unknown as { id: string; nome: string | null }[]).map((s) => [formaId(s.id), s.nome ?? FALLBACK_NOME]),
  )
  const nomeClasse = new Map(
    ((lettClassi.data ?? []) as unknown as { id: string; name: string | null }[]).map((s) => [formaId(s.id), s.name ?? FALLBACK_NOME]),
  )

  // La scelta già fatta, per scheda: votazione|ambito|classe.
  const chiaveScheda = (votazioneId: string, ambito: string, sectionId: string | null) =>
    `${formaId(votazioneId)}|${ambito}|${sectionId ? formaId(sectionId) : ''}`
  const sceltaPerScheda = new Map(righeVoti.map((r) => [chiaveScheda(r.votazione_id, r.ambito, r.section_id), r.candidato_id]))

  // 6. Le schede, nell'ordine: votazione, poi classi per nome, poi istituto.
  const schede: SchedaGenitore[] = []
  for (const v of votazioni) {
    const sede = formaId(v.scuola_id)
    const sedeNome = nomeSede.get(sede) ?? FALLBACK_NOME
    const base = { votazioneId: v.id, titolo: v.titolo, scadenza: istanteIso(v.scadenza), sedeNome }

    const schedeClasse: SchedaGenitore[] = (classiPerVotazione.get(v.id) ?? []).map((sectionId) => ({
      ...base,
      ambito: 'classe',
      sectionId,
      classeNome: nomeClasse.get(formaId(sectionId)) ?? FALLBACK_NOME,
      candidati: candidatiDellaClasse(ammissione.valore, sede, sectionId),
      sceltaAttuale: sceltaPerScheda.get(chiaveScheda(v.id, 'classe', sectionId)) ?? null,
    }))
    schedeClasse.sort(
      (a, b) =>
        (a.classeNome ?? '').localeCompare(b.classeNome ?? '', 'it', { numeric: true }) ||
        (a.sectionId ?? '').localeCompare(b.sectionId ?? ''),
    )
    schede.push(...schedeClasse)

    if (votazioniConIstituto.includes(v)) {
      // Nell'ordine di `nomiGenitori` (cognome, nome, id), come le liste di classe.
      const indicati = new Set((candidatiIstitutoPerVotazione.get(v.id) ?? []).map(formaId))
      const candidati = candidatiAttivi.valore.filter((g) => indicati.has(formaId(g.utenteId)))
      // Un istituto senza nessun candidato valido (account disattivati) è una scheda senza niente da scegliere.
      if (candidati.length > 0) {
        schede.push({
          ...base,
          ambito: 'istituto',
          sectionId: null,
          classeNome: null,
          candidati,
          sceltaAttuale: sceltaPerScheda.get(chiaveScheda(v.id, 'istituto', null)) ?? null,
        })
      }
    }
  }

  const corpo: SchedeGenitoreRisposta = { disponibile: true, schede }
  return NextResponse.json(corpo)
})
