import { NextResponse } from 'next/server';
import { istanteEmissioneCredenziali } from '@/lib/email/istante-emissione'
import { createAdminClient } from '@/lib/supabase/server-client';
import { z } from 'zod';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertParentInScope, assertUtenteInScope } from '@/lib/auth/scope';
import { requireEnv } from '@/lib/security/require-env';
import { sendEmailDetailed } from '@/lib/email/send';
import { risolviContestoSede } from '@/lib/email/contesto';
import { messaggioCredenziali } from '@/lib/email/messaggi/credenziali';
import { ensureParentIdentity, firstEmail, randomPassword } from '@/lib/auth/parent-identity';
import { sincronizzaLegamiRuntime } from '@/lib/anagrafiche/legami';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { buildCredentialsPdf } from '@/lib/pdf/credentials-pdf';
import { enqueueNotifiche } from '@/lib/push/enqueue';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { puoRigenerareCredenzialiStaff } from '@/lib/auth/credenziali-staff';
import { formattaIstante } from '@/i18n/config';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// targetId è sempre un UUID: parents.id (PK uuid) oppure utenti.id (= auth.users id).
const postBodySchema = z.object({
  targetKind: z.enum(['parent', 'staff']),
  targetId: zUuid,
});

/**
 * POST /api/admin/regenerate-credentials  (DL-005)
 * Body: { targetKind: 'parent' | 'staff', targetId }
 *
 * Genera una nuova password random per l'utente target e la invia automaticamente
 * via email. È il flusso di recupero credenziali presidiato dalla Segreteria:
 * nessun self-service "password dimenticata". Tracciato in audit (entita 'credenziali').
 *
 * ⚠️ AUTORIZZAZIONE. I GENITORI possono essere resettati da tutto lo staff di
 * gestione, Segreteria inclusa. Per lo STAFF la regola sta in un posto solo —
 * `puoRigenerareCredenzialiStaff`, `@/lib/auth/credenziali-staff` — e dal
 * 2026-09-03 dice: la Segreteria sì, tranne che sugli account di DIREZIONE
 * (`admin`/`coordinator`).
 *
 * Fino a quel giorno la riserva copriva tutto lo staff, e la decisione di
 * restringerla nasce da una misura: Cesa ha due segreterie e ZERO account di
 * Direzione, quindi per una maestra che perdeva la password bisognava telefonare
 * al titolare. L'eccezione sulla Direzione resta perché il PDF con la password IN
 * CHIARO viene notificato a CHI PREME IL PULSANTE: su un account di Direzione
 * non sarebbe un recupero credenziali, sarebbe un passaggio di consegne.
 *
 * AUTO-RIPARANTE (S6bis): se il genitore non ha ancora un'identità di accesso
 * completa (account auth, riga `utenti`, ponte `parents.auth_user_id`) la crea
 * al volo via `ensureParentIdentity` e poi procede — la Segreteria non deve più
 * conoscere procedure tecniche (il vecchio 409 "eseguire il backfill S6" era un
 * vicolo cieco: quella route in produzione risponde 404 by design).
 */
