import Anthropic from '@anthropic-ai/sdk'

// P4/DL-042 — Traduzione automatica chat (insegnante↔famiglie straniere) via Claude.
// Servizio gated su ANTHROPIC_API_KEY (dipendenza esterna, come Aruba): se la chiave
// manca, ritorna `disabled` e l'UI nasconde il pulsante "Traduci". Modello haiku
// (economico/veloce); nessun thinking/effort (non supportati/necessari).

const TRANSLATE_MODEL = 'claude-haiku-4-5'

export interface TranslateResult {
  translated: string | null
  disabled?: boolean
}

// Interfaccia minima per dependency-injection nei test (no rete).
type Translator = {
  messages: {
    create: (args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>
  }
}

export function isTranslationEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

export async function translateText(
  text: string,
  targetLang: string,
  opts?: { apiKey?: string | undefined; client?: Translator },
): Promise<TranslateResult> {
  const apiKey = opts?.apiKey !== undefined ? opts.apiKey : process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { translated: null, disabled: true }

  const trimmed = (text ?? '').trim()
  if (!trimmed) return { translated: '' }

  const client: Translator = opts?.client ?? (new Anthropic({ apiKey }) as unknown as Translator)
  try {
    const res = await client.messages.create({
      model: TRANSLATE_MODEL,
      max_tokens: 1024,
      system: `Sei un traduttore. Traduci il messaggio dell'utente nella lingua con codice "${targetLang}". Rispondi SOLO con la traduzione, senza preamboli, virgolette o note. Mantieni il tono colloquiale e gli eventuali emoji.`,
      messages: [{ role: 'user', content: trimmed }],
    })
    const out = res.content.find((b) => b.type === 'text')?.text?.trim() ?? null
    return { translated: out }
  } catch (e) {
    console.error('[translate] errore:', e)
    return { translated: null }
  }
}
