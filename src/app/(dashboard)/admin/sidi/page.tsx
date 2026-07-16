'use client'

import { Suspense } from 'react'
import { Network } from 'lucide-react'
import { useSessionIdentity } from '@/lib/auth/use-session-identity'
import { SidiPanel } from '@/components/features/admin/SidiPanel'
import { CockpitPage, PageHeader } from '@/components/ui/cockpit'

function SidiInner() {
  const { userId } = useSessionIdentity()
  return (
    <CockpitPage max={1100}>
      <PageHeader
        eyebrow="Sistema"
        icon={Network}
        title="Interoperabilità SIDI"
        subtitle="Import nuovi iscritti, allineamento Fase A, invio frequentanti e Piattaforma Unica. La trasmissione reale è subordinata all'accreditamento ministeriale."
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
