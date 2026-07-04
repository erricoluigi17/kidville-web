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
        title="Certificato delle Competenze"
        subtitle="Documento di fine classe quinta primaria (D.M. 14/2024). Flusso: le bozze derivano dallo scrutinio finale → si assegnano i livelli A/B/C/D per competenza → la Direzione genera e firma il certificato → il genitore lo trova in Pagelle. Non è la pagella: usa una scala distinta dai giudizi sintetici."
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
