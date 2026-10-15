# kvh-support

Eget, enkelt grensesnitt for support, som ligger under `support.kvh.no/kvhui/` ved siden av Zammad.
Det erstatter ikke Zammad: e-post, regler, triggere og lagring ligger der. Dette er bare en bedre inngang
for det saksbehandlerne gjør daglig.

## Hva det kan

- Saksliste med tall øverst (åpne, uten eier, venter over et døgn, på vent), Alle/Mine og fanene Åpne, På vent, Lukket.
- Søk i **alle** saker i Zammad, også meldingsteksten, med valg mellom åpne og/eller lukkede.
- Samtalen med avsender, notater, vedlegg og skjermbilder, og profilbilder fra Zammad.
- Svar til kunde og internt notat, med Cc og skjermbilder limt rett inn i meldingen.
- Videresend en melding på e-post (med vedlegg), Ny sak (e-post ut eller logg telefonsamtale).
- Eier (ta saken, gi den til en kollega), på vent, lukk, gjenåpne og Send og lukk.

## Slik henger det sammen

- Statiske filer bak nginx (`site/`), ingen byggetrinn, ingen database og ingen egen innlogging.
- Nettleseren snakker direkte med Zammads API (`/api/v1`) på **samme adresse** som siden, med agentens egen
  innloggingskake og `csrf-token`-hodet fra svarene. Svar og endringer går dermed ut i den innloggedes navn.
  Er man ikke innlogget i Zammad, svarer API-et 401 og siden ber om innlogging.
- Siden deler opprinnelse med Zammad, så en sikkerhetsfeil her er det samme som å kapre en agents innlogging.
  Derfor: streng CSP i `nginx.conf` (ingen innebygde skript, ingen eksterne skript, ingen rammer), og all e-post-HTML
  renses med en allowlist i `site/js/rens.js` (SVG og MathML droppes). Tekst fra Zammad settes aldri inn som rå HTML.
- Ingen hemmeligheter i koden eller i bildet. Dockerfile kopierer bare `nginx.conf` og `site/`.

## Hvor det kjører

- Server: **PROD-ext-dock-01**, mappe `/opt/docker-kvh-support` (`docker-compose.yml` og `src/`, som er en klone av dette repoet).
- Containeren `kvhui` publiserer på `100.76.1.117:3002` og `127.0.0.1:3002`, aldri `0.0.0.0`.
- **NetBird** (egen tenant): tjenesten `support.kvh.no` har to mål. `/` går til Zammads nginx (`100.76.1.117:8080`),
  og `/kvhui` går hit (`100.76.1.117:3002`). «Preserve Full Path» kan stå av eller på: nginx svarer på begge, og
  siden bruker absolutte adresser som begynner på `/kvhui/`.

## Oppdatere (rutine)

Redigér aldri `src/` på serveren. Endringer lages andre steder, pushes, og hentes på serveren.

```
cd /opt/docker-kvh-support/src
git status --short                      # skal være tom; ellers stopp og finn ut hvorfor
git pull --ff-only                      # feiler heller enn å lage en uventet sammenslåing
docker build -t kvh-support:local .
cd .. && docker compose up -d
curl -s http://127.0.0.1:3002/helse     # skal skrive «ok»
```

Last siden på nytt med **Ctrl+Shift+R** etterpå, ellers kan nettleseren vise gammel JavaScript.

### Gå tilbake til forrige versjon

```
cd /opt/docker-kvh-support/src
git log --oneline | head                # finn forrige gode commit
git checkout <commit>
docker build -t kvh-support:local . && cd .. && docker compose up -d
```

Gå tilbake til nyeste etterpå med `git checkout main && git pull --ff-only`, og bygg på nytt.

### Første gang (ny server)

1. Lag en lesenøkkel: `ssh-keygen -t ed25519 -N "" -f /root/.ssh/kvh-support-deploy`, og legg den offentlige nøkkelen inn
   som **Deploy key** (uten skrivetilgang) i repoet på GitHub.
2. `Host github-kvh-support` i `/root/.ssh/config` med `IdentityFile` og `IdentitiesOnly yes`.
3. `git clone git@github-kvh-support:kontorvarehuset/kvh-support.git src`, bygg og start som over (`docker-compose.yml` ligger i
   `/opt/docker-kvh-support`, se repoet for innholdet).
4. Legg inn målet `/kvhui` i NetBird som beskrevet over.

## Utvikle og prøve

Koden kan redigeres hvor som helst; på DEV-ubu-dock-02 ligger den i `/home/frank/kvh-support`. Den kan ikke kjøres mot
ekte data derfra (NetBird-proxyen slipper ikke den serveren inn), så endringer prøves i nettleseren etter at de er rullet ut.

```
for t in test/*.test.mjs; do node $t; done     # kjører uten byggetrinn
```

`rens`, `skriv`, `ny-sak` og `videresend`-testene trenger `jsdom` (`npm i --no-save jsdom`). Koden skrives på norsk bokmål med
lange «hvorfor»-kommentarer, som resten av KVH-kodebasene.

Pushing: på DEV-02 ligger en gammel lagret innlogging (`credential.helper=store`) som vinner over alt annet. Bruk
`git -c credential.helper= push` med et token som har tilgang til dette repoet (Contents og, for workflow-filer, Workflows).

## Kjente fallgruver

- **Zammads søkeindeks henger noen sekunder.** Hent aldri lista rett etter en endring. Siden bruker svaret fra endringen og
  husker endrede saker i ti sekunder (`medLokale` i `ui.js`).
- **Avsendernavnet** bestemmes av Microsoft 365, ikke av Zammad: visningsnavnet på postboksen `support@kontorvarehuset.no` overstyrer
  navnet Zammad sender. Endres i Exchange/Microsoft 365 admin. «Agentnavn via …» kan derfor ikke brukes, så agenten navngis i signaturen.
- **Logg telefonsamtale** (avsender Customer, type phone) utløser Zammads trigger «auto reply (on new tickets)». Fiks i Zammad:
  legg til betingelsen artikkeltype er ikke phone.
- **Status på vent:** 3 (pending reminder), 6 (pending close) og de egne 7 og 8 regnes som på vent til fristen er nådd,
  så er saken åpen igjen («venter på oss»). Saker i *pending close* uten frist ligger på vent for alltid; rydd dem i Zammad.
- Svar og notater sendes **umiddelbart**, uten ventetid og uten angre.

## Filer

- `site/index.html`, `site/app.css`: skall og stil (samme design som RMM-et: papirfarge, oransje aksent, lys og mørk drakt).
- `site/js/ui.js`: hovedskjermen. `modell.js`: rene funksjoner (statuser, søkespørring, tid). `api.js`: kall mot Zammad.
- `site/js/skriv.js` (svar og notat), `ny-sak.js`, `videresend.js`, `rens.js` (HTML-rensing).
- `nginx.conf`, `Dockerfile`, `docker-compose.yml`: containeren.
