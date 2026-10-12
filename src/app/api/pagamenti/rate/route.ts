import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { assertAlunnoInScope, resolveScuoleAttive } from '@/lib/auth/scope'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rispostaGuastoDb } from '@/lib/pagamenti/guasto-db'
import {
  normalizzaMetodiAmmessi,
  sonoTuttiIMetodi,
  CODICI_COLONNA_ASSENTE,
  type MetodoAmmesso,
} from '@/lib/pagamenti/metodi-ammessi'
import { zMetodiAmmessi } from '@/lib/pagamenti/metodi-ammessi-zod'
import { controllaVoceEliminabile, rispostaRifiuto, type VoceDaEliminare } from '@/lib/pagamenti/voce-eliminabile'
import { figlieTrattengono } from '@/lib/db/figlie-trattengono'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postBodySchema = z.object({
  alunno_id: zUuid,
  descrizione: z.string().min(1, 'alunno_id, descrizione e almeno 2 rate sono obbligatori'),
  // numero o stringa numerica; assente/null → somma delle rate (calcolata sotto)
  importo_totale: z.union([z.number(), z.string()]).nullish(),
  rate: z
    .array(
      z.object({
        importo: z.union([z.number(), z.string()], { error: 'Ogni rata richiede importo e scadenza' }),
        scadenza: z.string().min(1, 'Ogni rata richiede importo e scadenza'),
      }),
      { error: 'alunno_id, descrizione e almeno 2 rate sono obbligatori' }
    )
    .min(2, 'alunno_id, descrizione e almeno 2 rate sono obbligatori'),
  categoria_id: zUuid.nullish(),
  obbligatorio: z.boolean().nullish(), // default true applicato nel codice
  scuola_id: z.string().nullish(), // assente/vuota → derivata dall'alunno (come oggi)
  // Metodi ammessi (2026-10-05): quelli della voce che il piano SOSTITUISCE
  // («Dividi in acconti» crea padre+rate e poi cancella l'originale — senza,
  // il «solo contanti» spariva con lei). Assente = tutti e due (default della
  // colonna): «Acquisto rapido» non li manda.
  metodi_ammessi: zMetodiAmmessi.optional(),
  // Rateizza (2026-10-12): la voce che il piano SOSTITUISCE. Il server controlla che sia
  // eliminabile PRIMA di creare il piano, e la elimina DOPO; se non ci riesce, toglie il piano.
  // Prima lo faceva il browser con una seconda chiamata, e un fallimento lasciava voce e piano.
  sostituisce_pagamento_id: zUuid.optional(),
})

