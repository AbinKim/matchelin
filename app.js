'use strict';
(() => {
  const { RATINGS, CATEGORIES, ratingOf, categoryOf, isOverseas, guessCategory, parseMemo, placeKey } = window.MemoParser;

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

  const cfg = { kakaoKey: (window.APP_CONFIG || {}).kakaoKey || '', apiUrl: '', token: '', ...store.get(KEY.cfg, {}) };
  const state = {
    places: store.get(KEY.places, []),
    pending: store.get(KEY.pending, []),
    filter: { ratings: [], category: '', region: '', hideClosed: false, ...store.get(KEY.filter, {}) },
    sort: store.get(KEY.sort, 'rating'),
    selected: null,
    pick: null,       // 지도 탭으로 위치 고르는 중일 때의 콜백
    assignTo: null,   // 검색 결과를 이 맛집의 위치로 지정하는 중
    myPos: null,
  };

  let map, clusterer, placesSvc, geocoder, draftOverlay, meOverlay;
  const overlays = new Map(); // id → { ov, el }

  const byId = id => state.places.find(p => p.id === id);
  const hasPos = p => p && p.lat != null && p.lng != null && p.lat !== '' && !Number.isNaN(+p.lat);
  const years = p => String(p.years || '').split(/[\s,]+/).filter(Boolean).sort();
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
      if (res.unchanged) { if (!state.pending.length) setSync('ok'); return; }
      if (flushing || seq !== writeSeq) return; // 받는 사이 내 변경이 저장됨 → 다음 확인 때 다시 받음
      // 시트가 비어 있고 이 기기에 데이터가 있으면 올릴지 묻는다 (로컬 모드 → 시트 전환)
      if (!quiet && !res.places.length && state.places.length && !state.pending.length) {
        if (confirm(`시트가 비어 있어요. 이 기기에 있는 ${state.places.length}곳을 시트에 올릴까요?`)) {
          state.pending.push({ action: 'upsert', places: state.places });
          store.set(KEY.pending, state.pending);
          return flush();
        }
      }
      store.set(KEY.version, res.version || '');
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

    kakao.maps.event.addListener(map, 'click', e => {
      if (state.pick) { const cb = state.pick.cb; endPick(); cb(e.latLng.getLat(), e.latLng.getLng()); }
      else if (!$('#sheet').hidden && $('#sheet').dataset.kind !== 'form') closeSheet();
    });
    kakao.maps.event.addListener(map, 'idle', () => {
      const c = map.getCenter();
      store.set(KEY.view, { lat: c.getLat(), lng: c.getLng(), level: map.getLevel() });
    });
    kakao.maps.event.addListener(map, 'zoom_changed', updateLabels);

    renderAll();
    if (!v) fitAll();
    updateLabels();
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
      if (!hasPos(p) || !matches(p)) continue;
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
  }

  function showDraftPin(d) {
    clearDraft();
    if (!hasPos(d)) return;
    draftOverlay = new kakao.maps.CustomOverlay({ position: LL(d.lat, d.lng), content: pinEl(d, 'draft sel'), yAnchor: 1, zIndex: 200 });
    draftOverlay.setMap(map);
  }
  function clearDraft() { if (draftOverlay) { draftOverlay.setMap(null); draftOverlay = null; } }

  function focusOn(p) {
    if (!map || !hasPos(p)) return;
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

  // ─────────────────────────── 필터 · 칩 ───────────────────────────
  function matches(p) {
    const f = state.filter;
    if (f.ratings.length && !f.ratings.includes(p.rating)) return false;
    if (f.category && p.category !== f.category) return false;
    if (f.region && p.region !== f.region) return false;
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
    const rc = countBy(p => p.rating), cc = countBy(p => p.category), gc = countBy(p => p.region);
    const regions = Object.keys(gc).sort((a, b) => (isOverseas(a) - isOverseas(b)) || gc[b] - gc[a]);
    $('#chips').innerHTML =
      RATINGS.map(r => `<button type="button" class="chip${f.ratings.includes(r.key) ? ' on' : ''}" data-rating="${r.key}">${r.label} ${r.key === 'bib' || r.key === 'wish' ? r.short : ''}<small>${rc[r.key] || 0}</small></button>`).join('') +
      `<select class="chip${f.category ? ' on' : ''}" data-f="category"><option value="">종류 전체</option>${CATEGORIES.filter(c => cc[c.key]).map(c => `<option value="${c.key}"${f.category === c.key ? ' selected' : ''}>${c.emoji} ${c.label} (${cc[c.key]})</option>`).join('')}</select>` +
      `<select class="chip${f.region ? ' on' : ''}" data-f="region"><option value="">지역 전체</option>${regions.map(r => `<option value="${esc(r)}"${f.region === r ? ' selected' : ''}>${esc(r)} (${gc[r]})</option>`).join('')}</select>` +
      `<button type="button" class="chip${f.hideClosed ? ' on' : ''}" data-closed>폐업 숨김</button>`;
  }

  function onChips(e) {
    const f = state.filter;
    const b = e.target.closest('[data-rating],[data-closed]');
    if (e.type === 'click' && b) {
      if (b.dataset.rating) {
        const k = b.dataset.rating;
        f.ratings = f.ratings.includes(k) ? f.ratings.filter(x => x !== k) : [...f.ratings, k];
      } else f.hideClosed = !f.hideClosed;
    } else if (e.type === 'change' && e.target.dataset.f) {
      f[e.target.dataset.f] = e.target.value;
      if (e.target.dataset.f === 'region' && f.region) zoomToRegion(f.region);
    } else return;
    store.set(KEY.filter, f);
    renderAll();
    if ($('#sheet').dataset.kind === 'list' && !$('#sheet').hidden) showList();
  }

  function zoomToRegion(region) {
    const pts = state.places.filter(p => p.region === region && hasPos(p));
    if (!pts.length || !map) return;
    const b = new kakao.maps.LatLngBounds();
    pts.forEach(p => b.extend(LL(p.lat, p.lng)));
    map.setBounds(b, 120, 40, 120, 40);
    if (map.getLevel() < 4) map.setLevel(4);
  }

  function renderAll() { renderChips(); renderMarkers(); }

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
      return `<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.name} ${p.area}`)}">구글 지도</a>`;
    }
    const view = p.placeId ? `https://place.map.kakao.com/${p.placeId}` : `https://map.kakao.com/link/search/${encodeURIComponent(`${p.area.split('/')[0]} ${p.name}`)}`;
    const route = hasPos(p) ? `<a class="btn" target="_blank" rel="noopener" href="https://map.kakao.com/link/to/${encodeURIComponent(p.name)},${p.lat},${p.lng}">길찾기</a>` : '';
    return `<a class="btn" target="_blank" rel="noopener" href="${view}">카카오맵</a>${route}`;
  }

  function showDetail(p) {
    const r = ratingOf(p.rating), c = categoryOf(p.category), ys = years(p);
    let notice = '';
    if (!hasPos(p)) notice = `<div class="notice"><span>📍 아직 지도 위치가 없어요</span><button class="btn small" data-act="find">이름으로 찾기</button><button class="btn small" data-act="move">지도에서 지정</button></div>`;
    else if (p.approx === 'auto') notice = `<div class="notice"><span>📍 자동으로 찾은 위치예요. 맞나요?</span><button class="btn small" data-act="confirm">맞아요</button><button class="btn small" data-act="find">다시 찾기</button></div>`;
    else if (p.approx === 'city') notice = `<div class="notice"><span>📍 도시 중심에 대략 표시돼 있어요</span><button class="btn small" data-act="move">지도에서 지정</button></div>`;

    openSheet(`
      <div class="detail">
        <div class="d-rating r-${p.rating}">${r.label}<span>${esc(r.desc)}</span></div>
        <h2>${c.emoji} ${esc(p.name)} ${p.closed ? '<span class="badge">폐업</span>' : ''}</h2>
        ${p.menu ? `<p class="d-menu">${esc(p.menu)}</p>` : ''}
        <p class="d-meta">${esc(p.region)} ${esc(p.area)} · ${c.label}${p.address ? `<br>${esc(p.address)}` : ''}</p>
        ${ys.length ? `<div class="d-years">${ys.map(y => `<span>'${y}</span>`).join('')}</div>` : ''}
        ${p.memo ? `<p class="d-memo">${esc(p.memo)}</p>` : ''}
        ${notice}
        <div class="actions">
          <button class="btn primary" data-act="edit">편집</button>
          ${!ys.includes(THIS_YEAR) && !p.closed ? `<button class="btn" data-act="visit">올해도 갔어요 +'${THIS_YEAR}</button>` : ''}
          ${linksFor(p)}
        </div>
      </div>`, 'detail');

    $('#sheetBody').onclick = e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'edit') showForm({ ...p }, false);
      if (act === 'visit') { savePlace({ ...p, years: [...ys, THIS_YEAR].join(' '), rating: p.rating === 'wish' ? 'bib' : p.rating }); select(p.id, { pan: false }); toast(`'${THIS_YEAR} 방문 추가`); }
      if (act === 'confirm') { savePlace({ ...p, approx: '' }); select(p.id, { pan: false }); }
      if (act === 'find') startAssignSearch(p);
      if (act === 'move') {
        startPick(`'${p.name}' 위치를 지도에서 탭하세요`, async (lat, lng) => {
          const info = await describeCoord(lat, lng);
          savePlace({ ...p, lat, lng, approx: '', address: isOverseas(p.region) ? p.address : info.address });
          select(p.id, { pan: false });
        }, () => select(p.id, { pan: false }));
      }
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
        <div class="field"><span>등급</span><div class="seg">
          ${RATINGS.map(r => `<label><input type="radio" name="rating" value="${r.key}"${d.rating === r.key ? ' checked' : ''}><span>${r.label}${r.key === 'bib' || r.key === 'wish' ? ' ' + r.short : ''}</span></label>`).join('')}
        </div></div>
        <label class="field"><span>대표 메뉴</span><input name="menu" value="${esc(d.menu)}" placeholder="예) 로스/히레카츠"></label>
        <div class="row2">
          <label class="field"><span>종류</span><select name="category">${CATEGORIES.map(c => `<option value="${c.key}"${d.category === c.key ? ' selected' : ''}>${c.emoji} ${c.label}</option>`).join('')}</select></label>
          <label class="field"><span>방문 연도</span><input name="years" value="${esc(d.years)}" placeholder="23 24 25" inputmode="numeric"></label>
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
      Object.assign(d, {
        name: fd.get('name').trim(), rating: fd.get('rating') || 'bib', menu: fd.get('menu').trim(), category: fd.get('category'),
        years: (fd.get('years').match(/\d{2}/g) || []).join(' '), region: fd.get('region').trim(), area: fd.get('area').trim(),
        memo: fd.get('memo').trim(), closed: fd.get('closed') === 'on',
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
      if (act === 'cancel') { clearDraft(); isNew ? closeSheet() : select(d.id, { pan: false }); }
      if (act === 'delete' && confirm(`'${d.name}'을(를) 삭제할까요?`)) { deletePlace(d.id); closeSheet(); toast('삭제했어요'); }
      if (act === 'move') {
        read();
        startPick('새 위치를 지도에서 탭하세요', async (lat, lng) => {
          const info = await describeCoord(lat, lng);
          Object.assign(d, { lat, lng, approx: '', address: isOverseas(d.region) ? d.address : info.address });
          if (!d.region) d.region = info.region;
          if (!d.area) d.area = info.area;
          showDraftPin(d);
          showForm(d, isNew);
        }, () => showForm(d, isNew));
      }
    };
  }

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

  function startAdd() {
    closeSheet();
    startPick('추가할 가게 위치를 지도에서 탭하세요 · 위 검색창에 가게 이름을 검색해도 돼요', async (lat, lng) => {
      const info = await describeCoord(lat, lng);
      showForm(blank({ lat, lng, ...info }), true);
    });
  }

  const blank = extra => ({ id: newId(), name: '', rating: 'bib', category: 'etc', region: '', area: '', menu: '', years: THIS_YEAR, closed: false, lat: null, lng: null, address: '', placeId: '', approx: '', memo: '', ...extra });

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

  async function doSearch(q) {
    q = q.trim();
    if (!q) return;
    endPick();
    $('#q').blur();
    const assign = state.assignTo && byId(state.assignTo);
    const mine = assign ? [] : localMatches(q);
    const opts = map ? { location: map.getCenter() } : {};
    const kakaoRes = map ? await keywordSearch(q, opts) : [];
    const saved = new Map(state.places.filter(p => p.placeId).map(p => [p.placeId, p]));

    openSheet(`
      ${assign ? `<h3>'${esc(assign.name)}' 위치 고르기</h3>` : `<h3>'${esc(q)}' 검색</h3>`}
      ${mine.length ? `<p class="sec-title">내 맛집 ${mine.length}</p><ul class="items" data-sec="mine">${mine.map(itemHtml).join('')}</ul>` : ''}
      <p class="sec-title">카카오맵 장소 ${kakaoRes.length}</p>
      ${kakaoRes.length ? `<ul class="items" data-sec="kakao">${kakaoRes.map((r, i) => `
        <li data-i="${i}"><div class="em">${saved.has(r.id) ? '✅' : '📍'}</div>
          <div class="tx"><div class="nm">${esc(r.place_name)}</div><div class="sb">${esc(r.category_name.split(' > ').slice(1).join(' › ') || r.category_group_name)} · ${esc(r.road_address_name || r.address_name)}</div></div>
          <div class="rt">${saved.has(r.id) ? '저장됨' : (assign ? '선택' : '추가')}</div></li>`).join('')}</ul>`
        : `<p class="empty">결과가 없어요. 동네 이름을 붙여 보세요 (예: "효자동 담박집")</p>`}`, 'search');

    $('#sheetBody').onclick = async e => {
      const li = e.target.closest('li');
      if (!li) return;
      if (li.dataset.id) return select(li.dataset.id);
      const r = kakaoRes[+li.dataset.i];
      const lat = +r.y, lng = +r.x, address = r.road_address_name || r.address_name;
      if (assign) {
        state.assignTo = null;
        savePlace({ ...assign, lat, lng, address, placeId: r.id, approx: '' });
        return select(assign.id);
      }
      if (saved.has(r.id)) return select(saved.get(r.id).id);
      const info = await describeCoord(lat, lng);
      const d = blank({ name: r.place_name, category: guessCategory(`${r.category_name} ${r.place_name}`), region: info.region, area: info.area, address, placeId: r.id, lat, lng });
      map.setLevel(4);
      focusOn(d);
      showForm(d, true);
    };
  }

  function startAssignSearch(p) {
    state.assignTo = p.id;
    const q = `${p.area.split('/')[0]} ${p.name}`.trim();
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
    const noPos = state.places.filter(p => !hasPos(p)).length;
    openSheet(`
      <div class="list-head"><h3>내 맛집 ${list.length}곳</h3>
        <div class="sorts">${[['rating', '등급순'], ['recent', '최근 방문'], ['dist', '가까운 순']].map(([k, l]) => `<button data-sort="${k}" class="${s === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      ${noPos ? `<div class="notice"><span>📍 위치가 없는 곳이 ${noPos}곳 있어요</span><button class="btn small" data-act="autolocate">자동으로 찾기</button></div>` : ''}
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
  async function autoLocate() {
    const todo = state.places.filter(p => !hasPos(p) && !isOverseas(p.region));
    if (!todo.length) return toast('위치를 찾을 곳이 없어요');
    if (!map) return toast('지도가 준비되지 않았어요');
    const found = [], failed = [];
    for (let i = 0; i < todo.length; i++) {
      const p = todo[i];
      toast(`위치 찾는 중… ${i + 1}/${todo.length}`, 60000);
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
    toast(`${found.length}곳 위치를 찾았어요${failed.length ? ` · 못 찾음 ${failed.length}곳` : ''}`, 4000);
    if (found.length) fitAll();
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
    const noPos = state.places.filter(p => !hasPos(p) && !isOverseas(p.region)).length;
    openModal(`
      <h3>설정</h3>
      <p class="help">${first ? '카카오 지도 키를 넣으면 시작할 수 있어요. 시트 주소를 비워 두면 이 기기에만 저장돼요.' : `${state.places.length}곳 저장됨 · ${cfg.apiUrl ? '구글 시트 연동 중' : '로컬 모드 (이 기기에만 저장)'}`}</p>
      <form id="cfgForm">
        <label class="field"><span>카카오 JavaScript 키</span><input name="kakaoKey" value="${esc(cfg.kakaoKey)}" placeholder="developers.kakao.com → 내 애플리케이션 → 앱 키"></label>
        <label class="field"><span>구글 시트 Apps Script 웹앱 URL</span><input name="apiUrl" value="${esc(cfg.apiUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
        <label class="field"><span>시트 토큰</span><input name="token" value="${esc(cfg.token)}" placeholder="setup 실행 로그에 나온 값"></label>
        <div class="form-actions"><button type="button" class="btn" data-act="close">닫기</button><button class="btn primary">저장</button></div>
      </form>
      <hr>
      <div class="stack">
        <button class="btn" data-act="import">📋 메모장 내용 가져오기</button>
        ${noPos ? `<button class="btn" data-act="autolocate">📍 위치 없는 ${noPos}곳 자동으로 찾기</button>` : ''}
        ${cfg.apiUrl ? '<button class="btn" data-act="pull">🔄 시트에서 다시 불러오기</button>' : ''}
        <button class="btn" data-act="share">🔗 다른 기기용 설정 링크 복사</button>
        <button class="btn" data-act="export">💾 JSON 백업 내려받기</button>
      </div>`, body => {
      const form = $('#cfgForm', body);
      form.onsubmit = e => {
        e.preventDefault();
        const fd = new FormData(form);
        const keyChanged = fd.get('kakaoKey').trim() !== cfg.kakaoKey;
        const apiChanged = fd.get('apiUrl').trim() !== cfg.apiUrl || fd.get('token').trim() !== cfg.token;
        Object.assign(cfg, { kakaoKey: fd.get('kakaoKey').trim(), apiUrl: fd.get('apiUrl').trim(), token: fd.get('token').trim() });
        store.set(KEY.cfg, cfg);
        closeModal();
        if (apiChanged) store.set(KEY.version, '');
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
        if (act === 'share') shareLink();
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

  // 설정을 해시에 담은 링크 — 폰이나 배우자 기기에서 열면 설정이 자동 입력된다
  async function shareLink() {
    const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ k: cfg.kakaoKey, u: cfg.apiUrl, t: cfg.token }))));
    const url = `${location.origin}${location.pathname}#cfg=${payload}`;
    try { await navigator.clipboard.writeText(url); toast('링크를 복사했어요. 토큰이 들어 있으니 믿을 수 있는 사람에게만 보내세요', 4000); }
    catch { prompt('이 링크를 복사하세요', url); }
  }

  function readHashConfig() {
    const m = location.hash.match(/cfg=([^&]+)/);
    if (!m) return;
    try {
      const c = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
      if (c.k) cfg.kakaoKey = c.k;
      if (c.u) cfg.apiUrl = c.u;
      if (c.t) cfg.token = c.t;
      store.set(KEY.cfg, cfg);
    } catch { /* 잘못된 링크 */ }
    history.replaceState(null, '', location.pathname + location.search);
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
    bindUi();
    renderChips();
    setSync(cfg.apiUrl ? 'busy' : '');
    if (!cfg.kakaoKey) { openSettings(true); pull(); startLiveSync(); return; }
    try {
      await loadKakao(cfg.kakaoKey);
      initMap();
    } catch (e) {
      toast('카카오 지도를 불러오지 못했어요. 키와 등록된 사이트 도메인을 확인해 주세요', 6000);
      openSettings(true);
    }
    pull();
    startLiveSync();
  }

  boot();
})();
