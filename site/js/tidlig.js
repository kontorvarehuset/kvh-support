/*
 * Kjører FØR stilarket maler, som vanlig (ikke-modul) skript i head, slik at innbygd-modus og tema er satt før noe vises.
 * Uten dette ville siden blinket med feil bakgrunn i et øyeblikk når RMM-et viser den i et vindu.
 *
 * `?innbygd=1&tema=lys|mork`: siden ligger i en ramme i RMM-et. Bakgrunnen blir gjennomsiktig (se app.css), og
 * temaet følger RMM-et. Nettleseren gjør bare en ramme gjennomsiktig hvis rammen og siden rundt har SAMME
 * color-scheme, derfor må temaet være det samme på begge sider.
 */
(function () {
  var p = new URLSearchParams(location.search);
  if (p.get("innbygd") !== "1") return;
  var r = document.documentElement;
  r.setAttribute("data-innbygd", "1");
  var t = p.get("tema");
  if (t === "lys") r.setAttribute("data-theme", "light");
  else if (t === "mork") r.setAttribute("data-theme", "dark");
})();
