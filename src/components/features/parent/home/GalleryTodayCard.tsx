'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Image as ImageIcon, ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

interface Props {
  studentId: string
  parentId: string
  href: string
}

/**
 * "Foto di oggi" del design (DR galleria). Mostra il conteggio dei contenuti di
 * oggi del figlio e linka alla galleria completa. Dato esistente:
 * GET /api/gallery?studentId=&date=&parentId= → { total }. Si nasconde se 0.
 */
export function GalleryTodayCard({ studentId, parentId, href }: Props) {
  const [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!studentId || !parentId) return
    let active = true
    const today = new Date().toISOString().split('T')[0]
    fetch(`/api/gallery?studentId=${studentId}&date=${today}&parentId=${parentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (active && typeof j?.total === 'number') setTotal(j.total)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [studentId, parentId])

  if (!loaded || total === 0) return null

  return (
    <Link href={href} className="block">
      <Card tappable className="flex items-center gap-3 p-4">
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[14px] bg-kidville-green text-kidville-yellow">
          <ImageIcon size={21} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-barlow text-base font-black uppercase leading-none text-kidville-green">Foto di oggi</p>
          <p className="mt-1 font-maven text-[12.5px] text-[#55615c]">
            {total} {total === 1 ? 'nuovo contenuto' : 'nuovi contenuti'} oggi
          </p>
        </div>
        <Badge tone="unread">+{total}</Badge>
        <ChevronRight size={18} className="text-kidville-green/40" />
      </Card>
    </Link>
  )
}
