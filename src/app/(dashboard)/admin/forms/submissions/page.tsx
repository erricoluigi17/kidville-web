'use client'

import { Inbox } from 'lucide-react'
import { SubmissionsTable } from '@/components/features/admin/forms/submissions/SubmissionsTable'
import { CockpitPage, PageHeader } from '@/components/ui/cockpit'

export default function SubmissionsPage() {
  return (
    <CockpitPage max={1152}>
      <PageHeader
        eyebrow="Amministrazione"
        icon={Inbox}
        title="Compilazioni Ricevute"
        subtitle="Visualizza, filtra ed esporta tutte le risposte ai moduli dinamici"
      />
      <SubmissionsTable />
    </CockpitPage>
  )
}
