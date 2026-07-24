import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('public')
  return {
    title: t('iscrMetaTitolo'),
    description: t('iscrMetaDescrizione'),
  }
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
