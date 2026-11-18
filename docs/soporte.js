// ===== CORREO DE SOPORTE: cámbialo aquí, es el único lugar =====
var CORREO_SOPORTE = "ecora9505@gmail.com";
// ================================================================
(function () {
  var ok = CORREO_SOPORTE.indexOf("@") > 0;
  document.querySelectorAll(".mailLink").forEach(function (a) {
    if (ok) { a.href = "mailto:" + CORREO_SOPORTE; a.textContent = CORREO_SOPORTE; }
  });
  // El correo se manda desde el servidor (Apps Script, acción "soporte"),
  // así el alumno solo le pica a "Enviar correo" y ya.
  var f = document.getElementById("supportForm");
  if (!f) return;
  var btn = document.getElementById("supSend");
  var aviso = document.getElementById("supNotice");

  function avisar(texto, error) {
    aviso.textContent = texto;
    aviso.classList.toggle("error", !!error);
  }

  f.addEventListener("submit", function (e) {
    e.preventDefault();
    var n = document.getElementById("supName").value.trim();
    var correo = document.getElementById("supEmail").value.trim();
    var t = document.getElementById("supType").value;
    var m = document.getElementById("supMsg").value.trim();

    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
      avisar("Revisa tu correo, parece que está mal escrito.", true);
      return;
    }
    if (!m && t === "Otra cosa") {
      avisar("Cuéntanos qué pasó para poder ayudarte.", true);
      return;
    }

    btn.disabled = true;
    btn.textContent = "Enviando…";
    avisar("", false);

    fetch(CONFIG.SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "soporte",
        nombre: n || "Sin nombre",
        correo: correo,
        problema: t,
        mensaje: m || "(sin más detalles)",
        dispositivo: navigator.userAgent
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r && r.ok) {
          f.reset();
          avisar("¡Listo! Tu mensaje le llegó al equipo de EcoRA." + (correo ? " Te respondemos a tu correo." : ""), false);
        } else {
          avisar("No se pudo enviar ahorita. Intenta más tarde o escríbenos a " + CORREO_SOPORTE + ".", true);
        }
      })
      .catch(function () {
        avisar("No hay conexión o algo falló. Intenta otra vez o escríbenos a " + CORREO_SOPORTE + ".", true);
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = "Enviar correo";
      });
  });
})();
