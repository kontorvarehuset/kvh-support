import assert from "node:assert/strict";
import { byggSaker, byggArtikkel, skillSitat, navnFraFra, kortTid, bildeUrl, STATUS_ID } from "../site/js/modell.js";

const naa = new Date("2026-10-15T12:00:00").getTime();
const res = {
  record_ids: [12, 11, 10],
  total_count: 3,
  assets: {
    Ticket: {
      10: { id: 10, number: "20010", title: "Venter på oss", state_id: 2, owner_id: 1, customer_id: 5, organization_id: 7,
        last_contact_customer_at: "2026-10-13T09:00:00", last_contact_agent_at: "2026-10-12T09:00:00", article_count: 2, updated_at: "2026-10-13T09:00:00" },
      11: { id: 11, number: "20011", title: "Vi svarte sist", state_id: 2, owner_id: 3, customer_id: 5,
        last_contact_customer_at: "2026-10-14T09:00:00", last_contact_agent_at: "2026-10-14T10:00:00", article_count: 3, updated_at: "2026-10-14T10:00:00" },
      12: { id: 12, number: "20012", title: "På vent", state_id: 7, owner_id: 3, customer_id: 5, pending_time: null, article_count: 1, updated_at: "2026-10-15T08:00:00" },
    },
    User: {
      5: { id: 5, firstname: "Grete", lastname: "Sylteosen", email: "grete@x.example", organization_id: 7 },
      3: { id: 3, firstname: "Frank", lastname: "Iversen", login: "frank" },
    },
    Organization: { 7: { id: 7, name: "Sylteosen Betong AS" } },
  },
};
const s = byggSaker(res, naa);
assert.deepEqual(s.map((x) => x.id), [12, 11, 10], "rekkefølgen følger record_ids");
const [vent, svart, venter] = s;
assert.equal(vent.status, "vent", "status 7 (waiting for customer) er på vent");
assert.equal(venter.eier, null, "owner_id 1 er systembrukeren, altså ingen eier");
assert.equal(venter.kunde, "Sylteosen Betong AS");
assert.equal(venter.venterPaaOss, true);
assert.equal(venter.dager, 2, "to hele døgn siden kunden skrev");
assert.equal(svart.venterPaaOss, false, "vi svarte etter kunden");
assert.equal(svart.eier, "Frank Iversen");
assert.equal(vent.venterPaaOss, false, "på vent venter ikke på oss");
assert.equal(STATUS_ID[8], "vent");

assert.equal(navnFraFra('"Grete S." <g@x.example>'), "Grete S.");
assert.equal(navnFraFra("Grete Sylteosen <g@x.example>"), "Grete Sylteosen");
assert.equal(navnFraFra("g@x.example"), "g@x.example");

const br = new Map([[3, { id: 3, firstname: "Frank", lastname: "Iversen" }]]);
assert.equal(byggArtikkel({ sender: "Customer", from: "Grete <g@x>", body: "hei", created_by_id: 9 }, br).slag, "kunde");
assert.equal(byggArtikkel({ sender: "Agent", internal: true, created_by_id: 3 }, br).slag, "notat");
assert.equal(byggArtikkel({ sender: "Agent", internal: false, created_by_id: 3 }, br).navn, "Frank Iversen");
assert.equal(byggArtikkel({ sender: "System", internal: false }, br).slag, "system");
const v = byggArtikkel({ sender: "Customer", attachments: [{ id: 4, filename: "a.png", size: "2048", preferences: { "Content-Type": "image/png", "Content-ID": "<abc@x>" } }] }, br).vedlegg[0];
assert.equal(v.cid, "abc@x"); assert.equal(v.mime, "image/png");

const d = skillSitat("Takk, det virker!\n\nDen man. 12. okt. 2026 kl. 10:00 skrev Frank:\n> Prøv igjen\n> hilsen");
assert.equal(d.svar, "Takk, det virker!"); assert.match(d.sitat, /^Den man/);
assert.equal(skillSitat("Bare en melding").sitat, "");
assert.equal(skillSitat("> sitat først").svar, "> sitat først", "kutt på første linje kaster ikke teksten");

assert.equal(kortTid(new Date("2026-10-15T09:14:00").getTime(), naa), "09:14");
assert.equal(kortTid(new Date("2026-10-14T09:14:00").getTime(), naa), "i går");
assert.equal(kortTid(new Date("2026-10-08T09:14:00").getTime(), naa), "8. okt.");
const pend = byggSaker({ record_ids: [1, 2, 3, 4], assets: { Ticket: {
  1: { id: 1, number: "1", state_id: 6, owner_id: 3, customer_id: 5, pending_time: "2026-10-14T08:00:00" },
  2: { id: 2, number: "2", state_id: 6, owner_id: 3, customer_id: 5, pending_time: "2026-10-16T08:00:00" },
  3: { id: 3, number: "3", state_id: 3, owner_id: 3, customer_id: 5, pending_time: "2026-10-15T08:00:00" },
  4: { id: 4, number: "4", state_id: 7, owner_id: 3, customer_id: 5, pending_time: null },
}, User: { 5: { id: 5, firstname: "G", lastname: "S" }, 3: { id: 3, firstname: "F", lastname: "I" } } } }, naa);
assert.deepEqual(pend.map((x) => x.status), ["åpen", "vent", "åpen", "vent"], "passert frist er åpen, fram i tid er på vent");
assert.equal(pend[0].fristNaadd, true); assert.equal(pend[0].venterPaaOss, true); assert.equal(pend[0].dager, 1);
assert.equal(pend[1].fristNaadd, false); assert.equal(pend[3].status, "vent", "waiting for customer forblir på vent");
assert.equal(bildeUrl({ image: "a1b2c3d4e5f6" }), "/api/v1/users/image/a1b2c3d4e5f6");
assert.equal(bildeUrl({ image: null }), ""); assert.equal(bildeUrl(undefined), "");
assert.equal(bildeUrl({ image: "../../x" }), "", "ingen stier fra data inn i adressen");
assert.equal(byggArtikkel({ sender: "Agent", created_by_id: 3 }, new Map([[3, { id: 3, firstname: "F", lastname: "I", image: "abcdef12" }]])).bilde, "abcdef12");
console.log("modell: ok");
