import { useCallback, useSyncExternalStore } from 'react'
import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * «NASCONDI LE CIFRE» DELLA CONTABILITÀ — LA SCELTA RICORDATA SUL DISPOSITIVO.
 *
 * La Direzione lavora con lo schermo che altri possono vedere: un pulsante a occhio sostituisce gli
 * importi con «••••», e la scelta si ricorda per utente su questo dispositivo. Default: visibili.
 *
 * Si tiene solo un bit per utente (`'1'` = nascoste; assente o altro = visibili): nessun dato
 * personale, nessun importo. Se il `localStorage` manca o lancia (Safari privato, quota piena,
 * `SecurityError`) la scelta vale comunque per la sessione, in una memoria del modulo, e il guasto si
 * dice UNA volta sola nel log: ripeterlo a ogni lettura sarebbe rumore. Nel messaggio di log non entra
 * mai lo userId.
 */

const PREFISSO_CHIAVE = 'kv:contabilita-cifre-nascoste:'

/** La parte di `Storage` che serve: iniettabile, perché il collaudo non deve toccare quello vero. */
export interface DepositoCifre {
  getItem(chiave: string): string | null
  setItem(chiave: string, valore: string): void
}

let segnalato = false

/** Un guasto del deposito si dice una volta per sessione. */
function segnala(err: unknown): void {
  if (segnalato) return
  segnalato = true
  logClient({
    livello: 'warn',
    evento: 'offline',
    messaggio: `cifre-nascoste-storage-non-disponibile: ${nomeErrore(err)}`,
    route: '/admin/pagamenti',
  })
}

/**
 * Le scelte che il deposito non ha potuto tenere: finché una chiave è qui, vince sul deposito (che
 * altrimenti riporterebbe il valore vecchio dopo una scrittura fallita per quota piena).
 */
const inMemoria = new Map<string, string>()

/** Il deposito del browser, o `null` quando non c'è: l'accesso stesso può lanciare. */
function depositoDelBrowser(): DepositoCifre | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch (err) {
    segnala(err)
    return null
  }
}

/** Le cifre di questo utente sono nascoste? Senza userId, mai. */
export function leggiCifreNascoste(
  userId: string,
  deposito: DepositoCifre | null = depositoDelBrowser(),
): boolean {
  if (!userId) return false
  const chiave = PREFISSO_CHIAVE + userId
  const inRam = inMemoria.get(chiave)
  if (inRam !== undefined) return inRam === '1'
  if (!deposito) return false
  try {
    return deposito.getItem(chiave) === '1'
  } catch (err) {
    segnala(err)
    return false
  }
}

const ascoltatori = new Set<() => void>()

function avvisa(): void {
  // Una copia: chi viene avvisato può smettere di ascoltare mentre si avvisano gli altri.
  for (const avviso of [...ascoltatori]) avviso()
}

/** Ricorda la scelta e avvisa chi la mostra. Senza userId è un no-op. */
export function scriviCifreNascoste(
  userId: string,
  nascoste: boolean,
  deposito: DepositoCifre | null = depositoDelBrowser(),
): void {
  if (!userId) return
  const chiave = PREFISSO_CHIAVE + userId
  const valore = nascoste ? '1' : '0'
  let scritto = false
  if (deposito) {
    try {
      deposito.setItem(chiave, valore)
      scritto = true
    } catch (err) {
      segnala(err)
    }
  }
  // Scritto sul deposito: la memoria non serve e non deve fare ombra. Altrimenti si ripiega.
  if (scritto) inMemoria.delete(chiave)
  else inMemoria.set(chiave, valore)
  avvisa()
}

/** Definita a livello di modulo: identità stabile, nessuna risottoscrizione a ogni render. */
function ascolta(avviso: () => void): () => void {
  ascoltatori.add(avviso)
  // L'evento `storage` arriva dalle ALTRE schede: una scelta fatta altrove si vede qui.
  if (typeof window !== 'undefined') window.addEventListener('storage', avviso)
  return () => {
    ascoltatori.delete(avviso)
    if (typeof window !== 'undefined') window.removeEventListener('storage', avviso)
  }
}

/**
 * La scelta di questo utente e il modo di cambiarla. Lo snapshot del server è `false` (cifre visibili):
 * niente mismatch di idratazione, e la scelta ricordata si applica subito dopo.
 */
export function useCifreNascoste(userId: string): [boolean, (nascoste: boolean) => void] {
  const nascoste = useSyncExternalStore(
    ascolta,
    () => leggiCifreNascoste(userId),
    () => false,
  )
  const imposta = useCallback((v: boolean) => scriviCifreNascoste(userId, v), [userId])
  return [nascoste, imposta]
}
