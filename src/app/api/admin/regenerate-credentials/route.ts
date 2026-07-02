import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/auth/require-staff';
import { requireEnv } from '@/lib/security/require-env';
import { sendEmail, credentialsEmailBody } from '@/lib/email/send';
import { randomPassword } from '@/lib/auth/backfill';
import { logScrittura } from '@/lib/audit/scrittura';

/**
 * POST /api/admin/regenerate-credentials  (DL-005)  — staff (incl. Segreteria)
 * Body: { targetKind: 'parent' | 'staff', targetId }
 *
 * Genera una nuova password random per l'utente target e la invia automaticamente
 * via email. È il flusso di recupero credenziali presidiato dalla Segreteria:
 * nessun self-service "password dimenticata". Tracciato in audit (entita 'credenziali').
 */
function firstEmail(emails: unknown): string | null {
  if (Array.isArray(emails)) {
    const e = emails.find((x) => typeof x === 'string' && x.includes('@'));
    return e ? String(e).trim() : null;
  }
  if (typeof emails === 'string' && emails.includes('@')) return emails.trim();
  return null;
}

export async function POST(request: Request) {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => ({}))) as { targetKind?: string; targetId?: string };
  const { targetKind, targetId } = body;
  if (!targetId || (targetKind !== 'parent' && targetKind !== 'staff')) {
    return NextResponse.json({ error: 'targetKind (parent|staff) e targetId sono obbligatori' }, { status: 400 });
  }

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

  if (targetKind === 'parent') {
    const { data } = await admin.from('parents').select('auth_user_id, emails, first_name').eq('id', targetId).maybeSingle();
    if (!data) return NextResponse.json({ error: 'Genitore non trovato' }, { status: 404 });
    authId = (data as { auth_user_id: string | null }).auth_user_id;
    email = firstEmail((data as { emails: unknown }).emails);
    nome = (data as { first_name: string | null }).first_name;
    if (!authId) {
      return NextResponse.json({ error: 'Genitore senza account auth: eseguire prima il backfill (S6).' }, { status: 409 });
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

  const emailed = await sendEmail({
    to: email,
    subject: 'Le tue credenziali Kidville',
    text: credentialsEmailBody(nome, email, password),
  });

  await logScrittura(admin as never, {
    attore: auth.user,
    entitaTipo: 'credenziali',
    entitaId: targetId,
    azione: 'update',
    scuolaId: auth.user.scuola_id ?? null,
    valoreDopo: { targetKind, emailed },
  });

  // La password è già stata cambiata: un fallimento email NON può restare
  // silenzioso, altrimenti l'utente resta chiuso fuori senza che nessuno lo sappia.
  return NextResponse.json({
    ok: true,
    email_inviata: emailed,
    ...(emailed
      ? {}
      : { warning: 'Email non inviata (provider non configurato): comunicare le credenziali manualmente.' }),
    // In dev (nessun provider email) restituiamo le credenziali per la consegna manuale.
    ...(process.env.NODE_ENV !== 'production' ? { devCredentials: { email, password } } : {}),
  });
}
