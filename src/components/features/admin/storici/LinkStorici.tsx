'use client'
import Link from 'next/link'
import { Printer } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { GruppoStorico } from '@/lib/storici/catalogo'
export function LinkStorici({ scuolaId, alunnoId, sectionId, gruppo, dal, al }: { scuolaId?: string; alunnoId?: string; sectionId?: string; gruppo?: GruppoStorico; dal?: string; al?: string }) {
  const t = useTranslations('storici')
  const q = new URLSearchParams()
  if (scuolaId) q.set('scuolaId', scuolaId)
  if (alunnoId) q.set('alunnoId', alunnoId)
  if (sectionId) q.set('sectionId', sectionId)
  if (gruppo) q.set('gruppo', gruppo)
  if (dal) q.set('dal', dal)
  if (al) q.set('al', al)
  return <Link href={`/admin/storici?${q}`} className="inline-flex min-h-11 items-center gap-2 rounded-pill border border-kidville-green px-4 py-2 font-maven text-sm font-semibold text-kidville-green hover:bg-kidville-green-soft"><Printer size={16} aria-hidden="true" />{t('titolo')}</Link>
}
