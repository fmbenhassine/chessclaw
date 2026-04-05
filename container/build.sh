#!/bin/bash
# Build the ChessClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

IMAGE_NAME="chessclaw-agent"
TAG="${1:-latest}"

echo "Building ChessClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build with Apple Container using the repo root as context so backend/assets are available
container build -t "${IMAGE_NAME}:${TAG}" -f container/Dockerfile .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"chatJid\":\"tg:123456789\"}' | container run -i ${IMAGE_NAME}:${TAG}"
