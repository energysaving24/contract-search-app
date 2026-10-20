/* 학교장터·나라장터 계약조회 앱 — 에너지세이빙  (PC '계약상세조회기' 최신판과 같은 조건)
 * 나라장터: 공공데이터포털 '조달청_나라장터 계약정보서비스' + '사용자정보서비스'(기관 사업자번호·주소·팩스)
 * 학교장터: 교육청 연계 계약현황 공개화면 (서울·경기·인천)
 * 통신은 Capacitor 네이티브 HTTP (브라우저 CORS 제한 없음)
 */
"use strict";

// ───────────────────────── 공통 ─────────────────────────
const norm = s => (s || "").replace(/[\s()（）\[\]·.,\-]/g, "").replace(/주식회사|유한회사/g, "");
const pad2 = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
const isoD = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowYmdhm = () => { const d = new Date(); return ymd(d) + pad2(d.getHours()) + pad2(d.getMinutes()); };

function parseDate(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.length < 8) return null;
  const x = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  return isNaN(x) ? null : x;
}
const fmtDate = s => { const d = parseDate(s); return d ? isoD(d) : (s || ""); };
function fmtBizno(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : (s || "");
}
function toInt(s) { const d = String(s ?? "").replace(/[^\d]/g, ""); return d ? parseInt(d, 10) : null; }
const won = n => (n == null ? "" : n.toLocaleString("ko-KR"));
const daysBetween = (a, b) => Math.round((b - a) / 86400000);

function monthChunks(d1, d2) {
  const out = [];
  let cur = new Date(d1);
  while (cur <= d2) {
    const endM = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const end = endM < d2 ? endM : new Date(d2);
    out.push([new Date(cur), end]);
    cur = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  }
  return out;
}
const nameMatch = (t, names) => { const k = norm(t); return !!k && names.some(n => n && norm(n).includes(k)); };
function shortSchool(full) {
  const p = (full || "").trim().split(/\s+/);
  return p.length >= 2 && /(학교|유치원)$/.test(p[p.length - 1]) ? p[p.length - 1] : (full || "");
}
const REGION_KEYS = [["서울", "서울"], ["인천", "인천"], ["경기", "경기"], ["부산", "부산"], ["대구", "대구"], ["광주광역", "광주"],
  ["대전", "대전"], ["울산", "울산"], ["세종", "세종"], ["강원", "강원"], ["충청북", "충북"], ["충북", "충북"], ["충청남", "충남"],
  ["충남", "충남"], ["전라북", "전북"], ["전북", "전북"], ["전라남", "전남"], ["전남", "전남"], ["경상북", "경북"], ["경북", "경북"],
  ["경상남", "경남"], ["경남", "경남"], ["제주", "제주"]];
function regionOf(text) {
  const t = (text || "").replace(/\s+/g, "");
  for (const [k, rg] of REGION_KEYS) if (t.startsWith(k)) return rg;
  return "";
}

/** 입력한 학교명과 이름이 정확히 같은 학교가 있으면 이름 일부만 겹치는 다른 학교는 뺀다 */
function preferExact(rows, insts, log) {
  const drop = new Set(), inSet = new Set(insts.map(norm));
  const sn = r => [norm(shortSchool(r["계약(발주)기관"] || "")), norm(shortSchool((r.수요기관 || "").split(",")[0]))];
  for (const nm of insts) {
    const k = norm(nm);
    if (!k) continue;
    const hit = rows.filter(r => sn(r).some(x => x.includes(k)));
    if (!hit.some(r => sn(r).includes(k))) continue;
    const others = new Set();
    for (const r of hit) {
      const [a, b] = sn(r);
      if (a !== k && b !== k && !inSet.has(a) && !inSet.has(b)) { drop.add(r); others.add(shortSchool(r["계약(발주)기관"] || "")); }
    }
    if (others.size && log) log(`  · '${nm}'과(와) 이름이 정확히 같은 학교만 남김 → 제외: ${[...others].join(", ")}`);
  }
  return rows.filter(r => !drop.has(r));
}
/** 학교장터 계약상대 사업자번호·대표자를 같은 업체의 나라장터 정보로 채움 */
function fillCorpBiz(rows) {
  const known = new Map();
  for (const r of rows)
    if (r["계약상대 사업자번호"] && r["계약상대 상호"] && !r["계약상대 상호"].includes(","))
      if (!known.has(norm(r["계약상대 상호"]))) known.set(norm(r["계약상대 상호"]), [r["계약상대 사업자번호"], r["계약상대 대표자"] || ""]);
  for (const r of rows)
    if (!r["계약상대 사업자번호"]) {
      const k = known.get(norm(r["계약상대 상호"] || ""));
      if (k) { r["계약상대 사업자번호"] = k[0]; r["계약상대 대표자"] = r["계약상대 대표자"] || k[1]; }
    }
}
/** 기관정보 저장소 (휴대폰 안에 저장) */
const instStore = {
  load() { try { return JSON.parse(localStorage.getItem("cs_instcache") || "{}"); } catch { return {}; } },
  save(d) { try { localStorage.setItem("cs_instcache", JSON.stringify(d)); } catch { /* 무시 */ } },
};

/** 동시에 n개씩 실행 (순서 유지) */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

// EUC-KR(CP949) 퍼센트 인코딩 — 학교장터 전송용
let EUCKR = null;
function buildEuckr() {
  const dec = new TextDecoder("euc-kr");
  const m = new Map();
  for (let b1 = 0x81; b1 <= 0xFE; b1++)
    for (let b2 = 0x41; b2 <= 0xFE; b2++) {
      const s = dec.decode(new Uint8Array([b1, b2]));
      if (s.length === 1 && s !== "�" && !m.has(s)) m.set(s, [b1, b2]);
    }
  return m;
}
function encEuckr(str) {
  if (!EUCKR) EUCKR = buildEuckr();
  let out = "";
  for (const ch of String(str ?? "")) {
    const c = ch.codePointAt(0);
    if (c < 0x80) {
      if (/[A-Za-z0-9\-_.*]/.test(ch)) out += ch;
      else if (ch === " ") out += "+";
      else out += "%" + c.toString(16).toUpperCase().padStart(2, "0");
    } else {
      const b = EUCKR.get(ch);
      if (b) out += b.map(x => "%" + x.toString(16).toUpperCase()).join("");
    }
  }
  return out;
}
const formEncode = obj => Object.entries(obj).map(([k, v]) => `${k}=${encEuckr(v)}`).join("&");
function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// ───────────────────────── 통신 ─────────────────────────
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
/** 휴대폰 기능(플러그인) 호출. @capacitor/core 없이도 동작하도록 bridge의 nativePromise를 직접 사용 */
function nativePlugin(name) {
  if (typeof window === "undefined" || !window.Capacitor) return null;
  const C = window.Capacitor;
  if (C.Plugins && C.Plugins[name]) return C.Plugins[name];
  if (typeof C.nativePromise === "function" && (!C.isNativePlatform || C.isNativePlatform()))
    return new Proxy({}, { get: (_, method) => opts => C.nativePromise(name, method, opts) });
  return null;
}
const nativeHttp = () => nativePlugin("CapacitorHttp");
let HTTP_IMPL = null;   // 시험용으로 바꿔 끼울 수 있음

