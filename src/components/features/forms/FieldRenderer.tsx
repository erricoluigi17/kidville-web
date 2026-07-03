'use client'

import { useState } from 'react'
import type {
  UseFormRegister,
  Control,
  FieldValues,
} from 'react-hook-form'
import { Controller } from 'react-hook-form'
import {
  Upload, FileCheck2, Loader2, AlertCircle, PenLine, Info,
} from 'lucide-react'
import type { FormField } from '@/types/database.types'

export const FIELD_BASE =
  'w-full px-4 py-3 rounded-xl bg-white border border-kidville-green/15 text-kidville-green placeholder-kidville-green/40 ' +
  'focus:outline-none focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/20 transition-all'

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
      <h3 className="text-lg font-semibold text-kidville-green pt-2 border-b border-kidville-green/15 pb-2">
        {field.label}
      </h3>
    )
  }
  if (field.type === 'paragraph') {
    return <p className="text-sm text-gray-500 leading-relaxed">{field.label}</p>
  }
  if (field.type === 'signature') {
    return (
      <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-kidville-green-light border border-kidville-green/20">
        <PenLine className="w-4 h-4 text-kidville-green flex-shrink-0 mt-0.5" />
        <p className="text-sm text-kidville-green/80">
          {field.label || 'Questo modulo richiede la firma elettronica via OTP al termine.'}
        </p>
      </div>
    )
  }

  // Blocco Consensi/Privacy (DL-029): una singola checkbox da accettare; se
  // obbligatorio il wizard blocca finché non è spuntata. L'accettazione viene
  // archiviata con snapshot del testo + timestamp lato server (consents_log).
  if (field.type === 'consent') {
    return (
      <Controller
        name={field.id}
        control={control}
        defaultValue={false}
        rules={field.required ? { validate: (v) => v === true || 'Devi accettare per proseguire' } : undefined}
        render={({ field: rhf }) => (
          <div className="space-y-1.5">
            <label className="flex items-start gap-3 px-4 py-3 rounded-xl bg-kidville-cream border border-kidville-green/15 cursor-pointer hover:border-kidville-green/30 transition-all">
              <input
                type="checkbox"
                checked={rhf.value === true}
                onChange={e => rhf.onChange(e.target.checked)}
                className="accent-kidville-green mt-0.5 flex-shrink-0"
              />
              <span className="text-sm text-kidville-green/90">
                <span className="font-medium">
                  {field.label}
                  {field.required && <span className="text-kidville-green"> *</span>}
                </span>
                {field.text && (
                  <span className="block text-kidville-green/70 mt-1 leading-relaxed">{field.text}</span>
                )}
                {field.link && (
                  <a
                    href={field.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="inline-block mt-1 text-xs text-kidville-green underline"
                  >
                    {field.link_label || 'Leggi l’informativa'}
                  </a>
                )}
              </span>
            </label>
            {errMsg && (
              <p className="flex items-center gap-1.5 text-xs text-kidville-error">
                <AlertCircle className="w-3.5 h-3.5" />
                {errMsg}
              </p>
            )}
          </div>
        )}
      />
    )
  }

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-1.5 text-sm font-medium text-kidville-green/80">
        {field.label}
        {field.required && <span className="text-kidville-green">*</span>}
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
        <input type="date" className={`${FIELD_BASE} [color-scheme:light]`} {...register(field.id, rules)} />
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
        <select className={`${FIELD_BASE} [color-scheme:light]`} defaultValue="" {...register(field.id, rules)}>
          <option value="" disabled className="bg-white text-kidville-green">
            Seleziona…
          </option>
          {(field.options ?? []).map((opt, i) => (
            <option key={i} value={opt.value} className="bg-white text-kidville-green">
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
              className="flex items-center gap-3 px-4 py-3 rounded-xl bg-kidville-cream border border-kidville-green/15 cursor-pointer hover:border-kidville-green/30 transition-all"
            >
              <input type="radio" value={opt.value} className="accent-kidville-green" {...register(field.id, rules)} />
              <span className="text-sm text-kidville-green">{opt.label}</span>
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
                      className="flex items-center gap-3 px-4 py-3 rounded-xl bg-kidville-cream border border-kidville-green/15 cursor-pointer hover:border-kidville-green/30 transition-all"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        className="accent-kidville-green"
                        onChange={e =>
                          rhf.onChange(
                            e.target.checked
                              ? [...value, opt.value]
                              : value.filter(v => v !== opt.value)
                          )
                        }
                      />
                      <span className="text-sm text-kidville-green">{opt.label}</span>
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
            <FileField
              modelId={modelId}
              value={rhf.value}
              onChange={rhf.onChange}
              uploadEndpoint={uploadEndpoint}
              accept={field.accept}
              maxSizeMb={field.max_size_mb}
            />
          )}
        />
      )}

      {errMsg && (
        <p className="flex items-center gap-1.5 text-xs text-kidville-error">
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
  accept,
  maxSizeMb,
}: {
  modelId: string
  value: string
  onChange: (path: string) => void
  uploadEndpoint?: string
  /** Estensioni/MIME ammessi (default PDF + immagini). */
  accept?: string
  /** Dimensione massima in MB comunicata al server per la validazione. */
  maxSizeMb?: number
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
      // Upload SEMPRE via endpoint server (service-role, bucket privato deny-by-default).
      // Pubblico: token-scoped; autenticato: `/api/forms/upload` (requireUser). Niente
      // più scrittura diretta dal client anon (P0/DL-035).
      const endpoint = uploadEndpoint || '/api/forms/upload'
      const fd = new FormData()
      fd.append('file', file)
      fd.append('folder', modelId)
      if (maxSizeMb) fd.append('max_size_mb', String(maxSizeMb))
      const res = await fetch(endpoint, { method: 'POST', body: fd })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Upload fallito')
      const path: string = json.path
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
            ? 'border-kidville-green/40 bg-kidville-green-light'
            : 'border-kidville-green/20 bg-kidville-cream hover:border-kidville-green/30'
        }`}
      >
        {uploading ? (
          <Loader2 className="w-4 h-4 text-kidville-green animate-spin flex-shrink-0" />
        ) : value ? (
          <FileCheck2 className="w-4 h-4 text-kidville-green flex-shrink-0" />
        ) : (
          <Upload className="w-4 h-4 text-gray-500 flex-shrink-0" />
        )}
        <span className="text-sm text-kidville-green/80 truncate">
          {uploading
            ? 'Caricamento…'
            : value
            ? fileName || 'Allegato caricato'
            : 'Seleziona un file (PDF, JPG…)'}
        </span>
        <input
          type="file"
          accept={accept || '.pdf,.jpg,.jpeg,.png'}
          className="hidden"
          disabled={uploading}
          onChange={handleFile}
        />
      </label>
      {uploadError && (
        <p className="flex items-center gap-1.5 text-xs text-kidville-error mt-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          {uploadError}
        </p>
      )}
      {value && !uploading && (
        <p className="flex items-center gap-1.5 text-[11px] text-gray-500 mt-1.5">
          <Info className="w-3 h-3" />
          <span className="font-mono truncate">{value}</span>
        </p>
      )}
    </div>
  )
}
