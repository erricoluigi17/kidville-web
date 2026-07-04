import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ACTIVE_ROLE_COOKIE, parseActiveRole } from '@/lib/auth/active-role';
import { decideRootLanding } from '@/lib/auth/area-guard';
import { getSessionProfili } from '@/lib/auth/profili';

// La radice `/` non è una landing pubblica: è un instradatore che richiede
// l'accesso, come la dashboard. L'anonimo è già rediretto a `/auth/login` dal
// middleware; qui (difesa in profondità) si risolve la sessione e si smista
// sulla home del proprio ruolo (genitore→/parent, docente→/teacher, staff→/admin).
export default async function Home() {
  // cookies() PRIMA e FUORI da try/catch: in build il bailout "dynamic server"
  // deve propagarsi (come in requireArea) e non essere inghiottito da
  // getSessionProfili, che cattura ogni errore restituendo null.
  const cookieStore = await cookies();
  const cookieRuolo = parseActiveRole(cookieStore.get(ACTIVE_ROLE_COOKIE)?.value);
  const sessione = await getSessionProfili();
  redirect(decideRootLanding(sessione?.profili ?? null, cookieRuolo));
}