async function http({ url, method = "GET", body = null, headers = {}, binary = false, timeout = 30000 }) {
  if (HTTP_IMPL) return HTTP_IMPL({ url, method, body, headers, binary, timeout });
  const CH = nativeHttp();
  if (CH) {
    const opt = { url, method, headers: Object.assign({ "User-Agent": UA }, headers),
      responseType: binary ? "arraybuffer" : "text", connectTimeout: timeout, readTimeout: timeout };
    if (body != null) opt.data = body;
    const r = await CH.request(opt);
    let data = r.data;
    if (binary && typeof data === "string") data = b64ToBytes(data);
    else if (!binary && typeof data === "object" && data !== null) data = JSON.stringify(data);
    return { status: r.status, data };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method, body, headers, signal: ctl.signal });
    return { status: r.status, data: binary ? new Uint8Array(await r.arrayBuffer()) : await r.text() };
  } finally { clearTimeout(t); }
}

// ───────────────────────── 나라장터 ─────────────────────────
const G2B_CNTRCT_BASES = ["https://apis.data.go.kr/1230000/ao/CntrctInfoService",
  "https://apis.data.go.kr/1230000/CntrctInfoService01", "https://apis.data.go.kr/1230000/CntrctInfoService"];
const G2B_USR_BASES = ["https://apis.data.go.kr/1230000/ao/UsrInfoService02",
  "https://apis.data.go.kr/1230000/ao/UsrInfoService", "https://apis.data.go.kr/1230000/UsrInfoService02"];
const G2B_KINDS = { 용역: "Servc", 물품: "Thng", 공사: "Cnstwk" };

function pick(d, ...keys) {
  for (const k of keys) { const v = d[k]; if (v != null && v !== "" && v !== "null") return String(v).trim(); }
  return "";
}
const splitList = s => [...String(s || "").matchAll(/\[([^\]]*)\]/g)].map(m => m[1].split("^").map(x => x.trim()));

/** corpList [순번^업체구분^공동도급방식구분^업체명^대표자명^국적명^지분율^채권자명^담당자성명^사업자등록번호] */
function corpFromList(s) {
  const names = [], biz = [], reps = [];
  const skip = new Set(["단독", "공동", "대표사", "구성사", "주계약업체", "공동수급업체", "분담이행", "공동이행", "대한민국", "국내"]);
  for (const f of splitList(s)) {
    if (f.length >= 4 && f[3]) {
      names.push(f[3]); reps.push(f[4] || ""); biz.push(f[9] ? fmtBizno(f[9]) : "");
    } else {
      const nm = f.slice(1).find(x => x && !skip.has(x) && !/^[\d.\-%]+$/.test(x));
      if (nm) { names.push(nm); reps.push(""); biz.push(fmtBizno(f.find(x => /^\d{3}-?\d{2}-?\d{5}$/.test(x)) || "")); }
    }
  }
  return { names, biz, reps };
}
/** dminsttList [순번^수요기관코드^수요기관명^소관구분^담당부서명^담당자성명^담당자전화번호] */
const dminsttFromList = s => splitList(s).filter(f => f.length >= 3).map(f => [f[1], f[2]]);

function scmplDate(it) {
  const d = pick(it, "thtmScmpltDate", "ttalScmpltDate", "scmpltDate", "cmpltDate");
  if (d) return fmtDate(d);
  const prd = pick(it, "cntrctPrd");
  const ds = prd.match(/20\d\d[-./]?\d\d[-./]?\d\d/g);
  return ds ? fmtDate(ds[ds.length - 1]) : prd;
}
function cntrctOrder(it) {
  const parts = [];
  const o = pick(it, "cntrctOrd", "lngtrmCtnuOrd", "thtmCntrctOrd");
  if (o && o !== "0" && o !== "00") parts.push(`${/^\d+$/.test(o) ? +o : o}차`);
  let m = pick(it, "cntrctDtlInfoUrl", "cntrctInfoUrl").match(/ctrtChgOrd=(\d+)/);
  let chg = m ? m[1] : "";
  if (!chg) { m = pick(it, "dcsnCntrctNo").match(/(\d{2})$/); chg = m && pick(it, "dcsnCntrctNo").length >= 15 ? m[1] : ""; }
  if (chg && chg !== "00") parts.push(`${+chg}차 변경`);
  const lng = pick(it, "lngtrmCtnuDivNm");
  if (!parts.length) parts.push(!lng || !lng.includes("장기") ? "최초" : lng);
  return parts.join(" / ");
}
function g2bParse(txt) {
  const t = String(txt || "").trim();
  if (t.startsWith("<")) {
    const code = t.match(/<(?:returnReasonCode|resultCode)>([^<]*)</);
    const msg = t.match(/<(?:returnAuthMsg|errMsg|resultMsg)>([^<]*)</);
    return { code: code ? code[1] : "XML", msg: msg ? msg[1] : t.slice(0, 120), items: [], total: 0 };
  }
  let j;
  try { j = JSON.parse(t); } catch { return { code: "PARSE", msg: t.slice(0, 120), items: [], total: 0 }; }
  const resp = j.response || j, head = resp.header || {}, body = resp.body || {};
  let items = body.items || [];
  if (!Array.isArray(items)) items = items.item || [];
  if (!Array.isArray(items)) items = [items];
  return { code: String(head.resultCode ?? "00"), msg: head.resultMsg || "", items, total: +(body.totalCount || 0) };
}
function g2bRow(it, kind) {
  const dm = dminsttFromList(pick(it, "dminsttList"));
  const dmNames = dm.length ? dm.map(x => x[1]) : [pick(it, "dminsttNm")];
  const corp = corpFromList(pick(it, "corpList"));
  return {
    출처: "나라장터", 구분: kind,
    "계약(발주)기관": pick(it, "cntrctInsttNm"), 계약기관코드: pick(it, "cntrctInsttCd"),
    수요기관: dmNames.filter(Boolean).join(", "), 수요기관코드: dm.length ? dm[0][0] : pick(it, "dminsttCd"),
    담당자: pick(it, "cntrctInsttOfclNm", "cntrctInsttChrgrNm"),
    전화번호: pick(it, "cntrctInsttOfclTelNo", "cntrctInsttChrgrTelNo"),
    계약차수: cntrctOrder(it),
    계약일: fmtDate(pick(it, "cntrctCnclsDate", "cntrctDate")),
    완수일: scmplDate(it),
    계약금액: toInt(pick(it, "thtmCntrctAmt", "totCntrctAmt", "cntrctAmt")),
    "계약상대 상호": corp.names.join(", "),
    "계약상대 사업자번호": corp.biz.filter(Boolean).join(", "),
    "계약상대 대표자": corp.reps.filter(Boolean).join(", "),
    계약명: pick(it, "cntrctNm"),
    계약방법: pick(it, "cntrctCnclsMthdNm", "cntrctMthdNm"),
    계약번호: pick(it, "dcsnCntrctNo", "untyCntrctNo", "cntrctNo"),
  };
}
function g2bKeep(r, it, nm, mode, kw) {
  if (kw && !norm(r.계약명).includes(norm(kw))) return false;
  if (nm) {
    const org = [pick(it, "cntrctInsttNm")];
    const dm = dminsttFromList(pick(it, "dminsttList")).map(x => x[1]).concat([pick(it, "dminsttNm")]);
    const p = mode === "계약기관" ? org : mode === "수요기관" ? dm : org.concat(dm);
    if (!nameMatch(nm, p)) return false;
  }
  return true;
}