// POST /api/pagamenti/rate  (staff) — crea un piano rateale: 1 padre + N rate
// Body: { userId, alunno_id, descrizione, importo_totale, rate: [{importo, scadenza}],
//         categoria_id?, obbligatorio?, scuola_id?, metodi_ammessi?, sostituisce_pagamento_id? }
export const POST = withRoute('pagamenti/rate:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data
    const { alunno_id, descrizione, importo_totale, rate } = body
    const somma = rate.reduce((s, r) => s + Number(r.importo), 0)
    const tot = Number(importo_totale ?? somma)
    if (Math.abs(somma - tot) > 0.01) {
      return NextResponse.json({ error: `La somma delle rate (${somma}) deve coincidere col totale (${tot})` }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // Scope: l'alunno deve appartenere ai plessi dell'utente (403/404 se fuori scope)
    const scopeRes = await assertAlunnoInScope(supabase, user, alunno_id)
    if (scopeRes) return scopeRes

    // La sede è SEMPRE derivata dall'alunno: MAI fidarsi dello scuola_id del client
    const { data: al, error: errAl } = await supabase.from('alunni').select('scuola_id').eq('id', alunno_id).maybeSingle()
    // Un guasto non è «non trovato» (fase 5 robustezza, sesto pezzo).
    if (errAl) return rispostaGuastoDb('pagamenti/rate:POST', 'db:alunni', errAl)
    if (!al) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
    const scuolaId = al.scuola_id

    // Sostituzione: tutte le guardie PRIMA di scrivere qualunque cosa.
    let originale: VoceDaEliminare | null = null
    if (body.sostituisce_pagamento_id) {
      const sedi = await resolveScuoleAttive(request as NextRequest, supabase, user)
      const c = await controllaVoceEliminabile(supabase, body.sostituisce_pagamento_id, {
        sedi,
        perSostituzione: true,
        operazione: 'pagamenti/rate:POST',
      })
      if (!c.ok) {
        if ('guasto' in c) return c.guasto
        return rispostaRifiuto(c.codice)
      }
      if (c.voce.alunno_id !== alunno_id || c.voce.tipo !== 'singolo') {
        return NextResponse.json(
          {
            error: 'Questa voce non si può sostituire con un piano rateale: deve essere una voce singola dello stesso bambino.',
            codice: 'VOCE_NON_SOSTITUIBILE',
          },
          { status: 409 },
        )
      }
      originale = c.voce
    }

    const scadenze = rate.map((r) => r.scadenza).sort()
    const ultimaScadenza = scadenze[scadenze.length - 1]

    // Metodi ammessi: la stessa forma di `pagamenti/genera:POST`. Si SCRIVONO solo
    // quando non sono tutti e due — il default lo mette il DB, e così sul DB E2E
    // della CI (colonna assente) il caso normale non nomina mai la colonna.
    const metodiDaScrivere: MetodoAmmesso[] | undefined =
      body.metodi_ammessi && !sonoTuttiIMetodi(body.metodi_ammessi)
        ? normalizzaMetodiAmmessi(body.metodi_ammessi)
        : undefined
    // Diventa vero al primo PGRST204/42703: da lì la colonna non si nomina più
    // (UN rifiuto e un warn), e il log di successo non dichiara scritto ciò che non lo è.
    let metodiScartati = false
    const conMetodi = (): { metodi_ammessi?: MetodoAmmesso[] } =>
      metodiDaScrivere && !metodiScartati ? { metodi_ammessi: metodiDaScrivere } : {}
    const colonnaMetodiAssente = (e: { code?: string } | null): boolean =>
      !!e && !!metodiDaScrivere && !metodiScartati && CODICI_COLONNA_ASSENTE.includes(e.code ?? '')
    const scartaMetodi = (ramo: 'padre' | 'rata', e: unknown) => {
      metodiScartati = true
      logEvento('pagamento', 'warn', {
        operazione: 'pagamenti/rate:POST',
        esito: 'metodi-ammessi-colonna-assente',
        tipo: ramo,
      }, e)
    }

    // padre
    const rigaPadre = {
      alunno_id, scuola_id: scuolaId, descrizione, importo: tot, scadenza: ultimaScadenza,
      categoria_id: body.categoria_id ?? null, tipo: 'padre', obbligatorio: body.obbligatorio ?? true,
      creato_da: user.id, stato: 'da_pagare',
    }
    let insPadre = await supabase.from('pagamenti').insert({ ...rigaPadre, ...conMetodi() }).select().single()
    if (colonnaMetodiAssente(insPadre.error)) {
      scartaMetodi('padre', insPadre.error)
      insPadre = await supabase.from('pagamenti').insert(rigaPadre).select().single()
    }
    const { data: padre, error: pErr } = insPadre
    if (pErr || !padre) {
      logEvento('pagamento', 'error', {
        operazione: 'pagamenti/rate:POST',
        esito: 'padre-non-creato',
        alunno_id,
      }, pErr ?? undefined)
      return NextResponse.json({ error: 'Errore creazione piano', details: pErr?.message }, { status: 500 })
    }

    // rate figlie (la riga BASE, senza metodi: è quella del ritentativo)
    const figlieBase = rate.map((r, i) => ({
      alunno_id, scuola_id: scuolaId, descrizione: `${descrizione} — Rata ${i + 1}/${rate.length}`,
      importo: r.importo, scadenza: r.scadenza, categoria_id: body.categoria_id ?? null,
      tipo: 'rata', obbligatorio: body.obbligatorio ?? true, parent_payment_id: padre.id,
      creato_da: user.id, stato: 'da_pagare',
    }))
    let insRate = await supabase.from('pagamenti').insert(figlieBase.map((f) => ({ ...f, ...conMetodi() }))).select()
    if (colonnaMetodiAssente(insRate.error)) {
      scartaMetodi('rata', insRate.error)
      insRate = await supabase.from('pagamenti').insert(figlieBase).select()
    }
    const { data: created, error: rErr } = insRate
    if (rErr) {
      logEvento('pagamento', 'error', {
        operazione: 'pagamenti/rate:POST',
        esito: 'rate-non-create',
        alunno_id,
        pagamento_id: padre.id,
      }, rErr)
      // Rollback del padre. PostgREST non lancia: se la delete fallisce il padre
      // ORFANO resta in tabella senza rate, e va detto col suo uuid.
      const del = await supabase.from('pagamenti').delete().eq('id', padre.id)
      if (del.error) {
        logEvento('pagamento', 'error', {
          operazione: 'pagamenti/rate:POST',
          esito: 'padre-orfano-non-cancellato',
          alunno_id,
          pagamento_id: padre.id,
        }, del.error)
      }
      return NextResponse.json({ error: 'Errore creazione rate', details: rErr.message }, { status: 500 })
    }

    if (metodiDaScrivere && !metodiScartati) {
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti/rate:POST',
        esito: 'metodi-ammessi-scritti',
        solo_contanti: metodiDaScrivere.length === 1 && metodiDaScrivere[0] === 'contanti',
        pagamento_id: padre.id,
      })
    }

    if (originale) {
      const del = await supabase.from('pagamenti').delete().eq('id', originale.id)
      if (del.error) {
        // Compensazione: senza, la famiglia avrebbe voce e piano insieme (debito doppio). Le rate
        // se ne vanno col padre (CASCADE su `parent_payment_id`).
        const comp = await supabase.from('pagamenti').delete().eq('id', padre.id)
        if (comp.error) {
          logEvento('pagamento', 'error', {
            operazione: 'pagamenti/rate:POST',
            esito: 'compensazione-piano-fallita',
            padre_id: padre.id,
            originale_id: originale.id,
          }, comp.error)
          return NextResponse.json(
            { error: 'Errore sostituzione: il piano è stato creato ma la voce originale non è stata tolta.', codice: 'PAGAMENTI_SCRITTURA_FALLITA' },
            { status: 500 },
          )
        }
        const freno = figlieTrattengono(del.error)
        logEvento('pagamento', freno ? 'warn' : 'error', {
          operazione: 'pagamenti/rate:POST',
          esito: 'sostituzione-annullata',
          padre_id: padre.id,
          originale_id: originale.id,
        }, del.error)
        return freno
          ? NextResponse.json(
              { error: 'La voce è stata incassata o fatturata nel frattempo: non si può più sostituire. Ricarica la pagina.', codice: 'VOCE_CON_CONTABILITA' },
              { status: 409 },
            )
          : NextResponse.json({ error: 'Errore sostituzione: la voce originale non è stata tolta, il piano è stato annullato.', codice: 'PAGAMENTI_SCRITTURA_FALLITA' }, { status: 500 })
      }
      const audit = await supabase.from('registro_modifiche').insert({
        azione: 'elimina_pagamento',
        tabella_interessata: 'pagamenti',
        record_id: originale.id,
        vecchio_valore: originale,
        nuovo_valore: { sostituito_da: padre.id },
        utente_id: user.id,
      })
      if (audit.error) {
        logEvento('pagamento', 'error', {
          operazione: 'pagamenti/rate:POST',
          esito: 'audit-sostituzione-non-scritto',
          originale_id: originale.id,
        }, audit.error)
      }
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti/rate:POST',
        esito: 'voce-sostituita-da-piano',
        originale_id: originale.id,
        padre_id: padre.id,
      })
    }

    return NextResponse.json({ success: true, data: { padre, rate: created } }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/rate:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
