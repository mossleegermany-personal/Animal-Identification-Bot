#!/bin/bash
# Install fonts for sharp/SVG rendering on Azure App Service Linux
apt-get update && apt-get install -y fontconfig fonts-dejavu-core fonts-liberation --no-install-recommends
fc-cache -f -v
# Start the app
node src/index.js
