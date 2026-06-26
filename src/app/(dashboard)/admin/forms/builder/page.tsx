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
  Database, Baby, Heart, User, UserCheck, ShieldCheck,
  Globe, Lock, Copy, Link2, EyeOff,
} from 'lucide-react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { FormBuilderCanvas } from '@/components/features/admin/forms/builder/FormBuilderCanvas'
import { PropertiesPanel } from '@/components/features/admin/forms/builder/PropertiesPanel'
import type { FormSchemaConfig, FormField, FormFieldType, FormPage } from '@/types/database.types'
import { ANAGRAFICA_GROUPS, type AnagraficaPresetField, type AnagraficaGroup } from '@/lib/forms/anagrafica-fields'

// ── Field palette definition ─────────────────────────────────
const PALETTE_ITEMS = [
  { type: 'text' as FormFieldType, label: 'Testo Corto', Icon: Type },
  { type: 'textarea' as FormFieldType, label: 'Testo Lungo', Icon: AlignLeft },
  { type: 'select' as FormFieldType, label: 'Menu a Tendina', Icon: ChevronDown },
  { type: 'number' as FormFieldType, label: 'Numero', Icon: Hash },
  { type: 'file' as FormFieldType, label: 'Allegato File', Icon: Paperclip },
  { type: 'consent' as FormFieldType, label: 'Consensi/Privacy', Icon: ShieldCheck },
  { type: 'signature' as FormFieldType, label: 'Firma', Icon: PenLine },
] as const

