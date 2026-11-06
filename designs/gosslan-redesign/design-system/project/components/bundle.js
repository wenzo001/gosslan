/* Gosslan Still — component bundle entry.
   The previews are static HTML documents; this global exists so the
   design-system page can mount the system without a missing-bundle warning. */
(function () {
  var GosslanStill = {
    version: "1.0.0",
    name: "Gosslan Still",
    tokens: {
      accent: "#2f6beb",
      radiusControl: "8px",
      radiusBubble: "18px"
    }
  };
  window.GosslanStill = GosslanStill;
})();
