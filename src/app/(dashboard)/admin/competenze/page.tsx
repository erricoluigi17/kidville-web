'use client'

import { Suspense } from 'react'
import { useTranslations } from 'next-intl'
import { Award } from 'lucide-react'
import { useSessionIdentity } from '@/lib/auth/use-session-identity'
import { CompetenzePanel } from '@/components/features/admin/CompetenzePanel'
import { CockpitPage, PageHeader } from '@/components/ui/cockpit'

function CompetenzeInner() {
  const { userId } = useSessionIdentity()
  const t = useTranslations('adminStudents')
  return (
    <CockpitPage max={1100}>
      <PageHeader
        eyebrow={t('compEyebrow')}
        icon={Award}
        title={t('compTitolo')}
        subtitle={t('compSottotitolo')}
      />
      {userId && <CompetenzePanel userId={userId} />}
    </CockpitPage>
  )
}

export default function AdminCompetenzePage() {
  return (
    <Suspense fallback={null}>
      <CompetenzeInner />
    </Suspense>
  )
}
