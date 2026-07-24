'use client'

import { useTranslations } from 'next-intl'
import { Trophy } from 'lucide-react'
import { RankingTable } from '@/components/features/admin/forms/rankings/RankingTable'
import { CockpitPage, PageHeader } from '@/components/ui/cockpit'

export default function RankingsPage() {
  const t = useTranslations('adminModulistica')
  return (
    <CockpitPage max={1152}>
      <PageHeader
        eyebrow={t('eyebrowAmministrazione')}
        icon={Trophy}
        title={t('rnkPageTitle')}
        subtitle={t('rnkPageSubtitle')}
      />
      <RankingTable />
    </CockpitPage>
  )
}
