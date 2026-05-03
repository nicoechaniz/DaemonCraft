#!/usr/bin/env bash
set -euo pipefail

# DaemonCraft Development Startup Script
# Phase 0 - Start the Minecraft server and supporting services
# IMPORTANT: This project runs as a systemd user service.
# For normal operations, use: systemctl --user start daemoncraft.service
# This script is kept for ad-hoc / debug use only.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "====================================="
echo "  DaemonCraft Dev Server Launcher"
echo "====================================="
echo ""
echo "WARNING: This project is managed by systemd."
echo "Preferred: systemctl --user start daemoncraft.service"
echo ""
read -p "Continue with direct docker compose? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 0
fi

# Check prerequisites
if ! command -v docker &> /dev/null; then
    echo "ERROR: Docker is not installed or not in PATH"
    exit 1
fi

if ! command -v docker compose &> /dev/null; then
    echo "ERROR: Docker Compose is not installed"
    exit 1
fi

# Ensure .env exists
if [[ ! -f .env ]]; then
    echo "Creating .env from template..."
    cp .env.example .env
    echo "WARNING: Please edit .env and set CF_API_KEY for automatic modpack install"
fi

echo "Starting services..."
docker compose up -d "$@"

echo ""
echo "Services starting. Check logs with:"
echo "  docker compose logs -f minecraft  # Minecraft server (Geyser runs in-process)"
echo "  docker compose logs -f bridge     # Python control plane"
echo ""
echo "Connection info (host mode):"
echo "  Java Edition:    localhost:25565"
echo "  Bedrock Edition: localhost:19132 (UDP, via Geyser plugin)"
echo "  Bot API:         http://localhost:3000"
echo "  Bridge API:      http://localhost:5000"
echo "  Redis:           localhost:6379"
echo ""
echo "VPN connection:"
echo "  Java:     10.10.20.27:25565"
echo "  Bedrock:  10.10.20.27:19132"
echo ""
echo "To stop all services: docker compose down"
