'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Network } from 'lucide-react'
import { SidiPanel } from '@/components/features/admin/SidiPanel'
import { CockpitPage, PageHeader } from '@/components/ui/cockpit'

const DEV_ADMIN = '22222222-2222-2222-2222-555555555555'

function SidiInner() {
  const userId = useSearchParams().get('userId') || DEV_ADMIN
  return (
    <CockpitPage max={1100}>
      <PageHeader
        icon={Network}
        title="Interoperabilità SIDI"
        subtitle="Import nuovi iscritti, allineamento Fase A, invio frequentanti e Piattaforma Unica. La trasmissione reale è subordinata all'accreditamento ministeriale."
      />
      <SidiPanel userId={userId} />
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
