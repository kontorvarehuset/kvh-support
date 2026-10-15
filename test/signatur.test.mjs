import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document; globalThis.DOMParser = dom.window.DOMParser;
const { utfyllMal } = await import("../site/js/signatur.js");

const k = { user: { firstname: "Frank", lastname: "O'Iversen", email: "f@x.example" }, ticket: { title: "Skriver <b>", number: "13753", group: { name: "IT" } } };
assert.equal(utfyllMal("Mvh<br>#{user.firstname} #{user.lastname}", k), "Mvh<br>Frank O&#39;Iversen", "verdier escapes");
assert.equal(utfyllMal("#{ticket.title}", k), "Skriver &lt;b&gt;", "HTML i en verdi blir tekst");
assert.equal(utfyllMal("Gruppe: #{ticket.group.name} / #{ ticket.number }", k), "Gruppe: IT / 13753", "dype stier og mellomrom");
assert.equal(utfyllMal("a#{config.fqdn}b#{user.finnes_ikke}c#{user}", k), "abc", "ukjent og objekter blir tomme");
assert.equal(utfyllMal(null, k), "");
console.log("signatur: ok");
