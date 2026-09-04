import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { consensiMancanti, CONSENSI_RICHIESTI } from '@/lib/onboarding/consensi'
import { VERSIONE_PRIVACY, VERSIONE_TERMINI } from '@/lib/legal/versioni'
import { notificaEvento, nomeUtente } from '@/lib/notifiche/triggers'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { sediDeiFigli } from '@/lib/anagrafiche/sedi'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { classificaRifiutoPassword, codiceProviderPerLog } from '@/lib/auth/rifiuto-provider-password'
import {
  valutaPasswordNuova,
  LUNGHEZZA_MINIMA_PASSWORD,
  type CodiceRegolaPassword,
} from '@/lib/auth/regole-password'

/**
 * LE SEGRETERIE DA AVVISARE: QUELLE DEI FIGLI, MAI QUELLA DELL'ACCOUNT.
 *
 * ─── COS'ERA ─────────────────────────────────────────────────────────────────
 *     const scuolaId = auth.user.scuola_id ?? (await scuolaUnicaReale(admin))
 *
 * `auth.user.scuola_id` è la sede dell'ACCOUNT: il plesso in cui l'account è
 * stato aperto. Un genitore può avere due figli in due plessi — `parents` non ha
 * `scuola_id`, ed è una scelta esplicita (vedi `admin/parents/route.ts`) — quindi
 * quel valore è al più UNA delle sue sedi, e può non essere nessuna delle
 * attuali. La segreteria dell'altro plesso non sapeva mai che quella famiglia
 * aveva completato la registrazione: nessun errore, nessun log, solo una
 * notifica che non arriva.
 *
 * `scuolaUnicaReale`, l'anello successivo, è DEPRECATA e con tre sedi risponde
 * sempre `null`: non era un ripiego, era un anello morto.
 *
 * ─── PERCHÉ QUI SI COPRONO TUTTE ─────────────────────────────────────────────
 * Perché non si sta archiviando niente in un plesso: i consensi sono già scritti
 * su `parents`, che una sede non ce l'ha. Qui si decide soltanto CHI viene
 * informato, e una famiglia seguita da due plessi li riguarda entrambi. Dove
 * invece si SCRIVE una riga la regola resta l'opposta: `segnalazioni:POST`
 * rifiuta piuttosto che indovinare il plesso.
 *
 * ─── IL RIPIEGO CHE RESTA ────────────────────────────────────────────────────
 * L'onboarding si può completare PRIMA che il legame col figlio sia scritto: lì
 * non c'è nessuna sede da dedurre, e non avvisare nessuno sarebbe peggio che
 * avvisare la sede dell'account. Si usa quella, ma **lo si scrive nei log**:
 * è una deduzione, non un dato, e chi legge i log deve poterle distinguere.
 */
