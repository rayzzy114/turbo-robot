#!/usr/bin/env bash
set -euo pipefail

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "Docker Compose is not installed. Install docker compose plugin or docker-compose."
  exit 1
fi

NO_CACHE=0
TARGET="bot"

for arg in "$@"; do
  case "$arg" in
    --no-cache)
      NO_CACHE=1
      ;;
    bot|playable-bot)
      TARGET="bot"
      ;;
    admin|playable-admin)
      TARGET="admin"
      ;;
    all)
      TARGET="all"
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: ./vps_redeploy.sh [bot|admin|all] [--no-cache]"
      exit 1
      ;;
  esac
done

SERVICES=(playable-bot)
if [[ "$TARGET" == "admin" ]]; then
  SERVICES=(playable-admin)
elif [[ "$TARGET" == "all" ]]; then
  SERVICES=(playable-bot playable-admin)
fi

echo "Pulling latest changes..."
git pull --ff-only

echo "Building services: ${SERVICES[*]}"
BUILD_ARGS=(build --pull)
if [[ $NO_CACHE -eq 1 ]]; then
  BUILD_ARGS+=(--no-cache)
fi
"${COMPOSE_CMD[@]}" "${BUILD_ARGS[@]}" "${SERVICES[@]}"

echo "Recreating services: ${SERVICES[*]}"
"${COMPOSE_CMD[@]}" up -d --force-recreate --remove-orphans "${SERVICES[@]}"

echo "Current status:"
"${COMPOSE_CMD[@]}" ps

echo "Recent logs:"
"${COMPOSE_CMD[@]}" logs --tail=120 "${SERVICES[@]}"
