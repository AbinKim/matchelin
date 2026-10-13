'use strict';
(() => {
  const { RATINGS, CATEGORIES, ratingOf, categoryOf, isOverseas, provinceOf, cityCoord, guessCategory, parseMemo, placeKey } = window.MemoParser;

  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const newId = () => 'p_' + Math.random().toString(36).slice(2, 12);
  const THIS_YEAR = String(new Date().getFullYear()).slice(2);
  const RATING_ORDER = Object.fromEntries(RATINGS.map((r, i) => [r.key, i]));

  const KEY = { places: 'msl.places', pending: 'msl.pending', cfg: 'msl.cfg', view: 'msl.view', version: 'msl.version', filter: 'msl.filter', sort: 'msl.sort' };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
  };

  const cfg = { kakaoKey: '', apiUrl: '', token: '', role: 'edit', viewToken: '', ...store.get(KEY.cfg, {}) };
  cfg.kakaoKey = cfg.kakaoKey || (window.APP_CONFIG || {}).kakaoKey || '';
  const canEdit = () => cfg.role !== 'view';
  const state = {
    places: store.get(KEY.places, []),
    pending: store.get(KEY.pending, []),
    filter: (({ region, ...f }) => ({ ratings: [], category: '', province: '', hideClosed: false, ...f }))(store.get(KEY.filter, {})),
    sort: store.get(KEY.sort, 'rating'),
    selected: null,
    pick: null,       // 지도 탭으로 위치 고르는 중일 때의 콜백
    assignTo: null,   // 검색 결과를 이 맛집의 위치로 지정하는 중
    myPos: null,
    world: false,     // true면 해외 지도(OpenStreetMap)를 보여 준다
  };

  let map, clusterer, placesSvc, geocoder, draftOverlay, meOverlay;
  const overlays = new Map(); // id → { ov, el }

  const byId = id => state.places.find(p => p.id === id);
  const hasPos = p => p && p.lat != null && p.lng != null && p.lat !== '' && !Number.isNaN(+p.lat);
  // years 칸 = 연도별 등급 "23:bib 24:bib 25:1". 예전 형식 "23 24 25"는 모든 해에 현재 등급을 받은 것으로 본다
  function history(p) {
    const base = p.rating && p.rating !== 'wish' ? p.rating : 'bib';
    const m = {};
    String(p.years || '').split(/[\s,]+/).forEach(t => {
      const x = t.match(/^'?(\d{2})(?::(3|2|1|bib|visit))?$/);
      if (x) m[x[1]] = x[2] || base;
    });
    return Object.keys(m).sort().map(y => ({ y, r: m[y] }));
  }
  const years = p => history(p).map(h => h.y);
  // 등급은 가장 최근에 '받은' 등급 ('방문'만 한 해는 등급을 바꾸지 않음). 기록이 없으면 가볼곳
  const rated = h => h.filter(x => x.r !== 'visit');
  function withHistory(p, h) {
    const r = rated(h);
    const rating = r.length ? r[r.length - 1].r : h.length ? (p.rating === 'wish' ? 'bib' : p.rating) : 'wish';
    return { ...p, years: h.map(x => `${x.y}:${x.r}`).join(' '), rating };
  }
  const RATED = RATINGS.filter(r => r.key !== 'wish');
  const VISIT = { key: 'visit', label: '👣', short: '방문', desc: '방문만 기록 · 등급은 그대로' };
  const yearRating = k => k === 'visit' ? VISIT : ratingOf(k);
  const LL = (lat, lng) => new kakao.maps.LatLng(+lat, +lng);

  // ─────────────────────────── 저장 · 동기화 ───────────────────────────
  function persist() { store.set(KEY.places, state.places); }

  function applyOp(list, op) {
    if (op.action === 'delete') return list.filter(p => !op.ids.includes(p.id));
    const next = list.slice();
    for (const p of op.places) {
      const i = next.findIndex(x => x.id === p.id);
      if (i >= 0) next[i] = { ...p }; else next.push({ ...p });
    }
    return next;
  }

  function commit(op) {
    if (!canEdit()) return toast('보기 전용으로 연결돼 있어요');
    state.places = applyOp(state.places, op);
    persist();
    renderAll();
    if (!cfg.apiUrl) return;
    state.pending.push(op);
    store.set(KEY.pending, state.pending);
    flush();
  }

  function savePlaces(list) {
    const now = new Date().toISOString();
    list.forEach(p => { p.updatedAt = now; if (!p.createdAt) p.createdAt = now; });
    commit({ action: 'upsert', places: list });
  }
  const savePlace = p => savePlaces([p]);
  const deletePlace = id => commit({ action: 'delete', ids: [id] });

  async function api(payload, version) {
    if (!payload) {
      const v = version ? `&v=${encodeURIComponent(version)}` : '';
      const r = await fetch(`${cfg.apiUrl}?token=${encodeURIComponent(cfg.token)}${v}&t=${Date.now()}`);
      return r.json();
    }
    // text/plain 본문이라 CORS 사전요청 없이 Apps Script로 바로 간다
    const r = await fetch(cfg.apiUrl, { method: 'POST', body: JSON.stringify({ ...payload, token: cfg.token }) });
    return r.json();
  }

  function setSync(s, title) {
    const dot = $('#syncDot');
    dot.className = 'sync-dot ' + s;
    dot.title = title || { ok: '시트와 동기화됨', busy: '저장 중…', error: '동기화 실패 — 다시 시도 예정', '': '로컬 모드 (이 기기에만 저장)' }[s] || '';
  }

  let flushing = false;
  let writeSeq = 0; // 쓰기가 성공할 때마다 증가 — 그 사이에 받아 온 옛 목록을 버리기 위함
  async function flush() {
    if (flushing || !cfg.apiUrl) return;
    flushing = true;
    setSync('busy');
    try {
      while (state.pending.length) {
        const res = await api(state.pending[0]);
        if (!res || !res.ok) throw new Error(res && res.error || '응답 없음');
        state.pending.shift();
        store.set(KEY.pending, state.pending);
        writeSeq++;
      }
      setSync('ok');
    } catch (e) {
      setSync('error', '동기화 실패: ' + e.message);
      if (/unauthorized/.test(e.message)) toast('시트 토큰이 맞지 않아요. 설정을 확인해 주세요');
    } finally {
      flushing = false;
    }
  }

  // quiet: 주기적 확인용 — 시트 버전이 같으면 목록을 받지 않고, 실패해도 알림을 띄우지 않는다
  let pulling = false;
  async function pull({ quiet = false } = {}) {
    if (!cfg.apiUrl) { setSync(''); return; }
    if (pulling || (quiet && flushing)) return;
    pulling = true;
    const seq = writeSeq;
    if (!quiet) setSync('busy', '불러오는 중…');
    try {
      const res = await api(null, quiet ? store.get(KEY.version, '') : '');
      if (!res.ok) throw new Error(res.error);
      if (res.unchanged) { applyRole(res); if (!state.pending.length) setSync('ok'); return; }
      if (flushing || seq !== writeSeq) return; // 받는 사이 내 변경이 저장됨 → 다음 확인 때 다시 받음
      // 시트가 비어 있고 이 기기에 데이터가 있으면 올릴지 묻는다 (로컬 모드 → 시트 전환)
      applyRole(res);
      if (!quiet && canEdit() && !res.places.length && state.places.length && !state.pending.length) {
        if (confirm(`시트가 비어 있어요. 이 기기에 있는 ${state.places.length}곳을 시트에 올릴까요?`)) {
          state.pending.push({ action: 'upsert', places: state.places });
          store.set(KEY.pending, state.pending);
          return flush();
        }
      }
      store.set(KEY.version, res.version || '');
      applyRole(res);
      const hadPins = state.places.some(hasPos);
      let list = res.places;
      for (const op of state.pending) list = applyOp(list, op); // 아직 못 보낸 변경 유지
      state.places = list;
      persist();
      renderAll();
      if (map && !hadPins) fitAll();
      refreshOpenSheet();
      await flush();
      setSync(state.pending.length ? 'error' : 'ok');
    } catch (e) {
      setSync('error', '불러오기 실패: ' + e.message);
      if (!quiet) toast(/unauthorized/.test(e.message) ? '시트 토큰이 맞지 않아요' : '시트를 불러오지 못했어요. 저장된 데이터로 보여드릴게요');
    } finally {
      pulling = false;
    }
  }

  function applyRole(res) {
    if (!res.role) return;
    const changed = res.role !== cfg.role || (res.viewToken || '') !== cfg.viewToken;
    cfg.role = res.role;
    cfg.viewToken = res.viewToken || '';
    if (!changed) return;
    store.set(KEY.cfg, cfg);
    document.body.classList.toggle('readonly', !canEdit());
    if (!canEdit()) { state.pending = []; store.set(KEY.pending, []); }
  }

  // 다른 기기의 변경을 받아 왔을 때 열려 있는 상세/목록을 새로 그린다 (편집 중인 폼은 건드리지 않음)
  function refreshOpenSheet() {
    const sh = $('#sheet');
    if (sh.hidden) return;
    if (sh.dataset.kind === 'detail') {
      const p = state.selected && byId(state.selected);
      if (p) showDetail(p); else { closeSheet(); toast('다른 기기에서 삭제된 곳이에요'); }
    } else if (sh.dataset.kind === 'list') showList();
  }

  const POLL_MS = 20000;
  function startLiveSync() {
    setInterval(() => { if (!document.hidden) pull({ quiet: true }); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pull({ quiet: true }); });
    window.addEventListener('online', () => { flush(); pull({ quiet: true }); });
  }

  // ─────────────────────────── 카카오 지도 ───────────────────────────
  function loadKakao(key) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services,clusterer&autoload=false`;
      const timer = setTimeout(() => reject(new Error('timeout')), 10000);
      s.onload = () => {
        if (!window.kakao || !kakao.maps) { clearTimeout(timer); return reject(new Error('sdk')); }
        kakao.maps.load(() => { clearTimeout(timer); resolve(); });
      };
      s.onerror = () => { clearTimeout(timer); reject(new Error('network')); };
      document.head.appendChild(s);
    });
  }

  function initMap() {
    const v = store.get(KEY.view, null);
    map = new kakao.maps.Map($('#map'), { center: v ? LL(v.lat, v.lng) : LL(36.3504, 127.3845), level: v ? v.level : 9 });
    clusterer = new kakao.maps.MarkerClusterer({
      map, averageCenter: true, minLevel: 9, gridSize: 48, calculator: [10, 30],
      styles: [34, 42, 50].map(sz => ({
        width: sz + 'px', height: sz + 'px', lineHeight: sz + 'px', borderRadius: '50%', textAlign: 'center',
        background: 'rgba(179,0,27,.88)', color: '#fff', fontWeight: '700', fontSize: '13px', border: '2px solid #fff',
        boxShadow: '0 2px 6px rgba(0,0,0,.3)',
      })),
    });
    placesSvc = new kakao.maps.services.Places();
    geocoder = new kakao.maps.services.Geocoder();

    kakao.maps.event.addListener(map, 'click', e => mapClicked(e.latLng.getLat(), e.latLng.getLng()));
    kakao.maps.event.addListener(map, 'idle', () => {
      const c = map.getCenter();
      store.set(KEY.view, { lat: c.getLat(), lng: c.getLng(), level: map.getLevel() });
    });
    kakao.maps.event.addListener(map, 'zoom_changed', updateLabels);

    renderAll();
    if (!v) fitAll();
    updateLabels();
  }

  function mapClicked(lat, lng) {
    if (state.pick) { const cb = state.pick.cb; endPick(); cb(lat, lng); }
    else if (!$('#sheet').hidden && $('#sheet').dataset.kind !== 'form') closeSheet();
  }

  function updateLabels() { $('#map').classList.toggle('show-labels', map.getLevel() <= 5); }

  function fitAll() {
    const pts = state.places.filter(p => hasPos(p) && !isOverseas(p.region));
    if (!pts.length) return;
    const b = new kakao.maps.LatLngBounds();
    pts.forEach(p => b.extend(LL(p.lat, p.lng)));
    map.setBounds(b, 80, 40, 120, 40);
  }

  function pinEl(p, extra = '') {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `pin r-${p.rating}${p.closed ? ' closed' : ''}${p.approx ? ' approx' : ''} ${extra}`;
    el.innerHTML = `<div class="bubble"><span>${categoryOf(p.category).emoji}</span></div><div class="label">${esc(p.name || '새 맛집')}</div>`;
    return el;
  }

  const zOf = p => 10 - (RATING_ORDER[p.rating] ?? 5) - (p.closed ? 5 : 0);

  function renderMarkers() {
    if (!map) return;
    clusterer.clear();
    overlays.clear();
    const ovs = [];
    for (const p of state.places) {
      if (!hasPos(p) || !matches(p) || isOverseas(p.region)) continue;
      const el = pinEl(p, p.id === state.selected ? 'sel' : '');
      el.addEventListener('click', e => { e.stopPropagation(); if (!state.pick) select(p.id); });
      const ov = new kakao.maps.CustomOverlay({ position: LL(p.lat, p.lng), content: el, yAnchor: 1, clickable: true, zIndex: p.id === state.selected ? 100 : zOf(p) });
      overlays.set(p.id, { ov, el, p });
      ovs.push(ov);
    }
    clusterer.addMarkers(ovs);
  }

  function highlight(id) {
    overlays.forEach(({ ov, el, p }, k) => { el.classList.toggle('sel', k === id); ov.setZIndex(k === id ? 100 : zOf(p)); });
    if (W) W.highlight(id);
  }

  function showDraftPin(d) {
    clearDraft();
    if (!hasPos(d)) return;
    if (isOverseas(d.region) || state.world) {
      if (W) W.draft(d);
      return;
    }
    draftOverlay = new kakao.maps.CustomOverlay({ position: LL(d.lat, d.lng), content: pinEl(d, 'draft sel'), yAnchor: 1, zIndex: 200 });
    draftOverlay.setMap(map);
  }
  function clearDraft() {
    if (draftOverlay) { draftOverlay.setMap(null); draftOverlay = null; }
    if (W) W.clearDraft();
  }

  function focusOn(p) {
    if (!hasPos(p)) return;
    if (isOverseas(p.region)) return setWorld(true, { fit: false }).then(() => focusWorld(p));
    if (state.world) setWorld(false);
    if (!map) return;
    if (map.getLevel() > 5) map.setLevel(isOverseas(p.region) && p.approx ? 8 : 4);
    // 바텀시트에 가리지 않도록 살짝 아래쪽을 중심으로
    const proj = map.getProjection();
    const pt = proj.containerPointFromCoords(LL(p.lat, p.lng));
    const wide = window.innerWidth >= 820;
    const shifted = new kakao.maps.Point(pt.x - (wide ? 190 : 0), pt.y + (wide ? 0 : Math.round(window.innerHeight * 0.22)));
    map.panTo(proj.coordsFromContainerPoint(shifted));
  }

  // 좌표 → { region: '대전', area: '봉명동', address }
  function describeCoord(lat, lng) {
    if (state.world && W) return W.describe(lat, lng);
    const region = new Promise(res => geocoder.coord2RegionCode(lng, lat, (r, st) => {
      if (st !== kakao.maps.services.Status.OK) return res({});
      const b = r.find(x => x.region_type === 'B') || r[0];
      res({ region: shortRegion(b.region_1depth_name, b.region_2depth_name), area: b.region_3depth_name || b.region_2depth_name });
    }));
    const addr = new Promise(res => geocoder.coord2Address(lng, lat, (r, st) => {
      if (st !== kakao.maps.services.Status.OK || !r[0]) return res('');
      res((r[0].road_address && r[0].road_address.address_name) || r[0].address.address_name);
    }));
    return Promise.all([region, addr]).then(([r, address]) => ({ region: r.region || '', area: r.area || '', address }));
  }

  function shortRegion(r1 = '', r2 = '') {
    if (/(특별시|광역시|특별자치시)$/.test(r1)) return r1.replace(/(특별시|광역시|특별자치시)$/, '');
    const city = r2.split(' ')[0].replace(/(시|군)$/, '');
    return city || r1;
  }

  function keywordSearch(q, opts = {}) {
    return new Promise(res => placesSvc.keywordSearch(q, (data, st) => res(st === kakao.maps.services.Status.OK ? data : []), opts));
  }

  // ─────────────────────────── 해외 지도 ───────────────────────────
  // 카카오맵은 해외를 그리지 않는다. 해외 맛집은 config.js에 구글 키가 있으면 구글맵,
  // 없으면 OpenStreetMap(Leaflet + Photon 검색)으로 보여 준다. 두 엔진은 같은 메서드를 가진다.
  const COUNTRY_KO = { US: '미국', JP: '일본', VN: '베트남', CN: '중국', TW: '대만', TH: '태국', HK: '홍콩', SG: '싱가포르', PH: '필리핀', FR: '프랑스', IT: '이탈리아', ES: '스페인', GB: '영국', DE: '독일', AU: '호주', CA: '캐나다' };
  const GOOGLE_KEY = (window.APP_CONFIG || {}).googleKey || '';
  const isFoodType = t => /restaurant|food|cafe|bar|pub|bakery|meal|biergarten|ice_cream/.test(t || '');
  const panOffset = () => {
    const wide = window.innerWidth >= 820;
    return { x: wide ? -190 : 0, y: wide ? 0 : Math.round(window.innerHeight * 0.22) };
  };

  function loadAsset(tag, attrs) {
    return new Promise((resolve, reject) => {
      const el = document.createElement(tag);
      Object.assign(el, attrs);
      el.onload = resolve;
      el.onerror = () => reject(new Error('load ' + (attrs.src || attrs.href)));
      document.head.appendChild(el);
    });
  }

  function osmEngine() {
    let m, cluster, draft, me;
    const markers = new Map();
    const icon = (p, extra = '') => L.divIcon({ html: pinEl(p, extra).outerHTML, className: 'wpin', iconSize: [34, 36], iconAnchor: [17, 36] });
    return {
      name: 'osm',
      async load() {
        const css = href => loadAsset('link', { rel: 'stylesheet', href });
        await Promise.all([
          css('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'),
          css('https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css'),
          loadAsset('script', { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js' }),
        ]);
        await loadAsset('script', { src: 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js' });
      },
      init(el) {
        m = L.map(el, { zoomControl: false, attributionControl: false, worldCopyJump: true, minZoom: 2 }).setView([30, 140], 3);
        L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(m);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(m);
        cluster = L.markerClusterGroup({
          showCoverageOnHover: false, maxClusterRadius: 40, spiderfyOnMaxZoom: true, disableClusteringAtZoom: 12,
          iconCreateFunction: c => L.divIcon({ html: `<div class="wcluster">${c.getChildCount()}</div>`, className: '', iconSize: [38, 38] }),
        });
        m.addLayer(cluster);
        m.on('click', e => mapClicked(e.latlng.lat, e.latlng.lng));
        m.on('zoomend', () => el.classList.toggle('show-labels', m.getZoom() >= 15));
      },
      resize() { m.invalidateSize(); },
      render(list) {
        cluster.clearLayers();
        markers.clear();
        cluster.addLayers(list.map(p => {
          const mk = L.marker([+p.lat, +p.lng], { icon: icon(p, p.id === state.selected ? 'sel' : ''), zIndexOffset: p.id === state.selected ? 1000 : zOf(p) });
          mk.on('click', () => { if (!state.pick) select(p.id); });
          markers.set(p.id, { mk, p });
          return mk;
        }));
      },
      highlight(id) { markers.forEach(({ mk, p }, k) => { mk.setIcon(icon(p, k === id ? 'sel' : '')); mk.setZIndexOffset(k === id ? 1000 : zOf(p)); }); },
      draft(d) { draft = L.marker([+d.lat, +d.lng], { icon: icon(d, 'draft sel'), interactive: false, zIndexOffset: 2000 }).addTo(m); },
      clearDraft() { if (draft) { draft.remove(); draft = null; } },
      focus(p, minZoom) {
        const z = Math.max(m.getZoom(), minZoom), o = panOffset();
        m.setView(m.unproject(m.project([+p.lat, +p.lng], z).add(L.point(o.x, o.y)), z), z);
      },
      fit(pts) { m.fitBounds(L.latLngBounds(pts.map(p => [+p.lat, +p.lng])), { padding: [70, 50], maxZoom: 14 }); },
      me(pos, pan) {
        const at = [pos.lat, pos.lng];
        if (!me) me = L.marker(at, { icon: L.divIcon({ html: '<div class="me"></div>', className: 'wpin', iconSize: [22, 22] }), interactive: false, zIndexOffset: 3000 }).addTo(m);
        else me.setLatLng(at);
        if (pan) m.setView(at, 15);
      },
      center() { const c = m.getCenter(); return { lat: c.lat, lng: c.lng }; },
      async search(q, near) { return tag(await photonSearch(q, near || this.center()), 'OpenStreetMap'); },
      async describe(lat, lng) {
        try {
          const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`);
          const f = ((await r.json()).features || [])[0];
          if (!f) return { region: '', area: '', address: '' };
          const x = fromPhoton(f);
          return { region: x.country, area: x.city, address: x.address };
        } catch { return { region: '', area: '', address: '' }; }
      },
    };
  }

  async function photonSearch(q, c) {
    try {
      const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=10${c ? `&lat=${c.lat}&lon=${c.lng}` : ''}`);
      return ((await r.json()).features || []).map(fromPhoton).filter(x => x.name);
    } catch { return []; }
  }

  function fromPhoton(f) {
    const pr = f.properties, [lng, lat] = f.geometry.coordinates;
    const street = [pr.housenumber, pr.street].filter(Boolean).join(' ');
    return {
      id: `osm:${pr.osm_type}${pr.osm_id}`, name: pr.name || street || pr.city || '', lat, lng,
      address: [street, pr.city || pr.county, pr.state, pr.country].filter(Boolean).join(', '),
      sub: [pr.osm_value, pr.city || pr.state, pr.country].filter(Boolean).join(' · '),
      cat: `${pr.osm_value || ''} ${pr.name || ''}`, country: COUNTRY_KO[pr.countrycode] || pr.country || '', city: pr.city || pr.county || pr.state || '',
      food: isFoodType(pr.osm_value),
    };
  }

  function googleEngine(key) {
    let gm, clusterer, draft, me;
    const markers = new Map();
    const marker = (p, extra, opts = {}) => {
      const el = pinEl(p, extra);
      const mk = new google.maps.marker.AdvancedMarkerElement({ position: { lat: +p.lat, lng: +p.lng }, content: el, ...opts });
      return { mk, el };
    };
    const clusterEl = n => { const el = document.createElement('div'); el.className = 'wcluster'; el.textContent = n; return el; };
    const comp = (list, type, field) => { const c = (list || []).find(x => x.types.includes(type)); return c ? c[field] : ''; };
    return {
      name: 'google',
      async load() {
        await new Promise((resolve, reject) => {
          window.__gmReady = resolve;
          window.gm_authFailure = () => reject(new Error('google auth'));
          loadAsset('script', { src: `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__gmReady` }).catch(reject);
        });
        await Promise.all(['maps', 'marker'].map(l => google.maps.importLibrary(l)));
        await loadAsset('script', { src: 'https://unpkg.com/@googlemaps/markerclusterer@2.5.3/dist/index.min.js' });
      },
      init(el) {
        gm = new google.maps.Map(el, { center: { lat: 30, lng: 140 }, zoom: 3, minZoom: 1, mapId: 'DEMO_MAP_ID', disableDefaultUI: true, clickableIcons: false, gestureHandling: 'greedy' });
        gm.addListener('click', e => mapClicked(e.latLng.lat(), e.latLng.lng()));
        gm.addListener('zoom_changed', () => el.classList.toggle('show-labels', gm.getZoom() >= 15));
        clusterer = new markerClusterer.MarkerClusterer({
          map: gm,
          algorithm: new markerClusterer.SuperClusterAlgorithm({ maxZoom: 11, radius: 60 }),
          renderer: { render: ({ count, position }) => new google.maps.marker.AdvancedMarkerElement({ position, content: clusterEl(count), zIndex: 1000 + count }) },
        });
      },
      resize() {},
      render(list) {
        clusterer.clearMarkers();
        markers.clear();
        clusterer.addMarkers(list.map(p => {
          const { mk, el } = marker(p, p.id === state.selected ? 'sel' : '', { zIndex: p.id === state.selected ? 1000 : zOf(p), gmpClickable: true });
          mk.addEventListener('gmp-click', () => { if (!state.pick) select(p.id); });
          markers.set(p.id, { mk, el, p });
          return mk;
        }));
      },
      highlight(id) { markers.forEach(({ mk, el, p }, k) => { el.classList.toggle('sel', k === id); mk.zIndex = k === id ? 1000 : zOf(p); }); },
      draft(d) { draft = marker(d, 'draft sel', { map: gm, zIndex: 2000 }).mk; },
      clearDraft() { if (draft) { draft.map = null; draft = null; } },
      focus(p, minZoom) {
        const o = panOffset();
        gm.setZoom(Math.max(gm.getZoom(), minZoom));
        gm.setCenter({ lat: +p.lat, lng: +p.lng });
        gm.panBy(o.x, o.y);
      },
      fit(pts) {
        const b = new google.maps.LatLngBounds();
        pts.forEach(p => b.extend({ lat: +p.lat, lng: +p.lng }));
        gm.fitBounds(b, 60);
        google.maps.event.addListenerOnce(gm, 'idle', () => { if (gm.getZoom() > 14) gm.setZoom(14); });
      },
      me(pos, pan) {
        if (!me) { const el = document.createElement('div'); el.className = 'me'; me = new google.maps.marker.AdvancedMarkerElement({ map: gm, position: pos, content: el, zIndex: 3000 }); }
        else me.position = pos;
        if (pan) { gm.setZoom(15); gm.setCenter(pos); }
      },
      center() { const c = gm.getCenter(); return { lat: c.lat(), lng: c.lng() }; },
      // 검색·주소 찾기는 Apps Script가 대신 구글에 묻는다 (검색 키는 브라우저에 없음).
      // 시트 미연동이거나 서버에 키가 없으면 OpenStreetMap 검색으로 대신한다
      // 실패하면 OpenStreetMap 결과로 대신하되, 왜 구글 검색이 안 됐는지 results.error에 남긴다
      async search(q, near) {
        const c = near || (gm ? this.center() : null);
        let error = '';
        if (!cfg.apiUrl) error = '구글 검색은 시트를 연동해야 쓸 수 있어요';
        else if (canEdit()) {
          try {
            const res = await api({ action: 'gsearch', q, lat: c ? c.lat : null, lng: c ? c.lng : null });
            if (res.ok) return tag(res.places.map(fromGooglePlace).filter(x => x.name), '구글');
            error = googleErrorHint(res.error);
          } catch (e) {
            error = 'Apps Script가 구글에 접속할 권한이 없어요. 편집기에서 setup을 한 번 더 실행해 권한을 허용하고, 새 버전으로 다시 배포해 주세요';
          }
          console.warn('google search:', error);
        }
        return tag(await photonSearch(q, c), 'OpenStreetMap', error);
      },
      async describe(lat, lng) {
        if (cfg.apiUrl && canEdit()) {
          try {
            const res = await api({ action: 'greverse', lat, lng });
            const r = res.ok && res.results[0];
            if (r) {
              const ac = r.address_components.map(x => ({ types: x.types, long: x.long_name, short: x.short_name }));
              return {
                region: COUNTRY_KO[comp(ac, 'country', 'short')] || comp(ac, 'country', 'long'),
                area: comp(ac, 'locality', 'long') || comp(ac, 'administrative_area_level_1', 'long'),
                address: r.formatted_address,
              };
            }
          } catch (e) { console.warn(e); }
        }
        return osmEngine().describe(lat, lng);
      },
    };
  }

  const tag = (list, source, error = '') => Object.assign(list, { source, error });

  function googleErrorHint(err = '') {
    if (err === 'unknown action') return 'Apps Script가 예전 버전이에요. 배포 → 배포 관리 → 수정 → 새 버전으로 다시 배포해 주세요';
    if (err === 'no google key') return 'Apps Script 스크립트 속성에 GOOGLE_KEY가 없어요';
    if (err === 'rate limit') return '검색이 너무 잦아요. 1분 뒤에 다시 해 주세요';
    if (/referer|referrer/i.test(err)) return 'GOOGLE_KEY에 웹사이트 제한이 걸린 키(지도 키)가 들어 있어요. 제한 없는 검색 키로 바꿔 주세요';
    if (/not been used|disabled|not enabled|SERVICE_DISABLED/i.test(err)) return '구글 콘솔에서 Places API (New)가 사용 설정되지 않았어요';
    if (/not authorized|blocked|API_KEY_SERVICE_BLOCKED|PERMISSION_DENIED/i.test(err)) return '검색 키의 API 제한에 Places API (New)가 빠져 있어요';
    if (/invalid|API_KEY_INVALID/i.test(err)) return 'GOOGLE_KEY 값이 올바르지 않아요. 다시 복사해 넣어 주세요';
    return '구글 검색 오류: ' + err;
  }

  // Places API(New) REST 결과 → 검색 목록 공통 형태
  function fromGooglePlace(pl) {
    const ac = (pl.addressComponents || []).map(x => ({ types: x.types, long: x.longText, short: x.shortText }));
    const pick = (type, field) => { const c = ac.find(x => x.types.includes(type)); return c ? c[field] : ''; };
    const types = (pl.types || []).join(' ');
    const typeName = pl.primaryTypeDisplayName ? pl.primaryTypeDisplayName.text : '';
    const name = pl.displayName ? pl.displayName.text : '';
    return {
      id: `g:${pl.id}`, name, lat: pl.location.latitude, lng: pl.location.longitude, address: pl.formattedAddress || '',
      sub: [typeName, pl.formattedAddress].filter(Boolean).join(' · '),
      cat: `${types} ${typeName} ${name}`,
      country: COUNTRY_KO[pick('country', 'short')] || pick('country', 'long'),
      city: pick('locality', 'long') || pick('administrative_area_level_2', 'long') || pick('administrative_area_level_1', 'long'),
      food: isFoodType(types),
    };
  }

  // 구글 키가 있으면 구글맵, 키 문제로 실패하면 OpenStreetMap으로 대신 연다
  let W = null, worldLoading = null;
  function ensureWorld() {
    worldLoading = worldLoading || (async () => {
      // 구글 지도는 붙는 요소의 position을 덮어쓰므로 #wmap 안의 상자에 붙인다
      $('#wmap').hidden = false;
      $('#wmap').innerHTML = '<div class="engine"></div>';
      const el = $('#wmap .engine');
      if (GOOGLE_KEY) {
        try { const g = googleEngine(GOOGLE_KEY); await g.load(); g.init(el); return (W = g); }
        catch (e) { console.warn(e); toast('구글 지도를 불러오지 못해서 OpenStreetMap으로 보여 드려요', 4000); el.innerHTML = ''; el.removeAttribute('style'); }
      }
      const o = osmEngine();
      await o.load();
      o.init(el);
      return (W = o);
    })().catch(e => { worldLoading = null; throw e; });
    return worldLoading;
  }

  async function setWorld(on, { fit = true } = {}) {
    if (on && !W) {
      try { await ensureWorld(); } catch { toast('해외 지도를 불러오지 못했어요. 인터넷 연결을 확인해 주세요'); $('#wmap').hidden = true; return; }
    }
    const changed = state.world !== on;
    state.world = on;
    document.body.classList.toggle('world', on);
    $('#wmap').hidden = !on;
    if (on) {
      W.resize();
      renderWorldMarkers();
      if (fit && changed) fitWorld();
    }
    renderChips();
  }

  function renderWorldMarkers() {
    if (W) W.render(state.places.filter(p => hasPos(p) && matches(p) && isOverseas(p.region)));
  }

  function fitWorld(list) {
    const pts = (list || state.places.filter(p => matches(p) && isOverseas(p.region))).filter(hasPos);
    if (W && pts.length) W.fit(pts);
  }

  function focusWorld(p) { if (W) W.focus(p, p.approx === 'city' ? 12 : 16); }

  const worldSearch = (q, near) => ensureWorld().then(() => W.search(q, near), () => []);

  // ─────────────────────────── 필터 · 칩 ───────────────────────────
  function matches(p) {
    const f = state.filter;
    if (f.ratings.length && !f.ratings.includes(p.rating)) return false;
    if (f.category && p.category !== f.category) return false;
    if (f.province && provinceOf(p) !== f.province) return false;
    if (f.hideClosed && p.closed) return false;
    return true;
  }

  function countBy(fn) {
    const m = {};
    state.places.forEach(p => { const k = fn(p); m[k] = (m[k] || 0) + 1; });
    return m;
  }

  function renderChips() {
    const f = state.filter;
    const rc = countBy(p => p.rating), cc = countBy(p => p.category), gc = countBy(provinceOf);
    const regions = Object.keys(gc).sort((a, b) => (isOverseas(a) - isOverseas(b)) || gc[b] - gc[a]);
    if (f.province && !gc[f.province]) f.province = '';
    const abroad = state.places.filter(p => isOverseas(p.region)).length;
    $('#chips').innerHTML =
      (abroad || state.world ? `<button type="button" class="chip world${state.world ? ' on' : ''}" data-world>${state.world ? '🇰🇷 국내 지도로' : `🌏 해외 <small>${abroad}</small>`}</button>` : '') +
      RATINGS.map(r => `<button type="button" class="chip${f.ratings.includes(r.key) ? ' on' : ''}" data-rating="${r.key}">${r.label} ${r.key === 'bib' || r.key === 'wish' ? r.short : ''}<small>${rc[r.key] || 0}</small></button>`).join('') +
      `<select class="chip${f.category ? ' on' : ''}" data-f="category"><option value="">종류 전체</option>${CATEGORIES.filter(c => cc[c.key]).map(c => `<option value="${c.key}"${f.category === c.key ? ' selected' : ''}>${c.emoji} ${c.label} (${cc[c.key]})</option>`).join('')}</select>` +
      `<select class="chip${f.province ? ' on' : ''}" data-f="province"><option value="">지역 전체</option>${regions.map(r => `<option value="${esc(r)}"${f.province === r ? ' selected' : ''}>${esc(r)} (${gc[r]})</option>`).join('')}</select>` +
      `<button type="button" class="chip${f.hideClosed ? ' on' : ''}" data-closed>폐업 숨김</button>`;
  }

  function onChips(e) {
    const f = state.filter;
    if (e.type === 'click' && e.target.closest('[data-world]')) { closeSheet(); return setWorld(!state.world); }
    const b = e.target.closest('[data-rating],[data-closed]');
    if (e.type === 'click' && b) {
      if (b.dataset.rating) {
        const k = b.dataset.rating;
        f.ratings = f.ratings.includes(k) ? f.ratings.filter(x => x !== k) : [...f.ratings, k];
      } else f.hideClosed = !f.hideClosed;
    } else if (e.type === 'change' && e.target.dataset.f) {
      f[e.target.dataset.f] = e.target.value;
      if (e.target.dataset.f === 'province' && f.province) zoomToRegion(f.province);
    } else return;
    store.set(KEY.filter, f);
    renderAll();
    if ($('#sheet').dataset.kind === 'list' && !$('#sheet').hidden) showList();
  }

  function zoomToRegion(province) {
    const pts = state.places.filter(p => provinceOf(p) === province && hasPos(p));
    if (isOverseas(province)) return setWorld(true, { fit: false }).then(() => fitWorld(pts));
    if (state.world) setWorld(false);
    if (!pts.length || !map) return;
    const b = new kakao.maps.LatLngBounds();
    pts.forEach(p => b.extend(LL(p.lat, p.lng)));
    map.setBounds(b, 120, 40, 120, 40);
    if (map.getLevel() < 4) map.setLevel(4);
  }

  function renderAll() { renderChips(); renderMarkers(); renderWorldMarkers(); }

  // ─────────────────────────── 바텀시트 ───────────────────────────
  function openSheet(html, kind) {
    const sh = $('#sheet');
    $('#sheetBody').innerHTML = html;
    $('#sheetBody').scrollTop = 0;
    sh.dataset.kind = kind;
    sh.hidden = false;
    document.body.classList.add('sheet-open');
  }

  function closeSheet() {
    $('#sheet').hidden = true;
    $('#sheet').dataset.kind = '';
    document.body.classList.remove('sheet-open');
    state.selected = null;
    state.assignTo = null;
    highlight(null);
    clearDraft();
  }

  function select(id, { pan = true } = {}) {
    const p = byId(id);
    if (!p) return;
    state.selected = id;
    clearDraft();
    highlight(id);
    if (pan) focusOn(p);
    showDetail(p);
  }

  function linksFor(p) {
    if (isOverseas(p.region)) {
      const q = hasPos(p) && !p.approx ? `${p.name} ${p.address || ''}` : `${p.name} ${p.area}`;
      const pid = String(p.placeId || '').startsWith('g:') ? `&query_place_id=${encodeURIComponent(p.placeId.slice(2))}` : '';
      return `<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q.trim())}${pid}">구글 지도</a>`;
    }
    const view = p.placeId ? `https://place.map.kakao.com/${p.placeId}` : `https://map.kakao.com/link/search/${encodeURIComponent(`${p.area.split('/')[0]} ${p.name}`)}`;
    const route = hasPos(p) ? `<a class="btn" target="_blank" rel="noopener" href="https://map.kakao.com/link/to/${encodeURIComponent(p.name)},${p.lat},${p.lng}">길찾기</a>` : '';
    return `<a class="btn" target="_blank" rel="noopener" href="${view}">카카오맵</a>${route}`;
  }

  function showDetail(p) {
    const r = ratingOf(p.rating), c = categoryOf(p.category), h = history(p);
    const thisYear = h.find(x => x.y === THIS_YEAR);
    let trend = '';
    const hr = rated(h);
    if (hr.length >= 2) {
      const d = RATING_ORDER[hr[hr.length - 2].r] - RATING_ORDER[hr[hr.length - 1].r];
      trend = d > 0 ? ' <b class="up">⬆ 승급</b>' : d < 0 ? ' <b class="down">⬇ 강등</b>' : '';
    }
    let notice = '';
    if (!canEdit()) notice = '';
    else if (!hasPos(p)) notice = `<div class="notice"><span>📍 아직 지도 위치가 없어요</span><button class="btn small" data-act="find">이름으로 찾기</button><button class="btn small" data-act="move">지도에서 지정</button></div>`;
    else if (p.approx === 'auto') notice = `<div class="notice"><span>📍 자동으로 찾은 위치예요. 맞나요?</span><button class="btn small" data-act="confirm">맞아요</button><button class="btn small" data-act="find">다시 찾기</button></div>`;
    else if (p.approx === 'city') notice = `<div class="notice"><span>📍 도시 중심에 대략 표시돼 있어요</span><button class="btn small" data-act="find">이름으로 찾기</button><button class="btn small" data-act="move">지도에서 지정</button></div>`;

    openSheet(`
      <div class="detail">
        <div class="d-rating r-${p.rating}">${r.label}<span>${esc(r.desc)}</span>${trend}</div>
        <h2>${c.emoji} ${esc(p.name)} ${p.closed ? '<span class="badge">폐업</span>' : ''}</h2>
        ${p.menu ? `<p class="d-menu">${esc(p.menu)}</p>` : ''}
        <p class="d-meta">${esc(p.region)} ${esc(p.area)} · ${c.label}${p.address ? `<br>${esc(p.address)}` : ''}</p>
        ${h.length ? `<div class="d-years">${h.map(x => `<span class="r-${x.r}" title="${esc(yearRating(x.r).desc)}">'${x.y} ${yearRating(x.r).label}${x.r === 'visit' ? ' 방문' : ''}</span>`).join('')}</div>` : ''}
        ${p.memo ? `<p class="d-memo">${esc(p.memo)}</p>` : ''}
        ${notice}
        <div class="actions">
          ${canEdit() ? '<button class="btn primary" data-act="edit">편집</button>' : ''}
          ${canEdit() && !p.closed ? `<button class="btn" data-act="rate">'${THIS_YEAR} 평가 ${thisYear ? '바꾸기' : '남기기'}</button>` : ''}
          ${linksFor(p)}
        </div>
      </div>`, 'detail');

    $('#sheetBody').onclick = e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'edit') showForm({ ...p }, false);
      if (act === 'rate') showRate(p);
      if (act === 'confirm') { savePlace({ ...p, approx: '' }); select(p.id, { pan: false }); }
      if (act === 'find') startAssignSearch(p);
      if (act === 'move') {
        if (isOverseas(p.region) !== state.world) setWorld(isOverseas(p.region), { fit: false }).then(() => focusOn(p));
        startPick(`'${p.name}' 위치를 지도에서 탭하세요`, async (lat, lng) => {
          const info = await describeCoord(lat, lng);
          savePlace({ ...p, lat, lng, approx: '', address: info.address || p.address });
          select(p.id, { pan: false });
        }, () => select(p.id, { pan: false }));
      }
    };
  }

  // 올해 등급 고르기
  function showRate(p) {
    const h = history(p);
    const cur = (h.find(x => x.y === THIS_YEAR) || {}).r;
    const prev = rated(h.filter(x => x.y !== THIS_YEAR)).slice(-1)[0];
    openSheet(`
      <h3>${esc(p.name)} · '${THIS_YEAR} 평가</h3>
      <p class="d-meta">${prev ? `지난 등급: '${prev.y} ${ratingOf(prev.r).label} ${esc(ratingOf(prev.r).desc)}` : '처음 남기는 평가예요'}</p>
      <div class="rate-opts">${[...RATED, VISIT].map(o => `
        <button type="button" class="rate-opt r-${o.key}${cur === o.key ? ' on' : ''}" data-r="${o.key}"><b>${o.label}</b><span>${esc(o.desc)}</span></button>`).join('')}
      </div>
      <div class="form-actions">
        ${cur ? '<button type="button" class="btn danger" data-act="unrate">올해 기록 지우기</button>' : ''}
        <button type="button" class="btn primary" data-act="back">취소</button>
      </div>`, 'rate');
    $('#sheetBody').onclick = e => {
      const b = e.target.closest('[data-r]');
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (b) {
        const next = h.filter(x => x.y !== THIS_YEAR).concat({ y: THIS_YEAR, r: b.dataset.r }).sort((a, z) => a.y.localeCompare(z.y));
        savePlace(withHistory(p, next));
        toast(b.dataset.r === 'visit' ? `'${THIS_YEAR} 방문을 기록했어요` : `'${THIS_YEAR} ${ratingOf(b.dataset.r).label} 평가를 남겼어요`);
        return select(p.id, { pan: false });
      }
      if (act === 'unrate') { savePlace(withHistory(p, h.filter(x => x.y !== THIS_YEAR))); return select(p.id, { pan: false }); }
      if (act === 'back') select(p.id, { pan: false });
    };
  }

  // ─────────────────────────── 편집 폼 ───────────────────────────
  function showForm(d, isNew) {
    if (isNew) showDraftPin(d);
    const loc = hasPos(d) ? esc(d.address || (d.approx === 'city' ? `${d.area} (도시 위치)` : '좌표 지정됨')) : '위치 없음';
    openSheet(`
      <form class="form" id="placeForm">
        <h3>${isNew ? '맛집 추가' : '맛집 편집'}</h3>
        <label class="field"><span>가게 이름</span><input name="name" value="${esc(d.name)}" required placeholder="예) 담박집"></label>
        <div class="field"><span>연도별 등급 <small>· 그 해에 받은 등급, 지도에는 가장 최근 등급이 표시돼요. 👣 방문은 등급을 바꾸지 않아요</small></span>
          <div id="hist">${history(d).map(histRow).join('')}</div>
          <button type="button" class="btn small" data-act="addyear">+ 연도 추가</button>
          <p class="hint">하나도 없으면 🔖 가볼곳으로 저장돼요</p>
        </div>
        <label class="field"><span>대표 메뉴</span><input name="menu" value="${esc(d.menu)}" placeholder="예) 로스/히레카츠"></label>
        <div>
          <label class="field"><span>종류</span><select name="category">${CATEGORIES.map(c => `<option value="${c.key}"${d.category === c.key ? ' selected' : ''}>${c.emoji} ${c.label}</option>`).join('')}</select></label>
        </div>
        <div class="row2">
          <label class="field"><span>지역</span><input name="region" value="${esc(d.region)}" placeholder="대전"></label>
          <label class="field"><span>동네</span><input name="area" value="${esc(d.area)}" placeholder="봉명동"></label>
        </div>
        <div class="field"><span>위치</span><div class="loc"><span>${loc}</span><button type="button" class="btn small" data-act="move">지도에서 ${hasPos(d) ? '변경' : '지정'}</button></div></div>
        <label class="field"><span>메모</span><textarea name="memo" placeholder="웨이팅, 주차, 같이 간 사람, 다음에 먹어볼 메뉴…">${esc(d.memo)}</textarea></label>
        <label class="check"><input type="checkbox" name="closed"${d.closed ? ' checked' : ''}> 폐업했어요</label>
        <div class="form-actions">
          ${isNew ? '' : '<button type="button" class="btn danger" data-act="delete">삭제</button>'}
          <button type="button" class="btn" data-act="cancel">취소</button>
          <button type="submit" class="btn primary">저장</button>
        </div>
      </form>`, 'form');

    const form = $('#placeForm');
    const read = () => {
      const fd = new FormData(form);
      const h = {};
      form.querySelectorAll('.hrow').forEach(row => {
        const y = (row.querySelector('.hy').value.match(/\d{2}$/) || [])[0];
        if (y) h[y] = row.querySelector('.hr').value;
      });
      Object.assign(d, withHistory(d, Object.keys(h).sort().map(y => ({ y, r: h[y] }))), {
        name: fd.get('name').trim(), menu: fd.get('menu').trim(), category: fd.get('category'),
        region: fd.get('region').trim(), area: fd.get('area').trim(), memo: fd.get('memo').trim(), closed: fd.get('closed') === 'on',
      });
      return d;
    };
    // 메뉴를 입력하면 종류가 '기타'일 때 자동 추정
    form.menu.addEventListener('change', () => { if (form.category.value === 'etc') form.category.value = guessCategory(form.menu.value + ' ' + form.name.value); });

    form.onsubmit = e => {
      e.preventDefault();
      read();
      if (!d.name) return toast('가게 이름을 입력해 주세요');
      clearDraft();
      savePlace(d);
      select(d.id, { pan: isNew });
      toast(isNew ? '추가했어요' : '저장했어요');
    };
    form.onclick = e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'addyear') {
        const ys = [...form.querySelectorAll('.hy')].map(i => i.value);
        const last = form.querySelector('.hrow:last-child .hr');
        let y = +THIS_YEAR;
        while (ys.includes(String(y).padStart(2, '0')) && y > 0) y--;
        $('#hist').insertAdjacentHTML('beforeend', histRow({ y: String(y).padStart(2, '0'), r: last ? last.value : 'bib' }));
      }
      if (act === 'delyear') e.target.closest('.hrow').remove();
      if (act === 'cancel') { clearDraft(); isNew ? closeSheet() : select(d.id, { pan: false }); }
      if (act === 'delete' && confirm(`'${d.name}'을(를) 삭제할까요?`)) { deletePlace(d.id); closeSheet(); toast('삭제했어요'); }
      if (act === 'move') {
        read();
        startPick('새 위치를 지도에서 탭하세요', async (lat, lng) => {
          const info = await describeCoord(lat, lng);
          Object.assign(d, { lat, lng, approx: '', address: info.address || d.address });
          if (!d.region) d.region = info.region;
          if (!d.area) d.area = info.area;
          showDraftPin(d);
          showForm(d, isNew);
        }, () => showForm(d, isNew));
      }
    };
  }

  const histRow = x => `<div class="hrow"><span>'</span><input class="hy" value="${esc(x.y)}" inputmode="numeric" maxlength="2" aria-label="연도">
    <select class="hr" aria-label="등급">${[...RATED, VISIT].map(o => `<option value="${o.key}"${x.r === o.key ? ' selected' : ''}>${o.label} ${o.short}</option>`).join('')}</select>
    <button type="button" class="icon-btn" data-act="delyear" aria-label="이 연도 삭제">✕</button></div>`;

  // ─────────────────────────── 지도 탭으로 위치 고르기 ───────────────────────────
  function startPick(msg, cb, onCancel) {
    state.pick = { cb, onCancel };
    $('#bannerText').textContent = msg;
    $('#banner').hidden = false;
    $('#sheet').hidden = true;
    document.body.classList.remove('sheet-open');
    document.body.classList.add('picking');
  }
  function endPick() {
    state.pick = null;
    $('#banner').hidden = true;
    document.body.classList.remove('picking');
  }

  // ＋ 버튼: 검색창이 바로 열리고 입력하는 대로 장소를 찾는다. 못 찾으면 지도에서 직접 찍기
  function startAdd() {
    closeSheet();
    const world = state.world;
    const idle = `<p class="hint">${world ? '해외 가게 이름을 입력하세요 (영어·현지어도 돼요)' : '가게 이름을 입력하세요. 동네 이름을 붙이면 더 정확해요 (예: 효자동 담박집)'}</p>`;
    openSheet(`
      <h3>${world ? '🌏 해외 ' : ''}맛집 추가</h3>
      <form id="addForm" class="addbar" autocomplete="off"><input id="addQ" type="search" placeholder="가게 이름" enterkeyhint="search"></form>
      <div id="addResults">${idle}</div>
      <button type="button" class="btn pick-btn" data-act="pick">📍 검색 말고 지도에서 직접 찍기</button>`, 'add');
    const input = $('#addQ');
    input.focus();
    let timer, seq = 0, results = [];
    const run = async () => {
      const q = input.value.trim(), my = ++seq;
      if (q.length < 2) { $('#addResults').innerHTML = idle; return; }
      $('#addResults').innerHTML = '<p class="hint">찾는 중…</p>';
      const res = await searchPlaces(q, { world });
      if (my !== seq) return; // 더 최근 입력의 결과가 우선
      results = res;
      $('#addResults').innerHTML = placeResultsHtml(res, { world });
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, world ? 500 : 300); });
    $('#addForm').onsubmit = e => { e.preventDefault(); clearTimeout(timer); input.blur(); run(); };
    $('#sheetBody').onclick = e => {
      if (e.target.closest('[data-act=pick]')) return startPickAdd();
      const li = e.target.closest('li[data-i]');
      if (li) useResult(results[+li.dataset.i], { world });
    };
  }

  function startPickAdd() {
    closeSheet();
    startPick(`추가할 가게 위치를 ${state.world ? '해외 ' : ''}지도에서 탭하세요`, async (lat, lng) => {
      const info = await describeCoord(lat, lng);
      showForm(blank({ lat, lng, ...info }), true);
    }, startAdd);
  }

  const blank = extra => ({ id: newId(), name: '', rating: 'bib', category: 'etc', region: '', area: '', menu: '', years: `${THIS_YEAR}:bib`, closed: false, lat: null, lng: null, address: '', placeId: '', approx: '', memo: '', ...extra });

  // ─────────────────────────── 검색 ───────────────────────────
  function localMatches(q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return state.places.filter(p => {
      const hay = `${p.name} ${p.menu} ${p.region} ${p.area} ${p.memo} ${categoryOf(p.category).label}`.toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }

  function itemHtml(p, i) {
    const r = ratingOf(p.rating);
    const dist = state.myPos && hasPos(p) ? ` · ${fmtDist(distKm(state.myPos, p))}` : '';
    return `<li data-id="${p.id}" class="${p.closed ? 'closed' : ''}"><div class="em">${categoryOf(p.category).emoji}</div>
      <div class="tx"><div class="nm">${esc(p.name)}${!hasPos(p) ? ' <small>📍?</small>' : ''}</div><div class="sb">${esc(p.region)} ${esc(p.area)} · ${esc(p.menu)}${dist}</div></div>
      <div class="rt">${r.label}</div></li>`;
  }

  const fromKakao = r => ({
    id: r.id, name: r.place_name, lat: +r.y, lng: +r.x, address: r.road_address_name || r.address_name,
    sub: `${r.category_name.split(' > ').slice(1).join(' › ') || r.category_group_name} · ${r.road_address_name || r.address_name}`,
    cat: `${r.category_name} ${r.place_name}`,
  });

  // 장소 검색: 국내는 카카오, 해외는 구글/OpenStreetMap. 결과는 { id, name, lat, lng, address, sub, cat, country, city }
  async function searchPlaces(q, { world, near } = {}) {
    if (world) return worldSearch(q, near);
    if (!map) return [];
    return (await keywordSearch(q, { location: map.getCenter() })).map(fromKakao);
  }

  function placeResultsHtml(results, { world, assign }) {
    const saved = new Map(state.places.filter(p => p.placeId).map(p => [p.placeId, p]));
    const source = world ? `해외 장소 (${results.source || 'OpenStreetMap'})` : '카카오맵 장소';
    const warn = results.error ? `<div class="notice"><span>⚠️ 구글 검색이 안 돼서 OpenStreetMap으로 찾았어요.<br>${esc(results.error)}</span></div>` : '';
    const hint = world ? '영어나 현지어 이름으로도 검색해 보세요. 못 찾으면 지도에서 직접 찍으면 돼요' : '동네 이름을 붙여 보세요 (예: "효자동 담박집")';
    return warn + `<p class="sec-title">${source} ${results.length}</p>` + (results.length
      ? `<ul class="items">${results.map((r, i) => `
        <li data-i="${i}"><div class="em">${saved.has(r.id) ? '✅' : '📍'}</div>
          <div class="tx"><div class="nm">${esc(r.name)}</div><div class="sb">${esc(r.sub)}</div></div>
          <div class="rt">${saved.has(r.id) ? '저장됨' : (assign ? '선택' : '추가')}</div></li>`).join('')}</ul>`
      : `<p class="empty">결과가 없어요. ${hint}</p>`);
  }

  // 검색 결과 하나를 골랐을 때: 위치 지정 중이면 그 맛집에 좌표를, 아니면 새 맛집 등록 화면을 연다
  async function useResult(r, { world, assign }) {
    if (assign) {
      state.assignTo = null;
      savePlace({ ...assign, lat: r.lat, lng: r.lng, address: r.address, placeId: r.id, approx: '' });
      return select(assign.id);
    }
    const saved = state.places.find(p => p.placeId === r.id);
    if (saved) return select(saved.id);
    const info = world ? { region: r.country, area: r.city } : await describeCoord(r.lat, r.lng);
    const d = blank({ name: r.name, category: guessCategory(r.cat), region: info.region, area: info.area, address: r.address, placeId: r.id, lat: r.lat, lng: r.lng });
    if (!world) map.setLevel(4);
    focusOn(d);
    showForm(d, true);
  }

  async function doSearch(q) {
    q = q.trim();
    if (!q) return;
    endPick();
    $('#q').blur();
    const assign = state.assignTo && byId(state.assignTo);
    const world = assign ? isOverseas(assign.region) : state.world;
    const mine = assign ? [] : localMatches(q);
    let results = [];
    if (canEdit()) {
      const c = assign && cityCoord(assign.area);
      results = await searchPlaces(q, { world, near: c ? { lat: c[0], lng: c[1] } : null });
    }
    openSheet(`
      ${assign ? `<h3>'${esc(assign.name)}' 위치 고르기</h3>` : `<h3>'${esc(q)}' 검색</h3>`}
      ${mine.length ? `<p class="sec-title">내 맛집 ${mine.length}</p><ul class="items">${mine.map(itemHtml).join('')}</ul>` : ''}
      ${canEdit() ? placeResultsHtml(results, { world, assign }) : (mine.length ? '' : '<p class="empty">찾는 맛집이 없어요</p>')}`, 'search');

    $('#sheetBody').onclick = e => {
      const li = e.target.closest('li');
      if (!li) return;
      if (li.dataset.id) return select(li.dataset.id);
      useResult(results[+li.dataset.i], { world, assign });
    };
  }

  function startAssignSearch(p) {
    state.assignTo = p.id;
    // 해외는 '가게 이름 + 도시'(예: 食処 やま利 후쿠오카)로 찾는다
    const q = isOverseas(p.region) ? `${p.name} ${p.area.split(/\s+/).pop()}`.trim() : `${p.area.split('/')[0]} ${p.name}`.trim();
    $('#q').value = q;
    doSearch(q);
  }

  // ─────────────────────────── 목록 ───────────────────────────
  const distKm = (a, b) => {
    const R = 6371, rad = x => x * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const fmtDist = km => km < 1 ? `${Math.round(km * 1000)}m` : km < 100 ? `${km.toFixed(1)}km` : `${Math.round(km)}km`;

  function showList() {
    const list = state.places.filter(matches);
    const s = state.sort;
    const lastYear = p => years(p).slice(-1)[0] || '00';
    list.sort((a, b) => {
      if (s === 'dist' && state.myPos) return (hasPos(a) ? distKm(state.myPos, a) : 1e9) - (hasPos(b) ? distKm(state.myPos, b) : 1e9);
      if (s === 'recent') return lastYear(b).localeCompare(lastYear(a)) || (RATING_ORDER[a.rating] - RATING_ORDER[b.rating]);
      return (a.closed - b.closed) || (RATING_ORDER[a.rating] - RATING_ORDER[b.rating]) || a.region.localeCompare(b.region) || a.name.localeCompare(b.name);
    });
    const noPos = state.places.filter(needsLocate).length;
    openSheet(`
      <div class="list-head"><h3>내 맛집 ${list.length}곳</h3>
        <div class="sorts">${[['rating', '등급순'], ['recent', '최근 방문'], ['dist', '가까운 순']].map(([k, l]) => `<button data-sort="${k}" class="${s === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      ${noPos && canEdit() ? `<div class="notice"><span>📍 정확한 위치가 없는 곳이 ${noPos}곳 있어요</span><button class="btn small" data-act="autolocate">자동으로 찾기</button></div>` : ''}
      ${list.length ? `<ul class="items">${list.map(itemHtml).join('')}</ul>` : `<p class="empty">조건에 맞는 맛집이 없어요</p>`}`, 'list');

    $('#sheetBody').onclick = e => {
      const sb = e.target.closest('[data-sort]');
      if (sb) {
        state.sort = sb.dataset.sort;
        store.set(KEY.sort, state.sort);
        if (state.sort === 'dist' && !state.myPos) return locate(showList);
        return showList();
      }
      if (e.target.closest('[data-act=autolocate]')) return autoLocate();
      const li = e.target.closest('li[data-id]');
      if (li) select(li.dataset.id);
    };
  }

  // ─────────────────────────── 내 위치 ───────────────────────────
  function locate(then) {
    if (!navigator.geolocation) return toast('이 브라우저는 위치를 지원하지 않아요');
    navigator.geolocation.getCurrentPosition(pos => {
      state.myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (state.world && W) {
        W.me(state.myPos, typeof then !== 'function');
        if (typeof then === 'function') then();
        return;
      }
      const ll = LL(state.myPos.lat, state.myPos.lng);
      if (!meOverlay) {
        const el = document.createElement('div');
        el.className = 'me';
        meOverlay = new kakao.maps.CustomOverlay({ position: ll, content: el, zIndex: 300 });
        meOverlay.setMap(map);
      } else meOverlay.setPosition(ll);
      if (typeof then === 'function') then();
      else { map.setLevel(6); map.panTo(ll); }
    }, () => toast('위치 권한을 허용해 주세요 (https 주소에서만 동작해요)'), { enableHighAccuracy: true, timeout: 10000 });
  }

  // ─────────────────────────── 위치 자동 찾기 ───────────────────────────
  // 국내는 위치가 없는 곳, 해외는 위치가 없거나 도시 중심에 대략 찍힌 곳
  const needsLocate = p => isOverseas(p.region) ? (!hasPos(p) || p.approx === 'city') : !hasPos(p);
  async function autoLocate() {
    const todo = state.places.filter(needsLocate);
    if (!todo.length) return toast('위치를 찾을 곳이 없어요');
    if (!map) return toast('지도가 준비되지 않았어요');
    const found = [], failed = [];
    let searchError = '';
    for (let i = 0; i < todo.length; i++) {
      const p = todo[i];
      toast(`위치 찾는 중… ${i + 1}/${todo.length}`, 60000);
      if (isOverseas(p.region)) {
        // 도시 중심에서 50km 안의 결과만 인정 (같은 이름의 엉뚱한 곳 방지)
        const c = cityCoord(p.area) || [+p.lat, +p.lng];
        const all = await worldSearch(`${p.name} ${p.area.split(/\s+/).pop()}`, { lat: c[0], lng: c[1] });
        if (all.error) searchError = all.error;
        const near = all.filter(r => distKm({ lat: c[0], lng: c[1] }, r) < 50);
        const pick = near.find(r => r.food) || near[0];
        if (pick) found.push({ ...p, lat: pick.lat, lng: pick.lng, address: pick.address, placeId: pick.id, approx: 'auto' });
        else failed.push(p.name);
        await sleep(300);
        continue;
      }
      const area = p.area.split('/')[0];
      const inRegion = r => (r.address_name || '').includes(p.region);
      const isFood = r => /^(FD6|CE7)$/.test(r.category_group_code);
      let res = (await keywordSearch(`${area} ${p.name}`)).filter(inRegion);
      if (!res.length) res = (await keywordSearch(`${p.region} ${p.name}`)).filter(inRegion);
      const pick = res.find(isFood) || res[0];
      if (pick) found.push({ ...p, lat: +pick.y, lng: +pick.x, address: pick.road_address_name || pick.address_name, placeId: pick.id, approx: 'auto' });
      else failed.push(p.name);
      await sleep(120);
    }
    if (found.length) savePlaces(found);
    toast(`${found.length}곳 위치를 찾았어요${failed.length ? ` · 못 찾음 ${failed.length}곳` : ''}${searchError ? `\n⚠️ ${searchError}` : ''}`, searchError ? 9000 : 4000);
    if (found.length && !state.world) fitAll();
    if ($('#sheet').dataset.kind === 'list') showList();
    if (failed.length) console.info('위치를 못 찾은 곳:', failed);
  }

  // ─────────────────────────── 모달: 설정 · 가져오기 ───────────────────────────
  function openModal(html, bind) {
    $('#modalBody').innerHTML = html;
    const dlg = $('#modal');
    if (!dlg.open) dlg.showModal();
    bind && bind($('#modalBody'));
  }
  const closeModal = () => $('#modal').close();

  function openSettings(first = false) {
    const noPos = state.places.filter(needsLocate).length;
    const status = cfg.apiUrl ? (canEdit() ? '구글 시트 연동 중 · 편집 가능' : '공유받은 지도 · 보기 전용') : '로컬 모드 (이 기기에만 저장)';
    const editor = canEdit();
    openModal(`
      <h3>설정</h3>
      <p class="help">${first ? '카카오 지도 키를 넣으면 시작할 수 있어요. 시트 주소를 비워 두면 이 기기에만 저장돼요.' : `${state.places.length}곳 · ${status}`}</p>
      <form id="linkForm" class="link-form">
        <label class="field"><span>공유받은 링크로 연결 <small>· 홈 화면 앱에서는 여기에 링크를 붙여넣으세요</small></span>
          <input name="link" placeholder="https://abinkim.github.io/matchelin/?cfg=…" autocomplete="off"></label>
        <button class="btn primary">연결</button>
      </form>
      <hr>
      <form id="cfgForm">
        <label class="field"><span>카카오 JavaScript 키</span><input name="kakaoKey" value="${esc(cfg.kakaoKey)}" placeholder="developers.kakao.com → 내 애플리케이션 → 앱 키"></label>
        <label class="field"><span>구글 시트 Apps Script 웹앱 URL</span><input name="apiUrl" value="${esc(cfg.apiUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
        <label class="field"><span>시트 토큰</span><input name="token" value="${esc(cfg.token)}" placeholder="setup 실행 로그에 나온 값"></label>
        <div class="form-actions"><button type="button" class="btn" data-act="close">닫기</button><button class="btn primary">저장</button></div>
      </form>
      <hr>
      <div class="stack">
        ${editor ? '<button class="btn" data-act="import">📋 메모장 내용 가져오기</button>' : ''}
        ${noPos && editor ? `<button class="btn" data-act="autolocate">📍 정확한 위치가 없는 ${noPos}곳 자동으로 찾기</button>` : ''}
        ${cfg.apiUrl ? '<button class="btn" data-act="pull">🔄 시트에서 다시 불러오기</button>' : ''}
        ${cfg.apiUrl && editor ? '<button class="btn" data-act="share-edit">✏️ 편집용 링크 복사 <small>— 배우자처럼 같이 고칠 사람</small></button>' : ''}
        ${cfg.apiUrl && (cfg.viewToken || !editor) ? '<button class="btn" data-act="share-view">👀 보기 전용 링크 복사 <small>— 구경만 할 친구</small></button>' : ''}
        <button class="btn" data-act="export">💾 JSON 백업 내려받기</button>
      </div>`, body => {
      $('#linkForm', body).onsubmit = e => {
        e.preventDefault();
        if (!applyShareLink(e.target.link.value)) return toast('링크를 읽지 못했어요. 받은 링크 전체를 붙여넣어 주세요');
        closeModal();
        document.body.classList.toggle('readonly', !canEdit());
        renderAll();
        toast(canEdit() ? '연결했어요 (편집 가능)' : '연결했어요 (보기 전용)');
        pull();
      };
      const form = $('#cfgForm', body);
      form.onsubmit = e => {
        e.preventDefault();
        const fd = new FormData(form);
        const keyChanged = fd.get('kakaoKey').trim() !== cfg.kakaoKey;
        const apiChanged = fd.get('apiUrl').trim() !== cfg.apiUrl || fd.get('token').trim() !== cfg.token;
        Object.assign(cfg, { kakaoKey: fd.get('kakaoKey').trim(), apiUrl: fd.get('apiUrl').trim(), token: fd.get('token').trim() });
        store.set(KEY.cfg, cfg);
        closeModal();
        if (apiChanged) { store.set(KEY.version, ''); cfg.role = 'edit'; cfg.viewToken = ''; store.set(KEY.cfg, cfg); }
        if (keyChanged || !map) return location.reload();
        if (apiChanged) pull();
        toast('저장했어요');
      };
      body.onclick = e => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'close') closeModal();
        if (act === 'import') openImport();
        if (act === 'autolocate') { closeModal(); autoLocate(); }
        if (act === 'pull') { closeModal(); pull(); }
        if (act === 'export') exportJson();
        if (act === 'share-edit') shareLink('edit');
        if (act === 'share-view') shareLink('view');
      };
    });
  }

  function openImport() {
    let parsed = null;
    openModal(`
      <h3>메모장 내용 가져오기</h3>
      <p class="help">메모를 그대로 붙여넣으세요. 💫💫💫 / 💫💫 / 💫 / 🌝 줄이 등급 구분이고, 한 줄에 한 곳씩<br><code>지역 동네 가게이름 메뉴 (24‘ 25‘) - 폐업</code> 형식이면 돼요. 이미 있는 가게는 건너뛰어요.</p>
      <textarea class="memo" id="memoText" placeholder="💫💫 해당 지역을 방문하면 꼭 가야하는&#10;대전 봉명동 부연부 구채교, 황지향기린구 (24‘ 25‘)"></textarea>
      <div id="preview"></div>
      <div class="form-actions"><button class="btn" data-act="back">뒤로</button><button class="btn" data-act="parse">미리보기</button><button class="btn primary" data-act="go" disabled>가져오기</button></div>`, body => {
      body.onclick = e => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'back') openSettings();
        if (act === 'parse') {
          const { items, errors } = parseMemo($('#memoText').value);
          const have = new Set(state.places.map(placeKey));
          const fresh = items.filter(i => !have.has(placeKey(i)));
          parsed = fresh;
          const byR = RATINGS.map(r => [r, fresh.filter(i => i.rating === r.key).length]).filter(([, n]) => n);
          $('#preview').innerHTML = `<div class="preview"><b>${items.length}곳 인식</b> · 새로 추가 ${fresh.length}곳${items.length - fresh.length ? ` · 이미 있음 ${items.length - fresh.length}곳` : ''}
            <br>${byR.map(([r, n]) => `${r.label} ${n}`).join(' · ')}
            ${errors.length ? `<br>인식 못한 줄 ${errors.length}개:<ul>${errors.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}</div>`;
          $('[data-act=go]', body).disabled = !fresh.length;
        }
        if (act === 'go' && parsed && parsed.length) {
          const list = parsed.map(i => ({ ...i, id: newId() }));
          savePlaces(list);
          closeModal();
          const need = list.filter(p => !hasPos(p)).length;
          toast(`${list.length}곳을 가져왔어요`);
          if (need && map && confirm(`${need}곳은 아직 지도 위치가 없어요. 카카오 장소 검색으로 자동으로 찾을까요? (자동으로 찾은 곳은 나중에 확인할 수 있게 표시해 둬요)`)) autoLocate();
        }
      };
    });
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(state.places, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `맛슐랭_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // 설정을 해시에 담은 링크 — 열면 시트 URL·토큰이 자동 입력된다.
  // 편집용은 편집 토큰, 보기 전용은 보기 토큰을 담는다 (보기 토큰으로는 시트가 쓰기를 거부)
  async function shareLink(kind) {
    const token = kind === 'view' ? (canEdit() ? cfg.viewToken : cfg.token) : cfg.token;
    if (!token) return toast('보기 전용 토큰이 아직 없어요. 시트에서 다시 불러온 뒤 시도해 주세요');
    const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ u: cfg.apiUrl, t: token, r: kind }))));
    const url = `${location.origin}${location.pathname}?cfg=${encodeURIComponent(payload)}`;
    const msg = kind === 'view' ? '보기 전용 링크를 복사했어요. 받은 사람은 구경만 할 수 있어요' : '편집용 링크를 복사했어요. 받은 사람은 추가·수정·삭제를 할 수 있으니 믿을 수 있는 사람에게만 보내세요';
    try { await navigator.clipboard.writeText(url); toast(msg, 4500); }
    catch { prompt('이 링크를 복사하세요', url); }
  }

  // 공유 링크의 cfg(?cfg= 또는 예전 #cfg=)를 읽어 설정에 반영. 성공하면 true
  function applyShareLink(text) {
    const m = String(text || '').match(/[?#&]cfg=([^&#\s]+)/);
    if (!m) return false;
    try {
      const c = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
      if (c.k) cfg.kakaoKey = c.k;
      if (!c.u || !c.t) return false;
      if (c.u !== cfg.apiUrl || c.t !== cfg.token) {
        // 다른 지도로 바뀜 → 이전 지도의 캐시를 비운다
        state.places = []; state.pending = [];
        store.set(KEY.places, []); store.set(KEY.pending, []); store.set(KEY.version, '');
      }
      Object.assign(cfg, { apiUrl: c.u, token: c.t, role: c.r === 'view' ? 'view' : 'edit', viewToken: '' });
      store.set(KEY.cfg, cfg);
      return true;
    } catch { return false; }
  }

  function readHashConfig() {
    if (!/cfg=/.test(location.search + location.hash)) return;
    applyShareLink(location.search + location.hash);
    window.history.replaceState(null, '', location.pathname);
  }

  // ─────────────────────────── 기타 ───────────────────────────
  let toastTimer;
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function bindUi() {
    $('#searchForm').addEventListener('submit', e => { e.preventDefault(); state.assignTo = null; doSearch($('#q').value); });
    $('#chips').addEventListener('click', onChips);
    $('#chips').addEventListener('change', onChips);
    $('#btnSettings').onclick = () => openSettings();
    $('#btnAdd').onclick = () => map ? startAdd() : openSettings(true);
    $('#btnList').onclick = () => showList();
    $('#btnLocate').onclick = () => map && locate();
    $('#sheetClose').onclick = closeSheet;
    $('#bannerCancel').onclick = () => { const c = state.pick && state.pick.onCancel; endPick(); if (c) c(); };
    $('#modal').addEventListener('click', e => { if (e.target === $('#modal')) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').open) { if (state.pick) $('#bannerCancel').click(); else closeSheet(); } });
  }

  async function boot() {
    readHashConfig();
    document.body.classList.toggle('readonly', !canEdit());
    bindUi();
    renderChips();
    setSync(cfg.apiUrl ? 'busy' : '');
    if (!cfg.kakaoKey) { openSettings(true); pull(); startLiveSync(); return; }
    try {
      await loadKakao(cfg.kakaoKey);
      initMap();
    } catch (e) {
      toast('카카오 지도를 불러오지 못했어요. 카카오 콘솔에서 ① 카카오맵 사용 설정 ② JavaScript SDK 도메인 ③ JavaScript 키를 확인해 주세요', 8000);
      openSettings(true);
    }
    pull();
    startLiveSync();
  }

  boot();
})();
