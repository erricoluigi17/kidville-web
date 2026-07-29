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

// Il link da diffondere è UNO: `/iscrizione`, uguale per tutti i plessi — è il
// genitore a scegliere la sede al primo passo del wizard.
// `?scuola=<id>` resta una scorciatoia che salta quel passo (link "targato").
//
// `?scuola=` senza valore vale come ASSENTE: la stringa vuota è falsy ma non null,
// e passata giù verrebbe scambiata per "sede già decisa" — il genitore sceglierebbe
// il plesso e l'invio partirebbe comunque senza.
export default async function IscrizionePage({
  searchParams,
}: {
  searchParams: Promise<{ scuola?: string }>
}) {
  const sp = await searchParams
  const scuola = sp.scuola?.trim()
  return <EnrollmentWizard scuolaId={scuola && scuola.length > 0 ? scuola : null} />
}
