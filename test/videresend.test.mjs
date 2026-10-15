globalThis.window = { addEventListener() {} };
import assert from "node:assert/strict";
const { tekstTilHtml, pakkInn, byggVideresendKropp } = await import("../site/js/videresend.js");

assert.equal(tekstTilHtml("a <b>\nc & d"), "a &lt;b&gt;<br>c &amp; d", "ren tekst escapes og får linjeskift");
const innpakket = pakkInn({ navn: "Grete <S>", tid: new Date("2026-10-14T09:00:00").getTime(), emne: "Skriver", til: "support@x.example" }, "<p>hei</p>");
assert.match(innpakket, /Videresendt melding/); assert.match(innpakket, /Fra:<\/b> Grete &lt;S&gt;/, "navn escapes");
assert.match(innpakket, /<p>hei<\/p>/, "innholdet er allerede renset og legges inn som det er");

let k = byggVideresendKropp({ sak: { id: 9 }, til: ["a@x.example", "b@x.example"], cc: ["c@x.example"], emne: "Fwd: Test", html: "<div>x</div>", vedlegg: [{ filename: "a.pdf", data: "AAA", "mime-type": "application/pdf" }] });
assert.equal(k.ticket_id, 9); assert.equal(k.type, "email"); assert.equal(k.sender, "Agent"); assert.equal(k.internal, false);
assert.equal(k.to, "a@x.example, b@x.example"); assert.equal(k.cc, "c@x.example"); assert.equal(k.attachments.length, 1);
k = byggVideresendKropp({ sak: { id: 9 }, til: ["a@x.example"], cc: [], emne: "E", html: "x", vedlegg: [] });
assert.equal("cc" in k, false); assert.equal("attachments" in k, false, "ingen tomme felt i forespørselen");
console.log("videresend: ok");
