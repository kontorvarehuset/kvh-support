/*
 * Skjermen: hilsen og tall, saksliste og samtale.
 *
 * Første trinn er BARE LESING. Svar, notater, eier, på vent og lukking gjøres
 * foreløpig i Zammad (lenke øverst i hver sak), så ingenting her kan sende noe
 * til en kunde.
 *
 * All tekst fra Zammad (emner, navn, e-poster) settes inn gjennom `esc()` eller
 * som tekstnoder. HTML fra e-post går gjennom `rens()`. Aldri rå innerHTML av
 * noe vi ikke har skrevet selv: siden har agentens innlogging.
 */

import { hent, put, IkkeInnlogget } from "./api.js";
import {
  STATUSNAVN_APNE, INGEN_EIER, bildeUrl, beregnStatus, sokeSporring, byggSaker, brukereFra, byggArtikkel, navnPaa, initialer,
  kortTid, langTid, ventTekst, skillSitat, erBilde, storrelseTekst, navnFraFra,
} from "./modell.js";
import { rens } from "./rens.js";
import { monter, planleggSending, SPERRE_TIL } from "./skriv.js";
import { apneNySak } from "./ny-sak.js";
import { apneVideresend } from "./videresend.js";
import { signaturHtml } from "./signatur.js";

const $ = (s) => document.querySelector(s);

/* Eneste opprinnelse som får ramme inn siden og snakke med den (nginx sier det samme i frame-ancestors). */
const RMM_OPPRINNELSE = "https://rmm.kvh.no";

/*
 * Innbygd (i vinduet i RMM-et) velger siden ALDRI en sak av seg selv. Vinduet er smalt, og første sak sto åpen
 * hver gang man åpnet Support, så man aldri så lista først. I vanlig fane er første sak fortsatt valgt, siden lista og
 * saken står ved siden av hverandre der.
 */
