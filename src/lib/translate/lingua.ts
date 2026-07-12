// =============================================================================
// Euristica leggera (client-safe, zero dipendenze) per decidere se un testo
// "sembra italiano". Usata dalla chat per mostrare il pulsante «Traduci» SOLO
// quando serve: messaggio in un'altra lingua, oppure lettore con dispositivo
// non italiano. Non è un language-detector: sbagliare mostra/nasconde solo un
// pulsante, quindi privilegiamo semplicità e zero falsi allarmi sui messaggi
// brevissimi ("ok", emoji), che non hanno nulla da tradurre.
// =============================================================================

// Parole funzionali/quotidiane italiane (minuscole). Le frasi italiane reali ne
// contengono quasi sempre almeno una ogni poche parole.
const STOPWORDS_IT = new Set([
  // articoli e preposizioni (anche articolate)
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'a', 'da', 'in',
  'con', 'su', 'per', 'tra', 'fra', 'del', 'dello', 'della', 'dei', 'degli',
  'delle', 'dal', 'dalla', 'nel', 'nella', 'nei', 'nelle', 'al', 'allo', 'alla',
  'ai', 'alle', 'sul', 'sulla', 'sui', 'sulle',
  // congiunzioni, particelle, avverbi comuni
  'e', 'ed', 'o', 'ma', 'se', 'che', 'chi', 'cosa', 'come', 'dove', 'quando',
  'perché', 'perche', 'non', 'più', 'piu', 'anche', 'ancora', 'già', 'gia',
  'poi', 'qui', 'qua', 'lì', 'là', 'però', 'pero', 'quindi', 'allora', 'ecco',
  'molto', 'tutto', 'tutti', 'tutte', 'niente', 'nulla', 'solo', 'sempre',
  // essere/avere e pronomi
  'sono', 'sei', 'è', 'siamo', 'siete', 'era', 'ho', 'hai', 'ha', 'abbiamo',
  'avete', 'hanno', 'mi', 'ti', 'si', 'ci', 'vi', 'ne', 'io', 'tu', 'lui',
  'lei', 'noi', 'voi', 'loro', 'mio', 'mia', 'tuo', 'tua', 'suo', 'sua',
  'questo', 'questa', 'questi', 'queste', 'quello', 'quella',
  // saluti e lessico scolastico quotidiano
  'ciao', 'salve', 'buongiorno', 'buonasera', 'buonanotte', 'arrivederci',
  'grazie', 'prego', 'scusi', 'scusa', 'bene', 'male', 'ok', 'va', 'sì', 'si',
  'no', 'domani', 'oggi', 'ieri', 'signora', 'signore', 'maestra', 'maestro',
  'bambino', 'bambina', 'bimbo', 'bimba', 'scuola', 'classe', 'compiti',
])

/**
 * True se il testo sembra italiano (o non contiene abbastanza segnale per
 * giudicare: testo vuoto, emoji, una parolina corta → true = niente pulsante).
 */
export function sembraItaliano(testo: string): boolean {
  const t = (testo ?? '').trim()
  if (!t) return true

  // Lettere di alfabeti non latini (cirillico, arabo, cinese…): se sono una
  // parte significativa del testo, non è italiano.
  const lettere = t.match(/\p{L}/gu) ?? []
  if (lettere.length === 0) return true // solo emoji/numeri/punteggiatura
  const nonLatine = lettere.filter((ch) => !/\p{Script=Latin}/u.test(ch)).length
  if (nonLatine / lettere.length > 0.3) return false

  // Analisi per parole (apostrofi inclusi: "c'è", "un'ora").
  const parole = (t.toLowerCase().match(/[\p{Script=Latin}']+/gu) ?? []).map((w) =>
    w.replace(/^'+|'+$/g, ''),
  ).filter(Boolean)
  if (parole.length === 0) return true
  // Una sola parola cortissima ("ok", "sì", "yes"): niente da tradurre.
  if (parole.length === 1 && parole[0].length <= 4) return true

  // Conta anche le componenti degli apostrofi ("c'è" → "c", "è").
  const token = parole.flatMap((w) => w.split("'")).filter(Boolean)
  const hit = token.filter((w) => STOPWORDS_IT.has(w)).length

  // Frasi brevi: basta una stopword. Frasi lunghe: almeno ~15% di stopword.
  if (token.length <= 6) return hit >= 1
  return hit / token.length >= 0.15
}
