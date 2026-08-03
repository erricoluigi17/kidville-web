import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { z } from 'zod';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertParentInScope, assertUtenteInScope } from '@/lib/auth/scope';
import { requireEnv } from '@/lib/security/require-env';
import { sendEmailDetailed, credentialsEmailBody } from '@/lib/email/send';
import { nomeSede } from '@/lib/scuole/reali';
import { ensureParentIdentity, firstEmail, randomPassword } from '@/lib/auth/parent-identity';
import { sincronizzaLegamiRuntime } from '@/lib/anagrafiche/legami';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { buildCredentialsPdf } from '@/lib/pdf/credentials-pdf';
import { enqueueNotifiche } from '@/lib/push/enqueue';
import { withRoute } from '@/lib/logging/with-route';
import { logEvento } from '@/lib/logging/logger';
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
 * ⚠️ AUTORIZZAZIONE (T3): i GENITORI possono essere resettati da tutto lo staff di
 * gestione (Segreteria inclusa); le credenziali dello STAFF, invece, solo dalla
 * Direzione (`admin`/`coordinator`) — controllo esplicito sotto.
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

  // Le credenziali dello STAFF sono un'operazione di Direzione (T3): la Segreteria
  // può resettare le credenziali dei GENITORI, non quelle del personale.
  if (targetKind === 'staff' && auth.user.role !== 'admin' && auth.user.role !== 'coordinator') {
    return NextResponse.json(
      { error: 'Credenziali staff: operazione riservata alla Direzione' },
      { status: 403 }
    );
  }

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
    const { data } = await admin.from('utenti').select('id, email, nome, scuola_id').eq('id', targetId).maybeSingle();
    if (!data) return NextResponse.json({ error: 'Utente staff non trovato' }, { status: 404 });
    authId = (data as { id: string }).id;
    email = firstEmail((data as { email: string | null }).email);
    nome = (data as { nome: string | null }).nome;
    sedeId = (data as { scuola_id: string | null }).scuola_id ?? null;
  }

  if (!email) {
    return NextResponse.json({ error: 'Target senza email: impossibile inviare le credenziali.' }, { status: 400 });
  }

  const password = randomPassword();
  const { error } = await admin.auth.admin.updateUserById(authId!, { password, email_confirm: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const sedeNome = await nomeSede(admin, sedeId, 'admin/regenerate-credentials:POST');
  const invio = await sendEmailDetailed({
    to: email,
    subject: 'Le tue credenziali Kidville',
    text: credentialsEmailBody(nome, email, password, sedeNome),
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
    });
    // Assicura il bucket privato. Idempotente: in tutti gli ambienti il bucket ESISTE già, e
    // il 409 «resource already exists» è l'esito ATTESO — si registra a `info` e si tira
    // dritto (AGENTS.md regola 6: un errore ignorabile si logga spiegando perché).
    //
    // Qui prima c'era `.catch(() => {})`, ed era sbagliato due volte. Primo: lo Storage NON
    // lancia, ritorna `{ error }` (regola 7), quindi quel catch non ha mai intercettato
    // niente — l'errore veniva scartato dal fatto stesso di non guardarlo. Secondo: questo è
    // il percorso delle CREDENZIALI, cioè il difetto storico da cui nasce l'intera regola 6.
    // Se il bucket non si può creare, l'upload sotto fallisce e la Segreteria vede un PDF che
    // non arriva: il motivo va detto QUI, dove si sa ancora qual è.
    const creazioneBucket = await admin.storage.createBucket('credenziali', { public: false });
    if (creazioneBucket.error) {
      const giaPresente = /exist/i.test(creazioneBucket.error.message ?? '');
      logEvento(
        'storage',
        giaPresente ? 'info' : 'error',
        {
          operazione: 'admin/regenerate-credentials:POST',
          bucket: 'credenziali',
          esito: giaPresente ? 'bucket-gia-presente' : 'bucket-non-creato',
        },
        giaPresente ? undefined : creazioneBucket.error,
      );
    }
    const pdfKey = `${targetId}-${Date.now()}.pdf`;
    const up = await admin.storage.from('credenziali').upload(pdfKey, pdf, { contentType: 'application/pdf', upsert: true });
    if (up.error) throw up.error;
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
    ...(emailed
      ? {}
      : { warning: `Email non inviata: ${invio.error ?? 'motivo sconosciuto'}. Comunicare le credenziali manualmente (PDF disponibile).` }),
    // In dev (nessun provider email) restituiamo le credenziali per la consegna manuale.
    ...(process.env.NODE_ENV !== 'production' ? { devCredentials: { email, password } } : {}),
  });
});
