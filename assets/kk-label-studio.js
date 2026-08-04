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
  var STAGE_MAX = 820;      // latura mare a zonei de lucru, în px

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
    drawCanvasGuides();
    buildFields();
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
    canvas.on('object:added', function (e) {
      if (e.target && e.target.kkGuide) return;   /* altfel se auto-declanșează la nesfârșit */
      checkResolution();
      syncHint();
      liftGuides();
    });
    canvas.on('object:modified', checkResolution);
    canvas.on('object:removed', function (e) {
      if (e.target && e.target.kkGuide) return;
      checkResolution();
      syncHint();
    });

    syncPanel();
  }

  /* Ghidajele de pe etichetă se desenează ÎN canvas, nu ca DOM peste el:
     stratul DOM ajungea sub canvasul de interacțiune al lui Fabric și nu se
     vedea deloc, oricât de gros era conturul. `excludeFromExport` le ține în
     afara fișierului SVG final — se văd la lucru, nu ajung la tipar.

     Pastilele de zonă și cotele rămân DOM: stau în afara etichetei, unde nu
     există conflict, și acolo se pot stiliza mai bine. */
  var guideObjs = [];

  function drawCanvasGuides() {
    if (!canvas) return;
    guideObjs.forEach(function (o) { canvas.remove(o); });
    guideObjs = [];

    var z = zones();
    function mk(o) {
      o.set({ selectable: false, evented: false, excludeFromExport: true });
      o.kkGuide = true;
      guideObjs.push(o);
      canvas.add(o);
    }

    if (z.back > 0) {
      mk(new fabric.Rect({
        left: z.centerEnd, top: 0,
        width: z.w - z.centerEnd, height: z.h,
        fill: 'rgba(45, 75, 205, 0.07)'
      }));

      [z.frontEnd, z.centerEnd].forEach(function (x) {
        mk(new fabric.Line([x, 0, x, z.h], {
          stroke: '#2d4bcd', strokeWidth: 1, strokeDashArray: [6, 4]
        }));
      });
    }

    /* linia de siguranță — dincolo de ea se poate tăia */
    mk(new fabric.Rect({
      left: z.pad, top: z.pad,
      width: z.w - z.pad * 2, height: z.h - z.pad * 2,
      fill: 'transparent', stroke: '#e81e82', strokeWidth: 1, strokeDashArray: [5, 3]
    }));

    /* conturul de tăiere, pe marginea etichetei */
    mk(new fabric.Rect({
      left: 0.5, top: 0.5,
      width: z.w - 1, height: z.h - 1,
      fill: 'transparent', stroke: '#2d4bcd', strokeWidth: 1
    }));

    liftGuides();
  }

  function liftGuides() {
    if (!canvas) return;
    guideObjs.forEach(function (o) { canvas.bringToFront(o); });
    canvas.requestRenderAll();
  }

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

    if (z.back > 0) {
      out.push('<div class="kk-g-hint" data-kk-hint style="width:' + z.frontEnd +
               'px">Your design goes here</div>');
      out.push(badge(0, z.frontEnd, 'Front'));

      if (z.center > 0) {
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

    /* Rotim doar pe panouri CHIAR înguste, unde altfel n-ar încăpea rândurile.
       Pragul e strict dinadins: la 40 × 45 mm rotirea face textul ilizibil fără
       să rezolve nimic. Regula bună e „mai îngust decât jumătate din înălțime". */
    var rot = bw < z.h * 0.6;
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

    /* Textul legal nu are voie să iasă din panou. Câte rânduri ies depinde de
       cât INCI are produsul, deci mărimea nu se poate fixa dinainte — se
       micșorează până încape. Pe panou rotit, „înălțimea" textului se măsoară
       pe orizontală, adică pe lățimea panoului. */
    var avail = (rot ? bw : z.h) - z.pad * 2;
    var guard = 0;
    while (t.height > avail && t.fontSize > 2 && guard++ < 60) {
      t.set('fontSize', t.fontSize * 0.93);
      t.initDimensions();
    }

    t.set({ left: z.centerEnd + bw / 2, top: z.h / 2 });
    t.setCoords();
    canvas.requestRenderAll();
  }

  /* Îndemnul din zona de lucru dispare de îndată ce clientul pune ceva.
     Panoul legal nu se pune la socoteală — el e acolo mereu. */
  function syncHint() {
    var h = el('[data-kk-hint]');
    if (!h || !canvas) return;
    var mine = canvas.getObjects().filter(function (o) { return !o.kkLocked && !o.kkGuide; });
    h.hidden = mine.length > 0;
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

  /* Butoanele cu datele reale ale produsului. Selfnamed le numește „placeholders";
     rostul lor e ca omul să nu transcrie manual INCI-ul de 40 de ingrediente. */
  function buildFields() {
    var host = el('[data-kk-fieldlist]');
    var src = el('[data-kk-fields]');
    if (!host || !src || host.childNodes.length) return;

    var data = {};
    try { data = JSON.parse(src.textContent) || {}; } catch (e) { return; }

    var html = '';
    Object.keys(data).forEach(function (k) {
      if (!data[k]) return;
      html += '<button type="button" class="kk-chip" data-kk-field="' +
              k.replace(/"/g, '&quot;') + '">' + k + '</button>';
    });
    host.innerHTML = html;
    host.kkData = data;
  }

  function addField(name) {
    var host = el('[data-kk-fieldlist]');
    var value = host && host.kkData ? host.kkData[name] : null;
    if (!value) return;

    var f = frontCentre();
    /* Textele lungi — INCI, mod de folosire — intră ca bloc încadrat, nu ca o
       linie care iese din etichetă. */
    var long = value.length > 60;

    var o = long
      ? new fabric.Textbox(value, {
          width: f.w * 0.8,
          fontSize: Math.max(4, f.h / 26),
          lineHeight: 1.2
        })
      : new fabric.IText(value, { fontSize: Math.round(f.h / 12) });

    o.set({
      left: f.x, top: f.y,
      originX: 'center', originY: 'center',
      fontFamily: 'Helvetica', fill: '#111111'
    });

    canvas.add(o);
    canvas.setActiveObject(o);
    canvas.requestRenderAll();
    syncPanel();
  }

  function addShape(kind) {
    var f = frontCentre();
    var s = Math.min(f.w, f.h) * 0.32;
    var common = {
      left: f.x, top: f.y, originX: 'center', originY: 'center',
      fill: '#1d1d1b'
    };
    var o;

    if (kind === 'circle') o = new fabric.Circle(Object.assign({ radius: s / 2 }, common));
    else if (kind === 'triangle') o = new fabric.Triangle(Object.assign({ width: s, height: s }, common));
    else if (kind === 'line') o = new fabric.Rect(Object.assign({ width: f.w * 0.6, height: Math.max(1, f.h / 60) }, common));
    else o = new fabric.Rect(Object.assign({ width: s, height: s }, common));

    canvas.add(o);
    canvas.setActiveObject(o);
    canvas.requestRenderAll();
    syncPanel();
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
    drawCanvasGuides();
    addLegal();                       /* panoul legal nu se șterge niciodată */
    syncHint();
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

    var chip = t.closest('[data-kk-field]');
    if (chip && canvas) { addField(chip.dataset.kkField); return; }

    var shape = t.closest('[data-kk-shape]');
    if (shape && canvas) { addShape(shape.dataset.kkShape); return; }

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

    /* Ghidajele se pot stinge — pe un design aproape gata încep să încurce. */
    if (e.target.matches('[data-kk-guides-toggle]')) {
      var on = e.target.checked;
      var g = el('[data-kk-guides]');
      if (g) g.style.display = on ? '' : 'none';
      guideObjs.forEach(function (o) { o.set('visible', on); });
      if (canvas) canvas.requestRenderAll();
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
