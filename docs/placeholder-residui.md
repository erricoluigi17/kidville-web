# Placeholder residui — censimento M7.6

Verifica del piano (`docs/piano-app-100.md`, step M7.6):

```
grep -rn "in arrivo" src --include='*.tsx'   → VUOTO (2026-07-03)
```

Tutti i placeholder funzionali "in arrivo" (toast/badge su feature promesse e
poi costruite: ricerca globale, centro notifiche, presenze realtime, agenda,
umore, locker, ecc.) sono stati sostituiti da implementazioni reali in M5–M7.

## Legittimi documentati (badge "In arrivo" maiuscolo, non funzionali)

Restano 4 voci di menu del design DR **senza rotta reale nell'app**: sono gap
di prodotto dichiarati (non feature promesse dal piano M0–M10), rese NON
navigabili con badge "In arrivo" e `aria-disabled` — comportamento onesto
deciso nel porting del design (vedi commenti nei file):

| File | Voce | Perché resta |
| --- | --- | --- |
| `src/components/features/parent/BottomNav.tsx` | Profilo e deleghe | Nessuna pagina profilo/deleghe genitore nel piano |
| `src/components/features/teacher/TeacherBottomNav.tsx` | Mensa | Nessuna rotta `/teacher/mensa` (la mensa docente non è nel piano) |
| `src/components/features/teacher/TeacherBottomNav.tsx` | Calendario | L'agenda docente (M6) vive nella home `/teacher`, nessuna rotta dedicata |
| `src/components/features/teacher/TeacherBottomNav.tsx` | Profilo | Nessuna pagina account docente nel piano |

Se una di queste rotte verrà costruita, rimuovere `soon: true` e valorizzare
`href` nella voce corrispondente.