const INNBYGD = !!document.documentElement.dataset.innbygd;
const forsteSakId = (liste) => (INNBYGD || !liste.length ? null : liste[0].id);
function meldOpp(ny) {
  if (window.parent === window) return;
  try { window.parent.postMessage({ type: "kvhui-antall", ny }, RMM_OPPRINNELSE); } catch { /* uten ramme eller blokkert */ }
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = {
  me: null,
  meBruker: null,
  lokale: new Map(),
  treff: null,
  omfang: { apne: true, lukkede: true },
  visVent: false,
  sokSeq: 0,
  agenter: [],
  saker: [],
  lukkede: null,
  brukere: new Map(),
  fane: "åpen",
  visning: "alle",
  spesial: null,
  filter: "",
  valgt: null,
  artikler: new Map(),
  feil: null,
  mer: false,
};

/* ── Henting ─────────────────────────────────────────────────────────── */

const APNE_SPORRING = "state.name:(" + STATUSNAVN_APNE.map((n) => (n.includes(" ") ? `"${n}"` : n)).join(" OR ") + ")";

async function sok(sporring, grense) {
  const q = new URLSearchParams({ query: sporring, limit: String(grense), full: "true", sort_by: "updated_at", order_by: "desc" });
  return hent("/tickets/search?" + q);
}

/*
 * Zammads søkeindeks henger noen sekunder etter. Henter vi lista rett etter at vi selv har endret en
 * sak, får vi derfor ofte den GAMLE versjonen, og saken hopper tilbake til der den var (en gjenåpnet
 * sak ble stående som lukket til man lastet siden på nytt). Derfor husker vi saker vi har endret i ti
 * sekunder, og bruker vår versjon til serverens er like fersk eller ferskere.
 */
function husk(sak) { S.lokale.set(sak.id, { sak, til: Date.now() + 10_000 }); }

function medLokale(liste, lukkedeListe) {
  const naa = Date.now();
  let ut = liste;
  for (const [id, v] of [...S.lokale]) {
    if (v.til < naa) { S.lokale.delete(id); continue; }
    const server = ut.find((x) => x.id === id);
    if (server && new Date(server.oppdatert) >= new Date(v.sak.oppdatert)) { S.lokale.delete(id); continue; }
    ut = ut.filter((x) => x.id !== id);
    if ((v.sak.status === "lukket") === lukkedeListe) ut = [v.sak, ...ut];
  }
  return ut;
}

async function lastSaker() {
  const res = await sok(APNE_SPORRING, 200);
  for (const [id, b] of brukereFra(res)) S.brukere.set(id, b);
  S.saker = medLokale(byggSaker(res), false);
  S.mer = (res.total_count || 0) > S.saker.length;
}

async function lastLukkede() {
  const res = await sok("state.name:closed AND updated_at:[now-30d TO now]", 100);
  for (const [id, b] of brukereFra(res)) S.brukere.set(id, b);
  S.lukkede = medLokale(byggSaker(res), true);
}

async function lastArtikler(id) {
  const rader = await hent(`/ticket_articles/by_ticket/${id}?expand=true`);
  const mangler = [...new Set(rader.map((a) => a.created_by_id))].filter((u) => u && !S.brukere.has(u));
  await Promise.all(mangler.map(async (u) => {
    try { S.brukere.set(u, await hent(`/users/${u}`)); } catch { /* navn faller tilbake på from-hodet */ }
  }));
  const sak = alle().find((x) => x.id === id);
  S.artikler.set(id, { oppdatert: sak?.oppdatert, liste: rader.map((a) => byggArtikkel(a, S.brukere)) });
}

/* Kollegaene saker kan gis til: aktive agenter, uten tjenestebrukere (rolle «Orbit-integrasjon»). */
async function lastAgenter() {
  const roller = await hent("/roles");
  const agent = roller.find((r) => r.name === "Agent");
  const tjeneste = roller.find((r) => /integrasjon|integration/i.test(r.name));
  if (!agent) return;
  const q = new URLSearchParams({ query: `role_ids:${agent.id}`, limit: "100", full: "true" });
  const res = await hent("/users/search?" + q);
  const B = (res.assets || {}).User || {};
  S.agenter = Object.values(B)
    .filter((b) => b.active && (b.role_ids || []).includes(agent.id) && !(tjeneste && (b.role_ids || []).includes(tjeneste.id)))
    .map((b) => ({ id: b.id, navn: navnPaa(b) }))
    .sort((a, b) => a.navn.localeCompare(b.navn, "nb"));
  for (const b of Object.values(B)) S.brukere.set(b.id, b);
}

/* Initialer med profilbildet lagt oppå. Mangler bildet eller feiler lasting, står initialene igjen. */
const bildeId = (id) => bildeUrl(S.brukere.get(id));
function avatarInnhold(navn, url) {
  return esc(initialer(navn)) + (url ? `<img class="prof" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "");
}

const alle = () => [...S.saker, ...(S.lukkede || []), ...(S.treff ? S.treff.liste : [])];
const finn = (id) => alle().find((x) => x.id === id);

/* ── Utvalg ──────────────────────────────────────────────────────────── */

/* Lista for fanen man står i, før søk og filtre. Med «Vis også saker på vent» har fanen Åpne både åpne saker
   og saker på vent, åpne FØRST (det som haster øverst), så de på vent. */
function faneKilde() {
  if (S.fane === "lukket") return S.lukkede || [];
  if (S.fane === "åpen" && S.visVent) return [...S.saker.filter((x) => x.status === "åpen"), ...S.saker.filter((x) => x.status === "vent")];
  return S.saker.filter((x) => x.status === S.fane);
}

function synlige() {
  /* Mens et søk i alle saker står, er det treffene som vises, ikke fanen man sto i. */
  if (S.treff) return S.treff.liste.filter((x) => S.visning !== "mine" || x.eierId === S.me?.id);
  const kilde = faneKilde();
  const q = S.filter.trim().toLowerCase();
  return kilde.filter((x) =>
    (S.visning !== "mine" || x.eierId === S.me?.id) &&
    (S.spesial !== "uten" || !x.eier) &&
    (S.spesial !== "gamle" || x.dager >= 1) &&
    (!q || `${x.kunde} ${x.emne} ${x.fra} ${x.nummer}`.toLowerCase().includes(q)));
}

/* ── Tegning ─────────────────────────────────────────────────────────── */

function tegnBruker() {
  $("#bruker").innerHTML = S.me
    ? `<span class="mini-av">${avatarInnhold(S.me.navn, bildeId(S.me.id))}</span><span class="bn">${esc(S.me.navn)}</span>`
    : "";
}

/* Kortere etiketter til smale skjermer: tre linjer med «Venter over et døgn» gjorde kolonnene ulike i høyde. */
const KORT_ETIKETT = { åpne: "Åpne", uten: "Uten eier", gamle: "Over et døgn", vent: "På vent" };

function tegnHero() {
  const naa = new Date();
  const h = naa.getHours();
  const hils = h < 5 ? "God natt" : h < 10 ? "God morgen" : h < 17 ? "God dag" : "God kveld";
  const dato = naa.toLocaleDateString("nb-NO", { weekday: "long", day: "numeric", month: "long" }).toUpperCase();
  const apne = S.saker.filter((x) => x.status === "åpen");
  const uten = apne.filter((x) => !x.eier).length;
  const gamle = apne.filter((x) => x.dager >= 1);
  const vent = S.saker.filter((x) => x.status === "vent");
  const eldst = gamle.length ? Math.max(...gamle.map((x) => x.dager)) : 0;
  const neste = vent.map((x) => x.ventTil).filter((t) => t && t > Date.now()).sort()[0];
  const trenger = apne.filter((x) => x.venterPaaOss && (!x.eier || x.eierId === S.me?.id)).length;
  const fornavn = (S.me?.navn || "").split(" ")[0];
  const kort = [
    ["åpne", "Åpne saker", apne.length, uten ? `${uten} uten eier` : "alle har eier", "", S.fane === "åpen" && !S.spesial, "Vis åpne saker"],
    ["uten", "Uten eier", uten, uten ? "ingen har tatt dem" : "alle er tatt", uten ? "varsel" : "", S.spesial === "uten", "Vis saker uten eier"],
    ["gamle", "Venter over et døgn", gamle.length, gamle.length ? `eldste: ${eldst} d` : "ingen forsinket", gamle.length ? "farlig" : "", S.spesial === "gamle", "Vis saker som har ventet over et døgn"],
    ["vent", "På vent", vent.length, neste ? `neste: ${ventTekst(neste)}` : "ingen tidsfrister", "", S.fane === "vent" && !S.spesial, "Vis saker på vent"],
  ];
  $("#hero").innerHTML = `<div>
      <div class="dato">${esc(dato)}</div>
      <h1>${hils}${fornavn ? ", " + esc(fornavn) : ""}.</h1>
      <div class="under">${trenger ? `Du har ${trenger} ${trenger === 1 ? "sak" : "saker"} som venter på deg.` : "Ingenting venter på deg akkurat nå."}</div>
    </div>
    <div class="tall" id="tall" role="group" aria-label="Snarveier til saker">${kort.map(([k, e, n, u, kl, paa, t]) =>
      `<button data-t="${k}" class="${kl}" aria-pressed="${!!paa}" title="${esc(t)}" aria-label="${n} ${esc(e.toLowerCase())}"><span class="e"><span class="lang">${esc(e)}</span><span class="kort">${esc(KORT_ETIKETT[k] || e)}</span></span><span class="n">${n}</span><span class="u">${esc(u)}</span></button>`).join("")}</div>`;
  const ny = apne.filter((x) => x.venterPaaOss || !x.eier).length;
  document.title = (ny ? `(${ny}) ` : "") + "KVH Support";
  meldOpp(ny);
}

function tegnFaner() {
  const n = (s) => S.saker.filter((x) => x.status === s).length;
  const F = [["åpen", "Åpne", n("åpen") + (S.visVent ? `<span class="pluss">+${n("vent")}</span>` : "")], ["vent", "På vent", n("vent")], ["lukket", "Lukket", S.lukkede ? S.lukkede.length : null]];
  $("#faner").innerHTML = F.map(([k, nn, t]) =>
    `<button role="tab" aria-selected="${!S.treff && k === S.fane}" data-f="${k}">${nn}<span class="t">${t ?? ""}</span></button>`).join("");
  /* Tallene under Alle/Mine gjelder fanen man står i, ikke «alt som ikke er lukket».
     Med 7 under Alle og 2 i lista så det ut som en feil, selv om begge var riktige. */
  const kilde = faneKilde();
  const vr = $("#vis-vent-rad"); if (vr) { vr.hidden = S.fane !== "åpen" || !!S.treff; $("#vis-vent").checked = S.visVent; }
  $("#visning").innerHTML =
    `<button data-v="alle" aria-pressed="${S.visning === "alle"}">Alle saker<span class="t">${kilde.length}</span></button>` +
    `<button data-v="mine" aria-pressed="${S.visning === "mine"}">Mine saker<span class="t">${kilde.filter((x) => x.eierId === S.me?.id).length}</span></button>`;
}

/* Statusmerke i margen: grønn åpen hengelås = åpen, gul klokke = på vent, grå lukket hengelås = lukket. Formen skiller
   dem også uten farger. Den oransje prikken er «venter på svar fra oss». */
const IK_STAT = {
  åpen: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
  vent: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  lukket: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
};
const STAT_NAVN = { åpen: "Åpen", vent: "På vent", lukket: "Lukket" };
function statusMerke(x) {
  const tittel = STAT_NAVN[x.status] + (x.venterPaaOss ? " · venter på svar fra oss" : "");
  return `<span class="stat ${x.status}" role="img" aria-label="${esc(tittel)}" title="${esc(tittel)}">${IK_STAT[x.status] || ""}${x.venterPaaOss ? '<span class="stat-prikk"></span>' : ""}</span>`;
}

function sokStripe() {
  const t = S.treff;
  if (!t || t.laster) return "";
  const hvor = S.omfang.apne && S.omfang.lukkede ? "åpne og lukkede" : S.omfang.apne ? "åpne" : "lukkede";
  return `<div class="sok-strip"><span>${t.total} ${t.total === 1 ? "treff" : "treff"} i ${hvor} saker${t.total > t.liste.length ? `, viser de ${t.liste.length} sist endret` : ""}</span><button type="button" data-a="nullstill-sok">Nullstill søk</button></div>`;
}

function tegnListe() {
  if (S.treff) {
    if (S.treff.laster && !S.treff.liste.length) { $("#rader").innerHTML = `<div class="laster">Søker i alle saker …</div>`; return; }
    if (S.treff.feil) { $("#rader").innerHTML = `<div class="feil"><b>Søket feilet</b>${esc(S.treff.feil)}</div>`; return; }
  } else if (S.fane === "lukket" && S.lukkede === null && !S.feil) { $("#rader").innerHTML = `<div class="laster">Henter lukkede saker …</div>`; return; }
  const rader = synlige();
  if (!rader.length) {
    const tittel = S.treff ? "Ingen treff" : S.filter ? "Ingen treff" : S.visning === "mine" ? "Ingen saker på deg" : S.fane === "åpen" ? "Alt er besvart" : "Ingenting her";
    const under = S.treff ? `Ingen saker i Zammad passer med «${esc(S.treff.q)}». Prøv et annet ord, eller ta med både åpne og lukkede.` : S.filter ? "Prøv et annet søkeord." : "";
    $("#rader").innerHTML = sokStripe() + `<div class="tomt"><div class="w">${tittel}</div>${under}</div>`;
    return;
  }
  const gruppert = !S.treff && S.fane === "åpen" && S.visVent;
  let skilleSatt = false;
  $("#rader").innerHTML = sokStripe() + rader.map((x) => {
    const m = [];
    if (x.status === "vent") m.push(`<span class="chip vent">${x.ventTil ? "Til " + esc(ventTekst(x.ventTil)) : "Venter på svar"}</span>`);
    if (x.status === "lukket") m.push(`<span class="chip ok">Lukket</span>`);
    if (x.fristNaadd) m.push(`<span class="chip ingen">Påminnelsen er nådd</span>`);
    if (x.dager >= 1) m.push(`<span class="chip vent">Venter ${x.dager} d</span>`);
    if (!x.eier && x.status !== "lukket") m.push(`<span class="chip ingen">Uten eier</span>`);
    const eierPrikk = x.eier ? `<span class="mini-av ${x.eierId === S.me?.id ? "" : "andre"}" title="${esc(x.eier)}">${avatarInnhold(x.eier, bildeId(x.eierId))}</span>` : "";
    /* Skillelinje før første sak på vent når åpne og på vent vises sammen. */
    let skille = "";
    if (gruppert && x.status === "vent" && !skilleSatt) {
      skilleSatt = true;
      skille = `<div class="skille">På vent · ${rader.filter((r) => r.status === "vent").length}</div>`;
    }
    return skille + `<button class="rad" data-id="${x.id}" aria-current="${x.id === S.valgt}">
      ${statusMerke(x)}
      <span class="l1"><span class="kunde">${esc(x.kunde)}</span><span class="tid">${esc(kortTid(x.sist))}</span>${eierPrikk}</span>
      <span class="emne" style="display:block">${esc(x.emne)}</span>
      <span class="utdrag" style="display:block">${esc(x.fra)} · #${esc(x.nummer)} · ${x.antall} ${x.antall === 1 ? "melding" : "meldinger"}</span>
      ${m.length ? `<span class="merker">${m.join("")}</span>` : ""}
    </button>`;
  }).join("") + (S.mer && S.fane !== "lukket" ? `<div class="tomt" style="padding:16px">Viser de 200 sist oppdaterte. Flere finnes i Zammad.</div>` : "");
}

function vedleggUrl(a, v) { return `/api/v1/ticket_attachment/${a.ticketId}/${a.id}/${v.id}`; }

function tegnArtikler(sak, liste) {
  const ROLLE = { kunde: "Kunde", oss: "KVH", notat: "🔒 Internt", system: "System" };
  const hode = (a, i) => {
    const under = a.slag === "notat" ? `<span style="color:var(--stale);font-size:12.5px">Kunden ser ikke dette</span>` : "";
    return `<div class="hode"><b>${esc(a.navn)}</b><span class="rolle">${ROLLE[a.slag]}</span>${under}<span class="tid">${esc(langTid(a.tid))}</span><button type="button" class="vid" data-vid="${i}" title="Videresend denne meldingen på e-post" aria-label="Videresend meldingen fra ${esc(a.navn)}">↪ Videresend</button></div>`;
  };
  return liste.map((a, i) => a.slag === "system"
    ? `<div class="hend"><span class="sys">Automatisk svar til ${esc(navnFraFra(a.til) || a.til || "kunden")}${a.emne ? ": «" + esc(a.emne) + "»" : ""}</span><span class="sys">· ${esc(langTid(a.tid))}</span></div>`
    : `<article class="mld ${a.slag}">
        <div class="av" aria-hidden="true">${avatarInnhold(a.navn, bildeUrl({ image: a.bilde }))}</div>
        <div>${hode(a, i)}
          ${a.cc.length ? `<div class="ccvis">Cc: ${a.cc.map(esc).join(", ")}</div>` : ""}
          <div class="boble" data-a="${i}"></div>
        </div></article>`).join("");
}

function fyllBobler(sak, liste) {
  document.querySelectorAll("#tråd .boble").forEach((el) => {
    const a = liste[Number(el.dataset.a)];
    if (!a) return;
    let sitat = null;
    const bruktCid = new Set();
    if (a.html) {
      const r = rens(a.tekst, {
        cidTilUrl: (cid) => { const v = a.vedlegg.find((x) => x.cid === cid); return v ? vedleggUrl(a, v) : null; },
      });
      el.appendChild(r.svar);
      sitat = r.sitat;
      r.brukteCid.forEach((c) => bruktCid.add(c));
    } else {
      const d = skillSitat(a.tekst);
      for (const avsnitt of d.svar.split(/\n{2,}/)) {
        const p = document.createElement("p");
        avsnitt.split("\n").forEach((l, k) => { if (k) p.appendChild(document.createElement("br")); p.appendChild(document.createTextNode(l)); });
        el.appendChild(p);
      }
      if (d.sitat) { const s = document.createElement("div"); s.textContent = d.sitat; s.style.whiteSpace = "pre-wrap"; sitat = s; }
    }
    if (sitat) {
      const boks = document.createElement("div");
      boks.className = "sitat"; boks.hidden = true; boks.appendChild(sitat);
      const kn = document.createElement("button");
      kn.type = "button"; kn.className = "sitat-knapp"; kn.textContent = "⋯"; kn.title = "Vis sitert tekst"; kn.setAttribute("aria-expanded", "false");
      kn.addEventListener("click", () => { boks.hidden = !boks.hidden; kn.setAttribute("aria-expanded", String(!boks.hidden)); });
      el.appendChild(kn); el.appendChild(boks);
    }
    const rest = a.vedlegg.filter((v) => !v.skjul && !(v.cid && bruktCid.has(v.cid)));
    if (rest.length) {
      const v = document.createElement("div"); v.className = "vedlegg";
      for (const f of rest) {
        if (erBilde(f)) {
          const img = document.createElement("img");
          img.src = vedleggUrl(a, f); img.alt = f.navn; img.loading = "lazy";
          el.appendChild(img);
        } else {
          const l = document.createElement("a");
          l.className = "fil"; l.href = vedleggUrl(a, f); l.download = f.navn;
          l.append("📎 " + f.navn);
          if (f.storrelse) { const s = document.createElement("span"); s.className = "st"; s.textContent = storrelseTekst(f.storrelse); l.append(" ", s); }
          v.appendChild(l);
        }
      }
      if (v.childNodes.length) el.appendChild(v);
    }
  });
}

/* Artiklene tegnes for seg, slik at en oppfriskning ikke river ned skriveflata mens noen skriver. */
/*
 * Rull til nyeste melding, og HOLD der mens innholdet setter seg.
 *
 * Å rulle ned i det samtalen tegnes er ikke nok: bilder og profilbilder laster etterpå, og skriveflata blir høyere
 * når signaturen er hentet, så samtalen vokser (eller vinduet krymper) og man står igjen midt i. Vi følger
 * bunnen i noen sekunder, og slutter med en gang brukeren selv ruller eller trykker i samtalen.
 */
let holdNede = null;
function rullNed() {
  if (holdNede) holdNede();
  const t = $("#tråd"); if (!t) return;
  let aktiv = true;
  const ned = () => { if (aktiv) t.scrollTop = t.scrollHeight; };
  ned();
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(ned) : null;
  if (ro) { if (t.firstElementChild) ro.observe(t.firstElementChild); const sr = $("#skriv-rot"); if (sr) ro.observe(sr); }
  const hendelser = ["wheel", "touchstart", "pointerdown", "keydown"];
  const stopp = () => {
    aktiv = false; clearTimeout(tid);
    if (ro) ro.disconnect();
    for (const h of hendelser) t.removeEventListener(h, stopp);
    if (holdNede === stopp) holdNede = null;
  };
  const tid = setTimeout(stopp, 3000);
  for (const h of hendelser) t.addEventListener(h, stopp, { passive: true });
  holdNede = stopp;
}

function tegnArtikkelRot(sak) {
  const rot = $("#art-rot"); if (!rot) return;
  const ar = S.artikler.get(sak.id);
  rot.innerHTML = (S.feil && S.feil.sak === sak.id ? `<div class="feil"><b>Kunne ikke hente meldingene</b>${esc(S.feil.tekst)}</div>` : "") +
    (!ar && !(S.feil && S.feil.sak === sak.id) ? `<div class="laster">Henter meldinger …</div>` : "") +
    (ar ? tegnArtikler(sak, ar.liste) : "");
  if (ar) fyllBobler(sak, ar.liste);
}

function monterSkriveflate(sak) {
  const rot = $("#skriv-rot"); if (!rot) return;
  if (sak.status === "lukket" || !S.artikler.has(sak.id)) { rot.innerHTML = ""; return; }
  monter(rot, { sak, signatur: () => signaturHtml(sak.gruppeId, { bruker: S.meBruker, sak }), toast, planlegg: (j) => planleggSending(j, { toast, ferdig: etterSending, feilet: feilVedSending }) });
}

async function etterSending(j) {
  const sak0 = finn(j.saksId);
  if (sak0 && j.ticket) brukSvar(sak0, j.ticket, j.etterpa || {});
  try {
    await lastArtikler(j.saksId);
  } catch (e) { toast("Sendt, men kunne ikke oppdatere visningen: " + e.message); }
  tegnHero(); tegnFaner(); tegnListe();
  utsattOppfrisk();
  const sak = finn(j.saksId);
  if (S.valgt === j.saksId && sak && j.etterpa && !synlige().some((x) => x.id === j.saksId)) { velgNeste(j.saksId); return; }
  if (S.valgt === j.saksId && sak) { tegnBanner(sak); tegnSakTopp(sak); tegnArtikkelRot(sak); rullNed(); }
}

function feilVedSending(j, e) {
  toast("Ikke sendt: " + e.message);
}

function eierKnapp(sak) {
  if (sak.status === "lukket") return `<span class="chip" style="padding:5px 12px">${sak.eier ? "Eier: " + esc(sak.eier) : "Uten eier"}</span>`;
  const meg = sak.eierId === S.me?.id;
  const kn = sak.eier
    ? `<span class="mini-av ${meg ? "" : "andre"}">${avatarInnhold(sak.eier, bildeId(sak.eierId))}</span>${esc(meg ? "Meg" : sak.eier.split(" ")[0])}`
    : `<span class="mini-av ingen">–</span>Uten eier`;
  const andre = S.agenter.filter((a) => a.id !== S.me?.id);
  return `<button class="knapp eier-b" id="eier-b" aria-haspopup="menu" aria-expanded="false" title="Eier av saken">${kn} ▾</button>
    <div class="meny-pop" id="eier-pop" role="menu" hidden>
      ${!meg ? `<button role="menuitem" class="ta" data-e="${S.me?.id}"><span>Ta saken selv</span><span></span></button>${andre.length ? '<div class="sep"></div>' : ""}` : ""}
      ${andre.length ? '<div class="h">Gi saken til</div>' : ""}
      ${andre.map((a) => `<button role="menuitem" data-e="${a.id}"><span class="navn"><span class="mini-av andre">${avatarInnhold(a.navn, bildeId(a.id))}</span>${esc(a.navn)}</span>${sak.eierId === a.id ? '<span class="nå">Eier nå</span>' : ""}</button>`).join("")}
      ${sak.eier ? `<div class="sep"></div><button role="menuitem" data-e="0"><span>Fjern eier</span><span></span></button>` : ""}
    </div>`;
}

function tegnSakTopp(sak) {
  const rot = $("#sak-topp"); if (!rot) return;
  rot.innerHTML = `
      <button class="tilbake" data-a="tilbake">‹ Saker</button>
      <div class="tekst">
        <div class="meta"><span class="mono">#${esc(sak.nummer)}</span><span>·</span><span>${esc(sak.kunde)}</span></div>
        <h2>${esc(sak.emne)}</h2>
        <div class="fra">${esc(sak.fra)}${sak.epost ? " · " + esc(sak.epost) : ""}</div>
      </div>
      <div class="handlinger">${eierKnapp(sak)}${ventKnapp(sak)}${sak.status === "lukket" ? '<button class="knapp primær" data-a="aapne">Gjenåpne</button>' : `${sak.status === "vent" ? '<button class="knapp" data-a="aapne">Åpne nå</button>' : ""}<button class="knapp primær" data-a="lukk">Lukk saken</button>`}<a class="knapp" href="/#ticket/zoom/${sak.id}" target="_blank" rel="noopener" title="Åpne saken i Zammad" aria-label="Åpne saken i Zammad"><span class="zt">Zammad </span>↗</a></div>`;
}

function tegnBanner(sak) {
  const rot = $("#sak-banner"); if (!rot) return;
  /* Saker på vent har ikke eget felt lenger: knappen øverst viser fristen («På vent til man. 23. nov.»), og et felt
     som sa det samme en gang til tok bare plass, særlig på telefon. */
  rot.innerHTML = sak.status === "vent"
    ? ""
    : sak.status === "lukket" ? `<div class="banner lukket"><span>Saken er lukket. Gjenåpne den med knappen øverst.</span></div>` : "";
}

/* Tidspunkter for «på vent». Alle kl. 08:00 lokal tid (Oslo); mandag vises ikke når i morgen er mandag. */
function ventValg() {
  const kl8 = (dager) => { const d = new Date(); d.setDate(d.getDate() + dager); d.setHours(8, 0, 0, 0); return d; };
  const val = [{ navn: "I morgen", d: kl8(1), stat: 3 }];
  const tilMandag = ((8 - new Date().getDay()) % 7) || 7;
  if (tilMandag > 1) val.push({ navn: "Mandag", d: kl8(tilMandag), stat: 3 });
  val.push({ navn: "Om en uke", d: kl8(7), stat: 3 });
  val.push({ navn: "Venter på kunde", d: kl8(7), stat: 7, merke: "tas opp om 7 dager" });
  return val;
}

function ventKnapp(sak) {
  if (sak.status === "lukket") return "";
  const v = ventValg();
  const paaVent = sak.status === "vent";
  /* Står saken på vent, sier selve knappen det, og menyen begynner med veien ut. */
  const tekst = paaVent ? `På vent${sak.ventTil ? " til " + esc(ventTekst(sak.ventTil).replace(/ \d{2}:\d{2}$/, "")) : ""} ▾` : "På vent ▾";
  return `<button class="knapp${paaVent ? " er-paa-vent" : ""}" id="vent-b" aria-haspopup="menu" aria-expanded="false">${tekst}</button>
    <div class="meny-pop" id="vent-pop" role="menu" hidden>
      ${paaVent ? `<button role="menuitem" class="ta" data-a="aapne"><span>Åpne nå</span><span>ta av vent</span></button><div class="sep"></div>` : ""}
      <div class="h">${paaVent ? "Sett ny frist" : "Sett på vent til"}</div>
      ${v.map((x, i) => `<button role="menuitem" data-v="${i}"><span>${esc(x.navn)}</span><span>${x.merke ? esc(x.merke) : esc(ventTekst(x.d.getTime()).replace(/^\S+\s/, ""))}</span></button>`).join("")}
    </div>`;
}

/* Statusendring: én PUT på saken, i den innloggedes navn. Angre setter forrige status og frist tilbake. */
async function endreStatus(sak, kropp, tekst) {
  if (SPERRE_TIL && String(sak.nummer) !== SPERRE_TIL) return toast(`Sperret i prøvemodus: kan bare endres på #${SPERRE_TIL}.`);
  const forrige = { state_id: sak.stateId, pending_time: sak.pendingRaw };
  const forrigeStatus = sak.status;
  try {
    const t = await put(`/tickets/${sak.id}`, kropp);
    brukSvar(sak, t, kropp);
  } catch (e) {
    if (e instanceof IkkeInnlogget) return visInnlogging();
    return toast("Kunne ikke endre saken: " + e.message);
  }
  await etterEndring(sak.id);
  const fortsatt = finn(sak.id);
  /* Står man i en liste saken ikke lenger hører hjemme i, går man videre til neste sak i stedet for å bli stående på en tom. */
  if (fortsatt && !synlige().some((x) => x.id === sak.id)) {
    /* En gjenåpnet sak følger vi til fanen den nå hører hjemme i. Lukkes eller utsettes en sak, går vi videre til neste. */
    if (forrigeStatus === "lukket") { S.fane = fortsatt.status; helhet(); } else velgNeste(sak.id);
  }
  else if (fortsatt) { tegnBanner(fortsatt); tegnSakTopp(fortsatt); monterSkriveflate(fortsatt); }
  /* Meldingen sier HVILKEN sak det gjaldt: siden går videre til neste sak, og ellers ser det ut som endringen
     gjaldt den man nå står på. */
  toast(`Sak #${sak.nummer}: ${tekst}`, async () => {
    try {
      const t = await put(`/tickets/${sak.id}`, forrige);
      brukSvar(sak, t, forrige);
      await etterEndring(sak.id);
      S.fane = finn(sak.id)?.status === "lukket" ? "lukket" : finn(sak.id)?.status || S.fane;
      S.valgt = sak.id; helhet();
      toast("Satt tilbake.");
    } catch (e) { toast("Kunne ikke angre: " + e.message); }
  });
}

function velgNeste(forbiId) {
  const l = synlige().filter((x) => x.id !== forbiId);
  S.valgt = forsteSakId(l);
  /* Etter lukking eller på vent går man tilbake til lista i en smal visning (der er saken man stod på borte). */
  $("#app").classList.remove("sak-åpen");
  helhet();
  if (S.valgt && !S.artikler.has(S.valgt)) velgSak(S.valgt, true);
}

/* Eier endres med én PUT på saken, i den innloggedes navn. 1 er Zammads «ingen eier». */
async function settEier(sak, nyId) {
  if (SPERRE_TIL && String(sak.nummer) !== SPERRE_TIL) return toast(`Sperret i prøvemodus: kan bare endres på #${SPERRE_TIL}.`);
  const forrige = sak.eierId ?? INGEN_EIER, nytt = nyId || INGEN_EIER;
  if (forrige === nytt) return;
  const navn = (id) => (id === INGEN_EIER ? null : (S.agenter.find((a) => a.id === id)?.navn || S.brukere.get(id) && navnPaa(S.brukere.get(id)) || "kollega"));
  try {
    const t = await put(`/tickets/${sak.id}`, { owner_id: nytt });
    brukSvar(sak, t, { owner_id: nytt });
  } catch (e) {
    if (e instanceof IkkeInnlogget) return visInnlogging();
    return toast("Kunne ikke endre eier: " + e.message);
  }
  await etterEndring(sak.id);
  const tekst = nytt === INGEN_EIER ? "Eieren er fjernet" : nytt === S.me?.id ? "Du eier saken nå" : `Saken er gitt til ${navn(nytt)}`;
  toast(`Sak #${sak.nummer}: ${tekst}`, async () => {
    try {
      const t = await put(`/tickets/${sak.id}`, { owner_id: forrige });
      brukSvar(sak, t, { owner_id: forrige });
      await etterEndring(sak.id);
      toast("Eier satt tilbake.");
    } catch (e) { toast("Kunne ikke angre: " + e.message); }
  });
}

/* Zammads søkeindeks henger litt etter. En sak som akkurat er laget kan mangle i det første svaret,
   så vi spør noen ganger til før vi gir opp. */
async function etterOpprettet(id) {
  for (let forsok = 0; forsok < 6; forsok++) {
    try { await lastSaker(); } catch { /* prøver igjen */ }
    if (finn(id)) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  S.fane = "åpen"; S.spesial = null; S.visning = "alle"; S.filter = "";
  const sok = $("#sok"); if (sok) sok.value = "";
  if (!finn(id)) { helhet(); return toast("Saken er opprettet, men dukker opp i lista om litt."); }
  S.valgt = id;
  helhet();
  velgSak(id);
}

/* Legger svaret fra en endring rett inn i saken vi har, uten å vente på søkeindeksen. */
function brukSvar(sak, t, kropp) {
  const stateId = t.state_id ?? kropp.state_id ?? sak.stateId;
  const pend = t.pending_time !== undefined ? t.pending_time : (kropp.pending_time !== undefined ? kropp.pending_time : sak.pendingRaw);
  const b = beregnStatus(stateId, pend);
  sak.stateId = stateId; sak.pendingRaw = pend || null; sak.ventTil = b.ventTid; sak.fristNaadd = b.fristNaadd; sak.status = b.status;
  const eId = t.owner_id !== undefined ? t.owner_id : (kropp.owner_id !== undefined ? kropp.owner_id : (sak.eierId ?? INGEN_EIER));
  sak.eierId = eId && eId !== INGEN_EIER ? eId : null;
  const bruker = S.brukere.get(eId);
  sak.eier = sak.eierId ? (S.agenter.find((a) => a.id === eId)?.navn || (bruker && navnPaa(bruker)) || "kollega") : null;
  sak.venterPaaOss = sak.status === "åpen" && (sak.fristNaadd || (sak.sistKunde != null && (sak.sistOss == null || sak.sistKunde > sak.sistOss)));
  sak.oppdatert = t.updated_at || new Date().toISOString();
  /* Flytt saken mellom lista over åpne og lista over lukkede. */
  if (sak.status === "lukket") {
    S.saker = S.saker.filter((x) => x !== sak);
    if (S.lukkede && !S.lukkede.includes(sak)) S.lukkede.unshift(sak);
  } else {
    if (S.lukkede) S.lukkede = S.lukkede.filter((x) => x !== sak);
    if (!S.saker.includes(sak)) S.saker.unshift(sak);
  }
  husk(sak);
}

/* Henter lista på nytt litt etter en endring (indeksen trenger tid), uten å tegne om samtalen. */
async function utsattOppfrisk() {
  for (const ms of [1500, 3500]) {
    await new Promise((r) => setTimeout(r, ms));
    try { await lastSaker(); if (S.lukkede) await lastLukkede(); } catch { /* neste runde tar det */ }
    tegnHero(); tegnFaner(); tegnListe();
  }
}

async function etterEndring(id) {
  tegnHero(); tegnFaner(); tegnListe();
  const sak = finn(id);
  if (sak && S.valgt === id) { tegnSakTopp(sak); tegnBanner(sak); }
  utsattOppfrisk();
}

function tegnSak() {
  const sak = S.valgt ? finn(S.valgt) : null;
  if (!sak) { $("#sak").innerHTML = `<div class="tomt" style="margin:auto"><div class="w">Velg en sak</div>Saken åpnes her.</div>`; return; }
  $("#sak").innerHTML = `
    <div class="saktopp" id="sak-topp"></div>
    <div class="tråd" id="tråd"><div class="tråd-inn">
      <div id="sak-banner"></div>
      <div id="art-rot"></div>
    </div></div>
    <div id="skriv-rot" class="skriv-rot"></div>`;
  tegnSakTopp(sak);
  tegnBanner(sak);
  tegnArtikkelRot(sak);
  monterSkriveflate(sak);
  rullNed();
}

function tegnOmfang() {
  const rot = $("#omfang"); if (!rot) return;
  const vis = S.filter.trim().length >= 3;
  rot.hidden = !vis;
  if (!vis) return;
  rot.innerHTML = `<span>Søk i:</span>` +
    `<button type="button" data-o="apne" aria-pressed="${S.omfang.apne}">Åpne</button>` +
    `<button type="button" data-o="lukkede" aria-pressed="${S.omfang.lukkede}">Lukkede</button>`;
}

/* Søk i ALLE saker i Zammad, også meldingsteksten. Zammad søker på tvers av tittel, kunde og artikler. */
async function kjorSok() {
  const q = S.filter.trim();
  tegnOmfang();
  if (q.length < 3) { S.sokSeq++; S.treff = null; tegnFaner(); tegnListe(); return; }
  const seq = ++S.sokSeq;
  S.treff = { q, liste: S.treff ? S.treff.liste : [], total: 0, laster: true };
  tegnFaner(); tegnListe();
  try {
    const res = await sok(sokeSporring(q, S.omfang), 50);
    if (seq !== S.sokSeq) return;
    for (const [id, b] of brukereFra(res)) S.brukere.set(id, b);
    const liste = byggSaker(res);
    S.treff = { q, liste, total: res.total_count ?? liste.length, laster: false };
  } catch (e) {
    if (seq !== S.sokSeq) return;
    if (e instanceof IkkeInnlogget) return visInnlogging();
    S.treff = { q, liste: [], total: 0, laster: false, feil: e.message };
  }
  const l = synlige();
  if (!l.some((x) => x.id === S.valgt)) S.valgt = forsteSakId(l);
  helhet();
  if (S.valgt && !S.artikler.has(S.valgt)) velgSak(S.valgt, true);
}

function nullstillSok() {
  S.sokSeq++; S.treff = null; S.filter = "";
  const sok = $("#sok"); if (sok) sok.value = "";
  tegnOmfang();
  const l = synlige(); if (!l.some((x) => x.id === S.valgt)) S.valgt = forsteSakId(l);
  helhet();
}

function helhet() { tegnBruker(); tegnHero(); tegnFaner(); tegnOmfang(); tegnListe(); tegnSak(); }

/* ── Handlinger ──────────────────────────────────────────────────────── */

/*
 * `automatisk`: siden valgte saken selv (oppstart, ny fane, søk, etter lukking). Da vises saken i den store
 * visningen med lista ved siden av, men i en SMAL visning (som support-vinduet i RMM-et), der bare lista ELLER
 * saken vises, skal lista bli stående. Før åpnet siden alltid den første saken, så man aldri så lista først.
 * Trykker man selv på en sak, åpnes den som før.
 */
async function velgSak(id, automatisk = false) {
  S.valgt = id; S.feil = null;
  if (!automatisk) $("#app").classList.add("sak-åpen");
  tegnListe(); tegnSak();
  try {
    await lastArtikler(id);
  } catch (e) {
    if (e instanceof IkkeInnlogget) return visInnlogging();
    S.feil = { sak: id, tekst: e.message };
  }
  if (S.valgt === id) tegnSak();
}

async function byttFane(f) {
  if (S.treff) nullstillSok();
  S.fane = f; S.spesial = null;
  if (f === "lukket" && S.lukkede === null) {
    tegnFaner(); tegnListe();
    try { await lastLukkede(); } catch (e) { S.lukkede = []; toast("Kunne ikke hente lukkede saker: " + e.message); }
  }
  const lista = synlige();
  if (!lista.some((x) => x.id === S.valgt)) S.valgt = forsteSakId(lista);
  $("#app").classList.remove("sak-åpen");
  helhet();
  if (S.valgt && !S.artikler.has(S.valgt)) velgSak(S.valgt, true);
}

function visInnlogging() {
  $("#hero").innerHTML = "";
  $("#rader").innerHTML = "";
  $("#sak").innerHTML = `<div class="feil" style="margin:40px auto"><b>Du er ikke innlogget i Zammad</b>Logg inn i Zammad først, og last denne siden på nytt. Innloggingen din der brukes også her.<br><br><a class="knapp primær" href="/" target="_blank" rel="noopener">Åpne Zammad ↗</a></div>`;
  $("#app").classList.add("sak-åpen");
}

let toastT, angreFn = null;
function toast(tekst, angre) {
  $("#toast-t").textContent = tekst;
  const b = $("#toast-b"); b.hidden = !angre; angreFn = angre || null;
  $("#toast").classList.add("på");
  clearTimeout(toastT); toastT = setTimeout(() => $("#toast").classList.remove("på"), angre ? 11_000 : 4_000);
}

function koble() {
  /* `error` bobler ikke, så den fanges i fangstfasen. Et bilde som ikke finnes, fjernes og initialene vises. */
  document.addEventListener("error", (e) => { if (e.target && e.target.classList && e.target.classList.contains("prof")) e.target.remove(); }, true);
  $("#faner").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) byttFane(b.dataset.f); });
  $("#visning").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.visning = b.dataset.v; S.spesial = null;
    const l = synlige(); if (!l.some((x) => x.id === S.valgt)) S.valgt = forsteSakId(l);
    helhet();
  });
  let sokTid = 0;
  $("#sok").addEventListener("input", (e) => {
    S.filter = e.target.value;
    clearTimeout(sokTid);
    if (S.filter.trim().length < 3) { kjorSok(); if (!S.treff) tegnListe(); return; }
    sokTid = setTimeout(kjorSok, 400);
  });
  $("#sok").addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(sokTid); kjorSok(); } });
  try { S.visVent = localStorage.getItem("kvhui-vis-vent") === "1"; } catch { S.visVent = false; }
  $("#vis-vent").addEventListener("change", (e) => {
    S.visVent = e.target.checked;
    try { localStorage.setItem("kvhui-vis-vent", S.visVent ? "1" : "0"); } catch { /* ingen lagring */ }
    const l = synlige(); if (!l.some((x) => x.id === S.valgt)) S.valgt = forsteSakId(l);
    helhet();
  });
  $("#omfang").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-o]"); if (!b) return;
    const k = b.dataset.o, annet = k === "apne" ? "lukkede" : "apne";
    /* Minst ett av valgene må stå på, ellers finnes ingenting å søke i. */
    if (S.omfang[k] && !S.omfang[annet]) return;
    S.omfang[k] = !S.omfang[k];
    kjorSok();
  });
  $("#rader").addEventListener("click", (e) => { if (e.target.closest("[data-a='nullstill-sok']")) nullstillSok(); });
  $("#rader").addEventListener("click", (e) => { const r = e.target.closest(".rad"); if (r) velgSak(Number(r.dataset.id)); });
  $("#ny-b").addEventListener("click", () => apneNySak({ me: S.me, agenter: S.agenter, signatur: (gruppeId) => signaturHtml(gruppeId, { bruker: S.meBruker, sak: null }), toast, etterOpprettet }));
  $("#toast-b").addEventListener("click", () => { if (angreFn) angreFn(); });
  $("#hero").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-t]"); if (!b) return;
    const k = b.dataset.t;
    if (S.treff) { S.sokSeq++; S.treff = null; S.filter = ""; const sk = $("#sok"); if (sk) sk.value = ""; tegnOmfang(); }
    S.spesial = k === "uten" || k === "gamle" ? (S.spesial === k ? null : k) : null;
    S.fane = k === "vent" ? "vent" : "åpen";
    if (S.spesial === "uten") S.visning = "alle";
    const l = synlige(); S.valgt = forsteSakId(l);
    $("#app").classList.remove("sak-åpen");
    helhet();
    if (S.valgt && !S.artikler.has(S.valgt)) velgSak(S.valgt, true);
  });
  $("#sak").addEventListener("click", (e) => {
    const vid = e.target.closest("[data-vid]");
    if (vid && S.valgt) {
      const sak = finn(S.valgt), ar = S.artikler.get(S.valgt);
      const art = ar && ar.liste[Number(vid.dataset.vid)];
      if (sak && art) apneVideresend({ sak, artikkel: art, signatur: () => signaturHtml(sak.gruppeId, { bruker: S.meBruker, sak }), toast, ferdig: etterSending, innlogging: visInnlogging });
      return;
    }
    if (e.target.closest("[data-a='tilbake']")) $("#app").classList.remove("sak-åpen");
    const vb = e.target.closest("#vent-b");
    if (vb) { const p = $("#vent-pop"); p.hidden = !p.hidden; vb.setAttribute("aria-expanded", String(!p.hidden)); const q = $("#eier-pop"); if (q) q.hidden = true; return; }
    const vv = e.target.closest("[data-v]");
    if (vv && S.valgt) {
      const sak = finn(S.valgt), val = ventValg()[Number(vv.dataset.v)]; const p = $("#vent-pop"); if (p) p.hidden = true;
      if (sak && val) endreStatus(sak, { state_id: val.stat, pending_time: val.d.toISOString() }, val.stat === 7 ? "Venter på kunde, tas opp igjen " + ventTekst(val.d.getTime()) : "På vent til " + ventTekst(val.d.getTime()));
      return;
    }
    const ha = e.target.closest("[data-a]");
    if (ha && S.valgt) {
      const sak = finn(S.valgt);
      if (sak && ha.dataset.a === "lukk") { endreStatus(sak, { state_id: 4 }, "Saken er lukket"); return; }
      if (sak && ha.dataset.a === "aapne") { endreStatus(sak, { state_id: 2, pending_time: null }, "Saken er åpen igjen"); return; }
    }
    const eb = e.target.closest("#eier-b");
    if (eb) { const p = $("#eier-pop"); p.hidden = !p.hidden; eb.setAttribute("aria-expanded", String(!p.hidden)); const q = $("#vent-pop"); if (q) q.hidden = true; return; }
    const ev = e.target.closest("[data-e]");
    if (ev && S.valgt) { const sak = finn(S.valgt); const p = $("#eier-pop"); if (p) p.hidden = true; if (sak) settEier(sak, Number(ev.dataset.e)); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".handlinger")) document.querySelectorAll(".meny-pop").forEach((p) => { p.hidden = true; }); });
  document.addEventListener("click", (e) => {
    if (e.target.matches(".boble img")) { $("#lys-bilde").src = e.target.src; $("#lys").classList.add("på"); }
  });
  $("#lys").addEventListener("click", () => $("#lys").classList.remove("på"));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("#lys").classList.remove("på"); document.querySelectorAll(".meny-pop").forEach((p) => { p.hidden = true; }); } });
  $("#tema").addEventListener("click", () => {
    const r = document.documentElement;
    const mork = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    r.dataset.theme = mork ? "light" : "dark";
    try { localStorage.setItem("kvhui-tema", r.dataset.theme); } catch { /* privat vindu */ }
  });
  const innbygd = !!document.documentElement.dataset.innbygd;
  /* Innbygd følger temaet RMM-et sier, ikke det som er lagret her. */
  if (!innbygd) { try { const t = localStorage.getItem("kvhui-tema"); if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; } catch { /* ingen lagring */ } }
  /* RMM-et kan si fra at temaet er byttet. Bare meldinger fra RMM-ets opprinnelse tas imot. */
  window.addEventListener("message", (e) => {
    if (e.origin !== RMM_OPPRINNELSE || !innbygd || !e.data || e.data.type !== "kvhui-tema") return;
    if (e.data.tema === "lys") document.documentElement.dataset.theme = "light";
    else if (e.data.tema === "mork") document.documentElement.dataset.theme = "dark";
  });
}

