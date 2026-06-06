// Allergeni alimentari canonici (i 14 dell'allegato II Reg. UE 1169/2011).
// Usati sia per taggare le portate del menu sia per le allergie degli alunni,
// così il match è su chiavi normalizzate e non su confronto di testo libero.

export type AllergeneKey =
  | 'glutine' | 'crostacei' | 'uova' | 'pesce' | 'arachidi' | 'soia' | 'latte'
  | 'frutta_a_guscio' | 'sedano' | 'senape' | 'sesamo' | 'solfiti' | 'lupini' | 'molluschi'

export interface AllergeneDef {
  key: AllergeneKey
  label: string       // etichetta IT mostrata in UI
  emoji: string
  sinonimi: string[]  // termini per inferire l'allergene da testo libero
}

// Ordine = ordine di visualizzazione nelle checkbox.
export const ALLERGENI: AllergeneDef[] = [
  { key: 'glutine', label: 'Glutine', emoji: '🌾', sinonimi: ['glutine', 'grano', 'frumento', 'gluten', 'farro', 'orzo', 'segale', 'avena', 'kamut', 'pane', 'pasta', 'farina'] },
  { key: 'crostacei', label: 'Crostacei', emoji: '🦐', sinonimi: ['crostacei', 'crostaceo', 'gambero', 'gamberi', 'gamberetti', 'scampi', 'granchio', 'aragosta', 'mazzancolle'] },
  { key: 'uova', label: 'Uova', emoji: '🥚', sinonimi: ['uovo', 'uova', 'albume', 'tuorlo', 'frittata', 'maionese'] },
  { key: 'pesce', label: 'Pesce', emoji: '🐟', sinonimi: ['pesce', 'merluzzo', 'tonno', 'salmone', 'acciughe', 'acciuga', 'alici', 'nasello', 'platessa', 'sgombro'] },
  { key: 'arachidi', label: 'Arachidi', emoji: '🥜', sinonimi: ['arachide', 'arachidi', 'nocciolina', 'noccioline', 'burro di arachidi'] },
  { key: 'soia', label: 'Soia', emoji: '🫘', sinonimi: ['soia', 'soja', 'tofu', 'edamame'] },
  { key: 'latte', label: 'Latte / lattosio', emoji: '🥛', sinonimi: ['latte', 'lattosio', 'latticini', 'formaggio', 'formaggi', 'burro', 'panna', 'yogurt', 'parmigiano', 'mozzarella', 'ricotta', 'besciamella', 'grana'] },
  { key: 'frutta_a_guscio', label: 'Frutta a guscio', emoji: '🌰', sinonimi: ['frutta a guscio', 'noci', 'noce', 'nocciola', 'nocciole', 'mandorla', 'mandorle', 'pistacchio', 'pistacchi', 'anacardi', 'pinoli', 'noci pecan', 'noci macadamia'] },
  { key: 'sedano', label: 'Sedano', emoji: '🥬', sinonimi: ['sedano'] },
  { key: 'senape', label: 'Senape', emoji: '🟡', sinonimi: ['senape', 'mostarda'] },
  { key: 'sesamo', label: 'Sesamo', emoji: '◯', sinonimi: ['sesamo', 'tahin', 'tahini'] },
  { key: 'solfiti', label: 'Solfiti', emoji: '🍷', sinonimi: ['solfiti', 'solfito', 'anidride solforosa', 'so2'] },
  { key: 'lupini', label: 'Lupini', emoji: '🫛', sinonimi: ['lupini', 'lupino'] },
  { key: 'molluschi', label: 'Molluschi', emoji: '🦑', sinonimi: ['molluschi', 'mollusco', 'vongole', 'cozze', 'calamari', 'calamaro', 'polpo', 'seppia', 'seppie', 'lumache', 'ostriche'] },
]

const BY_KEY = new Map(ALLERGENI.map(a => [a.key, a]))
export const ALLERGENE_KEYS = ALLERGENI.map(a => a.key)

export function isAllergeneKey(k: string): k is AllergeneKey {
  return BY_KEY.has(k as AllergeneKey)
}

export function allergeneLabel(k: string): string {
  return BY_KEY.get(k as AllergeneKey)?.label ?? k
}

export function allergeneEmoji(k: string): string {
  return BY_KEY.get(k as AllergeneKey)?.emoji ?? '⚠️'
}

// Tiene solo le chiavi valide e deduplica, preservando l'ordine canonico.
export function normalizzaAllergeni(keys: unknown): AllergeneKey[] {
  const set = new Set<string>(Array.isArray(keys) ? keys.map(String) : [])
  return ALLERGENE_KEYS.filter(k => set.has(k))
}

// Inferisce allergeni dal testo libero (es. alunni.allergies "lattosio, fragole").
// Usato come fallback quando l'alunno non ha ancora allergeni strutturati.
export function inferisciAllergeniDaTesto(testo?: string | null): AllergeneKey[] {
  if (!testo) return []
  const t = testo.toLowerCase()
  const out: AllergeneKey[] = []
  for (const a of ALLERGENI) {
    if (a.sinonimi.some(s => t.includes(s))) out.push(a.key)
  }
  return out
}

// Allergeni "effettivi" di un alunno: usa quelli strutturati se presenti,
// altrimenti li inferisce dal testo libero.
export function allergeniAlunno(opts: { allergeni?: string[] | null; allergies?: string | null }): AllergeneKey[] {
  const strutturati = normalizzaAllergeni(opts.allergeni)
  if (strutturati.length > 0) return strutturati
  return inferisciAllergeniDaTesto(opts.allergies)
}

export interface PortateAllergeni {
  primo?: string[]
  secondo?: string[]
  contorno?: string[]
  frutta?: string[]
}
// Alias: stessa forma usata in resolveMenu (allergeni per portata).
export type AllergeniPortate = PortateAllergeni

// Union di tutti gli allergeni delle portate di un giorno (chiavi canoniche).
export function allergeniDelGiorno(perPortata?: PortateAllergeni | null): AllergeneKey[] {
  if (!perPortata) return []
  const all = [
    ...(perPortata.primo ?? []),
    ...(perPortata.secondo ?? []),
    ...(perPortata.contorno ?? []),
    ...(perPortata.frutta ?? []),
  ]
  return normalizzaAllergeni(all)
}

export interface ConflittoAllergia {
  allergene: AllergeneKey
  portate: ('primo' | 'secondo' | 'contorno' | 'frutta')[]
}

// Conflitti tra le allergie di un alunno e gli allergeni del menu del giorno:
// per ogni allergene in comune indica in quali portate compare.
export function conflittiAllergie(
  allergeniAlunno: string[],
  perPortata?: PortateAllergeni | null
): ConflittoAllergia[] {
  if (!perPortata) return []
  const alunno = new Set(normalizzaAllergeni(allergeniAlunno))
  const portate: ('primo' | 'secondo' | 'contorno' | 'frutta')[] = ['primo', 'secondo', 'contorno', 'frutta']
  const out: ConflittoAllergia[] = []
  for (const key of ALLERGENE_KEYS) {
    if (!alunno.has(key)) continue
    const inPortate = portate.filter(p => (perPortata[p] ?? []).includes(key))
    if (inPortate.length > 0) out.push({ allergene: key, portate: inPortate })
  }
  return out
}
