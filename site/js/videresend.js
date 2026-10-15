/*
 * Videresend en melding på e-post, til noen utenfor saken.
 *
 * Det som sendes er innholdet i en melding fra saken (kundens, vårt eller et notat), pakket inn med «Videresendt
 * melding» og de opprinnelige opplysningene. Mottakerne er som regel EKSTERNE, så dialogen sier det rett ut og
 * viser nøyaktig hva som følger med før noe sendes. Svar fra mottakeren kommer tilbake i samme sak
 * (emnet har saksnummeret).
 *
 * HTML fra e-posten går gjennom `rens()` før den legges inn: det vi videresender er like fritt for skript
 * som det vi viser. Bilder som bare finnes som vedlegg i saken (cid:) tas ut av teksten og sendes som
 * vedlegg i stedet, siden en adresse inn i Zammad ikke virker for en fremmed.
 */

import { hent, post, IkkeInnlogget } from "./api.js";
import { tilHtml, kobleFelt } from "./skriv.js";
import { rens } from "./rens.js";
import { langTid, erBilde } from "./modell.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const gyldig = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const MAKS_VEDLEGG_BYTES = 15 * 1024 * 1024;

/** Ren tekst til HTML med linjeskift. */
export const tekstTilHtml = (t) => esc(t).replace(/\r?\n/g, "<br>");

/**
 * Den videresendte meldingen som HTML: overskrift med de opprinnelige opplysningene, så selve innholdet.
 * `innholdHtml` er allerede renset.
 */
export function pakkInn(artikkel, innholdHtml) {
  const rad = (k, v) => (v ? `<div><b>${k}:</b> ${esc(v)}</div>` : "");
  return `<div>---------- Videresendt melding ----------</div>` +
    rad("Fra", artikkel.navn) + rad("Dato", langTid(artikkel.tid)) + rad("Emne", artikkel.emne) + rad("Til", artikkel.til) +
    `<br><div>${innholdHtml}</div>`;
}

/** Selve forespørselen, uten DOM, så den kan prøves. */
export function byggVideresendKropp({ sak, til, cc, emne, html, vedlegg }) {
  const kropp = {
    ticket_id: sak.id, type: "email", internal: false, sender: "Agent",
    content_type: "text/html", subject: emne, body: html, to: til.join(", "),
  };
  if (cc && cc.length) kropp.cc = cc.join(", ");
  if (vedlegg && vedlegg.length) kropp.attachments = vedlegg;
  return kropp;
}

/** Innholdet i meldingen som renset HTML. Cid-bilder fjernes (de sendes som vedlegg). */
function innholdSomHtml(a) {
  if (!a.html) return tekstTilHtml(a.tekst);
  const r = rens(a.tekst, { cidTilUrl: () => null });
  const rot = document.createElement("div");
  rot.appendChild(r.svar);
  if (r.sitat) rot.appendChild(r.sitat);
  return rot.innerHTML;
}

async function tilBase64(blob) {
  return new Promise((ok, feil) => {
    const l = new FileReader();
    l.onload = () => ok(String(l.result).split(",")[1] || "");
    l.onerror = () => feil(new Error("Kunne ikke lese vedlegget"));
    l.readAsDataURL(blob);
  });
}

async function hentVedlegg(a, valgte) {
  const ut = [];
  for (const v of valgte) {
    const r = await fetch(`/api/v1/ticket_attachment/${a.ticketId}/${a.id}/${v.id}`, { credentials: "include", cache: "no-store" });
    if (!r.ok) throw new Error(`Kunne ikke hente vedlegget «${v.navn}» (${r.status})`);
    const blob = await r.blob();
    ut.push({ filename: v.navn, data: await tilBase64(blob), "mime-type": v.mime || blob.type || "application/octet-stream" });
  }
  return ut;
}

