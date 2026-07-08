import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'

export const metadata = {
  title: 'Iscrizione Nuovo Alunno — Kidville',
  description: 'Modulo di iscrizione per nuovi alunni',
}

// Link pubblico per-scuola: /iscrizione?scuola=<id>. Se assente, l'API risolve la
// scuola reale del deployment (esclude la scuola di test E2E).
export default async function IscrizionePage({
  searchParams,
}: {
  searchParams: Promise<{ scuola?: string }>
}) {
  const sp = await searchParams
  return <EnrollmentWizard scuolaId={sp.scuola ?? null} />
}
