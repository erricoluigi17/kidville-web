# 46 — Certificato delle competenze

**Genera** l'insegnante, valida la Direzione · **Firma** legale rappresentante
**Archivia** `student_documents.document_type = 'certificato_competenze'`
**Stato** ✅ già in produzione — `src/lib/competenze/certificato-pdf.ts` e `certificato-store.ts`

---

## Cos'è già

Il modello è quello del **D.M. 14/2024**: tabella delle 8 competenze chiave europee × livello
A/B/C/D, con legenda, più la sezione «competenze significative» in coda. Il PDF si genera dal
modello in `src/lib/competenze/modello.ts` (`LIVELLI`, `livelloEtichetta`), e l'indicatore di
sincronizzazione SIDI è già previsto dalla fase P5.

Nell'archivio cartaceo **non esiste** un equivalente: è nato digitale, ed è l'unico dei
diciassette in questa condizione.

## Cosa manca

**1. Il protocollo.** Il certificato delle competenze esce dalla scuola e accompagna il bambino
alla scuola successiva: va protocollato in uscita come gli altri certificati, oggi non lo è.

**2. La firma del legale rappresentante nel PDF.** Il documento è generabile ma non porta la firma
e il timbro che portano il certificato di iscrizione e il nulla osta. Passando dal motore comune
(`documento-pdf.ts`) la eredita.

**3. La consegna al genitore.** Il certificato si genera e resta in app. Va consegnato: PDF nel
fascicolo del bambino, visibile in `/parent`, notificato quando è pronto — come il documento di
valutazione.

**4. La trasmissione SIDI** resta subordinata all'accreditamento ministeriale, e non cambia con
questo lavoro.

## Il legame con il documento di valutazione dell'infanzia

Il certificato delle competenze si rilascia **all'uscita** dal ciclo. Il
[45 — documento di valutazione dell'infanzia](45-documento-valutazione-infanzia.md), che è nuovo,
accompagna invece il bambino durante i tre anni.

I due documenti condividono l'impianto — campi di esperienza, traguardi, livelli — e vanno scritti
in modo che il secondo alimenti il primo: alla fine del terzo anno, il certificato delle competenze
non dovrebbe partire da un foglio bianco.
