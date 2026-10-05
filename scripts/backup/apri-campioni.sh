#!/usr/bin/env bash
# «Apri 5 file per bucket» della prova di ripristino dei FILE, senza guardarli.
#
# Roadmap di robustezza, fase 2 (D2). Per ogni bucket di Supabase Storage prende alcuni file dallo
# specchio cifrato su R2, li decifra al volo e li confronta con l'originale:
#   · stessa IMPRONTA sha256 (il contenuto decifrato coincide con quello su Supabase);
#   · FIRMA dei primi byte coerente con l'estensione (`%PDF`, JPEG, PNG, …): un file rotto
#     all'origine avrebbe la stessa impronta e sarebbe comunque inutile.
# I file sono foto di bambini, moduli firmati, documenti 104/PEI: lo script NON li mostra, NON li
# salva, NON stampa i loro nomi (sono uuid, ma identificano il documento di una famiglia). Stampa
# solo il nome del bucket e dei numeri.
#
# VARIABILI
#   SORGENTE     remote rclone dei file veri (default `SB:`, Supabase Storage)
#   SPECCHIO     remote rclone dello specchio decifrato (default `CRIPTO:corrente`)
#   PER_BUCKET   quanti file provare per bucket (default 5; se il bucket ne ha meno, tutti)
#
# Servono le credenziali di entrambi i remote come variabili `RCLONE_CONFIG_*` (vedi il runbook):
# la password di `rclone crypt` e il token R2 di LETTURA. Esce con errore se un solo file è diverso,
# ha la firma sbagliata o non si riesce a leggere.
#
# Compatibile con bash 3.2 (il Mac).

set -euo pipefail

errore() {
  echo "ERRORE: $*" >&2
  exit "${CODICE:-1}"
}

SORGENTE="${SORGENTE:-SB:}"
SPECCHIO="${SPECCHIO:-CRIPTO:corrente}"
PER_BUCKET="${PER_BUCKET:-5}"
case "$PER_BUCKET" in '' | *[!0-9]*) errore "PER_BUCKET deve essere un numero" ;; esac

T="$(mktemp -d "${TMPDIR:-/tmp}/apri-campioni.XXXXXX")"
trap 'rm -rf "$T"' EXIT

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}

# 0 = firma giusta, 1 = firma sbagliata, 2 = estensione che non si sa verificare
controlla_firma() { # estensione, esadecimale dei primi byte
  case "$1" in
    pdf) [[ "$2" == 25504446* ]] ;;
    jpg | jpeg) [[ "$2" == ffd8ff* ]] ;;
    png) [[ "$2" == 89504e47* ]] ;;
    webp) [[ "$2" == 52494646* ]] ;;
    mp4 | mov | m4v | heic) [[ "${2:8:8}" == 66747970 ]] ;;
    *) return 2 ;;
  esac
}

TOT_PROVATI=0
TOT_IDENTICI=0
TOT_DIVERSI=0
TOT_FIRMA=0
TOT_NON_LEGGIBILI=0
TOT_NON_VERIFICABILI=0

rclone lsf "$SORGENTE" --dirs-only > "$T/bucket.txt" || errore "non riesco a elencare i bucket di $SORGENTE"

while IFS= read -r riga; do
  b="${riga%/}"
  [ -n "$b" ] || continue

  rclone lsf "${SORGENTE}${b}" -R --files-only > "$T/file.txt" 2>/dev/null || : > "$T/file.txt"
  sort -R "$T/file.txt" | head -n "$PER_BUCKET" > "$T/scelti.txt"

  PROVATI=0; IDENTICI=0; DIVERSI=0; FIRMA_ERRATA=0; NON_LEGGIBILI=0; NON_VERIFICABILI=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    PROVATI=$((PROVATI + 1))
    ORIG="${SORGENTE}${b}/${f}"
    COPIA="${SPECCHIO}/${b}/${f}"

    if ! H_ORIG="$(rclone cat "$ORIG" | sha)" || ! H_COPIA="$(rclone cat "$COPIA" | sha)"; then
      NON_LEGGIBILI=$((NON_LEGGIBILI + 1))
      continue
    fi
    if [ "$H_ORIG" = "$H_COPIA" ]; then
      IDENTICI=$((IDENTICI + 1))
    else
      DIVERSI=$((DIVERSI + 1))
    fi

    ESTENSIONE="$(printf '%s' "${f##*.}" | tr 'A-Z' 'a-z')"
    PRIMI_BYTE="$(rclone cat "$COPIA" --count 16 | od -An -tx1 | tr -d ' \n')"
    FIRMA_OK=1
    set +e
    controlla_firma "$ESTENSIONE" "$PRIMI_BYTE"
    ESITO_FIRMA=$?
    set -e
    if [ "$ESITO_FIRMA" -eq 2 ]; then
      NON_VERIFICABILI=$((NON_VERIFICABILI + 1))
    elif [ "$ESITO_FIRMA" -ne 0 ]; then
      FIRMA_OK=0
    fi
    if [ "$FIRMA_OK" = "1" ]; then :; else FIRMA_ERRATA=$((FIRMA_ERRATA + 1)); fi
  done < "$T/scelti.txt"

  echo "CAMPIONE bucket=$b provati=$PROVATI identici=$IDENTICI diversi=$DIVERSI firma_errata=$FIRMA_ERRATA non_leggibili=$NON_LEGGIBILI firma_non_verificabile=$NON_VERIFICABILI"
  TOT_PROVATI=$((TOT_PROVATI + PROVATI))
  TOT_IDENTICI=$((TOT_IDENTICI + IDENTICI))
  TOT_DIVERSI=$((TOT_DIVERSI + DIVERSI))
  TOT_FIRMA=$((TOT_FIRMA + FIRMA_ERRATA))
  TOT_NON_LEGGIBILI=$((TOT_NON_LEGGIBILI + NON_LEGGIBILI))
  TOT_NON_VERIFICABILI=$((TOT_NON_VERIFICABILI + NON_VERIFICABILI))
done < "$T/bucket.txt"

echo "RISULTATO provati=$TOT_PROVATI identici=$TOT_IDENTICI diversi=$TOT_DIVERSI firma_errata=$TOT_FIRMA non_leggibili=$TOT_NON_LEGGIBILI firma_non_verificabile=$TOT_NON_VERIFICABILI"

[ "$TOT_PROVATI" -gt 0 ] || errore "nessun file provato: lo specchio o la sorgente sono vuoti?"
if [ "$TOT_DIVERSI" -ne 0 ] || [ "$TOT_FIRMA" -ne 0 ] || [ "$TOT_NON_LEGGIBILI" -ne 0 ]; then
  errore "alcuni file non coincidono (diversi=$TOT_DIVERSI, firma errata=$TOT_FIRMA, non leggibili=$TOT_NON_LEGGIBILI)"
fi
echo "OK: $TOT_PROVATI file aperti, tutti identici all'originale e con la firma giusta."
