'use client'

import { useState } from 'react'
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  DragOverlay,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import {
  Save, ChevronLeft, Loader2, Check, AlertCircle, GripVertical,
  Type, AlignLeft, ChevronDown, Paperclip, PenLine, Hash,
} from 'lucide-react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { FormBuilderCanvas } from '@/components/features/admin/forms/builder/FormBuilderCanvas'
import { PropertiesPanel } from '@/components/features/admin/forms/builder/PropertiesPanel'
import { getSupabase } from '@/lib/supabase/browser-client'
import type { FormSchemaConfig, FormField, FormFieldType, FormPage } from '@/types/database.types'

// ── Field palette definition ─────────────────────────────────
const PALETTE_ITEMS = [
  { type: 'text' as FormFieldType, label: 'Testo Corto', Icon: Type },
  { type: 'textarea' as FormFieldType, label: 'Testo Lungo', Icon: AlignLeft },
  { type: 'select' as FormFieldType, label: 'Menu a Tendina', Icon: ChevronDown },
  { type: 'number' as FormFieldType, label: 'Numero', Icon: Hash },
  { type: 'file' as FormFieldType, label: 'Allegato File', Icon: Paperclip },
  { type: 'signature' as FormFieldType, label: 'Firma', Icon: PenLine },
] as const

function makeField(type: FormFieldType, label: string): FormField {
  return {
    id: crypto.randomUUID(),
    type,
    label,
    required: false,
    points: 0,
    options: ['select', 'radio', 'checkbox'].includes(type)
      ? [{ label: 'Opzione 1', value: 'opt1' }]
      : undefined,
  }
}

