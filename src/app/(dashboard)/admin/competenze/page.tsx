'use client'

import { Suspense } from 'react'
import { Award } from 'lucide-react'
import { useSessionIdentity } from '@/lib/auth/use-session-identity'
import { CompetenzePanel } from '@/components/features/admin/CompetenzePanel'
import { CockpitPage, PageHeader } from '@/components/ui/cockpit'

function CompetenzeInner() {
  const { userId } = useSessionIdentity()
  return (
    <CockpitPage max={1100}>
      <PageHeader
        icon={Award}
        title="Certificati delle Competenze"
        subtitle="Classe quinta primaria (D.M. 14/2024). Le bozze derivano dallo scrutinio finale; la generazione e la firma sono riservate alla Direzione."
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
