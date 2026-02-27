#!/bin/bash
# DuckDNS IP update — runs every 5 minutes via cron
# Edit DOMAIN and TOKEN before deploying

DOMAIN="scws"
TOKEN=""

echo url="https://www.duckdns.org/update?domains=$DOMAIN&token=$TOKEN&ip=" | curl -s -o /var/www/scws/duckdns/duck.log -K -
