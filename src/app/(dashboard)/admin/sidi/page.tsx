'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Network } from 'lucide-react'
import { SidiPanel } from '@/components/features/admin/SidiPanel'

const DEV_ADMIN = '22222222-2222-2222-2222-555555555555'

function SidiInner() {
  const userId = useSearchParams().get('userId') || DEV_ADMIN
  return (
    <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6">
          <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
            <Network size={24} /> Interoperabilità SIDI
          </h1>
          <p className="font-maven text-sm text-gray-500">
            Import nuovi iscritti, allineamento Fase A, invio frequentanti e Piattaforma Unica.
            La trasmissione reale è subordinata all&apos;accreditamento ministeriale.
          </p>
        </header>
        <SidiPanel userId={userId} />
      </div>
    </div>
  )
}

export default function AdminSidiPage() {
  return (
    <Suspense fallback={null}>
      <SidiInner />
    </Suspense>
  )
}
