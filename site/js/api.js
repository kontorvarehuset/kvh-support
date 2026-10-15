/*
 * Tynn klient mot Zammads API.
 *
 * Siden ligger på samme opprinnelse som Zammad (support.kvh.no/kvhui/), så
 * nettleseren sender agentens egen innloggingskake med hver forespørsel. Her
 * finnes ingen token og ingen hemmelighet: er man ikke innlogget i Zammad,
 * svarer API-et 401 og siden ber om innlogging.
 *
 * Stien er ALLTID absolutt (`/api/v1/...`), ikke relativ til `/kvhui/`:
 * NetBird-proxyen kan sende siden med eller uten prefikset, men API-et ligger
 * uansett på roten.
 */

export class IkkeInnlogget extends Error {
  constructor() { super("Ikke innlogget i Zammad"); }
}

let csrf = null;

async function kall(metode, sti, kropp) {
  const hoder = { Accept: "application/json" };
  if (metode !== "GET") {
    /* Skriving krever CSRF-token. Zammad sender den i svar-hodet `csrf-token`
       (målt 15. okt. 2026), så den hentes fra første GET og følger med senere. */
    if (!csrf) await hent("/signshow");
    hoder["X-CSRF-Token"] = csrf;
    hoder["Content-Type"] = "application/json";
  }
  const r = await fetch("/api/v1" + sti, {
    method: metode,
    credentials: "include",
    cache: "no-store",
    headers: hoder,
    body: kropp ? JSON.stringify(kropp) : undefined,
  });
  const t = r.headers.get("csrf-token");
  if (t) csrf = t;
  if (r.status === 401 || r.status === 403) throw new IkkeInnlogget();
  if (!r.ok) {
    let melding = "";
    try { melding = (await r.json()).error || ""; } catch { /* ikke JSON */ }
    throw new Error(`Zammad svarte ${r.status} på ${sti}${melding ? ": " + melding : ""}`);
  }
  return r.json();
}

export const hent = (sti) => kall("GET", sti);
