/*
 * HTML fra e-post, renset til noe vi tør vise.
 *
 * Siden kjører på samme opprinnelse som Zammad, så et skript i en e-post ville
 * hatt agentens innlogging. Derfor: ALLOWLIST, og vi BYGGER nye noder i stedet
 * for å fjerne det farlige fra de gamle. Det som ikke står i listen, får aldri
 * komme med. Parseren (`DOMParser`) er inert: ingenting kjøres og ingen bilder
 * lastes mens vi leser.
 *
 * Sitater (`blockquote`, Gmails og Yahoos sitatbokser) legges i en egen
 * samling, så svaret er det man ser først og historikken ligger bak «⋯».
 */

const TILLATT = new Set([
  "P", "BR", "DIV", "SPAN", "B", "STRONG", "I", "EM", "U", "S", "UL", "OL", "LI", "A",
  "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "IMG", "PRE", "CODE",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR", "SMALL", "SUB", "SUP",
]);
/* Droppes helt, med innhold. Alt annet ukjent pakkes ut (innholdet beholdes). */
const DROPP = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA",
  "HEAD", "META", "LINK", "SVG", "MATH", "TEMPLATE", "NOSCRIPT", "TITLE", "BASE", "AUDIO", "VIDEO",
]);
const TRYGG_DATA = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i;

function trygg_lenke(href) {
  try {
    const u = new URL(href, "https://invalid.example/");
    return ["http:", "https:", "mailto:", "tel:"].includes(u.protocol) && /^(https?:|mailto:|tel:)/i.test(href.trim()) ? href.trim() : null;
  } catch { return null; }
}

function trygg_bilde(src, cidTilUrl) {
  const s = src.trim();
  if (/^cid:/i.test(s)) return cidTilUrl ? cidTilUrl(s.slice(4)) : null;
  if (TRYGG_DATA.test(s)) return s;
  if (/^https:\/\//i.test(s)) return s;
  if (/^\/api\/v1\/ticket_attachment\/\d+\/\d+\/\d+$/.test(s)) return s;
  return null;
}

function erSitat(el) {
  if (el.tagName === "BLOCKQUOTE") return true;
  const k = (el.getAttribute("class") || "").toLowerCase();
  return /gmail_quote|yahoo_quoted|moz-cite-prefix|protonmail_quote/.test(k);
}

/**
 * @param {string} html
 * @param {{cidTilUrl?: (cid: string) => string|null}} [valg]
 * @returns {{svar: DocumentFragment, sitat: DocumentFragment|null, brukteCid: Set<string>}}
 */
export function rens(html, valg = {}) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const svar = document.createDocumentFragment();
  const sitat = document.createDocumentFragment();
  const brukteCid = new Set();
  const cidTilUrl = (cid) => {
    const u = valg.cidTilUrl ? valg.cidTilUrl(cid) : null;
    if (u) brukteCid.add(cid);
    return u;
  };

  function kopier(kilde, mal) {
    for (const n of kilde.childNodes) {
      if (n.nodeType === 3) { mal.appendChild(document.createTextNode(n.textContent)); continue; }
      if (n.nodeType !== 1) continue;
      /* SVG og MathML har andre navnerom og små bokstaver i tagnavnet, så de
         ville sluppet forbi listene under. Alt utenfor vanlig HTML droppes. */
      if (n.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
      const tag = n.tagName;
      if (DROPP.has(tag)) continue;
      if (erSitat(n)) { const b = document.createElement("div"); kopier(n, b); sitat.appendChild(b); continue; }
      if (!TILLATT.has(tag)) { kopier(n, mal); continue; }
      const ny = document.createElement(tag.toLowerCase());
      if (tag === "A") {
        const l = trygg_lenke(n.getAttribute("href") || "");
        if (l) { ny.setAttribute("href", l); ny.setAttribute("target", "_blank"); ny.setAttribute("rel", "noopener noreferrer"); }
      } else if (tag === "IMG") {
        const s = trygg_bilde(n.getAttribute("src") || "", cidTilUrl);
        if (!s) continue;
        ny.setAttribute("src", s);
        ny.setAttribute("alt", n.getAttribute("alt") || "");
        ny.setAttribute("loading", "lazy");
        ny.setAttribute("referrerpolicy", "no-referrer");
      } else if (tag === "TD" || tag === "TH") {
        for (const a of ["colspan", "rowspan"]) {
          const v = n.getAttribute(a);
          if (v && /^\d{1,2}$/.test(v)) ny.setAttribute(a, v);
        }
      }
      if (tag !== "IMG") kopier(n, ny);
      mal.appendChild(ny);
    }
  }
  kopier(doc.body, svar);
  return { svar, sitat: sitat.childNodes.length ? sitat : null, brukteCid };
}
