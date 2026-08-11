'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
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
import { logClient, nomeErrore } from '@/lib/logging/client'
import { limiteUploadByte, limiteUploadMb } from '@/lib/upload/limite-piattaforma'
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton'

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
  const t = useTranslations('parentForms')
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
  // WCAG 2.1 AA, SC 1.3.5 «Identify Input Purpose»: lo scopo del campo lo
  // dichiara il TEMPLATE (`given-name`, `email`, `tel`, …) e da qui arriva al
  // controllo. Nessun campo lo dichiarava fino al 2026-08-11, e il prezzo lo
  // pagava chi compila dal telefono un modulo pubblico: sei campi digitati a
  // mano invece di un tocco. Omesso = nessun attributo, cioè il comportamento
  // di prima per ogni modello che non lo dichiara.
  const autoCompleteProps = field.autocomplete ? { autoComplete: field.autocomplete } : {}

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
          {field.label || t('firmaRichiesta')}
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
        rules={field.required ? { validate: (v) => v === true || t('devAccettare') } : undefined}
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
                    {field.link_label || t('leggiInformativa')}
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
                // LO SCOPO SI DICHIARA — e il ripiego non dice il contrario.
                // `off` vale per un template che NON dichiara niente: senza uno
                // scopo dichiarato il suggerimento del browser è un valore
                // qualunque, e questo campo ha una regola sua (si scrive per
                // esteso e si riduce a sigla su blur). Quando il template dice
                // `address-level1` lo scopo È noto, e dichiararlo è ciò che
                // SC 1.3.5 chiede: le due frasi parlano di due casi diversi.
                //
                // ⚠️ E NON si aggiunge `maxlength`, per quanto il template
                // dichiari `max_length: 2`. MISURATO l'11/08/2026: «Campania»
                // troncata a due lettere fa «CA», cioè Cagliari — un dato
                // sbagliato accettato in silenzio; lasciata intera fa `null`,
                // cioè un errore visibile e correggibile. Un valore che
                // l'autofill può davvero scrivere qui viene dall'elenco delle
                // province italiane (in Chromium l'admin area per l'Italia è
                // quell'elenco: chiave = sigla, nome = provincia) e tutte e 107
                // sono riconosciute in entrambe le forme — collaudi (m) e (n) di
                // `__tests__/components/FieldRenderer-validation.test.tsx`.
                autoComplete={field.autocomplete ?? 'off'}
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
            {...autoCompleteProps}
            {...ariaProps}
            {...register(field.id, rules)}
          />
        )
      )}

      {field.type === 'date' && (
        <input id={field.id} type="date" className={`${FIELD_BASE} [color-scheme:light]`} {...autoCompleteProps} {...ariaProps} {...register(field.id, rules)} />
      )}

      {field.type === 'textarea' && (
        <textarea
          id={field.id}
          rows={4}
          placeholder={field.placeholder}
          className={`${FIELD_BASE} resize-none`}
          {...autoCompleteProps}
          {...ariaProps}
          {...register(field.id, rules)}
        />
      )}

      {field.type === 'select' && (
        <select id={field.id} className={`${FIELD_BASE} [color-scheme:light]`} defaultValue="" {...autoCompleteProps} {...ariaProps} {...register(field.id, rules)}>
          <option value="" disabled className="bg-white text-kidville-green">
            {t('seleziona')}
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

/**
 * Il messaggio d'errore del SERVER, o `null` se non ce n'è uno leggibile.
 *
 * Tre strette, e ognuna ha un motivo:
 *  · si legge solo se il `content-type` è JSON — il corpo di un 413 di piattaforma è
 *    testo, e riversarlo in pagina mostrerebbe al genitore «FUNCTION_PAYLOAD_TOO_LARGE»;
 *  · si legge SOLO il campo `error`, che è quello che scriviamo noi nelle route;
 *  · si tronca. Non lancia mai: è il ramo che gestisce un errore, non il posto dove
 *    aprirne un secondo.
 */
async function messaggioDelServer(res: Response): Promise<string | null> {
  try {
    if (!/application\/json/i.test(res.headers.get('content-type') ?? '')) return null
    const body: unknown = await res.json()
    const msg = (body as { error?: unknown } | null)?.error
    return typeof msg === 'string' && msg !== '' ? msg.slice(0, 200) : null
  } catch {
    return null
  }
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
  const t = useTranslations('parentForms')
  const [uploading, setUploading] = useState(false)
  const [fileName, setFileName] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)

  // Accept dinamico: mostra «Scatta foto» solo se il campo ammette immagini
  // (la fotocamera produce un JPG) — così non si aggiunge un trigger foto a un
  // input che accetta solo PDF/doc.
  const acceptEff = accept || '.pdf,.jpg,.jpeg,.png'
  const consenteImmagini = /image\/|\*|\.jpe?g|\.png|\.webp|\.gif|\.heic/i.test(acceptEff)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await processaFile(file)
  }

  async function processaFile(file: File) {
    setUploading(true)
    setUploadError(null)
    setFileName(file.name)

    try {
      // ── IL CONTROLLO DELLA TAGLIA STA QUI, PRIMA DI SPEDIRE. Non è una gentilezza
      // verso la rete mobile del genitore: sopra il tetto della piattaforma la
      // richiesta non arriva MAI alla nostra route (Vercel risponde 413
      // `FUNCTION_PAYLOAD_TOO_LARGE` con un corpo di testo), quindi nessun controllo
      // lato server potrebbe scattare e nessun messaggio nostro potrebbe uscire. Il
      // 31 luglio 2026 sono stati 41 tentativi in un giorno sul modulo pubblico.
      // Vedi `@/lib/upload/limite-piattaforma`.
      const limite = limiteUploadByte(maxSizeMb)
      if (file.size > limite) {
        // Il NOME del file non si logga mai: «certificato-mario-rossi.pdf» è un dato.
        // La dimensione sì: è un numero, ed è l'unica cosa che serve per sapere se il
        // tetto è tarato bene o se i genitori caricano foto da 12 MB.
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `modulo-allegato-troppo-pesante: ${file.size} byte, limite ${limite}`,
        })
        setUploadError(t('fileTroppoPesante', { mb: limiteUploadMb(maxSizeMb) }))
        onChange('')
        return
      }

      // Upload SEMPRE via endpoint server (service-role, bucket privato deny-by-default).
      // Pubblico: token-scoped; autenticato: `/api/forms/upload` (requireUser). Niente
      // più scrittura diretta dal client anon (P0/DL-035).
      const endpoint = uploadEndpoint || '/api/forms/upload'
      const fd = new FormData()
      fd.append('file', file)
      fd.append('folder', modelId)
      if (maxSizeMb) fd.append('max_size_mb', String(maxSizeMb))
      const res = await fetch(endpoint, { method: 'POST', body: fd })

      // `res.ok` PRIMA di `res.json()`, ed è il difetto che questo ordine ripara: il 413
      // della piattaforma ha `content-type: text/plain`, quindi il parse LANCIAVA
      // `SyntaxError` e il genitore si vedeva «Caricamento non riuscito. Riprova.» —
      // l'invito a rifare l'unica cosa che non poteva funzionare. In `app_log` restava
      // `modulo-allegato-upload-fallito: SyntaxError`, che del 413 non diceva nulla.
      // (Il 413 in tabella ci finisce comunque, una volta sola: lo registra il patch di
      // `fetch` in `@/lib/logging/client`, che i 413 li tiene come anomalia.)
      if (!res.ok) {
        setUploadError(
          res.status === 413
            ? t('fileTroppoPesante', { mb: limiteUploadMb(maxSizeMb) })
            : (await messaggioDelServer(res)) ?? t('caricamentoNonRiuscito'),
        )
        onChange('')
        return
      }

      const json: unknown = await res.json()
      const path = (json as { path?: unknown } | null)?.path
      if (typeof path !== 'string' || path === '') throw new Error('risposta senza path')
      onChange(path)
    } catch (err) {
      // Un catch che non logga è un bug: l'upload fallito è invisibile a chi
      // non ha in mano il dispositivo. `logClient` redige il path e non lancia.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `modulo-allegato-upload-fallito: ${nomeErrore(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
      })
      setUploadError(t('caricamentoNonRiuscito'))
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
            ? t('caricamento')
            : value
            ? fileName || t('allegatoCaricato')
            : t('selezionaFile')}
        </span>
        <input
          type="file"
          accept={acceptEff}
          className="hidden"
          disabled={uploading}
          onChange={handleFile}
        />
      </label>
      {/* Nativo: scatta la foto dell'allegato (solo se il campo ammette immagini).
          Fuori dalla <label> per non riaprire il file picker. Su web non compare. */}
      {consenteImmagini && (
        <ScattaFotoButton
          onFile={processaFile}
          label={t('scattaFoto')}
          disabled={uploading}
          className="mt-2 inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-dashed border-kidville-green/30 text-sm font-medium text-kidville-green hover:border-kidville-green transition-colors disabled:opacity-50"
        />
      )}
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
