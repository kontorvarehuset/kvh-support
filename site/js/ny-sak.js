/*
 * Ny sak: e-post ut til en kunde, eller logg en telefonsamtale.
 *
 * Zammad lager kunden selv hvis adressen ikke finnes (`customer_id: "guess:adresse"`), og en sak
 * fra «Send e-post» sender e-posten fra supportadressen i den innloggedes navn.
 *
 * Prøvesperren (`SPERRE_NY_EPOST`) er fjernet. Settes den til en adresse, nekter siden alle andre kunder igjen.
 */

import { hent, post, IkkeInnlogget } from "./api.js";
import { tilHtml, kobleFelt } from "./skriv.js";
import { navnPaa } from "./modell.js";

/* Fjernet 15. okt. 2026 etter at Frank godkjente testen. Settes til en adresse for å begrense «Ny sak» igjen. */
export const SPERRE_NY_EPOST = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const gyldig = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/**
 * Selve forespørselen, uten DOM, så den kan prøves. `valg`: {kanal: "epost"|"telefon", kunde: {id?, epost},
 * cc: [], emne, html, gruppeId, eierId}.
 */
export function byggSakKropp(valg) {
  const epost = valg.kanal === "epost";
  const kunde = valg.kunde.id ? valg.kunde.id : `guess:${valg.kunde.epost}`;
  const artikkel = epost
    ? { subject: valg.emne, body: valg.html, content_type: "text/html", type: "email", sender: "Agent", internal: false, to: valg.kunde.epost }
    /* Telefon: kunden «sa» det, så avsenderen er Customer og typen phone. Ingen e-post sendes. */
    : { subject: valg.emne, body: valg.html, content_type: "text/html", type: "phone", sender: "Customer", internal: false };
  if (epost && valg.cc && valg.cc.length) artikkel.cc = valg.cc.join(", ");
  const kropp = { title: valg.emne, group_id: valg.gruppeId, customer_id: kunde, state: "open", article: artikkel };
  if (valg.eierId) kropp.owner_id = valg.eierId;
  return kropp;
}

/** Brukere fra et søkesvar, uansett om Zammad gir en liste eller {record_ids, assets}. */
export function brukereFraSok(svar) {
  let liste = [];
  if (Array.isArray(svar)) liste = svar;
  else if (svar && svar.assets && svar.assets.User) {
    const U = svar.assets.User, O = svar.assets.Organization || {};
    const ider = svar.record_ids || svar.user_ids || Object.keys(U);
    liste = ider.map((id) => U[id]).filter(Boolean).map((b) => ({ ...b, organization: b.organization || (O[b.organization_id] && O[b.organization_id].name) || "" }));
  }
  return liste.filter((b) => b && b.email).map((b) => ({
    id: b.id, navn: navnPaa(b), epost: b.email, org: typeof b.organization === "string" ? b.organization : (b.organization && b.organization.name) || "",
  }));
}

let gruppeCache = null;
async function hentGrupper() {
  if (!gruppeCache) gruppeCache = (await hent("/groups")).filter((g) => g.active !== false).map((g) => ({ id: g.id, navn: g.name }));
  return gruppeCache;
}

