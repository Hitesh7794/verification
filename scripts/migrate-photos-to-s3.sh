#!/usr/bin/env bash
#
# One-shot: mirror every enrolled photo currently on the local disk
# under /opt/verificationportal/data/uploaded/<exam_id>/photo/ into the
# S3 bucket at s3://<bucket>/<EXAM_CODE>/photos/, keyed the way the
# runtime expects. Idempotent — re-running skips files that already
# match (aws s3 sync semantics).
#
# Does NOT delete the local copies. Once you've flipped PHOTOS_BACKEND
# to s3, verified face-match works, and let it bake for a few days,
# run scripts/migrate-photos-to-s3.sh --purge to drop the local files.
#
# Usage on prod:
#   sudo bash /opt/verificationportal/scripts/migrate-photos-to-s3.sh --dry-run
#   sudo bash /opt/verificationportal/scripts/migrate-photos-to-s3.sh
#   sudo bash /opt/verificationportal/scripts/migrate-photos-to-s3.sh --purge   # after verification bake-in

set -euo pipefail

BUCKET="${S3_BUCKET:-trustview-verification-portal}"
REGION="${S3_REGION:-ap-south-1}"
DATA_DIR="${DATA_DIR:-/opt/verificationportal/data}"
DB="${PGDATABASE:-verification}"

DRY_RUN=0
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --purge)   PURGE=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "bucket=$BUCKET region=$REGION data_dir=$DATA_DIR dry_run=$DRY_RUN purge=$PURGE"
echo

# Pull (exam_id, exam_code) pairs. Uses sudo -u postgres so it works
# without a DB password baked in.
mapfile -t exams < <(
  sudo -u postgres psql -d "$DB" -tAF ' ' \
    -c "SELECT id, exam_code FROM exams ORDER BY id;"
)

if [ ${#exams[@]} -eq 0 ]; then
  echo "no exams in DB — nothing to do"
  exit 0
fi

total_synced=0
total_purged=0
for row in "${exams[@]}"; do
  eid="${row%% *}"
  ecode="${row#* }"
  src="$DATA_DIR/uploaded/$eid/photo"

  if [ ! -d "$src" ]; then
    echo "exam=$ecode id=$eid — no local photos dir ($src) — skip"
    continue
  fi

  n=$(find "$src" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | wc -l | tr -d ' ')
  if [ "$n" = "0" ]; then
    echo "exam=$ecode id=$eid — dir exists but empty — skip"
    continue
  fi

  dst="s3://$BUCKET/$ecode/photos/"
  echo "exam=$ecode id=$eid src=$src → $dst  ($n files)"

  if [ "$DRY_RUN" = "1" ]; then
    aws s3 sync "$src/" "$dst" --region "$REGION" --dryrun \
      --exclude '*' --include '*.jpg' --include '*.jpeg' --include '*.png' \
      --size-only || true
  else
    aws s3 sync "$src/" "$dst" --region "$REGION" \
      --exclude '*' --include '*.jpg' --include '*.jpeg' --include '*.png' \
      --size-only
    total_synced=$((total_synced + n))
    if [ "$PURGE" = "1" ]; then
      # Only purge files we can verify are in S3. Do it per-file
      # rather than rm -rf to be extra careful.
      while IFS= read -r f; do
        base="$(basename "$f")"
        # Extract the roll (filename without extension) — that's the S3 key.
        roll="${base%.*}"
        s3key="$ecode/photos/${roll}.jpg"
        if aws s3api head-object --bucket "$BUCKET" --key "$s3key" \
             --region "$REGION" >/dev/null 2>&1; then
          rm -f -- "$f"
          total_purged=$((total_purged + 1))
        else
          echo "  keep $f — no matching S3 object at s3://$BUCKET/$s3key"
        fi
      done < <(find "$src" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \))
    fi
  fi
done

echo
echo "done. synced_files=$total_synced purged_files=$total_purged"
if [ "$DRY_RUN" = "1" ]; then
  echo "(dry-run — nothing was uploaded or deleted)"
fi
