'use client'

import { Suspense } from 'react'
import { useTranslations } from 'next-intl'
import { Network } from 'lucide-react'
import { useSessionIdentity } from '@/lib/auth/use-session-identity'
import { SidiPanel } from '@/components/features/admin/SidiPanel'
import { CockpitPage, PageHeader } from '@/components/ui/cockpit'

function SidiInner() {
  const t = useTranslations('adminSettings')
  const { userId } = useSessionIdentity()
  return (
    <CockpitPage max={1100}>
      <PageHeader
        eyebrow={t('sistemaEyebrow')}
        icon={Network}
        title={t('sidiTitolo')}
        subtitle={t('sidiSottotitolo')}
      />
      {userId && <SidiPanel userId={userId} />}
    </CockpitPage>
  )
}

export default function AdminSidiPage() {
  return (
    <Suspense fallback={null}>
      <SidiInner />
    </Suspense>
  )
}
