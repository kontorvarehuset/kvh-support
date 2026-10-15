# Bare statiske filer bak nginx. Ingen byggetrinn og ingen avhengigheter:
# siden kjører i nettleseren og snakker med Zammads API på samme adresse.
FROM nginx:1.31.1-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY site/ /usr/share/nginx/html/
