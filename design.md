# Kidville Web App - Design System

Questo documento definisce le linee guida visive e di design per il registro elettronico di Kidville, assicurando una perfetta continuità stilistica con il sito web ufficiale (www.kidville.it). L'obiettivo è creare un "ecosistema omogeneo" in cui l'utente percepisca la stessa identità visiva su tutte le piattaforme.

## 🎨 Palette Colori

La palette si basa su contrasti forti ma accoglienti, adatti a un ambiente educativo infantile ma professionale.

### Colori Primari
| Nome | Hex | Utilizzo Principale |
| :--- | :--- | :--- |
| **Kidville Green** | `#006A5F` | Sfondo di navbar/header, pulsanti principali, icone, testo del corpo, sfondi scuri. |
| **Kidville Yellow** | `#FDC400` | Titoli di grande impatto (spesso su sfondo verde), accenti, icone, pulsanti secondari, badge. |

### Colori Secondari / Sfondo
| Nome | Hex | Utilizzo Principale |
| :--- | :--- | :--- |
| **Soft Cream** | `#FEF1E4` | Sfondo principale dell'applicazione e delle aree di contenuto. Crea un ambiente visivo caldo, rilassante e meno "clinico" del bianco puro. |
| **Pure White** | `#FFFFFF` | Sfondo per card, moduli form, modali o sezioni isolate per far risaltare i contenuti sul fondo panna. |
| **Error Red** | `#E53935` | (Standard) Messaggi di errore, badge eliminazione. |
| **Success Green**| `#43A047` | (Standard) Conferme, stati di completamento. |

---

## 🔤 Tipografia

La tipografia gioca un ruolo fondamentale per riprendere lo stile del sito.
Si consiglia di importare questi font da Google Fonts.

### Titoli (Headings)
- **Font Family:** `Barlow Condensed`, sans-serif
- **Stile:** Spesso utilizzato in **TUTTO MAIUSCOLO** (uppercase) per i titoli principali.
- **Pesi (Weights):** 600 (Semi-bold), 800 (Extra-bold), 900 (Black).
- **Utilizzo:** H1, H2, H3, titoli delle card, call to action molto grandi.

### Corpo del Testo (Body)
- **Font Family:** `Maven Pro`, sans-serif
- **Pesi (Weights):** 400 (Regular), 500 (Medium).
- **Dimensione Base:** `16px`
- **Interlinea (Line Height):** `1.5` (o `24px`) per la leggibilità del corpo, `1.2` per blocchi più stretti.
- **Colore:** Prevalentemente `#006A5F` (Verde Primario) su sfondi chiari, al posto del classico nero/grigio scuro, per rafforzare l'identità del brand.

---

## 🧱 Componenti UI

Il design di Kidville è caratterizzato da forme arrotondate ("child-friendly") e uno stile "flat" moderno senza eccessive ombreggiature.

### Pulsanti (Buttons)
Tutti i pulsanti seguono uno stile "Pill" (completamente arrotondati ai lati).

- **Border Radius:** `20px` o `9999px` (fully rounded / pill).
- **Ombre:** Assenti (Flat design).
- **Variante Primaria (Su sfondo chiaro):** Sfondo Verde (`#006A5F`), Testo Giallo (`#FDC400`) o Testo Bianco (`#FFFFFF`).
- **Variante Secondaria (Su sfondo verde):** Sfondo Giallo (`#FDC400`), Testo Verde (`#006A5F`).
- **Hover States:** Leggera variazione di opacità (es. `opacity-90`) o leggero scurimento del colore di sfondo.

### Card e Contenitori
- **Border Radius:** `12px` o `16px` (angoli dolcemente arrotondati, ma meno dei bottoni).
- **Sfondo:** Bianco puro (`#FFFFFF`) per risaltare sullo sfondo crema (`#FEF1E4`).
- **Bordi:** Nessun bordo o bordo sottile tono su tono (es. Verde molto chiaro o grigio chiaro).
- **Ombre:** Molto leggere e diffuse (es. `box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05)`), in quanto il brand predilige il flat design.

### Moduli (Forms) / Input
- **Stile Input:** Sfondo bianco o grigio chiarissimo.
- **Border Radius:** `8px` o `12px`.
- **Bordi:** Sottile bordo verde primario (`#006A5F`) al focus, grigio chiaro a riposo.
- **Testo interno:** `Maven Pro`, colore verde scuro (`#006A5F`).

---

## 🧭 Layout e Struttura

1. **Header / Navbar / Topbar:** 
   - Sfondo: Verde Primario (`#006A5F`).
   - Testo/Logo: Bianco o Giallo Primario.
   - Link di scelta rapida: Pulsanti "pill" gialli.
2. **Main Layout:**
   - Si raccomanda l'uso di contenitori larghi o layout a banda orizzontale alternando sfondi Soft Cream e Pure White.
3. **Sidebar (per il Registro Elettronico):**
   - Sfondo: Soft Cream (`#FEF1E4`) o Verde Primario (`#006A5F`) a seconda della gerarchia desiderata. I link attivi possono avere uno sfondo bianco con testo verde.
4. **Spaziature (Spacing):**
   - Ampi spazi "respirabili" (padding generosi) tra le sezioni per un look pulito e non affollato.

---

## 💻 Integrazione Tailwind CSS

Esempio di estensione della configurazione per Tailwind in `tailwind.config.ts`:

```typescript
import type { Config } from "tailwindcss";

const config: Config = {
  theme: {
    extend: {
      colors: {
        kidville: {
          green: '#006A5F',
          yellow: '#FDC400',
          cream: '#FEF1E4',
          white: '#FFFFFF',
        }
      },
      fontFamily: {
        barlow: ['"Barlow Condensed"', 'sans-serif'],
        maven: ['"Maven Pro"', 'sans-serif'],
      },
      borderRadius: {
        'pill': '9999px',
        'card': '16px',
      }
    }
  }
};
export default config;
```

---
*Questo file serve da "Sorgente di Verità" per tutto lo sviluppo UI del nuovo registro elettronico.*
