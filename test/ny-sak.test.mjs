globalThis.window = { addEventListener() {} };
import assert from "node:assert/strict";
const { byggSakKropp, brukereFraSok, SPERRE_NY_EPOST } = await import("../site/js/ny-sak.js");

let k = byggSakKropp({ kanal: "epost", kunde: { id: 77, epost: "a@x.example" }, cc: ["b@x.example", "c@x.example"], emne: "Emne", html: "<div>hei</div>", gruppeId: 2, eierId: 4 });
assert.equal(k.customer_id, 77); assert.equal(k.group_id, 2); assert.equal(k.owner_id, 4); assert.equal(k.state, "open");
assert.equal(k.article.type, "email"); assert.equal(k.article.sender, "Agent"); assert.equal(k.article.internal, false);
assert.equal(k.article.to, "a@x.example"); assert.equal(k.article.cc, "b@x.example, c@x.example");
k = byggSakKropp({ kanal: "epost", kunde: { id: null, epost: "ny@x.example" }, cc: [], emne: "E", html: "x", gruppeId: 2, eierId: 0 });
assert.equal(k.customer_id, "guess:ny@x.example", "ukjent kunde lages av Zammad fra adressen");
assert.equal("owner_id" in k, false, "ingen eier gir ingen owner_id"); assert.equal("cc" in k.article, false);
k = byggSakKropp({ kanal: "telefon", kunde: { id: 5, epost: "a@x.example" }, cc: ["b@x.example"], emne: "E", html: "x", gruppeId: 1, eierId: 4 });
assert.equal(k.article.type, "phone"); assert.equal(k.article.sender, "Customer");
assert.equal("to" in k.article, false, "telefon sender ingenting"); assert.equal("cc" in k.article, false, "ingen Cc på telefon");

assert.deepEqual(brukereFraSok([{ id: 1, firstname: "Grete", lastname: "S", email: "g@x.example", organization: "Sylteosen" }, { id: 2, firstname: "Uten", lastname: "Epost" }]),
  [{ id: 1, navn: "Grete S", epost: "g@x.example", org: "Sylteosen" }]);
const r = brukereFraSok({ record_ids: [9], assets: { User: { 9: { id: 9, firstname: "A", lastname: "B", email: "a@x.example", organization_id: 3 } }, Organization: { 3: { id: 3, name: "Firma" } } } });
assert.equal(r[0].org, "Firma"); assert.equal(SPERRE_NY_EPOST, null, "prøvesperren er fjernet");
console.log("ny-sak: ok");