class G2BClient {
  constructor(key, log, stop) {
    key = (key || "").trim();
    this.key = key.includes("%") ? decodeURIComponent(key) : key;
    this.log = log; this.stop = stop;
    this.base = null; this.usrBase = null; this.usrOk = true; this.cache = new Map();
    this.monthlyOnly = false; this.diagDone = false; this.diagText = "";
  }
  async get(url, params, tries = 3) {
    const q = new URLSearchParams(Object.assign({}, params, { ServiceKey: this.key, type: "json" }));
    let last;
    for (let k = 0; k < tries; k++) {
      if (this.stop.v) throw new Error("중지됨");
      try { const r = await http({ url: `${url}?${q}`, timeout: 30000 }); return r.data; }
      catch (e) { last = e; await sleep(1000 + 2000 * k); }
    }
    throw new Error(`접속 실패: ${last && last.message}`);
  }
  async call(op, params) {
    const bases = this.base ? [this.base] : G2B_CNTRCT_BASES;
    let last = "";
    for (const b of bases) {
      let txt;
      try { txt = await this.get(`${b}/${op}`, params); }
      catch (e) { if (/중지/.test(e.message)) throw e; last = e.message; continue; }
      const p = g2bParse(txt);
      if (["00", "03", "INFO-000", "INFO-200"].includes(p.code)) { this.base = b; return p; }
      last = `${p.code} ${p.msg}`;
      if (["20", "30", "31"].includes(p.code) || /SERVICE_KEY/.test(p.msg)) {
        this.base = b;
        throw new Error(`인증키 문제(${last}) — 공공데이터포털 활용신청·키 확인`);
      }
    }
    throw new Error(last || "응답 없음");
  }
  async pages(op, params, max = 200) {
    let out = [];
    for (let page = 1; page <= max && !this.stop.v; page++) {
      const p = await this.call(op, Object.assign({}, params, { numOfRows: "999", pageNo: String(page) }));
      out = out.concat(p.items);
      if (!p.items.length || page * 999 >= p.total) break;
    }
    return out;
  }
  async chunk(kc, a, b, nm, mode, kw, strict = false) {
    const srch = { inqryDiv: "1", inqryBgnDate: ymd(a), inqryEndDate: ymd(b) };
    if (nm) { srch.insttDivCd = mode === "수요기관" ? "2" : "1"; srch.insttNm = nm; }
    if (kw) srch.cntrctNm = kw;
    try {
      let out = await this.pages(`getCntrctInfoList${kc}PPSSrch`, srch);
      if (nm && mode === "둘 다") out = out.concat(await this.pages(`getCntrctInfoList${kc}PPSSrch`, Object.assign({}, srch, { insttDivCd: "2" })));
      return out;
    } catch (e) {
      if (strict || /인증키|중지/.test(e.message)) throw e;
      this.log(`  · 검색조건 조회 불가(${e.message}) → 기간 전체 조회 후 거릅니다`);
    }
    return this.pages(`getCntrctInfoList${kc}`, { inqryDiv: "1", inqryBgnDt: ymd(a) + "0000", inqryEndDt: ymd(b) + "2359" });
  }
  /** 전체 기간 한 번에 → 안 되면(또는 0건) 월별로 4개씩 동시에 */
  async whole(kind, d1, d2, nm, mode, kw) {
    const kc = G2B_KINDS[kind];
    if (this.stop.v) return [];
    if (daysBetween(d1, d2) > 31 && !this.monthlyOnly) {
      try {
        const got = await this.chunk(kc, d1, d2, nm, mode, kw, true);
        if (got.length) { this.log(`  · 나라장터 ${kind} '${nm || "전체"}' 전체 기간 한 번에 조회 완료`); return got; }
      } catch (e) {
        if (/인증키|중지/.test(e.message)) throw e;
        this.monthlyOnly = true;
        this.log("  · 나라장터는 한 달씩만 조회됩니다 → 월별로 나눠 동시에 조회합니다");
      }
    }
    const res = await pool(monthChunks(d1, d2), 4, ([a, b]) => this.chunk(kc, a, b, nm, mode, kw));
    return [].concat(...res);
  }
  async search(d1, d2, kinds, insts, mode, kw) {
    const tasks = [];
    for (const kind of kinds) for (const nm of (insts.length ? insts : [""])) tasks.push([kind, nm]);
    const res = [await this.whole(tasks[0][0], d1, d2, tasks[0][1], mode, kw)];   // 첫 조회로 주소 확인
    res.push(...await pool(tasks.slice(1), 4, ([kind, nm]) => this.whole(kind, d1, d2, nm, mode, kw)));
    const rows = [], seen = new Set();
    tasks.forEach(([kind, nm], i) => {
      let n = 0;
      for (const it of res[i]) {
        const r = g2bRow(it, kind);
        if (!g2bKeep(r, it, nm, mode, kw)) continue;
        const key = `${r.계약번호}|${r.계약차수}|${r.계약금액}`;
        if (seen.has(key)) continue;
        seen.add(key); rows.push(r); n++;
      }
      this.log(`[나라장터] ${kind} '${nm || "전체"}' : ${n}건`);
    });
    return rows;
  }

