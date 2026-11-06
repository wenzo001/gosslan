/* Gosslan Pulse — component bundle entry.
   The previews are static HTML documents; this global exists so the
   design-system page can mount the system without a missing-bundle warning. */
(function () {
  var GosslanPulse = {
    version: "2.2.0",
    name: "Gosslan Pulse",
    tokens: {
      accent: "#2f6bff",
      spark: "#fa5151",
      mint: "#07c160",
      lemon: "#ffb400",
      radiusControl: "10px",
      radiusCard: "16px",
      radiusBubble: "20px",
      radiusSheet: "22px",
      rowHeight: "62px",
      mobileRowHeight: "64px",
      minTap: "44px"
    }
  };
  window.GosslanPulse = GosslanPulse;
})();
