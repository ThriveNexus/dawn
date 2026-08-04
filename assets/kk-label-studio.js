/*
  KOSMETIKAL — Label Studio
  Editor de etichetă în pagina de produs.

  Ce produce: un PNG la 300 DPI, la dimensiunea reală a etichetei, pe care îl pune
  în câmpul de upload existent. De acolo merge la comandă pe fluxul deja testat —
  fără cale nouă de salvare, fără backend.

  Ce NU produce încă: fișier print-ready (dieline, bleed, CMYK, zone legale blocate).
  Alea cer specul printerului italian, care lipsește. Structura de aici le suportă:
  se adaugă un strat de export, restul rămâne.

  Fabric.js se încarcă abia la prima deschidere — 300 KB pe care nu-i plătește
  nimeni care doar se uită la produs.
*/
(function () {
  'use strict';

  var DPI = 300;
  var MM_PER_INCH = 25.4;
  var SAFE_MM = 3;          // margine în care nu se pune nimic important
  var STAGE_MAX = 560;      // latura mare a zonei de lucru, în px

  var canvas = null;        // instanța Fabric
  var loading = false;
  var conf = null;

  /* ---------- utilitare ---------- */

  function el(sel, root) { return (root || document).querySelector(sel); }
  function els(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* Dawn re-randează coloana de produs și ar recrea studioul acolo unde era.
     Îl ținem pe cel mutat în <body> — el are canvasul construit — și îi ștergem
     pe ceilalți. Fără asta, al doilea click ar lucra pe un canvas gol. */
  function studio() {
    var all = document.querySelectorAll('[data-kk-studio]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].parentElement === document.body) return all[i];
    }
    return all[0] || null;
  }

  function normalize() {
    var keep = studio();
    if (!keep) return null;
    if (keep.parentElement !== document.body) document.body.appendChild(keep);

    var all = document.querySelectorAll('[data-kk-studio]');
    for (var i = 0; i < all.length; i++) {
      if (all[i] !== keep) all[i].parentElement.removeChild(all[i]);
    }
    return keep;
  }

  function readConf() {
    var s = studio();
    if (!s) return null;
    var w = parseFloat(s.dataset.kkLw);
    var h = parseFloat(s.dataset.kkLh);
    if (!(w > 0) || !(h > 0)) return null;
    return {
      w: w,
      h: h,
      back: parseFloat(s.dataset.kkBack) || 0,
      center: parseFloat(s.dataset.kkCenter) || 0,
      legal: s.dataset.kkLegal || '',
      fabricUrl: s.dataset.kkFabric,
      name: s.dataset.kkName || '',
      root: s
    };
  }

  /* Eticheta desfășurată, în px pe zona de lucru: față | centru | spate.
     Fața e ce rămâne după ce scazi cotorul și panoul legal. */
  function zones() {
    var size = stageSize(conf);
    var perMm = size.w / conf.w;
    var back = conf.back * perMm;
    var center = conf.center * perMm;
    var frontEnd = Math.max(0, size.w - back - center);
    return {
      w: size.w,
      h: size.h,
      pad: SAFE_MM * perMm,
      back: back,
      center: center,
      frontEnd: frontEnd,
      centerEnd: frontEnd + center
    };
  }

  function mmToPx(mm) { return Math.round(mm / MM_PER_INCH * DPI); }

  /* Zona de lucru păstrează proporția etichetei și încape în STAGE_MAX. */
  function stageSize(c) {
    var ratio = c.w / c.h;
    return ratio >= 1
      ? { w: STAGE_MAX, h: Math.round(STAGE_MAX / ratio) }
      : { w: Math.round(STAGE_MAX * ratio), h: STAGE_MAX };
  }

  /* ---------- încărcarea bibliotecii ---------- */

  function withFabric(cb) {
    if (window.fabric) return cb();
    if (loading) return;
    loading = true;

    var s = document.createElement('script');
    s.src = conf.fabricUrl;
    s.onload = function () { loading = false; cb(); };
    s.onerror = function () {
      loading = false;
      alert('The design studio could not be loaded. Please upload a ready file instead.');
    };
    document.head.appendChild(s);
  }

  /* ---------- construcția editorului ---------- */

  function build() {
    if (canvas) return;

    var size = stageSize(conf);
    var node = el('[data-kk-canvas]');
    node.width = size.w;
    node.height = size.h;

    canvas = new fabric.Canvas(node, {
      backgroundColor: '#ffffff',
      preserveObjectStacking: true,
      selection: true
    });

    canvas.setDimensions({ width: size.w, height: size.h });

    /* Ghidajul de siguranță e un element DOM peste canvas, nu un obiect Fabric —
       altfel ar ajunge în exportul final. */
    drawGuides();
    addLegal();

    /* Obiectele clientului rămân pe față — altfel ar acoperi panoul legal. */
    canvas.on('object:moving', function (e) {
      var o = e.target;
      if (!o || o.kkLocked) return;
      var z = zones();
      if (z.back <= 0) return;
      var c = o.getCenterPoint();
      var nx = Math.min(Math.max(c.x, 0), z.frontEnd);
      if (nx !== c.x) o.setPositionByOrigin(new fabric.Point(nx, c.y), 'center', 'center');
    });

    canvas.on('selection:created', syncPanel);
    canvas.on('selection:updated', syncPanel);
    canvas.on('selection:cleared', syncPanel);
    canvas.on('object:added', checkResolution);
    canvas.on('object:modified', checkResolution);
    canvas.on('object:removed', checkResolution);

    syncPanel();
  }

  /* Ghidajele stau ca DOM peste canvas, nu ca obiecte Fabric — altfel ar ajunge
     în fișierul exportat. Linia de siguranță e ce se poate tăia la tipar. */
  function badge(left, width, text, cls) {
    /* pastilă centrată peste zona ei */
    return '<span class="kk-g-badge' + (cls || '') + '" style="left:' +
           (left + width / 2) + 'px">' + text + '</span>';
  }

  function drawGuides() {
    var g = el('[data-kk-guides]');
    if (!g) return;
    var z = zones();
    var out = [];

    /* linia de tăiere, pe conturul etichetei, și cea de siguranță, înăuntru */
    out.push('<div class="kk-g-cut"></div>');
    out.push('<div class="kk-g-safe" style="inset:' + z.pad + 'px"></div>');

    if (z.back > 0) {
      out.push('<div class="kk-g-lock" style="left:' + z.centerEnd +
               'px;width:' + (z.w - z.centerEnd) + 'px"></div>');

      out.push('<div class="kk-g-div" style="left:' + z.frontEnd + 'px"></div>');
      out.push(badge(0, z.frontEnd, 'Front'));

      if (z.center > 0) {
        out.push('<div class="kk-g-div" style="left:' + z.centerEnd + 'px"></div>');
        out.push(badge(z.frontEnd, z.center, 'Seam', ' kk-g-badge--mute'));
      }

      out.push(badge(z.centerEnd, z.w - z.centerEnd, 'Back &middot; locked', ' kk-g-badge--lock'));
    } else {
      out.push(badge(0, z.w, 'Front'));
    }

    /* cotele, ca pe un dieline: milimetri reali și pixelii la 300 dpi */
    out.push('<span class="kk-g-dim kk-g-dim--w">' + conf.w + ' mm &middot; ' + mmToPx(conf.w) + ' px</span>');
    out.push('<span class="kk-g-dim kk-g-dim--h">' + conf.h + ' mm &middot; ' + mmToPx(conf.h) + ' px</span>');

    g.innerHTML = out.join('');
  }

  /* Panoul legal: text obligatoriu prin Reg. (UE) 1223/2009 art. 19.
     Nu e selectabil și nu primește evenimente — clientul nu-l poate muta,
     nici șterge. Dacă ar putea, produsul ar deveni neconform. */
  function addLegal() {
    if (!conf.legal) return;
    var z = zones();
    if (z.back <= 0) return;

    var perMm = z.w / conf.w;
    var bw = z.w - z.centerEnd;

    /* Pe un panou mai îngust decât înalt, textul se rotește — așa se face pe
       etichetele reale, altfel nu încap rândurile. Vezi orice flacon de cosmetic. */
    var rot = bw < z.h;
    var box = (rot ? z.h : bw) - z.pad * 2;

    var t = new fabric.Textbox(conf.legal, {
      width: Math.max(20, box),
      /* ~1,7 mm ≈ 5 pt — mărimea reală a textului legal, nu una comodă */
      fontSize: Math.max(3, 1.7 * perMm),
      lineHeight: 1.15,
      charSpacing: -10,
      fontFamily: 'Helvetica',
      fill: '#111111',
      originX: 'center',
      originY: 'center',
      left: z.centerEnd + bw / 2,
      top: z.h / 2,
      angle: rot ? -90 : 0,
      selectable: false,
      evented: false
    });
    t.kkLocked = true;
    canvas.add(t);
    canvas.requestRenderAll();
  }

  /* Un JPEG de 400px nu poate deveni etichetă la 300 dpi. Se spune la încărcare,
     nu se descoperă la tipar. Rezoluția efectivă depinde de cât de mare e întinsă
     imaginea pe etichetă, deci se recalculează la fiecare mutare sau scalare. */
  function checkResolution() {
    var warn = el('[data-kk-lowres]');
    if (!warn || !canvas) return;

    var size = stageSize(conf);
    var worst = null;

    canvas.getObjects().forEach(function (o) {
      if (o.type !== 'image' || !o._element || !o._element.naturalWidth) return;
      var mmWide = (o.getScaledWidth() / size.w) * conf.w;
      if (mmWide <= 0) return;
      var dpi = o._element.naturalWidth / (mmWide / MM_PER_INCH);
      if (worst === null || dpi < worst) worst = dpi;
    });

    if (worst !== null && worst < 150) {
      warn.textContent =
        'One image is about ' + Math.round(worst) + ' DPI at this size. ' +
        'Under 150 DPI it prints soft — use a bigger file, or scale it down.';
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  }

  /* ---------- panoul de unelte ---------- */

  function active() { return canvas ? canvas.getActiveObject() : null; }

  function syncPanel() {
    var o = active();
    var isText = !!(o && o.type === 'i-text');

    var sel = el('[data-kk-selected]');
    if (sel) sel.hidden = !o;

    els('[data-kk-text-only]').forEach(function (n) { n.hidden = !isText; });

    if (isText) {
      var f = el('[data-kk-font]');
      var sz = el('[data-kk-size]');
      var col = el('[data-kk-color]');
      if (f) f.value = o.fontFamily;
      if (sz) sz.value = Math.round(o.fontSize);
      if (col) col.value = o.fill;
    }
  }

  /* mijlocul feței, nu al etichetei desfășurate */
  function frontCentre() {
    var z = zones();
    return { x: (z.back > 0 ? z.frontEnd : z.w) / 2, y: z.h / 2, w: (z.back > 0 ? z.frontEnd : z.w), h: z.h };
  }

  function addText() {
    var f = frontCentre();
    var t = new fabric.IText('Your brand', {
      left: f.x,
      top: f.y,
      originX: 'center',
      originY: 'center',
      fontFamily: 'Helvetica',
      fontSize: Math.round(f.h / 10),
      fill: '#111111'
    });
    canvas.add(t);
    canvas.setActiveObject(t);
    canvas.requestRenderAll();
    syncPanel();
  }

  function addImage(file) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      alert('That image is larger than 12 MB. Please use a smaller file.');
      return;
    }

    var r = new FileReader();
    r.onload = function (ev) {
      fabric.Image.fromURL(ev.target.result, function (img) {
        var f = frontCentre();
        /* încape pe jumătate din față, ca să rămână loc de text */
        var scale = Math.min((f.w * 0.5) / img.width, (f.h * 0.5) / img.height);
        img.set({
          left: f.x,
          top: f.y,
          originX: 'center',
          originY: 'center',
          scaleX: scale,
          scaleY: scale
        });
        canvas.add(img);
        canvas.setActiveObject(img);
        canvas.requestRenderAll();
        syncPanel();
      });
    };
    r.readAsDataURL(file);
  }

  function removeActive() {
    var o = active();
    if (!o) return;
    canvas.remove(o);
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    syncPanel();
  }

  function reset() {
    if (!canvas) return;
    canvas.clear();
    canvas.backgroundColor = '#ffffff';
    addLegal();                       /* panoul legal nu se șterge niciodată */
    canvas.requestRenderAll();
    var bg = el('[data-kk-bg]');
    if (bg) bg.value = '#ffffff';
    syncPanel();
  }

  /* ---------- export ---------- */

  function slug(s) {
    return (s || 'label').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  }

  /* Ieșirea e SVG, nu PNG.

     Claudio a cerut explicit fișier vectorial, pe care să poată lucra un grafician.
     Iar asta e o decizie de model de date, nu de format de export: dacă pornești pe
     raster, textul se aplatizează la prima salvare și nu se mai poate recupera.
     În SVG, textul rămâne text și formele rămân forme.

     Ce NU devine vector: un logo urcat ca PNG sau JPG rămâne raster, încorporat în
     SVG. Ca să fie vector cap-coadă, clientul trebuie să urce tot SVG.

     Dimensiunile sunt în milimetri reali, cu viewBox pe sistemul de coordonate al
     zonei de lucru — deci fișierul se deschide la scara corectă în Illustrator. */
  function handOff() {
    if (!canvas) return false;

    canvas.discardActiveObject();
    canvas.requestRenderAll();

    var size = stageSize(conf);
    var svg = canvas.toSVG({
      width: conf.w + 'mm',
      height: conf.h + 'mm',
      viewBox: { x: 0, y: 0, width: size.w, height: size.h }
    });

    var input = el('[data-kk-file]');
    if (!input) return false;

    var file = new File(
      [svg],
      slug(conf.name) + '-label-' + conf.w + 'x' + conf.h + 'mm.svg',
      { type: 'image/svg+xml' }
    );

    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
    } catch (e) {
      alert('Your browser could not attach the design automatically. Please download it and upload the file.');
      return false;
    }

    /* Handlerul existent din blocul de butoane ascultă „change" — el schimbă
       eticheta butonului și confirmă atașarea. */
    input.dispatchEvent(new Event('change', { bubbles: true }));

    var note = el('[data-kk-studio-note]');
    if (note) {
      note.textContent = 'Designed in the studio — vector file, ' + conf.w + ' × ' + conf.h + ' mm.';
      note.hidden = false;
    }
    return true;
  }

  /* ---------- deschidere / închidere ---------- */

  function open() {
    normalize();
    conf = readConf();
    if (!conf) return;

    withFabric(function () {
      build();
      conf.root.hidden = false;
      document.body.style.overflow = 'hidden';
      if (window.Shopify && Shopify.analytics && typeof Shopify.analytics.publish === 'function') {
        try { Shopify.analytics.publish('design_studio_opened', { product: conf.name }); } catch (e) {}
      }
    });
  }

  function close() {
    var s = studio();
    if (!s) return;
    s.hidden = true;
    document.body.style.overflow = '';
  }

  /* ---------- legături ---------- */

  document.addEventListener('click', function (e) {
    var t = e.target;

    if (t.closest('[data-kk-studio-open]')) { e.preventDefault(); open(); return; }
    if (t.closest('[data-kk-studio-close]')) { close(); return; }
    if (t.closest('[data-kk-add-text]')) { addText(); return; }
    if (t.closest('[data-kk-del]')) { removeActive(); return; }
    if (t.closest('[data-kk-reset]')) { reset(); return; }

    if (t.closest('[data-kk-studio-done]')) {
      if (handOff()) close();
      return;
    }

    var sw = t.closest('[data-kk-swatch]');
    if (sw && canvas) {
      canvas.backgroundColor = sw.dataset.kkSwatch;
      canvas.requestRenderAll();
      var bg = el('[data-kk-bg]');
      if (bg) bg.value = sw.dataset.kkSwatch;
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target.matches('[data-kk-add-image]')) {
      addImage(e.target.files && e.target.files[0]);
      e.target.value = '';
    }
  });

  document.addEventListener('input', function (e) {
    if (!canvas) return;
    var o = active();

    if (e.target.matches('[data-kk-bg]')) {
      canvas.backgroundColor = e.target.value;
      canvas.requestRenderAll();
    }
    if (!o) return;

    if (e.target.matches('[data-kk-font]'))  { o.set('fontFamily', e.target.value); canvas.requestRenderAll(); }
    if (e.target.matches('[data-kk-size]'))  { o.set('fontSize', parseInt(e.target.value, 10)); canvas.requestRenderAll(); }
    if (e.target.matches('[data-kk-color]')) { o.set('fill', e.target.value); canvas.requestRenderAll(); }
  });

  document.addEventListener('keydown', function (e) {
    var s = studio();
    if (!s || s.hidden) return;
    if (e.key === 'Escape') close();
    /* Delete pe obiect, dar nu în timp ce se tastează într-un text */
    if ((e.key === 'Delete' || e.key === 'Backspace')) {
      var o = active();
      if (o && !(o.type === 'i-text' && o.isEditing)) {
        e.preventDefault();
        removeActive();
      }
    }
  });
})();