async function sediDaAvvisare(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  accountGenitore: string,
  sedeAccount: string | null,
): Promise<string[]> {
  // La lettura (figli → plessi) sta in `@/lib/anagrafiche/sedi`: era scritta
  // identica in tre route, e in questo repo una regola valida per più strade vive
  // in un posto solo. Lì dentro c'è anche il controllo di `{ error }` — PostgREST
  // non lancia — e la riga di `warn` col solo CONTEGGIO dei figli, mai gli uuid.
  const sedi = await sediDeiFigli(admin, accountGenitore, {
    gruppo: 'multi_sede',
    operazione: 'parent/onboarding:POST',
  })
  if (sedi.length > 0) return sedi

  if (sedeAccount) {
    logEvento('multi_sede', 'info', {
      operazione: 'parent/onboarding:POST',
      esito: 'sede-onboarding-dedotta-dall-account',
      sede: sedeAccount,
    })
    return [sedeAccount]
  }

  // Né figli né sede sull'account: non si inventa un plesso. Il chiamante non
  // accoda niente, e la riga qui sotto è ciò che distingue «nessun destinatario»
  // da «la notifica non è mai partita».
  logEvento('multi_sede', 'warn', {
    operazione: 'parent/onboarding:POST',
    esito: 'sede-onboarding-non-determinabile',
    utente: accountGenitore,
  })
  return []
}

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
        // 4xx di GoTrue = la password non va bene (l'utente può cambiarla);
        // tutto il resto è un guasto nostro. In entrambi i casi i consensi
        // sono già salvati e l'onboarding è ripetibile: l'update è idempotente.
        //
        // ⚠️ I 4xx NON SONO TUTTI UGUALI. `422 weak_password` — password presente
        // in elenchi di credenziali rubate — è il rifiuto più frequente di questa
        // route (misurato il 2026-09-04: 5 occorrenze su 2 utenti, 9 su 3 il giorno
        // prima), e il suo rimedio è l'unico che NON riguarda la forma della
        // password. La classificazione sta in `rifiuto-provider-password.ts`,
        // condivisa con `POST /api/account/password`: la stessa domanda posta in
        // due posti diverge, e si vede come due utenti che leggono due frasi
        // diverse per lo stesso identico rifiuto.
        const rifiuto = classificaRifiutoPassword(pwErr)
        logEvento('auth', 'error', {
          operazione: 'parent/onboarding:POST',
          esito: 'password-onboarding-non-impostata',
          stato: typeof stato === 'number' ? stato : undefined,
          // Enumerato, già in chiaro per dichiarazione in `redact.ts`: senza, i
          // rifiuti di una giornata restano una massa indistinta.
          error_code: codiceProviderPerLog(pwErr),
        }, pwErr)
        // ⚠️ IL `codice` NON È FACOLTATIVO. La pagina passa da
        // `soloCatalogoDaCorpo`, che senza codice mostra il generico «Operazione
        // non riuscita. Riprova.»: fino al 2026-09-04 questa route non ne
        // dichiarava nessuno, e ogni rifiuto arrivava a schermo muto.
        //
        // Il rassicurante «i consensi sono stati salvati» NON entra nella frase di
        // catalogo — quella è condivisa con l'altra route, dove i consensi non
        // c'entrano — ma esce come `consensi_salvati`, che la pagina compone con
        // la propria traduzione.
        //
        // ⚠️ TRE `return` E NON UNA VARIABILE `codice`. Il lock
        // `__tests__/architecture/errori-con-codice.test.ts` legge il sorgente e
        // pretende una stringa LETTERALE: solo così può verificare che il codice
        // sia dichiarato in `CODICI_ERRORE` e tradotto in entrambe le lingue. Un
        // ternario gli è opaco, e un codice mai tradotto passerebbe inosservato
        // fino a comparire a schermo come tale.
        if (rifiuto === 'password-nota') {
          return NextResponse.json(
            {
              error: 'La password non è stata accettata: sceglierne un\'altra. I consensi sono stati salvati.',
              codice: 'PASSWORD_TROPPO_COMUNE',
              consensi_salvati: true,
            },
            { status: 400 },
          )
        }
        if (rifiuto === 'password-non-accettata') {
          return NextResponse.json(
            {
              error: 'La password non è stata accettata: sceglierne un\'altra. I consensi sono stati salvati.',
              codice: 'PASSWORD_RIFIUTATA',
              consensi_salvati: true,
            },
            { status: 400 },
          )
        }
        return NextResponse.json(
          {
            error: 'Consensi salvati, ma non è stato possibile impostare la password: riprovare fra poco.',
            codice: 'PASSWORD_NON_SCRITTA',
            consensi_salvati: true,
          },
          { status: 500 },
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
      const sedi = await sediDaAvvisare(admin, auth.user.id, auth.user.scuola_id ?? null)
      const nome = await nomeUtente(admin, auth.user.id)
      // Una notifica per sede: `notificaEvento` archivia la riga CON il plesso,
      // quindi due segreterie sono due righe, non una con due destinatari.
      for (const scuolaId of sedi) {
        const destinatari = await staffScuola(admin, scuolaId, ['admin', 'coordinator', 'segreteria'])
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
      }
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
