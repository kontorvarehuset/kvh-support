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
