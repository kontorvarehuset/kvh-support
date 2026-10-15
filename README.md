# kvh-support

Eget, enkelt grensesnitt for support, som ligger under `support.kvh.no/kvhui/` ved siden av Zammad.

- Statiske filer bak nginx, ingen byggetrinn og ingen database.
- Nettleseren snakker direkte med Zammads API (`/api/v1`) på samme adresse, med agentens egen innlogging og `csrf-token` fra svarene. Svar og notater går dermed ut i den innloggedes navn.
- Bildet bygges av GitHub Actions til `ghcr.io/kontorvarehuset/kvh-support`. Serveren (PROD-ext-dock-01) trekker det ferdige bildet.

Utrulling: `docker compose pull && docker compose up -d` i `/opt/docker-kvh-support`.
NetBird-ruten `/kvhui` på tjenesten for `support.kvh.no` peker på `100.76.1.117:3002`.
