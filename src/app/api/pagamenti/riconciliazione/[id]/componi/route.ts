import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
// ─── LA REGISTRAZIONE NON VIVE PIÙ QUI DENTRO ───────────────────────────────
// I nove gate applicativi, la quadratura, l'àncora, il payload e la rete del
// `movimento_confermato` stanno in `@/lib/pagamenti/conciliazione-registra`:
// l'import che concilierà da sé non ha una `Request` né un corpo JSON, ma deve
// passare esattamente da quelle guardie. Qui restano le cose che sono davvero di
// una rotta — ruolo, validazione, sedi — e quelle che solo lei sa di dover fare:
// audit, avviso alla famiglia, revoca della sospensione.
//
// ⚠️ I TETTI SI IMPORTANO, non si riscrivono: vivono accanto ai gate perché chi
// arriverà senza `zod` li legga lo stesso. Due copie gemelle di un numero sono la
// forma più silenziosa di divergenza — e questi numeri sono misurati, non tondi:
// la misura che li regge sta sopra la loro dichiarazione, nel modulo.
import {
  registraConciliazione,
  MAX_QUANTITA_TICKET,
  MAX_IMPORTO_EURO,
  MAX_RIGHE_PER_ELENCO,
  MAX_RIGHE_TOTALI,
} from '@/lib/pagamenti/conciliazione-registra'

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pagamenti/riconciliazione/[id]/componi — «Componi il pagamento»
//
// Un bonifico di famiglia non paga quasi mai una voce sola: paga la retta, il
// pomeridiano e i ticket mensa, magari per due fratelli di plessi diversi.
// Questa rotta registra l'intera composizione in UNA transazione, e lega il
// movimento con un compare-and-swap.
//
// Il MOTORE è la RPC `registra_transazione_contabile(p jsonb)` e non si
// riscrive; i GATE che la RPC per costruzione non può avere — nove, uno per uno
// con la misura che li regge — stanno in `@/lib/pagamenti/conciliazione-registra`,
// insieme alla mappa degli errori e alla rete che dice se la riga bancaria è
// stata legata davvero. Si leggono lì: qui sarebbero la seconda copia.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * «Ha al più due decimali», misurato sul valore e non sulla sua stringa.
 * `v * 100` non è mai esatto in virgola mobile (`2.13 * 100` = 213.00000000000003),
 * quindi il confronto è con una tolleranza molto più piccola del centesimo e molto
 * più grande dell'errore di rappresentazione.
 */
const dueDecimali = (v: number) =>
  Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6

const zImporto = z.coerce
  .number()
  .positive('importo deve essere > 0')
  .max(MAX_IMPORTO_EURO, `importo oltre il tetto di ${MAX_IMPORTO_EURO} €`)

const zData = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida (atteso YYYY-MM-DD)')

const voceSchema = z.object({
  pagamento_id: zUuid,
  importo: zImporto,
})

const voceNuovaSchema = z.object({
  alunno_id: zUuid,
  // Obbligatoria: il motore emette `categoria_mancante` su una riga nuova senza
  // categoria, e un 400 parlante di zod è più utile di un 422 d'insieme.
  categoria_id: zUuid,
  descrizione: z.string().trim().min(1, 'descrizione obbligatoria').max(200),
  importo: zImporto,
  scadenza: zData,
  gruppo: z.string().trim().max(80).nullish(),
})

const voceTicketSchema = z.object({
  alunno_id: zUuid,
  quantita: z.coerce
    .number()
    .int('quantita deve essere un intero')
    .positive('quantita deve essere > 0')
    .max(MAX_QUANTITA_TICKET, 'quantita oltre il massimo consentito'),
  // `> 0`, non `>= 0`: a costo zero l'importo della riga vale `0.00` e l'INSERT in
  // `incassi` viola `incassi_importo_check CHECK (importo <> 0)` (misurato,
  // SQLSTATE 23514). Una ricarica in omaggio si fa da Mensa, non da qui.
  costo_unitario: z.coerce
    .number()
    .positive('costo_unitario deve essere > 0')
    .max(MAX_IMPORTO_EURO)
    .refine(dueDecimali, 'costo_unitario ammette al massimo due decimali'),
  categoria_id: zUuid.nullish(),
  scadenza: zData.nullish(),
  gruppo: z.string().trim().max(80).nullish(),
})

