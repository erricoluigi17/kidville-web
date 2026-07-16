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
import { validateField, isProvinceField } from '@/lib/forms/validate-fields'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import { logClient } from '@/lib/logging/client'

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
  // Regola unica di validazione: la STESSA `validateField` che rigira il server
  // (obbligatorietà + pattern/lunghezze/provincia/email/date/select). RHF mostra
  // sotto il campo il messaggio (in italiano) che ritorna. I blocchi `consent`
  // mantengono la loro regola dedicata (messaggio migliore).
  const rules = {
    validate: (value: unknown) => validateField(field, value) ?? true,
  }
  const errMsg = (error as { message?: string } | undefined)?.message
  const errorId = `${field.id}-error`
  // Accessibilità: input in errore marcato `aria-invalid` e collegato al testo
  // del messaggio via `aria-describedby` (il messaggio è testo visibile, non
  // solo colore).
  const ariaProps: React.AriaAttributes = errMsg
    ? { 'aria-invalid': true, 'aria-describedby': errorId }
    : {}
  // Tipi a controllo SINGOLO: la <label> esterna li etichetta direttamente
  // (htmlFor ↔ id). radio/checkbox/file hanno un gruppo di controlli o una label
  // propria annidata → la label esterna resta una didascalia senza htmlFor (per
  // non puntare a un id inesistente); il gruppo usa già `aria-describedby`.
  const CONTROLLO_SINGOLO = ['text', 'number', 'email', 'phone', 'date', 'textarea', 'select']
  const associaLabel = CONTROLLO_SINGOLO.includes(field.type)

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
                {...ariaProps}
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
              <p id={errorId} role="alert" className="flex items-center gap-1.5 text-xs text-kidville-error-strong">
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
      <label
        htmlFor={associaLabel ? field.id : undefined}
        className="flex items-center gap-1.5 text-sm font-medium text-kidville-green/80"
      >
        {field.label}
        {field.required && <span className="text-kidville-green">*</span>}
      </label>

      {/* Testo / numero / email / telefono */}
      {['text', 'number', 'email', 'phone'].includes(field.type) && (
        isProvinceField(field) ? (
          // Campo PROVINCIA: digitazione libera (i nomi per esteso devono essere
          // scrivibili) con auto-MAIUSCOLO; su blur `normalizzaProvincia` riduce
          // il nome riconosciuto alla sigla ("Napoli" → "NA", "na" → "NA"). Un
          // valore irriconoscibile NON viene indovinato: resta e la validazione lo
          // blocca con messaggio chiaro. Il valore che parte è sempre sigla o bloccato.
          <Controller
            name={field.id}
            control={control}
            defaultValue=""
            rules={rules}
            render={({ field: rhf }) => (
              <input
                id={field.id}
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                placeholder={field.placeholder}
                className={FIELD_BASE}
                name={rhf.name}
                ref={rhf.ref}
                value={typeof rhf.value === 'string' ? rhf.value : ''}
                onChange={e => rhf.onChange(e.target.value.toUpperCase())}
                onBlur={() => {
                  const sigla = normalizzaProvincia(rhf.value)
                  if (sigla && sigla !== rhf.value) rhf.onChange(sigla)
                  rhf.onBlur()
                }}
                {...ariaProps}
              />
            )}
          />
        ) : (
          <input
            id={field.id}
            type={field.type === 'phone' ? 'tel' : field.type === 'number' ? 'number' : field.type === 'email' ? 'email' : 'text'}
            placeholder={field.placeholder}
            className={FIELD_BASE}
            {...ariaProps}
            {...register(field.id, rules)}
          />
        )
      )}

      {field.type === 'date' && (
        <input id={field.id} type="date" className={`${FIELD_BASE} [color-scheme:light]`} {...ariaProps} {...register(field.id, rules)} />
      )}

      {field.type === 'textarea' && (
        <textarea
          id={field.id}
          rows={4}
          placeholder={field.placeholder}
          className={`${FIELD_BASE} resize-none`}
          {...ariaProps}
          {...register(field.id, rules)}
        />
      )}

      {field.type === 'select' && (
        <select id={field.id} className={`${FIELD_BASE} [color-scheme:light]`} defaultValue="" {...ariaProps} {...register(field.id, rules)}>
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
        <div className="space-y-2" role="radiogroup" aria-describedby={errMsg ? errorId : undefined}>
          {(field.options ?? []).map((opt, i) => (
            <label
              key={i}
              className="flex items-center gap-3 px-4 py-3 rounded-xl bg-kidville-cream border border-kidville-green/15 cursor-pointer hover:border-kidville-green/30 transition-all"
            >
              <input type="radio" value={opt.value} className="accent-kidville-green" {...ariaProps} {...register(field.id, rules)} />
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
              <div className="space-y-2" role="group" aria-describedby={errMsg ? errorId : undefined}>
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
                        {...ariaProps}
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
        <p id={errorId} role="alert" className="flex items-center gap-1.5 text-xs text-kidville-error-strong">
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
      // Un catch che non logga è un bug: l'upload fallito è invisibile a chi
      // non ha in mano il dispositivo. `logClient` redige il path e non lancia.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `upload allegato modulo fallito — ${err instanceof Error ? err.message : 'errore sconosciuto'}`,
        stack: err instanceof Error ? err.stack : undefined,
      })
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