  // ── 기관 정보: 사용자정보서비스 getDminsttInfo02 (조회구분 + 기간 필수)
  async usr(params) {
    const bases = this.usrBase ? [this.usrBase] : G2B_USR_BASES;
    let last = ["", []];
    for (const b of bases) {
      let txt;
      try { txt = await this.get(`${b}/getDminsttInfo02`, Object.assign({}, params, { numOfRows: "100", pageNo: "1" }), 2); }
      catch (e) { if (/중지/.test(e.message)) throw e; continue; }
      const p = g2bParse(txt);
      if (p.code === "00" || p.code === "03") { this.usrBase = b; return [p.code, p.items]; }
      last = [`${p.code} ${p.msg}`, []];
      if (["20", "30", "31"].includes(p.code) || /SERVICE_KEY/.test(p.msg)) return ["KEY", []];
    }
    return last;
  }
  static pickInst(items, code, name) {
    if (!items.length) return null;
    const live = items.filter(x => pick(x, "dltYn") !== "Y");
    const L = live.length ? live : items;
    const byCode = code && L.find(x => pick(x, "dminsttCd") === code);
    if (byCode) return byCode;
    if (name) {
      const k = norm(name);
      return L.find(x => norm(pick(x, "dminsttNm")) === k) || L.find(x => norm(pick(x, "dminsttNm")).endsWith(k)) || null;
    }
    return null;
  }
  /** 처음 한 번: API가 결과를 주는 최대 기간과 기관코드 조건 동작 확인 */
  async discover() {
    if (this.span != null) return this.span;
    const now = new Date(), notes = [];
    let span = 0, sample = null;
    for (const [days, label] of [[7, "7일"], [31, "1개월"], [92, "3개월"], [183, "6개월"], [366, "1년"], [1830, "5년"]]) {
      const b = new Date(now - days * 86400000);
      const [res, items] = await this.usr({ inqryDiv: "2", inqryBgnDt: ymd(b) + "0000", inqryEndDt: nowYmdhm() });
      notes.push(`[점검] 조건 없이 최근 ${label} → 결과 ${res || "응답없음"}, ${items.length}건`);
      if (res === "KEY") { this.usrOk = false; break; }
      if (items.length) { span = days; sample = sample || items[0]; } else break;
    }
    this.codeOk = true;
    if (sample && pick(sample, "dminsttCd")) {
      const c0 = pick(sample, "dminsttCd");
      const [, items] = await this.usr({ inqryDiv: "2", dminsttCd: c0, inqryBgnDt: ymd(new Date(now - 7 * 86400000)) + "0000", inqryEndDt: nowYmdhm() });
      this.codeOk = items.some(x => pick(x, "dminsttCd") === c0) && items.length < 100;
      notes.push(`[점검] 기관코드 조건 확인 (${pick(sample, "dminsttNm")} ${c0}) → ${items.length}건, ${this.codeOk ? "코드 조건 정상" : "코드 조건 이상"}`);
    }
    this.span = span; this.usrNotes = notes;
    notes.forEach(n => this.log("  · 사용자정보서비스 " + n));
    if (span) this.log(`  · 사용자정보서비스는 한 번에 최대 약 ${span}일까지 조회됨 → 이 단위로 나눠 찾습니다`);
    return span;
  }
  async instInfo(code, full, short) {
    const key = code || full || short;
    if (!key || !this.usrOk) return null;
    if (this.cache.has(key)) return this.cache.get(key);
    if (!this.disk) this.disk = instStore.load();
    if (this.disk[key]) { this.cache.set(key, this.disk[key]); return this.disk[key]; }
    const span = await this.discover();
    if (this.usrSkip) {
      if (!this.skipLogged) { this.skipLogged = true; this.log("  · 첫 기관의 사업자번호를 찾지 못해, 시간 절약을 위해 나머지 기관은 생략합니다"); }
      return null;
    }
    if (!this.usrOk || !span) { this.cache.set(key, null); return null; }
    const diag = !this.diagDone;
    this.diagDone = true;
    const notes = diag ? [...(this.usrNotes || [])] : [];
    const cond = code && this.codeOk ? { dminsttCd: code } : { dminsttNm: full || short };
    // 구간: 현재 → 1985년, span 일 단위
    const wins = [], limit = new Date(1985, 0, 1);
    let end = new Date();
    while (end > limit) {
      const bgn = new Date(Math.max(end - span * 86400000, limit));
      wins.push([bgn, end]);
      end = new Date(bgn - 60000);
    }
    const y95 = new Date(1995, 0, 1), y04 = new Date(2004, 11, 31);
    const mid = wins.filter(([a, b]) => b >= y95 && a <= y04), nw = wins.filter(([a]) => a > y04), old = wins.filter(([, b]) => b < y95);
    const tries = wins.slice(0, 3).map(w => ["2", w]).concat(mid.concat(nw, old).map(w => ["1", w])).slice(0, 150);
    let found = null, n = 0;
    const hm = d => ymd(d) + pad2(d.getHours()) + pad2(d.getMinutes());
    for (const [div, [bgn, end2]] of tries) {
      if (this.stop.v) break;
      const [res, items] = await this.usr(Object.assign({}, cond, { inqryDiv: div, inqryBgnDt: hm(bgn), inqryEndDt: hm(end2) }));
      n++;
      if (res === "KEY") { this.usrOk = false; break; }
      found = G2BClient.pickInst(items, cond.dminsttCd ? code : "", short || full);
      if (found) { notes.push(`찾음: 조회구분${div} ${JSON.stringify(cond)} ${isoD(bgn)}~${isoD(end2)} (${n}번째 조회)`); break; }
    }
    if (!found) { notes.push(`못 찾음: ${JSON.stringify(cond)} 로 ${n}번 조회 (1985년~현재, ${span}일 단위)`); if (diag) this.usrSkip = true; }
    if (diag) this.diagText = `기관: ${full || short} / 코드 ${code}\n` + notes.join("\n");
    this.log(`  · 사업자번호 [${short || full}] ${notes[notes.length - 1] || ""}`);
    const info = found ? { 사업자번호: fmtBizno(pick(found, "bizno")), 전화번호: pick(found, "telNo"), 팩스: pick(found, "faxNo"),
      주소: [pick(found, "adrs"), pick(found, "dtlAdrs")].filter(Boolean).join(" ") } : null;
    this.cache.set(key, info);
    if (info && info.사업자번호) { this.disk[key] = info; instStore.save(this.disk); }
    return info;
  }
}

// ───────────────────────── 학교장터 ─────────────────────────
const S2B_BASE = "https://www.s2b.kr/S2BNCustomer/";
const S2B_EDU = { 서울: [["SU"], "서울", "서울특별시"], 경기: [["GG"], "경기", "경기도"], 인천: [["IC", "IN", "IH"], "인천", "인천광역시"] };

