'use client'

import { Suspense } from 'react'
import { useTranslations } from 'next-intl'
import { Network } from 'lucide-react'
import { useSessionIdentity } from '@/lib/auth/use-session-identity'
import { SidiPanel } from '@/components/features/admin/SidiPanel'
import { CockpitPage, PageHeader } from '@/components/ui/cockpit'
import { SedeRequired } from '@/lib/context/sede-context'

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
      {/* Il SIDI si trasmette PER SCUOLA (un codice meccanografico per plesso):
          con più sedi attive non esiste una risposta giusta, e finché non se ne
          sceglie una il pannello non si mostra nemmeno. `SedeNotice` porta i
          bottoni per scegliere, quindi non è un vicolo cieco. */}
      <SedeRequired>
        {(scuolaId) => (userId ? <SidiPanel userId={userId} scuolaId={scuolaId} /> : null)}
      </SedeRequired>
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
