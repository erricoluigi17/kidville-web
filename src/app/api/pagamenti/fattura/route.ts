import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { assertPagamentoInScope } from '@/lib/auth/scope'
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami'
import { emettiFatturaPagamento } from '@/lib/aruba/emissione'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { zIntestatarioScelto } from '@/lib/fatturazione/intestatario-scelto'
import { jsPDF } from 'jspdf'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { formatEuro } from '@/lib/format/valuta'

/**
 * IL TEMPO MASSIMO DELLA FUNZIONE, DICHIARATO E NON EREDITATO.
 *
 * ─── IL CONTO, NEL CASO TIPICO: UN SOLO `429`, E SULL'UPLOAD ─────────────────
 * Un'emissione parla con Aruba con un ritmo che Aruba impone (SLA §3: 12 ricerche
 * al minuto per IP ⇒ una ogni 5 s, vedi `PAUSA_FRA_PAGINE_MS` in
 * `src/lib/aruba/client.ts`):
 *
 *     1 `signin`
 *   + 7 pagine di `findByUsername`, cioè 6 pause da 5 s        →   30 s
 *   + la pausa prima dell'upload, della stessa durata          →    5 s
 *   + 1 `upload`
 *   + il `429` sull'upload: attesa e UN ritentativo            →   90 s
 *                                                              ─────────
 *                                    ~125 s di sola attesa, più le risposte
 *
 * ⚠️ NON È IL MASSIMO TEORICO, e chiamarlo «caso peggiore» sarebbe una di quelle
 * frasi che dichiarano un tetto che non è un tetto. Anche la LETTURA ritenta una
 * volta dopo un `429` (`paginaConRitentativo`, in `client.ts`): ogni pagina che lo
 * prende aggiunge 90 s, e con abbastanza pagine sfortunate si sfonda qualunque
 * valore si scriva qui.
 *
 * ─── PERCHÉ IL MASSIMO TEORICO NON È IL BUDGET CHE CONTA ─────────────────────
 * Un `429` in lettura cade PRIMA che `prossimo_numero_fattura_sezionale` abbia
 * scritto il contatore, e lì un troncamento non costa niente: nessun numero
 * consumato, nessuna riga a registro, si ripreme e basta. DOPO l'allocazione un
 * troncamento significa invece un numero bruciato, nessuna riga a registro e
 * nessuno in grado di dire se la fattura sia partita — cioè il danno che tutto
 * questo lavoro esiste per evitare.
 *
 * Quel tratto è il budget da coprire: pausa da 5 s + `signin` + `upload` + i 90 s
 * dell'unico ritentativo + il secondo `upload`, cioè **~100 s più le risposte**
 * (tetto di 30 s ciascuna, in pratica molto meno). Trecento secondi lo coprono con
 * margine, senza dipendere da un default di piattaforma che nessuno ha scelto e
 * che può cambiare con un aggiornamento del piano. È lo stesso ragionamento
 * dell'import massivo, dove l'unico altro `maxDuration` del repository sta scritto
 * per esteso (`src/app/api/iscrizione/import-massivo/route.ts`).
 */
export const maxDuration = 300

// causale: il comportamento pre-esistente accetta qualsiasi tipo e la usa solo
// se è una stringa non vuota → unknown().optional(), il typeof resta nell'handler.
const postBodySchema = z.object({
  pagamento_id: zUuid,
  causale: z.unknown().optional(),
  /**
   * L'intestatario scelto a mano dalla segreteria. ASSENTE = comportamento di
   * sempre: la cascata di `determinaQuoteFatturazione` decide da sola.
   *
   * L'unione discriminata rende irrappresentabile l'ibrido «adult_id + campi
   * anagrafici»: sul ramo `adult` viaggia solo l'id, e nome, codice fiscale e
   * residenza si rileggono da `parents` lato server. Accettare l'anagrafica dal
   * client per una persona che abbiamo in archivio vorrebbe dire lasciar
   * intestare una fattura a un genitore vero con un codice fiscale forgiato dal
   * browser.
   */
  intestatario: zIntestatarioScelto.optional(),
})

/**
 * I due rifiuti che nascono con il selettore, e i loro codici.
 *
 * Costanti LOCALI e letterali, non un accesso a una mappa: il lock
 * `errori-con-codice` risolve `codice: X` solo se `X` è una stringa nel corpo
 * oppure un `const X = '…'` di QUESTO file. Un valore che il lock non sa leggere
 * è un valore che nessuno controlla.
 */