/* Oppdaterer lista hvert minutt mens vinduet er synlig, og samtalen hvis saken er endret. */
async function oppfrisk() {
  if (document.hidden) return;
  try {
    const eierFoer = S.valgt ? finn(S.valgt)?.eierId : undefined;
    await lastSaker();
    if (S.fane === "lukket") await lastLukkede();
    const sak = S.valgt ? finn(S.valgt) : null;
    /* Eieren kan være endret av en kollega: tegn toppen på nytt, men bare da (åpen meny skal ikke lukkes av seg selv). */
    if (sak && sak.eierId !== eierFoer) tegnSakTopp(sak);
    const ar = S.valgt ? S.artikler.get(S.valgt) : null;
    const endret = sak && ar && sak.oppdatert !== ar.oppdatert;
    if (endret) await lastArtikler(S.valgt);
    tegnHero(); tegnFaner(); tegnListe();
    if (endret) { const s2 = finn(S.valgt); if (s2) tegnArtikkelRot(s2); }
  } catch (e) {
    if (e instanceof IkkeInnlogget) visInnlogging();
  }
}

/*
 * TASTATURET PÅ iOS. Safari krymper ikke siden når tastaturet kommer opp: det synlige området (`visualViewport`) blir
 * lavere, men siden er like høy, så skriveflata nederst havnet BAK tastaturet og man skrev i blinde. Nå følger
 * saksvisningen det synlige området (`--vvh` og `--vvt`, brukt av app.css), og samtalen ruller ned igjen så siste melding
 * står rett over feltet.
 */