// ── Palette item (draggable) ─────────────────────────────────
function PaletteItem({
  type,
  label,
  Icon,
}: {
  type: FormFieldType
  label: string
  Icon: React.ComponentType<{ className?: string }>
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${type}`,
  })

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-all select-none cursor-grab active:cursor-grabbing ${
        isDragging
          ? 'opacity-40 border-indigo-500/40 bg-indigo-500/10'
          : 'border-white/[0.07] bg-white/[0.03] hover:border-indigo-400/30 hover:bg-indigo-500/[0.07]'
      }`}
    >
      <Icon className="w-4 h-4 text-indigo-400 flex-shrink-0" />
      <span className="text-sm text-slate-300 flex-1">{label}</span>
      <GripVertical className="w-3.5 h-3.5 text-slate-700 flex-shrink-0" />
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────
export default function FormBuilderPage() {
  const [schema, setSchema] = useState<FormSchemaConfig>(() => ({
    version: '1.0',
    pages: [
      { id: crypto.randomUUID(), title: 'Pagina 1', description: '', fields: [] },
    ],
    scoring: { enabled: false },
    settings: {
      allow_save_draft: true,
      show_progress_bar: true,
      show_page_numbers: true,
    },
  }))
  const [activePage, setActivePage] = useState(0)
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null)
  const [formTitle, setFormTitle] = useState('Nuovo Modello')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [draggingPaletteId, setDraggingPaletteId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )

  const currentPage = schema.pages[activePage]
  const selectedField = currentPage?.fields.find(f => f.id === selectedFieldId) ?? null
  const draggingPaletteItem = draggingPaletteId
    ? PALETTE_ITEMS.find(p => `palette-${p.type}` === draggingPaletteId) ?? null
    : null

  function handleDragStart(evt: DragStartEvent) {
    const id = String(evt.active.id)
    if (id.startsWith('palette-')) setDraggingPaletteId(id)
  }

  function handleDragEnd(evt: DragEndEvent) {
    setDraggingPaletteId(null)
    const { active, over } = evt
    if (!over) return

    const aId = String(active.id)
    const oId = String(over.id)

    if (aId.startsWith('palette-')) {
      // Palette → Canvas: insert new field at end
      const fieldType = aId.replace('palette-', '') as FormFieldType
      const meta = PALETTE_ITEMS.find(p => p.type === fieldType)!
      const newField = makeField(fieldType, meta.label)
      setSchema(prev => {
        const pages = [...prev.pages]
        pages[activePage] = {
          ...pages[activePage],
          fields: [...pages[activePage].fields, newField],
        }
        return { ...prev, pages }
      })
      setSelectedFieldId(newField.id)
      return
    }

    // Reorder within canvas
    if (oId !== 'canvas-droppable' && !oId.startsWith('palette-') && aId !== oId) {
      setSchema(prev => {
        const pages = [...prev.pages]
        const fields = pages[activePage].fields
        const from = fields.findIndex(f => f.id === aId)
        const to = fields.findIndex(f => f.id === oId)
        if (from >= 0 && to >= 0) {
          pages[activePage] = { ...pages[activePage], fields: arrayMove(fields, from, to) }
        }
        return { ...prev, pages }
      })
    }
  }

  function addPage() {
    const page: FormPage = {
      id: crypto.randomUUID(),
      title: `Pagina ${schema.pages.length + 1}`,
      description: '',
      fields: [],
    }
    setSchema(prev => ({ ...prev, pages: [...prev.pages, page] }))
    setActivePage(schema.pages.length)
    setSelectedFieldId(null)
  }

  function deleteField(fieldId: string) {
    if (selectedFieldId === fieldId) setSelectedFieldId(null)
    setSchema(prev => {
      const pages = [...prev.pages]
      pages[activePage] = {
        ...pages[activePage],
        fields: pages[activePage].fields.filter(f => f.id !== fieldId),
      }
      return { ...prev, pages }
    })
  }

  function updateField(updated: FormField) {
    setSchema(prev => {
      const pages = [...prev.pages]
      pages[activePage] = {
        ...pages[activePage],
        fields: pages[activePage].fields.map(f => (f.id === updated.id ? updated : f)),
      }
      return { ...prev, pages }
    })
  }

  async function handleSave() {
    setSaveState('saving')
    try {
      const supabase = getSupabase()
      const { error } = await supabase.from('form_models').insert({
        title: formTitle,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        schema: schema as any,
        is_active: false,
        requires_signature: schema.pages
          .flatMap(p => p.fields)
          .some(f => f.type === 'signature'),
      })
      if (error) throw error
      setSaveState('saved')
    } catch (err) {
      console.error('Errore salvataggio form_models:', err)
      setSaveState('error')
    } finally {
      setTimeout(() => setSaveState('idle'), 3000)
    }
  }

  const totalFields = schema.pages.flatMap(p => p.fields).length

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {/* Full-screen dark canvas overriding the cream body */}
      <div
        className="flex flex-col overflow-hidden"
        style={{ height: '100vh', background: '#0b0f1f', color: '#f1f5f9' }}
      >
        {/* ── Header ── */}
        <header
          className="flex items-center justify-between px-6 py-3 flex-shrink-0"
          style={{
            background: 'rgba(11,15,31,0.92)',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            backdropFilter: 'blur(16px)',
            zIndex: 30,
          }}
        >
          <div className="flex items-center gap-3">
            <Link
              href="/admin/modulistica"
              className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-all"
            >
              <ChevronLeft className="w-5 h-5" />
            </Link>
            <div className="w-px h-5 bg-white/10" />
            <input
              value={formTitle}
              onChange={e => setFormTitle(e.target.value)}
              className="bg-transparent text-base font-semibold text-white focus:outline-none border-b border-transparent focus:border-indigo-400/50 transition-colors w-64 pb-0.5 placeholder-slate-700"
              placeholder="Nome del modello…"
            />
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-600 font-mono tabular-nums">
            <span>{schema.pages.length} {schema.pages.length === 1 ? 'pag.' : 'pag.'}</span>
            <span className="text-slate-800">·</span>
            <span>{totalFields} campi</span>
          </div>

          <motion.button
            onClick={handleSave}
            disabled={saveState === 'saving'}
            whileTap={{ scale: 0.95 }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all disabled:opacity-50 ${
              saveState === 'saved'
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : saveState === 'error'
                ? 'bg-red-600 text-white'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white'
            }`}
          >
            {saveState === 'saving' && <Loader2 className="w-4 h-4 animate-spin" />}
            {saveState === 'saved' && <Check className="w-4 h-4" />}
            {saveState === 'error' && <AlertCircle className="w-4 h-4" />}
            {saveState === 'idle' && <Save className="w-4 h-4" />}
            <span>
              {saveState === 'saving'
                ? 'Salvataggio…'
                : saveState === 'saved'
                ? 'Salvato!'
                : saveState === 'error'
                ? 'Errore'
                : 'Salva Modello'}
            </span>
          </motion.button>
        </header>

        {/* ── 3-column body ── */}
        <div className="flex flex-1 min-h-0">
          {/* Left: Field palette */}
          <aside
            className="w-56 flex-shrink-0 overflow-y-auto"
            style={{
              background: 'rgba(11,15,31,0.8)',
              borderRight: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <div className="p-4">
              <p className="text-[10px] font-bold text-slate-700 uppercase tracking-widest mb-3">
                Libreria Campi
              </p>
              <div className="space-y-1.5">
                {PALETTE_ITEMS.map(item => (
                  <PaletteItem
                    key={item.type}
                    type={item.type}
                    label={item.label}
                    Icon={item.Icon}
                  />
                ))}
              </div>
              <p className="mt-4 text-[10px] text-slate-800 leading-relaxed">
                Trascina i blocchi sul canvas per costruire il modulo passo dopo passo.
              </p>
            </div>
          </aside>

          {/* Center: Builder canvas */}
          <FormBuilderCanvas
            schema={schema}
            activePage={activePage}
            setActivePage={idx => {
              setActivePage(idx)
              setSelectedFieldId(null)
            }}
            selectedFieldId={selectedFieldId}
            setSelectedFieldId={id => setSelectedFieldId(id)}
            onAddPage={addPage}
            onDeleteField={deleteField}
          />

          {/* Right: Properties */}
          <PropertiesPanel field={selectedField} onChange={updateField} />
        </div>
      </div>

      {/* Drag overlay: ghost following the cursor */}
      <DragOverlay dropAnimation={null}>
        {draggingPaletteItem && (
          <div
            className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border pointer-events-none w-48"
            style={{
              background: 'rgba(99,102,241,0.85)',
              borderColor: 'rgba(129,140,248,0.5)',
              boxShadow: '0 20px 40px rgba(99,102,241,0.35)',
              backdropFilter: 'blur(8px)',
            }}
          >
            <draggingPaletteItem.Icon className="w-4 h-4 text-white flex-shrink-0" />
            <span className="text-sm font-medium text-white">{draggingPaletteItem.label}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