function htmlRows(html) {
  const rows = [];
  for (const tr of String(html).split(/<tr[\s>]/i).slice(1)) {
    const body = tr.split(/<\/tr>/i)[0];
    rows.push([...body.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m =>
      m[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim()));
  }
  return rows;
}
function parseS2bList(html) {
  const rows = htmlRows(html), out = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.length === 6 && /^\d+$/.test(a[0]) && b.length === 4 && /^20\d\d-\d\d-\d\d/.test(b[3] || b[2] || "")) {
      out.push({ 계약방법: a[1], 계약번호: a[2], 계약명: a[3], 계약금액: a[4], 계약상대자: a[5],
        거래구분: b[0], 기관명: b[1], 공고일자: b[2], 계약일자: b[3] });
      i++;
    }
  }
  const pages = [...String(html).matchAll(/goList\((\d+)\)/g)].map(m => +m[1]);
  return { rows: out, last: pages.length ? Math.max(...pages) : 1 };
}
/** 실제로 뜨는 오류 창 문구만. 학교장터 정상 화면에도 입력검사용 alert 문장이 함수 안에 늘 들어 있음 */
function pageAlert(html) {
  const h = String(html || "");
  if (h.includes("tcmo001Form") && (h.includes("td_list_tit_01") || h.includes("goList"))) return "";
  const body = h.replace(/function\s+\w+\s*\([^)]*\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  const m = body.match(/alert\(['"]([^'"]{4,120})['"]\)/);
  return m ? m[1] : "";
}

function s2bForm(region, kw, inst, d1, d2, page) {
  const [, name, full] = S2B_EDU[region];
  const fd = d => ymd(d);
  const f = { forwardName: "eduEstiNTenderContList", pageNo: page, tender_num: "", tender_step_code: "",
    page_flag: "", excelSection: "N", eduName: name, eduFullName: full, eduFrame: "f", contSection: "e",
    contAmount: "0", tbWidth: "680", tender_sep1: "1", tender_name: (kw || "").slice(0, 30),
    company_name_s: (inst || "").slice(0, 30), tender_sep2: "2",
    tender_date_start: fd(d1), tender_date_end: fd(d2), tender_item: "", estimate_kind: "" };
  for (let i = 1; i < 8; i++) f[`leftMenuCheck${i}`] = "1";
  return f;
}
function s2bRow(r, region) {
  const chg = r.계약명.match(/(\d+)\s*차\s*변경|변경\s*(\d+)\s*차/);
  return { 출처: "학교장터", 구분: r.거래구분, 지역: region, "계약(발주)기관": r.기관명, 수요기관: r.기관명,
    담당자: "", 전화번호: "", 계약차수: chg ? `${chg[1] || chg[2]}차 변경` : "최초",
    계약일: fmtDate(r.계약일자), 완수일: "", 계약금액: toInt(r.계약금액), "계약상대 상호": r.계약상대자,
    계약명: r.계약명, 계약방법: r.계약방법, 계약번호: r.계약번호 };
}
const eucDecode = bytes => new TextDecoder("euc-kr").decode(bytes);

class S2BClient {
  constructor(log, stop) {
    this.log = log; this.stop = stop; this.sample = ""; this.dateSample = "";
    this.failed = [];
  }
  async open(url, form) {
    let last;
    for (let k = 0; k < 2; k++) {
      if (this.stop.v) throw new Error("중지됨");
      try {
        const ref = { Referer: S2B_BASE + "S2B/scrweb/eduInterface/eduInterface.jsp", "Accept-Language": "ko-KR" };
        const r = form
          ? await http({ url, method: "POST", body: formEncode(form), binary: true, timeout: 60000,
              headers: Object.assign({ "Content-Type": "application/x-www-form-urlencoded" }, ref) })
          : await http({ url, binary: true, headers: ref, timeout: 60000 });
        await sleep(200);
        return eucDecode(r.data);
      } catch (e) { last = e; await sleep(3000); }
    }
    throw new Error(`학교장터 접속 실패: ${last && last.message}`);
  }
  async session(region) {
    const [codes, name] = S2B_EDU[region];
    for (const es of codes.concat(["GG"])) {
      let html;
      try { html = await this.open(`${S2B_BASE}S2B/scrweb/eduInterface/eduInterface.jsp?ES=${es}&EF=f&CS=e&MC=9`); }
      catch (e) { if (/중지/.test(e.message)) throw e; continue; }
      const m = html.match(/name="eduName"\s+value="([^"]*)"/);
      if (m && (m[1] === name || es === "GG")) return;
    }
    throw new Error(`${region} 학교장터 화면을 열 수 없습니다`);
  }
  /** 한 쪽 조회. '날짜' 안내가 나오면 같은 형식(YYYYMMDD)으로 새로 접속해 최대 2번 다시 시도.
   *  그래도 안 되면 0건으로 넘기지 않고 '조회 실패'로 처리 */
  async fetchPage(region, kw, nm, a, b, pg) {
    let html = await this.open(S2B_BASE + "tcmo001.do", s2bForm(region, kw, nm, a, b, pg));
    for (let k = 0; k < 2; k++) {
      if (!pageAlert(html).includes("날짜")) return html;
      if (!this.dateSample) this.dateSample = html;
      await sleep(2000 + 3000 * k);
      await this.session(region);
      html = await this.open(S2B_BASE + "tcmo001.do", s2bForm(region, kw, nm, a, b, pg));
    }
    if (pageAlert(html).includes("날짜")) throw new Error("날짜 오류 안내가 반복됨");
    return html;
  }
  async month(region, nm, a, b, kw) {
    const out = [];
    if (this.stop.v) return out;
    let pg = 1, last = 1, got = 0;
    try {
      await this.session(region);
      while (!this.stop.v) {
        const html = await this.fetchPage(region, kw, nm, a, b, pg);
        const p = parseS2bList(html);
        last = Math.max(last, p.last);
        if (!this.sample) this.sample = html;
        if (pg === 1 && !p.rows.length) { const al = pageAlert(html); if (al) this.log(`  · [${region}] 학교장터 안내: ${al}`); }
        for (const r of p.rows) {
          if (kw && !norm(r.계약명).includes(norm(kw))) continue;
          if (nm && !nameMatch(nm, [r.기관명])) continue;
          out.push(s2bRow(r, region)); got++;
        }
        if (pg >= last || !p.rows.length) break;
        pg++;
      }
      this.log(`[학교장터] ${region} ${isoD(a)}~${isoD(b).slice(5)} '${nm || "전체"}' : ${got}건`);
    } catch (e) {
      if (!/중지/.test(e.message)) {
        const why = /날짜/.test(e.message) ? "날짜 오류" : "응답 없음";
        this.failed.push(`${region} ${pad2(a.getMonth() + 1)}월 '${nm || "전체"}' (${why})`);
        this.log(`  ✗ [학교장터] ${region} ${isoD(a)}~${isoD(b).slice(5)} '${nm || "전체"}' 조회 실패 — ${why} (0건이 아니라 확인 못 함)`);
      }
      return [];
    }
    return out;
  }
  /** jobs: [[지역, 학교명], ...] — 학교별로 1개월씩, 3개월치를 동시에 */
  async search(jobs, d1, d2, kw) {
    const parts = await pool(jobs, 2, ([rg, nm]) =>
      pool(monthChunks(d1, d2), 3, ([a, b]) => this.month(rg, nm, a, b, kw)).then(x => [].concat(...x)));
    if (this.failed.length)
      this.log(`  ※ 학교장터 조회 실패 ${this.failed.length}건: ${this.failed.join(", ")} → 잠시 뒤 다시 조회하세요`);
    const out = [], seen = new Set();
    for (const r of [].concat(...parts)) {
      const key = `${r.계약번호}|${r.계약일}|${r.계약금액}`;
      if (seen.has(key)) continue;
      seen.add(key); out.push(r);
    }
    return out;
  }
}