export function apneVideresend(ctx) {
  const { sak, artikkel: a } = ctx;
  let rot = document.getElementById("vid-bak");
  if (rot) rot.remove();
  const vedleggListe = a.vedlegg.filter((v) => !v.skjul);
  const storrelse = vedleggListe.reduce((s, v) => s + (v.storrelse || 0), 0);
  const forStort = storrelse > MAKS_VEDLEGG_BYTES;
  rot = document.createElement("div");
  rot.id = "vid-bak"; rot.className = "ark-bak på";
  rot.innerHTML = `<div class="ark" role="dialog" aria-modal="true" aria-labelledby="vid-t">
    <div class="ark-topp"><h3 id="vid-t">Videresend melding</h3><button type="button" class="ikon" id="vid-lukk" aria-label="Lukk"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="ark-rader">
      <div class="les-merknad" style="margin:0"><span><b>Sendes til andre enn kunden.</b> Sjekk mottakerne og innholdet under før du sender.</span></div>
      <div class="fl"><span>Til</span><div class="ccrad" id="vid-til" style="padding:6px 10px;border:1px solid var(--kant);border-radius:10px;background:var(--raised)"></div></div>
      <div class="fl"><span>Cc</span><div class="ccrad" id="vid-cc" style="padding:6px 10px;border:1px solid var(--kant);border-radius:10px;background:var(--raised)"></div></div>
      <label class="fl"><span>Emne</span><input id="vid-emne"></label>
      <div class="fl"><span>Din melding (valgfri)</span><div class="felt" id="vid-felt" contenteditable="true" role="textbox" aria-multiline="true" style="border:1px solid var(--kant);border-radius:12px;background:var(--raised);position:relative;min-height:70px"></div></div>
      <div class="fl"><span>Det som videresendes</span><div id="vid-orig" style="max-height:200px;overflow:auto;border:1px dashed var(--kant);border-radius:12px;padding:10px 14px;background:var(--card)"></div></div>
      ${vedleggListe.length ? `<label class="omfang" style="gap:8px"><input type="checkbox" id="vid-vedlegg" ${forStort ? "" : "checked"} ${forStort ? "disabled" : ""}> Ta med ${vedleggListe.length} vedlegg (${vedleggListe.map((v) => esc(v.navn)).join(", ")})${forStort ? " — for store til å sende (over 15 MB)" : ""}</label>` : ""}
    </div>
    <div class="ark-bunn"><span class="hint">Svar fra mottakeren kommer tilbake i denne saken</span><button type="button" class="knapp" id="vid-avbryt">Avbryt</button><button type="button" class="knapp oransje" id="vid-send">Videresend</button></div>
  </div>`;
  document.body.appendChild(rot);
  const $ = (s) => rot.querySelector(s);
  const lukk = () => rot.remove();
  $("#vid-lukk").addEventListener("click", lukk); $("#vid-avbryt").addEventListener("click", lukk);
  rot.addEventListener("mousedown", (e) => { if (e.target === rot) lukk(); });
  rot.addEventListener("keydown", (e) => { if (e.key === "Escape") lukk(); });

  $("#vid-emne").value = /^(fwd?|vs|videresendt):/i.test(a.emne || sak.emne) ? (a.emne || sak.emne) : "Fwd: " + (sak.emne || a.emne || "");
  const orig = innholdSomHtml(a);
  $("#vid-orig").innerHTML = "";
  $("#vid-orig").appendChild(document.createRange().createContextualFragment(pakkInn(a, orig)));

  /* Mottakerlistene er to like Cc-lignende felt. */
  const lister = { til: [], cc: [] };
  const tegn = (nokkel) => {
    const el = $("#vid-" + nokkel);
    el.innerHTML = lister[nokkel].map((e, i) => `<span class="cc-chip">${esc(e)}<button type="button" data-i="${i}" aria-label="Fjern ${esc(e)}">×</button></span>`).join(" ") +
      `<input class="cc-inn" type="email" placeholder="${lister[nokkel].length ? "" : "Legg til e-postadresse …"}" aria-label="${nokkel === "til" ? "Til" : "Cc"}">`;
    const inn = el.querySelector("input");
    const legg = () => { const v = inn.value.trim().replace(/[,;]$/, ""); if (!v) return true; if (!gyldig(v)) { ctx.toast(`«${v}» er ikke en gyldig e-postadresse.`); return false; } if (!lister[nokkel].includes(v)) lister[nokkel].push(v); tegn(nokkel); el.querySelector("input").focus(); return true; };
    inn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "," || e.key === ";") { e.preventDefault(); legg(); } else if (e.key === "Backspace" && !inn.value) { lister[nokkel].pop(); tegn(nokkel); el.querySelector("input").focus(); } });
    inn.addEventListener("blur", legg);
    el._legg = legg;
  };
  for (const n of ["til", "cc"]) { tegn(n); $("#vid-" + n).addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) { lister[n].splice(Number(b.dataset.i), 1); tegn(n); } }); }

  const felt = $("#vid-felt");
  felt.dataset.tom = "Skriv noen ord til mottakeren, hvis du vil …";
  kobleFelt(felt, felt.parentElement);

  $("#vid-send").addEventListener("click", async () => {
    if (!$("#vid-til")._legg() || !$("#vid-cc")._legg()) return;
    if (!lister.til.length) { ctx.toast("Legg til minst én mottaker."); return $("#vid-til").querySelector("input").focus(); }
    const emne = $("#vid-emne").value.trim();
    if (!emne) { ctx.toast("Skriv et emne først."); return $("#vid-emne").focus(); }
    const knapp = $("#vid-send"); knapp.disabled = true; knapp.textContent = "Sender …";
    try {
      const egen = tilHtml(felt);
      const html = (egen.tomt ? "" : egen.html + "<br><br>") + pakkInn(a, orig);
      const med = $("#vid-vedlegg") && $("#vid-vedlegg").checked;
      const vedlegg = med ? await hentVedlegg(a, vedleggListe) : [];
      await post("/ticket_articles", byggVideresendKropp({ sak, til: lister.til, cc: lister.cc, emne, html, vedlegg }));
      lukk();
      ctx.toast(`Videresendt til ${lister.til.join(", ")}`);
      await ctx.ferdig({ saksId: sak.id });
    } catch (e) {
      if (e instanceof IkkeInnlogget) { lukk(); return ctx.innlogging(); }
      knapp.disabled = false; knapp.textContent = "Videresend";
      ctx.toast("Kunne ikke videresende: " + e.message);
    }
  });
  $("#vid-til").querySelector("input").focus();
}
