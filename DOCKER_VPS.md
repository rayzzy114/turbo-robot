# Docker deploy on VPS

## 0. Fast update + relaunch (copy/paste)
```bash
bash vps_redeploy.sh
```

## 1. Prepare environment
1. Copy `.env.example` to `.env`.
2. Fill required variables in `.env` (`BOT_TOKEN`, `ADMIN_TELEGRAM_ID`, admin credentials, optional Crypto Pay vars).
3. On a clean VPS, install Docker first:
```bash
bash setup_vps.sh
```

## 2. Build and run (bot + admin)
Preferred (Docker Compose plugin):
```bash
docker compose up -d --build
```

Fallback (legacy binary):
```bash
docker-compose up -d --build
```

## 3. Check status and logs
```bash
docker compose ps
docker compose logs -f playable-bot playable-admin
```

Fallback:
```bash
docker-compose ps
docker-compose logs -f playable-bot playable-admin
```

## 4. Update after repository changes
Preferred:
```bash
git pull
docker compose down
docker compose up -d --build --remove-orphans
docker compose ps
docker compose logs --tail=120 playable-bot playable-admin
```

Fallback:
```bash
git pull
docker-compose down
docker-compose up -d --build --remove-orphans
docker-compose ps
docker-compose logs --tail=120 playable-bot playable-admin
```

## 4.1 One-command updater script on VPS (`update.sh`)
Create once on VPS:
```bash
cat > /root/turbo-robot/update.sh << 'EOF'
#!/usr/bin/env bash
set -euo pipefail

cd /root/turbo-robot
echo "[1/5] Fetch..."
git fetch origin main

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[2/5] No changes in main. Nothing to deploy."
  exit 0
fi

echo "[2/5] Updating to origin/main..."
git reset --hard origin/main

echo "[3/5] Rebuild + restart containers..."
docker compose up -d --build

echo "[4/5] Cleanup old images..."
docker image prune -f >/dev/null || true

echo "[5/5] Done."
docker compose ps
EOF

chmod +x /root/turbo-robot/update.sh
```

Run updates anytime:
```bash
/root/turbo-robot/update.sh
```

## 5. Stop
```bash
docker compose down
```

## Notes
- Bot works in polling mode, so no public HTTP port is required.
- Admin panel is available on `http://<VPS_IP>:3001`.
- Persistent data is stored in named volumes:
  - `bot_data` (`/app/data`)
  - `bot_sessions` (`/app/sessions`)
  - `bot_previews` (`/app/previews`)
  - `bot_temp` (`/app/temp`)
  - `bot_logs` (`/app/logs`)
