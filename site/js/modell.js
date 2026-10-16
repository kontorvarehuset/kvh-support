/*
 * Fra Zammads svar til det skjermen trenger. Rene funksjoner uten DOM, slik at
 * de kan prøves i Node mot data i samme form som API-et gir (målt 15. okt. 2026
 * på Zammad 7.2.2: søk gir {record_ids, assets:{Ticket,User,Organization},
 * total_count}).
 */

/* Statusene i HUSETS Zammad: 7 og 8 er egne tillegg. «Venter på kunde» og
   «venter på leverandør» er derfor på vent, ikke åpne: ingen skal gjøre noe
   med dem før noen andre har svart. */
export const STATUS_ID = {
  1: "åpen", 2: "åpen",
  3: "vent", 6: "vent", 7: "vent", 8: "vent",
  4: "lukket", 5: "sammenslått",
};
/* Statuser som har en frist: 3 pending reminder, 6 pending close, og de to egne (7, 8), som er
   av samme type som pending reminder (målt 15. okt. 2026). */
export const VENTESTATUSER = new Set([3, 6, 7, 8]);
export const STATUSNAVN_APNE = ["new", "open", "pending reminder", "pending close", "waiting for customer", "waiting for supplier"];
/* Bruker 1 er Zammads systembruker: en sak eid av den har ingen eier. */
export const INGEN_EIER = 1;

const DAG = 86_400_000;

/** Status ut fra Zammads state_id og frist. Brukes både når lista leses og når vi selv har endret en sak. */
export function beregnStatus(stateId, pendingTime, naa = Date.now()) {
  let status = STATUS_ID[stateId] || "åpen";
  const ventTid = pendingTime ? new Date(pendingTime).getTime() : null;
  const fristNaadd = VENTESTATUSER.has(stateId) && ventTid !== null && ventTid <= naa;
  if (fristNaadd) status = "åpen";
  return { status, ventTid, fristNaadd };
}

export function navnPaa(b) {
  if (!b) return "";
  const n = `${b.firstname || ""} ${b.lastname || ""}`.trim();
  return n || b.login || b.email || "";
}

/** Adressen til en brukers profilbilde i Zammad, eller tom streng. Zammad henter bildet selv
    (for eksempel fra Microsoft-innloggingen), så vi trenger ikke snakke med Graph. */
export function bildeUrl(bruker) {
  const id = bruker && bruker.image;
  return id && /^[A-Za-z0-9_-]{6,128}$/.test(String(id)) ? `/api/v1/users/image/${id}` : "";
}

export function initialer(navn) {
  return (navn || "?").split(/\s+/).filter(Boolean).map((d) => d[0]).slice(0, 2).join("").toUpperCase();
}

const tid = (s) => (s ? new Date(s).getTime() : null);

/**
 * Sakene fra et søk, i samme rekkefølge som Zammad ga dem.
 * `naa` kan settes for å teste.
 */
