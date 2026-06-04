#!/usr/bin/env bash
#
# This script is intended for appending the configuration values for livekit.
# Please run this script from the project directory like so:
# ./migrations/20260218-voice-config.sh your.domain

# Append the new web environment variables to the .env.web
echo "Adding new environment variables to .env.web for new web app..."
echo "VITE_API_URL=https://$1/api" >> .env.web
echo "VITE_WS_URL=wss://$1/ws" >> .env.web
echo "VITE_MEDIA_URL=https://$1/autumn" >> .env.web
echo "VITE_PROXY_URL=https://$1/january" >> .env.web

# Append the hosts.livekit configuration
echo "Adding livekit worldwide host to Syrnike.toml..."
echo "" >> Syrnike.toml
echo "[hosts.livekit]" >> Syrnike.toml
echo "worldwide = \"wss://$1/livekit\"" >> Syrnike.toml

# Create livekit key and secret
livekit_key=$(openssl rand -hex 6)
livekit_secret=$(openssl rand -hex 24)

# Append keys and webhook to livekit.yml
echo "Adding livekit key and webhook configuration to livekit.yml..."
echo "" >> livekit.yml
echo "keys:" >> livekit.yml
echo "  $livekit_key: $livekit_secret" >> livekit.yml
echo "" >> livekit.yml
echo "webhook:" >> livekit.yml
echo "  api_key: $livekit_key" >> livekit.yml
echo "  urls:" >> livekit.yml
echo "  - \"http://voice-ingress:8500/worldwide\"" >> livekit.yml

# Append livekit node configuration to Syrnike.toml
echo "Adding livekit node configuration to Syrnike.toml..."
echo "" >> Syrnike.toml
echo "[api.livekit.nodes.worldwide]" >> Syrnike.toml
echo "url = \"http://livekit:7880\"" >> Syrnike.toml
echo "lat = 0.0" >> Syrnike.toml
echo "lon = 0.0" >> Syrnike.toml
echo "key = \"$livekit_key\"" >> Syrnike.toml
echo "secret = \"$livekit_secret\"" >> Syrnike.toml

echo "Done! <3"