const ancoraSchema = z.object({
  specie: z.enum(['esistente', 'nuova', 'ticket']),
  indice: z.coerce.number().int().min(0).max(MAX_RIGHE_PER_ELENCO),
})

const postBodySchema = z
  .object({
    /** La sede del DOCUMENTO, scelta dall'operatore (§3). Non è la sede delle voci. */
    scuola_id: zUuid,
    pagante_parent_id: zUuid,
    riferimento: z.string().trim().max(200).nullish(),
    note: z.string().trim().max(500).nullish(),
    voci: z.array(voceSchema).max(MAX_RIGHE_PER_ELENCO).default([]),
    voci_nuove: z.array(voceNuovaSchema).max(MAX_RIGHE_PER_ELENCO).default([]),
    voci_ticket: z.array(voceTicketSchema).max(MAX_RIGHE_PER_ELENCO).default([]),
    ancora: ancoraSchema.optional(),
  })
  .superRefine((b, ctx) => {
    const totale = b.voci.length + b.voci_nuove.length + b.voci_ticket.length
    if (totale > MAX_RIGHE_TOTALI) {
      ctx.addIssue({ code: 'custom', path: ['voci'], message: `troppe righe: massimo ${MAX_RIGHE_TOTALI}` })
    }
  })

const OPERAZIONE = 'pagamenti/riconciliazione/[id]/componi:POST'

