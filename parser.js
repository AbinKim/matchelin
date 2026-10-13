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

  // "(24‘ 25’)" → "24 25"
  function parseYears(s) { return (String(s || '').match(/\d{2}/g) || []).join(' '); }

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
    let years = '';
    const ym = s.match(/\(([^()]*)\)\s*$/);
    if (ym) { years = parseYears(ym[1]); s = s.slice(0, ym.index).trim(); }

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

  return { RATINGS, CATEGORIES, ratingOf, categoryOf, isOverseas, cityCoord, guessCategory, parseMemo, parseYears, placeKey };
});