function makeField(type: FormFieldType, label: string): FormField {
  const base: FormField = {
    id: crypto.randomUUID(),
    type,
    label,
    required: false,
    points: 0,
    options: ['select', 'radio', 'checkbox'].includes(type)
      ? [{ label: 'Opzione 1', value: 'opt1' }]
      : undefined,
  }
  // Il blocco Consensi nasce obbligatorio con un testo di default editabile.
  if (type === 'consent') {
    return {
      ...base,
      label: 'Consenso al trattamento dei dati',
      required: true,
      text: 'Dichiaro di aver letto l’informativa e acconsento al trattamento dei dati.',
    }
  }
  return base
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

// ── Accent color maps per gruppo anagrafica ──────────────────
const ACCENT_ICON: Record<AnagraficaGroup['groupId'], React.ComponentType<{ className?: string }>> = {
  bambino: Baby,
  madre: Heart,
  padre: User,
  delegato: UserCheck,
}

const ACCENT_COLORS: Record<AnagraficaGroup['accent'], { border: string; bg: string; text: string; dot: string }> = {
  sky:    { border: 'rgba(56,189,248,0.25)', bg: 'rgba(56,189,248,0.06)', text: 'text-sky-400', dot: 'bg-sky-400' },
  rose:   { border: 'rgba(251,113,133,0.25)', bg: 'rgba(251,113,133,0.06)', text: 'text-rose-400', dot: 'bg-rose-400' },
  indigo: { border: 'rgba(129,140,248,0.25)', bg: 'rgba(129,140,248,0.06)', text: 'text-indigo-400', dot: 'bg-indigo-400' },
  amber:  { border: 'rgba(251,191,36,0.25)', bg: 'rgba(251,191,36,0.06)', text: 'text-amber-400', dot: 'bg-amber-400' },
}

// ── Palette item anagrafica (draggable) ──────────────────────
function AnagraficaPaletteItem({
  preset,
  accent,
}: {
  preset: AnagraficaPresetField
  accent: AnagraficaGroup['accent']
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `preset-${preset.presetId}`,
  })
  const field = preset.toFormField()
  const colors = ACCENT_COLORS[accent]

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border transition-all select-none cursor-grab active:cursor-grabbing ${
        isDragging ? 'opacity-40' : 'hover:brightness-125'
      }`}
      style={{
        borderColor: isDragging ? colors.border : 'rgba(255,255,255,0.05)',
        background: isDragging ? colors.bg : 'rgba(255,255,255,0.02)',
      }}
      onMouseEnter={e => {
        if (!isDragging) {
          ;(e.currentTarget as HTMLElement).style.borderColor = colors.border
          ;(e.currentTarget as HTMLElement).style.background = colors.bg
        }
      }}
      onMouseLeave={e => {
        if (!isDragging) {
          ;(e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.05)'
          ;(e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'
        }
      }}
    >
      <Database className={`w-3 h-3 ${colors.text} flex-shrink-0`} />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-slate-300 truncate leading-tight">{field.label}</p>
        <p className={`text-[9px] font-mono ${colors.text} opacity-60 truncate leading-tight`}>
          {field.db_mapping}
        </p>
      </div>
      <GripVertical className="w-3 h-3 text-slate-700 flex-shrink-0" />
    </div>
  )
}

// ── Gruppo anagrafica collassabile ───────────────────────────
function AnagraficaGroupSection({
  group,
  collapsed,
  onToggle,
}: {
  group: AnagraficaGroup
  collapsed: boolean
  onToggle: () => void
}) {
  const colors = ACCENT_COLORS[group.accent]
  const GroupIcon = ACCENT_ICON[group.groupId]

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-1 py-1.5 rounded-lg hover:bg-white/5 transition-all text-left"
      >
        <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0`}
          style={{ background: colors.bg }}>
          <GroupIcon className={`w-2.5 h-2.5 ${colors.text}`} />
        </div>
        <span className={`text-[11px] font-semibold ${colors.text} flex-1`}>{group.label}</span>
        <ChevronDown
          className={`w-3 h-3 text-slate-600 transition-transform ${collapsed ? '' : 'rotate-180'}`}
        />
      </button>
      {!collapsed && (
        <div className="mt-1 space-y-0.5 pl-1">
          {group.fields.map(preset => (
            <AnagraficaPaletteItem key={preset.presetId} preset={preset} accent={group.accent} />
          ))}
        </div>
      )}
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
  // Pubblicazione (DL-030): id del modello salvato + stato link pubblico.
  const [savedModelId, setSavedModelId] = useState<string | null>(null)
  const [accessMode, setAccessMode] = useState<'public' | 'authenticated'>('public')
  const [pub, setPub] = useState<{ token: string; url: string; access_mode: string } | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [copied, setCopied] = useState(false)
  // Modalità firma (DL-031): joint = firma congiunta dei due genitori.
  const [signatureMode, setSignatureMode] = useState<'single' | 'joint'>('single')
  const [draggingPaletteId, setDraggingPaletteId] = useState<string | null>(null)
  const [draggingPresetId, setDraggingPresetId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(['madre', 'padre', 'delegato'])
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )

  const currentPage = schema.pages[activePage]
  const selectedField = currentPage?.fields.find(f => f.id === selectedFieldId) ?? null
  const hasSignature = schema.pages.flatMap(p => p.fields).some(f => f.type === 'signature')
  // Campi referenziabili in una condizione: tutti tranne se stesso e i decorativi.
  const campiDisponibili = schema.pages
    .flatMap(p => p.fields)
    .filter(f => f.id !== selectedFieldId && !['section_header', 'paragraph', 'signature'].includes(f.type))
    .map(f => ({ id: f.id, label: f.label }))
  const draggingPaletteItem = draggingPaletteId
    ? PALETTE_ITEMS.find(p => `palette-${p.type}` === draggingPaletteId) ?? null
    : null

  const draggingPreset = draggingPresetId
    ? (() => {
        const id = draggingPresetId.replace('preset-', '')
        for (const group of ANAGRAFICA_GROUPS) {
          const found = group.fields.find(f => f.presetId === id)
          if (found) return { preset: found, group }
        }
        return null
      })()
    : null

  function handleDragStart(evt: DragStartEvent) {
    const id = String(evt.active.id)
    if (id.startsWith('palette-')) setDraggingPaletteId(id)
    else if (id.startsWith('preset-')) setDraggingPresetId(id)
  }

  function handleDragEnd(evt: DragEndEvent) {
    setDraggingPaletteId(null)
    setDraggingPresetId(null)
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

    if (aId.startsWith('preset-')) {
      // Anagrafica preset → Canvas: insert pre-configured field
      const presetId = aId.replace('preset-', '')
      let found: AnagraficaPresetField | undefined
      for (const group of ANAGRAFICA_GROUPS) {
        found = group.fields.find(f => f.presetId === presetId)
        if (found) break
      }
      if (!found) return
      const newField = found.toFormField()
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
    if (oId !== 'canvas-droppable' && !oId.startsWith('palette-') && !oId.startsWith('preset-') && aId !== oId) {
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

  // Identità staff (modello app-level): da ?userId= o admin dev di default.
  function getUserId(): string {
    if (typeof window !== 'undefined') {
      const u = new URLSearchParams(window.location.search).get('userId')
      if (u) return u
    }
    return '22222222-2222-2222-2222-555555555555'
  }

  async function handleSave() {
    setSaveState('saving')
    try {
      const res = await fetch('/api/admin/form-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': getUserId() },
        body: JSON.stringify({
          title: formTitle,
          schema,
          is_active: false,
          requires_signature: hasSignature,
          signature_mode: hasSignature ? signatureMode : 'single',
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Salvataggio fallito')
      setSavedModelId(json.id ?? null)
      setSaveState('saved')
    } catch (err) {
      console.error('Errore salvataggio form_models:', err)
      setSaveState('error')
    } finally {
      setTimeout(() => setSaveState('idle'), 3000)
    }
  }

  // Pubblica / ritira il modello salvato (DL-030).
  async function handlePublish(action: 'publish' | 'unpublish') {
    if (!savedModelId) return
    setPublishing(true)
    try {
      const res = await fetch('/api/admin/form-models/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': getUserId() },
        body: JSON.stringify({ id: savedModelId, action, access_mode: accessMode }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Errore pubblicazione')
      setPub(action === 'publish' ? { token: json.public_token, url: json.url, access_mode: json.access_mode } : null)
    } catch (err) {
      console.error('Errore pubblicazione:', err)
    } finally {
      setPublishing(false)
    }
  }

  async function copyLink() {
    if (!pub || typeof window === 'undefined') return
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${pub.url}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard non disponibile */
    }
  }

  const totalFields = schema.pages.flatMap(p => p.fields).length

  return (
    <DndContext
      id="form-builder-dnd"
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

          <div className="flex items-center gap-3">
            {hasSignature && (
              <button
                onClick={() => setSignatureMode(m => (m === 'joint' ? 'single' : 'joint'))}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${signatureMode === 'joint' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-white/10 text-slate-400 hover:text-slate-200'}`}
                title="Richiede la firma di entrambi i genitori"
              >
                <PenLine className="w-3.5 h-3.5" />
                {signatureMode === 'joint' ? 'Firma congiunta' : 'Firma singola'}
              </button>
            )}
            <div className="flex items-center gap-2 text-xs text-slate-600 font-mono tabular-nums">
              <span>{schema.pages.length} {schema.pages.length === 1 ? 'pag.' : 'pag.'}</span>
              <span className="text-slate-800">·</span>
              <span>{totalFields} campi</span>
            </div>
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

        {/* ── Barra Pubblicazione (DL-030) ── */}
        {savedModelId && (
          <div
            className="flex items-center gap-3 px-6 py-2.5 flex-shrink-0 flex-wrap"
            style={{ background: 'rgba(16,185,129,0.06)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
          >
            <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 uppercase tracking-wider">
              <Globe className="w-3.5 h-3.5" /> Pubblicazione
            </span>

            <div className="flex items-center gap-1.5 text-xs">
              <button
                onClick={() => setAccessMode('public')}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border transition-all ${accessMode === 'public' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-white/10 text-slate-400'}`}
              >
                <Globe className="w-3 h-3" /> Link pubblico
              </button>
              <button
                onClick={() => setAccessMode('authenticated')}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border transition-all ${accessMode === 'authenticated' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-white/10 text-slate-400'}`}
              >
                <Lock className="w-3 h-3" /> Solo registrati
              </button>
            </div>

            {!pub ? (
              <button
                onClick={() => handlePublish('publish')}
                disabled={publishing}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-all disabled:opacity-50"
              >
                {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                Pubblica
              </button>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <code className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-lg">
                  {pub.url}
                </code>
                <button
                  onClick={copyLink}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5 text-xs transition-all"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copiato' : 'Copia link'}
                </button>
                <button
                  onClick={() => handlePublish('unpublish')}
                  disabled={publishing}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-white/10 text-slate-400 hover:text-rose-300 hover:border-rose-400/30 text-xs transition-all disabled:opacity-50"
                >
                  <EyeOff className="w-3.5 h-3.5" /> Ritira
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── 3-column body ── */}
        <div className="flex flex-1 min-h-0">
          {/* Left: Field palette */}
          <aside
            className="w-60 flex-shrink-0 overflow-y-auto"
            style={{
              background: 'rgba(11,15,31,0.8)',
              borderRight: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <div className="p-4 space-y-4">
              {/* Campi generici */}
              <div>
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
              </div>

              {/* Divisore */}
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }} />

              {/* Campi anagrafica */}
              <div>
                <p className="text-[10px] font-bold text-slate-700 uppercase tracking-widest mb-3">
                  Campi Anagrafica
                </p>
                <div className="space-y-1">
                  {ANAGRAFICA_GROUPS.map(group => (
                    <AnagraficaGroupSection
                      key={group.groupId}
                      group={group}
                      collapsed={collapsedGroups.has(group.groupId)}
                      onToggle={() =>
                        setCollapsedGroups(prev => {
                          const next = new Set(prev)
                          next.has(group.groupId) ? next.delete(group.groupId) : next.add(group.groupId)
                          return next
                        })
                      }
                    />
                  ))}
                </div>
                <p className="mt-3 text-[10px] text-slate-800 leading-relaxed">
                  I campi anagrafica si collegano automaticamente al database alla compilazione.
                </p>
              </div>
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
          <PropertiesPanel field={selectedField} onChange={updateField} campiDisponibili={campiDisponibili} />
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
        {draggingPreset && (() => {
          const field = draggingPreset.preset.toFormField()
          const colors = ACCENT_COLORS[draggingPreset.group.accent]
          return (
            <div
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border pointer-events-none w-52"
              style={{
                background: 'rgba(11,15,31,0.92)',
                borderColor: colors.border,
                boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(8px)',
              }}
            >
              <Database className={`w-4 h-4 ${colors.text} flex-shrink-0`} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{field.label}</p>
                <p className={`text-[10px] font-mono ${colors.text} opacity-70 truncate`}>
                  {field.db_mapping}
                </p>
              </div>
            </div>
          )
        })()}
      </DragOverlay>
    </DndContext>
  )
}
