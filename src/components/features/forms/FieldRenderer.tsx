'use client'

import { useState } from 'react'
import type {
  UseFormRegister,
  FieldErrors,
  Control,
  FieldValues,
} from 'react-hook-form'
import { Controller } from 'react-hook-form'
import {
  Upload, FileCheck2, Loader2, AlertCircle, PenLine, Info,
} from 'lucide-react'
import { getSupabase } from '@/lib/supabase/browser-client'
import type { FormField } from '@/types/database.types'

export const FIELD_BASE =
  'w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-slate-500 ' +
  'backdrop-blur-md focus:outline-none focus:border-emerald-500/50 focus:bg-white/[0.07] transition-all'

export function FieldRenderer({
  field,
  modelId,
  register,
  control,
  error,
  uploadEndpoint,
}: {
  field: FormField
  modelId: string
  register: UseFormRegister<FieldValues>
  control: Control<FieldValues>
  error: unknown
  /** Se valorizzato, gli upload passano da questo endpoint server (multipart) invece del client browser. */
  uploadEndpoint?: string
}) {
  const rules = field.required ? { required: 'Campo obbligatorio' } : undefined
  const errMsg = (error as { message?: string } | undefined)?.message

  // Blocchi non-input
  if (field.type === 'section_header') {
    return (
      <h3 className="text-lg font-semibold text-white pt-2 border-b border-white/10 pb-2">
        {field.label}
      </h3>
    )
  }
  if (field.type === 'paragraph') {
    return <p className="text-sm text-slate-400 leading-relaxed">{field.label}</p>
  }
  if (field.type === 'signature') {
    return (
      <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-emerald-500/[0.07] border border-emerald-500/20">
        <PenLine className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-emerald-200/80">
          {field.label || 'Questo modulo richiede la firma elettronica via OTP al termine.'}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-1.5 text-sm font-medium text-slate-300">
        {field.label}
        {field.required && <span className="text-emerald-400">*</span>}
      </label>

      {/* Testo / numero / email / telefono */}
      {['text', 'number', 'email', 'phone'].includes(field.type) && (
        <input
          type={field.type === 'phone' ? 'tel' : field.type === 'number' ? 'number' : field.type === 'email' ? 'email' : 'text'}
          placeholder={field.placeholder}
          className={FIELD_BASE}
          {...register(field.id, rules)}
        />
      )}

      {field.type === 'date' && (
        <input type="date" className={`${FIELD_BASE} [color-scheme:dark]`} {...register(field.id, rules)} />
      )}

      {field.type === 'textarea' && (
        <textarea
          rows={4}
          placeholder={field.placeholder}
          className={`${FIELD_BASE} resize-none`}
          {...register(field.id, rules)}
        />
      )}

      {field.type === 'select' && (
        <select className={`${FIELD_BASE} [color-scheme:dark]`} defaultValue="" {...register(field.id, rules)}>
          <option value="" disabled className="bg-slate-900">
            Seleziona…
          </option>
          {(field.options ?? []).map((opt, i) => (
            <option key={i} value={opt.value} className="bg-slate-900">
              {opt.label}
            </option>
          ))}
        </select>
      )}

      {field.type === 'radio' && (
        <div className="space-y-2">
          {(field.options ?? []).map((opt, i) => (
            <label
              key={i}
              className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10 cursor-pointer hover:border-emerald-500/30 transition-all"
            >
              <input type="radio" value={opt.value} className="accent-emerald-500" {...register(field.id, rules)} />
              <span className="text-sm text-slate-200">{opt.label}</span>
            </label>
          ))}
        </div>
      )}

      {field.type === 'checkbox' && (
        <Controller
          name={field.id}
          control={control}
          rules={rules}
          defaultValue={[]}
          render={({ field: rhf }) => {
            const value: string[] = Array.isArray(rhf.value) ? rhf.value : []
            return (
              <div className="space-y-2">
                {(field.options ?? []).map((opt, i) => {
                  const checked = value.includes(opt.value)
                  return (
                    <label
                      key={i}
                      className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10 cursor-pointer hover:border-emerald-500/30 transition-all"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        className="accent-emerald-500"
                        onChange={e =>
                          rhf.onChange(
                            e.target.checked
                              ? [...value, opt.value]
                              : value.filter(v => v !== opt.value)
                          )
                        }
                      />
                      <span className="text-sm text-slate-200">{opt.label}</span>
                    </label>
                  )
                })}
              </div>
            )
          }}
        />
      )}

      {field.type === 'file' && (
        <Controller
          name={field.id}
          control={control}
          rules={rules}
          defaultValue=""
          render={({ field: rhf }) => (
            <FileField modelId={modelId} value={rhf.value} onChange={rhf.onChange} uploadEndpoint={uploadEndpoint} />
          )}
        />
      )}

      {errMsg && (
        <p className="flex items-center gap-1.5 text-xs text-rose-400">
          <AlertCircle className="w-3.5 h-3.5" />
          {errMsg}
        </p>
      )}
    </div>
  )
}

// ── Upload allegato (bucket form_attachments) ────────────────
export function FileField({
  modelId,
  value,
  onChange,
  uploadEndpoint,
}: {
  modelId: string
  value: string
  onChange: (path: string) => void
  uploadEndpoint?: string
}) {
  const [uploading, setUploading] = useState(false)
  const [fileName, setFileName] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError(null)
    setFileName(file.name)

    try {
      let path: string
      if (uploadEndpoint) {
        // Upload via endpoint server (service-role) — adatto al form pubblico senza login
        const fd = new FormData()
        fd.append('file', file)
        fd.append('folder', modelId)
        const res = await fetch(uploadEndpoint, { method: 'POST', body: fd })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Upload fallito')
        path = json.path
      } else {
        // Upload diretto via client browser (utente autenticato)
        const supabase = getSupabase()
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        path = `${modelId}/${crypto.randomUUID()}-${safeName}`
        const { error } = await supabase.storage
          .from('form_attachments')
          .upload(path, file, { cacheControl: '3600', upsert: false })
        if (error) throw error
      }
      onChange(path)
    } catch (err) {
      console.error('Upload fallito:', err)
      setUploadError('Caricamento non riuscito. Riprova.')
      onChange('')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      <label
        className={`flex items-center gap-3 px-4 py-3 rounded-xl border border-dashed cursor-pointer transition-all ${
          value
            ? 'border-emerald-500/40 bg-emerald-500/[0.07]'
            : 'border-white/15 bg-white/5 hover:border-emerald-500/30'
        }`}
      >
        {uploading ? (
          <Loader2 className="w-4 h-4 text-emerald-400 animate-spin flex-shrink-0" />
        ) : value ? (
          <FileCheck2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
        ) : (
          <Upload className="w-4 h-4 text-slate-400 flex-shrink-0" />
        )}
        <span className="text-sm text-slate-300 truncate">
          {uploading
            ? 'Caricamento…'
            : value
            ? fileName || 'Allegato caricato'
            : 'Seleziona un file (PDF, JPG…)'}
        </span>
        <input
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          className="hidden"
          disabled={uploading}
          onChange={handleFile}
        />
      </label>
      {uploadError && (
        <p className="flex items-center gap-1.5 text-xs text-rose-400 mt-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          {uploadError}
        </p>
      )}
      {value && !uploading && (
        <p className="flex items-center gap-1.5 text-[11px] text-slate-500 mt-1.5">
          <Info className="w-3 h-3" />
          <span className="font-mono truncate">{value}</span>
        </p>
      )}
    </div>
  )
}
