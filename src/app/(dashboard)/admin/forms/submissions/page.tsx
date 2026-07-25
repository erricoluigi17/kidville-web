'use client'

import { useTranslations } from 'next-intl'
import { Inbox } from 'lucide-react'
import { SubmissionsTable } from '@/components/features/admin/forms/submissions/SubmissionsTable'
import { CockpitPage, PageHeader } from '@/components/ui/cockpit'

export default function SubmissionsPage() {
  const t = useTranslations('adminModulistica')
  return (
    <CockpitPage max={1152}>
      <PageHeader
        eyebrow={t('eyebrowAmministrazione')}
        icon={Inbox}
        title={t('subPageTitle')}
        subtitle={t('subPageSubtitle')}
      />
      <SubmissionsTable />
    </CockpitPage>
  )
}
