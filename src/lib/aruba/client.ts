/**
 * Aruba — client REST reale per la Fatturazione Elettronica (SDI).
 *
 * Integrazione REALE (DL-017): autenticazione OAuth-like (Bearer token),
 * upload del tracciato FatturaPA (base64), polling stato/notifiche SDI.
 * Le credenziali NON transitano mai dal client: username dal config,
 * password risolta lato server da `process.env` via `password_ref` (vault/env).
 *
 * Doc ufficiale: https://fatturazioneelettronica.aruba.it/apidoc/docs_EN.html
 */

export interface ArubaConfig {
  username?: string
  password_ref?: string
  abilitato?: boolean
  ambiente?: string
  fiscal?: Record<string, unknown>
  iva?: { causale: string; aliquota: number; natura?: string }[]
}

export interface ArubaCredentials {
  username: string
  password: string
}

export interface ArubaTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number // epoch ms
}

export interface ArubaUploadResult {
  ok: boolean
  uploadFileName?: string
  errorCode: string
  errorDescription?: string
}

export interface ArubaInvoiceStatus {
  stato: number // 1..10 (vedi stato.ts)
  pdfBase64?: string | null
  raw?: unknown
}

/** Base URL per ambiente: DEMO (default) o PRODUCTION. */
export function arubaBaseUrls(ambiente?: string): { auth: string; ws: string } {
  if (ambiente === 'production' || ambiente === 'produzione') {
    return {
      auth: 'https://auth.fatturazioneelettronica.aruba.it',
      ws: 'https://ws.fatturazioneelettronica.aruba.it',
    }
  }
  return {
    auth: 'https://demoauth.fatturazioneelettronica.aruba.it',
    ws: 'https://demows.fatturazioneelettronica.aruba.it',
  }
}

/**
 * Risolve le credenziali lato server. La password viene letta da `process.env`
 * usando il nome indicato in `password_ref` (oppure dal fallback ARUBA_PASSWORD);
 * lo username dal config (o ARUBA_USERNAME). Ritorna null se incompleto.
 */
export function resolveArubaCredentials(config: ArubaConfig): ArubaCredentials | null {
  const username = config.username || process.env.ARUBA_USERNAME
  const password =
    (config.password_ref ? process.env[config.password_ref] : undefined) || process.env.ARUBA_PASSWORD
  if (!username || !password) return null
  return { username, password }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Autenticazione: POST /auth/signin (grant_type=password). */
export async function arubaSignin(ambiente: string | undefined, creds: ArubaCredentials): Promise<ArubaTokens> {
  const { auth } = arubaBaseUrls(ambiente)
  const body = new URLSearchParams({
    grant_type: 'password',
    username: creds.username,
    password: creds.password,
  }).toString()
  const res = await fetch(`${auth}/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`Aruba signin fallita (HTTP ${res.status})`)
  const json = await readJson(res)
  return {
    accessToken: String(json.access_token ?? ''),
    refreshToken: String(json.refresh_token ?? ''),
    expiresAt: Date.now() + Number(json.expires_in ?? 1700) * 1000,
  }
}

/** Rinnovo token: POST /auth/signin (grant_type=refresh_token). */
export async function arubaRefresh(ambiente: string | undefined, refreshToken: string): Promise<ArubaTokens> {
  const { auth } = arubaBaseUrls(ambiente)
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString()
  const res = await fetch(`${auth}/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`Aruba refresh fallito (HTTP ${res.status})`)
  const json = await readJson(res)
  return {
    accessToken: String(json.access_token ?? ''),
    refreshToken: String(json.refresh_token ?? refreshToken),
    expiresAt: Date.now() + Number(json.expires_in ?? 1700) * 1000,
  }
}

/** Upload del tracciato FatturaPA (non firmato; Aruba firma CAdES e invia allo SDI). */
export async function arubaUpload(
  ambiente: string | undefined,
  accessToken: string,
  params: { dataFileBase64: string; senderPIVA: string }
): Promise<ArubaUploadResult> {
  const { ws } = arubaBaseUrls(ambiente)
  const res = await fetch(`${ws}/services/invoice/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: JSON.stringify({
      dataFile: params.dataFileBase64,
      senderPIVA: params.senderPIVA,
      skipExtraSchema: false,
    }),
  })
  const json = await readJson(res)
  const env = (json.value as Record<string, unknown>) ?? json
  const errorCode = String(env.errorCode ?? (res.ok ? '0000' : String(res.status)))
  return {
    ok: errorCode === '0000',
    uploadFileName: env.uploadFileName ? String(env.uploadFileName) : undefined,
    errorCode,
    errorDescription: env.errorDescription ? String(env.errorDescription) : undefined,
  }
}

/** Stato di una fattura inviata: GET /services/invoice/out/getByFilename. */
export async function arubaGetByFilename(
  ambiente: string | undefined,
  accessToken: string,
  filename: string,
  opts?: { includePdf?: boolean }
): Promise<ArubaInvoiceStatus> {
  const { ws } = arubaBaseUrls(ambiente)
  const qs = new URLSearchParams({
    filename,
    includePdf: String(opts?.includePdf ?? true),
    includeFile: 'false',
  }).toString()
  const res = await fetch(`${ws}/services/invoice/out/getByFilename?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Aruba getByFilename fallita (HTTP ${res.status})`)
  const json = await readJson(res)
  const env = (json.value as Record<string, unknown>) ?? json
  const stato = Number(env.status ?? env.stato ?? 0)
  const pdf = (env.pdfFile ?? env.pdf ?? null) as string | null
  return { stato, pdfBase64: pdf, raw: json }
}

/**
 * Ultimo (massimo) numero di fattura EMESSA su Aruba per l'anno indicato:
 * GET /services/invoice/out/findByUsername. Serve ad allineare il progressivo
 * interno ed evitare collisioni con fatture emesse anche fuori dalla web app.
 * Best-effort: il chiamante degrada al contatore locale se questa fallisce.
 * NB il `number` è una stringa: si estrae la parte numerica e si prende il max.
 */
export async function arubaUltimoNumeroFattura(
  ambiente: string | undefined,
  accessToken: string,
  params: { username: string; anno: number; vatcodeSender?: string }
): Promise<number> {
  const { ws } = arubaBaseUrls(ambiente)
  const qs = new URLSearchParams({
    username: params.username,
    page: '1',
    size: '500',
    startDate: `${params.anno}-01-01`,
    endDate: `${params.anno}-12-31`,
  })
  if (params.vatcodeSender) qs.set('vatcodeSender', params.vatcodeSender)
  const res = await fetch(`${ws}/services/invoice/out/findByUsername?${qs.toString()}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Aruba findByUsername fallita (HTTP ${res.status})`)
  const json = await readJson(res)
  const env = (json.value as Record<string, unknown>) ?? json
  const invoices = (env.invoices ?? env.content ?? []) as { number?: string | number | null }[]
  let max = 0
  for (const inv of invoices) {
    const n = parseInt(String(inv.number ?? '').replace(/[^\d]/g, ''), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

/** Notifiche SDI relative a una fattura inviata. */
export async function arubaGetNotifications(
  ambiente: string | undefined,
  accessToken: string,
  filename: string
): Promise<unknown> {
  const { ws } = arubaBaseUrls(ambiente)
  const qs = new URLSearchParams({ filename }).toString()
  const res = await fetch(`${ws}/services/notification/out/getByInvoiceFilename?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Aruba notifiche fallite (HTTP ${res.status})`)
  return readJson(res)
}
