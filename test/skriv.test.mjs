import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const { tilHtml, SPERRE_TIL } = await import("../site/js/skriv.js");

const lag = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d; };
let r = tilHtml(lag("Hei <b>du</b> &amp; <script>x</script>"));
assert.equal(r.html.includes("<script"), false, "ingen rå tagger fra innholdet");
assert.match(r.html, /Hei /); assert.equal(r.tekst, true); assert.equal(r.tomt, false);
r = tilHtml(lag("<div>Første</div><div><br></div><div>Tredje</div>"));
assert.equal(r.html, "<div>Første</div><div><br></div><div>Tredje</div>");
r = tilHtml(lag('<img src="data:image/png;base64,iVBORw0KGgo=">'));
assert.equal(r.bilder, 1); assert.equal(r.tomt, false, "bare et bilde er ikke tomt");
r = tilHtml(lag('<img src="javascript:alert(1)"><img src="https://x.example/a.png"><img src="data:image/svg+xml;base64,AAAA">'));
assert.equal(r.bilder, 0, "bare data:-bilder av trygge typer"); assert.equal(r.html, ""); assert.equal(r.tomt, true);
r = tilHtml(lag("   <br>  "));
assert.equal(r.tomt, true, "bare luft er tomt");
r = tilHtml(lag('Tekst med "sitat" og <tegn>'));
assert.match(r.html, /&quot;sitat&quot;/); assert.equal(SPERRE_TIL, null, "prøvesperren er fjernet");
/* Omtale: notat gir lenken Zammad selv lager; svar til kunde gir bare navnet; id-en valideres. */
{
  const omt = lag('Se på denne <a class="omtale" contenteditable="false" data-mention-user-id="12">Bjørn Magne Vik</a>&nbsp;takk');
  let o = tilHtml(omt, { omtaler: true });
  assert.match(o.html, /<a href="https:\/\/support\.kvh\.no\/#user\/profile\/12" data-mention-user-id="12" rel="nofollow noreferrer noopener" title="https:\/\/support\.kvh\.no\/#user\/profile\/12">Bjørn Magne Vik<\/a>/);
  o = tilHtml(omt);
  assert.equal(o.html.includes("<a"), false, "uten omtaler (svar til kunde) blir navnet ren tekst");
  assert.match(o.html, /Bjørn Magne Vik/);
  o = tilHtml(lag('<a data-mention-user-id="1&quot; onclick=&quot;x">Ond</a>'), { omtaler: true });
  assert.equal(o.html.includes("onclick"), false, "ugyldig id gir ingen lenke"); assert.equal(o.html, "Ond");
  o = tilHtml(lag('<a data-mention-user-id="7"><b>&lt;i&gt;</b></a>'), { omtaler: true });
  assert.equal(o.html.includes("<i>"), false, "navnet escapes");
  console.log("skriv omtale: ok");
}
console.log("skriv: ok");

/* ── Skriveflata på bred skjerm: hilsen og signatur som tekst i feltet ── */
{
  const { monter } = await import("../site/js/skriv.js");
  const d2 = new JSDOM("<!doctype html><body><div id=rot></div></body>", { pretendToBeVisual: true });
  Object.assign(globalThis, { document: d2.window.document, window: d2.window, getSelection: () => d2.window.getSelection() });
  d2.window.matchMedia = (q) => ({ matches: q.includes("min-width:861px"), addEventListener() {} });
  d2.window.addEventListener = d2.window.addEventListener.bind(d2.window);
  const rot = d2.window.document.getElementById("rot");
  let sendt = null;
  const sak = { id: 7, nummer: "100", fra: "Arne Buseth", epost: "arne@rir.no", emne: "Test" };
  monter(rot, { sak, toast() {}, planlegg: (j) => { sendt = j; }, signatur: async () => "Frank Iversen<br>KVH" });
  const felt = rot.querySelector("#felt");
  assert.match(felt.textContent, /^Hei Arne Buseth,/, "hilsenen står i feltet ved åpning");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(felt.querySelector("[data-sig]"), "signaturen ligger som tekst i feltet");
  rot.querySelector("#send").click();
  assert.equal(sendt, null, "hilsen og signatur alene sendes ikke");
  felt.insertBefore(d2.window.document.createTextNode("Det fikser vi."), felt.querySelector("[data-sig]"));
  rot.querySelector("#send").click();
  assert.ok(sendt.kropp.body.includes("Frank Iversen<br>KVH"), "signaturen følger med");
  assert.ok(sendt.kropp.body.includes("Det fikser vi."));
  assert.equal((sendt.kropp.body.match(/Frank Iversen/g) || []).length, 1, "signaturen står bare én gang");
}