// ───────────────────────── 결과 정리 ─────────────────────────
function fillInst(r, c) {
  const org = r["계약(발주)기관"] || "", dm = r.수요기관 || "";
  let t = null;
  for (const nm of c.insts) {
    if (c.mode !== "수요기관" && nameMatch(nm, [org])) { t = ["계약기관", org]; break; }
    if (c.mode !== "계약기관" && nameMatch(nm, [dm])) { t = ["수요기관", dm]; break; }
  }
  if (!t) t = c.mode === "수요기관" ? ["수요기관", dm] : ["계약기관", org];
  r.기관구분 = r.출처 === "학교장터" ? "학교장터" : (t[0] === "계약기관" ? "발주기관" : "수요기관");
  r["기관 상호"] = shortSchool(t[1].split(",")[0].trim());
  r._정식명 = t[1].split(",")[0].trim();
  r["사업자번호(고유번호)"] = r["사업자번호(고유번호)"] || "";
}
function fillFromSameInst(rows) {
  const known = new Map();
  for (const r of rows) if (r.담당자 || r["사업자번호(고유번호)"]) { const k = norm(r["기관 상호"]); if (!known.has(k)) known.set(k, r); }
  for (const r of rows) {
    const s = known.get(norm(r["기관 상호"]));
    if (s && s !== r) for (const f of ["사업자번호(고유번호)", "담당자", "전화번호", "기관 팩스", "기관 주소"])
      if (!r[f] && s[f]) r[f] = s[f] + (f === "담당자" || f === "전화번호" ? " *" : "");
  }
}
/** 나라장터 결과로 학교 지역을 알아내 학교장터 조회 목록 만들기 */
function s2bJobs(c, rows, log) {
  const jobs = [];
  for (const nm of (c.insts.length ? c.insts : [""])) {
    const regs = new Set();
    if (nm) for (const r of rows)
      if (nameMatch(nm, [r["계약(발주)기관"], r.수요기관])) {
        const rg = regionOf(r["계약(발주)기관"]) || regionOf(r.수요기관);
        if (rg) regs.add(rg);
      }
    if (regs.size && !regs.has("서울")) { log(`  · '${nm || "전체"}'은(는) ${[...regs].sort().join("·")} 학교 → 학교장터 조회 생략 (서울만 조회)`); continue; }
    if (nm && !regs.size) log(`  · '${nm}'은(는) 나라장터 계약이 없어 지역 확인 불가 → 학교장터 서울에서 조회`);
    jobs.push(["서울", nm]);
  }
  if (!jobs.length) log("  · 학교장터 조회 대상(서울 학교)이 없어 건너뜁니다");
  return jobs;
}
/** 전체 조회 흐름 (화면 없이도 시험 가능) */
async function runAll(c, log, stop) {
  const t0 = Date.now();
  let rows = [], g = null, s = null;
  const errs = [];
  if (c.g2b) {
    try { g = new G2BClient(c.key, log, stop); rows = preferExact(rows.concat(await g.search(c.d1, c.d2, c.kinds, c.insts, c.mode, c.kw)), c.insts, log); }
    catch (e) { errs.push("나라장터: " + e.message); log("✗ 나라장터 오류: " + e.message); }
  }
  if (c.s2b && !stop.v) {
    s = new S2BClient(log, stop);
    const jobs = s2bJobs(c, rows, log);
    try { if (jobs.length) rows = rows.concat(await s.search(jobs, c.d1, c.d2, c.kw)); }
    catch (e) { errs.push("학교장터: " + e.message); log("✗ 학교장터 오류: " + e.message); }
  }
  rows.forEach(r => fillInst(r, c));
  if (g && c.biz && rows.length && !stop.v) {
    log("기관 사업자번호(고유번호) 조회 중…");
    const uniq = new Map();
    const g2bInst = new Set(rows.filter(r => r.출처 === "나라장터").map(r => norm(r["기관 상호"])));
    for (const r of rows) {
      if (r.출처 === "학교장터" && g2bInst.has(norm(r["기관 상호"]))) continue;   // 같은 학교는 나라장터 쪽 정보로 채움
      const code = r.기관구분 === "수요기관" ? r.수요기관코드 : r.계약기관코드;
      const k = [code || "", r._정식명 || "", r["기관 상호"]].join("|");
      if (!uniq.has(k)) uniq.set(k, []);
      uniq.get(k).push(r);
    }
    const keys = [...uniq.keys()];
    const infos = new Map();
    infos.set(keys[0], await g.instInfo(...keys[0].split("|")));
    if (g.usrOk && keys.length > 1) {
      const res = await pool(keys.slice(1), 4, k => g.instInfo(...k.split("|")));
      keys.slice(1).forEach((k, i) => infos.set(k, res[i]));
    }
    for (const [k, rs] of uniq) {
      const info = infos.get(k);
      if (!info) continue;
      for (const r of rs) {
        if (info.사업자번호) r["사업자번호(고유번호)"] = info.사업자번호;
        if (!r.전화번호 && info.전화번호) r.전화번호 = info.전화번호;
        r["기관 팩스"] = info.팩스 || ""; r["기관 주소"] = info.주소 || "";
      }
    }
    log(`  · 사업자번호 확인: 기관 ${keys.length}곳 중 ${[...infos.values()].filter(x => x && x.사업자번호).length}곳`);
  }
  rows = preferExact(rows, c.insts);
  fillCorpBiz(rows);
  fillFromSameInst(rows);
  rows.forEach(r => delete r._정식명);
  rows.sort((a, b) => (a["기관 상호"] + a.계약일 + a.계약명).localeCompare(b["기관 상호"] + b.계약일 + b.계약명, "ko"));
  return { rows, errs, sec: Math.round((Date.now() - t0) / 1000),
    diag: { 사용자정보: g ? g.diagText : "", 학교장터: s ? s.sample : "", 학교장터_날짜오류: s ? s.dateSample : "" } };
}

// ───────────────────────── 엑셀 ─────────────────────────
const COLS = ["출처", "기관구분", "기관 상호", "사업자번호(고유번호)", "담당자", "전화번호", "기관 팩스", "기관 주소",
  "계약차수", "계약일", "완수일", "계약금액", "계약상대 상호", "계약상대 사업자번호", "계약상대 대표자", "계약명",
  "계약방법", "계약번호", "계약(발주)기관", "수요기관"];
const COL_W = [7, 8, 18, 14, 8, 14, 14, 32, 10, 11, 11, 12, 18, 14, 10, 40, 12, 18, 26, 26];

