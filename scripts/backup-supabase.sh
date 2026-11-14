#!/usr/bin/env bash
# Back up application schemas/records and encrypt before uploading GitHub artifacts.
# NEVER echo or upload the unencrypted SQL files.
set -Eeuo pipefail
umask 077

if [[ -z "${SUPABASE_DB_URL:-}" || -z "${TANO_BACKUP_PASSPHRASE:-}" ]]; then
  echo "::error::Missing TANO_BACKUP_DB_URL or TANO_BACKUP_PASSPHRASE repository secrets."
  exit 1
fi
if [[ ${#TANO_BACKUP_PASSPHRASE} -lt 24 ]]; then
  echo "::error::Backup encryption passphrase must contain at least 24 characters."
  exit 1
fi

: "${RUNNER_TEMP:?This script must run in GitHub Actions}"
workdir="$(mktemp -d "${RUNNER_TEMP}/tano-export-XXXXXXXX")"
outdir="${RUNNER_TEMP}/tano-secure-backup"
mkdir -p "$outdir"
chmod 700 "$outdir"
trap 'rm -rf "$workdir"' EXIT
cd "$workdir"

# Supabase CLI deliberately excludes platform-managed schemas such as auth/storage
# from its normal schema dump. Custom roles, application schema, application data.
echo "Exporting database roles..."
supabase db dump --db-url "$SUPABASE_DB_URL" --role-only -f roles.sql
echo "Exporting application schema..."
supabase db dump --db-url "$SUPABASE_DB_URL" -f schema.sql
echo "Exporting application records..."
supabase db dump --db-url "$SUPABASE_DB_URL" --data-only --use-copy \
  -x "storage.buckets_vectors" -x "storage.vector_indexes" -f data.sql

for file in roles.sql schema.sql data.sql; do
  [[ -s "$file" ]] || { echo "::error::Empty backup component: $file"; exit 1; }
done

backup_name="tano-supabase-$(date -u '+%Y%m%dT%H%M%SZ').tar.gz.gpg"
encrypted="$outdir/$backup_name"
# Stream SQL directly into GPG, so no plaintext compressed archive is left on disk.
# Read passphrase via fd 3; never pass it as a command-line argument.
tar -czf - roles.sql schema.sql data.sql | \
  gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
  --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 \
  --output "$encrypted" 3<<<"$TANO_BACKUP_PASSPHRASE"

# Verify ciphertext is decryptable and contains the expected files.
gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
  --decrypt "$encrypted" 3<<<"$TANO_BACKUP_PASSPHRASE" | \
  tar -tzf - | grep -Fxq "data.sql"
sha256sum "$encrypted" > "$encrypted.sha256"
echo "Encrypted backup created and verified. Only encrypted artifacts will be uploaded."
