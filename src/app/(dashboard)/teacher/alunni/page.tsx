'use client'

import { Suspense } from 'react'
import { useTranslations } from 'next-intl'
import { Contact } from 'lucide-react'
import { PageHeaderCard } from '@/components/ui/PageHeaderCard'
import { ElencoAlunniDocente } from '@/components/features/teacher/anagrafica/ElencoAlunniDocente'

/**
 * Insegnante — l'anagrafica dei propri bambini, in sola lettura. Il perimetro lo
 * impone la route (sezioni assegnate, anche per materia), non questa pagina.
 * `<Suspense>`: il pannello monta `useFiltri`, che legge `useSearchParams()`.
 */
export default function TeacherAlunniPage() {
  const t = useTranslations('teacherServizi')
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-4 sm:px-6">
      <PageHeaderCard
        eyebrow={t('anagraficaEyebrow')}
        icon={Contact}
        title={t('anagraficaTitolo')}
        subtitle={t('anagraficaSottotitolo')}
        compatta
      />
      <div className="mt-4">
        <Suspense fallback={null}>
          <ElencoAlunniDocente />
        </Suspense>
      </div>
    </div>
  )
}
