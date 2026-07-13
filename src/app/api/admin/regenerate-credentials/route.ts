import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { requireStaff } from '@/lib/auth/require-staff';
import { requireEnv } from '@/lib/security/require-env';
import { sendEmailDetailed, credentialsEmailBody } from '@/lib/email/send';
import { ensureParentIdentity, firstEmail, randomPassword } from '@/lib/auth/parent-identity';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { buildCredentialsPdf } from '@/lib/pdf/credentials-pdf';
import { enqueueNotifiche } from '@/lib/push/enqueue';
import { withRoute } from '@/lib/logging/with-route';
import { logEvento } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// targetId è sempre un UUID: parents.id (PK uuid) oppure utenti.id (= auth.users id).
const postBodySchema = z.object({
  targetKind: z.enum(['parent', 'staff']),
  targetId: zUuid,
});

/**
 * POST /api/admin/regenerate-credentials  (DL-005)  — staff (incl. Segreteria)
 * Body: { targetKind: 'parent' | 'staff', targetId }
 *
 * Genera una nuova password random per l'utente target e la invia automaticamente
 * via email. È il flusso di recupero credenziali presidiato dalla Segreteria:
 * nessun self-service "password dimenticata". Tracciato in audit (entita 'credenziali').
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

  const missingEnv = requireEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  if (missingEnv) return missingEnv;
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  let authId: string | null = null;
  let email: string | null = null;
  let nome: string | null = null;
  let identitaCreata = false;

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
    const identita = await ensureParentIdentity(admin, row, { scuolaId: auth.user.scuola_id ?? null });
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
    const { data } = await admin.from('utenti').select('id, email, nome').eq('id', targetId).maybeSingle();
    if (!data) return NextResponse.json({ error: 'Utente staff non trovato' }, { status: 404 });
    authId = (data as { id: string }).id;
    email = firstEmail((data as { email: string | null }).email);
    nome = (data as { nome: string | null }).nome;
  }

  if (!email) {
    return NextResponse.json({ error: 'Target senza email: impossibile inviare le credenziali.' }, { status: 400 });
  }

  const password = randomPassword();
  const { error } = await admin.auth.admin.updateUserById(authId!, { password, email_confirm: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const invio = await sendEmailDetailed({
    to: email,
    subject: 'Le tue credenziali Kidville',
    text: credentialsEmailBody(nome, email, password),
  });
  const emailed = invio.ok;

  // PDF credenziali scaricabile → bucket privato + notifica alla segreteria che
  // ha agito (oltre alla mail). Best-effort: un errore non blocca la rigenerazione.
  let pdfPronto = false;
  try {
    const loginUrl = process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL}/auth/login` : '/auth/login';
    const pdf = buildCredentialsPdf({
      schoolName: 'Kidville',
      nome,
      ruolo: targetKind === 'parent' ? 'Genitore' : 'Staff',
      email,
      password,
      loginUrl,
      generatedAt: new Date().toLocaleString('it-IT'),
    });
    // Assicura il bucket privato (idempotente: se esiste, l'errore è ignorato).
    await admin.storage.createBucket('credenziali', { public: false }).catch(() => {});
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

  await logScrittura(admin as never, {
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
