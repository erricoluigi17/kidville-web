'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Award } from 'lucide-react'
import { CompetenzePanel } from '@/components/features/admin/CompetenzePanel'
import { CockpitPage, PageHeader } from '@/components/ui/cockpit'

const DEV_ADMIN = '22222222-2222-2222-2222-555555555555'

function CompetenzeInner() {
  const userId = useSearchParams().get('userId') || DEV_ADMIN
  return (
    <CockpitPage max={1100}>
      <PageHeader
        icon={Award}
        title="Certificati delle Competenze"
        subtitle="Classe quinta primaria (D.M. 14/2024). Le bozze derivano dallo scrutinio finale; la generazione e la firma sono riservate alla Direzione."
      />
      <CompetenzePanel userId={userId} />
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
