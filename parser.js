/*
 * 맛슐랭 메모 파서 — 메모장 형식을 맛집 객체로 변환.
 * 브라우저(window.MemoParser)와 node(require) 양쪽에서 쓴다.
 *
 * 형식:
 *   💫💫 해당 지역을 방문하면 꼭 가야하는      ← 등급 헤더
 *   대전 봉명동 부연부 구채교, 황지향기린구 (24‘ 25‘)
 *   청도 고수리 가마솥국밥 육회비빔밥 (23’) - 폐업
 *   미국 텍사스 오스틴 Terry Black's Barbecue 바베큐 (25‘)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MemoParser = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const RATINGS = [
    { key: '3', label: '💫💫💫', short: '3스타', desc: '요리가 훌륭해 찾아갈 만한' },
    { key: '2', label: '💫💫', short: '2스타', desc: '해당 지역을 방문하면 꼭 가야하는' },
    { key: '1', label: '💫', short: '1스타', desc: '해당 지역을 방문하면 들러볼 가치가 있는' },
    { key: 'bib', label: '🌝', short: '가성비', desc: '가격 대비 합리적인 맛' },
    { key: 'wish', label: '🔖', short: '가볼곳', desc: '가보고 싶은 곳' },
  ];

  // 앞쪽이 우선. kw = 메뉴/가게명 키워드, gkw = 카카오 업종명 같은 넓은 키워드(2차 판정)
  const CATEGORIES = [
    { key: 'katsu', emoji: '🐷', label: '돈가스', kw: ['카츠', '까스', '돈가스', '히레', '로스'], gkw: ['돈까스'] },
    { key: 'noodle', emoji: '🍜', label: '면', kw: ['칼국수', '냉면', '라멘', '소바', '우동', '국수', '도삭면', '쌀국수', '분짜'], gkw: ['국수', '냉면'] },
    { key: 'chinese', emoji: '🥟', label: '중식', kw: ['짬뽕', '짜장', '유린기', '딤섬', '마라', '훠궈', '양꼬치', '탕수육', '토마토계란'], gkw: ['중식', '중국'] },
    { key: 'soup', emoji: '🍲', label: '국밥·탕', kw: ['국밥', '탕', '전골', '찌개', '순대', '샤브', '해장국'], gkw: ['국밥', '해장국'] },
    { key: 'korean', emoji: '🍚', label: '한식', kw: ['비빔밥', '보리밥', '김밥', '순두부', '오징어볶음', '부추전', '파전', '백반'], gkw: ['한식'] },
    { key: 'meat', emoji: '🥩', label: '고기', kw: ['한우', '갈비', '목살', '곱창', '막창', '등심', '스테이크', '바베큐', '징기스칸', '야키니쿠', '차돌', '특양', '오리', '육회', '육사시미', '항정', '삼겹'], gkw: ['육류', '고기', '곱창'] },
    { key: 'seafood', emoji: '🦪', label: '해산물', kw: ['굴', '물회', '회', '게장', '우럭', '고등어', '바지락', '물총', '해물', '조개', '대게'], gkw: ['해물', '생선', '회'] },
    { key: 'japanese', emoji: '🍣', label: '일식', kw: ['초밥', '스시', '오마카세', '텐동', '이자카야', '텐푸라', '사케동'], gkw: ['일식', '초밥'] },
    { key: 'western', emoji: '🍝', label: '양식', kw: ['파스타', '피자', '버거', '뇨끼', '타코', '카레', '알리오', '리조또'], gkw: ['양식', '이탈리안', '피자', '햄버거', '멕시칸'] },
    { key: 'cafe', emoji: '☕', label: '카페·디저트', kw: ['커피', '카페', '디저트', '베이커리', '빵', '케이크'], gkw: ['카페', '제과', '디저트'] },
    { key: 'etc', emoji: '🍽️', label: '기타', kw: [], gkw: [] },
  ];

  // 첫 토큰이 이 나라면 해외. 값 = 지역 토큰 수 (미국은 '미국 주 도시')
  const COUNTRIES = { 일본: 2, 미국: 3, 베트남: 2, 중국: 2, 대만: 2, 태국: 2, 홍콩: 1, 싱가포르: 1, 필리핀: 2, 프랑스: 2, 이탈리아: 2, 스페인: 2, 영국: 2, 독일: 2, 호주: 2, 캐나다: 2 };

  // 해외는 카카오 장소 검색이 안 되므로 도시 중심으로 대략 표시
  const CITY_COORDS = {
    후쿠오카: [33.5902, 130.4017], 삿포로: [43.0618, 141.3545], 오타루: [43.1907, 140.9947],
    도쿄: [35.6762, 139.6503], 오사카: [34.6937, 135.5023], 교토: [35.0116, 135.7681], 나고야: [35.1815, 136.9066], 오키나와: [26.2124, 127.6809],
    뉴올리언스: [29.9511, -90.0715], 칼리지스테이션: [30.628, -96.3344], 오스틴: [30.2672, -97.7431], 휴스턴: [29.7604, -95.3698], 뉴욕: [40.7128, -74.006], 로스앤젤레스: [34.0522, -118.2437], 샌프란시스코: [37.7749, -122.4194],
    다낭: [16.0544, 108.2022], 하노이: [21.0278, 105.8342], 호치민: [10.8231, 106.6297], 나트랑: [12.2388, 109.1967],
    방콕: [13.7563, 100.5018], 타이베이: [25.033, 121.5654], 홍콩: [22.3193, 114.1694], 싱가포르: [1.3521, 103.8198], 상하이: [31.2304, 121.4737], 베이징: [39.9042, 116.4074],
    파리: [48.8566, 2.3522], 런던: [51.5074, -0.1278], 로마: [41.9028, 12.4964], 바르셀로나: [41.3874, 2.1686],
  };

  // 지역 필터는 도·광역시 단위로 묶는다. region에는 '포항' 같은 시·군 이름이 들어 있다
  const METROS = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종'];
  const PROVINCE_CITIES = {
    경기: '수원 성남 고양 용인 부천 안산 안양 남양주 화성 평택 의정부 시흥 파주 김포 광명 군포 하남 오산 이천 안성 의왕 양주 구리 포천 동두천 과천 여주 양평 가평 연천',
    강원: '춘천 원주 강릉 동해 태백 속초 삼척 홍천 횡성 영월 평창 정선 철원 화천 양구 인제 양양',
    충북: '청주 충주 제천 보은 옥천 영동 증평 진천 괴산 음성 단양',
    충남: '천안 공주 보령 아산 서산 논산 계룡 당진 금산 부여 서천 청양 홍성 예산 태안',
    전북: '전주 군산 익산 정읍 남원 김제 완주 진안 무주 장수 임실 순창 고창 부안',
    전남: '목포 여수 순천 나주 광양 담양 곡성 구례 고흥 보성 화순 장흥 강진 해남 영암 무안 함평 영광 장성 완도 진도 신안',
    경북: '포항 경주 김천 안동 구미 영주 영천 상주 문경 경산 의성 청송 영양 영덕 청도 고령 성주 칠곡 예천 봉화 울진 울릉',
    경남: '창원 진주 통영 사천 김해 밀양 거제 양산 의령 함안 창녕 고성 남해 하동 산청 함양 거창 합천',
    제주: '제주 서귀포',
  };
  const CITY_PROVINCE = {};
  Object.entries(PROVINCE_CITIES).forEach(([prov, list]) => list.split(' ').forEach(c => { CITY_PROVINCE[c] = prov; }));
  const ADDR_PROVINCE = [
    [/^경기/, '경기'], [/^강원/, '강원'], [/^(충북|충청북)/, '충북'], [/^(충남|충청남)/, '충남'], [/^(전북|전라북)/, '전북'],
    [/^(전남|전라남)/, '전남'], [/^(경북|경상북)/, '경북'], [/^(경남|경상남)/, '경남'], [/^제주/, '제주'],
  ];

  // 필터용 큰 지역: 해외는 나라, 광역시는 그대로, 그 외 시·군은 도
  function provinceOf(p) {
    const region = String(p.region || '').trim();
    if (isOverseas(region) || METROS.includes(region)) return region;
    if (CITY_PROVINCE[region]) return CITY_PROVINCE[region];
    const addr = String(p.address || '').trim();
    for (const [re, prov] of ADDR_PROVINCE) if (re.test(addr)) return prov;
    const metro = METROS.find(m => addr.startsWith(m));
    return metro || region || '기타';
  }

  const HANGUL = /[가-힣]/;

  function ratingOf(key) { return RATINGS.find(r => r.key === key) || RATINGS[3]; }
  function categoryOf(key) { return CATEGORIES.find(c => c.key === key) || CATEGORIES[CATEGORIES.length - 1]; }
  function isOverseas(region) { return Object.prototype.hasOwnProperty.call(COUNTRIES, region); }
  function cityCoord(area) {
    const toks = String(area || '').split(/\s+/);
    for (let i = toks.length - 1; i >= 0; i--) if (CITY_COORDS[toks[i]]) return CITY_COORDS[toks[i]];
    return null;
  }

  function guessCategory(text) {
    const t = String(text || '');
    for (const c of CATEGORIES) if (c.kw.some(k => t.includes(k))) return c.key;
    for (const c of CATEGORIES) if (c.gkw.some(k => t.includes(k))) return c.key;
    return 'etc';
  }

  function headerRating(line) {
    const m = line.match(/^(?:💫)+/u);
    if (m) return String(Math.min(3, Array.from(m[0]).length));
    if (line.startsWith('🌝')) return 'bib';
    if (line.startsWith('🔖')) return 'wish';
    return null;
  }

  // "(24‘ 25’)" → ['24', '25']  — 그 등급을 받은 연도들
  function parseYears(s) { return String(s || '').match(/\d{2}/g) || []; }

  // 가게명 = 앞쪽 비한글 토큰들(영문·일본어 상호) 또는 첫 한글 토큰 + '…점' 지점 토큰
  function splitNameMenu(toks) {
    let n = 0;
    if (!HANGUL.test(toks[0])) { while (n < toks.length - 1 && !HANGUL.test(toks[n])) n++; }
    else { n = 1; while (n < toks.length - 1 && /점$/.test(toks[n])) n++; }
    if (n >= toks.length) n = toks.length - 1 || 1;
    return { name: toks.slice(0, n).join(' '), menu: toks.slice(n).join(' ') };
  }

  function parseLine(line, rating) {
    let s = line.trim();
    const closed = /[-–]\s*폐업\s*$/.test(s);
    s = s.replace(/[-–]\s*폐업\s*$/, '').trim();
    // years = 연도별 등급 "24:2 25:2" (메모의 연도는 그 등급을 받은 해)
    let years = '';
    const ym = s.match(/\(([^()]*)\)\s*$/);
    if (ym) { years = parseYears(ym[1]).map(y => `${y}:${rating}`).join(' '); s = s.slice(0, ym.index).trim(); }

    const toks = s.split(/\s+/).filter(Boolean);
    const regionN = isOverseas(toks[0]) ? COUNTRIES[toks[0]] : 2;
    if (toks.length < regionN + 1) return null;
    const region = toks[0];
    const area = toks.slice(1, regionN).join(' ');
    const { name, menu } = splitNameMenu(toks.slice(regionN));

    const item = { name, rating, category: guessCategory(`${menu} ${name}`), region, area, menu, years, closed, lat: null, lng: null, address: '', placeId: '', approx: '', memo: '' };
    if (isOverseas(region)) {
      const c = cityCoord(area);
      if (c) { item.lat = c[0]; item.lng = c[1]; item.approx = 'city'; }
    }
    return item;
  }

  function parseMemo(text) {
    const items = [], errors = [];
    let rating = 'bib';
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const h = headerRating(line);
      if (h) { rating = h; continue; }
      // 연도 괄호도 없고 토큰도 적은 줄(제목 등)은 조용히 건너뜀
      if (!/\(/.test(line) && line.split(/\s+/).length < 3) continue;
      const item = parseLine(line, rating);
      if (item && item.name) items.push(item); else errors.push(line);
    }
    return { items, errors };
  }

  function placeKey(p) { return `${p.region}|${p.area}|${p.name}`.replace(/\s+/g, ''); }

  return { RATINGS, CATEGORIES, ratingOf, categoryOf, isOverseas, provinceOf, cityCoord, guessCategory, parseMemo, parseYears, placeKey };
});
