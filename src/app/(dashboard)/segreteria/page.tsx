import { redirect } from 'next/navigation';

// La Segreteria e la Direzione condividono lo STESSO cockpit (shell + sidebar
// "Direzione & Segreteria"). La vecchia rotta /segreteria reindirizza a /admin
// preservando ?userId= (auth applicativa). Niente cockpit parallelo.
export default async function SegreteriaRedirect({
  searchParams,
}: {
  searchParams: Promise<{ userId?: string }>;
}) {
  const sp = await searchParams;
  const qs = sp?.userId ? `?userId=${sp.userId}` : '';
  redirect(`/admin${qs}`);
}
