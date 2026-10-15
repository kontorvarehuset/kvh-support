# Bare statiske filer bak nginx. Ingen byggetrinn og ingen avhengigheter:
# siden kjører i nettleseren og snakker med Zammads API på samme adresse.
FROM nginx:1.31.1-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY site/ /usr/share/nginx/html/
# Versjonen som kjører, satt av bygget (`--build-arg GIT_SHA=…`). Vises nederst i lista, så ingen må gjette hva som er utrullet.
ARG GIT_SHA=ukjent
RUN echo "$GIT_SHA" > /usr/share/nginx/html/versjon.txt