// ⚠️ IL NOME È SCRITTO DUE VOLTE, ed è voluto. Il lock
// `__tests__/architecture/logging-coverage.test.ts` cerca un LETTERALE subito
// dopo `withRoute(` — una costante lì dentro lo rende cieco su questa route, e un
// lock cieco per costruzione in questo repo è già costato due volte. `OPERAZIONE`
// resta per le righe di log che la nominano, qui e nel modulo, a cui viene
// passata. Che le due stringhe restino la stessa lo verifica un test («il nome
// del withRoute e la costante OPERAZIONE non divergono»), non la buona volontà
// di chi rinomina.
export const POST = withRoute(
  'pagamenti/riconciliazione/[id]/componi:POST',
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    try {
      // GATE PRIMA DEL CORPO: il lock `corpo-letto-dopo-il-gate` lo verifica, e la
      // ragione è che il corpo di un anonimo non si legge né si bufferizza.
      const auth = await requireStaff(request)
      if (auth.response) return auth.response
      const { user } = auth

      const { id: rawId } = await context.params
      const idParsed = parseData(zUuid, rawId)
      if ('response' in idParsed) return idParsed.response
      const movimentoId = idParsed.data

      const b = await parseBody(request, postBodySchema)
      if ('response' in b) return b.response
      const body = b.data

      const supabase = await createAdminClient()

      // ── L'ELENCO DELLE SEDI: UNO SOLO, e lo risolve la rotta ───────────────
      // ⚠️ `resolveScuoleAttive` e non `resolveScuolaScrittura`, ed è una scelta.
      // Il secondo risolve UNA sede e la confronta con le accessibili ignorando il
      // SedeSelector; qui serve un INSIEME, perché le voci di un bonifico
      // cross-sede vanno confrontate una per una. Un elenco solo, una regola sola.
      // Il prezzo è che una selezione stretta nel SedeSelector restringe anche la
      // scrittura — e la direzione in cui si sbaglia è quella sicura: mai più
      // larga dell'ambito dichiarato a schermo.
      //
      // Va al modulo come PARAMETRO: il percorso manuale concilia sulle sedi
      // dell'operatore, quello automatico che arriverà su un perimetro che dovrà
      // dichiarare. Un modulo che se lo risolvesse da sé sceglierebbe per tutt'e
      // due, e la differenza diventerebbe accidentale invece che scritta.
      const sedi = await resolveScuoleAttive(request as NextRequest, supabase, user)

      const esito = await registraConciliazione(supabase, {
        movimentoId,
        composizione: body,
        sediAmmesse: sedi,
        attoreId: user.id,
        operazione: OPERAZIONE,
      })
      if (!esito.ok) return NextResponse.json(esito.body, { status: esito.status })
      const { transazioneId, importoTotale, movimentoConfermato, alunniCoinvolti } = esito.ok

      // ⚠️ DENTRO UN `try`, come le due chiamate che seguono, e per la stessa
      // ragione: da qui in poi IL DENARO È SCRITTO. `logScrittura` oggi non lancia
      // — è scritta per non farlo — ma è una garanzia di un altro modulo, e se si
      // rompesse questa eccezione salterebbe al `catch` in fondo, che risponde
      // `500 CONCILIAZIONE_NON_REGISTRATA` dicendo «nulla è stato scritto». Sarebbe
      // la bugia esatta che la rete del `movimento_confermato` esiste per evitare:
      // l'operatrice ritenterebbe, e sulle voci NUOVE e sui ticket non c'è residuo
      // che la fermi. Un audit perso è grave e si logga a `error`; un incasso
      // raddoppiato è peggio.
      try {
        await logScrittura(supabase, {
          attore: user,
          entitaTipo: 'conciliazione',
          entitaId: transazioneId,
          azione: 'insert',
          scuolaId: body.scuola_id,
          valorePrima: null,
          // Nel diff di audit vanno i CONTEGGI e l'importo del bonifico — che è un
          // dato contabile del movimento, non un'anagrafica — mai le descrizioni
          // delle voci, che sono testo libero scritto dall'operatrice.
          valoreDopo: {
            movimento_id: movimentoId,
            transazione_id: transazioneId,
            importo_totale: importoTotale,
            voci: body.voci.length,
            voci_nuove: body.voci_nuove.length,
            voci_ticket: body.voci_ticket.length,
            movimento_confermato: movimentoConfermato,
          },
        })
      } catch (e) {
        logEvento('pagamento', 'error', {
          operazione: OPERAZIONE,
          esito: 'audit_non_scritto',
          movimento_id: movimentoId,
          transazione_id: transazioneId,
        }, e)
      }

      // ── NOTIFICHE: come oggi, nessuna regola nuova, e BEST-EFFORT ──────────
      // `alunniCoinvolti` è lo STESSO elenco su cui si è deciso il pagante, e non
      // una seconda lista ricostruita: due elenchi calcolati in due punti sono il
      // modo in cui un gate e la sua conseguenza smettono di parlare dello stesso
      // insieme senza che nessun test se ne accorga. Per questo arriva dal modulo
      // invece di essere rifatto qui.
      if (alunniCoinvolti.length > 0) {
        try {
          await notificaEvento(supabase, {
            tipo: 'pagamento_registrato',
            scuolaId: body.scuola_id,
            alunnoIds: alunniCoinvolti,
            titolo: 'Pagamento registrato',
            corpo: 'È stato registrato un pagamento. La ricevuta è disponibile nella sezione Pagamenti.',
            link: '/parent/pagamenti',
            entitaTipo: 'transazione',
            entitaId: transazioneId,
            debounce: true,
          })
        } catch (e) {
          logEvento('notifica', 'error', {
            operazione: OPERAZIONE, tipo: 'pagamento_registrato', esito: 'notifica_non_inviata',
          }, e)
        }
        try {
          await verificaRevocaSospensioneMorosita(supabase, alunniCoinvolti)
        } catch (e) {
          logEvento('pagamento', 'error', { operazione: OPERAZIONE, esito: 'revoca_non_verificata' }, e)
        }
      }

      return NextResponse.json(esito.body, { status: esito.status })
    } catch (err) {
      // `withRoute` NON vede le eccezioni catturate: senza questo `logErrore` il
      // 500 sarebbe muto.
      logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
      return NextResponse.json(
        { error: 'Errore interno durante la registrazione del pagamento', codice: 'CONCILIAZIONE_NON_REGISTRATA' },
        { status: 500 },
      )
    }
  },
)
