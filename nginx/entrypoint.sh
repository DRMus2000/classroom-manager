#!/bin/sh
set -eu
mkdir -p /etc/nginx/certs
if [ ! -s /etc/nginx/certs/fullchain.pem ] || [ ! -s /etc/nginx/certs/privkey.pem ]; then
  apk add --no-cache openssl >/dev/null
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/nginx/certs/privkey.pem \
    -out /etc/nginx/certs/fullchain.pem \
    -subj "/CN=localhost" >/dev/null 2>&1
  echo "已生成自签证书。生产环境请用可信证书替换 /etc/nginx/certs。"
fi
exec nginx -g 'daemon off;'
