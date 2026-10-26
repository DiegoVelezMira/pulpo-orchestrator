// Ayudas comunes de las pantallas de Pulpo: sesión, barra superior, llamadas al servidor y formatos.
(function () {
  var ESTADOS = { recibido: 'Recibido', leido: 'Leído', necesita_ayuda: 'Necesita ayuda', en_espera: 'En espera por tope', revisado: 'Revisado', exportado: 'Exportado' };
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pesos(v) { return v == null ? '—' : '$' + Number(v).toLocaleString('es-CO', { maximumFractionDigits: 2 }); }
  function pill(e) { return '<span class="pill s-' + esc(e) + '">' + esc(ESTADOS[e] || e) + '</span>'; }

  function api(url, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    return fetch(url, init).then(function (r) {
      if (r.status === 401) { location.href = '/entrar.html' + (location.search.indexOf('oficina=') >= 0 ? location.search : ''); return new Promise(function () {}); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('Error ' + r.status)); e.status = r.status; e.datos = j; throw e; }
        return j;
      });
    });
  }

  // Sesión + barra superior. Resuelve { oficinaId, oficinaNombre, nombre, admin }.
  function iniciar(actual) {
    return api('/api/acceso/estado').then(function (s) {
      var q = new URLSearchParams(location.search);
      var oficinaId = s.oficina ? s.oficina.id : Number(q.get('oficina')) || null;
      var info = { oficinaId: oficinaId, oficinaNombre: s.oficina ? s.oficina.nombre : '', nombre: s.nombre, admin: s.rol === 'admin' };
      var sufijo = info.admin && oficinaId ? '?oficina=' + oficinaId : '';
      var nav = [['documentos.html', 'Documentos'], ['cargar.html', 'Cargar']].map(function (n) {
        return '<a class="n" href="/' + n[0] + sufijo + '"' + (n[0] === actual ? ' aria-current="page"' : '') + '>' + n[1] + '</a>';
      }).join('');
      var top = document.createElement('header');
      top.className = 'top';
      top.innerHTML = '<div class="in"><nav><span class="marca">Pulpo</span>' + nav + '</nav><div class="quien"><span>' +
        esc(info.oficinaNombre || (info.admin ? 'Administrador' : '')) + (info.nombre ? ' · ' + esc(info.nombre) : '') +
        '</span><button type="button" id="salir">Salir</button></div></div>';
      document.body.insertBefore(top, document.body.firstChild);
      document.getElementById('salir').onclick = function () {
        fetch('/api/acceso/salir', { method: 'POST' }).then(function () { location.href = '/entrar.html' + (oficinaId && !info.admin ? '?oficina=' + oficinaId : ''); });
      };
      if (!oficinaId) {
        document.querySelector('main').innerHTML = '<div class="card">Entraste como administrador. Abre esta pantalla con <span class="mono">?oficina=NÚMERO</span> para ver una oficina.</div>';
        return new Promise(function () {});
      }
      return info;
    });
  }
  window.Pulpo = { ESTADOS: ESTADOS, esc: esc, pesos: pesos, pill: pill, api: api, iniciar: iniciar };
})();
