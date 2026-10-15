/*
 * Signaturen i Zammad (Admin → Kanaler → E-post → Signaturer), slik at svar fra kvhui får den samme som svar
 * fra Zammads eget grensesnitt. Zammads grensesnitt setter signaturen inn i redigeringsfeltet i nettleseren, og
 * API-et legger den ALDRI til selv, så uten dette gikk e-postene ut uten.
 *
 * Gruppen bestemmer hvilken signatur som gjelder (`signature_id` på gruppen). Målt 15. okt. 2026: signatur 1
 * («default», HTML) brukes av Users og IT, de andre gruppene har ingen.
 *
 * Variablene i malen (`#{user.firstname}` og slikt) fylles inn med den innloggede brukeren og saken. Ukjente
 * variabler blir tomme, og alle verdier escapes før de legges inn i HTML-en. Selve signaturen renses med `rens()`
 * til den vises eller sendes, selv om den er skrevet av en admin.
 */

import { hent } from "./api.js";
import { rens } from "./rens.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tekstTilHtml = (t) => esc(t).replace(/\r?\n/g, "<br>");

/** `#{user.firstname}` osv. `kontekst`: {user, ticket, ...}. Ukjente stier blir tom tekst. */
export function utfyllMal(mal, kontekst) {
  return String(mal ?? "").replace(/#\{\s*([a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)*)\s*\}/gi, (_, sti) => {
    let v = kontekst;
    for (const del of sti.split(".")) { v = v && typeof v === "object" ? v[del] : undefined; }
    return v == null || typeof v === "object" ? "" : esc(v);
  });
}

let grupper = null;
const cache = new Map();

async function malFor(gruppeId) {
  if (!grupper) { try { grupper = await hent("/groups"); } catch { grupper = []; } }
  const g = grupper.find((x) => x.id === gruppeId);
  const id = g && g.signature_id;
  if (!id) return null;
  if (cache.has(id)) return cache.get(id);
  let body = null;
  try { body = (await hent(`/signatures/${id}`)).body; }
  catch {
    /* Ikke alle agenter får lese /signatures. Gruppen selv kan gi den med på kjøpet. */
    try { const r = await hent(`/groups/${gruppeId}?full=true`); body = r && r.assets && r.assets.Signature && r.assets.Signature[id] && r.assets.Signature[id].body; } catch { body = null; }
  }
  cache.set(id, body || null);
  return body || null;
}

/** Ferdig renset HTML for signaturen til en gruppe, med brukerens og sakens opplysninger. Tom streng hvis ingen. */
export async function signaturHtml(gruppeId, { bruker, sak }) {
  const mal = await malFor(gruppeId);
  if (!mal) return "";
  const gruppe = (grupper || []).find((x) => x.id === gruppeId);
  const fylt = utfyllMal(mal, {
    user: bruker || {},
    ticket: { title: sak && sak.emne, number: sak && sak.nummer, group: { name: gruppe && gruppe.name } },
  });
  const html = /<[a-z][^>]*>/i.test(fylt) ? fylt : tekstTilHtml(fylt.replace(/&amp;/g, "&"));
  const r = rens(html, { cidTilUrl: () => null });
  const rot = document.createElement("div");
  rot.appendChild(r.svar);
  return rot.innerHTML.trim();
}
