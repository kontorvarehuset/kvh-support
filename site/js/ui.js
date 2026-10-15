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

import { hent, IkkeInnlogget } from "./api.js";
import {
  STATUSNAVN_APNE, byggSaker, brukereFra, byggArtikkel, navnPaa, initialer,
  kortTid, langTid, ventTekst, skillSitat, erBilde, storrelseTekst,
} from "./modell.js";
import { rens } from "./rens.js";
import { monter, planleggSending } from "./skriv.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = {
  me: null,
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

async function lastSaker() {
  const res = await sok(APNE_SPORRING, 200);
  for (const [id, b] of brukereFra(res)) S.brukere.set(id, b);
  S.saker = byggSaker(res);
  S.mer = (res.total_count || 0) > S.saker.length;
}

async function lastLukkede() {
  const res = await sok("state.name:closed AND updated_at:[now-30d TO now]", 100);
  for (const [id, b] of brukereFra(res)) S.brukere.set(id, b);
  S.lukkede = byggSaker(res);
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

const alle = () => [...S.saker, ...(S.lukkede || [])];
const finn = (id) => alle().find((x) => x.id === id);

/* ── Utvalg ──────────────────────────────────────────────────────────── */

function synlige() {
  const kilde = S.fane === "lukket" ? (S.lukkede || []) : S.saker.filter((x) => x.status === S.fane);
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
    ? `<span class="mini-av">${esc(initialer(S.me.navn))}</span><span class="bn">${esc(S.me.navn)}</span>`
    : "";
}

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
      `<button data-t="${k}" class="${kl}" aria-pressed="${!!paa}" title="${esc(t)}" aria-label="${n} ${esc(e.toLowerCase())}"><span class="e">${esc(e)}</span><span class="n">${n}</span><span class="u">${esc(u)}</span></button>`).join("")}</div>`;
  const ny = apne.filter((x) => x.venterPaaOss || !x.eier).length;
  document.title = (ny ? `(${ny}) ` : "") + "KVH Support";
}

function tegnFaner() {
  const n = (s) => S.saker.filter((x) => x.status === s).length;
  const F = [["åpen", "Åpne", n("åpen")], ["vent", "På vent", n("vent")], ["lukket", "Lukket", S.lukkede ? S.lukkede.length : null]];
  $("#faner").innerHTML = F.map(([k, nn, t]) =>
    `<button role="tab" aria-selected="${k === S.fane}" data-f="${k}">${nn}<span class="t">${t ?? ""}</span></button>`).join("");
  /* Tallene under Alle/Mine gjelder fanen man står i, ikke «alt som ikke er lukket».
     Med 7 under Alle og 2 i lista så det ut som en feil, selv om begge var riktige. */
  const kilde = S.fane === "lukket" ? (S.lukkede || []) : S.saker.filter((x) => x.status === S.fane);
  $("#visning").innerHTML =
    `<button data-v="alle" aria-pressed="${S.visning === "alle"}">Alle saker<span class="t">${kilde.length}</span></button>` +
    `<button data-v="mine" aria-pressed="${S.visning === "mine"}">Mine saker<span class="t">${kilde.filter((x) => x.eierId === S.me?.id).length}</span></button>`;
}

function tegnListe() {
  if (S.fane === "lukket" && S.lukkede === null && !S.feil) { $("#rader").innerHTML = `<div class="laster">Henter lukkede saker …</div>`; return; }
  const rader = synlige();
  if (!rader.length) {
    $("#rader").innerHTML = `<div class="tomt"><div class="w">${S.filter ? "Ingen treff" : S.visning === "mine" ? "Ingen saker på deg" : S.fane === "åpen" ? "Alt er besvart" : "Ingenting her"}</div>${S.filter ? "Prøv et annet søkeord." : ""}</div>`;
    return;
  }
  $("#rader").innerHTML = rader.map((x) => {
    const m = [];
    if (x.status === "vent") m.push(`<span class="chip vent">${x.ventTil ? "Til " + esc(ventTekst(x.ventTil)) : "Venter på svar"}</span>`);
    if (x.status === "lukket") m.push(`<span class="chip ok">Lukket</span>`);
    if (x.fristNaadd) m.push(`<span class="chip ingen">Påminnelsen er nådd</span>`);
    if (x.dager >= 1) m.push(`<span class="chip vent">Venter ${x.dager} d</span>`);
    if (!x.eier && x.status !== "lukket") m.push(`<span class="chip ingen">Uten eier</span>`);
    const eierPrikk = x.eier ? `<span class="mini-av ${x.eierId === S.me?.id ? "" : "andre"}" title="${esc(x.eier)}">${esc(initialer(x.eier))}</span>` : "";
    return `<button class="rad" data-id="${x.id}" aria-current="${x.id === S.valgt}">
      ${x.venterPaaOss ? '<span class="prikk" aria-label="Venter på svar fra oss"></span>' : ""}
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
  const hode = (a) => {
    const under = a.slag === "notat" ? `<span style="color:var(--stale);font-size:12.5px">Kunden ser ikke dette</span>` : "";
    return `<div class="hode"><b>${esc(a.navn)}</b><span class="rolle">${ROLLE[a.slag]}</span>${under}<span class="tid">${esc(langTid(a.tid))}</span></div>`;
  };
  return liste.map((a, i) => a.slag === "system"
    ? `<div class="hend"><span class="sys">${esc(a.emne || "Automatisk melding")}</span> · ${esc(langTid(a.tid))}</div>`
    : `<article class="mld ${a.slag}">
        <div class="av" aria-hidden="true">${esc(initialer(a.navn))}</div>
        <div>${hode(a)}
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
    const rest = a.vedlegg.filter((v) => !(v.cid && bruktCid.has(v.cid)));
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
  monter(rot, { sak, toast, planlegg: (j) => planleggSending(j, { toast, ferdig: etterSending, feilet: feilVedSending }) });
}

async function etterSending(j) {
  try {
    await lastSaker();
    await lastArtikler(j.saksId);
  } catch (e) { toast("Sendt, men kunne ikke oppdatere visningen: " + e.message); }
  tegnHero(); tegnFaner(); tegnListe();
  const sak = finn(j.saksId);
  if (S.valgt === j.saksId && sak) { tegnArtikkelRot(sak); const t = $("#tråd"); if (t) t.scrollTop = t.scrollHeight; }
}

function feilVedSending(j, e) {
  toast("Ikke sendt: " + e.message);
}

function tegnSak() {
  const sak = S.valgt ? finn(S.valgt) : null;
  if (!sak) { $("#sak").innerHTML = `<div class="tomt" style="margin:auto"><div class="w">Velg en sak</div>Saken åpnes her.</div>`; return; }
  const banner = sak.status === "vent"
    ? `<div class="banner vent"><span>På vent${sak.ventTil ? " til " + esc(ventTekst(sak.ventTil)) : ", venter på svar"}.</span></div>`
    : sak.status === "lukket" ? `<div class="banner lukket"><span>Saken er lukket. Åpne den i Zammad for å svare.</span></div>` : "";
  $("#sak").innerHTML = `
    <div class="saktopp">
      <button class="tilbake" data-a="tilbake">‹ Saker</button>
      <div class="tekst">
        <div class="meta"><span class="mono">#${esc(sak.nummer)}</span><span>·</span><span>${esc(sak.kunde)}</span></div>
        <h2>${esc(sak.emne)}</h2>
        <div class="fra">${esc(sak.fra)}${sak.epost ? " · " + esc(sak.epost) : ""} · ${sak.eier ? "Eier: " + esc(sak.eier) : "Uten eier"}</div>
      </div>
      <div class="handlinger"><a class="knapp primær" href="/#ticket/zoom/${sak.id}" target="_blank" rel="noopener">Åpne i Zammad ↗</a></div>
    </div>
    <div class="tråd" id="tråd"><div class="tråd-inn">
      ${banner}
      <div id="art-rot"></div>
      <div id="skriv-rot"></div>
    </div></div>`;
  tegnArtikkelRot(sak);
  monterSkriveflate(sak);
  const t = $("#tråd"); if (t) t.scrollTop = t.scrollHeight;
}

function helhet() { tegnBruker(); tegnHero(); tegnFaner(); tegnListe(); tegnSak(); }

/* ── Handlinger ──────────────────────────────────────────────────────── */

async function velgSak(id) {
  S.valgt = id; S.feil = null;
  $("#app").classList.add("sak-åpen");
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
  S.fane = f; S.spesial = null;
  if (f === "lukket" && S.lukkede === null) {
    tegnFaner(); tegnListe();
    try { await lastLukkede(); } catch (e) { S.lukkede = []; toast("Kunne ikke hente lukkede saker: " + e.message); }
  }
  const lista = synlige();
  if (!lista.some((x) => x.id === S.valgt)) S.valgt = lista.length ? lista[0].id : null;
  $("#app").classList.remove("sak-åpen");
  helhet();
  if (S.valgt && !S.artikler.has(S.valgt)) velgSak(S.valgt);
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
  $("#faner").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) byttFane(b.dataset.f); });
  $("#visning").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.visning = b.dataset.v; S.spesial = null;
    const l = synlige(); if (!l.some((x) => x.id === S.valgt)) S.valgt = l.length ? l[0].id : null;
    helhet();
  });
  $("#sok").addEventListener("input", (e) => { S.filter = e.target.value; tegnListe(); });
  $("#rader").addEventListener("click", (e) => { const r = e.target.closest(".rad"); if (r) velgSak(Number(r.dataset.id)); });
  $("#toast-b").addEventListener("click", () => { if (angreFn) angreFn(); });
  $("#hero").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-t]"); if (!b) return;
    const k = b.dataset.t;
    S.spesial = k === "uten" || k === "gamle" ? (S.spesial === k ? null : k) : null;
    S.fane = k === "vent" ? "vent" : "åpen";
    if (S.spesial === "uten") S.visning = "alle";
    const l = synlige(); S.valgt = l.length ? l[0].id : null;
    $("#app").classList.remove("sak-åpen");
    helhet();
    if (S.valgt && !S.artikler.has(S.valgt)) velgSak(S.valgt);
  });
  $("#sak").addEventListener("click", (e) => { if (e.target.closest("[data-a='tilbake']")) $("#app").classList.remove("sak-åpen"); });
  document.addEventListener("click", (e) => {
    if (e.target.matches(".boble img")) { $("#lys-bilde").src = e.target.src; $("#lys").classList.add("på"); }
  });
  $("#lys").addEventListener("click", () => $("#lys").classList.remove("på"));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#lys").classList.remove("på"); });
  $("#tema").addEventListener("click", () => {
    const r = document.documentElement;
    const mork = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    r.dataset.theme = mork ? "light" : "dark";
    try { localStorage.setItem("kvhui-tema", r.dataset.theme); } catch { /* privat vindu */ }
  });
  try { const t = localStorage.getItem("kvhui-tema"); if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; } catch { /* ingen lagring */ }
}

/* Oppdaterer lista hvert minutt mens vinduet er synlig, og samtalen hvis saken er endret. */
async function oppfrisk() {
  if (document.hidden) return;
  try {
    await lastSaker();
    if (S.fane === "lukket") await lastLukkede();
    const sak = S.valgt ? finn(S.valgt) : null;
    const ar = S.valgt ? S.artikler.get(S.valgt) : null;
    const endret = sak && ar && sak.oppdatert !== ar.oppdatert;
    if (endret) await lastArtikler(S.valgt);
    tegnHero(); tegnFaner(); tegnListe();
    if (endret) { const s2 = finn(S.valgt); if (s2) tegnArtikkelRot(s2); }
  } catch (e) {
    if (e instanceof IkkeInnlogget) visInnlogging();
  }
}

export async function start() {
  koble();
  $("#rader").innerHTML = `<div class="laster">Henter saker …</div>`;
  try {
    const sess = await hent("/signshow");
    const b = sess.session;
    if (!b || !b.id) return visInnlogging();
    S.me = { id: b.id, navn: navnPaa(b) };
    S.brukere.set(b.id, b);
    await lastSaker();
  } catch (e) {
    if (e instanceof IkkeInnlogget) return visInnlogging();
    $("#rader").innerHTML = `<div class="feil"><b>Kunne ikke hente saker</b>${esc(e.message)}</div>`;
    return;
  }
  const lista = synlige();
  S.valgt = lista.length ? lista[0].id : null;
  helhet();
  if (S.valgt) velgSak(S.valgt);
  setInterval(oppfrisk, 60_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) oppfrisk(); });
}
