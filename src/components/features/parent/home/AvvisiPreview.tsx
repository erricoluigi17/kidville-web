'use client'

import { useEffect, useState } from 'react'
import { Megaphone, ClipboardList } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { cx } from '@/lib/ui/cx'
import type { Avviso } from '@/components/features/avvisi/AvvisoCard'

interface Props {
  parentId: string
  studentId: string
}

const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })
  } catch {
    return ''
  }
}

/**
 * Anteprima Avvisi del design (DR AvvisoRow, top 2). SOLA LETTURA: le azioni
 * (adesione / segna come letto) restano sulla pagina /parent/avvisi. Dato
 * esistente: GET /api/diary/students + GET /api/avvisi. Si nasconde se vuoto.
 */
export function AvvisiPreview({ parentId, studentId }: Props) {
  const [items, setItems] = useState<Avviso[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!parentId || !studentId) return
    let active = true
    ;(async () => {
      try {
        const sres = await fetch(`/api/diary/students?id=${studentId}`)
        const student = await sres.json()
        const classe = student?.classe_sezione
        if (classe) {
          const res = await fetch(
            `/api/avvisi?classe=${encodeURIComponent(classe)}&parentId=${parentId}&studentId=${studentId}`,
          )
          const data = await res.json()
          if (active && Array.isArray(data)) setItems(data)
        }
      } catch {
        /* noop: best-effort preview */
      } finally {
        if (active) setLoaded(true)
      }
    })()
    return () => {
      active = false
    }
  }, [parentId, studentId])

  if (!loaded || items.length === 0) return null

  // Priorità: adesione non risposta → presa-visione non letta → resto.
  const score = (a: Avviso) => {
    const answered = !!a.my_response?.risposta
    const read = !!a.my_response?.letto_il
    if (a.tipo === 'adesione' && !answered) return 0
    if (a.tipo !== 'adesione' && !read) return 1
    return 2
  }
  const top = [...items].sort((a, b) => score(a) - score(b)).slice(0, 2)

  return (
    <div className="flex flex-col gap-3">
      {top.map((a) => {
        const isAdesione = a.tipo === 'adesione'
        const Icon = isAdesione ? ClipboardList : Megaphone
        const answered = a.my_response?.risposta
        const read = !!a.my_response?.letto_il
        let tone: BadgeTone
        let label: string
        if (isAdesione) {
          if (answered) {
            tone = answered === 'si' ? 'success' : 'error'
            label = answered === 'si' ? 'Hai aderito' : 'Non aderisci'
          } else {
            tone = 'unread'
            label = 'Richiede adesione'
          }
        } else {
          tone = read ? 'read' : 'info'
          label = read ? 'Letto' : 'Da leggere'
        }
        return (
          <Card key={a.id} className={cx('p-[14px]', !isAdesione && read && 'opacity-70')}>
            <div className="flex items-start gap-3">
              <div
                className={cx(
                  'flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-xl text-kidville-green',
                  isAdesione ? 'bg-kidville-yellow' : 'bg-kidville-green-soft',
                )}
              >
                <Icon size={19} strokeWidth={1.8} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={tone}>{label}</Badge>
                  <span className="font-maven text-[11px] text-kidville-muted">{fmtDate(a.created_at)}</span>
                </div>
                <h3 className="mt-1.5 line-clamp-1 font-barlow text-base font-extrabold uppercase leading-tight text-kidville-green">
                  {a.titolo}
                </h3>
                <p className="mt-1 line-clamp-2 font-maven text-[12.5px] leading-snug text-[#55615c]">
                  {a.contenuto}
                </p>
              </div>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
