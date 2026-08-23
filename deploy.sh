#!/usr/bin/env bash

# ==============================================================================
# CAF Orchestrator - Deployment Script
# ==============================================================================
# Pulls latest code, rebuilds the docker image, and restarts services
# (redis, api, worker) via docker compose. Intended for use both manually
# on the VPS and from the GitHub Actions deploy workflow.
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info() { echo -e "${BLUE}${BOLD}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}${BOLD}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}${BOLD}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}${BOLD}[ERROR]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

SKIP_PULL=false
SKIP_BUILD=false
NO_CACHE=false

show_usage() {
  echo "Usage: $0 [options]"
  echo ""
  echo "Options:"
  echo "  --skip-pull        Skip 'git fetch' + reset to origin/main"
  echo "  --skip-build       Skip 'docker compose build' (just restart with existing image)"
  echo "  --no-cache         Build image with --no-cache"
  echo "  --env <path>       Path to .env file (default: $ENV_FILE)"
  echo "  -h, --help         Show this help message"
  echo ""
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-pull) SKIP_PULL=true; shift ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --no-cache) NO_CACHE=true; shift ;;
    --env) ENV_FILE="$2"; shift 2 ;;
    -h|--help) show_usage; exit 0 ;;
    *) log_error "Unknown option: $1"; show_usage; exit 1 ;;
  esac
done

cd "$SCRIPT_DIR"

log_info "=== CAF Orchestrator Deployment ==="
log_info "Working directory: $SCRIPT_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  log_error ".env file not found at $ENV_FILE"
  exit 1
fi

if [[ "$SKIP_PULL" == false ]]; then
  log_info "Fetching latest changes from Git..."
  git fetch --all
  git reset --hard origin/main
  log_success "Repository updated to $(git rev-parse --short HEAD)"
else
  log_warn "Skipping git pull (--skip-pull)"
fi

if [[ "$SKIP_BUILD" == false ]]; then
  log_info "Building docker image..."
  if [[ "$NO_CACHE" == true ]]; then
    docker compose build --no-cache
  else
    docker compose build
  fi
  log_success "Image built"
else
  log_warn "Skipping build (--skip-build)"
fi

log_info "Restarting services..."
docker compose up -d

log_info "Pruning dangling images..."
docker image prune -f

log_info "Service status:"
docker compose ps

log_success "=== Deployment complete ==="
