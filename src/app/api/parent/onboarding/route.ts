import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { consensiMancanti, CONSENSI_RICHIESTI } from '@/lib/onboarding/consensi'
import { VERSIONE_PRIVACY, VERSIONE_TERMINI } from '@/lib/legal/versioni'
import { notificaEvento, nomeUtente } from '@/lib/notifiche/triggers'
import { staffScuola, scuolaUnicaReale } from '@/lib/notifiche/destinatari'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import {
  valutaPasswordNuova,
  LUNGHEZZA_MINIMA_PASSWORD,
  type CodiceRegolaPassword,
} from '@/lib/auth/regole-password'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postBodySchema = z.object({
  // Record salvato tal quale in `parents.consensi_gdpr`: valori permissivi
  // (oggi nessun vincolo di tipo sui singoli consensi). L'obbligo dei consensi
  // richiesti resta il 422 semantico dell'handler.
  consensi: z.record(z.string(), z.unknown()).optional(),
  // Permissivo: oggi un valore falsy ('' incluso) viene ignorato, e qualsiasi
  // valore truthy viene giudicato da `valutaPasswordNuova`; un vincolo
  // z.string().min(…) cambierebbe il comportamento — e soprattutto duplicherebbe
  // QUI il numero che ora vive in un posto solo. Il giudizio resta nell'handler.
  password: z.unknown().optional(),
})

/**
 * Il rifiuto di ciascun motivo: la prosa (per i log e per chi chiama l'API) e il CODICE
 * (per chi guarda lo schermo).
 *
 * ─── PERCHÉ IL CODICE, DAL 2026-09-01 ──────────────────────────────────────────
 *
 * Il genitore NON legge questa prosa: `src/app/(dashboard)/parent/onboarding/page.tsx` passa
 * da `soloCatalogoDaCorpo`, che mostra la prosa del server MAI e il catalogo tradotto solo
 * quando la risposta porta un `codice` (lock
 * `__tests__/architecture/errori-server-schermate-famiglia.test.ts`: nelle schermate delle
 * famiglie la prosa del server è italiana per costruzione e non si mostra). Finché questi
 * quattro motivi non hanno avuto un codice, a schermo si è letto «Operazione non riuscita.
 * Riprova.» davanti a una password correggibile in tre secondi — cioè il motivo vero viveva
 * qui e nel log, e in nessun posto in cui potesse servire a chi stava digitando.
 *
 * ─── PERCHÉ QUATTRO COSTRUTTORI E NON UNA RISPOSTA SOLA ────────────────────────
 *
 * Perché il `codice` va scritto come STRINGA LETTERALE: il lock
 * `__tests__/architecture/errori-con-codice.test.ts` legge il corpo di ogni
 * `NextResponse.json({ … })` e un `codice: mappa[x].codice` non lo saprebbe verificare —
 * non contro `CODICI_ERRORE`, non contro i due cataloghi. Un valore che il lock non sa
 * leggere è un valore che nessuno controlla, ed è esattamente il buco che quel file ha
 * chiuso il 2026-08-03. Qui ogni codice è scritto per esteso e verificabile a occhio.
 *
 * `PASSWORD_UGUALE_ALLA_PRECEDENTE` da questa route non può uscire (l'onboarding non conosce
 * nessuna password precedente e non passa `attuale`): sta nella mappa perché il tipo è
 * esaustivo, cioè perché il giorno in cui una regola nuova si aggiunge il compilatore
 * pretenda anche il suo rifiuto, invece di lasciar uscire `undefined`.
 *
 * Il numero non è ricopiato: viene da `LUNGHEZZA_MINIMA_PASSWORD`, che è il posto in cui la
 * regola vive. Le due copie inevitabili — le voci di catalogo, che sono JSON e non possono
 * importare una costante — le sorveglia
 * `__tests__/components/parent-onboarding-password.test.tsx`.
 */
const RIFIUTO_PASSWORD: Record<CodiceRegolaPassword, () => NextResponse> = {
  PASSWORD_TROPPO_CORTA: () =>
    NextResponse.json(
      { error: `La password deve avere almeno ${LUNGHEZZA_MINIMA_PASSWORD} caratteri.`, codice: 'PASSWORD_TROPPO_CORTA' },
      { status: 400 },
    ),
  PASSWORD_SENZA_CIFRA: () =>
    NextResponse.json(
      { error: 'La password deve contenere almeno una lettera e almeno una cifra.', codice: 'PASSWORD_SENZA_CIFRA' },
      { status: 400 },
    ),
  PASSWORD_CON_SPAZI_AI_BORDI: () =>
    NextResponse.json(
      { error: 'La password non può iniziare o finire con uno spazio.', codice: 'PASSWORD_CON_SPAZI_AI_BORDI' },
      { status: 400 },
    ),
  PASSWORD_UGUALE_ALLA_PRECEDENTE: () =>
    NextResponse.json(
      { error: 'La nuova password deve essere diversa da quella attuale.', codice: 'PASSWORD_UGUALE_ALLA_PRECEDENTE' },
      { status: 400 },
    ),
}

