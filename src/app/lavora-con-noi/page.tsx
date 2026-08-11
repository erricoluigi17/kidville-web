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
    <CandidaturaInsegnanteWizard
      sedeId={sede && sede.length > 0 ? sede : null}
      // La riga di testa pubblica è un componente SERVER e viene passata come
      // slot: è l'unico posto in cui vivono insieme il ritorno tradotto e il
      // comando di Alto Contrasto, ed è il motivo per cui non si ricopia in
      // ogni pagina — cinque copie sono cinque occasioni di divergere.
      intestazione={<PublicPageHeader ritorno={sp.da} />}
    />
  )
}
