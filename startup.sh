#!/bin/bash
# Install fonts for sharp/SVG rendering on Azure App Service Linux
echo "Installing fonts for text rendering..."
apt-get update 2>/dev/null
apt-get install -y fontconfig fonts-dejavu-core fonts-dejavu fonts-liberation fonts-freefont-ttf --no-install-recommends 2>/dev/null || true

# Rebuild font cache
echo "Rebuilding font cache..."
fc-cache -f 2>/dev/null || true

# List available fonts (for debugging)
echo "Available fonts:"
fc-list 2>/dev/null | head -5 || echo "fc-list not available"

# Start the app
echo "Starting Node.js application..."
node src/index.js
