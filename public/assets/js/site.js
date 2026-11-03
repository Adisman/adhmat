// ADHMAT site: mobile menu and level calculator (no external dependencies)
(function () {
  var btn = document.querySelector(".menu-btn");
  var nav = document.getElementById("site-nav");
  if (btn && nav) {
    btn.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  // Maturity level calculator (bands as documented in the ADHMAT tool)
  var range = document.getElementById("pct-range");
  if (range) {
    var out = document.getElementById("calc-out");
    var pctEl = document.getElementById("pct-val");
    var bands = [
      { min: 85, code: "L5", name: "Optimized", cls: "lv5", text: "Continental benchmark, continuous improvement." },
      { min: 70, code: "L4", name: "Advanced", cls: "lv4", text: "Strong performance, optimisation needed." },
      { min: 55, code: "L3", name: "Established", cls: "lv3", text: "Meeting minimum standards, consolidation needed." },
      { min: 40, code: "L2", name: "Emerging", cls: "lv2", text: "Early development, significant gaps remain." },
      { min: 0, code: "L1", name: "Nascent", cls: "lv1", text: "Foundation missing, immediate action needed." }
    ];
    var update = function () {
      var v = Number(range.value);
      pctEl.textContent = v + "%";
      var b = bands.find(function (x) { return v >= x.min; });
      out.className = "calc-out " + b.cls;
      out.querySelector("small").textContent = b.code + " · LEVEL";
      out.querySelector("strong").textContent = b.name;
      out.querySelector("p").textContent = b.text;
      range.setAttribute("aria-valuetext", v + " percent, " + b.name);
    };
    range.addEventListener("input", update);
    update();
  }
})();