const CODICE_CONFLITTO_QUOTE = 'INTESTATARIO_IN_CONFLITTO_CON_QUOTE'
const CODICE_GIA_EMESSA_ALTRO = 'FATTURA_GIA_EMESSA_ALTRO_INTESTATARIO'
const CODICE_NON_DEL_BAMBINO = 'INTESTATARIO_NON_DEL_BAMBINO'

const getQuerySchema = z.object({
  pagamento_id: zUuid,
  // opzionale: scarica il PDF di UNA specifica fattura (quota) del pagamento.
  fattura_id: zUuid.optional(),
})

// PDF anteprima "copia di cortesia" generato al volo (in attesa del PDF SDI).
async function anteprimaPdf(opts: {
  pagamentoId: string
  numeroDoc: string
  data: string
  intestatario: string
  causale: string
  importo: number
}): Promise<NextResponse> {
  const doc = new jsPDF()
  doc.setFontSize(18)
  doc.text('Kidville — Ricevuta / Fattura', 20, 25)
  doc.setFontSize(10)
  doc.setTextColor(150)
  doc.text('Copia di cortesia. La fattura elettronica è stata trasmessa allo SDI tramite Aruba;', 20, 33)
  doc.text('il PDF ufficiale è disponibile appena lo SDI conferma la consegna.', 20, 38)
  doc.setTextColor(0)
  doc.setFontSize(12)
  doc.text(`N. documento: ${opts.numeroDoc || '—'}`, 20, 55)
  doc.text(`Data: ${(opts.data ?? '').slice(0, 10)}`, 20, 63)
  doc.text(`Intestatario: ${opts.intestatario}`, 20, 71)
  doc.text(`Causale: ${opts.causale}`, 20, 79)
  doc.setFontSize(14)
  // Documento in italiano, letto da una famiglia italiana: la valuta passa da
  // `formatEuro` come nell'altro builder PDF (`src/lib/pagamenti/pdf.ts`).
  // L'XML per lo SDI è un'altra cosa e resta col punto decimale (fatturapa-xml.ts).
  doc.text(`Importo: ${formatEuro(opts.importo)}`, 20, 92)
  const pdf = Buffer.from(doc.output('arraybuffer'))
  return new NextResponse(pdf, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="fattura-${opts.pagamentoId.slice(0, 8)}.pdf"`,
    },
  })
}

// POST /api/pagamenti/fattura  (staff) — "Invia Fattura" → emissione REALE Aruba/SDI.
// Body: { userId, pagamento_id, causale? }. Richiede pagamento saldato.
export const POST = withRoute('pagamenti/fattura:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { pagamento_id, causale, intestatario } = b.data

    const supabase = await createAdminClient()

    // Isolamento per sede: il gate di ruolo non bastava — si operava sulle rette
    // di un'altra sede conoscendo l'uuid del pagamento. `pagamenti` ha gia'
    // `scuola_id`, che per la contabilita' e' il dato che conta.
    const fuoriScopePag = await assertPagamentoInScope(supabase, auth.user, pagamento_id)
    if (fuoriScopePag) return fuoriScopePag

    // ─── LA CORREZIONE MANUALE, E COME SI TOGLIE ──────────────────────────────
    // `pagamenti.fattura_causale` batte qualunque modello configurato: è una
    // correzione che un umano scrive su QUESTO documento. Fino al 2026-09-04 si
    // poteva solo scrivere, mai cancellare — e siccome il modale precompilava la
    // casella con la descrizione del pagamento, ogni emissione ci lasciava dentro
    // l'eco della descrizione. Quel pagamento restava congelato per sempre:
    // cambiare il modello in Contabilità → Causali non aveva più alcun effetto su
    // di lui, e nessuno poteva sapere perché.
    //
    //   stringa non vuota → si scrive la correzione
    //   `null`           → si TOGLIE (il modale lo manda quando non si personalizza)
    //   `undefined`      → non si tocca (chiamanti vecchi)
    const scriviCausale =
      typeof causale === 'string' && causale.trim()
        ? causale.trim()
        : causale === null
          ? null
          : undefined
    if (scriviCausale !== undefined) {
      // PostgREST NON LANCIA (AGENTS.md, regola 7): l'esito va guardato. Non è
      // bloccante — la causale composta resta corretta anche senza questa riga — ma
      // un fallimento muto qui rimetterebbe in circolo esattamente il difetto sopra.
      const { error: errCausale } = await supabase
        .from('pagamenti')
        .update({ fattura_causale: scriviCausale })
        .eq('id', pagamento_id)
      if (errCausale) {
        logEvento('fattura', 'warn', {
          operazione: 'pagamenti/fattura:POST',
          esito: scriviCausale === null ? 'causale-manuale-non-rimossa' : 'causale-manuale-non-salvata',
          pagamento_id,
        }, errCausale)
      }
    }

    // ⚠️ L'intestatario scelto NON viene scritto su `alunni.intestatario_fatture`:
    // vale per QUESTO documento e basta. Persisterlo qui vorrebbe dire che una
    // fattura andata storta lascia dietro di sé un intestatario nuovo su tutte le
    // rette future del bambino, senza che nessuno l'abbia deciso. La scheda si
    // cambia dalla scheda.
    const esito = await emettiFatturaPagamento(supabase, pagamento_id, { id: auth.user.id }, {
      intestatarioScelto: intestatario,
    })
    if (!esito.ok) {
      // I due rifiuti del selettore nascono CON il codice: senza, l'utente inglese
      // leggerebbe la prosa italiana del server (lock `errori-con-codice`). Gli
      // altri restano come sono — il loro debito è dichiarato in allowlist e si
      // paga a parte, non di straforo dentro un lavoro che parla d'altro.
      if (esito.motivo === 'intestatario_in_conflitto') {
        return NextResponse.json(
          { error: esito.messaggio, codice: CODICE_CONFLITTO_QUOTE, data: { motivo: esito.motivo } },
          { status: esito.httpStatus }
        )
      }
      if (esito.motivo === 'gia_emessa_altro_intestatario') {
        return NextResponse.json(
          { error: esito.messaggio, codice: CODICE_GIA_EMESSA_ALTRO, data: { motivo: esito.motivo } },
          { status: esito.httpStatus }
        )
      }
      if (esito.motivo === 'intestatario_non_del_bambino') {
        return NextResponse.json(
          { error: esito.messaggio, codice: CODICE_NON_DEL_BAMBINO, data: { motivo: esito.motivo } },
          { status: esito.httpStatus }
        )
      }
      return NextResponse.json(
        { error: esito.messaggio, data: { motivo: esito.motivo } },
        { status: esito.httpStatus }
      )
    }
    return NextResponse.json({
      success: true,
      data: { fattura_stato: esito.fatturaStato, numero: esito.numero, fattura_id: esito.uploadFileName },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/fattura:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// GET /api/pagamenti/fattura?pagamento_id=&userId=  — scarica la copia di cortesia.
// Accesso: staff oppure genitore del bambino. Preferisce il PDF reale di Aruba
// (storage `fatture`), con fallback a un'anteprima generata finché lo SDI non
// ha restituito il documento.
export const GET = withRoute('pagamenti/fattura:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { pagamento_id: pagamentoId, fattura_id: fatturaId } = q.data

    const supabase = await createAdminClient()

    // Isolamento per sede: il gate di ruolo non bastava — si operava sulle rette
    // di un'altra sede conoscendo l'uuid del pagamento. `pagamenti` ha gia'
    // `scuola_id`, che per la contabilita' e' il dato che conta.
    const fuoriScopePag = await assertPagamentoInScope(supabase, auth.user, pagamentoId)
    if (fuoriScopePag) return fuoriScopePag
    const { data: pag } = await supabase
      .from('pagamenti')
      .select(
        'id, descrizione, fattura_causale, importo, fattura_stato, fattura_aruba_id, fattura_pdf_path, fattura_emessa_il, alunno_id, alunni:alunno_id ( nome, cognome )'
      )
      .eq('id', pagamentoId)
      .maybeSingle()
    if (!pag) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })

    // scoping genitore
    const isStaff = user.role === 'admin' || user.role === 'coordinator' || user.role === 'segreteria'
    if (!isStaff) {
      // Unione runtime + anagrafica: la fattura di un bambino importato dal form
      // pubblico non era scaricabile da nessuno dei suoi genitori.
      const ok = await genitoreHasFiglio(supabase, user.id, pag.alunno_id)
      if (!ok) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }
    const al = pag.alunni as unknown as { nome?: string; cognome?: string }
    const alunnoNome = `${al?.nome ?? ''} ${al?.cognome ?? ''}`.trim()

    // Percorso PER-FATTURA (multi-quota): serve il PDF della singola riga.
    if (fatturaId) {
      const { data: fatt } = await supabase
        .from('fatture_emesse')
        .select('id, numero, causale, importo, intestatario, pdf_path, inviata_il')
        .eq('id', fatturaId)
        .eq('pagamento_id', pagamentoId)
        .maybeSingle()
      if (!fatt) return NextResponse.json({ error: 'Fattura non trovata' }, { status: 404 })
      if (fatt.pdf_path) {
        try {
          // `supabase-storage-js` NON lancia: `download` ritorna `{ data, error }`. L'`error`
          // era SCARTATO dalla destrutturazione, quindi il catch qui sotto non scattava mai:
          // l'utente si ritrovava in mano la copia di cortesia al posto della fattura ufficiale
          // Aruba — un documento diverso da quello che ha chiesto — e nei log non restava nulla.
          const { data: file, error: scaricaErr } = await supabase.storage.from('fatture').download(fatt.pdf_path)
          if (scaricaErr) {
            // `warn`: il risultato è salvo (l'anteprima parte qui sotto), ma è DEGRADATO —
            // e se il bucket è rotto lo si scopre solo da questa riga.
            logEvento('storage', 'warn', {
              operazione: 'pagamenti/fattura:GET',
              bucket: 'fatture',
              esito: 'pdf_non_recuperabile_uso_anteprima',
            }, scaricaErr)
          }
          if (file) {
            const buf = Buffer.from(await file.arrayBuffer())
            return new NextResponse(buf, {
              status: 200,
              headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `inline; filename="fattura-${pagamentoId.slice(0, 8)}-${fatt.numero}.pdf"`,
              },
            })
          }
        } catch (e) {
          // Resta a coprire ciò che può lanciare davvero: `arrayBuffer()` su un Blob corrotto,
          // o un guasto di trasporto. Stesso livello, stessa ragione: risultato salvo, degradato.
          logEvento('storage', 'warn', {
            operazione: 'pagamenti/fattura:GET',
            bucket: 'fatture',
            esito: 'pdf_non_recuperabile_uso_anteprima',
          }, e)
        }
      }
      const intest = (fatt.intestatario ?? {}) as { nome?: string; cognome?: string }
      const nomeInt = `${intest.nome ?? ''} ${intest.cognome ?? ''}`.trim() || alunnoNome
      return anteprimaPdf({
        pagamentoId,
        numeroDoc: String(fatt.numero ?? '—'),
        data: fatt.inviata_il ?? '',
        intestatario: nomeInt,
        causale: String(fatt.causale ?? pag.descrizione),
        importo: Number(fatt.importo ?? pag.importo),
      })
    }

    // Percorso legacy (senza param): comportamento odierno (fattura singola).
    if (pag.fattura_stato !== 'emessa') {
      return NextResponse.json({ error: 'Fattura non ancora disponibile' }, { status: 409 })
    }

    // PDF reale di Aruba (copia di cortesia) se già recuperato dallo SDI
    if (pag.fattura_pdf_path) {
      try {
        // Identico al percorso per-fattura qui sopra: l'`error` del download si controlla, non
        // si scarta. Chi chiede la fattura e riceve la copia di cortesia deve lasciare traccia.
        const { data: file, error: scaricaErr } = await supabase.storage.from('fatture').download(pag.fattura_pdf_path)
        if (scaricaErr) {
          logEvento('storage', 'warn', {
            operazione: 'pagamenti/fattura:GET',
            bucket: 'fatture',
            esito: 'pdf_non_recuperabile_uso_anteprima',
          }, scaricaErr)
        }
        if (file) {
          const buf = Buffer.from(await file.arrayBuffer())
          return new NextResponse(buf, {
            status: 200,
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': `inline; filename="fattura-${pagamentoId.slice(0, 8)}.pdf"`,
            },
          })
        }
      } catch (e) {
        logEvento('storage', 'warn', {
          operazione: 'pagamenti/fattura:GET',
          bucket: 'fatture',
          esito: 'pdf_non_recuperabile_uso_anteprima',
        }, e)
      }
    }

    // Fallback: anteprima generata (in attesa del PDF SDI)
    return anteprimaPdf({
      pagamentoId,
      numeroDoc: pag.fattura_aruba_id ?? '—',
      data: pag.fattura_emessa_il ?? '',
      intestatario: `Alunno: ${alunnoNome}`,
      causale: String(pag.fattura_causale ?? pag.descrizione),
      importo: Number(pag.importo),
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/fattura:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
