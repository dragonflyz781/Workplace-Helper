(function(){
  "use strict";

  /* ---------------- On-screen error diagnostics ---------------- */
  /* If anything throws, show it instead of failing silently — makes a
     broken load debuggable without needing dev tools. */
  var errBanner = null;
  function showError(msg){
    if(!errBanner){
      errBanner = document.createElement('div');
      errBanner.style.cssText = 'position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));z-index:9999;background:#b3391f;color:#fff;padding:10px 14px;border-radius:10px;font:13px -apple-system,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35);';
      document.body.appendChild(errBanner);
    }
    errBanner.textContent = msg;
    errBanner.style.display = 'block';
  }
  window.addEventListener('error', function(e){ showError('App error: '+(e.message||'unknown')); });
  window.addEventListener('unhandledrejection', function(e){
    var m = (e.reason && (e.reason.message||e.reason.code)) || String(e.reason);
    showError('App error: '+m);
  });

  /* Routes now come from Firestore (see js/main.js) via RoundTracker.setRoutes(). */

  /* ---------------- Theme ---------------- */
  var themeBtn = document.getElementById('themeBtn');
  function applyTheme(t){
    if(t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  var savedTheme = null;
  try{ savedTheme = localStorage.getItem('rt_theme'); }catch(e){}
  applyTheme(savedTheme);
  themeBtn.addEventListener('click', function(){
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : (cur === 'light' ? null : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark'));
    applyTheme(next);
    try{ localStorage.setItem('rt_theme', next || ''); }catch(e){}
  });

  /* ---------------- Map setup ---------------- */
  // Real street tiles load fine when this page is hosted normally (e.g.
  // GitHub Pages). Inside Claude's published-artifact sandbox, external
  // image loads are blocked, so we detect that and fall back gracefully
  // to a plain grid + "Open in Maps" links — no separate build needed.
  // Zoom control is a custom fixed +/- button pair (added further down)
  // instead of Leaflet's own, to match the app's styling.
  // rotate:true (from the leaflet-rotate plugin) turns on real heading-up
  // rotation, handled correctly inside Leaflet itself — it works out how
  // many tiles are needed to cover a rotated view and keeps dragging/zoom
  // working throughout, rather than the manual CSS-transform + overscan
  // approach this app used before (which is what caused all the clipping
  // and mis-sizing bugs). Markers default to staying upright regardless of
  // map rotation (rotateWithView:false), which is exactly what's wanted
  // for the live GPS dot.
  var map = L.map('map', {
    zoomControl:false, attributionControl:false,
    rotate:true, rotateControl:false, touchRotate:false, shiftKeyRotate:false
  }).setView([51.5, -0.12], 6);
  map.on('rotate', function(){
    var tick = document.getElementById('compassTick');
    if(tick) tick.style.transform = 'rotate('+map.getBearing()+'deg)';
  });

  var tilesConfirmed = false;
  var tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
    crossOrigin: true
  }).addTo(map);

  function markTilesWorking(){
    if(tilesConfirmed) return;
    tilesConfirmed = true;
    document.getElementById('map').classList.add('tiles-ok');
    var b = document.querySelector('.notile-banner');
    if(b) b.remove();
  }
  tileLayer.on('tileload', markTilesWorking);
  tileLayer.on('load', markTilesWorking);

  function showNoTilesBanner(){
    if(tilesConfirmed) return;
    try{ if(localStorage.getItem('rt_notile_seen')) return; }catch(e){}
    var banner = document.createElement('div');
    banner.className = 'notile-banner';
    banner.innerHTML = 'No street map imagery here (platform restriction) — route &amp; GPS position are accurate. Tap a marker for a link to open it in Maps.<button aria-label="Dismiss">&times;</button>';
    document.querySelector('.map-wrap').appendChild(banner);
    banner.querySelector('button').addEventListener('click', function(){
      banner.remove();
      try{ localStorage.setItem('rt_notile_seen','1'); }catch(e){}
    });
  }
  // Give tiles a few seconds to prove themselves before assuming they're blocked.
  setTimeout(function(){ if(!tilesConfirmed) showNoTilesBanner(); }, 3500);
  setTimeout(function(){ map.invalidateSize(); }, 150);

  function mapsLink(lat, lng){
    return 'https://www.google.com/maps/search/?api=1&query='+lat+','+lng;
  }

  var trackLine = null;
  var stopsGroup = L.layerGroup().addTo(map);
  var liveMarker = null;
  var watchId = null;
  var tracking = false;
  var lastFix = null;
  var followMe = true;

  function stopIcon(n){
    return L.divIcon({ className:'', html:'<div class="stop-marker"><span>'+n+'</span></div>', iconSize:[24,24], iconAnchor:[12,12] });
  }
  // Markers default to staying upright regardless of map rotation
  // (rotateWithView:false, from the plugin), so this wedge always points
  // toward the top of the screen — which, since the map rotates to face
  // your direction of travel, means it's naturally always pointing "ahead".
  var LIVE_ICON = L.divIcon({
    className:'live-marker-icon',
    html:'<div class="live-dot-wrap"><div class="heading-wedge"></div><div class="live-dot"></div></div>',
    iconSize:[26,26], iconAnchor:[13,13]
  });
  function liveIcon(){ return LIVE_ICON; }

  /* ---------------- Geometry helpers ---------------- */
  function toRad(d){ return d*Math.PI/180; }

  function haversineMeters(a,b){
    var R=6371000, dLat=toRad(b[0]-a[0]), dLon=toRad(b[1]-a[1]);
    var s = Math.sin(dLat/2)**2 + Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.min(1,Math.sqrt(s)));
  }
  // local flat-earth projection around a reference lat, for cheap point-to-segment math
  function project(pt, ref){
    var mPerDegLat = 111320;
    var mPerDegLon = 111320*Math.cos(toRad(ref[0]));
    return [ (pt[0]-ref[0])*mPerDegLat, (pt[1]-ref[1])*mPerDegLon ];
  }
  function distToSegment(p, a, b){
    var dx=b[0]-a[0], dy=b[1]-a[1];
    var len2 = dx*dx+dy*dy;
    if(len2===0) return Math.hypot(p[0]-a[0], p[1]-a[1]);
    var t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy)/len2;
    t = Math.max(0, Math.min(1, t));
    var cx = a[0]+t*dx, cy = a[1]+t*dy;
    return Math.hypot(p[0]-cx, p[1]-cy);
  }
  function distanceToTrack(latlng, track){
    if(!track || track.length===0) return null;
    var ref = latlng;
    var p = [0,0];
    var best = Infinity;
    if(track.length===1){
      return haversineMeters(latlng, track[0]);
    }
    for(var i=0;i<track.length-1;i++){
      var a = project(track[i], ref);
      var b = project(track[i+1], ref);
      var d = distToSegment(p, a, b);
      if(d<best) best=d;
    }
    return best;
  }
  function nearestStop(latlng, stops){
    if(!stops || stops.length===0) return null;
    var bestI=-1, bestD=Infinity;
    for(var i=0;i<stops.length;i++){
      var d = haversineMeters(latlng, stops[i]);
      if(d<bestD){ bestD=d; bestI=i; }
    }
    return { index:bestI, dist:bestD };
  }
  function fmtDist(m){
    if(m==null) return {v:'–', u:''};
    if(m < 1000) return { v: Math.round(m), u:' m' };
    return { v: (m/1000).toFixed(1), u:' km' };
  }

  // ----- Turn-by-turn (computed purely from the GPX track's own geometry —
  // no routing/geocoding service involved, so this works with no network) -----
  function bearing(a,b){
    var lat1=toRad(a[0]), lat2=toRad(b[0]), dLon=toRad(b[1]-a[1]);
    var y=Math.sin(dLon)*Math.cos(lat2);
    var x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
    return (Math.atan2(y,x)*180/Math.PI+360)%360;
  }
  function angleDiff(a,b){ return ((b-a+540)%360)-180; }
  function findNearestTrackIndex(latlng, track){
    if(!track||track.length===0) return -1;
    var bestI=0, bestD=Infinity;
    for(var i=0;i<track.length;i++){
      var d=haversineMeters(latlng, track[i]);
      if(d<bestD){ bestD=d; bestI=i; }
    }
    return bestI;
  }
  // Direction of travel taken from the road itself rather than raw GPS
  // movement — the route's own shape doesn't jitter the way consecutive
  // GPS fixes do, so this gives a much steadier rotation whenever you're
  // actually on (or close to) the loaded route. Returns null when too far
  // from the track to trust its direction, so callers can fall back to
  // device/movement-based heading instead.
  function roadHeadingNear(latlng, track){
    if(!track || track.length<2) return null;
    var idx = findNearestTrackIndex(latlng, track);
    if(idx<0 || haversineMeters(latlng, track[idx]) > 65) return null;
    var startIdx = Math.max(0, idx-1);
    var endIdx = Math.min(track.length-1, idx+3);
    if(startIdx===endIdx) return null;
    return bearing(track[startIdx], track[endIdx]);
  }
  function computeTurns(track){
    if(!track || track.length<3) return [];
    var STEP=35; // metres between samples — smooths out raw GPS jitter
    var pts=[track[0]], acc=0;
    for(var i=1;i<track.length;i++){
      acc += haversineMeters(track[i-1], track[i]);
      if(acc>=STEP){ pts.push(track[i]); acc=0; }
    }
    if(pts[pts.length-1]!==track[track.length-1]) pts.push(track[track.length-1]);
    if(pts.length<3) return [];
    var turns=[];
    for(var j=1;j<pts.length-1;j++){
      var diff = angleDiff(bearing(pts[j-1],pts[j]), bearing(pts[j],pts[j+1]));
      if(Math.abs(diff)>=28) turns.push({ latlng:pts[j], dir: diff>0?'right':'left', angle:Math.abs(diff) });
    }
    var merged=[];
    turns.forEach(function(t){
      var last=merged[merged.length-1];
      if(last && haversineMeters(last.latlng,t.latlng)<70){ if(t.angle>last.angle) merged[merged.length-1]=t; }
      else merged.push(t);
    });
    merged.forEach(function(t){ t.trackIdx = findNearestTrackIndex(t.latlng, track); });
    return merged;
  }
  function getRouteNav(r){
    if(!r) return null;
    if(!r._navReady){
      r._turns = computeTurns(r.track||[]);
      r._stopTrackIdx = (r.stops||[]).map(function(s){ return findNearestTrackIndex(s, r.track||[]); });
      var cum=[0];
      for(var i=1;i<(r.track||[]).length;i++) cum.push(cum[i-1]+haversineMeters(r.track[i-1], r.track[i]));
      r._cum = cum;
      r._navReady = true;
    }
    return r;
  }

  /* ---------------- Route store (fed by RoundTracker.setRoutes) ---------------- */
  var routes = {};      // id -> {id,name,addedAt,track,stops}
  var activeId = null;

  /* ---------------- Passenger counter (per route, this device) ---------------- */
  function newPax(){
    return { byStop:{}, byGpsStop:{}, adhoc:0, stopsOn:{}, stopsOff:{}, adhocOn:0, adhocOff:0, startedAt:null };
  }
  var pax = newPax();
  // byStop: schedule-row key ("MORNING-0"...) -> net count, set from the Schedule tab's own +/- controls.
  // byGpsStop: r.stops index -> net count, set from the Board/Alight buttons WHILE the live GPS position is at that stop.
  // adhoc: Board/Alight taps made when GPS isn't near any numbered stop (e.g. an unscheduled pickup).
  // stopsOn / stopsOff: r.stops index -> number of Board / Alight taps at that stop (what a submitted run reports).
  // adhocOn / adhocOff: Board / Alight taps made away from every stop ("unscheduled").
  // startedAt: ms timestamp of the first tap / GPS start of the current run (null = run not started).
  var currentGpsStopIdx = null;
  var AT_STOP_RADIUS_M = 50;   // Board/Alight within this many metres of a stop is logged against that stop
  function paxKey(routeId){ return 'rt_pax_'+routeId; }
  function loadPax(routeId){
    var out = newPax();
    try{
      var raw = localStorage.getItem(paxKey(routeId));
      if(raw){
        var parsed = JSON.parse(raw);
        if(parsed && typeof parsed==='object'){
          out.byStop = parsed.byStop||{};
          out.byGpsStop = parsed.byGpsStop||{};
          out.adhoc = parsed.adhoc||0;
          out.stopsOn = parsed.stopsOn||{};
          out.stopsOff = parsed.stopsOff||{};
          out.adhocOn = parsed.adhocOn||0;
          out.adhocOff = parsed.adhocOff||0;
          out.startedAt = parsed.startedAt||null;
        }
      }
    }catch(e){}
    return out;
  }
  function savePax(routeId){
    try{ localStorage.setItem(paxKey(routeId), JSON.stringify(pax)); }catch(e){}
  }
  function ensureRunStarted(){
    if(activeId && !pax.startedAt){ pax.startedAt = Date.now(); savePax(activeId); }
  }
  function paxTotal(){
    var t = pax.adhoc;
    Object.keys(pax.byStop).forEach(function(k){ t += pax.byStop[k]; });
    Object.keys(pax.byGpsStop).forEach(function(k){ t += pax.byGpsStop[k]; });
    return Math.max(0, t);
  }
  function renderPax(){
    var total = paxTotal();
    var elMap = document.getElementById('paxCountMap');
    if(elMap) elMap.textContent = total;
    var elFs = document.getElementById('fsPaxCount');
    if(elFs) elFs.textContent = total;
    document.querySelectorAll('.sched-pax .n').forEach(function(el){
      el.textContent = pax.byStop[el.getAttribute('data-stop-idx')] || 0;
    });
    renderPaxContext();
  }
  // Shows which stop Board/Alight will be logged against right now, next to
  // the quick-tap buttons (main panel + full-screen), so it's never a guess.
  function renderPaxContext(){
    var text = (currentGpsStopIdx!=null)
      ? 'At Stop '+(currentGpsStopIdx+1)+' — taps log to this stop'
      : (tracking ? 'Between stops — taps log as unscheduled' : 'Start GPS tracking to log by stop');
    ['paxContext','fsPaxContext'].forEach(function(id){
      var el = document.getElementById(id);
      if(el) el.textContent = text;
    });
  }
  function paxAdjust(delta){
    ensureRunStarted();
    var counter = delta>0 ? 'stopsOn' : 'stopsOff';
    if(currentGpsStopIdx!=null){
      var cur = pax.byGpsStop[currentGpsStopIdx] || 0;
      pax.byGpsStop[currentGpsStopIdx] = cur + delta;
      pax[counter][currentGpsStopIdx] = (pax[counter][currentGpsStopIdx]||0) + 1;
    } else {
      pax.adhoc += delta;
      if(delta>0) pax.adhocOn += 1; else pax.adhocOff += 1;
    }
    if(activeId) savePax(activeId);
    renderPax();
  }
  function paxAdjustStop(stopIdx, delta){
    var cur = pax.byStop[stopIdx] || 0;
    pax.byStop[stopIdx] = cur + delta;
    if(activeId) savePax(activeId);
    renderPax();
  }
  function paxReset(){
    if(!confirm('Reset the onboard passenger count for this route?')) return;
    pax = newPax();
    if(activeId) savePax(activeId);
    renderPax();
  }
  document.querySelectorAll('[data-pax]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var action = btn.dataset.pax;
      if(action==='on') paxAdjust(1);
      else if(action==='off') paxAdjust(-1);
      else if(action==='reset') paxReset();
    });
  });
  document.getElementById('fsPaxOn').addEventListener('click', function(){ paxAdjust(1); });
  document.getElementById('fsPaxOff').addEventListener('click', function(){ paxAdjust(-1); });

  function renderEmptyState(){
    document.getElementById('emptyState').style.display = Object.keys(routes).length ? 'none' : 'flex';
  }

  /* ---------------- Route category tabs ---------------- */
  function hasMorning(r){
    return !!((r.timetable && r.timetable.morning && r.timetable.morning.length) || r.session==='AM' || r.session==='both');
  }
  function hasAfternoon(r){
    return !!((r.timetable && r.timetable.afternoon && r.timetable.afternoon.length) || r.session==='PM' || r.session==='both');
  }
  var RT_TABS = [
    { key:'schools-am',  label:'Schools AM',  match:function(r){ return r.category==='school'  && hasMorning(r); } },
    { key:'schools-pm',  label:'Schools PM',  match:function(r){ return r.category==='school'  && hasAfternoon(r); } },
    { key:'colleges-am', label:'Colleges AM', match:function(r){ return r.category==='college' && hasMorning(r); } },
    { key:'colleges-pm', label:'Colleges PM', match:function(r){ return r.category==='college' && hasAfternoon(r); } },
    { key:'other', label:'Other', match:function(r){
        return !RT_TABS.slice(0,4).some(function(t){ return t.match(r); });
      } }
  ];
  var drawerTab = 'schools-am';
  try{ drawerTab = localStorage.getItem('rt_drawer_tab') || 'schools-am'; }catch(e){}

  function renderRouteTabs(){
    var wrap = document.getElementById('rtTabs');
    wrap.innerHTML = '';
    RT_TABS.forEach(function(t){
      var n = Object.keys(routes).filter(function(id){ return t.match(routes[id]); }).length;
      var btn = document.createElement('button');
      btn.className = 'rt-tab' + (t.key===drawerTab ? ' active' : '');
      btn.innerHTML = t.label + (n ? ' <span class="count">'+n+'</span>' : '');
      btn.addEventListener('click', function(){
        drawerTab = t.key;
        try{ localStorage.setItem('rt_drawer_tab', t.key); }catch(e){}
        renderRouteList();
      });
      wrap.appendChild(btn);
    });
  }

  function renderRouteList(){
    renderRouteTabs();
    var list = document.getElementById('routeList');
    var activeTab = RT_TABS.filter(function(t){ return t.key===drawerTab; })[0] || RT_TABS[0];
    var ids = Object.keys(routes)
      .filter(function(id){ return activeTab.match(routes[id]); })
      .sort(function(a,b){ return (routes[b].addedAt||'').localeCompare(routes[a].addedAt||''); });
    if(ids.length===0){
      list.innerHTML = '<div class="drawer-empty">No routes in "'+activeTab.label+'" yet.'+
        (Object.keys(routes).length ? ' Try another tab.' : ' Your administrator has not added any routes yet.')+'</div>';
      return;
    }
    list.innerHTML = '';
    ids.forEach(function(id){
      var r = routes[id];
      var card = document.createElement('div');
      card.className = 'route-card' + (id===activeId ? ' active' : '');
      var initials = (r.name||'?').replace(/[^A-Za-z0-9]/g,'').slice(0,3).toUpperCase() || '?';
      var dateStr = '';
      try{ dateStr = r.addedAt ? new Date(r.addedAt).toLocaleDateString(undefined,{day:'numeric',month:'short'}) : ''; }catch(e){}
      card.innerHTML =
        '<div class="route-badge">'+initials+'</div>'+
        '<div class="route-meta"><div class="name"></div><div class="sub"></div></div>'+
        '<div class="route-actions">'+
          '<button class="chip-btn use">'+(id===activeId?'Viewing':'View')+'</button>'+
        '</div>';
      card.querySelector('.name').textContent = r.name || 'Untitled route';
      card.querySelector('.sub').textContent = (r.stops?r.stops.length:0)+' stops · '+(r.track?r.track.length:0)+' pts'+(dateStr?' · '+dateStr:'');
      card.querySelector('.use').addEventListener('click', function(){ setActiveRoute(id); closeDrawer(); });
      list.appendChild(card);
    });
  }

  function setActiveRoute(id){
    var r = routes[id];
    if(!r) return;
    activeId = id;
    getRouteNav(r);
    if(typeof clearGuide==='function' && guiding) clearGuide();
    try{ localStorage.setItem('rt_active', id); }catch(e){}
    document.getElementById('routeName').textContent = r.name || 'Round Tracker';
    document.getElementById('routeSub').textContent = (r.stops?r.stops.length:0)+' stops · '+(r.track?r.track.length:0)+' track points';

    if(trackLine) map.removeLayer(trackLine);
    stopsGroup.clearLayers();

    if(r.track && r.track.length>1){
      trackLine = L.polyline(r.track, { color: getCss('--route'), weight:4, opacity:.9, lineJoin:'round' }).addTo(map);
    } else {
      trackLine = null;
    }
    (r.stops||[]).forEach(function(pt, i){
      var sname = (r.stopNames && r.stopNames[i]) ? ' \u2014 '+escapeHtml(r.stopNames[i]) : '';
      L.marker(pt, { icon: stopIcon(i+1) }).addTo(stopsGroup)
        .bindPopup('Stop '+(i+1)+sname+'<br><a class="maps-link" target="_blank" rel="noopener" href="'+mapsLink(pt[0],pt[1])+'">Open in Maps ↗</a>');
    });

    var bounds = null;
    if(r.track && r.track.length) bounds = L.latLngBounds(r.track);
    else if(r.stops && r.stops.length) bounds = L.latLngBounds(r.stops);
    // (skip while the driver view is hidden - the map has no size yet; show() fits it later)
    if(bounds && map.getSize().x > 0) map.fitBounds(bounds, { padding:[36,36] });

    renderRouteList();
    renderEmptyState();
    pax = loadPax(id);
    currentGpsStopIdx = null;
    renderPax();
    renderSchedule();
    renderRunUi();
    updateNextStop();
  }

  function getCss(varName){
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  /* ---------------- Tabs & live schedule ---------------- */
  var tabMapBtn = document.getElementById('tabMapBtn'), tabSchedBtn = document.getElementById('tabSchedBtn');
  var mapView = document.getElementById('mapView'), scheduleView = document.getElementById('scheduleView');
  function showTab(name){
    if(name==='schedule'){
      mapView.style.display = 'none'; scheduleView.style.display = 'flex';
      tabSchedBtn.classList.add('active'); tabMapBtn.classList.remove('active');
      renderSchedule();
    } else {
      scheduleView.style.display = 'none'; mapView.style.display = 'flex';
      tabMapBtn.classList.add('active'); tabSchedBtn.classList.remove('active');
      setTimeout(function(){ map.invalidateSize(); }, 0);
    }
  }
  tabMapBtn.addEventListener('click', function(){ showTab('map'); });
  tabSchedBtn.addEventListener('click', function(){ showTab('schedule'); });
  // Start on the Map tab (on narrow screens both panes were otherwise shown, with the map squashed to 0 height).
  showTab('map');

  function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  // Parse "HH:MM" against today's date (local time)
  function timeToday(hhmm){
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm||'').trim());
    if(!m) return null;
    var d = new Date();
    d.setHours(parseInt(m[1],10), parseInt(m[2],10), 0, 0);
    return d;
  }
  function fmtMinutes(ms){
    var mins = Math.round(Math.abs(ms)/60000);
    if(mins < 1) return 'under a minute';
    if(mins === 1) return '1 min';
    if(mins < 60) return mins+' min';
    var h = Math.floor(mins/60), m = mins%60;
    return h+'h'+(m?' '+m+'m':'');
  }

  function renderSchedule(){
    var r = activeId ? routes[activeId] : null;
    var body = document.getElementById('schedBody');
    if(!r){
      body.innerHTML = '<div class="sched-empty">No route selected. Open ☰ to pick a route.</div>';
      return;
    }
    var tt = r.timetable || {};
    var sections = [];
    if(tt.morning && tt.morning.length) sections.push({ label:'MORNING', rows:tt.morning, note:tt.morningNote });
    if(tt.afternoon && tt.afternoon.length) sections.push({ label:'AFTERNOON', rows:tt.afternoon, note:tt.afternoonNote });

    var html = '';
    var now = new Date();

    if(sections.length===0){
      html += '<div class="sched-empty">No drop times saved for this route yet.</div>';
    }

    sections.forEach(function(sec){
      // build parsed times, find "now" index
      var times = sec.rows.map(function(row){ return timeToday(row.time); });
      var nowIdx = -1;
      for(var i=0;i<times.length;i++){
        if(times[i] && times[i].getTime() <= now.getTime()) nowIdx = i;
      }
      var tripDone = (times[times.length-1] && now.getTime() > times[times.length-1].getTime() + 10*60000);

      if(sections.length>1 || true){
        html += '<div class="sched-section"><h3>'+sec.label+'</h3>';
      }
      sec.rows.forEach(function(row, i){
        var cls = 'sched-row';
        var status = '';
        if(tripDone){
          cls += ' past'; status = 'Done';
        } else if(i < nowIdx){
          cls += ' past'; status = 'Passed';
        } else if(i === nowIdx){
          cls += ' now'; status = 'Due now';
        } else if(nowIdx===-1 && i===0){
          var t = times[0];
          status = t ? 'Starts in '+fmtMinutes(t.getTime()-now.getTime()) : 'Upcoming';
        } else {
          var t2 = times[i];
          status = t2 ? 'In '+fmtMinutes(t2.getTime()-now.getTime()) : 'Upcoming';
        }
        var stopKey = sec.label+'-'+i;
        html += '<div class="'+cls+'"><div class="sched-dot"></div><div class="sched-info">'+
          '<div class="sched-stop">'+escapeHtml(row.stop)+'</div>'+
          '<div class="sched-status">'+escapeHtml(status)+'</div>'+
          '<div class="sched-pax">'+
            '<span class="sched-pax-label">Onboard change:</span>'+
            '<button class="sched-pax-btn off" data-stopkey="'+stopKey+'" data-dir="-1" aria-label="Passenger got off">−</button>'+
            '<span class="n" data-stop-idx="'+stopKey+'">0</span>'+
            '<button class="sched-pax-btn on" data-stopkey="'+stopKey+'" data-dir="1" aria-label="Passenger got on">+</button>'+
          '</div>'+
          '</div><div class="sched-time">'+escapeHtml(row.time)+'</div></div>';
      });
      if(sec.note) html += '<div class="sched-note">'+escapeHtml(sec.note)+'</div>';
      html += '</div>';
    });

    if(r.note){
      html = '<div class="sched-banner">'+escapeHtml(r.note)+'</div>' + html;
    }

    if(r.operator){
      html += '<div class="sched-section"><h3>OPERATOR</h3><div class="sched-op">'+
        '<div>'+escapeHtml(r.operator.name)+'</div>'+
        (r.operator.address ? '<div class="muted">'+escapeHtml(r.operator.address)+'</div>' : '')+
        (r.operator.tel ? '<div class="muted">Tel: '+escapeHtml(r.operator.tel)+'</div>' : '')+
        (r.operator.email ? '<div class="muted">'+escapeHtml(r.operator.email)+'</div>' : '')+
        (r.capacity ? '<div class="muted">Capacity: '+escapeHtml(r.capacity)+'</div>' : '')+
        (r.contacts && r.contacts.length ? r.contacts.map(function(c){
          return '<div class="muted" style="margin-top:6px;">'+escapeHtml(c.label)+(c.tel?': '+escapeHtml(c.tel):'')+'</div>';
        }).join('') : '')+
        '</div></div>';
    }
    if(r.specifiedRoute){
      html += '<div class="sched-section"><h3>SPECIFIED ROUTE</h3><div class="sched-route-text">'+escapeHtml(r.specifiedRoute)+'</div></div>';
    }
    body.innerHTML = html;
    renderPax();
  }
  document.getElementById('schedBody').addEventListener('click', function(e){
    var btn = e.target.closest('.sched-pax-btn');
    if(!btn) return;
    paxAdjustStop(btn.getAttribute('data-stopkey'), parseInt(btn.getAttribute('data-dir'),10));
  });
  // Refresh the live shading every 20s while the schedule tab is open
  setInterval(function(){
    renderSchedule();
  }, 20000);

  /* ---------------- Drawer open/close ---------------- */
  var drawer = document.getElementById('drawer'), scrim = document.getElementById('scrim');
  function openDrawer(){ drawer.classList.add('open'); scrim.classList.add('open'); }
  function closeDrawer(){ drawer.classList.remove('open'); scrim.classList.remove('open'); }
  document.getElementById('menuBtn').addEventListener('click', openDrawer);
  document.getElementById('drawerClose').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);

  /* ---------------- GPS tracking ---------------- */
  var trackBtn = document.getElementById('trackBtn');
  var navBtn = document.getElementById('navBtn');
  var firstStopBtn = document.getElementById('firstStopBtn');
  var gpsNote = document.getElementById('gpsNote');

  // Draws an in-app route to the first stop. Tries a free public road-routing
  // service (no key needed) so the line follows real streets; if that request
  // can't reach out — which is expected inside Claude's own sandbox, same
  // restriction that blocks map tiles there — it falls back to a straight-line
  // distance/bearing guide instead, computed entirely from the GPX data.
  var COACH_MAX_MPH = 62;
  var COACH_MAX_MPS = COACH_MAX_MPH * 0.44704;

  // OSRM estimates time assuming a car. We keep its road distance/geometry
  // (still the best guess at the actual path) but recompute the time using
  // each step's own implied speed, capped at the coach's max — so a
  // motorway-fast car estimate doesn't understate a coach's real trip time.
  function coachDurationFromSteps(steps, fallbackDuration){
    if(!steps || !steps.length) return fallbackDuration;
    var total = 0;
    steps.forEach(function(s){
      var d = s.distance||0, t = s.duration||0;
      var carMps = t>0 ? d/t : 0;
      var mps = carMps>0 ? Math.min(carMps, COACH_MAX_MPS) : COACH_MAX_MPS;
      total += mps>0 ? d/mps : 0;
    });
    return total || fallbackDuration;
  }

  function fetchOsrmRoute(origin, dest){
    var url = 'https://router.project-osrm.org/route/v1/driving/'+
      origin[1]+','+origin[0]+';'+dest[1]+','+dest[0]+'?overview=full&geometries=geojson&steps=true';
    var controller = (typeof AbortController!=='undefined') ? new AbortController() : null;
    var t = controller ? setTimeout(function(){ controller.abort(); }, 6000) : null;
    return fetch(url, controller ? { signal: controller.signal } : {})
      .then(function(res){
        if(t) clearTimeout(t);
        if(!res.ok) return null;
        return res.json();
      })
      .then(function(data){
        if(!data || data.code!=='Ok' || !data.routes || !data.routes.length) return null;
        var route = data.routes[0];
        var coords = route.geometry.coordinates.map(function(c){ return [c[1], c[0]]; });
        var steps = (route.legs && route.legs[0] && route.legs[0].steps) || [];
        var coachDuration = coachDurationFromSteps(steps, route.duration);
        return { coords:coords, distance:route.distance, duration:coachDuration, carDuration:route.duration };
      })
      .catch(function(){ if(t) clearTimeout(t); return null; });
  }
  function fmtDuration(sec){
    var m = Math.round(sec/60);
    if(m<60) return m+' min';
    var h=Math.floor(m/60), mm=m%60;
    return h+'h'+(mm?' '+mm+'m':'');
  }

  var guideLine = null, guiding = false;
  var guideNote = document.getElementById('guideNote');

  function clearGuide(){
    if(guideLine){ map.removeLayer(guideLine); guideLine=null; }
    guiding = false;
    firstStopBtn.classList.remove('on');
    firstStopBtn.textContent = '📍  Directions to first stop';
    guideNote.textContent = '';
  }

  firstStopBtn.addEventListener('click', function(){
    if(guiding){ clearGuide(); return; }

    var r = activeId ? routes[activeId] : null;
    var target = (r && r.stops && r.stops.length) ? r.stops[0] : (r && r.track && r.track.length ? r.track[0] : null);
    if(!target){ guideNote.textContent = 'No stops on this route yet.'; return; }

    firstStopBtn.disabled = true;
    guideNote.textContent = 'Finding your location…';

    function withOrigin(origin){
      guideNote.textContent = 'Working out a route to Stop 1…';
      fetchOsrmRoute(origin, target).then(function(res){
        if(guideLine){ map.removeLayer(guideLine); guideLine=null; }
        if(res){
          guideLine = L.polyline(res.coords, { color:getCss('--stop'), weight:5, opacity:.9, dashArray:'1,10', lineCap:'round' }).addTo(map);
          var fd = fmtDist(res.distance);
          guideNote.textContent = 'To Stop 1: '+fd.v+fd.u+' · about '+fmtDuration(res.duration)+' by road (coach pace, max '+COACH_MAX_MPH+' mph).';
        } else {
          var d = haversineMeters(origin, target);
          guideLine = L.polyline([origin, target], { color:getCss('--stop'), weight:4, opacity:.85, dashArray:'2,10' }).addTo(map);
          var fd2 = fmtDist(d);
          guideNote.textContent = 'To Stop 1: '+fd2.v+fd2.u+' as the crow flies (no road-routing service reachable here — straight line shown).';
        }
        map.fitBounds(guideLine.getBounds(), { padding:[40,40] });
        guiding = true;
        firstStopBtn.disabled = false;
        firstStopBtn.classList.add('on');
        firstStopBtn.textContent = '✕  Clear guide to first stop';
      });
    }

    if(tracking && lastFix){
      withOrigin(lastFix.latlng);
    } else if(navigator.geolocation){
      navigator.geolocation.getCurrentPosition(function(pos){
        withOrigin([pos.coords.latitude, pos.coords.longitude]);
      }, function(){
        firstStopBtn.disabled = false;
        guideNote.textContent = 'Could not get your location.';
      }, { enableHighAccuracy:true, timeout:12000 });
    } else {
      firstStopBtn.disabled = false;
      guideNote.textContent = 'This browser does not support GPS location.';
    }
  });

  navBtn.addEventListener('click', function(){
    var r = activeId ? routes[activeId] : null;
    var pts = (r && r.stops && r.stops.length>=2) ? r.stops : (r && r.track && r.track.length>=2 ? [r.track[0], r.track[r.track.length-1]] : null);
    if(!pts){
      gpsNote.textContent = 'No stops on this route to navigate to yet.';
      return;
    }
    // Google Maps' waypoints parameter tops out around 25 stops — thin
    // the list evenly if a route ever has more than that, keeping the
    // first and last stop fixed.
    var MAX = 25;
    var use = pts;
    if(pts.length > MAX){
      use = [pts[0]];
      var step = (pts.length-1)/(MAX-1);
      for(var i=1;i<MAX-1;i++) use.push(pts[Math.round(i*step)]);
      use.push(pts[pts.length-1]);
    }
    var origin = use[0], dest = use[use.length-1];
    var mid = use.slice(1,-1).map(function(p){ return p[0]+','+p[1]; }).join('|');
    var url = 'https://www.google.com/maps/dir/?api=1'+
      '&origin='+origin[0]+','+origin[1]+
      '&destination='+dest[0]+','+dest[1]+
      (mid ? '&waypoints='+encodeURIComponent(mid) : '')+
      '&travelmode=driving';
    window.open(url, '_blank', 'noopener');
  });

  var statSpeed = document.getElementById('statSpeed');
  var statDist = document.getElementById('statDist');
  var statDistUnit = document.getElementById('statDistUnit');
  var statStop = document.getElementById('statStop');
  var statStopDist = document.getElementById('statStopDist');

  // Smoothing for the *visual* marker/camera/bearing only — raw GPS fixes
  // are noisy enough on their own to make the marker and rotation feel
  // jumpy even when driving in a straight line. Every distance/off-route/
  // turn/stop calculation below still uses the real, unsmoothed fix — only
  // where something moves on screen does the smoothed value get used.
  var smoothLatLng = null, smoothHeading = null;   // what is drawn on screen right now
  var lastFixPos = null, lastFixPerf = 0;          // latest real GPS fix + when it arrived
  var velLat = 0, velLng = 0;                      // estimated velocity, degrees per ms
  var targetHeading = null;
  var POS_TAU_MS = 220;      // how quickly the drawn position catches up with the predicted one
  var HEAD_TAU_MS = 350;     // same for the map rotation
  var MAX_PREDICT_MS = 2500; // never guess further ahead than this if fixes stop arriving
  var fixHistory = [], lastTravelHeading = null, TRAVEL_MIN_M = 10; // metres moved before a direction counts
  var renderRunning = false, lastFrameT = 0, lastTileKick = 0;

  function angDiff(a, b){ return ((a - b + 540) % 360) - 180; }

  // Called for every real GPS fix: records where we are and how fast we're
  // going. Nothing is drawn here — the frame loop below does the drawing.
  function feedFix(latlng, ts, speedMps){
    var nowP = performance.now();
    if(lastFixPos && ts > lastFixPos.ts){
      var dtMs = ts - lastFixPos.ts;
      if(dtMs < 6000){
        var vLa = (latlng[0]-lastFixPos.latlng[0])/dtMs;
        var vLn = (latlng[1]-lastFixPos.latlng[1])/dtMs;
        velLat = velLat*0.4 + vLa*0.6;   // blend so one noisy fix can't fling the dot
        velLng = velLng*0.4 + vLn*0.6;
      } else { velLat = 0; velLng = 0; }
    }
    // Standing still: GPS wobble looks like movement, so drop the velocity.
    if(speedMps!=null && !isNaN(speedMps) && speedMps < 0.6){ velLat = 0; velLng = 0; }
    lastFixPos = { latlng: latlng.slice(), ts: ts };
    lastFixPerf = nowP;
    if(!smoothLatLng) smoothLatLng = latlng.slice();
    startRenderLoop();
  }

  function startRenderLoop(){
    if(renderRunning) return;
    renderRunning = true;
    lastFrameT = performance.now();
    requestAnimationFrame(renderFrame);
  }

  // Runs on every screen refresh (~60 fps). Predicts where the vehicle is
  // *now* from the last fix plus its velocity, glides the dot and camera
  // toward that point and eases the rotation toward the current heading.
  // That's what makes the map move continuously like a real sat-nav rather
  // than hopping once per GPS update.
  function renderFrame(now){
    if(!tracking || !lastFixPos || !smoothLatLng){ renderRunning = false; return; }
    var dt = Math.min(100, Math.max(1, now - lastFrameT));
    lastFrameT = now;

    var ahead = Math.min(MAX_PREDICT_MS, now - lastFixPerf);
    var tgtLat = lastFixPos.latlng[0] + velLat*ahead;
    var tgtLng = lastFixPos.latlng[1] + velLng*ahead;
    var k = 1 - Math.exp(-dt/POS_TAU_MS);
    smoothLatLng = [
      smoothLatLng[0] + (tgtLat - smoothLatLng[0])*k,
      smoothLatLng[1] + (tgtLng - smoothLatLng[1])*k
    ];

    if(targetHeading!=null){
      if(smoothHeading==null) smoothHeading = targetHeading;
      else {
        var kh = 1 - Math.exp(-dt/HEAD_TAU_MS);
        smoothHeading = (smoothHeading + kh*angDiff(targetHeading, smoothHeading) + 360) % 360;
      }
      // Bearing first, then pan (the rotate plugin needs it in that order).
      // The rotate plugin's bearing turns the map clockwise, so to put the
      // direction of travel at the top of the screen the bearing must be
      // the opposite of the heading (heading 90 = east -> bearing 270).
      var mapBrg = (360 - smoothHeading) % 360;
      if(Math.abs(angDiff(mapBrg, map.getBearing())) > 0.05) map.setBearing(mapBrg);
    }

    if(liveMarker) liveMarker.setLatLng(smoothLatLng);

    if(followMe && !map._animatingZoom){
      // Cheap pan: shift the map pane by the tiny remaining offset instead of
      // calling setView every frame (which resets the whole view and is far
      // too heavy at 60 fps).
      // In sat-nav mode the vehicle sits low on the screen (like a real
      // sat-nav) so most of the map shows the road ahead.
      var sz = map.getSize();
      var aim = sz.divideBy(2);
      if(document.body.classList.contains('satnav-mode')) aim = L.point(sz.x/2, sz.y*0.64);
      var off = map.latLngToContainerPoint(smoothLatLng).subtract(aim);
      if(Math.abs(off.x) > 0.02 || Math.abs(off.y) > 0.02){
        map._rawPanBy(off);
        map.fire('move');
        // Every so often let Leaflet settle and load newly exposed tiles.
        if(now - lastTileKick > 400){ lastTileKick = now; map.fire('moveend'); }
      }
    }
    autoZoomTick(now);
    requestAnimationFrame(renderFrame);
  }
  function resetSmoothing(){
    smoothLatLng = null; smoothHeading = null; targetHeading = null;
    lastFixPos = null; velLat = 0; velLng = 0;
    fixHistory = []; lastTravelHeading = null;
    currentGpsStopIdx = null; lastFix = null;   // no live position any more -> taps are no longer "at a stop"
    renderPaxContext();
    updateNextStop();
  }

  function onPosition(pos){
    var c = pos.coords;
    var latlng = [c.latitude, c.longitude];
    feedFix(latlng, pos.timestamp || Date.now(), c.speed);
    var displayLatLng = smoothLatLng;

    if(!liveMarker){
      liveMarker = L.marker(displayLatLng, { icon: liveIcon(), zIndexOffset:1000 }).addTo(map);
      liveMarker.bindPopup('');
    }
    liveMarker.setPopupContent('You are here<br><a class="maps-link" target="_blank" rel="noopener" href="'+mapsLink(latlng[0],latlng[1])+'">Open in Maps ↗</a>');

    // Heading priority: (1) the road itself — steadiest, since the route's
    // shape doesn't jitter like GPS does, used whenever you're on/near the
    // loaded route; (2) the device's own coords.heading, which is often
    // null in practice (many phones only populate it above a speed
    // threshold); (3) the bearing between this GPS fix and the last one,
    // once you've moved far enough for that to be meaningful.
    //
    // IMPORTANT: bearing must be set BEFORE panning, not after. The
    // rotate plugin's pan/pixel-origin math is rotation-aware, but only
    // computes correctly when it already knows the target bearing —
    // panning first and rotating second (what this used to do) is exactly
    // what caused the map to visibly jump/jitter on every single update.
    // Heading = the direction you are actually travelling across the map:
    // the bearing from where you were a few metres back to where you are
    // now (ignores the phone's own compass/GPS heading). While you're
    // stopped or crawling it holds the last direction instead of spinning.
    var headingSrc = 'none';
    var heading = null;
    fixHistory.push({ latlng: latlng, t: pos.timestamp || Date.now() });
    if(fixHistory.length > 40) fixHistory.shift();
    for(var hi = fixHistory.length-2; hi >= 0; hi--){
      var dHist = haversineMeters(fixHistory[hi].latlng, latlng);
      if(dHist >= TRAVEL_MIN_M){
        heading = bearing(fixHistory[hi].latlng, latlng);
        headingSrc = 'travel';
        lastTravelHeading = heading;
        break;
      }
    }
    if(heading==null && lastTravelHeading!=null){ heading = lastTravelHeading; headingSrc = 'held'; }
    if(tracking && heading!=null){
      targetHeading = heading;   // the frame loop eases the map round to this
    }
    var hdgDebugEl = document.getElementById('hdgDebug');
    if(hdgDebugEl){
      hdgDebugEl.textContent = (heading!=null && smoothHeading!=null ? Math.round(smoothHeading)+'\u00b0' : '–') + ' ' + headingSrc + (tracking?'':' (off)');
    }
    if(liveMarker && liveMarker.getElement){
      var iconElForWedge = liveMarker.getElement();
      var wedgeEl = iconElForWedge && iconElForWedge.querySelector('.heading-wedge');
      if(wedgeEl) wedgeEl.style.opacity = heading!=null ? '1' : '0.3';
    }
    // (camera follow now happens every frame in renderFrame)

    var mph = null;
    if(c.speed!==null && c.speed!==undefined && !isNaN(c.speed)){
      mph = c.speed*2.23694;
    } else if(lastFix){
      var dt = (pos.timestamp - lastFix.timestamp)/1000;
      if(dt>0.5){
        var dm = haversineMeters(lastFix.latlng, latlng);
        mph = (dm/dt)*2.23694;
      }
    }
    statSpeed.textContent = mph===null ? '–' : Math.max(0, Math.round(mph));
    lastFix = { latlng:latlng, timestamp:pos.timestamp };
    snCurMph = mph===null ? null : Math.max(0, mph);
    updateSatnavSpeed();
    lookupSpeedLimit(latlng);

    var r = activeId ? routes[activeId] : null;
    if(r){
      var d = distanceToTrack(latlng, r.track && r.track.length>1 ? r.track : r.stops);
      var fd = fmtDist(d);
      statDist.textContent = fd.v; statDistUnit.textContent = fd.u;

      var ns = nearestStop(latlng, r.stops);
      if(ns){
        statStop.textContent = '#'+(ns.index+1);
        var fs = fmtDist(ns.dist);
        statStopDist.textContent = fs.v+fs.u+' away';
        stopsGroup.eachLayer(function(m){});
      } else {
        statStop.textContent = '–'; statStopDist.textContent = '';
      }
      // "At a stop" for passenger-count purposes means genuinely close by —
      // a tight radius so Board/Alight taps don't get misattributed while
      // still moving between stops.
      currentGpsStopIdx = (ns && ns.dist<=AT_STOP_RADIUS_M) ? ns.index : null;
      renderPaxContext();
      updateNextStop(latlng);
      updateNavBanner(r, latlng);
    } else {
      statDist.textContent = '–'; statDistUnit.textContent = '';
      statStop.textContent = '–'; statStopDist.textContent = '';
      navBanner.style.display = 'none';
      satnavTop.style.display = 'none';
      satnavThen.style.display = 'none';
      currentGpsStopIdx = null;
      renderPaxContext();
      updateNextStop(latlng);
    }
    gpsNote.textContent = '';
  }

  var navBanner = document.getElementById('navBanner');
  var navTurnArrow = document.getElementById('navTurnArrow');
  var navTurnDist = document.getElementById('navTurnDist');
  var navStopDist = document.getElementById('navStopDist');
  var TURN_GLYPH = { left:'↰', right:'↱' };

  var satnavTop = document.getElementById('satnavTop');
  var satnavArrow = document.getElementById('satnavArrow');
  var satnavDist = document.getElementById('satnavDist');
  var satnavInstr = document.getElementById('satnavInstr');
  var satnavThen = document.getElementById('satnavThen');
  var sbEta = document.getElementById('sbEta');
  var sbRemaining = document.getElementById('sbRemaining');
  var sbSpeed = document.getElementById('sbSpeed');
  var sbStop = document.getElementById('sbStop');

  function updateNavBanner(r, latlng){
    if(!r.track || r.track.length<3){ navBanner.style.display='none'; satnavTop.style.display='none'; satnavThen.style.display='none'; return; }
    getRouteNav(r);
    var inSatnav = document.body.classList.contains('satnav-mode');
    navBanner.style.display = inSatnav ? 'none' : 'flex';
    satnavTop.style.display = inSatnav ? 'flex' : 'none';

    var progressIdx = findNearestTrackIndex(latlng, r.track);

    var nextTurn = null, nextTurnPos = -1;
    for(var i=0;i<r._turns.length;i++){ if(r._turns[i].trackIdx >= progressIdx){ nextTurn = r._turns[i]; nextTurnPos = i; break; } }
    var thenTurn = (nextTurnPos>=0 && r._turns[nextTurnPos+1]) ? r._turns[nextTurnPos+1] : null;

    if(nextTurn){
      var glyph = TURN_GLYPH[nextTurn.dir] || '↑';
      var label = (nextTurn.dir==='left'?'Left':'Right')+(nextTurn.angle>=80?' turn':'');
      var td = fmtDist(haversineMeters(latlng, nextTurn.latlng));
      navTurnArrow.textContent = glyph;
      navTurnDist.textContent = label+' in '+td.v+td.u;
      satnavArrow.textContent = glyph;
      satnavDist.textContent = td.v+td.u;
      satnavInstr.textContent = label;
    } else {
      navTurnArrow.textContent = '🏁'; navTurnDist.textContent = 'No more turns';
      satnavArrow.textContent = '🏁'; satnavDist.textContent = '–'; satnavInstr.textContent = 'No more turns';
    }
    if(inSatnav && thenTurn){
      var thenGlyph = TURN_GLYPH[thenTurn.dir] || '↑';
      satnavThen.style.display = 'flex';
      satnavThen.innerHTML = 'Then <span class="then-arrow">'+thenGlyph+'</span> '+(thenTurn.dir==='left'?'left':'right');
    } else {
      satnavThen.style.display = 'none';
    }

    var nextStopI = -1;
    for(var j=0;j<r._stopTrackIdx.length;j++){ if(r._stopTrackIdx[j] >= progressIdx){ nextStopI = j; break; } }
    if(nextStopI>=0){
      var sd = fmtDist(haversineMeters(latlng, r.stops[nextStopI]));
      navStopDist.textContent = 'Stop '+(nextStopI+1)+' · '+sd.v+sd.u;
      sbStop.textContent = '#'+(nextStopI+1)+' '+sd.v+sd.u;
    } else {
      navStopDist.textContent = 'Route complete';
      sbStop.textContent = '–';
    }

    if(inSatnav){
      var remainM = Math.max(0, (r._cum[r._cum.length-1]||0) - (r._cum[progressIdx]||0));
      var rd = fmtDist(remainM);
      sbRemaining.textContent = rd.v+rd.u;
      var curMph = parseFloat(statSpeed.textContent);
      var planMph = (!isNaN(curMph) && curMph>5) ? Math.min(curMph, COACH_MAX_MPH) : Math.min(30, COACH_MAX_MPH);
      sbSpeed.textContent = isNaN(curMph) ? '–' : Math.round(curMph);
      var etaMinutes = Math.round((remainM/1609.34)/planMph*60);
      var etaDate = new Date(Date.now()+etaMinutes*60000);
      var hh = etaDate.getHours(), mm = etaDate.getMinutes();
      sbEta.textContent = (hh<10?'0':'')+hh+':'+(mm<10?'0':'')+mm;
    }
  }

  function onPositionError(err){
    var msg = 'GPS unavailable.';
    if(err && err.code===1) msg = 'Location permission denied — enable it in your browser settings to track your position.';
    else if(err && err.code===2) msg = 'Location signal unavailable right now.';
    else if(err && err.code===3) msg = 'Location request timed out — still trying…';
    gpsNote.textContent = msg;
  }

  trackBtn.addEventListener('click', function(){
    if(!tracking){
      if(!navigator.geolocation){
        gpsNote.textContent = 'This browser does not support GPS location.';
        return;
      }
      tracking = true;
      followMe = true;
      ensureRunStarted();
      trackBtn.classList.add('on');
      trackBtn.textContent = '■  Stop GPS tracking';
      gpsNote.textContent = 'Finding your location…';
      try{
        watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
          enableHighAccuracy:true, maximumAge:0, timeout:15000
        });
      }catch(e){
        gpsNote.textContent = 'Could not start GPS tracking.';
        tracking = false; trackBtn.classList.remove('on'); trackBtn.textContent = '▶  Start GPS tracking';
      }
    } else {
      tracking = false;
      trackBtn.classList.remove('on');
      trackBtn.textContent = '▶  Start GPS tracking';
      gpsNote.textContent = '';
      navBanner.style.display = 'none';
      map.setBearing(0);
      resetSmoothing();
      if(document.body.classList.contains('satnav-mode') && typeof endSatnav==='function') endSatnav();
      if(watchId!==null && navigator.geolocation){ navigator.geolocation.clearWatch(watchId); watchId=null; }
    }
  });

  // Full-screen map: hides the top bar / tabs / bottom panel so the map
  // fills the screen. Also tries the browser's native Fullscreen API (hides
  // the browser chrome too) where the platform supports it — iOS Safari
  // generally doesn't, so this quietly no-ops there and the CSS-only
  // full-bleed layout still does the main job everywhere.
  var fsFab = document.getElementById('fsFab');
  var fsExit = document.getElementById('fsExit');
  function setFullscreen(on){
    document.body.classList.toggle('fs-mode', on);
    fsFab.classList.toggle('active', on);
    if(on){
      try{
        var el = document.documentElement;
        if(el.requestFullscreen) el.requestFullscreen().catch(function(){});
        else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      }catch(e){}
    } else {
      try{
        if(document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function(){});
        else if(document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
      }catch(e){}
    }
    // The real Fullscreen API transition can take a moment to actually
    // finish resizing the viewport, so retry a couple of times.
    [120, 350].forEach(function(ms){ setTimeout(function(){ map.invalidateSize(); }, ms); });
  }
  fsFab.addEventListener('click', function(){
    if(document.body.classList.contains('satnav-mode')){ endSatnav(); return; }
    setFullscreen(!document.body.classList.contains('fs-mode'));
  });

  // Sat-Nav mode: one button that turns on everything a sat-nav view needs —
  // full screen, heading-based spin (which kicks in automatically once
  // tracking starts, per the spin logic above), and swaps the small
  // turn/stop cards for the big top instruction bar + bottom ETA bar.
  // Flat 2D throughout — no 3D tilt.
  var satnavBtn = document.getElementById('satnavBtn');
  function startSatnav(){
    document.body.classList.add('satnav-mode');
    satnavBtn.classList.add('on');
    satnavBtn.textContent = '✕  End Sat-Nav mode';
    fsExit.textContent = '✕ End Sat-Nav';
    snWake(true); snAutoZoomAt = 0; snUserZoomUntil = 0;
    setFullscreen(true);
    if(!tracking) trackBtn.click();
    if(activeId && routes[activeId]) updateNavBanner(routes[activeId], lastFix ? lastFix.latlng : (map.getCenter?[map.getCenter().lat,map.getCenter().lng]:[0,0]));
    updateNextStop();
  }
  function endSatnav(){
    if(typeof previewActive!=='undefined' && previewActive){
      previewActive = false;
      if(previewTimer){ clearInterval(previewTimer); previewTimer = null; }
      previewBtn.classList.remove('on');
      previewBtn.textContent = '🎬  Preview this route';
      tracking = false;
      map.setBearing(0);
      resetSmoothing();
    }
    snWake(false);
    if(tracking) trackBtn.click();   // GPS has no button of its own now, so ending Sat-Nav stops it
    document.body.classList.remove('satnav-mode');
    satnavBtn.classList.remove('on');
    satnavBtn.textContent = '🛰️  Start Sat-Nav mode';
    fsExit.textContent = '✕ Exit full screen';
    setFullscreen(false);
    satnavTop.style.display = 'none';
    satnavThen.style.display = 'none';
    document.getElementById('satnavBottom').style.display = 'none';
    updateNextStop();
  }
  satnavBtn.addEventListener('click', function(){
    if(document.body.classList.contains('satnav-mode')) endSatnav(); else startSatnav();
  });

  // Route preview — "drives" the loaded route by walking along its own
  // track at a steady simulated speed and feeding each point through the
  // exact same onPosition() function real GPS updates use. That means the
  // map pan, rotation (road-derived, since we're always exactly on the
  // track), big turn card, ETA bar and schedule shading all behave
  // identically to a real drive, with nothing duplicated or faked twice.
  var previewBtn = document.getElementById('previewBtn');
  var previewActive = false, previewTimer = null, previewDistance = 0;
  var PREVIEW_SPEED_MPS = 13.4; // ~30 mph simulated
  var PREVIEW_TICK_MS = 500;

  function positionAtDistance(track, cum, dist){
    if(!track || !track.length) return null;
    if(dist<=0) return track[0];
    if(dist>=cum[cum.length-1]) return track[track.length-1];
    var i=0;
    while(i<cum.length-2 && cum[i+1]<dist) i++;
    var segStart=cum[i], segEnd=cum[i+1];
    var frac = segEnd>segStart ? (dist-segStart)/(segEnd-segStart) : 0;
    var a=track[i], b=track[i+1];
    return [ a[0]+(b[0]-a[0])*frac, a[1]+(b[1]-a[1])*frac ];
  }
  function previewTick(){
    var r = activeId ? routes[activeId] : null;
    if(!r || !r.track || r.track.length<2 || !previewActive){ stopPreview(); return; }
    getRouteNav(r);
    var total = r._cum[r._cum.length-1] || 0;
    if(previewDistance >= total){ stopPreview(); return; }
    var latlng = positionAtDistance(r.track, r._cum, previewDistance);
    previewDistance += PREVIEW_SPEED_MPS * (PREVIEW_TICK_MS/1000);
    onPosition({
      coords: { latitude:latlng[0], longitude:latlng[1], heading:null, speed:PREVIEW_SPEED_MPS, accuracy:5 },
      timestamp: Date.now()
    });
  }
  function startPreview(){
    var r = activeId ? routes[activeId] : null;
    if(!r || !r.track || r.track.length<2){ gpsNote.textContent = 'No route track to preview.'; return; }
    if(tracking) trackBtn.click(); // stop any real GPS tracking first, don't run both at once
    previewActive = true;
    previewDistance = 0;
    ensureRunStarted();
    tracking = true;   // reuses onPosition's normal tracking-gated rotation logic
    followMe = true;
    previewBtn.classList.add('on');
    previewBtn.textContent = '⏹  Stop preview';
    document.body.classList.add('satnav-mode');
    setFullscreen(true);
    previewTimer = setInterval(previewTick, PREVIEW_TICK_MS);
    previewTick();
  }
  function stopPreview(){
    previewActive = false;
    tracking = false;
    if(previewTimer){ clearInterval(previewTimer); previewTimer = null; }
    previewBtn.classList.remove('on');
    previewBtn.textContent = '🎬  Preview this route';
    map.setBearing(0);
    resetSmoothing();
    endSatnav();
  }
  previewBtn.addEventListener('click', function(){
    if(previewActive) stopPreview(); else startPreview();
  });
  fsExit.addEventListener('click', function(){
    if(document.body.classList.contains('satnav-mode')) endSatnav(); else setFullscreen(false);
  });
  document.addEventListener('fullscreenchange', function(){
    setTimeout(function(){ map.invalidateSize(); }, 30);
    if(document.fullscreenElement) return;
    if(document.body.classList.contains('satnav-mode')) endSatnav();
    else if(document.body.classList.contains('fs-mode')) setFullscreen(false);
  });


  /* ---------------- Sat-nav extras: clock, speed, speed limit, auto-zoom ---------------- */
  var snCurMph = null, snLimitMph = null;
  var snClock = document.getElementById('snClock');
  var snSpeed = document.getElementById('snSpeed');
  var snSpeedBox = document.getElementById('snSpeedBox');
  var snLimit = document.getElementById('snLimit');
  function tickClock(){
    var n = new Date(), h = n.getHours(), m = n.getMinutes();
    snClock.textContent = (h<10?'0':'')+h+':'+(m<10?'0':'')+m;
  }
  tickClock(); setInterval(tickClock, 1000);
  function updateSatnavSpeed(){
    snSpeed.textContent = snCurMph===null ? '–' : Math.round(snCurMph);
    snSpeedBox.classList.toggle('over', snLimitMph!=null && snCurMph!=null && Math.round(snCurMph) > snLimitMph + 2);
  }
  function showLimit(v){
    snLimitMph = v;
    snLimit.textContent = v==null ? '–' : v;
    snLimit.classList.toggle('unknown', v==null);
    updateSatnavSpeed();
  }
  // Speed limit comes from OpenStreetMap (via the free Overpass service):
  // the nearest road to you and its "maxspeed" tag. It only asks again after
  // you've moved ~50 m, and keeps the last answer while a lookup is running
  // or if there's no signal. Roads with no limit tagged show a dash.
  var limQueryPos = null, limBusy = false, limLastT = 0, limMisses = 0;
  function parseMaxspeed(t){
    if(!t) return null;
    var v = String(t).toLowerCase().trim();
    var m = v.match(/^(\d+)\s*mph$/);
    if(m) return parseInt(m[1],10);
    m = v.match(/^(\d+)$/);            // bare number in UK data means km/h; convert
    if(m) return Math.round(parseInt(m[1],10)/1.609);
    m = v.match(/^(\d+)\s*km\/h$/);
    if(m) return Math.round(parseInt(m[1],10)/1.609);
    if(v==='national' || v==='gb:nsl_single') return 60;
    if(v==='gb:nsl_dual' || v==='gb:motorway') return 70;
    return null;
  }
  function segDistM(p, a, b){
    var kx = Math.cos(p[0]*Math.PI/180)*111320, ky = 110540;
    var ax=(a.lon-p[1])*kx, ay=(a.lat-p[0])*ky, bx=(b.lon-p[1])*kx, by=(b.lat-p[0])*ky;
    var dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy, t = L2? Math.max(0,Math.min(1,-(ax*dx+ay*dy)/L2)) : 0;
    var px=ax+t*dx, py=ay+t*dy; return Math.sqrt(px*px+py*py);
  }
  function lookupSpeedLimit(latlng){
    if(limBusy) return;
    var now = Date.now();
    if(limQueryPos && haversineMeters(limQueryPos, latlng) < 50 && now - limLastT < 60000) return;
    if(now - limLastT < 4000) return;
    limBusy = true; limLastT = now; limQueryPos = latlng;
    var q = '[out:json][timeout:8];way(around:30,'+latlng[0].toFixed(6)+','+latlng[1].toFixed(6)+')[highway];out tags geom;';
    var ctl = (typeof AbortController!=='undefined') ? new AbortController() : null;
    var to = setTimeout(function(){ if(ctl) ctl.abort(); }, 9000);
    fetch('https://overpass-api.de/api/interpreter', { method:'POST', body:'data='+encodeURIComponent(q),
        headers:{'Content-Type':'application/x-www-form-urlencoded'}, signal: ctl?ctl.signal:undefined })
      .then(function(r){ return r.json(); })
      .then(function(j){
        var best = null, bestD = 1e9;
        (j.elements||[]).forEach(function(w){
          var g = w.geometry||[]; var t = w.tags||{};
          if(t.highway==='footway'||t.highway==='path'||t.highway==='cycleway'||t.highway==='steps'||t.highway==='service'&&!t.maxspeed) return;
          for(var i=0;i<g.length-1;i++){
            var d = segDistM(latlng, g[i], g[i+1]);
            if(d < bestD){ bestD = d; best = w; }
          }
        });
        var v = best ? parseMaxspeed(best.tags && best.tags.maxspeed) : null;
        if(v==null && best){
          // UK defaults for untagged roads would be guesswork, so only
          // say "unknown" after a couple of misses in a row.
          limMisses++; if(limMisses>=2) showLimit(null);
        } else { limMisses = 0; showLimit(v); }
      })
      .catch(function(){ /* keep last value */ })
      .then(function(){ clearTimeout(to); limBusy = false; });
  }

  // Auto-zoom: closer in when slow / in town, further out at speed, like a
  // sat-nav. Backs off for 25 s whenever you zoom the map yourself.
  var snAutoZoomAt = 0, snUserZoomUntil = 0, snAutoZooming = false;
  function autoZoomTick(now){
    if(!document.body.classList.contains('satnav-mode') || snCurMph==null) return;
    if(now < snUserZoomUntil || now - snAutoZoomAt < 6000 || map._animatingZoom) return;
    var mph = snCurMph, z;
    if(mph < 12) z = 18; else if(mph < 28) z = 17.5; else if(mph < 42) z = 17; else if(mph < 55) z = 16.5; else z = 16;
    if(Math.abs(map.getZoom() - z) < 0.4) return;
    snAutoZoomAt = now; snAutoZooming = true;
    map.setZoomAround(smoothLatLng, z, { animate:true });
    setTimeout(function(){ snAutoZooming = false; }, 700);
  }
  map.on('zoomstart', function(){ if(!snAutoZooming) snUserZoomUntil = performance.now() + 25000; });

  // Snap back to following you 8 s after you drag the map in sat-nav mode.
  var snRecenterTimer = null;
  map.on('dragstart', function(){
    if(!document.body.classList.contains('satnav-mode')) return;
    clearTimeout(snRecenterTimer);
    snRecenterTimer = setTimeout(function(){ followMe = true; }, 8000);
  });

  // Keep the screen on while navigating.
  var snWakeLock = null;
  function snWake(on){
    try{
      if(on && navigator.wakeLock){ navigator.wakeLock.request('screen').then(function(l){ snWakeLock = l; }).catch(function(){}); }
      else if(!on && snWakeLock){ snWakeLock.release(); snWakeLock = null; }
    }catch(e){}
  }
  document.addEventListener('visibilitychange', function(){
    if(!document.hidden && document.body.classList.contains('satnav-mode') && !snWakeLock) snWake(true);
  });

  document.getElementById('zoomInFab').addEventListener('click', function(){ map.zoomIn(); });
  document.getElementById('zoomOutFab').addEventListener('click', function(){ map.zoomOut(); });

  document.getElementById('locateFab').addEventListener('click', function(){
    followMe = true;
    if(liveMarker) map.panTo(liveMarker.getLatLng(), { animate:true });
    else if(!tracking) trackBtn.click();
  });
  map.on('dragstart', function(){ followMe = false; });

  /* ---------------- Stop names, timetable times & the "Next stop" display ---------------- */
  function isGenericStopName(n){ return !n || /^stop\s*\d+$/i.test(String(n).trim()); }
  function normName(n){ return String(n||'').trim().toLowerCase().replace(/\s+/g,' '); }
  // Which timetable part applies now: the route's own session if it has one, else by time of day.
  function currentTimetableRows(r){
    var tt = (r && r.timetable) || {};
    var am = tt.morning || [], pm = tt.afternoon || [];
    var wantAm = r.session==='AM' ? true : r.session==='PM' ? false : (new Date().getHours() < 12);
    var rows = wantAm ? am : pm;
    if(!rows.length) rows = wantAm ? pm : am;
    return rows;
  }
  // Best available name: route.stops name -> timetable row (when rows line up with stops) -> "Stop N".
  function stopName(r, i){
    var n = String((r.stopNames && r.stopNames[i]) || '').trim();
    if(!isGenericStopName(n)) return n;
    var rows = currentTimetableRows(r), count = (r.stops||[]).length;
    if(rows.length && rows.length===count && rows[i] && String(rows[i].stop||'').trim()) return String(rows[i].stop).trim();
    return n || ('Stop '+(i+1));
  }
  // Scheduled time ("HH:MM") for stop i, if the timetable has one: match by name first, else by position.
  function stopSchedTime(r, i){
    var rows = currentTimetableRows(r);
    if(!rows.length) return '';
    var nm = normName(stopName(r, i)), raw = normName(r.stopNames && r.stopNames[i]);
    for(var k=0;k<rows.length;k++){
      var rn = normName(rows[k].stop);
      if(rn && (rn===nm || (raw && rn===raw)) && rows[k].time) return String(rows[k].time);
    }
    if(rows.length===(r.stops||[]).length && rows[i] && rows[i].time) return String(rows[i].time);
    return '';
  }

  var nextStopEl = document.getElementById('nextStop');
  var nsNum = document.getElementById('nsNum'), nsLbl = document.getElementById('nsLbl');
  var nsName = document.getElementById('nsName'), nsDist = document.getElementById('nsDist'), nsTime = document.getElementById('nsTime');
  // Which stop is the driver coming up to? At a stop (within AT_STOP_RADIUS_M) -> that stop. Otherwise, with a
  // track: the first stop not yet passed along the track (same progress logic as the turn banner);
  // without a track: the nearest stop. idx -1 = every stop has been passed.
  function computeNextStop(r, latlng){
    var stops = r.stops || [];
    if(!stops.length) return null;
    if(!latlng) return { idx:0, at:false, dist:null };
    var ns = nearestStop(latlng, stops);
    if(ns && ns.dist <= AT_STOP_RADIUS_M) return { idx:ns.index, at:true, dist:ns.dist };
    var idx;
    if(r.track && r.track.length>=2){
      getRouteNav(r);
      var progress = findNearestTrackIndex(latlng, r.track);
      idx = -1;
      for(var j=0;j<r._stopTrackIdx.length;j++){ if(r._stopTrackIdx[j] >= progress){ idx = j; break; } }
    } else idx = ns.index;
    return { idx:idx, at:false, dist: idx>=0 ? haversineMeters(latlng, stops[idx]) : null };
  }
  function updateNextStop(latlng){
    if(!nextStopEl) return;
    var r = activeId ? routes[activeId] : null;
    var show = !!r && r.stops && r.stops.length && document.body.classList.contains('satnav-mode');
    if(!show){ nextStopEl.style.display = 'none'; return; }
    if(latlng===undefined) latlng = lastFix ? lastFix.latlng : null;
    var res = computeNextStop(r, latlng);
    nextStopEl.style.display = 'flex';
    nextStopEl.classList.toggle('at', !!(res && res.at));
    if(!res || res.idx<0){
      nextStopEl.setAttribute('data-stop', 'done');
      nsNum.textContent = '🏁'; nsLbl.textContent = 'ROUTE COMPLETE';
      nsName.textContent = 'All stops passed'; nsDist.textContent = ''; nsTime.textContent = '';
      return;
    }
    var i = res.idx, total = r.stops.length;
    var fd = fmtDist(res.dist);
    var nm = stopName(r, i), t = stopSchedTime(r, i);
    nextStopEl.setAttribute('data-stop', String(i+1));
    nsNum.textContent = String(i+1);
    nsLbl.textContent = (res.at ? 'AT STOP ' : 'NEXT STOP ') + (i+1) + ' OF ' + total;
    nsName.textContent = nm;
    nsDist.textContent = res.dist==null ? '–' : (fd.v + fd.u).replace(' ','\u00a0');
    nsTime.textContent = t ? ('Due ' + t) : '';
  }

  /* ---------------- Finish & submit run ---------------- */
  // main.js supplies runCfg = { uid, companyId, newRunId(), submit(id, run) -> Promise } after sign-in.
  // The run's counts live in `pax` (localStorage) until a submit succeeds; a failed/offline submit is kept in
  // the 'rt_pending_runs' list (with its id, so a retry can never create a duplicate) and offers a Retry.
  var runCfg = null;
  var PENDING_KEY = 'rt_pending_runs';
  var runModal = document.getElementById('runModal');
  var runBody = document.getElementById('runBody'), runMsg = document.getElementById('runMsg');
  var runSubmitBtn = document.getElementById('runSubmit'), runCancelBtn = document.getElementById('runCancel');
  var finishBtn = document.getElementById('finishRunBtn'), snFinishBtn = document.getElementById('snFinishBtn');
  var runPendingEl = document.getElementById('runPending');
  var modalRun = null, modalRunId = null, modalBusy = false, modalDone = false;

  function readPending(){
    try{ var a = JSON.parse(localStorage.getItem(PENDING_KEY)||'[]'); return Array.isArray(a) ? a : []; }catch(e){ return []; }
  }
  function writePending(list){ try{ localStorage.setItem(PENDING_KEY, JSON.stringify(list)); }catch(e){} }
  function myPending(){
    return runCfg ? readPending().filter(function(p){ return p.uid===runCfg.uid && p.companyId===runCfg.companyId; }) : [];
  }
  function putPending(entry){
    var list = readPending().filter(function(p){ return p.id!==entry.id; });
    list.push(entry); writePending(list);
  }
  function dropPending(id){ writePending(readPending().filter(function(p){ return p.id!==id; })); }

  function runSession(r, startedAt){
    if(r.session==='AM' || r.session==='PM') return r.session;
    var h = new Date(startedAt || Date.now()).getHours();
    return h < 12 ? 'AM' : 'PM';
  }
  function sumVals(o){ var t=0; Object.keys(o||{}).forEach(function(k){ t += (o[k]|0); }); return t; }
  // Builds the run document body from the counts stored for the active route.
  function buildRun(r){
    var stops = r.stops || [], n = stops.length;
    var rows = stops.map(function(_, i){
      return { index:i, name:stopName(r, i), boarded:(pax.stopsOn[i]|0), alighted:(pax.stopsOff[i]|0) };
    });
    var extraOn = 0, extraOff = 0;      // counts for stops that no longer exist (route edited mid-run) -> unscheduled
    Object.keys(pax.stopsOn||{}).forEach(function(k){ if(+k >= n) extraOn += pax.stopsOn[k]|0; });
    Object.keys(pax.stopsOff||{}).forEach(function(k){ if(+k >= n) extraOff += pax.stopsOff[k]|0; });
    var uOn = (pax.adhocOn|0) + extraOn, uOff = (pax.adhocOff|0) + extraOff;
    var tb = uOn, ta = uOff;
    rows.forEach(function(x){ tb += x.boarded; ta += x.alighted; });
    var started = pax.startedAt || Date.now();
    return {
      routeId:activeId, routeName:r.name || 'Route', session:runSession(r, started), startedAt:started,
      totalBoarded:tb, totalAlighted:ta, unscheduledBoarded:uOn, unscheduledAlighted:uOff, stops:rows
    };
  }

  function renderRunUi(){
    var r = activeId ? routes[activeId] : null;
    var has = !!r && !!runCfg;
    var pend = myPending();
    if(finishBtn) finishBtn.style.display = has ? '' : 'none';
    if(snFinishBtn){
      snFinishBtn.classList.toggle('on', has);
      snFinishBtn.textContent = pend.length ? '⚠ Retry run upload' : '🏁 Finish & submit run';
      snFinishBtn.classList.toggle('warn', pend.length>0);
    }
    if(runPendingEl){
      runPendingEl.style.display = pend.length ? 'flex' : 'none';
      var t = document.getElementById('runPendingText');
      if(t) t.textContent = pend.length + (pend.length===1 ? ' finished run is' : ' finished runs are') + ' saved on this phone and not uploaded yet.';
    }
  }

  function summaryHtml(run){
    var h = '<div class="run-meta"><b>'+escapeHtml(run.routeName)+'</b> · '+escapeHtml(run.session)+'</div>'+
      '<table class="run-table"><thead><tr><th>Stop</th><th class="n">Boarded</th><th class="n">Alighted</th></tr></thead><tbody>';
    run.stops.forEach(function(s){
      h += '<tr><td>'+(s.index+1)+'. '+escapeHtml(s.name)+'</td><td class="n">'+s.boarded+'</td><td class="n">'+s.alighted+'</td></tr>';
    });
    h += '<tr class="unsched"><td>Unscheduled (not at a stop)</td><td class="n">'+run.unscheduledBoarded+'</td><td class="n">'+run.unscheduledAlighted+'</td></tr>';
    h += '<tr class="tot"><td>Total</td><td class="n" id="runTotB">'+run.totalBoarded+'</td><td class="n" id="runTotA">'+run.totalAlighted+'</td></tr></tbody></table>';
    var sched = sumVals(pax.byStop);
    if(run.routeId===activeId && sched) h += '<div class="run-note">Schedule-tab “onboard change” taps (net '+(sched>0?'+':'')+sched+') are not part of the per-stop figures.</div>';
    return h;
  }
  function setModalState(state, msg){
    // state: 'confirm' | 'busy' | 'failed' | 'done'
    modalBusy = state==='busy'; modalDone = state==='done';
    runMsg.textContent = msg || '';
    runMsg.className = 'run-msg' + (state==='failed' ? ' err' : state==='done' ? ' ok' : '');
    runSubmitBtn.disabled = state==='busy';
    runCancelBtn.disabled = state==='busy';
    runSubmitBtn.textContent = state==='busy' ? 'Submitting…' : state==='failed' ? 'Retry' : state==='done' ? 'Done' : 'Submit';
    runCancelBtn.style.display = state==='done' ? 'none' : '';
    runCancelBtn.textContent = state==='failed' ? 'Close (keep on phone)' : 'Cancel';
  }
  function openRunModal(fromBanner){
    if(!runCfg) return;
    var pend = myPending();
    var r = activeId ? routes[activeId] : null;
    var target = null;                       // a saved-but-not-uploaded run to retry
    if(fromBanner===true && pend.length){
      target = pend.filter(function(p){ return p.run.routeId===activeId; })[0] || pend[0];
    }
    if(target && target.run.routeId!==activeId){
      modalRun = target.run; modalRunId = target.id;        // another route: resend exactly what was saved
    } else if(r){
      var same = target || pend.filter(function(p){ return p.run.routeId===activeId; })[0];
      modalRun = buildRun(r);                               // counts may have grown since the failed attempt
      modalRunId = same ? same.id : runCfg.newRunId();
      if(same && same.run.startedAt) modalRun.startedAt = Math.min(same.run.startedAt, modalRun.startedAt);
    } else if(pend.length){
      modalRun = pend[0].run; modalRunId = pend[0].id;
    } else return;
    runBody.innerHTML = summaryHtml(modalRun);
    runModal.style.display = 'flex';
    var isRetry = pend.some(function(p){ return p.id===modalRunId; });
    if(isRetry) setModalState('failed', 'This run is saved on your phone but is not uploaded yet. Tap Retry to upload it.');
    else setModalState('confirm', '');
  }
  function closeRunModal(){ runModal.style.display = 'none'; modalBusy = false; renderRunUi(); }

  function resetRunCounts(run){
    if(run.routeId===activeId){
      pax = newPax(); savePax(activeId); renderPax();
    } else {
      try{ localStorage.removeItem(paxKey(run.routeId)); }catch(e){}
    }
  }
  function doSubmitRun(){
    if(modalBusy || !modalRun || !runCfg) return;
    if(modalDone){ closeRunModal(); return; }
    var run = modalRun, id = modalRunId;
    setModalState('busy', 'Uploading…');
    putPending({ id:id, uid:runCfg.uid, companyId:runCfg.companyId, run:run, savedAt:Date.now() });   // safe copy first
    Promise.resolve().then(function(){ return runCfg.submit(id, run); }).then(function(){
      dropPending(id);
      resetRunCounts(run);
      renderRunUi();
      setModalState('done', 'Run submitted ✔ — passenger counts for this route have been reset.');
    }, function(e){
      var why = (e && e.code==='offline') ? 'You appear to be offline.' : 'The upload failed (' + ((e && (e.code||e.message)) || 'unknown error') + ').';
      renderRunUi();
      setModalState('failed', why + ' The run is saved on this phone — tap Retry when you have signal.');
    });
  }
  if(finishBtn) finishBtn.addEventListener('click', function(){ openRunModal(false); });
  if(snFinishBtn) snFinishBtn.addEventListener('click', function(){ openRunModal(myPending().length>0); });
  if(runSubmitBtn) runSubmitBtn.addEventListener('click', doSubmitRun);
  if(runCancelBtn) runCancelBtn.addEventListener('click', function(){ if(!modalBusy) closeRunModal(); });
  var runPendingBtn = document.getElementById('runPendingRetry');
  if(runPendingBtn) runPendingBtn.addEventListener('click', function(){ openRunModal(true); });

  /* ---------------- Public API (used by js/main.js) ---------------- */
  function clearActiveRoute(){
    activeId = null;
    if(trackLine){ map.removeLayer(trackLine); trackLine=null; }
    stopsGroup.clearLayers();
    document.getElementById('routeName').textContent = 'Round Tracker';
    document.getElementById('routeSub').textContent = 'No route loaded';
    pax = newPax();
    renderPax();
    renderSchedule();
    renderRunUi();
    updateNextStop();
  }
  window.RoundTracker = {
    // fresh: { routeId: routeObject } for the signed-in user's company (real-time)
    setRoutes: function(fresh){
      var old = activeId ? routes[activeId] : null;
      // keep the already-prepared object (turn cache etc.) if that route did not change
      if(old && fresh[activeId] && fresh[activeId]._v === old._v) fresh[activeId] = old;
      routes = fresh;
      renderEmptyState();
      if(!Object.keys(routes).length){ clearActiveRoute(); renderRouteList(); return; }
      if(!activeId || !routes[activeId]){
        var saved = null;
        try{ saved = localStorage.getItem('rt_active'); }catch(e){}
        setActiveRoute((saved && routes[saved]) ? saved : Object.keys(routes).sort(function(a,b){
          return (routes[b].addedAt||'').localeCompare(routes[a].addedAt||'');
        })[0]);
      } else if(!old || routes[activeId] !== old){
        setActiveRoute(activeId);   // the admin edited the route being viewed
      } else {
        renderRouteList();
      }
    },
    // call after the driver view becomes visible (map was hidden while sizing)
    // after sign-in: { uid, companyId, newRunId(), submit(id, run) -> Promise }  (see "Finish & submit run")
    configureRuns: function(cfg){ runCfg = cfg; renderRunUi(); },
    show: function(){
      map.invalidateSize();
      var r = activeId ? routes[activeId] : null;
      if(r){
        var b = (r.track && r.track.length) ? L.latLngBounds(r.track) : ((r.stops && r.stops.length) ? L.latLngBounds(r.stops) : null);
        if(b) map.fitBounds(b, { padding:[36,36] });
      }
      renderSchedule();
      renderRunUi();
    }
  };

})();
