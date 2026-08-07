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
      pack: s.dataset.kkPack || 'bottle',
      photo: s.dataset.kkPhoto || '',
      photodef: s.dataset.kkPhotodef || '',
      mockup: s.dataset.kkMockup || '',
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
      })['catch'](function (e) {
        /* vizibil în consolă — o degradare tăcută ne-a costat deja o rundă de diagnoză */
        if (window.console && console.warn) console.warn('[kk] font indisponibil pentru export:', family, e && e.message);
        fontCache[family] = null;
        return null;
      });
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

  /* ---------- mockup 3D ----------

     Flaconul construit din geometrie, după dimensiunile în milimetri ale
     etichetei: lățimea etichetei = circumferința, deci raza = lățime / 2π.
     Eticheta desenată e textură vie pe bandă — rotind flaconul se văd și fața,
     și panoul legal din spate, ceea ce nicio metodă pe poză nu poate.

     Flaconul e reprezentativ (un recipient generic cu proporțiile corecte),
     nu ambalajul exact al furnizorului — eticheta în schimb e exactă.
     three.js r147 (ultimul cu build clasic), încărcat abia la prima deschidere. */

  var m3 = { renderer: null, scene: null, camera: null, controls: null, band: null, raf: 0 };
  var libs3dP = null;

  function ensure3dLibs() {
    if (libs3dP) return libs3dP;
    var L = conf.libs || {};
    libs3dP = (window.THREE ? Promise.resolve() : loadScript(L.three)).then(function () {
      return Promise.all([
        window.THREE.OrbitControls ? null : loadScript(L.orbit),
        window.THREE.RoomEnvironment ? null : loadScript(L.roomenv)
      ]);
    });
    libs3dP['catch'](function () { libs3dP = null; });
    return libs3dP;
  }

  /* Toată eticheta tăiată — față + cotor + spate — pentru înfășurarea completă.
     Fără ghidaje și fără chenarul de selecție. */
  function captureLabel() {
    var z = zones();
    /* Bufferul lui Fabric e mai mare decât coordonatele logice cu zoom ×
       devicePixelRatio (retina). Raportul buffer/scenă le acoperă pe amândouă —
       cu k doar din zoom, la scalarea Windows de 125% captura pierdea 20% din
       lățimea etichetei și textul legal ieșea tăiat pe flacon. */
    var k = canvas.lowerCanvasEl.width / stageSize(conf).w;
    var vis = guideObjs.map(function (o) { return o.visible; });
    guideObjs.forEach(function (o) { o.set('visible', false); });
    canvas.discardActiveObject();
    clearSnap();
    canvas.renderAll();

    var w = Math.max(1, Math.round(z.tw));
    var h = Math.max(1, Math.round(z.th));
    var c = document.createElement('canvas');
    c.width = w * 2;
    c.height = h * 2;
    c.getContext('2d').drawImage(canvas.lowerCanvasEl,
      z.x * k, z.y * k, w * k, h * k, 0, 0, c.width, c.height);

    guideObjs.forEach(function (o, i) { o.set('visible', vis[i]); });
    canvas.renderAll();
    return c;
  }

  /* centrul feței, ca fracțiune din lățimea etichetei — cu el se rotește banda
     astfel încât fața să privească spre cameră la deschidere */
  function frontCenterU() {
    var z = zones();
    return ((z.frontEnd - z.x) / 2) / z.tw;
  }

  function mockSize() {
    var stage = el('.kk-mock-stage');
    if (!stage || !m3.renderer) return;
    var s = Math.max(320, Math.min(stage.clientWidth - 48, stage.clientHeight - 48, 780));
    m3.renderer.setSize(s, Math.round(s * 0.92));
    m3.camera.aspect = s / (s * 0.92);
    m3.camera.updateProjectionMatrix();
  }

  var MAT = {
    body: function (T) { return new T.MeshStandardMaterial({ color: 0xf5f4f0, roughness: 0.38, metalness: 0 }); },
    dark: function (T) { return new T.MeshStandardMaterial({ color: 0x1d1d1b, roughness: 0.3, metalness: 0 }); }
  };

  /* Suprafață cilindrică ce se turtește spre vârf — corpul unui tub.
     Parametrizarea (x = r·sinθ, z = r·cosθ) e aceeași ca la CylinderGeometry,
     deci u=0 privește camera și textul rămâne cu orientarea corectă.
     Cu withUv, aceeași suprafață devine banda de etichetă: urmează turtirea. */
  function tubeSurface(T, r, y0, y1, H, withUv) {
    var NU = 128, NV = 32;
    var pos = [], uv = [], idx = [];
    /* Turtirea începe abia în treimea de sus — pornită de la jumătate, tubul
       arăta a vază. sx crește blând (lățimea crimpului), sz cade aproape de
       zero (sudura e o linie). */
    function squish(t) {
      var f = Math.max(0, Math.min(1, (t - 0.62) / 0.38));
      f = f * f * (3 - 2 * f);
      return { sx: 1 + 0.42 * f, sz: 1 - 0.9 * f };
    }
    for (var j = 0; j <= NV; j++) {
      var v = j / NV;
      var y = y0 + (y1 - y0) * v;
      var s = squish(y / H);
      for (var i = 0; i <= NU; i++) {
        var th = i / NU * Math.PI * 2;
        pos.push(r * s.sx * Math.sin(th), y, r * s.sz * Math.cos(th));
        if (withUv) uv.push(i / NU, v);
      }
    }
    for (var jj = 0; jj < NV; jj++) {
      for (var ii = 0; ii < NU; ii++) {
        var a = jj * (NU + 1) + ii, b = a + 1, c = a + NU + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    if (withUv) g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /* Recipientul, pe tipuri. Raza vine mereu din lățimea etichetei
     (circumferința), deci proporțiile sunt cele reale ale produsului. */
  function buildContainer(T, type, r, h) {
    var parts = [], bandGeo = null, bandY = 0, topY = 0;

    if (type === 'tube') {
      /* stă pe capac, ca în pozele de produs; corpul se turtește spre sudură */
      var capH = r * 0.85, bodyH = h * 1.7;
      var cap = new T.Mesh(new T.CylinderGeometry(r * 0.98, r * 0.98, capH, 64), MAT.dark(T));
      cap.position.y = capH / 2;
      parts.push(cap);

      var body = new T.Mesh(tubeSurface(T, r, 0, bodyH, bodyH, false), MAT.body(T));
      body.material.side = T.DoubleSide;    /* geometria e proprie — nu riscăm sensul fețelor */
      body.position.y = capH;
      parts.push(body);

      /* eticheta pe zona de jos, care e încă rotundă; urmează profilul */
      var pad = Math.max(1.5, (bodyH * 0.62 - h) / 2);
      bandGeo = tubeSurface(T, r + 0.12, pad, pad + h, bodyH, true);
      bandY = capH;
      topY = capH + bodyH;

    } else if (type === 'jar') {
      var jarH = Math.max(h * 1.15, r * 1.1);
      var pts = [
        new T.Vector2(0.01, 0), new T.Vector2(r * 0.9, 0),
        new T.Vector2(r, r * 0.1), new T.Vector2(r, jarH)
      ];
      parts.push(new T.Mesh(new T.LatheGeometry(pts, 96), MAT.body(T)));
      var lid = new T.Mesh(new T.CylinderGeometry(r * 1.03, r * 1.03, r * 0.4, 96), MAT.dark(T));
      lid.position.y = jarH + r * 0.2;
      parts.push(lid);
      bandGeo = new T.CylinderGeometry(r + 0.12, r + 0.12, h, 128, 1, true);
      bandY = jarH * 0.5;      /* cilindrul e centrat pe propriul mijloc */
      topY = jarH + r * 0.4;

    } else if (type === 'dropper') {
      var dH = h * 1.35;
      var dpts = [
        new T.Vector2(0.01, 0), new T.Vector2(r * 0.88, 0),
        new T.Vector2(r, r * 0.14), new T.Vector2(r, dH),
        new T.Vector2(r * 0.6, dH + r * 0.25), new T.Vector2(r * 0.3, dH + r * 0.4)
      ];
      parts.push(new T.Mesh(new T.LatheGeometry(dpts, 96), MAT.body(T)));
      var dcap = new T.Mesh(new T.CylinderGeometry(r * 0.3, r * 0.34, r * 1.7, 48), MAT.dark(T));
      dcap.position.y = dH + r * 0.4 + r * 0.85;
      parts.push(dcap);
      var bulb = new T.Mesh(new T.SphereGeometry(r * 0.3, 32, 24), MAT.dark(T));
      bulb.scale.y = 1.25;
      bulb.position.y = dH + r * 0.4 + r * 1.7;
      parts.push(bulb);
      bandGeo = new T.CylinderGeometry(r + 0.12, r + 0.12, h, 128, 1, true);
      bandY = dH * 0.5;
      topY = dH + r * 2.1;

    } else {
      /* bottle — implicit */
      var bH = h * 1.5;
      var bpts = [
        new T.Vector2(0.01, 0), new T.Vector2(r * 0.88, 0),
        new T.Vector2(r, r * 0.14), new T.Vector2(r, bH),
        new T.Vector2(r * 0.8, bH + r * 0.3), new T.Vector2(r * 0.45, bH + r * 0.52),
        new T.Vector2(r * 0.45, bH + r * 0.58)
      ];
      parts.push(new T.Mesh(new T.LatheGeometry(bpts, 96), MAT.body(T)));
      var bcap = new T.Mesh(new T.CylinderGeometry(r * 0.47, r * 0.47, r * 0.8, 64), MAT.dark(T));
      bcap.position.y = bH + r * 0.58 + r * 0.4;
      parts.push(bcap);
      bandGeo = new T.CylinderGeometry(r + 0.12, r + 0.12, h, 128, 1, true);
      bandY = bH * 0.5;
      topY = bH + r * 1.4;
    }

    return { parts: parts, bandGeo: bandGeo, bandY: bandY, topY: topY };
  }

  function build3d() {
    var T = window.THREE;
    var cv = el('[data-kk-mock-canvas]');

    /* dimensiuni reale, în mm — scena lucrează direct în mm */
    var r = conf.w / (2 * Math.PI);
    var h = conf.h;
    var built = buildContainer(T, conf.pack || 'bottle', r, h);

    m3.renderer = new T.WebGLRenderer({ canvas: cv, antialias: true, alpha: false, preserveDrawingBuffer: true });
    m3.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    m3.renderer.outputEncoding = T.sRGBEncoding;
    m3.renderer.toneMapping = T.ACESFilmicToneMapping;

    m3.scene = new T.Scene();
    m3.scene.background = new T.Color(0xefede7);
    var pmrem = new T.PMREMGenerator(m3.renderer);
    m3.scene.environment = pmrem.fromScene(new T.RoomEnvironment(), 0.04).texture;

    var dist = Math.max(built.topY * 1.6, r * 7);
    m3.camera = new T.PerspectiveCamera(32, 1, 1, dist * 6);
    m3.camera.position.set(0, built.topY * 0.58, dist);

    m3.controls = new T.OrbitControls(m3.camera, cv);
    m3.controls.target.set(0, built.topY * 0.48, 0);
    m3.controls.enablePan = false;
    m3.controls.enableDamping = true;
    m3.controls.minDistance = dist * 0.45;
    m3.controls.maxDistance = dist * 2;

    var tex = new T.CanvasTexture(captureLabel());
    tex.encoding = T.sRGBEncoding;
    tex.anisotropy = m3.renderer.capabilities.getMaxAnisotropy();
    m3.band = new T.Mesh(built.bandGeo, new T.MeshStandardMaterial({
      map: tex, roughness: 0.5, metalness: 0, side: T.DoubleSide
    }));
    m3.band.position.y = built.bandY;
    m3.band.rotation.y = -frontCenterU() * Math.PI * 2;

    built.parts.forEach(function (p) { m3.scene.add(p); });
    m3.scene.add(m3.band);
    mockSize();
  }

  /* la fiecare deschidere, eticheta se recapturează — poate a fost editată */
  function refresh3dTexture() {
    if (!m3.band) return;
    var old = m3.band.material.map;
    var tex = new window.THREE.CanvasTexture(captureLabel());
    tex.encoding = window.THREE.sRGBEncoding;
    tex.anisotropy = m3.renderer.capabilities.getMaxAnisotropy();
    m3.band.material.map = tex;
    m3.band.material.needsUpdate = true;
    if (old) old.dispose();
  }

  function animate3d() {
    m3.raf = requestAnimationFrame(animate3d);
    if (mview !== 'threed') return;      /* în vederea foto nu ardem GPU degeaba */
    m3.controls.update();
    m3.renderer.render(m3.scene, m3.camera);
  }

  function openMock() {
    var m = el('[data-kk-mock]');
    if (!m) return;
    ensure3dLibs().then(function () {
      m.hidden = false;
      if (!m3.renderer) build3d(); else refresh3dTexture();
      mockSize();
      if (!m3.raf) animate3d();
      /* Fotografia vinde mai bine decât geometria — unde există scenă, ea e
         vederea implicită, ca la Selfnamed. 3D-ul rămâne un click distanță. */
      var pv = el('[data-kk-mview="photo"]');
      if (pv) pv.hidden = !photoAvailable();
      if (CAL_MODE || photoAvailable()) setMView('photo');
      else setMView('threed');
      if (window.Shopify && Shopify.analytics && typeof Shopify.analytics.publish === 'function') {
        try { Shopify.analytics.publish('design_mockup_previewed', { product: conf.name }); } catch (e) {}
      }
    })['catch'](function () {
      alert('The 3D preview could not be loaded.');
    });
  }

  function closeMock() {
    var m = el('[data-kk-mock]');
    if (m) m.hidden = true;
    if (m3.raf) { cancelAnimationFrame(m3.raf); m3.raf = 0; }
  }

  function mockBlob(cb) {
    if (mview === 'photo') {
      var pc = el('[data-kk-mock-photo]');
      if (pc) pc.toBlob(cb, 'image/png');
      return;
    }
    if (!m3.renderer) return;
    m3.renderer.render(m3.scene, m3.camera);
    m3.renderer.domElement.toBlob(cb, 'image/png');
  }

  window.addEventListener('resize', function () {
    var m = el('[data-kk-mock]');
    if (m && !m.hidden) mockSize();
  });

  /* ---------- vederea foto (compunere 2D) ----------

     Eticheta (doar fața) înfășurată pe o fotografie de studio a unui ambalaj
     neutru — drumul spre randările fotorealiste tip Selfnamed, 100% în browser.
     Fundalul implicit e poza cu tubul alb nebrandat din pachetul Kosmetikal;
     per produs se poate schimba prin JSON-ul din metacâmpul custom.mockup.

     Calibrarea (colțuri + slidere) apare doar cu ?kk-cal în adresă. */

  var mview = 'threed';
  var mface = 'front';
  var mock = { cfg: null, photoC: null, photoP: null, drag: -1, raf: 0 };
  var CAL_MODE = /[?&]kk-cal\b/.test(location.search);

  /* Scene pre-calibrate, ca la Selfnamed: clientul nu așază nimic, platforma
     vine cu poza și poziția gata măsurate. Cheia e tipul de ambalaj; tube și
     jar folosesc aceeași fotografie de studio (tubul alb + borcanele albe),
     cu patrulatere diferite. Metacâmpul custom.mockup suprascrie tot, iar
     ?kk-cal rămâne unealta noastră de reglaj fin, invizibilă clienților.

     Coordonatele sunt procente din poza de 1200×1800, măsurate pe imagine. */
  function SCENES() {
    var photo = conf.photodef || '';
    /* Scena descrie doar CONTURUL recipientului în poză (marginile siluetei,
       sus și jos, în procente) plus lumina. Cât de mare e eticheta pe el NU se
       stochează: se calculează din milimetrii reali — lățimea siluetei
       corespunde diametrului, de acolo iese px-per-mm, iar eticheta aterizează
       mereu la proporțiile ei adevărate, oricare ar fi produsul. */
    return {
      tube: {
        photo: photo,
        top: { y: 20.5, xL: 39.5, xR: 61.5 },
        bot: { y: 53,   xL: 41.5, xR: 58.5 },
        yC: 36,
        bulge: 1, shade: 36, shine: 12
      },
      jar: {
        photo: photo,
        top: { y: 63.5, xL: 66.5, xR: 85.5 },
        bot: { y: 78.5, xL: 66.5, xR: 85.5 },
        yC: 70.5,
        bulge: 2.5, shade: 34, shine: 8
      }
    };
  }

  /* Așezarea etichetei pe poză, din geometrie reală:
     silueta la înălțimea etichetei ↔ diametrul (2r), de unde px/mm;
     lățimea vizibilă a feței = sin(semi-arcul zonei), fiindcă pe un cilindru
     văzut frontal vezi cel mult jumătate de circumferință. */
  function computePlacement(cfg, W, H, face) {
    if (cfg.quad) {           /* metacâmpul poate fixa manual patrulaterul */
      return { quad: cfg.quad.map(function (p) { return [p[0] / 100 * W, p[1] / 100 * H]; }),
               wrap: cfg.wrap || 70 };
    }
    var z = zones();
    var zoneMm = (face === 'back' ? conf.back
                                  : conf.w - conf.back - conf.center) || conf.w;

    function edgeAt(yPct) {
      var t = (yPct - cfg.top.y) / (cfg.bot.y - cfg.top.y);
      return {
        xL: (cfg.top.xL + (cfg.bot.xL - cfg.top.xL) * t) / 100 * W,
        xR: (cfg.top.xR + (cfg.bot.xR - cfg.top.xR) * t) / 100 * W
      };
    }

    /* Conturul recipientului, găsit pe pixeli — verificat vizual în bancul de
       test local, nu ghicit. Două idei, amândouă câștigate din încercări eșuate:

       1. PRIMA muchie suficient de puternică dinspre centru spre exterior, nu
          pragul de luminozitate (lumina cade lin pe cilindru și pragul se oprea
          la banda strălucitoare din mijloc) și nici gradientul maxim global
          (sare pe cutele luminoase ale draperiei).
       2. Muchiile pe un singur rând mint lângă umăr — silueta pe zona etichetei
          e o pereche de DREPTE, deci: 9 rânduri, dreaptă prin mediana pantelor
          (Theil–Sen), aruncăm cele 3 puncte cu abaterea cea mai mare, repotrivim. */
    function refineEdge(approx, yPx) {
      var photo = mock.photoC;
      if (!photo) return approx;
      try {
        var y = Math.max(1, Math.min(photo.height - 2, Math.round(yPx)));
        var pad = Math.round(W * 0.015);
        var x0 = Math.max(0, Math.round(approx.xL) - pad);
        var x1 = Math.min(W, Math.round(approx.xR) + pad);
        var n = x1 - x0;
        var ctx = photo.getContext('2d');
        var rows = [ctx.getImageData(x0, y - 1, n, 1).data,
                    ctx.getImageData(x0, y, n, 1).data,
                    ctx.getImageData(x0, y + 1, n, 1).data];
        function lum(i) {
          var s = 0;
          for (var r = 0; r < 3; r++) s += 0.299 * rows[r][i * 4] + 0.587 * rows[r][i * 4 + 1] + 0.114 * rows[r][i * 4 + 2];
          return s / 3;
        }
        /* Dinspre EXTERIOR spre interior: prima urcare puternică de la fundalul
           întunecat la recipientul luminos = silueta. Dinspre centru, umbrele
           interne de lângă umăr opreau scanarea devreme (verificat în banc pe
           poza plafonată la 1600, unde înmuierea le făcea dominante). Rândurile
           unde nici asta nu găsește nimic întorc centrul — potrivirea robustă
           de mai jos le aruncă. */
        function firstRise(from, dir, lim) {
          var maxG = 0, i, g;
          for (i = from; dir > 0 ? i < lim : i > lim; i += dir) {
            g = dir > 0 ? lum(i + 1) - lum(i - 1) : lum(i - 1) - lum(i + 1);
            if (g > maxG) maxG = g;
          }
          var TH = Math.max(9, maxG * 0.5);
          for (i = from; dir > 0 ? i < lim : i > lim; i += dir) {
            g = dir > 0 ? lum(i + 1) - lum(i - 1) : lum(i - 1) - lum(i + 1);
            if (g >= TH) return i;
          }
          return lim;
        }
        var c = Math.round((approx.xL + approx.xR) / 2) - x0;
        return { xL: x0 + firstRise(2, 1, c), xR: x0 + firstRise(n - 3, -1, c) };
      } catch (e) { return approx; }
    }

    function fitSides(yTop, yBot) {
      var pts = [];
      for (var i = 0; i < 9; i++) {
        var y = yTop + (yBot - yTop) * i / 8;
        var e = refineEdge(edgeAt(y / H * 100), y);
        pts.push({ y: y, xL: e.xL, xR: e.xR });
      }
      function theilSen(get, set) {
        var slopes = [];
        for (var a = 0; a < set.length; a++)
          for (var b = a + 1; b < set.length; b++)
            slopes.push((get(set[b]) - get(set[a])) / (set[b].y - set[a].y));
        slopes.sort(function (p, q) { return p - q; });
        var m = slopes[Math.floor(slopes.length / 2)];
        var inters = set.map(function (p) { return get(p) - m * p.y; }).sort(function (p, q) { return p - q; });
        var cc = inters[Math.floor(inters.length / 2)];
        return function (y) { return m * y + cc; };
      }
      function robust(get) {
        var f = theilSen(get, pts);
        var keep = pts.map(function (p) { return { p: p, r: Math.abs(get(p) - f(p.y)) }; })
                      .sort(function (a, b) { return a.r - b.r; })
                      .slice(0, 6).map(function (x) { return x.p; });
        return theilSen(get, keep);
      }
      return { L: robust(function (p) { return p.xL; }), R: robust(function (p) { return p.xR; }) };
    }

    var yC = cfg.yC / 100 * H;
    var seed = refineEdge(edgeAt(cfg.yC), yC);
    var seedHalf = (seed.xR - seed.xL) * (conf.h * Math.PI / conf.w) / 2;
    var sides = fitSides(yC - seedHalf, yC + seedHalf);

    var faceW = sides.R(yC) - sides.L(yC);            /* ↔ 2r în px */
    var pxPerMm = faceW / (conf.w / Math.PI);         /* 2r = lățime/π */
    var labelH = conf.h * pxPerMm;

    /* Dacă produsul nu încape în recipientul din poză (proporții foarte
       diferite), preview-ul se scalează la limită în loc să explodeze. */
    var span = (cfg.bot.y - cfg.top.y) / 100 * H;
    if (labelH > span * 0.92) {
      var kk = span * 0.92 / labelH;
      pxPerMm *= kk;
      labelH *= kk;
    }

    var y0 = yC - labelH / 2, y1 = yC + labelH / 2;

    /* semi-arcul zonei de etichetă; peste 90° eticheta dă după siluetă */
    var halfArc = Math.min(85 * Math.PI / 180, zoneMm * Math.PI / conf.w);
    var frac = Math.sin(halfArc);

    var e0 = { xL: sides.L(y0), xR: sides.R(y0) };
    var e1 = { xL: sides.L(y1), xR: sides.R(y1) };
    function shrink(e) {
      var c = (e.xL + e.xR) / 2, half = (e.xR - e.xL) / 2 * frac;
      return { xL: c - half, xR: c + half };
    }
    e0 = shrink(e0); e1 = shrink(e1);

    return {
      quad: [[e0.xL, y0], [e0.xR, y0], [e1.xR, y1], [e1.xL, y1]],
      wrap: halfArc * 2 * 180 / Math.PI
    };
  }

  function mockCfg() {
    if (mock.cfg) return mock.cfg;
    var stored = null;
    if (conf.mockup) { try { stored = JSON.parse(conf.mockup); } catch (e) { stored = null; } }
    var scene = SCENES()[conf.pack] || null;
    if (!stored && !scene) return null;          /* fără scenă → vederea foto nu există */
    mock.cfg = Object.assign({}, scene || {}, stored || {});
    if (!mock.cfg.photo) return (mock.cfg = null);
    return mock.cfg;
  }

  function photoAvailable() { return !!mockCfg(); }

  function loadPhoto() {
    if (mock.photoC) return Promise.resolve(mock.photoC);
    if (mock.photoP) return mock.photoP;
    mock.photoP = new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';   /* altfel canvasul devine tainted și nu mai exportă */
      img.onload = function () {
        var k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k);
        c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        mock.photoC = c;
        resolve(c);
      };
      img.onerror = function () { reject(new Error('photo')); };
      img.src = mockCfg().photo;
    });
    return mock.photoP;
  }

  /* Pe poză se vede o singură parte a ambalajului: fața sau spatele.
     Front = zona de design; Back = panoul legal. */
  function captureZone(face) {
    var z = zones();
    var k = canvas.lowerCanvasEl.width / stageSize(conf).w;   /* zoom × retina */
    var x0 = face === 'back' ? z.centerEnd : z.x;
    var x1 = face === 'back' ? z.x + z.tw : z.frontEnd;

    var vis = guideObjs.map(function (o) { return o.visible; });
    guideObjs.forEach(function (o) { o.set('visible', false); });
    canvas.discardActiveObject();
    clearSnap();
    canvas.renderAll();

    var w = Math.max(1, Math.round(x1 - x0));
    var h = Math.max(1, Math.round(z.th));
    var c = document.createElement('canvas');
    c.width = w * 2;
    c.height = h * 2;
    c.getContext('2d').drawImage(canvas.lowerCanvasEl,
      x0 * k, z.y * k, w * k, h * k, 0, 0, c.width, c.height);

    guideObjs.forEach(function (o, i) { o.set('visible', vis[i]); });
    canvas.renderAll();
    return c;
  }

  /* Înfășurare pe coloane întregi de pixeli — capete fracționare lasă rosturi
     de transparență și eticheta iese vărgată. Compresie asin la margini
     (cilindru văzut frontal), bombare parabolică sus/jos. */
  function warpFront(cfg, W, H) {
    var label = captureZone(mface);
    var place = computePlacement(cfg, W, H, mface);
    var q = place.quad;
    var phiMax = Math.max(0, Math.min(85, place.wrap / 2)) * Math.PI / 180;
    var qh = (q[3][1] - q[0][1] + q[2][1] - q[1][1]) / 2;
    var bulgePx = cfg.bulge / 100 * qh;

    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var ctx = out.getContext('2d');

    function srcU(u) {
      if (phiMax < 0.02) return u;
      return 0.5 + Math.asin((2 * u - 1) * Math.sin(phiMax)) / (2 * phiMax);
    }

    var xL = (q[0][0] + q[3][0]) / 2;
    var xR = (q[1][0] + q[2][0]) / 2;
    if (xR - xL < 2) return out;

    var x0 = Math.max(0, Math.floor(xL));
    var x1 = Math.min(W, Math.ceil(xR));

    for (var x = x0; x < x1; x++) {
      var u = (x + 0.5 - xL) / (xR - xL);
      if (u < 0 || u > 1) continue;

      var b = bulgePx * (1 - Math.pow(2 * u - 1, 2));
      var yT = q[0][1] + (q[1][1] - q[0][1]) * u + b;
      var yB = q[3][1] + (q[2][1] - q[3][1]) * u + b;
      if (yB - yT < 1) continue;

      var s0 = srcU(Math.max(0, (x - xL) / (xR - xL))) * label.width;
      var s1 = srcU(Math.min(1, (x + 1 - xL) / (xR - xL))) * label.width;

      ctx.drawImage(label, s0, 0, Math.max(0.5, s1 - s0), label.height, x, yT, 1, yB - yT);
    }
    return out;
  }

  function renderPhoto() {
    var cfg = mockCfg();
    var photo = mock.photoC;
    var pc = el('[data-kk-mock-photo]');
    if (!cfg || !photo || !pc) return;

    var W = photo.width, H = photo.height;
    pc.width = W; pc.height = H;
    var ctx = pc.getContext('2d');
    ctx.drawImage(photo, 0, 0);

    var warped = warpFront(cfg, W, H);

    /* umbrele pozei (multiply) și luciul ei (screen), doar peste etichetă;
       destination-in taie înapoi pe conturul etichetei */
    var lit = document.createElement('canvas');
    lit.width = W; lit.height = H;
    var lc = lit.getContext('2d');
    lc.drawImage(warped, 0, 0);
    lc.globalCompositeOperation = 'multiply';
    lc.globalAlpha = cfg.shade / 100;
    lc.drawImage(photo, 0, 0);
    lc.globalCompositeOperation = 'screen';
    lc.globalAlpha = cfg.shine / 100;
    lc.drawImage(photo, 0, 0);
    lc.globalCompositeOperation = 'destination-in';
    lc.globalAlpha = 1;
    lc.drawImage(warped, 0, 0);

    ctx.drawImage(lit, 0, 0);
    syncCalUi();
  }

  function syncFaceUi() {
    var row = el('[data-kk-mface-row]');
    if (!row) return;
    row.hidden = mview !== 'photo';
    var hasBack = zones().back > 0;
    els('[data-kk-mface]').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.kkMface === mface);
      if (b.dataset.kkMface === 'back') b.hidden = !hasBack;
    });
  }

  function syncCalUi() {
    var cfg = mockCfg();
    if (!cfg) return;
    /* colțurile trăgabile există doar când patrulaterul e fixat manual (metacâmp);
       la scenele calculate din geometrie n-au obiect pe care să tragă */
    var showCal = CAL_MODE && mview === 'photo' && !!cfg.quad;
    els('[data-kk-mock-h]').forEach(function (h) {
      h.hidden = !showCal;
      if (!showCal) return;
      var p = cfg.quad[parseInt(h.dataset.kkMockH, 10)];
      h.style.left = p[0] + '%';
      h.style.top = p[1] + '%';
    });
    var cal = el('[data-kk-mock-cal]');
    if (cal) cal.hidden = !showCal;
    if (showCal) {
      els('[data-kk-mock-p]').forEach(function (r) { r.value = cfg[r.dataset.kkMockP]; });
      var ta = el('[data-kk-mock-json]');
      if (ta) ta.value = JSON.stringify(cfg);
    }
  }

  function schedulePhoto() {
    if (mock.raf) return;
    mock.raf = requestAnimationFrame(function () { mock.raf = 0; renderPhoto(); });
  }

  function setMView(v) {
    if (v === 'photo' && !photoAvailable()) v = 'threed';
    mview = v;
    var c3 = el('[data-kk-mock-canvas]');
    var cp = el('[data-kk-mock-photo]');
    if (c3) c3.hidden = v !== 'threed';
    if (cp) cp.hidden = v !== 'photo';
    els('[data-kk-mview]').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.kkMview === v);
    });
    var h3 = el('[data-kk-mock-hint-3d]'), hp = el('[data-kk-mock-hint-photo]');
    if (h3) h3.hidden = v !== 'threed';
    if (hp) hp.hidden = v !== 'photo';
    syncFaceUi();
    syncCalUi();

    if (v === 'photo') {
      loadPhoto().then(renderPhoto)['catch'](function () {
        alert('The studio photo could not be loaded.');
        setMView('threed');
      });
    }
  }

  function setMFace(f) {
    mface = f;
    syncFaceUi();
    schedulePhoto();
  }

  /* tragerea colțurilor, doar în calibrare */
  document.addEventListener('pointerdown', function (e) {
    var h = e.target.closest && e.target.closest('[data-kk-mock-h]');
    if (!h || !CAL_MODE) return;
    mock.drag = parseInt(h.dataset.kkMockH, 10);
    if (h.setPointerCapture) h.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  document.addEventListener('pointermove', function (e) {
    if (mock.drag < 0) return;
    var wrap = el('[data-kk-mock-wrap]');
    if (!wrap) return;
    var r = wrap.getBoundingClientRect();
    mockCfg().quad[mock.drag] = [
      Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100)),
      Math.max(0, Math.min(100, (e.clientY - r.top) / r.height * 100))
    ];
    schedulePhoto();
  });

  document.addEventListener('pointerup', function () { mock.drag = -1; });

  document.addEventListener('input', function (e) {
    if (e.target.matches && e.target.matches('[data-kk-mock-p]')) {
      mockCfg()[e.target.dataset.kkMockP] = parseFloat(e.target.value);
      schedulePhoto();
    }
  });


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
      /* 3D-ul nu depinde de poze sau calibrare — butonul e mereu disponibil */
      var mo = el('[data-kk-mock-open]');
      if (mo) mo.hidden = false;
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

    if (t.closest('[data-kk-mock-open]')) { openMock(); return; }
    if (t.closest('[data-kk-mock-close]')) { closeMock(); return; }

    var mv = t.closest('[data-kk-mview]');
    if (mv) { setMView(mv.dataset.kkMview); return; }

    var mf = t.closest('[data-kk-mface]');
    if (mf) { setMFace(mf.dataset.kkMface); return; }

    if (t.closest('[data-kk-mock-copy]')) {
      var ta = el('[data-kk-mock-json]');
      if (ta && navigator.clipboard) {
        navigator.clipboard.writeText(ta.value);
        t.closest('[data-kk-mock-copy]').textContent = 'Copied!';
      }
      return;
    }

    if (t.closest('[data-kk-mock-dl]')) {
      mockBlob(function (blob) {
        if (blob) saveBlob(blob, slug(conf.name) + '-mockup.png');
      });
      return;
    }

    if (t.closest('[data-kk-mock-attach]')) {
      mockBlob(function (blob) {
        if (!blob) return;
        var input = el('[data-kk-mockfile]');
        var note = el('[data-kk-mock-note]');
        if (!input) return;
        try {
          var dt = new DataTransfer();
          dt.items.add(new File([blob], slug(conf.name) + '-mockup.png', { type: 'image/png' }));
          input.files = dt.files;
          if (note) { note.textContent = 'Mockup attached — it travels with the order.'; note.hidden = false; }
        } catch (e) {
          if (note) { note.textContent = 'Could not attach — use Download instead.'; note.hidden = false; }
        }
      });
      return;
    }


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
    if (e.key === 'Escape') {
      var mv = el('[data-kk-mock]');
      if (mv && !mv.hidden) { closeMock(); return; }   /* întâi mockup-ul, apoi studioul */
      close();
    }
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