function folgTastaturet() {
  const vv = window.visualViewport;
  if (!vv) return;
  const sett = () => {
    const rot = document.documentElement.style;
    rot.setProperty("--vvh", `${Math.round(vv.height)}px`);
    rot.setProperty("--vvt", `${Math.round(vv.offsetTop)}px`);
    if ($("#app") && $("#app").classList.contains("sak-åpen")) rullNed();
  };
  vv.addEventListener("resize", sett);
  vv.addEventListener("scroll", sett);
  sett();
}

/* Hvilken versjon som kjører, fra bygget. Står nederst i lista: «ingen endring» er umulig å sjekke uten. */
async function visVersjon() {
  try {
    const r = await fetch("/kvhui/versjon.txt", { cache: "no-store" });
    const t = r.ok ? (await r.text()).trim() : "";
    if (/^[0-9a-f]{4,40}$/i.test(t)) $("#versjon").textContent = `Versjon ${t}`;
  } catch { /* uten versjonslinje */ }
}

export async function start() {
  koble();
  visVersjon();
  folgTastaturet();
  $("#rader").innerHTML = `<div class="laster">Henter saker …</div>`;
  try {
    const sess = await hent("/signshow");
    const b = sess.session;
    if (!b || !b.id) return visInnlogging();
    S.me = { id: b.id, navn: navnPaa(b) };
    S.meBruker = b;
    S.brukere.set(b.id, b);
    await lastSaker();
    try { await lastAgenter(); } catch { /* eiermenyen mangler kollegaer, men siden virker */ }
  } catch (e) {
    if (e instanceof IkkeInnlogget) return visInnlogging();
    $("#rader").innerHTML = `<div class="feil"><b>Kunne ikke hente saker</b>${esc(e.message)}</div>`;
    return;
  }
  const lista = synlige();
  S.valgt = forsteSakId(lista);
  helhet();
  if (S.valgt) velgSak(S.valgt, true);
  setInterval(oppfrisk, 60_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) oppfrisk(); });
}
