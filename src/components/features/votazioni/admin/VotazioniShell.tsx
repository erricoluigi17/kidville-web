'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Info, Plus } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco'
import { DettaglioVotazione } from './DettaglioVotazione'
import { ElencoVotazioni } from './ElencoVotazioni'
import { NuovaVotazioneForm } from './NuovaVotazioneForm'
import { leggiElenco, type LetturaElenco } from './chiamate'

/**
 * VOTAZIONI · LA SCHERMATA DELLA SEGRETERIA.
 *
 * L'elenco delle votazioni della sede, il comando «Nuova votazione» (un modulo in una finestra) e il dettaglio
 * di una votazione in un pannello laterale. La sede è UNA e arriva da `SedeRequired` (la pagina): qui non si
 * sceglie, e ogni richiesta la dichiara.
 *
 * ── UN SOLO «NUOVA VOTAZIONE» ───────────────────────────────────────────────────────
 * Il comando compare in UN punto per volta: nella barra sopra l'elenco quando l'elenco c'è, dentro lo stato
 * vuoto quando non c'è niente. Mai insieme (due pulsanti con lo stesso nome sono due bersagli per la tastiera e
 * per i test), e mai quando l'elenco non si è letto (errore) o le votazioni non sono disponibili: lì «Nuova
 * votazione» promette un'azione che poi non può compiere.
 *
 * ── L'INDIRIZZO ─────────────────────────────────────────────────────────────────────
 * `?id=<uuid>` apre il pannello su quella votazione. La verità è lo stato di React e l'indirizzo la insegue con
 * `history.replaceState` (come `CrmShell`): se cambia da fuori, lo stato lo segue (`parametroVisto`, adattamento
 * durante il render). Un valore che non è un uuid si ignora: finirebbe dritto in un percorso API. Il
 * `useSearchParams` vuole un `Suspense` sopra, che sta nella pagina.
 *
 * ── RILEGGERE L'ELENCO ──────────────────────────────────────────────────────────────
 * Dopo una creazione, una chiusura, una proroga o un'eliminazione l'elenco si rilegge SENZA svuotarsi (si
 * incrementa `tentativo` e i dati vecchi restano a schermo finché arrivano i nuovi): chi guarda il pannello non
 * deve vedere la lista sparire e ricomparire sotto. «Riprova» invece svuota, perché l'errore era lo stato.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function idDaParametro(valore: string | null): string | null {
  return valore !== null && UUID.test(valore) ? valore : null
}

function scriviId(id: string | null): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('id', id)
  else url.searchParams.delete('id')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

type Elenco = { per: string; lettura: LetturaElenco }

export function VotazioniShell({ scuolaId }: { scuolaId: string }) {
  const t = useTranslations('votazioniAdmin')
  const ts = useTranslations('shared')
  const ricerca = useSearchParams()
  const parametro = idDaParametro(ricerca.get('id'))

  const [aperta, setAperta] = useState<string | null>(parametro)
  // L'indirizzo è cambiato da fuori: lo stato lo segue. Si confronta durante il render (e non in un effetto)
  // perché è il modo documentato di adattare lo stato a un valore che cambia.
  const [parametroVisto, setParametroVisto] = useState(parametro)
  if (parametro !== parametroVisto) {
    setParametroVisto(parametro)
    setAperta(parametro)
  }

  const [formAperto, setFormAperto] = useState(false)

  const [elenco, setElenco] = useState<Elenco | null>(null)
  const [tentativo, setTentativo] = useState(0)
  useEffect(() => {
    let vivo = true
    void leggiElenco(scuolaId).then((lettura) => {
      if (vivo) setElenco({ per: scuolaId, lettura })
    })
    return () => {
      vivo = false
    }
  }, [scuolaId, tentativo])
  const corrente = elenco?.per === scuolaId ? elenco.lettura : null

  const ricarica = () => setTentativo((n) => n + 1)
  const riprova = () => {
    setElenco(null)
    ricarica()
  }

  const apri = (id: string) => {
    setAperta(id)
    scriviId(id)
  }
  const chiudiDettaglio = () => {
    setAperta(null)
    scriviId(null)
  }

  const bottoneNuova = (
    <Btn onClick={() => setFormAperto(true)}>
      <Plus size={16} aria-hidden="true" />
      {t('nuovaVotazione')}
    </Btn>
  )

  const testi = {
    ...testiStatoElenco(ts),
    vuotoTitolo: t('elencoVuotoTitolo'),
    vuotoCorpo: t('elencoVuotoCorpo'),
  }

  let contenuto: React.ReactNode
  if (corrente === null) {
    contenuto = <StatoElenco stato="caricamento" testi={testi} />
  } else if (corrente.esito === 'errore') {
    contenuto = <StatoElenco stato="errore" testi={testi} onRiprova={riprova} />
  } else if (!corrente.disponibile) {
    contenuto = (
      <div role="status" className="flex flex-col items-center gap-2 py-12 text-center">
        <Info size={34} aria-hidden="true" className="text-kidville-neutral" />
        <p className="font-barlow text-lg font-extrabold uppercase text-kidville-green">{t('nonDisponibiliTitolo')}</p>
        <p className="max-w-md font-maven text-sm text-kidville-sub">{t('nonDisponibiliCorpo')}</p>
      </div>
    )
  } else if (corrente.votazioni.length === 0) {
    contenuto = <StatoElenco stato="vuoto" testi={testi} azione={bottoneNuova} />
  } else {
    contenuto = (
      <div className="space-y-4">
        <div className="flex justify-end">{bottoneNuova}</div>
        <ElencoVotazioni votazioni={corrente.votazioni} onApri={apri} />
      </div>
    )
  }

  return (
    <>
      {contenuto}

      {formAperto && (
        <NuovaVotazioneForm
          scuolaId={scuolaId}
          onAnnulla={() => setFormAperto(false)}
          onCreata={(id) => {
            setFormAperto(false)
            ricarica()
            // Si apre subito la votazione appena creata: è ciò che la segreteria vuole controllare.
            if (id) apri(id)
          }}
        />
      )}

      {aperta && (
        <DettaglioVotazione
          votazioneId={aperta}
          onChiudi={chiudiDettaglio}
          onCambiata={ricarica}
          onEliminata={() => {
            chiudiDettaglio()
            ricarica()
          }}
        />
      )}
    </>
  )
}