export const POST = withRoute('admin/regenerate-credentials:POST', async (request: Request) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;

  const b = await parseBody(request, postBodySchema);
  if ('response' in b) return b.response;
  const { targetKind, targetId } = b.data;

  // IL CLIENT ARRIVA DAL FACTORY STRUMENTATO, non più da `createClient` di supabase-js: quello
  // non aveva né tetto di tempo né osservabilità, e da qui passa il RESET DI UNA PASSWORD — con
  // l'email delle nuove credenziali a un genitore. Il perché sta in
  // `src/lib/supabase/server-client.ts`; il lock che impedisce il ritorno indietro è
  // `__tests__/architecture/supabase-client-strumentato.test.ts`.
  //
  // `NEXT_PUBLIC_SUPABASE_URL` non è più fra le env pretese: il factory usa `SUPABASE_URL` di
  // `public-config.ts`, che ha un ripiego dichiarato e quindi non manca mai. Continuare a
  // esigerla qui darebbe un 503 in un ambiente dove il client funziona — una precondizione
  // falsa, che è peggio di nessuna precondizione.
  const missingEnv = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (missingEnv) return missingEnv;
  const admin = await createAdminClient();

  // Isolamento per sede. Il gate di ruolo c'era, lo scope no: si resettava la
  // password di un genitore (o di un membro dello staff) di un'ALTRA sede e gli
  // si spediva le nuove credenziali per email. Il genitore si verifica dai figli
  // (`parents` non ha sede); lo staff dalla propria `utenti.scuola_id`.
  const fuoriScope = targetKind === 'parent'
    ? await assertParentInScope(admin, auth.user, targetId)
    : await assertUtenteInScope(admin, auth.user, targetId);
  if (fuoriScope) return fuoriScope;

  let authId: string | null = null;
  let email: string | null = null;
  let nome: string | null = null;
  let identitaCreata = false;
  // La sede a cui appartiene il destinatario: finisce nel corpo dell'email e
  // nel PDF delle credenziali. Con tre plessi «Kidville» non identifica più
  // niente, e un genitore che riceve le credenziali del plesso sbagliato non ha
  // modo di accorgersene.
  let sedeId: string | null = null;
  /** Dichiarazione per l'operatore quando il login è stato spostato di indirizzo. */
  let indirizzoSpostato: string | null = null;

  if (targetKind === 'parent') {
    const { data } = await admin
      .from('parents')
      .select('id, auth_user_id, emails, first_name, last_name')
      .eq('id', targetId)
      .maybeSingle();
    if (!data) return NextResponse.json({ error: 'Genitore non trovato' }, { status: 404 });
    const row = data as {
      id: string;
      auth_user_id: string | null;
      emails: unknown;
      first_name: string | null;
      last_name: string | null;
    };
    email = firstEmail(row.emails);
    nome = row.first_name;
    // Completa (o verifica) l'identità di accesso: account auth, ponte
    // anagrafica↔account e riga `utenti` ruolo genitore. Idempotente.
    //
    // LA SEDE DEL GENITORE VIENE DAI FIGLI. Qui si passava `scuolaId:
    // auth.user.scuola_id`, cioè la sede di CHI PREME IL BOTTONE: l'unico admin
    // reale ha come primaria Giugliano ed è l'unico che possa gestire Aversa e
    // Cesa, quindi al primo invio di credenziali a una famiglia di Aversa quel
    // genitore nasceva «di Giugliano». La query giusta era già stata fatta 28
    // righe più su da `assertParentInScope`. Ora la sede dell'operatore serve
    // solo a sciogliere l'ambiguità di un genitore con figli in due plessi.
    const identita = await ensureParentIdentity(admin, row, { sedeOperatore: auth.user.scuola_id ?? null });
    if (!identita.ok) {
      if (identita.reason === 'no_email') {
        return NextResponse.json(
          { error: "Genitore senza email in anagrafica: aggiungere un indirizzo email e riprovare l'invio." },
          { status: 400 }
        );
      }
      return NextResponse.json(
        { error: identita.message },
        { status: identita.reason === 'email_conflict' ? 409 : 500 }
      );
    }
    authId = identita.authUserId;
    identitaCreata = identita.createdAuth || identita.createdUtenti || identita.boundNow;

    // ─── L'INDIRIZZO DELL'ACCOUNT DEVE ESSERE QUELLO A CUI SI SPEDISCE ────────
    //
    // `ensureParentIdentity` ha appena provato a portarli sullo stesso valore. Se
    // NON c'è riuscita, l'account vive ancora altrove: scrivere la password qui e
    // spedirla all'indirizzo dell'anagrafica è esattamente il difetto che ha
    // prodotto 13 rigenerazioni a vuoto per una sola famiglia (misurato il
    // 2026-09-04), ognuna delle quali distruggeva anche la password precedente.
    //
    // Ci si ferma PRIMA di `randomPassword()`: una password non scritta è un
    // fastidio, una password scritta e mandata all'indirizzo sbagliato è una
    // famiglia chiusa fuori che prima almeno poteva ancora usare la vecchia.
    //
    // `sconosciuto` NON ferma: un guasto di lettura non è una divergenza, e
    // trattarlo come tale bloccherebbe le credenziali di tutti ogni volta che
    // GoTrue tossisce.
    //
    // Due codici e due `return`, non un ternario: il lock `errori-con-codice`
    // legge il sorgente e pretende un LETTERALE, e soprattutto i due rimedi sono
    // opposti — là si sistemano due anagrafiche, qui si riprova fra un minuto.
    const statoIndirizzo = identita.indirizzo?.stato;
    if (statoIndirizzo === 'in-uso-da-altri') {
      return NextResponse.json(
        {
          error:
            "L'indirizzo di questa anagrafica appartiene già a un altro account: le credenziali non sono state inviate perché la famiglia riceverebbe una password per un indirizzo con cui non può entrare. Unificare le anagrafiche, oppure indicare un indirizzo diverso.",
          codice: 'CREDENZIALI_INDIRIZZO_IN_USO',
        },
        { status: 409 }
      );
    }
    if (statoIndirizzo === 'non-riuscito') {
      return NextResponse.json(
        {
          error:
            "Non è stato possibile allineare l'indirizzo di accesso a quello dell'anagrafica: le credenziali non sono state inviate, perché la famiglia riceverebbe una password per un indirizzo con cui non può entrare. La password precedente resta valida. Riprovare fra qualche minuto.",
          codice: 'CREDENZIALI_INDIRIZZO_NON_ALLINEATO',
        },
        { status: 409 }
      );
    }
    // Il login di questa famiglia è appena cambiato indirizzo: si dichiara a chi ha
    // premuto il pulsante, invece di lasciarglielo scoprire.
    if (identita.indirizzo?.stato === 'allineato') {
      indirizzoSpostato = `L'indirizzo di accesso è stato spostato da ${identita.indirizzo.da} a ${identita.indirizzo.a}, che è quello in anagrafica.`;
    }
    // Risolta dai FIGLI dentro `ensureParentIdentity`, non da chi preme il bottone.
    sedeId = identita.scuolaId;

    // Il genitore ha (finalmente) un account: allinea al runtime i legami che
    // vivono solo in `student_parents`. È il momento in cui gli 11 `parents`
    // senza account della produzione si riparano da soli — non appena la
    // Segreteria manda loro le credenziali. Idempotente, non sovrascrive le
    // quote impostate a mano, e un errore qui non blocca l'invio.
    await sincronizzaLegamiRuntime(admin, targetId);

    // Guard anti-lockout: se l'email dell'anagrafica corrisponde a un account
    // STAFF (incluso il caso docente-che-è-anche-genitore), il reset da qui
    // cambierebbe la password di QUEL login — admin compreso (es. anagrafica di
    // prova con l'email del titolare in sandbox Resend). Le credenziali staff
    // si gestiscono dal pannello Staff.
    const { data: profilo } = await admin.from('utenti').select('ruolo').eq('id', authId).maybeSingle();
    const ruoloAccount = (profilo as { ruolo?: string } | null)?.ruolo ?? null;
    if (ruoloAccount && ruoloAccount !== 'genitore') {
      return NextResponse.json(
        {
          error: `L'email di questa anagrafica corrisponde a un account staff (${ruoloAccount}): rigenerare le credenziali dal pannello Staff, oppure correggere l'email del genitore.`,
        },
        { status: 409 }
      );
    }
  } else {
    // staff: utenti.id È l'auth.users id (FK utenti_id_fkey)
    //
    // `ruolo` è nel select perché da qui in giù serve a DECIDERE, non a mostrare:
    // dal 2026-09-03 la Segreteria rigenera le credenziali dello staff del proprio
    // plesso ma non quelle della Direzione, e il ruolo del bersaglio è l'unico
    // modo di saperlo. In `utenti` la colonna è NOT NULL: una riga vera lo porta
    // sempre.
    const { data, error: erroreUtente } = await admin
      .from('utenti')
      .select('id, email, nome, scuola_id, ruolo')
      .eq('id', targetId)
      .maybeSingle();
    // PostgREST NON lancia: ritorna `{ error }` (AGENTS.md regola 7). Senza questa
    // riga un guasto di lettura diventerebbe «ruolo assente» → 403: un diniego
    // indistinguibile da un tentativo vero, che riempirebbe di rumore un contatore
    // nato come segnale di sicurezza. E se il guasto fosse intermittente, la
    // Segreteria vedrebbe «riservato alla Direzione» a caso, su colleghe che il
    // giorno prima poteva servire.
    if (erroreUtente) {
      logErrore({ operazione: 'admin/regenerate-credentials:POST', stato: 500, evento: 'db' }, erroreUtente);
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'Utente staff non trovato' }, { status: 404 });
    const riga = data as {
      id: string;
      email: string | null;
      nome: string | null;
      scuola_id: string | null;
      ruolo: string | null;
    };

    /* ── IL GATE, e sta QUI e non in cima di proposito ────────────────────────
     * L'ordine è «prima la sede, poi il ruolo»: `assertUtenteInScope` è già
     * passato una quarantina di righe più su, quindi chi è fuori plesso ha già
     * ricevuto «fuori dal tuo plesso» e non arriva mai a sapere che ruolo abbia
     * quella persona. Anticipare questo controllo trasformerebbe la route in un
     * modo per scoprire chi è admin in una sede che non è la propria.
     *
     * La riserva non è sparita rispetto al gate che stava in cima: si è
     * ristretta. Prima escludeva la Segreteria da TUTTO lo staff — e a Cesa, che
     * non ha nessun account di Direzione, questo lasciava due segreterie senza
     * strumento. Ora esclude soltanto gli account la cui password vale il plesso.
     */
    if (!puoRigenerareCredenzialiStaff(auth.user.role, riga.ruolo)) {
      // `warn` → persistito: il tentativo di resettare un account di Direzione è
      // un segnale di sicurezza e deve lasciare traccia. Né l'uuid né il ruolo del
      // bersaglio: basta sapere che è successo, e a chi (AGENTS.md regola 8).
      logEvento('auth', 'warn', {
        tipo: 'credenziali-staff-riservate',
        azione: 'admin/regenerate-credentials:POST',
        utente: auth.user.id,
        ruolo: auth.user.role,
      });
      return NextResponse.json(
        {
          error: 'Le credenziali di un account di Direzione si rigenerano dalla Direzione',
          codice: 'CREDENZIALI_STAFF_RISERVATE',
        },
        { status: 403 },
      );
    }

    authId = riga.id;
    email = firstEmail(riga.email);
    nome = riga.nome;
    sedeId = riga.scuola_id ?? null;
  }

  if (!email) {
    return NextResponse.json({ error: 'Target senza email: impossibile inviare le credenziali.' }, { status: 400 });
  }

  const password = randomPassword();
  const { error } = await admin.auth.admin.updateUserById(authId!, { password, email_confirm: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // `sedeNome` resta perché serve anche al PDF; l'email prende il contesto
  // completo (indirizzo e casella del plesso per il piè di pagina).
  const sede = await risolviContestoSede(admin, sedeId, 'admin/regenerate-credentials:POST');
  const sedeNome = sede.nome === 'Kidville' ? null : sede.nome;
  // Un'unica email di credenziali per tutti e quattro i momenti in cui parte, e
  // per entrambi i pubblici: questa route serve sia un genitore sia una
  // dipendente, e prima aveva pure un oggetto diverso dagli altri tre punti
  // («Le tue credenziali Kidville» invece di «Credenziali di accesso — Kidville»).
  const messaggio = messaggioCredenziali(
    { nome, email, password, occasione: 'password-rigenerata', emessaIl: istanteEmissioneCredenziali() },
    sede,
  );
  const invio = await sendEmailDetailed({
    to: email,
    subject: messaggio.oggetto,
    text: messaggio.testo,
    html: messaggio.html,
  });
  const emailed = invio.ok;

  // PDF credenziali scaricabile → bucket privato + notifica alla segreteria che
  // ha agito (oltre alla mail). Best-effort: un errore non blocca la rigenerazione.
  let pdfPronto = false;
  try {
    const loginUrl = process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL}/auth/login` : '/auth/login';
    const pdf = buildCredentialsPdf({
      schoolName: sedeNome ?? 'Kidville',
      nome,
      ruolo: targetKind === 'parent' ? 'Genitore' : 'Staff',
      email,
      password,
      loginUrl,
      generatedAt: formattaIstante(new Date(), 'it', { day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }),
      // Da questa rotta si esce SEMPRE riscrivendo una password che c'era già:
      // il foglio deve dire la stessa cosa dell'email, o chi ha due fogli in mano
      // non sa quale sia quello buono.
      annullaPrecedenti: true,
    });
    // ─── IL BUCKET NON SI CREA PIÙ A OGNI RIGENERAZIONE ──────────────────────
    //
    // Qui c'era `createBucket('credenziali')`, con la sua classificazione corretta
    // («esiste» → `info`). Il problema non era la classificazione: era la DOMANDA.
    // Misurato in produzione il 2026-09-04: **32 righe `error` in un giorno** con
    // `BucketAlreadyExists`, `stato_http 400` — e non le scriveva questa route, le
    // scriveva `supabase-fetch.ts`, dove un 4xx sullo Storage è `error` per
    // invariante dichiarata: «un 4xx qui è una richiesta sbagliata scritta da noi».
    //
    // Aveva ragione. La richiesta sbagliata era chiedere, a ogni singola
    // rigenerazione, di creare un bucket che esiste dal primo giorno. Non si
    // allenta l'invariante — varrebbe per tutto lo Storage: si toglie la domanda.
    // Un canale d'allarme pieno di allarmi falsi è un canale spento.
    //
    // Il caso che quella chiamata voleva prevenire — bucket assente — non è
    // scomparso: è stato spostato dove si manifesta, cioè sull'upload, dove costa
    // una riga sola e solo quando succede davvero.
    const pdfKey = `${targetId}-${Date.now()}.pdf`;
    const up = await admin.storage.from('credenziali').upload(pdfKey, pdf, { contentType: 'application/pdf', upsert: true });
    if (up.error) {
      // Lo Storage NON lancia, ritorna `{ error }` (AGENTS.md regola 7): il valore
      // di ritorno si guarda. E il corpo dell'errore non si butta via — è l'unica
      // cosa che dice *perché* il PDF non c'è.
      const bucketAssente = /bucket not found|not found.*bucket/i.test(up.error.message ?? '');
      logEvento(
        'storage',
        'error',
        {
          operazione: 'admin/regenerate-credentials:POST',
          bucket: 'credenziali',
          // Due esiti distinti perché mandano a cercare in due posti diversi: uno
          // è «manca il contenitore», l'altro «il contenitore c'è e il file no».
          esito: bucketAssente ? 'bucket-credenziali-assente' : 'pdf-credenziali-non-caricato',
        },
        up.error,
      );
      throw up.error;
    }
    await enqueueNotifiche(admin, {
      utenteIds: [auth.user.id],
      tipo: 'credenziali',
      titolo: 'Credenziali rigenerate',
      corpo: `${nome ?? email}: PDF con le credenziali pronto per il download.`,
      link: `/api/admin/credentials-pdf?key=${encodeURIComponent(pdfKey)}`,
      entitaTipo: 'credenziali',
      entitaId: targetId,
      scuolaId: auth.user.scuola_id ?? null,
    });
    pdfPronto = true;
  } catch (e) {
    // Il PDF e la notifica sono un effetto collaterale: la password è GIÀ stata cambiata e la
    // richiesta non deve fallire. Ma «saltati» va detto — la Segreteria si aspetta un PDF che
    // non troverà, e senza questa riga l'assenza sarebbe inspiegabile. `warn` e non `error`:
    // l'operazione principale è riuscita. Va in tabella (vaPersistito persiste i warn).
    logEvento('credenziali', 'warn', {
      operazione: 'admin/regenerate-credentials:POST',
      esito: 'pdf-notifica-saltati',
    }, e);
  }

  await logScrittura(admin, {
    attore: auth.user,
    entitaTipo: 'credenziali',
    entitaId: targetId,
    azione: 'update',
    scuolaId: auth.user.scuola_id ?? null,
    valoreDopo: { targetKind, emailed, emailError: invio.error, pdf: pdfPronto, identitaCreata },
  });

  // La password è già stata cambiata: un fallimento email NON può restare
  // silenzioso, altrimenti l'utente resta chiuso fuori senza che nessuno lo sappia.
  // Il warning riporta il MOTIVO REALE del provider (es. dominio mittente non
  // verificato → consegna solo verso il titolare), non un generico "non configurato".
  return NextResponse.json({
    ok: true,
    email_inviata: emailed,
    identita_creata: identitaCreata,
    pdf_notifica: pdfPronto,
    ...(indirizzoSpostato ? { indirizzoSpostato } : {}),
    ...(emailed
      ? {}
      : { warning: `Email non inviata: ${invio.error ?? 'motivo sconosciuto'}. Comunicare le credenziali manualmente (PDF disponibile).` }),
    // In dev (nessun provider email) restituiamo le credenziali per la consegna manuale.
    ...(process.env.NODE_ENV !== 'production' ? { devCredentials: { email, password } } : {}),
  });
});