/* ── @-menyen i notatmodus: lista, valg, og at det som sendes er Zammads omtale ── */
{
  const { monter } = await import("../site/js/skriv.js");
  const d3 = new JSDOM("<!doctype html><body><div id=rot></div></body>", { pretendToBeVisual: true });
  Object.assign(globalThis, { document: d3.window.document, window: d3.window, getSelection: () => d3.window.getSelection() });
  d3.window.matchMedia = (q) => ({ matches: q.includes("min-width:861px"), addEventListener() {} });
  d3.window.Range.prototype.getBoundingClientRect = () => ({ left: 10, right: 10, top: 10, bottom: 24 });
  const rot = d3.window.document.getElementById("rot");
  let sendt = null;
  const sak = { id: 8, nummer: "101", fra: "Arne", epost: "arne@rir.no", emne: "T" };
  const agenter = [{ id: 5, navn: "Bjørn Magne Vik" }, { id: 6, navn: "Bjørge Hoksnes Tøien" }, { id: 9, navn: "Anne Lise" }];
  monter(rot, { sak, agenter: () => agenter, toast() {}, planlegg: (j) => { sendt = j; } });
  const felt = rot.querySelector("#felt");
  const skriv = (tekst) => {
    felt.textContent = ""; const t = d3.window.document.createTextNode(tekst); felt.appendChild(t);
    const r = d3.window.document.createRange(); r.setStart(t, tekst.length); r.collapse(true);
    const s = d3.window.getSelection(); s.removeAllRanges(); s.addRange(r);
    felt.dispatchEvent(new d3.window.Event("input", { bubbles: true }));
  };
  skriv("Se @bj");
  assert.equal(d3.window.document.querySelector(".omtaleliste"), null, "ingen liste i svarmodus");
  rot.querySelector('[data-m="notat"]').click();
  skriv("Se @bj");
  let liste = d3.window.document.querySelector(".omtaleliste");
  assert.ok(liste, "lista kommer i notatmodus");
  assert.equal(liste.querySelectorAll("button").length, 2, "bare Bjørn og Bjørge matcher «bj»");
  skriv("Se @ann"); liste = d3.window.document.querySelector(".omtaleliste");
  assert.equal(liste.querySelectorAll("button").length, 1); assert.match(liste.textContent, /Anne Lise/);
  skriv("a@bj"); assert.equal(d3.window.document.querySelector(".omtaleliste"), null, "en e-postadresse åpner ikke lista");
  skriv("Se @bjørn");
  felt.dispatchEvent(new d3.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const a = felt.querySelector("a.omtale");
  assert.ok(a, "Enter setter inn omtalen"); assert.equal(a.dataset.mentionUserId, "5"); assert.equal(a.textContent, "Bjørn Magne Vik");
  assert.equal(d3.window.document.querySelector(".omtaleliste"), null, "lista lukkes etter valg");
  assert.equal(sendt, null);
  felt.appendChild(d3.window.document.createTextNode("kan du se på denne"));
  rot.querySelector("#send").click();
  assert.equal(sendt.kropp.internal, true);
  assert.match(sendt.kropp.body, /data-mention-user-id="5"/, "notatet bærer Zammads omtale");
  assert.equal(sendt.kropp.body.includes("@bj"), false, "det halvskrevne @ er borte");
  console.log("skriv @-meny: ok");
}
