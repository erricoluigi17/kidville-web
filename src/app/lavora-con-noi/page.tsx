import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { PublicPageHeader } from '@/components/ui/PublicPageHeader'
import { CandidaturaInsegnanteWizard } from '@/components/features/public/CandidaturaInsegnanteWizard'

/**
 * `/lavora-con-noi` — il modulo PUBBLICO di candidatura di un'insegnante.
 *
 * È il link che la scuola manda a chi si propone: si apre senza account, perché
 * chi si candida non ne ha uno e non deve averlo — l'account (`utenti`, ruolo
 * `educator`) nasce solo se la Direzione approva.
 *
 * ⚠️ `/lavora-con-noi` era GIÀ in `PUBLIC_PREFIXES` (`src/lib/auth/middleware-rules.ts`)
 * prima che questa pagina esistesse, ed era voluto: senza quella voce la pagina,
 * il giorno in cui fosse nata, sarebbe finita dietro il login — un difetto che
 * da server non si vede, perché lo si scopre solo aprendo la pagina da
 * disconnessi. Chi tocca questo file non tolga quella riga:
 * `__tests__/architecture/prefissi-pubblici.test.ts` la pretende.
 *
 * ── I DUE PARAMETRI DELL'URL ────────────────────────────────────────────────
 *
 * `?sede=<uuid>` — il link «targato» per plesso: salta il passo di scelta della
 * sede. Il link da diffondere resta UNO, uguale per tutte e tre le sedi; questo
 * serve a chi vuole indirizzare una candidatura a un plesso preciso.
 *
 * ⚠️ `?sede=` SENZA VALORE vale come ASSENTE, e va normalizzato QUI. La stringa
 * vuota è falsy ma non `null`: passata giù verrebbe scambiata per «sede già
 * decisa», la scelta del plesso non comparirebbe e l'invio partirebbe senza
 * sede — cioè con un 400 dopo tutto il modulo compilato. È lo stesso inciampo
 * già pagato su `/iscrizione?scuola=`.
 *
 * `?da=<percorso>` — da dove si è arrivati, per il link di ritorno della riga di
 * testa. `PublicPageHeader` lo filtra (solo percorsi interni), perché è un
 * valore che scrive chiunque sappia comporre un URL.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('public')
  return {
    title: t('candMetaTitolo'),
    description: t('candMetaDescrizione'),
  }
}

export default async function LavoraConNoiPage({
  searchParams,
}: {
  searchParams?: Promise<{ sede?: string; da?: string }>
}) {
  const sp = (await searchParams) ?? {}
  const sede = sp.sede?.trim()

  return (
    // ── IL PUNTO DI RIFERIMENTO PER CHI NAVIGA PER REGIONI (11/08/2026) ───────
    // MISURATO sulla pagina viva, su tutti e cinque i passi:
    // `document.querySelector('main')` → `null`, e zero `nav`/`header`/`aside`/
    // `footer`. Nessun fallimento WCAG A/AA — la struttura per intestazioni c'è
    // ed è corretta (un solo `h1`, un `h2` per passo, `h3` nei gruppi del
    // riepilogo) — ma è il landmark che permette a uno screen reader di saltare
    // al contenuto invece di scorrere la riga di testa a ogni passo. Le tre
    // pagine legali (`/privacy`, `/termini`, `/assistenza`) ce l'hanno già: qui
    // mancava, ed era l'unica delle superfici pubbliche con un modulo dentro.
    //
    // ⚠️ Sta QUI e non dentro il wizard: il wizard è un componente client
    // rimontato dai passi, mentre il landmark è una proprietà della PAGINA. E
    // sta FUORI dal guscio `kv-public` per non entrare nella cascata delle
    // regole per superficie, che agganciano classi e non elementi.
    //
    // ⚠️ E la colonna «Dopo l'invio» resta un `<div>`: da oggi che il `<main>`
    // c'è, promuoverla ad `<aside>` la renderebbe un landmark `complementary`
    // ANNIDATO dentro `main` — cioè il rilievo axe
    // `landmark-complementary-is-top-level`. Per essere un `aside` legittimo
    // dovrebbe stare fuori da qui, ma vive dentro la griglia a due colonne del
    // wizard ed è lì che deve stare (è la seconda colonna da `lg` in su, e sotto
    // `lg` il suo posto nell'ordine del documento è misurato). Resta navigabile
    // perché ha la sua intestazione. Il commento accanto a quel `<div>`, in
    // `CandidaturaInsegnanteWizard.tsx`, è aggiornato di conseguenza.
    <main>
      <CandidaturaInsegnanteWizard
        sedeId={sede && sede.length > 0 ? sede : null}
        // La riga di testa pubblica è un componente SERVER e viene passata come
        // slot: è l'unico posto in cui vivono insieme il ritorno tradotto e il
        // comando di Alto Contrasto, ed è il motivo per cui non si ricopia in
        // ogni pagina — cinque copie sono cinque occasioni di divergere.
        intestazione={<PublicPageHeader ritorno={sp.da} />}
      />
    </main>
  )
}
