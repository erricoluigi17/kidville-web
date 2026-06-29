'use client'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { motion } from 'framer-motion'
import {
  GripVertical, Trash2, Type, AlignLeft, ChevronDown,
  Paperclip, PenLine, Hash, CheckSquare, Calendar, Mail, Phone,
  Heading, AlignCenter, FileSignature, ShieldCheck,
} from 'lucide-react'
import type { FormField, FormFieldType } from '@/types/database.types'

const FIELD_ICONS: Record<FormFieldType, React.ComponentType<{ className?: string }>> = {
  text: Type,
  textarea: AlignLeft,
  number: Hash,
  email: Mail,
  phone: Phone,
  date: Calendar,
  select: ChevronDown,
  radio: CheckSquare,
  checkbox: CheckSquare,
  file: Paperclip,
  consent: ShieldCheck,
  signature: PenLine,
  section_header: Heading,
  paragraph: AlignCenter,
}

const FIELD_LABELS: Record<FormFieldType, string> = {
  text: 'Testo Corto',
  textarea: 'Testo Lungo',
  number: 'Numero',
  email: 'Email',
  phone: 'Telefono',
  date: 'Data',
  select: 'Menu a Tendina',
  radio: 'Scelta Singola',
  checkbox: 'Scelta Multipla',
  file: 'Allegato File',
  consent: 'Consensi/Privacy',
  signature: 'Firma',
  section_header: 'Intestazione',
  paragraph: 'Paragrafo',
}

interface Props {
  field: FormField
  isSelected: boolean
  onClick: () => void
  onDelete: () => void
}

export function DraggableField({ field, isSelected, onClick, onDelete }: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
  }

  const Icon = FIELD_ICONS[field.type] ?? Type

  return (
    <div ref={setNodeRef} style={style}>
      <motion.div
        layout
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: isDragging ? 0.3 : 1, y: 0 }}
        exit={{ opacity: 0, y: -8, scale: 0.97 }}
        transition={{ duration: 0.15 }}
        onClick={onClick}
        className={`group flex items-center gap-3 px-3 py-3 rounded-xl border cursor-pointer transition-all ${
          isSelected
            ? 'border-kidville-green/60 bg-kidville-success-soft shadow-lg shadow-kidville-green/10'
            : 'border-kidville-line bg-white hover:border-white/20 hover:bg-white/[0.06]'
        }`}
      >
        {/* Drag handle */}
        <div
          {...attributes}
          {...listeners}
          className="flex-shrink-0 cursor-grab active:cursor-grabbing text-kidville-muted hover:text-kidville-muted transition-colors touch-none"
          onClick={e => e.stopPropagation()}
        >
          <GripVertical className="w-4 h-4" />
        </div>

        {/* Field icon */}
        <div
          className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${
            isSelected ? 'bg-kidville-green/20' : 'bg-kidville-cream'
          }`}
        >
          <Icon className={`w-3.5 h-3.5 ${isSelected ? 'text-kidville-green' : 'text-kidville-muted'}`} />
        </div>

        {/* Field info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-kidville-ink truncate">{field.label}</p>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-[10px] text-kidville-muted uppercase tracking-wide">
              {FIELD_LABELS[field.type] ?? field.type}
            </span>
            {field.required && (
              <span className="text-[10px] text-kidville-error/80">● Obbligatorio</span>
            )}
            {(field.points ?? 0) > 0 && (
              <span className="text-[10px] text-kidville-warn/80">+{field.points}pt</span>
            )}
            {field.db_mapping && (
              <span className="text-[10px] text-kidville-success/70 font-mono">⇢ {field.db_mapping}</span>
            )}
          </div>
        </div>

        {/* Delete */}
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          className="flex-shrink-0 opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-kidville-muted hover:text-kidville-error hover:bg-kidville-error/10 transition-all"
          title="Elimina campo"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>

        {/* Selected indicator */}
        {isSelected && (
          <div className="flex-shrink-0 w-1 h-6 rounded-full bg-kidville-green self-center" />
        )}
      </motion.div>
    </div>
  )
}
