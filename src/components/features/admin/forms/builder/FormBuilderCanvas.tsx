'use client'

import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { AnimatePresence, motion } from 'framer-motion'
import { Plus, MousePointerClick, Layers } from 'lucide-react'
import { DraggableField } from './DraggableField'
import type { FormSchemaConfig } from '@/types/database.types'

interface Props {
  schema: FormSchemaConfig
  activePage: number
  setActivePage: (idx: number) => void
  selectedFieldId: string | null
  setSelectedFieldId: (id: string | null) => void
  onAddPage: () => void
  onDeleteField: (id: string) => void
}

export function FormBuilderCanvas({
  schema,
  activePage,
  setActivePage,
  selectedFieldId,
  setSelectedFieldId,
  onAddPage,
  onDeleteField,
}: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: 'canvas-droppable' })

  const currentPage = schema.pages[activePage]
  const fieldIds = currentPage?.fields.map(f => f.id) ?? []

  return (
    <main className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
      {/* Page tabs */}
      <div
        className="flex items-center gap-1 px-4 pt-3 pb-0 flex-shrink-0 flex-wrap"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        {schema.pages.map((page, idx) => (
          <button
            key={page.id}
            onClick={() => setActivePage(idx)}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-t-lg transition-all relative ${
              idx === activePage
                ? 'text-white bg-white/5 border border-b-transparent border-white/10'
                : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.03]'
            }`}
          >
            <Layers className="w-3 h-3" />
            {page.title}
            {idx === activePage && (
              <span className="ml-1 text-[10px] text-indigo-400/80 font-mono">
                {currentPage.fields.length}
              </span>
            )}
          </button>
        ))}
        <button
          onClick={onAddPage}
          title="Aggiungi pagina"
          className="flex items-center gap-1 px-3 py-2 text-xs text-slate-600 hover:text-indigo-400 hover:bg-indigo-500/10 rounded-t-lg transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          Aggiungi pagina
        </button>
      </div>

      {/* Canvas scroll area */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {/* Page title */}
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
            <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">
              Step {activePage + 1} / {schema.pages.length}
            </span>
          </div>
          <h2 className="text-lg font-semibold text-white">{currentPage?.title}</h2>
          {currentPage?.description && (
            <p className="text-sm text-slate-500 mt-0.5">{currentPage.description}</p>
          )}
        </div>

        {/* Drop zone */}
        <div
          ref={setNodeRef}
          className={`min-h-64 rounded-2xl border-2 border-dashed transition-all p-3 space-y-2 ${
            isOver
              ? 'border-indigo-400/60 bg-indigo-500/5'
              : fieldIds.length === 0
              ? 'border-white/10 bg-white/[0.015]'
              : 'border-transparent'
          }`}
        >
          {fieldIds.length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="h-48 flex flex-col items-center justify-center gap-3 text-center select-none"
            >
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center"
                style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.15)' }}
              >
                <MousePointerClick className="w-5 h-5 text-indigo-500/60" />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-600">Canvas vuoto</p>
                <p className="text-xs text-slate-700 mt-1">
                  Trascina i campi dalla libreria a sinistra per iniziare.
                </p>
              </div>
            </motion.div>
          ) : (
            <SortableContext items={fieldIds} strategy={verticalListSortingStrategy}>
              <AnimatePresence initial={false}>
                {currentPage.fields.map(field => (
                  <DraggableField
                    key={field.id}
                    field={field}
                    isSelected={selectedFieldId === field.id}
                    onClick={() => setSelectedFieldId(selectedFieldId === field.id ? null : field.id)}
                    onDelete={() => onDeleteField(field.id)}
                  />
                ))}
              </AnimatePresence>
            </SortableContext>
          )}

          {/* Drop indicator when dragging over non-empty canvas */}
          {isOver && fieldIds.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed border-indigo-400/40 bg-indigo-500/5"
            >
              <div className="w-1 h-6 rounded-full bg-indigo-400" />
              <span className="text-xs text-indigo-400/70">Rilascia qui per aggiungere</span>
            </motion.div>
          )}
        </div>

        {/* Field count summary */}
        {fieldIds.length > 0 && (
          <p className="mt-3 text-[10px] text-slate-700 text-center">
            {fieldIds.length} {fieldIds.length === 1 ? 'campo' : 'campi'} in questa pagina · Trascina per riordinare
          </p>
        )}
      </div>
    </main>
  )
}
