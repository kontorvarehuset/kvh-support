/*
 * Skriveflata: svar til kunde og internt notat, med Cc og skjermbilder.
 *
 * ── Hva som kan gå galt, og hva som er gjort med det ──────────────────
 *
 * 1. Et internt notat som går til kunden. `internal`-flagget og artikkeltypen
 *    settes ENE av modusknappen, og fargen på hele boksen følger modusen. Det
 *    finnes ingen annen vei til `internal`.
 * 2. Et svar til feil sak. Hver sak har sitt eget utkast, og sendingen bærer
 *    saks-id fra den saken skriveflata ble åpnet på, ikke «den valgte».
 * 3. Et svar som går ut før man ombestemmer seg. Det finnes ingen ventetid
 *    (Frank fjernet den), så feil mottaker fanges bare av at den står tydelig
 *    over feltet. Mens forespørselen er på vei, advarer nettleseren hvis man
 *    lukker fanen.
 * 4. Prøvesperren (`SPERRE_TIL`) er fjernet.
 */

import { post, put } from "./api.js";
import { kompaktSignatur } from "./signatur.js";

/* Prøvesperren er fjernet (15. okt. 2026, etter at Frank godkjente testen). Settes til et saksnummer som
   tekst for å begrense alt som skrives til én sak igjen. */
export const SPERRE_TIL = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const gyldig = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const TRYGG_BILDE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i;

/** Redigeringsfeltet til HTML for Zammad. Bare tekst, linjeskift og innlimte bilder. */
export function tilHtml(felt) {
  let bilder = 0, tekst = false;
  const gaa = (node) => {
    let ut = "";
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { if (n.textContent.trim()) tekst = true; ut += esc(n.textContent); }
      else if (n.nodeName === "BR") ut += "<br>";
      else if (n.nodeName === "IMG") {
        const src = n.getAttribute("src") || "";
        if (TRYGG_BILDE.test(src)) { bilder++; ut += `<img src="${src}">`; }
      } else if (n.nodeName === "DIV" || n.nodeName === "P") {
        const inn = gaa(n);
        ut += `<div>${inn || "<br>"}</div>`;
      } else if (n.nodeType === 1) ut += gaa(n);
    }
    return ut;
  };
  const html = gaa(felt);
  return { html, bilder, tekst, tomt: !tekst && bilder === 0 };
}

/**
 * Innliming og slipp av skjermbilder i et redigeringsfelt. Brukes av «Ny sak». (Svarfeltet har sin
 * egen kopi av det samme, som ikke er flyttet hit for å ikke røre det som virker.)
 */