function buildWorkbook(XLSX, rows, cond) {
  const aoa = [["학교장터·나라장터 계약 상세 조회"], [cond], [], COLS];
  for (const r of rows) aoa.push(COLS.map(c => r[c] ?? ""));
  const total = rows.reduce((s, r) => s + (r.계약금액 || 0), 0);
  aoa.push(COLS.map(c => c === "완수일" ? "합계" : c === "계약금액" ? total : ""));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = COL_W.map(w => ({ wch: w }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3 + rows.length, c: COLS.length - 1 } }) };
  const ci = COLS.indexOf("계약금액");
  for (let i = 4; i <= 4 + rows.length; i++) { const cell = ws[XLSX.utils.encode_cell({ r: i, c: ci })]; if (cell && cell.t === "n") cell.z = "#,##0"; }

  const summ = new Map();
  for (const r of rows) {
    const k = r["기관 상호"];
    if (!summ.has(k)) summ.set(k, { 건수: 0, 합계: 0, 사업자번호: "", 담당자: "", 전화번호: "", 팩스: "", 주소: "", 업체: new Set() });
    const d = summ.get(k);
    d.건수++; d.합계 += r.계약금액 || 0;
    for (const [f, c] of [["사업자번호", "사업자번호(고유번호)"], ["담당자", "담당자"], ["전화번호", "전화번호"], ["팩스", "기관 팩스"], ["주소", "기관 주소"]])
      if (!d[f] && r[c]) d[f] = r[c];
    if (r["계약상대 상호"]) d.업체.add(r["계약상대 상호"]);
  }
  const a2 = [["기관 상호", "사업자번호(고유번호)", "담당자", "전화번호", "팩스", "주소", "계약 건수", "계약금액 합계", "계약상대 상호"]];
  for (const [k, d] of [...summ.entries()].sort((x, y) => x[0].localeCompare(y[0], "ko")))
    a2.push([k, d.사업자번호, d.담당자, d.전화번호, d.팩스, d.주소, d.건수, d.합계, [...d.업체].sort().join(", ")]);
  const ws2 = XLSX.utils.aoa_to_sheet(a2);
  ws2["!cols"] = [24, 16, 10, 15, 15, 40, 10, 16, 50].map(w => ({ wch: w }));
  for (let i = 1; i < a2.length; i++) { const cell = ws2[XLSX.utils.encode_cell({ r: i, c: 7 })]; if (cell) cell.z = "#,##0"; }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "계약 상세");
  XLSX.utils.book_append_sheet(wb, ws2, "기관별 요약");
  return wb;
}

