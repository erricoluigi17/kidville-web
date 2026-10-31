/**
 * CRM DELLA SEGRETERIA · CONFRONTARE I NOMI DI BATTESIMO.
 *
 * Un solo punto per la regola «questo nome somiglia a quello», usata da due strade che non devono mai
 * divergere: l'abbinamento dei figli di una domanda ai bambini di una scheda (`collegamento.ts`) e la
 * ricerca dell'alunno che l'import ha creato da quella domanda (`aggancio-alunno.ts`). Sta in un file a sé
 * perché le due si importano a vicenda nel flusso (il collegamento chiama l'aggancio): una funzione
 * condivisa dentro uno dei due darebbe un import circolare.
 */

/** Le parole di almeno tre lettere di un nome, senza maiuscole né accenti. */
export function paroleDelNome(nome: string | null | undefined): Set<string> {
  if (!nome) return new Set()
  return new Set(
    nome
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter((p) => p.length >= 3),
  )
}

/** I due nomi hanno almeno una parola di tre lettere in comune? Mai il cognome: lo condividono i fratelli. */
export function nomiSiSomigliano(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = paroleDelNome(a)
  for (const p of paroleDelNome(b)) if (pa.has(p)) return true
  return false
}
