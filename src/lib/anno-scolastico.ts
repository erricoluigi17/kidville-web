import { dataCivile } from '@/i18n/config'

// Anno scolastico italiano: va da settembre a luglio (agosto fa già da ponte
// verso il nuovo anno). Regola: mese >= 8 (agosto) → `${y}/${y+1}`,
// altrimenti `${y-1}/${y}`. Es. 10 lug 2026 → "2025/2026"; 1 ago 2026 → "2026/2027".
//
// ⚠️ IL GIORNO SI CONTA A ROMA, NON DOVE GIRA IL PROCESSO.
//
// Fino al 2026-08-16 questa funzione usava `d.getFullYear()`/`d.getMonth()`, cioè il
// fuso dell'AMBIENTE: su Vercel il processo gira in UTC mentre le famiglie sono in
// Italia. Fra le 00:00 e le 02:00 italiane del 1° agosto il server è ancora al 31
// luglio, e i due mesi cadono ai due lati della soglia: l'anno scolastico usciva
// diverso a seconda di chi lo chiedeva.
//
// Non è un cavillo: `documentoDellAnnoScolastico` confronta questo valore con l'anno
// del giorno civile italiano per decidere se RIUSARE il certificato già emesso. Con i
// due lati in fusi diversi, in quella finestra ogni «Scarica il certificato» non
// riusava nulla — riemetteva, bruciando un numero del registro di protocollo WORM (che
// non torna indietro) e stampando l'anno scolastico SBAGLIATO su un foglio destinato a
// un datore di lavoro o all'INPS.
//
// È la stessa classe di difetto già pagata il 2026-08-01 alle 01:08 con gli incassi
// spariti da un KPI, e per cui esiste `dataCivile` — vedi il commento in
// `src/i18n/config.ts`. Qui si riusa quella, invece di ridichiarare il fuso.
export function annoScolasticoCorrente(d: Date = new Date()): string {
  const [y, m] = dataCivile(d).split('-').map(Number)
  return m >= 8 ? `${y}/${y + 1}` : `${y - 1}/${y}`
}
