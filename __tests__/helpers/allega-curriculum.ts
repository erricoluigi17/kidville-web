import { expect } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/react'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  ALLEGARE UN FILE A UN CAMPO `file`, IN UN POSTO SOLO                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * Questa funzione era ricopiata **sei volte**, identica riga per riga, in
 * `CandidaturaInsegnanteWizard-{sede,posizioni,riepilogo,errore-invio,consensi}`
 * e in `a11y/candidatura-insegnante-a11y`. Finché nessuno la toccava, sei copie
 * uguali costavano solo spazio.
 *
 * Il 2026-08-25 qualcuno l'ha toccata, e il conto è arrivato tutto insieme: il
 * riquadro del file ha smesso di stampare il nome in un nodo di testo unico (il
 * troncamento centrale lo spezza in radice + coda, vedi `spezzaNomeFile`), e
 * `getByText(NOME_FILE)` ha smesso di trovarlo. Le sei copie sono andate in
 * TIMEOUT insieme — **132 test rossi in sei file**, tutti con lo stack di un
 * `waitFor` scaduto, cioè con la diagnosi peggiore possibile: sembrava che il
 * wizard fosse rotto, e invece era rotta la sonda.
 *
 * È esattamente la dottrina che questo repo ha già pagato altrove: *una regola
 * valida per due strade deve vivere in un posto solo*. Vale anche quando la
 * «regola» è il modo di premere un bottone in un test.
 *
 * ─── E LA SONDA GUARDA CIÒ CHE UNA PERSONA LEGGE ───────────────────────────
 *
 * Non `getByText`, che pretende un nodo di testo unico, ma il `textContent` del
 * riquadro: è la stessa cosa che legge chi compila, e sopravvive a qualunque
 * modo il componente scelga per impaginare il nome.
 *
 * ⚠️ L'ATTESA IN CODA NON È FACOLTATIVA: il caricamento è asincrono, e senza di
 * essa si preme «Avanti» prima che il campo abbia preso il percorso — cioè si
 * collauda esattamente il caso che si voleva evitare.
 */
export async function allegaAlCampoFile(idCampo: string, nomeFile: string): Promise<void> {
  const controllo = document.getElementById(idCampo) as HTMLInputElement | null
  expect(controllo, `il campo «${idCampo}» non è reso dal modulo`).not.toBeNull()
  fireEvent.change(controllo!, {
    target: { files: [new File(['%PDF-1.4 finto'], nomeFile, { type: 'application/pdf' })] },
  })
  const riquadro = controllo!.closest('label')
  expect(riquadro, `il campo «${idCampo}» non è dentro il riquadro che ne mostra lo stato`).not.toBeNull()
  await waitFor(() => expect(riquadro!.textContent).toContain(nomeFile))
}

/** Il curriculum di `/lavora-con-noi`: il caso di gran lunga più frequente. */
export const allegaCurriculumDiProva = (nomeFile: string) => allegaAlCampoFile('cv_path', nomeFile)