export function kobleFelt(felt, boks, { vedEndring } = {}) {
  const settInn = (src) => {
    felt.focus();
    const img = document.createElement("img"); img.src = src; img.alt = "Skjermbilde";
    const sel = getSelection();
    if (sel.rangeCount && felt.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(img); r.setStartAfter(img); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    } else felt.appendChild(img);
    felt.appendChild(document.createElement("br"));
    if (vedEndring) vedEndring();
  };
  const les = (filer) => [...filer].filter((f) => /^image\/(png|jpe?g|gif|webp)$/.test(f.type)).forEach((f) => {
    const l = new FileReader(); l.onload = () => settInn(l.result); l.readAsDataURL(f);
  });
  felt.addEventListener("paste", (e) => {
    const filer = [...(e.clipboardData?.files || [])];
    e.preventDefault();
    if (filer.some((q) => q.type.startsWith("image/"))) les(filer);
    else document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  });
  ["dragenter", "dragover"].forEach((ev) => boks.addEventListener(ev, (e) => { e.preventDefault(); boks.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => boks.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop") les(e.dataTransfer.files); boks.classList.remove("over"); }));
  return { les };
}

const utkast = new Map(); // sak-id -> {modus, html, cc}

/**
 * Setter inn skriveflata. `ctx`: {sak, toast, etterSendt, trykkeSendt}.
 * Returnerer en funksjon som fjerner den igjen.
 */
export function monter(rot, ctx) {
  const sak = ctx.sak;
  const u = utkast.get(sak.id) || { modus: "svar", html: "", cc: [] };
  utkast.set(sak.id, u);
  const kunSperret = SPERRE_TIL && String(sak.nummer) !== SPERRE_TIL;

  rot.innerHTML = `<div class="skriv ${u.modus === "notat" ? "notat" : ""}" id="skriv"><button type="button" class="svar-knapp" id="svar-apne">Svar</button>
    <div class="skriv-inn" id="skriv-inn">
    <div class="dropp">Slipp skjermbildet her</div>
    <div class="skrivtopp">
      <div class="modus" role="group" aria-label="Mottaker">
        <button type="button" data-m="svar" aria-pressed="${u.modus === "svar"}">Svar kunden</button>
        <button type="button" data-m="notat" aria-pressed="${u.modus === "notat"}">Internt notat</button>
      </div>
      <span class="til" id="til"></span>
    </div>
    <div class="ccrad" id="ccrad"><span class="l">Cc</span><span id="cc-chips"></span><input class="cc-inn" id="cc-inn" type="email" placeholder="Legg til e-postadresse …" aria-label="Cc"></div>
    <div class="felt" id="felt" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Melding"></div>
    <div class="sig" id="sig-rad" hidden>
      <label class="sig-valg"><input type="checkbox" id="sig-pa"> Med signatur <button type="button" class="apne-sig" id="sig-apne">vis</button></label>
      <div class="sig-visning" id="sig-visning"></div>
    </div>
    <div class="skrivbunn">
      <button type="button" class="ikon" id="vedlegg" title="Legg til skjermbilde" aria-label="Legg til skjermbilde">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/></svg>
      </button>
      <input type="file" id="fil" accept="image/*" multiple hidden>
      <span class="hint" id="hint"></span>
      <button type="button" class="knapp" id="send-lukk" title="Send svaret og lukk saken">Send og lukk</button>
      <button type="button" class="knapp oransje" id="send"></button>
    </div></div></div>
    ${kunSperret ? `<div class="les-merknad" style="margin-top:0"><span><b>Prøvemodus:</b> sending er sperret på alle saker unntatt <b>#${esc(SPERRE_TIL)}</b>.</span></div>` : ""}`;

  const $ = (s) => rot.querySelector(s);
  const felt = $("#felt");
  /* Over 860 px står skriveflata alltid åpen, og da ligger signaturen som vanlig tekst i selve feltet (kan redigeres
     og fjernes), ikke som en egen blokk under. Under 860 px legges den til automatisk ved sending, som før. */
  const alltidApen = window.matchMedia("(min-width:861px)").matches;
  felt.innerHTML = u.html;

  /* Smale skjermer: skriveflata er en «Svar»-knapp til man trykker, og folder seg sammen igjen når den er tom og forlatt. */
  const skrivEl = $("#skriv");
  if (u.html.trim()) skrivEl.classList.add("utvidet");
  $("#svar-apne").addEventListener("click", () => { skrivEl.classList.add("utvidet"); felt.focus(); });
  skrivEl.addEventListener("focusout", (e) => {
    const til = e.relatedTarget;
    if (til && skrivEl.contains(til)) return;
    if ((erTomt() || bareHilsen()) && !$("#cc-inn").value && u.cc.length === 0) { if (bareHilsen() && !alltidApen) { felt.innerHTML = ""; lagre(); } skrivEl.classList.remove("utvidet"); }
  });

  /* Signaturen hentes fra Zammad når skriveflata åpnes. Mangler den, vises ingenting. */
  let sigHtml = "";
  const sigPa = $("#sig-pa");
  /* Signaturen er alltid på (valget er skjult, og et gammelt lagret «av» ignoreres): et svar uten signatur er en feil. */
  sigPa.checked = true;
  const sigRad = $("#sig-rad");
  $("#sig-apne").addEventListener("click", (e) => {
    e.preventDefault();
    const apen = sigRad.classList.toggle("apen");
    e.target.textContent = apen ? "skjul" : "vis";
  });
  sigPa.addEventListener("change", () => { try { localStorage.setItem("kvhui-signatur", sigPa.checked ? "pa" : "av"); } catch { /* ingen lagring */ } });
  const oppdater = () => {
    const notat = u.modus === "notat";
    $("#skriv").classList.toggle("notat", notat);
    $("#til").className = "til" + (notat ? " lås" : "");
    $("#til").textContent = notat ? "🔒 Bare dere ser dette. Kunden får ingenting." : `Til ${sak.fra || "kunden"} · ${sak.epost || "ingen e-postadresse"}`;
    felt.dataset.tom = notat ? "Skriv et notat til dere selv …" : "Skriv svar …";
    $("#send").textContent = notat ? "Lagre notat" : "Send svar";
    $("#ccrad").hidden = notat;
    $("#send-lukk").hidden = notat;
    $("#sig-rad").hidden = notat || !sigHtml || alltidApen;
    $("#hint").textContent = "Lim inn eller dra skjermbilder rett i meldingen · ⌘↵ sender";
    rot.querySelectorAll(".modus button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.m === u.modus)));
    $("#cc-chips").innerHTML = u.cc.map((e, i) => `<span class="cc-chip">${esc(e)}<button type="button" data-cc="${i}" aria-label="Fjern ${esc(e)}">×</button></span>`).join(" ");
  };
  oppdater();
  if (ctx.signatur) {
    ctx.signatur().then((h) => {
      sigHtml = h || "";
      /* Signaturen kommer etter at feltet er tegnet: legg den inn nå hvis feltet fortsatt bare har hilsenen. */
      if (alltidApen && u.modus === "svar" && bareHilsen() && !felt.querySelector("[data-sig]")) { felt.insertAdjacentHTML("beforeend", sigBlokk()); lagre(); }
      $("#sig-visning").innerHTML = sigHtml ? `<span class="sig-kort"></span><span class="sig-full">${sigHtml}</span>` : "";
      const kort = $("#sig-visning").querySelector(".sig-kort"); if (kort) kort.textContent = kompaktSignatur(sigHtml);
      oppdater();
    }).catch(() => { /* uten signatur */ });
  }

  const lagre = () => { u.html = felt.innerHTML; };
  felt.addEventListener("input", lagre);

  /* Zammad-makroen «Hei Fornavn Etternavn,» som alle svar begynner med. Den settes inn når man begynner å skrive
     et svar i et tomt felt (ikke ved åpning av saken: på telefon betyr et ikke-tomt felt at skriveflata står utvidet,
     og et notat skal ikke ha hilsen). En hilsen uten noe etter seg regnes som tomt, så den hverken hindrer at feltet
     folder seg sammen eller lar «Send» slippe gjennom. Står det ikke et navn (bare en adresse), blir det «Hei,». */
  const navn = (sak.fra || "").trim();
  const hilsen = navn && !navn.includes("@") ? `Hei ${navn},` : "Hei,";
  /* «Innholdet» er det man selv har skrevet: signaturblokken (data-sig) regnes ikke med, så en hilsen med signatur
     under fortsatt er et tomt svar. */
  const utenSig = () => { const k = felt.cloneNode(true); k.querySelectorAll("[data-sig]").forEach((n) => n.remove()); return k; };
  const erTomt = () => { const k = utenSig(); return k.textContent.trim() === "" && !k.querySelector("img"); };
  const bareHilsen = () => { const k = utenSig(); return k.textContent.trim() === hilsen && !k.querySelector("img"); };
  const sigBlokk = () => (alltidApen && sigHtml ? `<div data-sig="1" class="sig-inline"><br>${sigHtml}</div>` : "");
  /* Markøren står på linja under hilsenen, rett over signaturen. */
  const markorSist = () => {
    const r = document.createRange(); const sig = felt.querySelector("[data-sig]");
    if (sig) r.setStartBefore(sig); else r.selectNodeContents(felt);
    r.collapse(!sig ? false : true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  };
  const settHilsen = (flyttMarkor = true) => {
    if (u.modus !== "svar" || !erTomt()) return;
    felt.innerHTML = "";
    felt.append(hilsen, document.createElement("br"), document.createElement("br"));
    felt.insertAdjacentHTML("beforeend", sigBlokk());
    if (flyttMarkor) markorSist();
    lagre();
  };
  /* Skriveflata står alltid åpen over 860 px: der er hilsenen ferdig satt inn og signaturen ligger som vanlig tekst
     under, så man ser hvordan svaret blir og kan fjerne den. Hilsenen settes uten å ta fokus (siden tegnes på nytt
     mens man søker, og fokus ville ellers hoppet fra søkefeltet), og markøren legges på linja under hilsenen når man
     klikker i feltet. */
  felt.addEventListener("focus", () => { if (erTomt()) settHilsen(); else if (bareHilsen()) markorSist(); });
  if (alltidApen) settHilsen(false);

  /* Innliming: bilder blir bilder, alt annet blir ren tekst (ingen skjult formatering fra Word eller e-post). */
  const settInnBilde = (src) => {
    felt.focus();
    const img = document.createElement("img"); img.src = src; img.alt = "Skjermbilde";
    const sel = getSelection();
    if (sel.rangeCount && felt.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(img); r.setStartAfter(img); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    } else felt.appendChild(img);
    felt.appendChild(document.createElement("br"));
    lagre();
  };
  const lesFiler = (filer) => [...filer].filter((f) => /^image\/(png|jpe?g|gif|webp)$/.test(f.type)).forEach((f) => {
    const l = new FileReader(); l.onload = () => settInnBilde(l.result); l.readAsDataURL(f);
  });
  felt.addEventListener("paste", (e) => {
    const filer = [...(e.clipboardData?.files || [])];
    e.preventDefault();
    if (filer.some((q) => q.type.startsWith("image/"))) lesFiler(filer);
    else document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  });
  const boks = $("#skriv-inn");
  ["dragenter", "dragover"].forEach((ev) => boks.addEventListener(ev, (e) => { e.preventDefault(); boks.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => boks.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop") lesFiler(e.dataTransfer.files); boks.classList.remove("over"); }));
  $("#vedlegg").addEventListener("click", () => $("#fil").click());
  $("#fil").addEventListener("change", (e) => { lesFiler(e.target.files); e.target.value = ""; });

  rot.querySelector(".modus").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (alltidApen && (erTomt() || bareHilsen())) felt.innerHTML = ""; u.modus = b.dataset.m; oppdater(); if (u.modus === "svar" && alltidApen) settHilsen(false); felt.focus();
  });

  /* Cc: Enter, komma eller semikolon legger til. Backspace i tomt felt fjerner den siste. */
  const ci = $("#cc-inn");
  const leggTilCc = () => {
    const v = ci.value.trim().replace(/[,;]$/, ""); if (!v) return true;
    if (!gyldig(v)) { ctx.toast(`«${v}» er ikke en gyldig e-postadresse.`); return false; }
    if (!u.cc.includes(v)) u.cc.push(v);
    ci.value = ""; oppdater(); return true;
  };
  ci.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "," || e.key === ";") { e.preventDefault(); leggTilCc(); }
    else if (e.key === "Backspace" && !ci.value) { u.cc.pop(); oppdater(); }
  });
  ci.addEventListener("blur", leggTilCc);
  $("#cc-chips").addEventListener("click", (e) => { const b = e.target.closest("[data-cc]"); if (b) { u.cc.splice(Number(b.dataset.cc), 1); oppdater(); } });

  /* Signaturen slik den står i feltet nå (kan være redigert eller fjernet). Hentes som HTML, så formateringen fra Zammad følger med. */
  const sigFraFelt = () => { const e = felt.querySelector("[data-sig]"); return e && e.textContent.trim() ? "<br>" + e.innerHTML.replace(/^(<br>)+/, "") : ""; };

  /* Sending. */
  const send = (lukkEtterpaa = false) => {
    if (kunSperret) return ctx.toast(`Sperret i prøvemodus: kan bare sende på #${SPERRE_TIL}.`);
    if (u.modus === "svar" && !leggTilCc()) return;
    const { html, tomt } = tilHtml(utenSig());
    if (tomt || (u.modus === "svar" && bareHilsen())) return ctx.toast("Skriv noe først.");
    const notat = u.modus === "notat";
    if (!notat && !gyldig(sak.epost || "")) return ctx.toast("Saken mangler en gyldig e-postadresse til kunden.");
    /* Hodet bæres av FORMEN på forespørselen: notat = type note + internal, svar = type email + ikke internal. */
    const kropp = {
      ticket_id: sak.id,
      type: notat ? "note" : "email",
      internal: notat,
      sender: "Agent",
      content_type: "text/html",
      /* Signaturen legges til på slutten, bare på svar til kunde og bare hvis den er på. */
      body: html + (notat ? "" : alltidApen ? sigFraFelt() : sigHtml && sigPa.checked ? "<br>" + sigHtml : ""),
      subject: sak.emne,
    };
    if (!notat) { kropp.to = sak.epost; if (u.cc.length) kropp.cc = u.cc.join(", "); }
    const brukt = { html: felt.innerHTML, modus: u.modus, cc: [...u.cc] };
    felt.innerHTML = ""; u.html = ""; u.cc = []; oppdater();
    skrivEl.classList.remove("utvidet");
    ctx.planlegg({
      kropp, notat, saksId: sak.id,
      /* Etter svaret lukkes saken, i samme jobb: ett Angre gjelder begge deler. */
      etterpa: lukkEtterpaa && !notat ? { state_id: 4 } : null,
      beskrivelse: notat ? "Notat lagres" : `Svar sendes${lukkEtterpaa ? " og saken lukkes" : ""} til ${sak.epost}${brukt.cc.length ? " og " + brukt.cc.length + " i kopi" : ""}`,
      gjenopprett: () => { u.html = brukt.html; u.modus = brukt.modus; u.cc = brukt.cc; if (rot.contains(felt)) { felt.innerHTML = u.html; oppdater(); skrivEl.classList.add("utvidet"); } },
    });
  };
  $("#send").addEventListener("click", () => send(false));
  $("#send-lukk").addEventListener("click", () => send(true));
  felt.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); } });
}

/*
 * Sending. Svar går ut med en gang: Frank ba om å fjerne de ti sekundene med «Angre». Det betyr at et svar
 * til feil kunde ikke kan hentes tilbake, så mottaker og modus står tydelig over feltet. Mens
 * forespørselen er på vei, advarer nettleseren hvis man lukker fanen.
 */
let ventende = null;
window.addEventListener("beforeunload", (e) => { if (ventende) { e.preventDefault(); e.returnValue = ""; } });

export async function planleggSending(jobb, { toast, ferdig, feilet }) {
  if (ventende) { toast("Vent til forrige melding er sendt."); jobb.gjenopprett(); return; }
  ventende = { ...jobb };
  toast(jobb.notat ? "Lagrer notat …" : "Sender svar …");
  try {
    await post("/ticket_articles", jobb.kropp);
    if (jobb.etterpa) jobb.ticket = await put(`/tickets/${jobb.saksId}`, jobb.etterpa);
    ventende = null;
    toast(jobb.notat ? "Notat lagret" : jobb.etterpa ? "Svar sendt og saken lukket" : "Svar sendt");
    ferdig(jobb);
  } catch (e) {
    ventende = null;
    jobb.gjenopprett();
    feilet(jobb, e);
  }
}
