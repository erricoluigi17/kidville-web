'use client'

import { useParams } from 'next/navigation'
import { SchedaAlunnoLettura } from '@/components/features/teacher/anagrafica/SchedaAlunnoLettura'

/**
 * Insegnante — la scheda di un bambino. Un guscio: i dati arrivano dall'API, mai
 * nell'HTML (che il service worker salva per l'offline). Il perimetro lo decide la
 * route, non questa pagina.
 */
export default function TeacherSchedaAlunnoPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : ''
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-4 sm:px-6">
      <SchedaAlunnoLettura alunnoId={id} />
    </div>
  )
}