export function byggSaker(res, naa = Date.now()) {
  const A = res.assets || {};
  const T = A.Ticket || {}, U = A.User || {}, O = A.Organization || {};
  const ut = [];
  for (const id of res.record_ids || Object.keys(T)) {
    const t = T[id];
    if (!t) continue;
    const kunde = U[t.customer_id];
    const org = O[t.organization_id] || O[kunde?.organization_id];
    const eier = t.owner_id && t.owner_id !== INGEN_EIER ? U[t.owner_id] : null;
    const sistKunde = tid(t.last_contact_customer_at);
    const sistOss = tid(t.last_contact_agent_at);
    /* En sak satt på vent (3 pending reminder, 6 pending close, og de egne 7 og 8) er på vent bare til
       fristen. Er fristen passert, venter den på OSS igjen: Zammad kaller det «Pending Reached». Målt
       15. okt. 2026: Zammads «Åpne saker» telte pending reminder som åpne også når fristen lå fram i tid,
       mens vi vil se hva som faktisk haster. */
    const { status, ventTid, fristNaadd } = beregnStatus(t.state_id, t.pending_time, naa);
    const venterPaaOss = status === "åpen" && (fristNaadd || (sistKunde !== null && (sistOss === null || sistKunde > sistOss)));
    const referanse = fristNaadd ? ventTid : sistKunde;
    ut.push({
      id: t.id,
      nummer: t.number,
      emne: t.title || "(uten emne)",
      kunde: org?.name || navnPaa(kunde) || "Ukjent kunde",
      fra: navnPaa(kunde),
      epost: kunde?.email || "",
      /* Til kundekortet i panelet. Telefonnummeret finnes ikke på alle kunder. */
      kundeId: t.customer_id,
      tlf: kunde?.mobile || kunde?.phone || "",
      status,
      gruppeId: t.group_id,
      stateId: t.state_id,
      pendingRaw: t.pending_time || null,
      eierId: eier ? eier.id : null,
      eier: eier ? navnPaa(eier) : null,
      venterPaaOss,
      sistKunde,
      sistOss,
      sist: tid(t.last_contact_at) ?? tid(t.updated_at),
      oppdatert: t.updated_at,
      antall: t.article_count || 0,
      ventTil: ventTid,
      fristNaadd,
      /* Hele døgn siden kunden skrev (eller fristen gikk ut), bare for saker som venter på oss. */
      dager: venterPaaOss && referanse ? Math.floor((naa - referanse) / DAG) : 0,
    });
  }
  return ut;
}

/** Brukerne i søkesvaret, for navn på eiere og avsendere uten flere kall. */
export function brukereFra(res) {
  const m = new Map();
  for (const [id, b] of Object.entries((res.assets || {}).User || {})) m.set(Number(id), b);
  return m;
}

const UKEDAG = ["søn.", "man.", "tirs.", "ons.", "tors.", "fre.", "lør."];
const MND = ["jan.", "feb.", "mars", "apr.", "mai", "juni", "juli", "aug.", "sep.", "okt.", "nov.", "des."];
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const dagStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Kort tid i lista: «09:14», «i går», «man.», «9. okt.». */
export function kortTid(ms, naa = Date.now()) {
  if (ms == null) return "";
  const d = new Date(ms);
  const dager = Math.round((dagStart(new Date(naa)) - dagStart(d)) / DAG);
  if (dager <= 0) return hhmm(d);
  if (dager === 1) return "i går";
  if (dager < 7) return UKEDAG[d.getDay()];
  return `${d.getDate()}. ${MND[d.getMonth()]}`;
}

/** Full tid over en melding: «i dag 09:14», «i går 14:40», «man. 10:05», «9. okt. 11:20». */
export function langTid(ms, naa = Date.now()) {
  if (ms == null) return "";
  const d = new Date(ms);
  const dager = Math.round((dagStart(new Date(naa)) - dagStart(d)) / DAG);
  if (dager <= 0) return `i dag ${hhmm(d)}`;
  if (dager === 1) return `i går ${hhmm(d)}`;
  if (dager < 7) return `${UKEDAG[d.getDay()]} ${hhmm(d)}`;
  return `${d.getDate()}. ${MND[d.getMonth()]} ${hhmm(d)}`;
}

/** «fre. 16. okt. 08:00» for på-vent-tidspunkt. */
export function ventTekst(ms) {
  if (!ms) return "til kunden svarer";
  const d = new Date(ms);
  return `${UKEDAG[d.getDay()]} ${d.getDate()}. ${MND[d.getMonth()]} ${hhmm(d)}`;
}

/** «Navn <adresse>» → «Navn», ellers selve adressen. */
export function navnFraFra(fra) {
  if (!fra) return "";
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(fra);
  return (m ? m[1] : fra).trim();
}

/**
 * En artikkel som skjermen kan tegne. `brukere` er et Map fra bruker-id til
 * brukerobjekt; avsendere som ikke finnes der får navn fra `from`-hodet.
 */