export async function apneNySak(ctx) {
  let rot = document.getElementById("ark-bak");
  if (rot) rot.remove();
  rot = document.createElement("div");
  rot.id = "ark-bak"; rot.className = "ark-bak på";
  rot.innerHTML = `<div class="ark" role="dialog" aria-modal="true" aria-labelledby="ark-t">
    <div class="ark-topp"><h3 id="ark-t">Ny sak</h3><button type="button" class="ikon" id="ns-lukk" aria-label="Lukk"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="ark-rader">
      <div class="kanal" role="group" aria-label="Type henvendelse"><button type="button" data-k="epost" aria-pressed="true">Send e-post</button><button type="button" data-k="telefon" aria-pressed="false">Logg telefonsamtale</button></div>
      <div class="fl"><span>Kunde</span>
        <input id="ns-sok" type="search" autocomplete="off" placeholder="Søk på navn, e-post eller firma, eller skriv en ny e-postadresse" aria-label="Kunde">
        <div id="ns-valgt"></div><div id="ns-treff" role="listbox"></div></div>
      <div class="fl" id="ns-cc-rad"><span>Cc</span><div class="ccrad" id="ns-cc" style="padding:6px 10px;border:1px solid var(--kant);border-radius:10px;background:var(--raised)"></div></div>
      <label class="fl"><span>Emne</span><input id="ns-emne" placeholder="Hva gjelder det?"></label>
      <div class="fl"><span id="ns-mld-l">Melding til kunden</span><div class="felt" id="ns-felt" contenteditable="true" role="textbox" aria-multiline="true" style="border:1px solid var(--kant);border-radius:12px;background:var(--raised);position:relative"></div></div>
      <div class="to-kol">
        <label class="fl"><span>Gruppe</span><select id="ns-gruppe"></select></label>
        <label class="fl"><span>Eier</span><select id="ns-eier"></select></label>
      </div>
      ${SPERRE_NY_EPOST ? `<div class="les-merknad" style="margin:0"><span><b>Prøvemodus:</b> bare testbrukeren (${esc(SPERRE_NY_EPOST)}) kan velges som kunde.</span></div>` : ""}
    </div>
    <div class="ark-bunn"><span class="hint">Lim inn eller dra skjermbilder rett i meldingen</span><button type="button" class="knapp" id="ns-avbryt">Avbryt</button><button type="button" class="knapp oransje" id="ns-opprett">Opprett og send</button></div>
  </div>`;
  document.body.appendChild(rot);

  const $ = (s) => rot.querySelector(s);
  const S = { kanal: "epost", kunde: null, cc: [] };
  const lukk = () => rot.remove();
  $("#ns-lukk").addEventListener("click", lukk); $("#ns-avbryt").addEventListener("click", lukk);
  rot.addEventListener("mousedown", (e) => { if (e.target === rot) lukk(); });
  rot.addEventListener("keydown", (e) => { if (e.key === "Escape") lukk(); });

  try {
    const grupper = await hentGrupper();
    const sist = (() => { try { return Number(localStorage.getItem("kvhui-gruppe")); } catch { return 0; } })();
    const standard = grupper.find((g) => g.id === sist) || grupper.find((g) => g.navn === "IT") || grupper[0];
    $("#ns-gruppe").innerHTML = grupper.map((g) => `<option value="${g.id}"${standard && g.id === standard.id ? " selected" : ""}>${esc(g.navn)}</option>`).join("");
  } catch (e) {
    $("#ns-gruppe").innerHTML = `<option value="">(kunne ikke hente grupper)</option>`;
  }
  $("#ns-eier").innerHTML = `<option value="${ctx.me.id}">Meg</option>` +
    ctx.agenter.filter((a) => a.id !== ctx.me.id).map((a) => `<option value="${a.id}">${esc(a.navn)}</option>`).join("") + `<option value="">Ingen eier</option>`;

  const oppdaterKanal = () => {
    rot.querySelectorAll(".kanal button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === S.kanal)));
    $("#ns-mld-l").textContent = S.kanal === "epost" ? "Melding til kunden" : "Hva ble sagt i samtalen?";
    $("#ns-opprett").textContent = S.kanal === "epost" ? "Opprett og send" : "Opprett saken";
    $("#ns-cc-rad").hidden = S.kanal !== "epost";
  };
  rot.querySelector(".kanal").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { S.kanal = b.dataset.k; oppdaterKanal(); } });
  oppdaterKanal();

  const tegnKunde = () => {
    $("#ns-valgt").innerHTML = S.kunde
      ? `<span class="cc-chip" style="margin-top:6px">${esc(S.kunde.navn || S.kunde.epost)}${S.kunde.org ? " · " + esc(S.kunde.org) : ""} · ${esc(S.kunde.epost)}${S.kunde.id ? "" : " (ny kunde)"}<button type="button" data-fjern aria-label="Fjern kunde">×</button></span>`
      : "";
    $("#ns-sok").hidden = !!S.kunde;
  };
  $("#ns-valgt").addEventListener("click", (e) => { if (e.target.closest("[data-fjern]")) { S.kunde = null; tegnKunde(); $("#ns-sok").value = ""; $("#ns-sok").focus(); } });

  let tidtaker = 0, treff = [];
  const tegnTreff = (q) => {
    const ny = gyldig(q) && !treff.some((t) => t.epost.toLowerCase() === q.toLowerCase());
    $("#ns-treff").innerHTML = (treff.length || ny)
      ? `<div class="meny-pop" style="position:static;width:auto;margin-top:6px;box-shadow:var(--shadow)">${treff.map((t, i) => `<button type="button" data-t="${i}"><span>${esc(t.navn)}${t.org ? " · " + esc(t.org) : ""}</span><span>${esc(t.epost)}</span></button>`).join("")}${ny ? `<button type="button" data-ny="${esc(q)}"><span>Ny kunde fra adressen</span><span>${esc(q)}</span></button>` : ""}</div>`
      : (q.length >= 2 ? `<div class="hint" style="padding:6px 2px">Ingen treff. Skriv en hel e-postadresse for å lage en ny kunde.</div>` : "");
  };
  $("#ns-sok").addEventListener("input", (e) => {
    const q = e.target.value.trim();
    clearTimeout(tidtaker);
    if (q.length < 2) { treff = []; tegnTreff(q); return; }
    tidtaker = setTimeout(async () => {
      try { treff = brukereFraSok(await hent("/users/search?" + new URLSearchParams({ query: q, limit: "8", expand: "true" }))); }
      catch (err) { if (err instanceof IkkeInnlogget) return; treff = []; }
      if ($("#ns-sok").value.trim() === q) tegnTreff(q);
    }, 250);
  });
  $("#ns-treff").addEventListener("click", (e) => {
    const t = e.target.closest("[data-t]"), n = e.target.closest("[data-ny]");
    if (t) S.kunde = treff[Number(t.dataset.t)];
    else if (n) S.kunde = { id: null, navn: "", epost: n.dataset.ny, org: "" };
    else return;
    $("#ns-treff").innerHTML = ""; tegnKunde();
  });

  /* Cc */
  const tegnCc = () => {
    $("#ns-cc").innerHTML = S.cc.map((e, i) => `<span class="cc-chip">${esc(e)}<button type="button" data-i="${i}" aria-label="Fjern ${esc(e)}">×</button></span>`).join(" ") +
      `<input class="cc-inn" id="ns-cc-inn" type="email" placeholder="${S.cc.length ? "" : "Legg til e-postadresse …"}" aria-label="Cc">`;
    const inn = $("#ns-cc-inn");
    const legg = () => { const v = inn.value.trim().replace(/[,;]$/, ""); if (!v) return; if (!gyldig(v)) return ctx.toast(`«${v}» er ikke en gyldig e-postadresse.`); if (!S.cc.includes(v)) S.cc.push(v); tegnCc(); $("#ns-cc-inn").focus(); };
    inn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "," || e.key === ";") { e.preventDefault(); legg(); } else if (e.key === "Backspace" && !inn.value) { S.cc.pop(); tegnCc(); $("#ns-cc-inn").focus(); } });
    inn.addEventListener("blur", legg);
  };
  $("#ns-cc").addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) { S.cc.splice(Number(b.dataset.i), 1); tegnCc(); } });
  tegnCc(); tegnKunde();

  const felt = $("#ns-felt");
  felt.dataset.tom = "Skriv her …";
  kobleFelt(felt, felt.parentElement);

  $("#ns-opprett").addEventListener("click", async () => {
    const emne = $("#ns-emne").value.trim();
    if (!S.kunde) return ctx.toast("Velg en kunde først.");
    if (SPERRE_NY_EPOST && S.kunde.epost.toLowerCase() !== SPERRE_NY_EPOST.toLowerCase()) return ctx.toast(`Sperret i prøvemodus: bare ${SPERRE_NY_EPOST} kan velges som kunde.`);
    if (!emne) { ctx.toast("Skriv et emne først."); return $("#ns-emne").focus(); }
    const { html, tomt } = tilHtml(felt);
    if (tomt) return ctx.toast("Skriv en melding først.");
    const gruppeId = Number($("#ns-gruppe").value);
    if (!gruppeId) return ctx.toast("Velg en gruppe først.");
    const kropp = byggSakKropp({ kanal: S.kanal, kunde: S.kunde, cc: S.cc, emne, html, gruppeId, eierId: Number($("#ns-eier").value) || 0 });
    const knapp = $("#ns-opprett"); knapp.disabled = true; knapp.textContent = "Oppretter …";
    try {
      const sak = await post("/tickets", kropp);
      try { localStorage.setItem("kvhui-gruppe", String(gruppeId)); } catch { /* ingen lagring */ }
      lukk();
      ctx.toast(S.kanal === "epost" ? `Sak #${sak.number} opprettet og sendt til ${S.kunde.epost}` : `Sak #${sak.number} opprettet fra telefonsamtalen`);
      await ctx.etterOpprettet(sak.id);
    } catch (e) {
      knapp.disabled = false; oppdaterKanal();
      ctx.toast("Kunne ikke opprette saken: " + e.message);
    }
  });
  $("#ns-sok").focus();
}
