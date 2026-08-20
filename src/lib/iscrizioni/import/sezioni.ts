/**
 * LA CLASSE DEL FOGLIO CHE IN ARCHIVIO NON ESISTE — e che oggi non lo dice.
 *
 * ─── IL GUASTO, MISURATO ────────────────────────────────────────────────────
 * `eseguiDomanda` scrive la classe come TESTO in `alunni.classe_sezione`
 * (`esegui.ts:204-206`) e lascia al trigger `sync_alunno_section_id` il compito
 * di risolvere `section_id`. Se nessuna sezione combacia, il trigger **lascia
 * NULL e non solleva niente**: l'alunno viene creato, la sua iscrizione risulta
 * completata, e il bambino non compare in nessun appello e in nessun registro.
 * Nessun errore, nessun log, nessun test.
 *
 * Misurato il 2026-08-20 sul foglio vero di Cesa contro le sezioni in
 * produzione: 3 classi su 13 non hanno una sezione omonima — `2 ANNI CONCY`,
 * `2 ANNI AMALIA` (l'archivio ne ha una sola, `2 ANNI`) e `5 ANNI GIUSY`
 * (l'archivio ha `5 ANNI`). Valgono 66 righe del foglio.
 *
 * ─── PERCHÉ SI DICHIARA E NON SI RIFIUTA ────────────────────────────────────
 * Rifiutare il file lascerebbe la sede SENZA elenco, e il giro dell'indomani non
 * assegnerebbe nessuna classe a nessuno: il rimedio sarebbe peggio del male.
 * L'anomalia è però da CORREGGERE, non da guardare: chi la legge deve capire che
 * l'iscrizione andrà avanti lo stesso, e che il bambino resterà senza sezione.
 *
 * ─── QUESTO MODULO NON LEGGE IL DATABASE ────────────────────────────────────
 * Riceve i nomi delle sezioni già letti. Così si collauda senza un finto di
 * Supabase, e la regola di confronto — che è quella del trigger, alla lettera —
 * resta l'unica cosa da guardare.
 */
import { normalizzaNomeSezione } from '@/lib/alunni/sezione'
import type { Anomalia } from './elenco'

/**
 * Le classi del foglio che nessuna sezione della sede risolverebbe.
 *
 * @param perClasse   il conteggio per classe che esce da `leggiElenco`
 * @param nomiSezioni i `sections.name` della sede. **Elenco vuoto ⇒ nessuna
 *                    anomalia**: significa «non lo so», non «non combacia
 *                    nessuna», e gridare su ogni classe sarebbe rumore che
 *                    nasconde il segnale.
 */
export function anomalieClassiSenzaSezione(
  perClasse: readonly { classe: string; alunni: number }[],
  nomiSezioni: readonly string[],
): Anomalia[] {
  if (nomiSezioni.length === 0) return []
  const esistenti = new Set(nomiSezioni.map(normalizzaNomeSezione))

  const out: Anomalia[] = []
  for (const c of perClasse) {
    if (esistenti.has(normalizzaNomeSezione(c.classe))) continue
    out.push({
      genere: 'classe-senza-sezione',
      classe: c.classe,
      // La classe sta nella riga 1 in entrambe le forme del foglio: come nome
      // del foglio o come intestazione della colonna. È lì che si corregge.
      rigaExcel: 1,
      nome: '',
      dettaglio:
        `La classe «${c.classe}» non è fra le sezioni di questa sede: i ${c.alunni} bambini ` +
        `di questa classe verrebbero iscritti SENZA sezione — invisibili all'appello e a ogni ` +
        `registro. Va creata la sezione con questo nome esatto, oppure corretto il nome nel foglio.`,
    })
  }
  return out
}