// POST /api/parent/onboarding — primo accesso genitore (DL-045):
// accettazione consensi GDPR obbligatori + (opzionale) impostazione password
// Supabase Auth. Marca `parents.onboarded_at`. Prerequisito ingegneristico di
// S13 (sigillo identità): dà al genitore una sessione reale.
export const POST = withRoute('parent/onboarding:POST', async (request: Request) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response

  try {
    const consensi = (b.data.consensi ?? {}) as Record<string, boolean>
    const password = b.data.password as string | undefined

    const mancanti = consensiMancanti(consensi, CONSENSI_RICHIESTI)
    if (mancanti.length > 0) {
      return NextResponse.json({ error: 'Consensi obbligatori mancanti', mancanti }, { status: 422 })
    }
    // LA REGOLA DELLA PASSWORD STA IN UN POSTO SOLO — `@/lib/auth/regole-password`.
    // Qui c'era `String(password).length < 8`, mentre la schermata che chiama questa
    // route ne pretendeva 8 per conto suo e `supabase/config.toml` ne dichiarava 6 al
    // provider: tre numeri per lo stesso gesto, e nessun test che potesse vederli
    // diversi, perché ogni copia era coerente con sé stessa.
    //
    // La password resta FACOLTATIVA: chi accetta solo i consensi non viene giudicato.
    if (password) {
      const regola = valutaPasswordNuova(String(password))
      if (!regola.ok) {
        // Livello `info`: non è un guasto nostro, è una password che non va bene. Va
        // loggato lo stesso, perché senza questa riga «il genitore non completa
        // l'onboarding» non distingue una password rifiutata QUI da una rifiutata da
        // GoTrue cento righe più in basso — due guasti diversi con lo stesso sintomo,
        // e uno solo dei due è nostro. Esce il CODICE, mai la password.
        logEvento('auth', 'info', {
          operazione: 'parent/onboarding:POST',
          esito: 'password-onboarding-rifiutata',
          error_code: regola.codice,
        })
        return RIFIUTO_PASSWORD[regola.codice]()
      }
    }

    const admin = await createAdminClient()
    // `auth.user.id` (dal gate) è l'id della riga `utenti` con ruolo genitore,
    // NON `parents.id` (riga di anagrafica separata): il ponte è
    // `parents.auth_user_id`. Un `.eq('id', auth.user.id)` non ha MAI trovato
    // la riga giusta — verificato in produzione: 0 genitori su 46 risultavano
    // onboardati, perché ogni update qui aggiornava zero righe e rispondeva
    // comunque successo. Corretto insieme alla stessa svista in
    // parent/account/richiesta-cancellazione e in onboarding/consensi.ts (C5).
    const { data: parent, error: updateErr } = await admin
      .from('parents')
      .update({ consensi_gdpr: consensi, onboarded_at: new Date().toISOString() })
      .eq('auth_user_id', auth.user.id)
      .select('id, auth_user_id')
      .maybeSingle()

    // PostgREST non lancia: senza questo controllo un update fallito veniva
    // ignorato e la risposta dichiarava comunque successo. Con il gate C5 in
    // chat/messages (che legge consensi_gdpr.termini) questo non è più solo
    // un dato di onboarding incompleto: è un genitore che crede di aver
    // accettato i Termini e riceve un 403 permanente senza alcuna diagnosi.
    if (updateErr) {
      logErrore({ operazione: 'parent/onboarding:POST', stato: 500, evento: 'db' }, updateErr)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    // Un UPDATE che non trova righe non è un `{ error }` per PostgREST (0 righe
    // aggiornate è un esito valido, non un guasto) — va quindi controllato a
    // parte: senza questo, un genitore senza riga `parents` agganciata
    // riceverebbe comunque "successo" e non saprebbe mai perché la chat
    // continua a rifiutarlo.
    if (!parent) {
      logErrore(
        { operazione: 'parent/onboarding:POST', stato: 404, evento: 'db' },
        new Error('nessuna riga parents con questo auth_user_id'),
      )
      return NextResponse.json({ error: 'Profilo genitore non trovato' }, { status: 404 })
    }

    // C5 — Prova d'accettazione append-only (art. 1341 c.c.): una riga in
    // `consensi_accettazioni` per ogni consenso ACCETTATO fra quelli richiesti, con
    // la VERSIONE decisa SERVER-SIDE (mai dal client: un client datato o malevolo
    // spedirebbe una versione arbitraria, svuotando il valore probatorio) e la data
    // dal DB (default now()). Best-effort: un fallimento NON fa fallire l'onboarding
    // (loggato, mai swallow). PostgREST non lancia → si controlla { error }. Degrada
    // pulito sul DB E2E non migrato (tabella assente → warn, onboarding comunque ok).
    if (parent?.id) {
      const versioni: Record<string, string> = { privacy: VERSIONE_PRIVACY, termini: VERSIONE_TERMINI }
      const righe = CONSENSI_RICHIESTI
        .filter((tipo) => consensi[tipo] === true)
        .map((tipo) => ({ parent_id: parent.id as string, tipo, versione: versioni[tipo] }))
      if (righe.length > 0) {
        const { error: consErr } = await admin.from('consensi_accettazioni').insert(righe)
        if (consErr) {
          logEvento('gdpr', 'warn', {
            operazione: 'parent/onboarding:POST',
            esito: 'prova-consenso-non-registrata',
          }, consErr)
        } else {
          logEvento('gdpr', 'info', {
            operazione: 'parent/onboarding:POST',
            esito: 'prova-consenso-registrata',
            n: righe.length,
          })
        }
      }
    }

    // Imposta la password sulla sessione Supabase Auth solo se il genitore è
    // bindato (auth_user_id) e ha fornito una password.
    //
    // È l'ULTIMO passo, e non per caso: se fallisce, i consensi e la loro prova
    // d'accettazione sono già scritti e non si perdono — l'onboarding si ripete.
    //
    // ⚠️ IL VALORE DI RITORNO NON SI BUTTA VIA. Fino al 2026-07-31 qui c'era un
    // `await` nudo: l'update PostgREST su `parents` era controllato con tanto di
    // commento, e alla riga dopo l'esito di GoTrue
    // finiva nel nulla. Se GoTrue rifiutava — policy password, utente bannato,
    // rate limit, servizio giù — l'onboarding proseguiva e rispondeva
    // `{ success: true, onboarded: true }`: il genitore aveva scelto una
    // password MAI scritta, non riusciva ad accedere, e non esisteva una riga
    // di log da nessuna parte. Dichiarare successo su una credenziale non
    // scritta è il modo più caro di fallire in silenzio.
    if (password && parent?.auth_user_id) {
      const { error: pwErr } = await admin.auth.admin.updateUserById(
        parent.auth_user_id as string,
        { password: String(password) },
      )
      if (pwErr) {
        // Il CORPO dell'errore del provider non si butta via: `message` di
        // GoTrue può essere `undefined` (riga di auth.users non serializzabile,
        // vista in produzione il 31/07), e `status ${…}` da solo non spiega
        // niente. Stessa normalizzazione di parent-identity.ts e backfill.ts.
        const stato = (pwErr as { status?: number }).status
        logEvento('auth', 'error', {
          operazione: 'parent/onboarding:POST',
          esito: 'password-onboarding-non-impostata',
          stato: typeof stato === 'number' ? stato : undefined,
        }, pwErr)
        // 4xx di GoTrue = la password non va bene (l'utente può cambiarla);
        // tutto il resto è un guasto nostro. In entrambi i casi i consensi
        // sono già salvati e l'onboarding è ripetibile: l'update è idempotente.
        const client = typeof stato === 'number' && stato >= 400 && stato < 500
        return NextResponse.json(
          {
            error: client
              ? 'La password non è stata accettata: sceglierne un\'altra. I consensi sono stati salvati.'
              : 'Consensi salvati, ma non è stato possibile impostare la password: riprovare fra poco.',
          },
          { status: client ? 400 : 500 },
        )
      }
      // Regola 5: gli eventi critici loggano anche il SUCCESSO. Senza questa
      // riga «nessun log» non distingue «password impostata» da «non è mai
      // partito niente» — l'ambiguità che ha tenuto nascosto per mesi il
      // guasto delle email di credenziali.
      logEvento('auth', 'info', {
        operazione: 'parent/onboarding:POST',
        esito: 'password-onboarding-impostata',
      })
    }

    // Notifica alla segreteria: onboarding completato (best-effort).
    try {
      const scuolaId = auth.user.scuola_id ?? (await scuolaUnicaReale(admin))
      const destinatari = await staffScuola(admin, scuolaId, ['admin', 'coordinator', 'segreteria'])
      const nome = await nomeUtente(admin, auth.user.id)
      await notificaEvento(admin, {
        tipo: 'onboarding_completato',
        scuolaId,
        utenteIds: destinatari,
        titolo: 'Onboarding genitore completato',
        corpo: `${nome ?? 'Un genitore'} ha completato la registrazione iniziale.`,
        link: '/admin/students',
        entitaTipo: 'onboarding',
        entitaId: auth.user.id,
        bufferMin: 60,
      })
    } catch (e) {
      logEvento('notifica', 'error', {
        operazione: 'parent/onboarding:POST',
        tipo: 'onboarding_completato',
        esito: 'notifica_non_inviata',
      }, e)
    }

    return NextResponse.json({ success: true, onboarded: true })
  } catch (err) {
    logErrore({ operazione: 'parent/onboarding:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
