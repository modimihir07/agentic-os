#!/usr/bin/env bash
# Agentic OS — cloud fallback model on the droplet.
# llama.cpp server + Qwen3-0.6B (Q4_K_M), OpenAI-compatible on the NetBird IP only.
set -euo pipefail
LOG=/var/log/llm-install.log
exec > >(tee -a "$LOG") 2>&1
echo "== $(date) start"

MESH_IP="${MESH_IP:-100.84.1.36}"
PORT=8000
BASE=/opt/llm
MODEL_URL="https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf"
MODEL="$BASE/models/Qwen3-0.6B-Q4_K_M.gguf"

echo "== reclaim disk (apt cache, journal > 60M)"
apt-get clean
journalctl --vacuum-size=60M || true
df -h / | tail -1

echo "== swap guard (768M, swappiness 10)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 768M /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null && echo 'vm.swappiness=10' > /etc/sysctl.d/99-llm.conf

echo "== llama.cpp server (prebuilt release)"
mkdir -p "$BASE/bin" "$BASE/models" /etc/llm
URL=$(curl -fsSL "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10"   | python3 -c 'import json,re,sys
for r in json.load(sys.stdin):
    for a in r["assets"]:
        if re.fullmatch(r"llama-b\d+-bin-ubuntu-x64\.(tar\.gz|zip)", a["name"]):
            print(a["browser_download_url"]); sys.exit()')
echo "release: $URL"
TMP=$(mktemp -d)
curl -fL --retry 3 -o "$TMP/llama.pkg" "$URL"
mkdir -p "$TMP/x"
case "$URL" in
  *.zip) python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/llama.pkg" "$TMP/x" ;;
  *) tar -xzf "$TMP/llama.pkg" -C "$TMP/x" ;;
esac
SRV=$(find "$TMP/x" -name llama-server -type f | head -1)
cp -a "$(dirname "$SRV")"/. "$BASE/bin/"
chmod +x "$BASE/bin/"llama-*
rm -rf "$TMP"
"$BASE/bin/llama-server" --version 2>&1 | tail -2

echo "== model"
[ -s "$MODEL" ] || curl -fL --retry 3 -o "$MODEL.part" "$MODEL_URL" && { [ -s "$MODEL" ] || mv "$MODEL.part" "$MODEL"; }
ls -lh "$MODEL"

echo "== API key"
[ -s /etc/llm/api-key ] || openssl rand -hex 24 > /etc/llm/api-key
chmod 600 /etc/llm/api-key

REASON=""
"$BASE/bin/llama-server" --help 2>&1 | grep -q -- '--reasoning-budget' && REASON="--reasoning-budget 0"

cat > /etc/systemd/system/llama-qwen.service <<EOF
[Unit]
Description=Agentic OS cloud fallback model (Qwen3-0.6B via llama.cpp)
After=network-online.target netbird.service
Wants=network-online.target

[Service]
Environment=LD_LIBRARY_PATH=$BASE/bin
ExecStart=$BASE/bin/llama-server -m $MODEL --alias qwen3-0.6b --host $MESH_IP --port $PORT --api-key-file /etc/llm/api-key -c 4096 -t 1 -tb 1 --jinja $REASON --no-webui
Restart=always
RestartSec=5
MemoryMax=1100M
Nice=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now llama-qwen
sleep 20
systemctl --no-pager --lines=8 status llama-qwen || true
echo "== $(date) done"
df -h / | tail -1
free -m
