// ===== CORREO DE SOPORTE: cámbialo aquí, es el único lugar =====
var CORREO_SOPORTE = "ecora9505@gmail.com";
// ================================================================
(function () {
  var ok = CORREO_SOPORTE.indexOf("@") > 0;
  document.querySelectorAll(".mailLink").forEach(function (a) {
    if (ok) { a.href = "mailto:" + CORREO_SOPORTE; a.textContent = CORREO_SOPORTE; }
  });
  var f = document.getElementById("supportForm");
  if (!f) return;
  f.addEventListener("submit", function (e) {
    e.preventDefault();
    var n = document.getElementById("supName").value.trim() || "Sin nombre";
    var t = document.getElementById("supType").value;
    var m = document.getElementById("supMsg").value.trim();
    var cuerpo = "Hola equipo EcoRA,\n\nMi nombre: " + n + "\nProblema: " + t + "\n\n" + (m || "(sin más detalles)") + "\n\nDispositivo: " + navigator.userAgent;
    location.href = "mailto:" + CORREO_SOPORTE + "?subject=" + encodeURIComponent("Ayuda EcoRA: " + t) + "&body=" + encodeURIComponent(cuerpo);
  });
})();
