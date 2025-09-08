#!/bin/bash
set -e

REPO_PATH="/home/root/SkyFunnel-warmup-service"
DOCKER_COMPOSE_FILE="$REPO_PATH/docker-compose.yml"

if [ -f "$DOCKER_COMPOSE_FILE" ]; then
    echo "🚀 Starting services with docker-compose..."
    docker compose -f "$DOCKER_COMPOSE_FILE" down --remove-orphans
    docker compose -f "$DOCKER_COMPOSE_FILE" up -d
else
    echo "❌ docker-compose.yml not found!"
    exit 1
fi

echo "✅ Reload complete!"
