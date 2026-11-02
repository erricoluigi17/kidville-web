'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { TriangleAlert, Vote } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import type { SchedaGenitore } from '@/lib/votazioni/tipi'
import { leggiSchede } from './chiamate'
import { SchedaVoto } from './SchedaVoto'

interface Props {
  /** L'identità di sessione. `null` finché non è risolta: la pagina resta in «caricamento» e non chiama. */
  parentId: string | null
}

type Stato =
  | { fase: 'caricamento' }
  | { fase: 'pronto'; schede: SchedaGenitore[] }
  | { fase: 'errore'; messaggio: string }

/** Una votazione ha più schede (una per classe, più l'istituto): la chiave le distingue tutte. */
const chiaveScheda = (s: SchedaGenitore) => `${s.votazioneId}:${s.ambito}:${s.sectionId ?? 'istituto'}`

/**
 * L'ELENCO DELLE SCHEDE DA VOTARE: carica `GET /api/parent/votazioni`, disegna una `SchedaVoto` per
 * scheda e ricarica quando una scheda scopre di essere chiusa.
 *
 * ── PAGINA APERTA OLTRE LA SCADENZA (Review Focus 3) ────────────────────────────
 * Il genitore vota alle 18:01 su una scheda caricata alle 17:50. Il server risponde 409
 * `VOTAZIONE_CHIUSA`: la scheda passa il messaggio qui (`onVotazioneChiusa`), questo componente lo
 * mostra in un riquadro SUO e rilegge l'elenco, e la scheda sparisce. Il messaggio sta qui e non nella
 * scheda perché la scheda, ricaricando, se lo porterebbe via: il genitore leggerebbe un lampo e poi
 * nulla, senza sapere perché la scheda è sparita.
 *
 * ── LA RILETTURA È SILENZIOSA ───────────────────────────────────────────────────
 * Non torna in «caricamento»: le altre schede restano a schermo finché la nuova lista non arriva, così
 * chi ha una scheda ancora aperta non vede la pagina svuotarsi e riempirsi.
 *
 * ── LA FORMA DELL'EFFETTO ───────────────────────────────────────────────────────
 * Funzione di modulo (`leggiSchede`) che restituisce un esito, `setState` dentro il `.then` e flag
 * `vivo`: così una risposta vecchia non scrive sopra una nuova (`react-hooks/set-state-in-effect`).
 */
export function SchedeVotazione({ parentId }: Props) {
  const t = useTranslations('votazioniGenitore')
  const fallback = t('erroreCaricamento')
  const [stato, setStato] = useState<Stato>({ fase: 'caricamento' })
  const [tentativo, setTentativo] = useState(0)
  const [chiusura, setChiusura] = useState<string | null>(null)

  useEffect(() => {
    if (!parentId) return
    let vivo = true
    void leggiSchede(parentId, fallback).then((esito) => {
      if (!vivo) return
      setStato(
        esito.tipo === 'ok'
          ? { fase: 'pronto', schede: esito.schede }
          : { fase: 'errore', messaggio: esito.messaggio },
      )
    })
    return () => {
      vivo = false
    }
  }, [parentId, tentativo, fallback])

  const riprova = () => {
    setChiusura(null)
    setStato({ fase: 'caricamento' })
    setTentativo((n) => n + 1)
  }

  const votazioneChiusa = (messaggio: string) => {
    setChiusura(messaggio)
    setTentativo((n) => n + 1)
  }

  return (
    <div>
      {chiusura && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-kidville-error bg-kidville-error-soft px-4 py-3 font-maven text-[13.5px] text-kidville-error-strong"
        >
          {chiusura}
        </p>
      )}

      {stato.fase === 'caricamento' && (
        <div role="status" className="flex flex-col items-center justify-center gap-3 py-20">
          <div
            aria-hidden="true"
            className="h-7 w-7 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green"
          />
          <p className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>
        </div>
      )}

      {stato.fase === 'errore' && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <TriangleAlert size={34} aria-hidden="true" className="text-kidville-error-strong" />
          <p role="alert" className="max-w-xs font-maven text-sm text-kidville-ink">
            {stato.messaggio}
          </p>
          <Btn variant="ghost" size="sm" onClick={riprova}>
            {t('riprova')}
          </Btn>
        </div>
      )}

      {stato.fase === 'pronto' && stato.schede.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-kidville-green-soft text-kidville-green">
            <Vote size={28} strokeWidth={1.8} aria-hidden="true" />
          </div>
          <h2 className="mb-2 font-barlow text-xl font-bold uppercase text-kidville-green">{t('vuotoTitolo')}</h2>
          <p className="max-w-xs font-maven text-sm text-kidville-sub">{t('vuotoDescrizione')}</p>
        </div>
      )}

      {stato.fase === 'pronto' && stato.schede.length > 0 && (
        <div className="flex flex-col gap-3">
          {stato.schede.map((s) => (
            <SchedaVoto key={chiaveScheda(s)} scheda={s} parentId={parentId ?? ''} onVotazioneChiusa={votazioneChiusa} />
          ))}
        </div>
      )}
    </div>
  )
}
