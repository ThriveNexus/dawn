/*
  KOSMETIKAL — Label Studio
  Editor de etichetă în pagina de produs.

  Ce produce: un pachet ZIP construit în browser — print.pdf (vectorial, text
  conturat), print.svg, editable.svg (master cu text viu + fonturi înglobate),
  fonturile TTF cu licențele OFL și un README. Pachetul intră în câmpul de upload
  existent, deci merge la comandă pe fluxul deja testat — fără backend.

  Ce NU produce încă: culori CMYK (cere PDF cu profil ICC, adică serverul din V2)
  și conturul real de tăiere (cere dieline de la furnizorul de ambalaj).
  Structura le suportă pe amândouă: se schimbă stratul de export și geometria
  planșei, restul rămâne.

  Fabric.js se încarcă abia la prima deschidere — 300 KB pe care nu-i plătește
  nimeni care doar se uită la produs.
*/
(function () {
  'use strict';

  var DPI = 300;
  var MM_PER_INCH = 25.4;
  var SAFE_MM = 3;          // margine în care nu se pune nimic important
  var STAGE_MAX = 820;      // latura mare a zonei de lucru, în px
  var SNAP = 6;             // toleranța de agățare la aliniere, în px

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
      bleed: parseFloat(s.dataset.kkBleed) || 0,
      legal: s.dataset.kkLegal || '',
      fabricUrl: s.dataset.kkFabric,
      libs: parseJsonAttr(s.dataset.kkLibs),
      fonts: parseJsonAttr(s.dataset.kkFonts),
      fontlic: s.dataset.kkFontlic || '',
      name: s.dataset.kkName || '',
      root: s
    };
  }

  function parseJsonAttr(v) {
    try { return JSON.parse(v || '{}') || {}; } catch (e) { return {}; }
  }

  /* Eticheta desfășurată, în px pe zona de lucru: față | centru | spate.
     Fața e ce rămâne după ce scazi cotorul și panoul legal. */
  function zones() {
    var size = stageSize(conf);
    var perMm = size.w / (conf.w + conf.bleed * 2);
    var b = conf.bleed * perMm;
    var tw = conf.w * perMm;
    var th = conf.h * perMm;
    var back = conf.back * perMm;
    var center = conf.center * perMm;
    var frontEnd = b + Math.max(0, tw - back - center);
    return {
      w: size.w, h: size.h,        /* planșa întreagă, bleed inclus */
      perMm: perMm,
      b: b,                        /* lățimea bleed-ului, în px */
      x: b, y: b, tw: tw, th: th,  /* dreptunghiul de tăiere, în coordonate de canvas */
      pad: SAFE_MM * perMm,
      back: back,
      center: center,
      frontEnd: frontEnd,
      centerEnd: frontEnd + center
    };
  }

  function mmToPx(mm) { return Math.round(mm / MM_PER_INCH * DPI); }

  /* Zona de lucru păstrează proporția etichetei și încape în STAGE_MAX. */
  /* Planșa e eticheta plus bleed pe fiecare latură — asta e suprafața pe care
     se desenează și care ajunge la tipar. Tăierea se face pe dinăuntru. */
  function stageSize(c) {
    var W = c.w + c.bleed * 2;
    var H = c.h + c.bleed * 2;
    var ratio = W / H;
    return ratio >= 1
      ? { w: STAGE_MAX, h: Math.round(STAGE_MAX / ratio) }
      : { w: Math.round(STAGE_MAX * ratio), h: STAGE_MAX };
  }

  /* ---------- încărcarea bibliotecii ---------- */

  /* Fonturile editorului, găzduite în temă (OFL). Randarea pe canvas măsoară
     textul O SINGURĂ DATĂ, la crearea obiectului — dacă fontul real nu e gata,
     măsurătorile se fac pe fontul de rezervă și layoutul rămâne strâmb și după
     ce fontul sosește. De asta construcția așteaptă fonturile, cu plafon de
     3 secunde ca să nu blocheze studioul dacă un fișier nu se încarcă. */
  var FONT_FAMILIES = ['Montserrat', 'Inter', 'Source Sans 3', 'Bodoni Moda', 'Archivo Narrow', 'Arimo'];

  /* Descărcarea pornește o singură dată și cât mai devreme — la primul click pe
     „Add design", nu la deschiderea studioului. Sunt ~3 MB; secundele dintre
     deschiderea sertarului și intrarea în studio sunt exact avansul care lipsea. */
  var fontsPromise = null;
  var fontsSettled = false;

  function kickFonts() {
    if (fontsPromise || !document.fonts || !document.fonts.load) return fontsPromise;
    fontsPromise = Promise.all(FONT_FAMILIES.map(function (f) {
      return document.fonts.load('16px "' + f + '"')['catch'](function () {});
    }));
    fontsPromise.then(function () { fontsSettled = true; }, function () { fontsSettled = true; });
    return fontsPromise;
  }

  function withFonts(cb) {
    var p = kickFonts();
    if (!p) return cb();
    var done = false;
    function once() { if (!done) { done = true; cb(); } }
    p.then(once, once);
    setTimeout(once, 3000);
  }

  /* Plafonul de 3s poate expira înaintea fonturilor. Canvasul măsoară textul la
     crearea obiectului, deci ce s-a creat pe fontul de rezervă rămâne strâmb și
     după ce sosește fontul bun. Când ajung târziu: golim cache-ul de lățimi al
     lui Fabric, remăsurăm textele clientului și reconstruim panoul legal —
     mărimea lui se calculase tot pe metrici greșite. */
  function lateFontRefresh() {
    if (!canvas) return;
    if (window.fabric && fabric.charWidthsCache) fabric.charWidthsCache = {};

    var hadLegal = false;
    canvas.getObjects().slice().forEach(function (o) {
      if (o.kkGuide) return;
      if (o.kkLocked) { canvas.remove(o); hadLegal = true; return; }
      if ((o.type === 'i-text' || o.type === 'textbox') && o.initDimensions) {
        o.initDimensions();
        o.setCoords();
      }
    });
    if (hadLegal) addLegal();

    canvas.requestRenderAll();
    renderLayers();
  }

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

    /* Obiectele clientului rămân pe față, iar la mutare se aliniază singure
       pe axele feței — linia verde apare doar cât ține alinierea, ca în orice
       editor de prezentări. */
    canvas.on('object:moving', function (e) {
      var o = e.target;
      if (!o || o.kkLocked || o.kkGuide) return;

      var z = zones();
      clearSnap();

      var c = o.getCenterPoint();
      if (z.back > 0) {
        var nx = Math.min(Math.max(c.x, 0), z.frontEnd);
        if (nx !== c.x) {
          o.setPositionByOrigin(new fabric.Point(nx, c.y), 'center', 'center');
          c = o.getCenterPoint();
        }
      }

      var f = frontCentre();
      var mx = f.x, my = f.y;

      if (Math.abs(c.x - mx) < SNAP) {
        o.setPositionByOrigin(new fabric.Point(mx, c.y), 'center', 'center');
        snapLine(mx, z.y, mx, z.y + z.th);
        c = o.getCenterPoint();
      }
      if (Math.abs(c.y - my) < SNAP) {
        o.setPositionByOrigin(new fabric.Point(c.x, my), 'center', 'center');
        snapLine(z.x, my, z.frontEnd > z.x ? z.frontEnd : z.x + z.tw, my);
      }
    });

    /* Rotirea se prinde din 15 în 15 grade, ca să nimerești drept fără efort. */
    canvas.on('object:rotating', function (e) {
      var o = e.target;
      if (!o) return;
      var a = ((o.angle % 360) + 360) % 360;
      var near = Math.round(a / 15) * 15;
      if (Math.abs(a - near) < 4) o.set('angle', near % 360);
    });

    canvas.on('object:modified', clearSnap);
    canvas.on('mouse:up', clearSnap);

    function refresh() { syncPanel(); renderLayers(); }

    canvas.on('selection:created', refresh);
    canvas.on('selection:updated', refresh);
    canvas.on('selection:cleared', refresh);
    canvas.on('object:added', function (e) {
      if (e.target && e.target.kkGuide) return;   /* altfel se auto-declanșează la nesfârșit */
      checkResolution();
      syncHint();
      liftGuides();
      renderLayers();
    });
    canvas.on('object:modified', function () { checkResolution(); clearSnap(); renderLayers(); });
    canvas.on('object:removed', function (e) {
      if (e.target && e.target.kkGuide) return;
      checkResolution();
      syncHint();
      renderLayers();
    });
    /* textul editat pe canvas schimbă și numele stratului */
    canvas.on('text:changed', renderLayers);

    syncPanel();
    renderLayers();
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
        left: z.centerEnd, top: z.y,
        width: z.x + z.tw - z.centerEnd, height: z.th,
        fill: 'rgba(45, 75, 205, 0.07)'
      }));

      [z.frontEnd, z.centerEnd].forEach(function (x) {
        mk(new fabric.Line([x, z.y, x, z.y + z.th], {
          stroke: '#2d4bcd', strokeWidth: 1, strokeDashArray: [6, 4]
        }));
      });
    }

    /* Convenția de tipar: întrerupt = tăiere, continuu = zona sigură.
       Un tipograf citește desenul după ea, deci nu se inversează. */
    mk(new fabric.Rect({
      left: z.x + z.pad, top: z.y + z.pad,
      width: z.tw - z.pad * 2, height: z.th - z.pad * 2,
      fill: 'transparent', stroke: '#e81e82', strokeWidth: 1
    }));

    mk(new fabric.Rect({
      left: z.x, top: z.y, width: z.tw, height: z.th,
      fill: 'transparent', stroke: '#2d4bcd', strokeWidth: 1, strokeDashArray: [7, 4]
    }));

    /* Marginea planșei = limita bleed-ului. Grafica de fundal trebuie să ajungă
       până aici, nu până la linia de tăiere. */
    if (z.b > 0) {
      mk(new fabric.Rect({
        left: 0.5, top: 0.5, width: z.w - 1, height: z.h - 1,
        fill: 'transparent', stroke: '#e08a1e', strokeWidth: 1, strokeDashArray: [3, 3]
      }));
    }

    liftGuides();
  }

  /* Liniile de aliniere apar cât ține alinierea și dispar la eliberare. */
  var snapLines = [];

  function clearSnap() {
    if (!canvas || !snapLines.length) return;
    snapLines.forEach(function (o) { canvas.remove(o); });
    snapLines = [];
    canvas.requestRenderAll();
  }

  function snapLine(x1, y1, x2, y2) {
    var l = new fabric.Line([x1, y1, x2, y2], {
      stroke: '#12b8a6', strokeWidth: 1, strokeDashArray: [4, 4],
      selectable: false, evented: false, excludeFromExport: true
    });
    l.kkGuide = true;
    snapLines.push(l);
    canvas.add(l);
    canvas.bringToFront(l);
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
    var k = zoom;                 /* pastilele sunt DOM, deci urmăresc mărimea reală */
    var out = [];

    if (z.back > 0) {
      out.push('<div class="kk-g-hint" data-kk-hint style="left:' + z.x * k +
               'px;width:' + (z.frontEnd - z.x) * k + 'px">Your design goes here</div>');
      out.push(badge(z.x * k, (z.frontEnd - z.x) * k, 'Front'));

      if (z.center > 0) {
        out.push(badge(z.frontEnd * k, z.center * k, 'Seam', ' kk-g-badge--mute'));
      }

      out.push(badge(z.centerEnd * k, (z.x + z.tw - z.centerEnd) * k, 'Back &middot; locked', ' kk-g-badge--lock'));
    } else {
      out.push(badge(z.x * k, z.tw * k, 'Front'));
    }

    /* cotele sunt ale etichetei tăiate, nu ale planșei — aia e mărimea reală */
    out.push('<span class="kk-g-dim kk-g-dim--w">' + conf.w + ' mm &middot; ' + mmToPx(conf.w) + ' px</span>');
    out.push('<span class="kk-g-dim kk-g-dim--h">' + conf.h + ' mm &middot; ' + mmToPx(conf.h) + ' px</span>');
    if (conf.bleed > 0) {
      out.push('<span class="kk-g-bleed">+ ' + conf.bleed + ' mm bleed</span>');
    }

    g.innerHTML = out.join('');
  }

  /* Panoul legal: text obligatoriu prin Reg. (UE) 1223/2009 art. 19.
     Nu e selectabil și nu primește evenimente — clientul nu-l poate muta,
     nici șterge. Dacă ar putea, produsul ar deveni neconform. */
  function addLegal() {
    if (!conf.legal) return;
    var z = zones();
    if (z.back <= 0) return;

    var perMm = z.perMm;
    var bw = z.x + z.tw - z.centerEnd;

    /* Rotim doar pe panouri CHIAR înguste, unde altfel n-ar încăpea rândurile.
       Pragul e strict dinadins: la 40 × 45 mm rotirea face textul ilizibil fără
       să rezolve nimic. Regula bună e „mai îngust decât jumătate din înălțime". */
    var rot = bw < z.th * 0.6;
    var box = (rot ? z.th : bw) - z.pad * 2;

    var t = new fabric.Textbox(conf.legal, {
      width: Math.max(20, box),
      /* ~1,7 mm ≈ 5 pt — mărimea reală a textului legal, nu una comodă */
      fontSize: Math.max(3, 1.7 * perMm),
      lineHeight: 1.15,
      charSpacing: -10,
      /* Inter ține la mărimi mici — de asta e fontul panoului legal */
      fontFamily: 'Inter',
      fill: '#111111',
      originX: 'center',
      originY: 'center',
      left: z.centerEnd + bw / 2,
      top: z.y + z.th / 2,
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
    var avail = (rot ? bw : z.th) - z.pad * 2;
    var guard = 0;
    while (t.height > avail && t.fontSize > 2 && guard++ < 60) {
      t.set('fontSize', t.fontSize * 0.93);
      t.initDimensions();
    }

    t.set({ left: z.centerEnd + bw / 2, top: z.y + z.th / 2 });
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

    var z = zones();
    var worst = null;

    canvas.getObjects().forEach(function (o) {
      if (o.type !== 'image' || !o._element || !o._element.naturalWidth) return;
      var mmWide = o.getScaledWidth() / z.perMm;
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

  /* ---------- straturi ---------- */

  var seq = 0;

  function idOf(o) {
    if (!o.kkId) o.kkId = 'o' + (++seq);
    return o.kkId;
  }

  function byId(id) {
    var hit = null;
    canvas.getObjects().forEach(function (o) { if (o.kkId === id) hit = o; });
    return hit;
  }

  function layerName(o) {
    if (o.kkLocked) return 'Legal panel';
    if (o.type === 'image') return 'Image';
    if (o.type === 'i-text' || o.type === 'textbox') {
      var t = (o.text || '').replace(/\s+/g, ' ').trim();
      if (!t) return 'Text';
      return t.length > 24 ? t.slice(0, 24) + '…' : t;
    }
    if (o.type === 'circle') return 'Circle';
    if (o.type === 'triangle') return 'Triangle';
    if (o.type === 'rect') return 'Rectangle';
    return o.type;
  }

  /* Lista merge de sus în jos, ca în orice editor: primul rând e stratul
     de deasupra. Ghidajele nu apar — nu sunt ale clientului. */
  function renderLayers() {
    var host = el('[data-kk-layers]');
    if (!host || !canvas) return;

    var act = canvas.getActiveObject();
    var list = canvas.getObjects().filter(function (o) { return !o.kkGuide; });
    var rows = [];

    for (var i = list.length - 1; i >= 0; i--) {
      var o = list[i];
      var id = idOf(o);
      var locked = !!o.kkLocked;

      rows.push(
        '<li class="kk-layer' + (o === act ? ' is-on' : '') + (locked ? ' is-locked' : '') + '">' +
          '<button type="button" class="kk-layer-vis" data-kk-lvis="' + id + '" ' +
            'aria-label="Show or hide">' + (o.visible === false ? '◌' : '●') + '</button>' +
          '<button type="button" class="kk-layer-name" data-kk-lpick="' + id + '">' +
            layerName(o) + '</button>' +
          (locked
            ? '<span class="kk-layer-lock" title="Required by law — cannot be moved">&#128274;</span>'
            : '<button type="button" class="kk-layer-btn" data-kk-lup="' + id + '" aria-label="Move up">&#8593;</button>' +
              '<button type="button" class="kk-layer-btn" data-kk-ldown="' + id + '" aria-label="Move down">&#8595;</button>' +
              '<button type="button" class="kk-layer-btn kk-layer-del" data-kk-ldel="' + id + '" aria-label="Delete">&times;</button>'
          ) +
        '</li>'
      );
    }

    host.innerHTML = rows.join('') ||
      '<li class="kk-layer is-empty">Nothing on the label yet</li>';
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
      fontFamily: 'Inter', fill: '#111111'
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
    var x1 = z.back > 0 ? z.frontEnd : z.x + z.tw;
    return { x: (z.x + x1) / 2, y: z.y + z.th / 2, w: x1 - z.x, h: z.th };
  }

  function addText() {
    var f = frontCentre();
    var t = new fabric.IText('Your brand', {
      left: f.x,
      top: f.y,
      originX: 'center',
      originY: 'center',
      fontFamily: 'Montserrat',
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
    renderLayers();
    canvas.requestRenderAll();
    var bg = el('[data-kk-bg]');
    if (bg) bg.value = '#ffffff';
    syncPanel();
  }

  /* ---------- zoom ---------- */

  var zoom = 1;

  /* Fabric scalează conținutul; elementul canvas trebuie crescut separat,
     altfel etichetă mărită ar fi tăiată. Coordonatele obiectelor rămân
     neschimbate, deci zones() și agățarea nu se ating de zoom. */
  function applyZoom(z) {
    if (!canvas) return;
    zoom = Math.min(3, Math.max(0.3, z));
    var size = stageSize(conf);
    canvas.setZoom(zoom);
    canvas.setDimensions({ width: size.w * zoom, height: size.h * zoom });
    drawGuides();
    var v = el('[data-kk-zoom-val]');
    if (v) v.textContent = Math.round(zoom * 100) + '%';
  }

  /* ---------- export ---------- */

  /* Ce se vede pe etichetă, fără ghidaje, la dimensiuni reale în milimetri. */
  function toSvg() {
    var size = stageSize(conf);
    var W = conf.w + conf.bleed * 2;
    var H = conf.h + conf.bleed * 2;

    var svg = canvas.toSVG({
      width: W + 'mm',
      height: H + 'mm',
      viewBox: { x: 0, y: 0, width: size.w, height: size.h }
    });

    /* Fișierul are mărimea planșei, nu a etichetei. Fără o notă înăuntru,
       cine îl deschide nu are de unde ști unde se taie. */
    var note = 'Kosmetikal label. Artboard ' + W + ' x ' + H + ' mm' +
      (conf.bleed > 0 ? ', including ' + conf.bleed + ' mm bleed on every side' : '') +
      '. Trim to ' + conf.w + ' x ' + conf.h + ' mm. ' +
      'Keep essential content at least ' + SAFE_MM + ' mm inside the trim line.';

    var i = svg.indexOf('>', svg.indexOf('<svg'));
    if (i > 0) svg = svg.slice(0, i + 1) + '\n<desc>' + note + '</desc>' + svg.slice(i + 1);

    return svg;
  }

  function fileName() {
    return slug(conf.name) + '-label-' + conf.w + 'x' + conf.h + 'mm.svg';
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------- pachetul de export ----------

     „Use this design" și „Download" livrează un ZIP construit integral în browser:

       print.pdf     — vectorial, TOT textul convertit în contururi; pentru tipar
       print.svg     — aceeași grafică conturată, în formă SVG
       editable.svg  — masterul cu text viu + fonturile înglobate
       fonts/        — fișierele TTF folosite + licențele OFL (obligate să
                       călătorească împreună la redistribuire)
       README.txt    — dimensiuni, unde se taie, ce e fiecare fișier

     De ce două forme: editoarele desktop (Illustrator, Affinity) ignoră
     @font-face din SVG și substituie fontul după numele instalat — pentru tipar
     textul devine contururi, dar contururile nu se mai pot edita, deci masterul
     viu se livrează separat, cu fonturile alături.

     Bibliotecile (opentype.js, jsPDF, svg2pdf, JSZip) se încarcă abia la primul
     export. Dacă orice pas eșuează, se cade pe vechiul comportament — SVG-ul
     simplu — ca fluxul de comandă să nu se blocheze niciodată. */

  var libsPromise = null;

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('nu s-a încărcat: ' + url)); };
      document.head.appendChild(s);
    });
  }

  function ensureExportLibs() {
    if (libsPromise) return libsPromise;
    var L = conf.libs || {};
    libsPromise = Promise.all([
      window.opentype ? null : loadScript(L.opentype),
      window.JSZip ? null : loadScript(L.jszip),
      (window.jspdf && window.jspdf.jsPDF) ? null : loadScript(L.jspdf)
    ]).then(function () {
      /* svg2pdf se agață de jsPDF, deci strict după el */
      var api = window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API;
      return api && api.svg ? null : loadScript(L.svg2pdf);
    });
    libsPromise['catch'](function () { libsPromise = null; });   /* eșec → se poate reîncerca */
    return libsPromise;
  }

  /* fonturile ca date: arraybuffer pentru ZIP, obiect opentype pentru conturare */
  var fontCache = {};

  function fetchFontData(family) {
    if (fontCache[family]) return fontCache[family].promise;
    var url = (conf.fonts || {})[family];
    var entry = fontCache[family] = {};
    entry.promise = !url ? Promise.resolve(null) : fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('font ' + r.status); return r.arrayBuffer(); })
      .then(function (buf) {
        entry.buf = buf;
        entry.font = window.opentype.parse(buf);
        return entry;
      })['catch'](function () { fontCache[family] = null; return null; });
    return entry.promise;
  }

  function bufToB64(buf) {
    var u8 = new Uint8Array(buf), s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  var SVGNS = 'http://www.w3.org/2000/svg';

  function parseSvg(str) {
    var doc = new DOMParser().parseFromString(str, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('SVG invalid');
    return doc;
  }

  function serializeSvg(doc) {
    return new XMLSerializer().serializeToString(doc.documentElement);
  }

  function familyOf(textEl) {
    var f = textEl.getAttribute('font-family') || '';
    return f.replace(/["']/g, '').split(',')[0].trim();
  }

  function fillOf(textEl) {
    var st = textEl.getAttribute('style') || '';
    var m = st.match(/(?:^|;)\s*fill:\s*([^;]+)/);
    return m ? m[1].trim() : (textEl.getAttribute('fill') || '#000000');
  }

  function collectFamilies(doc) {
    var seen = {};
    Array.prototype.slice.call(doc.querySelectorAll('text')).forEach(function (t) {
      var f = familyOf(t);
      if (f && (conf.fonts || {})[f]) seen[f] = true;
    });
    return Object.keys(seen);
  }

  /* Fiecare <tspan> din exportul Fabric poartă deja poziția liniei de bază —
     toată așezarea (împărțirea pe rânduri, alinierea) e făcută. Noi doar
     înlocuim glifele cu contururile lor, la aceleași coordonate. */
  function outlineTextNodes(doc) {
    Array.prototype.slice.call(doc.querySelectorAll('text')).forEach(function (t) {
      var entry = fontCache[familyOf(t)];
      var font = entry && entry.font;
      if (!font) return;                       /* fără font → rămâne text viu */

      var size = parseFloat(t.getAttribute('font-size')) || 16;
      var g = doc.createElementNS(SVGNS, 'g');
      if (t.getAttribute('transform')) g.setAttribute('transform', t.getAttribute('transform'));
      g.setAttribute('fill', fillOf(t));

      var ok = true;
      Array.prototype.slice.call(t.querySelectorAll('tspan')).forEach(function (sp) {
        var txt = sp.textContent;
        if (!txt) return;
        try {
          var d = font.getPath(txt, parseFloat(sp.getAttribute('x')) || 0,
                                    parseFloat(sp.getAttribute('y')) || 0,
                                    size, { kerning: true }).toPathData(3);
          if (d) {
            var p = doc.createElementNS(SVGNS, 'path');
            p.setAttribute('d', d);
            g.appendChild(p);
          }
        } catch (e) { ok = false; }
      });

      if (ok && g.childNodes.length) t.parentNode.replaceChild(g, t);
    });
  }

  function embedFonts(doc, families) {
    var css = '';
    families.forEach(function (f) {
      var e = fontCache[f];
      if (!e || !e.buf) return;
      if (!e.b64) e.b64 = bufToB64(e.buf);
      css += "@font-face{font-family:'" + f + "';src:url(data:font/ttf;base64," + e.b64 + ") format('truetype');}\n";
    });
    if (!css) return;
    var st = doc.createElementNS(SVGNS, 'style');
    st.textContent = css;
    doc.documentElement.insertBefore(st, doc.documentElement.firstChild);
  }

  function svgToPdf(svgEl, Wmm, Hmm) {
    var jsPDF = window.jspdf.jsPDF;
    var pdf = new jsPDF({
      orientation: Wmm >= Hmm ? 'landscape' : 'portrait',
      unit: 'mm',
      format: [Wmm, Hmm]
    });
    /* svg2pdf citește stiluri calculate, deci elementul trebuie să fie în DOM */
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;';
    host.appendChild(svgEl);
    document.body.appendChild(host);
    function cleanup() { if (host.parentNode) document.body.removeChild(host); }
    return pdf.svg(svgEl, { x: 0, y: 0, width: Wmm, height: Hmm }).then(function () {
      cleanup();
      return pdf.output('blob');
    }, function (e) { cleanup(); throw e; });
  }

  function buildReadme(families) {
    var W = conf.w + conf.bleed * 2, H = conf.h + conf.bleed * 2;
    return [
      'KOSMETIKAL — label design pack',
      'Product: ' + conf.name,
      '',
      'Artboard: ' + W + ' x ' + H + ' mm' +
        (conf.bleed > 0 ? ' (includes ' + conf.bleed + ' mm bleed on every side)' : ''),
      'Trim — the finished label: ' + conf.w + ' x ' + conf.h + ' mm',
      'Keep essential content at least ' + SAFE_MM + ' mm inside the trim line.',
      '',
      'FILES',
      '  print.pdf    vector, all text converted to outlines. Send this to the printer.',
      '  print.svg    the same outlined artwork, in SVG form.',
      '  editable.svg the live-text master. Opens correctly in any browser;',
      '               desktop editors substitute fonts by installed name, so',
      '               install the fonts from the fonts/ folder before editing.',
      '  fonts/       the exact font files used' + (families.length ? ' (' + families.join(', ') + ')' : '') + ',',
      '               licensed under the SIL Open Font License - see LICENSES.txt.',
      '',
      'COLOUR',
      'Colours are RGB. Most digital label printers convert to CMYK on their side;',
      'for colour-critical brand colours, ask the printer for a proof first.',
      '',
      'Generated by Kosmetikal Label Studio.'
    ].join('\n');
  }

  function buildPack() {
    canvas.discardActiveObject();
    clearSnap();
    canvas.requestRenderAll();

    var Wmm = conf.w + conf.bleed * 2;
    var Hmm = conf.h + conf.bleed * 2;
    var svgString = toSvg();

    return ensureExportLibs().then(function () {
      var families = collectFamilies(parseSvg(svgString));
      return Promise.all(families.map(fetchFontData)).then(function () {

        var editableDoc = parseSvg(svgString);
        embedFonts(editableDoc, families);
        var editableSvg = serializeSvg(editableDoc);

        var printDoc = parseSvg(svgString);
        outlineTextNodes(printDoc);
        var printSvg = serializeSvg(printDoc);

        var printEl = parseSvg(printSvg).documentElement;
        return svgToPdf(printEl, Wmm, Hmm).then(function (pdfBlob) {
          var zip = new window.JSZip();
          zip.file('README.txt', buildReadme(families));
          zip.file('print.pdf', pdfBlob);
          zip.file('print.svg', printSvg);
          zip.file('editable.svg', editableSvg);

          var ff = zip.folder('fonts');
          families.forEach(function (f) {
            var e = fontCache[f];
            if (e && e.buf) ff.file(f.replace(/\s+/g, '') + '.ttf', e.buf);
          });

          return fetch(conf.fontlic)
            .then(function (r) { return r.ok ? r.text() : ''; })
            ['catch'](function () { return ''; })
            .then(function (lic) {
              if (lic) ff.file('LICENSES.txt', lic);
              return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
            });
        });
      });
    });
  }

  function packName() {
    return slug(conf.name) + '-label-pack-' + conf.w + 'x' + conf.h + 'mm.zip';
  }

  function fallbackFile() {
    return new File([toSvg()], fileName(), { type: 'image/svg+xml' });
  }

  function attachFile(file, noteText) {
    var input = el('[data-kk-file]');
    if (!input) return false;
    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
    } catch (e) { return false; }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    var note = el('[data-kk-studio-note]');
    if (note) { note.textContent = noteText; note.hidden = false; }
    return true;
  }

  function setBusy(on) {
    els('[data-kk-studio-done], [data-kk-studio-download]').forEach(function (b) {
      if (on) { b.kkLabel = b.textContent; b.textContent = 'Preparing files…'; b.disabled = true; }
      else { if (b.kkLabel) b.textContent = b.kkLabel; b.disabled = false; }
    });
  }

  var exporting = false;

  function exportAndAttach() {
    if (!canvas || exporting) return;
    exporting = true;
    setBusy(true);
    buildPack().then(function (blob) {
      var ok = attachFile(
        new File([blob], packName(), { type: 'application/zip' }),
        'Design pack attached — print-ready PDF, editable SVG and fonts (' + conf.w + ' × ' + conf.h + ' mm).'
      );
      if (!ok) throw new Error('attach');
      close(true);
    })['catch'](function () {
      /* orice eșec → SVG-ul simplu, ca până acum; comanda nu se blochează */
      if (attachFile(fallbackFile(),
        'Designed in the studio — vector file, ' + conf.w + ' × ' + conf.h + ' mm.')) {
        close(true);
      } else {
        alert('Could not attach the design automatically. Please use Download and upload the file.');
      }
    }).then(function () { exporting = false; setBusy(false); });
  }

  function exportAndSave() {
    if (!canvas || exporting) return;
    exporting = true;
    setBusy(true);
    buildPack().then(function (blob) {
      saveBlob(blob, packName());
    })['catch'](function () {
      saveBlob(new Blob([toSvg()], { type: 'image/svg+xml' }), fileName());
    }).then(function () { exporting = false; setBusy(false); });
  }

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
  /* ---------- deschidere / închidere ---------- */

  function open() {
    normalize();
    conf = readConf();
    if (!conf) return;

    withFabric(function () { withFonts(function () {
      build();
      if (!fontsSettled && fontsPromise) {
        fontsPromise.then(lateFontRefresh, lateFontRefresh);
      }
      conf.root.hidden = false;
      document.body.style.overflow = 'hidden';
      if (window.Shopify && Shopify.analytics && typeof Shopify.analytics.publish === 'function') {
        try { Shopify.analytics.publish('design_studio_opened', { product: conf.name }); } catch (e) {}
      }
    }); });
  }

  function hasWork() {
    if (!canvas) return false;
    return canvas.getObjects().some(function (o) { return !o.kkLocked && !o.kkGuide; });
  }

  /* `force` doar după ce designul a fost predat comenzii. Altfel întrebăm —
     închiderea pierde tot, iar un X arată nevinovat. */
  function close(force) {
    var s = studio();
    if (!s) return;
    if (!force && hasWork() &&
        !window.confirm('Close the studio? Your design is not attached to the order yet and will be lost.')) {
      return;
    }
    s.hidden = true;
    document.body.style.overflow = '';
  }

  /* ---------- legături ---------- */

  /* pe capture, ca să pornească indiferent ce fac ceilalți handleri cu evenimentul */
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-kk-design-toggle], [data-kk-studio-open]')) kickFonts();
  }, true);

  document.addEventListener('click', function (e) {
    var t = e.target;

    if (t.closest('[data-kk-studio-open]')) { e.preventDefault(); open(); return; }
    if (t.closest('[data-kk-studio-close]')) { close(); return; }
    if (t.closest('[data-kk-add-text]')) { addText(); return; }
    if (t.closest('[data-kk-del]')) { removeActive(); return; }
    if (t.closest('[data-kk-reset]')) { reset(); return; }

    var lay = t.closest('[data-kk-lpick],[data-kk-lvis],[data-kk-lup],[data-kk-ldown],[data-kk-ldel]');
    if (lay && canvas) {
      var d = lay.dataset;
      var o = byId(d.kkLpick || d.kkLvis || d.kkLup || d.kkLdown || d.kkLdel);
      if (!o) return;

      if (d.kkLpick && o.selectable) { canvas.setActiveObject(o); }
      else if (d.kkLvis) { o.set('visible', o.visible === false); }
      else if (d.kkLup) { canvas.bringForward(o); liftGuides(); }
      else if (d.kkLdown) { canvas.sendBackwards(o); liftGuides(); }
      else if (d.kkLdel && !o.kkLocked) { canvas.remove(o); canvas.discardActiveObject(); }

      canvas.requestRenderAll();
      renderLayers();
      syncPanel();
      return;
    }

    var chip = t.closest('[data-kk-field]');
    if (chip && canvas) { addField(chip.dataset.kkField); return; }

    var shape = t.closest('[data-kk-shape]');
    if (shape && canvas) { addShape(shape.dataset.kkShape); return; }

    if (t.closest('[data-kk-studio-done]')) { exportAndAttach(); return; }

    if (t.closest('[data-kk-studio-download]')) { exportAndSave(); return; }

    var zb = t.closest('[data-kk-zoom]');
    if (zb) {
      var k = zb.dataset.kkZoom;
      applyZoom(k === '+' ? zoom + 0.25 : k === '-' ? zoom - 0.25 : 1);
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
