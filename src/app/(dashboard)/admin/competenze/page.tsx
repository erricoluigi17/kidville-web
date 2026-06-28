'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Award } from 'lucide-react'
import { CompetenzePanel } from '@/components/features/admin/CompetenzePanel'

const DEV_ADMIN = '22222222-2222-2222-2222-555555555555'

function CompetenzeInner() {
  const userId = useSearchParams().get('userId') || DEV_ADMIN
  return (
    <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6">
          <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
            <Award size={24} /> Certificati delle Competenze
          </h1>
          <p className="font-maven text-sm text-gray-500">
            Classe quinta primaria (D.M. 14/2024). Le bozze derivano dallo scrutinio finale; la generazione e la firma sono riservate alla Direzione.
          </p>
        </header>
        <CompetenzePanel userId={userId} />
      </div>
    </div>
  )
}

export default function AdminCompetenzePage() {
  return (
    <Suspense fallback={null}>
      <CompetenzeInner />
    </Suspense>
  )
}