export function byggArtikkel(a, brukere) {
  const avsender = String(a.sender || "").toLowerCase();
  const intern = a.internal === true;
  const slag = avsender === "customer" ? "kunde"
    : avsender === "agent" ? (intern ? "notat" : "oss")
    : intern ? "notat" : "system";
  const bruker = brukere.get(a.created_by_id) || null;
  const navn = slag === "kunde"
    ? (navnFraFra(a.from) || navnPaa(bruker))
    : (navnPaa(bruker) || navnFraFra(a.from) || "Ukjent");
  return {
    id: a.id,
    ticketId: a.ticket_id,
    slag,
    navn,
    tid: tid(a.created_at),
    emne: a.subject || "",
    html: a.content_type === "text/html",
    tekst: a.body || "",
    bilde: (bruker && bruker.image) || "",
    til: a.to || "",
    cc: (a.cc || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean),
    kanal: a.type || "",
    vedlegg: (a.attachments || []).map((v) => ({
      id: v.id,
      navn: v.filename || "vedlegg",
      storrelse: Number(v.size) || 0,
      mime: (v.preferences && (v.preferences["Mime-Type"] || v.preferences["Content-Type"])) || "",
      cid: v.preferences && v.preferences["Content-ID"] ? String(v.preferences["Content-ID"]).replace(/^<|>$/g, "") : "",
      /* Zammads egen kopi av e-postens HTML-del er ikke noe kunden la ved. Zammad merker den selv
         (`Content-Alternative`), og navnet `message.html` på en e-post er reserven. */
      skjul: !!(v.preferences && v.preferences["Content-Alternative"]) ||
        (String(a.type || "") === "email" && /^message\.html$/i.test(v.filename || "")),
    })),
  };
}

/** Skiller sitert tekst fra selve svaret i ren tekst. Ingenting kastes: resten
    vises bak «⋯». Kuttet settes ved første attribusjonslinje eller første
    sitatlinje (>), det som kommer først. */
export function skillSitat(tekst) {
  const linjer = tekst.replace(/\r\n?/g, "\n").split("\n");
  const attr = /^\s*(Den .{5,100}skrev.*:|On .{5,120}wrote:|-{3,}\s*(Original Message|Opprinnelig melding)|Fra:\s.+)\s*$/i;
  let kutt = -1;
  for (let i = 0; i < linjer.length; i++) {
    if (attr.test(linjer[i]) || /^\s*>/.test(linjer[i])) { kutt = i; break; }
  }
  if (kutt <= 0) return { svar: tekst.trim(), sitat: "" };
  return { svar: linjer.slice(0, kutt).join("\n").trim(), sitat: linjer.slice(kutt).join("\n").trim() };
}

export const erBilde = (v) => /^image\/(png|jpe?g|gif|webp)$/i.test(v.mime);

export function storrelseTekst(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} kB`;
  return `${(b / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

/* Spesialtegn i Elasticsearchs spørresyntaks. Brukerens tekst skal være tekst, ikke syntaks: et kolon,
   en anførselstegn eller en bindestrek i et navn ville ellers gitt en feil eller et annet søk enn ment. */
const ES_SPESIAL = /[+\-=&|><!(){}\[\]^"~*?:\\/]/g;
export const escES = (s) => String(s).replace(ES_SPESIAL, "\\$&");

/**
 * Søk i ALLE saker i Zammad, også meldingstekst. `omfang`: {apne, lukkede}. Åpne betyr alt som ikke er
 * lukket eller slått sammen (inkludert på vent), siden det er slik resten av siden bruker ordet.
 */
export function sokeSporring(q, omfang) {
  const apne = "state.name:(" + STATUSNAVN_APNE.map((n) => (n.includes(" ") ? `"${n}"` : n)).join(" OR ") + ")";
  const lukket = "state.name:closed";
  const tilstand = omfang.apne && omfang.lukkede ? `(${apne} OR ${lukket})` : omfang.apne ? apne : lukket;
  return `(${escES(q.trim())}) AND ${tilstand}`;
}
