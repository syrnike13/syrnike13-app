#!/usr/bin/env bash

SECRETS_FOUND=0
IS_OVERWRITING=0
DOMAIN=
VIDEO_ENABLED=

usage() {
    echo "Usage: ./generate_config.sh [--overwrite] DOMAIN"
    exit 1
}

loadSecrets() {
    SECRETS_FOUND=1
    set -a && source secrets.env && set +a
}

# Check args to ensure correct usage
# No args is not valid
if [[ $# -eq 1 ]]; then
    if [[ $1 = --* ]]; then
        usage
    fi
    DOMAIN=$1
elif [[ $# -eq 2 ]]; then
    if [[ $1 != --overwrite ]]; then
        usage
    fi
    if [[ $2 = --* ]]; then
        usage
    fi
    DOMAIN=$2
    IS_OVERWRITING=1
else
    usage
fi

if test -f "secrets.env"; then
    loadSecrets
fi

if test -f "Syrnike.toml"; then
    if [[ $IS_OVERWRITING -eq 1 ]]; then
        if [ "$SECRETS_FOUND" -eq "0" ]; then
            echo "Overwrite flag passed, but secrets.env not found. This script will refuse to execute an overwrite without secrets.env."
            echo "If you are absolutely sure you want to overwrite your secrets with new secrets, copy the secrets.env.example file without modifying it's contents using command 'cp secrets.env.example secrets.env'."
            echo "If you do not copy your existing secrets into secrets.env you WILL lose access to ALL of your files store in your syrnike13 instance."
            exit 1
        fi
        echo "Overwriting existing config."
        echo "Renaming Syrnike.toml to Syrnike.toml.old"
        mv Syrnike.toml Syrnike.toml.old
        echo "Renaming livekit.yml to livekit.yml.old"
        mv livekit.yml livekit.yml.old
        echo "Renaming compose.override.yml to compose.override.yml.old"
        mv compose.override.yml compose.override.yml.old
    else
        echo "Existing config found, in caution, this script will refuse to execute if you have existing config."
        if [ "$SECRETS_FOUND" -eq "0" ]; then
            echo "Please configure secrets.env with your existing secrets to prevent losing access to your saved files in your syrnike13 instance. You can see instructions on how to configure it by reading the file secrets.env.example. You can do this by running the command 'cat secrets.env.example'."
            echo "Overwriting your existing config will result in you losing access to all current files stored on your syrnike13 instance unless you copy your old secrets into secrets.env."
        else
            echo "secrets.env found, please ensure it matches what is currently in your Syrnike.toml."
        fi
        echo "This script will back up your old config if you choose to overwrite."
        echo "To overwrite the existing config, run the script again with the --overwrite flag"
        usage
    fi
fi

if [ "$SECRETS_FOUND" -eq "0" ]; then
    cp secrets.env.example secrets.env
    loadSecrets
else
    echo "Checking if secrets file needs to be updated..."
    if [ "${REVOLT__PUSHD__VAPID__PRIVATE_KEY:-}" != "" ] && [ "${SYRNIKE__PUSHD__VAPID__PRIVATE_KEY:-}" = "" ]; then
        SYRNIKE__PUSHD__VAPID__PRIVATE_KEY="$REVOLT__PUSHD__VAPID__PRIVATE_KEY"
    fi
    if [ "${REVOLT__PUSHD__VAPID__PUBLIC_KEY:-}" != "" ] && [ "${SYRNIKE__PUSHD__VAPID__PUBLIC_KEY:-}" = "" ]; then
        SYRNIKE__PUSHD__VAPID__PUBLIC_KEY="$REVOLT__PUSHD__VAPID__PUBLIC_KEY"
    fi
    if [ "${REVOLT__FILES__ENCRYPTION_KEY:-}" != "" ] && [ "${SYRNIKE__FILES__ENCRYPTION_KEY:-}" = "" ]; then
        SYRNIKE__FILES__ENCRYPTION_KEY="$REVOLT__FILES__ENCRYPTION_KEY"
    fi
    if [ "${REVOLT__API__LIVEKIT__NODES__WORLDWIDE__SECRET:-}" != "" ] && [ "${SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET:-}" = "" ]; then
        SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET="$REVOLT__API__LIVEKIT__NODES__WORLDWIDE__SECRET"
    fi
    if [ "${REVOLT__API__LIVEKIT__NODES__WORLDWIDE__KEY:-}" != "" ] && [ "${SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY:-}" = "" ]; then
        SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY="$REVOLT__API__LIVEKIT__NODES__WORLDWIDE__KEY"
    fi

    if [ "${PUSHD_VAPID_PRIVATEKEY:-}" != "" ] || [ "${PUSHD_VAPID_PUBLICKEY:-}" != "" ] || [ "${FILES_ENCRYPTION_KEY:-}" != "" ] || [ "${LIVEKIT_WORLDWIDE_SECRET:-}" != "" ] || [ "${LIVEKIT_WORLDWIDE_KEY:-}" != "" ] || [ "${REVOLT__PUSHD__VAPID__PRIVATE_KEY:-}" != "" ] || [ "${REVOLT__PUSHD__VAPID__PUBLIC_KEY:-}" != "" ] || [ "${REVOLT__FILES__ENCRYPTION_KEY:-}" != "" ] || [ "${REVOLT__API__LIVEKIT__NODES__WORLDWIDE__SECRET:-}" != "" ] || [ "${REVOLT__API__LIVEKIT__NODES__WORLDWIDE__KEY:-}" != "" ]; then
        echo "Old secrets found. Your secrets will be rewritten in the new format. If you have any custom secrets not managed by this file, you will need to convert them to the new format."
        echo "See https://github.com/syrnike13/syrnike13-app"
        echo "Renaming secrets.env to secrets.env.old"
        mv secrets.env secrets.env.old
        echo "Copying old secrets to new format..."
        cp secrets.env.example secrets.env
        if [ "${SYRNIKE__PUSHD__VAPID__PRIVATE_KEY:-}" = "" ] && [ "${PUSHD_VAPID_PRIVATEKEY:-}" != "" ]; then
            SYRNIKE__PUSHD__VAPID__PRIVATE_KEY="$PUSHD_VAPID_PRIVATEKEY"
        fi
        if [ "${SYRNIKE__PUSHD__VAPID__PUBLIC_KEY:-}" = "" ] && [ "${PUSHD_VAPID_PUBLICKEY:-}" != "" ]; then
            SYRNIKE__PUSHD__VAPID__PUBLIC_KEY="$PUSHD_VAPID_PUBLICKEY"
        fi
        if [ "${SYRNIKE__FILES__ENCRYPTION_KEY:-}" = "" ] && [ "${FILES_ENCRYPTION_KEY:-}" != "" ]; then
            SYRNIKE__FILES__ENCRYPTION_KEY="$FILES_ENCRYPTION_KEY"
        fi
        if [ "${SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET:-}" = "" ] && [ "${LIVEKIT_WORLDWIDE_SECRET:-}" != "" ]; then
            SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET="$LIVEKIT_WORLDWIDE_SECRET"
        fi
        if [ "${SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY:-}" = "" ] && [ "${LIVEKIT_WORLDWIDE_KEY:-}" != "" ]; then
            SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY="$LIVEKIT_WORLDWIDE_KEY"
        fi
        printf "SYRNIKE__PUSHD__VAPID__PRIVATE_KEY='%s'\n" "$SYRNIKE__PUSHD__VAPID__PRIVATE_KEY" >> secrets.env
        printf "SYRNIKE__PUSHD__VAPID__PUBLIC_KEY='%s'\n" "$SYRNIKE__PUSHD__VAPID__PUBLIC_KEY" >> secrets.env
        echo "" >> secrets.env
        printf "SYRNIKE__FILES__ENCRYPTION_KEY='%s'\n" "$SYRNIKE__FILES__ENCRYPTION_KEY" >> secrets.env
        echo "" >> secrets.env
        printf "SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET='%s'\n" "$SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET" >> secrets.env
        printf "SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY='%s'\n" "$SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY" >> secrets.env
        loadSecrets
    fi
fi

echo "Configuring syrnike13 with hostname $DOMAIN"

SYRNIKE_HOSTNAME="https://$DOMAIN"
LIVEKIT_RTC_PORT_RANGE_START="${LIVEKIT_RTC_PORT_RANGE_START:-50000}"
LIVEKIT_RTC_PORT_RANGE_END="${LIVEKIT_RTC_PORT_RANGE_END:-50100}"
LIVEKIT_TCP_PORT="${LIVEKIT_TCP_PORT:-7881}"
LIVEKIT_TURN_UDP_PORT="${LIVEKIT_TURN_UDP_PORT:-3478}"
LIVEKIT_TURN_RELAY_RANGE_START="${LIVEKIT_TURN_RELAY_RANGE_START:-30000}"
LIVEKIT_TURN_RELAY_RANGE_END="${LIVEKIT_TURN_RELAY_RANGE_END:-30100}"

read -rp "Would you like to place syrnike13 behind another reverse proxy? [y/N]: "
if [ "$REPLY" = "y" ] || [ "$REPLY" = "Y" ]; then
    echo "Yes received. Configuring for reverse proxy."
    SYRNIKE_HOSTNAME=':80'
    echo "Writing compose.override.yml..."
    echo "services:" > compose.override.yml
    echo "  caddy:" >> compose.override.yml
    echo "    ports: !override" >> compose.override.yml
    echo "     - \"8880:80\"" >> compose.override.yml
    echo "caddy is configured to host on :8880. If you need a different port, modify the compose.override.yml."
    echo "SYRNIKE_DOMAIN=" > .env
else
    echo "No received. Configuring with built in caddy as primary reverse proxy."
    echo "SYRNIKE_DOMAIN=$DOMAIN" > .env
fi

read -rp "Would you like to enable camera and screen sharing? [Y/n]: "
if [ "$REPLY" = "n" ] || [ "$REPLY" = "N" ]; then
    echo "No received. Not configuring video."
else
    echo "Yes received. Configuring video."
    VIDEO_ENABLED=true
fi

# Generate secrets
echo "Generating secrets..."
if [ "${SYRNIKE__PUSHD__VAPID__PRIVATE_KEY:-}" = "" ]; then
    if [ "${SYRNIKE__PUSHD__VAPID__PUBLIC_KEY:-}" != "" ]; then
        echo "VAPID public key is defined when private key isn't?"
        echo "Did you forget to copy the SYRNIKE__PUSHD__VAPID__PRIVATE_KEY secret?"
        echo "Try removing SYRNIKE__PUSHD__VAPID__PUBLIC_KEY if you do not have a private key."
        exit 1
    fi
    echo "Generating Pushd VAPID secrets..."
    openssl ecparam -name prime256v1 -genkey -noout -out vapid_private.pem
    SYRNIKE__PUSHD__VAPID__PRIVATE_KEY=$(base64 -i vapid_private.pem | tr -d '\n' | tr -d '=')
    SYRNIKE__PUSHD__VAPID__PUBLIC_KEY=$(openssl ec -in vapid_private.pem -outform DER|tail --bytes 65|base64|tr '/+' '_-'|tr -d '\n'|tr -d '=')
    rm vapid_private.pem
    echo "" >> secrets.env
    printf "SYRNIKE__PUSHD__VAPID__PRIVATE_KEY='%s'\n" $SYRNIKE__PUSHD__VAPID__PRIVATE_KEY >> secrets.env
    printf "SYRNIKE__PUSHD__VAPID__PUBLIC_KEY='%s'\n" $SYRNIKE__PUSHD__VAPID__PUBLIC_KEY >> secrets.env
elif [ "${SYRNIKE__PUSHD__VAPID__PUBLIC_KEY:-}" = "" ]; then
    echo "VAPID private key is defined when public key isn't?"
    echo "Did you forget to copy the SYRNIKE__PUSHD__VAPID__PUBLIC_KEY secret?"
    echo "Try removing SYRNIKE__PUSHD__VAPID__PRIVATE_KEY if you do not have a public key."
    exit 1
else
    echo "Using old Pushd VAPID secrets..."
fi

if [ "${SYRNIKE__FILES__ENCRYPTION_KEY:-}" = "" ]; then
    echo "Generating files encryption secret..."
    SYRNIKE__FILES__ENCRYPTION_KEY=$(openssl rand -base64 32)
    echo "" >> secrets.env
    printf "SYRNIKE__FILES__ENCRYPTION_KEY='%s'\n" $SYRNIKE__FILES__ENCRYPTION_KEY >> secrets.env
else
    echo "Using old files encryption secret..."
fi

if [ "${SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET:-}" = "" ]; then
    if [ "${SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY:-}" != "" ]; then
        echo "Livekit public key is defined when secret isn't?"
        echo "Did you forget to copy the SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET secret?"
        echo "Try removing SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY if you do not have a secret."
        exit 1
    fi
    echo "Generating Livekit secrets..."
    SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET=$(openssl rand -hex 24)
    SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY=$(openssl rand -hex 6)
    echo "" >> secrets.env
    printf "SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET='%s'\n" $SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET >> secrets.env
    printf "SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY='%s'\n" $SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY >> secrets.env
elif [ "${SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY:-}" = "" ]; then
    echo "Livekit secret is defined when public key isn't?"
    echo "Did you forget to copy the SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY secret?"
    echo "Try removing SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET if you do not have a public key."
    exit 1
else
    echo "Using old Livekit secrets..."
fi

# set hostname for Caddy and vite variables
echo "HOSTNAME=$SYRNIKE_HOSTNAME" > .env.web
echo "ADMIN_HOSTNAME=admin.$DOMAIN" >> .env.web
echo "SYRNIKE_PUBLIC_URL=https://$DOMAIN/api" >> .env.web
echo "VITE_API_URL=https://$DOMAIN/api" >> .env.web
echo "VITE_WS_URL=wss://$DOMAIN/ws" >> .env.web
echo "VITE_MEDIA_URL=https://$DOMAIN/autumn" >> .env.web
echo "VITE_PROXY_URL=https://$DOMAIN/january" >> .env.web
echo "VITE_CFG_ENABLE_VIDEO=$VIDEO_ENABLED" >> .env.web

# hostnames
echo "# All secrets are stored in secrets.env" > Syrnike.toml
echo "# Any configuration added to this file will be overwritten by generate_config on run; however," >> Syrnike.toml
echo "# the script will back up your old configuration so you can copy over your old configuration" >> Syrnike.toml
echo "# values if needed." >> Syrnike.toml
echo "[hosts]" >> Syrnike.toml
echo "app = \"https://$DOMAIN\"" >> Syrnike.toml
echo "api = \"https://$DOMAIN/api\"" >> Syrnike.toml
echo "events = \"wss://$DOMAIN/ws\"" >> Syrnike.toml
echo "autumn = \"https://$DOMAIN/autumn\"" >> Syrnike.toml
echo "january = \"https://$DOMAIN/january\"" >> Syrnike.toml

# livekit hostname
echo "" >> Syrnike.toml
echo "[hosts.livekit]" >> Syrnike.toml
echo "worldwide = \"wss://$DOMAIN/livekit\"" >> Syrnike.toml

# livekit yml
echo "rtc:" > livekit.yml
echo "  use_external_ip: true" >> livekit.yml
echo "  port_range_start: $LIVEKIT_RTC_PORT_RANGE_START" >> livekit.yml
echo "  port_range_end: $LIVEKIT_RTC_PORT_RANGE_END" >> livekit.yml
echo "  tcp_port: $LIVEKIT_TCP_PORT" >> livekit.yml
echo "" >> livekit.yml
echo "redis:" >> livekit.yml
echo "  address: redis:6379" >> livekit.yml
echo "" >> livekit.yml
echo "turn:" >> livekit.yml
echo "  enabled: true" >> livekit.yml
echo "  udp_port: $LIVEKIT_TURN_UDP_PORT" >> livekit.yml
echo "  relay_range_start: $LIVEKIT_TURN_RELAY_RANGE_START" >> livekit.yml
echo "  relay_range_end: $LIVEKIT_TURN_RELAY_RANGE_END" >> livekit.yml
echo "" >> livekit.yml
echo "keys:" >> livekit.yml
echo "  $SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY: $SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__SECRET" >> livekit.yml
echo "" >> livekit.yml
echo "webhook:" >> livekit.yml
echo "  api_key: $SYRNIKE__API__LIVEKIT__NODES__WORLDWIDE__KEY" >> livekit.yml
echo "  urls:" >> livekit.yml
echo "  - \"http://voice-ingress:8500/worldwide\"" >> livekit.yml

# livekit config
echo "" >> Syrnike.toml
echo "[api.livekit.nodes.worldwide]" >> Syrnike.toml
echo "url = \"http://livekit:7880\"" >> Syrnike.toml
echo "lat = 0.0" >> Syrnike.toml
echo "lon = 0.0" >> Syrnike.toml

# Video config
# We'll enable 1080p video by default, that should be high enough for most users.
if [[ -n "$VIDEO_ENABLED" ]]; then
    echo "" >> Syrnike.toml
    echo "[features.limits.new_user]" >> Syrnike.toml
    echo "video_resolution = [1920, 1080]" >> Syrnike.toml
    echo "video_aspect_ratio = [0.3, 10]" >> Syrnike.toml
    echo "" >> Syrnike.toml
    echo "[features.limits.default]" >> Syrnike.toml
    echo "video_resolution = [1920, 1080]" >> Syrnike.toml
    echo "video_aspect_ratio = [0.3, 10]" >> Syrnike.toml
fi

if [[ $IS_OVERWRITING -eq 1 ]]; then
    echo "Overwrote existing config. If any custom configuration was present in old Syrnike.toml, you may now copy it over from Syrnike.toml.old."
fi