// ───────────────────────── 화면 ─────────────────────────
if (typeof document !== "undefined") {
  const $ = id => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("cs_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("cs_" + k, JSON.stringify(v)); } catch { /* 무시 */ } },
  };
  let RESULTS = [], COND = null, DIAG = null;
  const stop = { v: false };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function log(msg) {
    const box = $("log"), t = new Date();
    box.textContent += `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}  ${msg}\n`;
    box.scrollTop = box.scrollHeight;
    $("status").textContent = msg.replace(/^\s*·\s*/, "");
  }
  function toast(msg) {
    const el = $("toast"); el.textContent = msg; el.classList.add("show");
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 2800);
  }
  function setRange(kind) {
    const t = new Date(); let a, b = t;
    if (kind === "year") a = new Date(t.getFullYear(), 0, 1);
    else if (kind === "last") { a = new Date(t.getFullYear() - 1, 0, 1); b = new Date(t.getFullYear() - 1, 11, 31); }
    else a = new Date(t.getFullYear(), t.getMonth() - 3, t.getDate());
    $("d1").value = isoD(a); $("d2").value = isoD(b);
  }
  function loadForm() {
    const t = new Date();
    $("d1").value = store.get("d1", `${t.getFullYear()}-01-01`);
    $("d2").value = store.get("d2", isoD(t));
    $("insts").value = store.get("insts", "");
    $("kw").value = store.get("kw", "");
    $("key").value = store.get("key", "");
    const mode = store.get("mode", "계약기관");
    document.querySelectorAll("input[name=mode]").forEach(x => { x.checked = x.value === mode; });
    const kinds = store.get("kinds", ["용역"]);
    document.querySelectorAll("input[name=kind]").forEach(x => { x.checked = kinds.includes(x.value); });
    $("g2b").checked = store.get("g2b", true);
    $("s2b").checked = store.get("s2b", true);
    $("biz").checked = store.get("biz", true);
    if (!$("key").value) $("setPanel").open = true;
  }
  function readCond() {
    const d1 = parseDate($("d1").value), d2 = parseDate($("d2").value);
    if (!d1 || !d2 || d1 > d2) throw new Error("계약기간을 바르게 입력하세요.");
    const insts = [...new Set($("insts").value.split(/[\n,]/).map(x => x.trim()).filter(Boolean))];
    const kw = $("kw").value.trim();
    if (!insts.length && !kw) throw new Error("기관명(학교명)이나 계약명 중 하나는 입력하세요.");
    const mode = (document.querySelector("input[name=mode]:checked") || {}).value || "계약기관";
    const kinds = [...document.querySelectorAll("input[name=kind]:checked")].map(x => x.value);
    const sregions = ["서울"];
    const g2b = $("g2b").checked, s2b = $("s2b").checked, key = $("key").value.trim(), biz = $("biz").checked;
    if (!g2b && !s2b) throw new Error("조회 출처를 하나 이상 선택하세요.");
    if (g2b && !key) { $("setPanel").open = true; throw new Error("설정에서 나라장터 인증키를 입력하세요."); }
    if (g2b && !kinds.length) throw new Error("나라장터 업무구분을 하나 이상 선택하세요.");
    Object.entries({ d1: $("d1").value, d2: $("d2").value, insts: $("insts").value, kw, key, mode, kinds, sregions, g2b, s2b, biz })
      .forEach(([k, v]) => store.set(k, v));
    return { d1, d2, insts, kw, mode, kinds, sregions, g2b, s2b, key, biz };
  }
  function render() {
    const q = norm($("filter").value);
    const rows = q ? RESULTS.filter(r => norm(Object.values(r).join(" ")).includes(q)) : RESULTS;
    const total = rows.reduce((s, r) => s + (r.계약금액 || 0), 0);
    $("summary").innerHTML = RESULTS.length
      ? `<b>${rows.length.toLocaleString()}</b>건 · 합계 <b>${won(total)}</b>원` +
        `<span class="muted"> (나라장터 ${rows.filter(r => r.출처 === "나라장터").length} · 학교장터 ${rows.filter(r => r.출처 === "학교장터").length})</span>`
      : "";
    $("resultBar").hidden = !RESULTS.length;
    $("list").innerHTML = rows.map(r => {
      const tel = (r.전화번호 || "").replace(/\s*\*$/, "");
      const telHtml = tel ? `<a href="tel:${tel.replace(/[^\d]/g, "")}">${esc(r.전화번호)}</a>` : "-";
      const corp = r["계약상대 상호"] || "-";
      const corpSub = [r["계약상대 대표자"], r["계약상대 사업자번호"]].filter(Boolean).join(" · ");
      return `<article class="card">
        <header><span class="badge ${r.출처 === "나라장터" ? "g" : "s"}">${r.출처}</span>
          <span class="inst">${esc(r["기관 상호"])}</span><span class="kind">${esc(r.기관구분 || "")}</span></header>
        <div class="title">${esc(r.계약명)}</div>
        <div class="amt">${won(r.계약금액)}<small>원</small></div>
        <dl>
          <dt>계약상대</dt><dd>${esc(corp)}${corpSub ? `<br><span class="muted">${esc(corpSub)}</span>` : ""}</dd>
          <dt>계약일</dt><dd>${esc(r.계약일 || "-")}${r.완수일 ? ` ~ ${esc(r.완수일)}` : ""}</dd>
          <dt>차수</dt><dd>${esc(r.계약차수 || "-")}${r.계약방법 ? ` · ${esc(r.계약방법)}` : ""}</dd>
          <dt>담당자</dt><dd>${esc(r.담당자 || "-")} · ${telHtml}</dd>
          <dt>사업자번호</dt><dd>${esc(r["사업자번호(고유번호)"] || "-")}</dd>
          ${r["기관 팩스"] ? `<dt>팩스</dt><dd>${esc(r["기관 팩스"])}</dd>` : ""}
          ${r["기관 주소"] ? `<dt>주소</dt><dd>${esc(r["기관 주소"])}</dd>` : ""}
        </dl></article>`;
    }).join("") || (RESULTS.length ? `<p class="empty">검색어에 맞는 결과가 없습니다.</p>` : "");
  }

  async function runSearch() {
    let c;
    try { c = readCond(); } catch (e) { toast(e.message); return; }
    COND = c; RESULTS = []; render(); stop.v = false;
    $("log").textContent = "";
    log(nativeHttp() ? "통신: 휴대폰 직접 연결" : "통신: 브라우저 (휴대폰 앱이 아니면 조회가 안 될 수 있음)");
    $("run").hidden = true; $("stop").hidden = false; $("spin").hidden = false;
    $("logPanel").open = true; $("formPanel").open = false;
    const { rows, errs, sec, diag } = await runAll(c, log, stop);
    RESULTS = rows; DIAG = diag;
    $("run").hidden = false; $("stop").hidden = true; $("spin").hidden = true;
    const total = rows.reduce((s, r) => s + (r.계약금액 || 0), 0);
    const nG = rows.filter(r => r.출처 === "나라장터").length;
    log(`${stop.v ? "중지됨 — " : "완료: "}총 ${rows.length}건 (나라장터 ${nG} · 학교장터 ${rows.length - nG})  합계 ${won(total)}원 · 소요 ${Math.floor(sec / 60)}분 ${sec % 60}초`);
    if (rows.some(r => / \*$/.test((r.담당자 || "") + (r.전화번호 || "")))) log("  ※ '*' = 같은 기관의 나라장터 계약에서 가져온 담당자·전화");
    render();
    if (rows.length) $("logPanel").open = false;
    if (errs.length && !rows.length) toast(errs[0]);
  }

  async function saveFile(name, b64, mime, share = true) {
    const FS = nativePlugin("Filesystem"), SH = nativePlugin("Share");
    const P = FS ? { Filesystem: FS, Share: SH } : null;
    if (P && P.Filesystem) {
      let uri = null;
      for (const dir of ["DOCUMENTS", "CACHE"]) {
        try {
          const r = await P.Filesystem.writeFile({ path: dir === "DOCUMENTS" ? `계약조회/${name}` : name, data: b64, directory: dir, recursive: true });
          uri = r.uri; if (dir === "DOCUMENTS") toast(`저장됨: 문서/계약조회/${name}`); break;
        } catch { /* 다음 위치 */ }
      }
      if (uri && share && P.Share) {
        try { await P.Share.share({ title: name, text: name, files: [uri], dialogTitle: "파일 보내기/열기" }); } catch { /* 취소 */ }
      }
      return;
    }
    const a = document.createElement("a");
    a.href = `data:${mime};base64,${b64}`; a.download = name; a.click();
  }
  const utf8b64 = s => btoa(unescape(encodeURIComponent(s)));

  async function exportExcel() {
    if (!RESULTS.length) { toast("저장할 결과가 없습니다."); return; }
    const c = COND;
    let tag = c.insts[0] || c.kw || "계약";
    if (c.insts.length > 1) tag += `_외${c.insts.length - 1}곳`;
    const name = `계약상세_${tag}_${ymd(new Date())}.xlsx`.replace(/[\\/:*?"<>|]/g, "");
    const cond = `계약기간 ${isoD(c.d1)} ~ ${isoD(c.d2)} | 기관 ${c.insts.slice(0, 5).join(", ") || "전체"}${c.insts.length > 5 ? " 외" : ""} (${c.mode}) | 계약명 '${c.kw || "전체"}' | 조회일 ${isoD(new Date())}`;
    const wb = buildWorkbook(window.XLSX, RESULTS, cond);
    await saveFile(name, window.XLSX.write(wb, { bookType: "xlsx", type: "base64" }),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  async function shareDiag() {
    if (!DIAG) { toast("한 번 조회한 뒤 사용하세요."); return; }
    const txt = `[진행 기록]\n${$("log").textContent}\n\n[사용자정보 응답기록]\n${DIAG.사용자정보 || "-"}\n\n` +
      `[학교장터 날짜오류 응답]\n${DIAG.학교장터_날짜오류 || "-"}\n\n[학교장터 응답샘플]\n${DIAG.학교장터 || "-"}`;
    await saveFile(`조회_응답기록_${ymd(new Date())}.txt`, utf8b64(txt), "text/plain");
  }

  document.addEventListener("DOMContentLoaded", () => {
    loadForm();
    $("run").onclick = runSearch;
    $("stop").onclick = () => { stop.v = true; log("중지 요청…"); };
    $("xls").onclick = exportExcel;
    $("filter").oninput = render;
    $("sample").onclick = shareDiag;
    document.querySelectorAll("[data-range]").forEach(b => { b.onclick = () => setRange(b.dataset.range); });
    $("key").onchange = () => store.set("key", $("key").value.trim());
  });
}

// node 시험용
if (typeof module !== "undefined") module.exports = {
  encEuckr, formEncode, parseS2bList, s2bForm, s2bRow, g2bParse, g2bRow, g2bKeep, monthChunks, fillInst,
  fillFromSameInst, preferExact, fillCorpBiz, pageAlert, buildWorkbook, cntrctOrder, corpFromList, dminsttFromList, regionOf, s2bJobs, runAll,
  G2BClient, S2BClient, setHttp: f => { HTTP_IMPL = f; } };
