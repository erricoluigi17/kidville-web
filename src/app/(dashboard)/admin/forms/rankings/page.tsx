'use client'

import { Trophy } from 'lucide-react'
import { RankingTable } from '@/components/features/admin/forms/rankings/RankingTable'
import { CockpitPage, PageHeader } from '@/components/ui/cockpit'

export default function RankingsPage() {
  return (
    <CockpitPage max={1152}>
      <PageHeader
        icon={Trophy}
        title="Graduatorie"
        subtitle="Classifiche con punteggi calcolati automaticamente — clicca su una riga per regolare"
      />
      <RankingTable />
    </CockpitPage>
  )
}
