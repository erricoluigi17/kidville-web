# 50 — Registro presenze mensile firmabile

**Compila** l'app, dalle presenze già registrate · **Firma** insegnante di sezione + Direzione
**Archivia** `student_documents.document_type = 'registro_presenze'` (per sede e mese, non per alunno)
**Stato** 🔶 la tabella esiste già — `src/components/features/teacher/attendance/MonthlyAttendanceTable.tsx`

---

## Cosa c'è già

L'insegnante vede la griglia del mese — alunni in riga, giorni in colonna, riepilogo P/A/R in coda
— ed esporta un PDF orizzontale. La logica è già corretta nei punti in cui è facile sbagliare: i
giorni futuri non contano, e il conteggio distingue l'assenza vera dal giorno non ancora arrivato.

## Cosa manca perché diventi un registro

Un registro non è una stampa: è un documento che qualcuno firma e di cui si risponde. Quattro
aggiunte.

**1. L'intestazione formale.**

> **REGISTRO DELLE PRESENZE**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
> Sede: `{{sede.nome}}` · Sezione: `{{sezione.nome}}` · Livello: `{{sezione.livello}}`
> Mese: `{{mese}}` `{{anno}}` · Anno scolastico: `{{anno_scolastico}}`
> Codice meccanografico: `{{sede.codice_meccanografico}}`

**2. Il riepilogo che serve a rendicontare.**

> Bambini iscritti nel mese: `{{totale_iscritti}}`
> Giorni di attività didattica: `{{giorni_apertura}}`
> Presenze totali: `{{presenze_totali}}` · Assenze: `{{assenze_totali}}`
> Media giornaliera di frequenza: `{{media_giornaliera}}`
> Bambini con frequenza superiore al 50% dei giorni: `{{sopra_meta}}`

Sono i numeri che chiedono i fondi — voucher comunale 0-3, PON, PNRR, SIEI — e che oggi si
ricontano a mano dalla griglia.

**3. Le due firme.**

> Chiuso il `{{chiusura.data}}`
> L'insegnante di sezione: `{{sezione.insegnante}}` — *firmato il {{firma.timestamp}}*
> La Direzione: `{{direzione.nome}}` — *firmato il {{controfirma.timestamp}}*

**4. La chiusura del mese.** Finché il mese è aperto le presenze si correggono. Alla chiusura il
registro si congela: il PDF diventa immutabile e le correzioni successive sono **rettifiche
tracciate**, con motivo e autore, non modifiche silenziose del passato.

È lo stesso principio già applicato alle ricevute — una volta emesse non si riscrivono, si stornano —
e vale per la stessa ragione: un documento che rendiconta denaro pubblico deve essere lo stesso
documento anche fra due anni.

## Le entrate e le uscite fuori orario

Il registro riporta P/A/R. I permessi firmati con il
[09 — entrata posticipata / uscita anticipata](09-permesso-entrata-uscita.md) vanno segnati in
colonna con un simbolo distinto: un bambino uscito alle 12 non è assente, ma non ha fatto la
giornata intera, e per la rendicontazione a ore la differenza conta.

## Dopo la chiusura

1. PDF in `student_documents` con `student_id = null` e riferimento a sede + sezione + mese: è un
   documento di sezione, non di un bambino.
2. Esportabile in blocco per anno, per la rendicontazione di un fondo.
3. Se al giorno 5 del mese successivo un registro non è chiuso, promemoria alla Direzione. I
   registri non chiusi si accorgono a giugno, quando serve rendicontare, e a quel punto nessuno
   ricorda più chi c'era il 14 novembre.
