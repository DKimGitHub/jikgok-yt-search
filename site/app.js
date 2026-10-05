// 내용 검색: Ctrl-F over transcript segments (search.js) + YouTube IFrame player.
import { findSegments, loadSegments, loadText, markMatches, normalize } from "./search.js";

const $ = (s) => document.querySelector(s);
const el = {
  q: $("#q"), type: $("#f-type"), year: $("#f-year"), sort: $("#f-sort"),
  count: $("#count"), hits: $("#hits"), more: $("#more"), empty: $("#empty"),
  panel: $("#panel"), nowTitle: $("#now-title"), nowPos: $("#now-pos"),
  prev: $("#prev"), next: $("#next"), openYt: $("#open-yt"),
};
const PAGE_SIZE = 10;
const MOMENTS_SHOWN = 3;

let scope = "text"; // "text" = 내용 (transcript Ctrl-F) | "title" = 제목 (titles.json)
let titles = null;   // lazily loaded rows: {vid, title, date, duration, type, page, key}
const filterCounts = { text: null, title: null };
let results = [];
let resultKind = "content"; // "content" (내용 hits) | "titles" (title rows: 제목 search or browsing)
let shown = 0;
let searchSeq = 0;
// The video currently in the player, and the matched moments inside it.
const now = { vid: null, title: "", moments: [], idx: 0 };

// ------------------------------------------------------------------ utils

const fmtTime = (sec) => {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = h ? String(m).padStart(2, "0") : m;
  return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
};
const LIVE = "라이브 · ";
const yearOf = (date) => (date ? date.slice(0, 4) : "unknown");
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const h = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "html") n.innerHTML = v; // only for markMatches/escapeHtml output
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
};

// ----------------------------------------------------------------- search

async function init() {
  loadStats();
  await loadTitles();

  const p = new URLSearchParams(location.search);
  if (p.get("in") === "title") await setScope("title", false);
  else fillFilters();
  el.q.value = p.get("q") || "";
  el.type.value = p.get("type") || "";
  el.year.value = p.get("year") || "";
  el.sort.value = p.get("sort") || "";
  if (p.get("v")) playDirect(p.get("v"), Number(p.get("t") || 0));
  search();
}

function fillFilters() {
  // Option counts differ per scope (title search also covers caption-less videos).
  const c = filterCounts[scope] || { type: {}, year: {} };
  const keep = [el.type.value, el.year.value];
  el.type.replaceChildren(h("option", { value: "" }, "모든 유형"));
  el.year.replaceChildren(h("option", { value: "" }, "모든 연도"));
  fillTypes(c.type || {});
  fillSelect(el.year, c.year, (y) => (y === "unknown" ? "미상" : y + "년"), (a, b) => b.localeCompare(a));
  el.type.value = keep[0];
  el.year.value = keep[1];
  // A filter value that doesn't exist in this scope falls back to "전체".
  if (el.type.selectedIndex < 0) el.type.value = "";
  if (el.year.selectedIndex < 0) el.year.value = "";
}

async function loadTitles() {
  if (titles) return;
  const rows = await (await fetch("titles.json")).json();
  titles = rows.map(([vid, title, date, duration, type, page]) =>
    ({ vid, title, date, duration, type, page: page === 1, noCaptions: page === 0, key: normalize(title) }));
  // 제목 counts every video; 내용 counts videos with a transcript.
  for (const [name, rowsIn] of [["title", titles], ["text", titles.filter((t) => t.page)]]) {
    const type = {}, year = {};
    for (const t of rowsIn) {
      type[t.type] = (type[t.type] || 0) + 1;
      year[yearOf(t.date)] = (year[yearOf(t.date)] || 0) + 1;
    }
    filterCounts[name] = { type, year };
  }
}

async function setScope(next, rerun = true) {
  scope = next;
  document.querySelectorAll(".scope button").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.scope === scope)));
  el.q.placeholder = scope === "title" ? "제목 검색" : "내용 검색";
  if (scope === "title") await loadTitles();
  fillFilters();
  if (rerun) search();
}

function fillSelect(select, counts = {}, label, order) {
  for (const key of Object.keys(counts).sort(order)) {
    select.append(h("option", { value: key }, `${label(key)} (${counts[key].toLocaleString("ko-KR")})`));
  }
}

function fillTypes(counts) {
  // Live shows first, then video types by size; "기타" always last.
  const n = (k) => counts[k].toLocaleString("ko-KR");
  const bySize = (a, b) => (a === "기타") - (b === "기타") || counts[b] - counts[a];
  const keys = Object.keys(counts);
  const live = h("optgroup", { label: "라이브" },
    ...keys.filter((k) => k.startsWith(LIVE)).sort(bySize)
      .map((k) => h("option", { value: k }, `${k.slice(LIVE.length)} (${n(k)})`)));
  const vids = h("optgroup", { label: "영상" },
    ...keys.filter((k) => !k.startsWith(LIVE)).sort(bySize)
      .map((k) => h("option", { value: k }, `${k} (${n(k)})`)));
  el.type.append(live, vids);
}

async function loadStats() {
  try {
    const s = await (await fetch("stats.json")).json();
    $("#stats-line").textContent =
      `영상 ${s.videos.toLocaleString("ko-KR")}편, 약 ${s.hours.toLocaleString("ko-KR")}시간 분량의 내용` +
      (s.titles ? `과 영상 ${s.titles.toLocaleString("ko-KR")}편의 제목을 검색할 수 있습니다.` : `을 검색할 수 있습니다.`);
    $("#updated").textContent = `마지막 업데이트: ${s.updated}`;
  } catch { /* stats are optional */ }
}

function syncUrl() {
  const p = new URLSearchParams();
  if (el.q.value.trim()) p.set("q", el.q.value.trim());
  if (scope === "title") p.set("in", "title");
  if (el.type.value) p.set("type", el.type.value);
  if (el.year.value) p.set("year", el.year.value);
  if (el.sort.value) p.set("sort", el.sort.value);
  if (now.vid) p.set("v", now.vid);
  const qs = p.toString();
  history.replaceState(null, "", qs ? "?" + qs : location.pathname);
}

async function search() {
  const seq = ++searchSeq;
  const q = el.q.value.trim();
  syncUrl();
  if (!q) return browse(seq);
  if (scope === "title") return titleSearch(q, seq);
  return contentSearch(q, seq);
}

const passesFilters = (t) =>
  (!el.type.value || t.type === el.type.value) && (!el.year.value || yearOf(t.date) === el.year.value);
const newestFirst = (a, b) => (b.date || "").localeCompare(a.date || "");
const oldestFirst = (a, b) => (a.date || "9").localeCompare(b.date || "9");

async function contentSearch(q, seq) {
  // Ctrl-F: a video matches when the query appears in its title or in one of its
  // ~25 s segments (spaces/punctuation ignored). Every match is listed.
  await new Promise((r) => setTimeout(r, 150)); // let fast typing settle
  if (seq !== searchSeq) return;
  const nq = normalize(q);
  const [segs, table] = await Promise.all([findSegments(q), loadSegments()]);
  if (seq !== searchSeq) return;
  const byVid = new Map(titles.map((t) => [t.vid, t]));
  const hits = new Map();
  const entry = (t) => hits.get(t.vid) || hits.set(t.vid, { row: t, moments: [], titleHit: false }).get(t.vid);
  for (const s of segs) {
    const row = byVid.get(table.ids[table.video[s]]);
    if (row) entry(row).moments.push(table.start[s]);
  }
  if (nq) for (const t of titles) if (t.key.includes(nq)) entry(t).titleHit = true;
  const list = [...hits.values()].filter((e) => passesFilters(e.row));
  if (el.sort.value === "old") list.sort((a, b) => oldestFirst(a.row, b.row));
  else if (el.sort.value === "new") list.sort((a, b) => newestFirst(a.row, b.row));
  // 관련도: title matches first, then most mentions, then newest.
  else list.sort((a, b) => (b.titleHit - a.titleHit) || (b.moments.length - a.moments.length) || newestFirst(a.row, b.row));
  const mentions = list.reduce((n, e) => n + e.moments.length, 0);
  await showResults(list, q, seq, "내용", mentions);
}

async function browse(seq) {
  // An empty search box lists the channel's videos (narrowed by any filter):
  // newest first (관련도 has no meaning without a query), or oldest with 오래된순.
  // 내용 mode lists videos with a transcript, matching the filter's counts.
  await loadTitles();
  if (seq !== searchSeq) return;
  const rows = titles.filter((t) => (scope === "title" || t.page) && passesFilters(t));
  rows.sort(el.sort.value === "old" ? oldestFirst : newestFirst);
  await showResults(rows, "", seq, "목록");
  el.empty.hidden = false; // keep the suggested searches above the list
}

async function showResults(list, q, seq, what, mentions = 0) {
  results = list;
  resultKind = what === "내용" ? "content" : "titles";
  shown = 0;
  el.more.hidden = true; // no auto-load until the first page is in
  el.empty.hidden = true;
  el.hits.replaceChildren();
  el.count.textContent = !results.length ? ""
    : what === "목록" ? `영상 ${results.length.toLocaleString("ko-KR")}편`
    : what === "내용" && mentions ? `${results.length.toLocaleString("ko-KR")}개 영상 · ${mentions.toLocaleString("ko-KR")}곳`
    : `${results.length.toLocaleString("ko-KR")}개 영상에서 찾았습니다`;
  if (!results.length && what === "목록") {
    el.hits.append(h("li", { class: "none" }, h("p", {}, "이 조건에 해당하는 영상이 없습니다.")));
  } else if (!results.length) {
    const target = what === "제목" ? "제목" : "내용";
    el.hits.append(h("li", { class: "none" },
      h("p", {}, `‘${q}’에 해당하는 ${target}을 찾지 못했습니다.`),
      h("p", { class: "sub" }, what === "제목"
        ? "내용 검색으로 바꾸면 영상 속에서 한 말까지 찾아봅니다."
        : "다른 표현이나 더 짧은 단어로 검색해 보세요. 필터가 켜져 있다면 해제해 보세요.")));
  }
  await renderMore(seq);
}

function titleSearch(q, seq) {
  // Ctrl-F on titles: the query must appear as typed (spaces/punctuation ignored).
  // Newest first unless 오래된순.
  const nq = normalize(q);
  const rows = titles.filter((t) => nq && t.key.includes(nq) && passesFilters(t));
  rows.sort(el.sort.value === "old" ? oldestFirst : newestFirst);
  showResults(rows, q, seq, "제목");
}

const highlight = (title, q) => markMatches(title, normalize(q), escapeHtml);

function titleCard(t, q) {
  const href = t.page ? `video/${t.vid}.html` : `https://www.youtube.com/watch?v=${t.vid}`;
  return h("li", { class: "hit" },
    h("button", {
      type: "button", class: "thumb", "aria-label": `${t.title} 재생`,
      onclick: () => play(t.vid, t.title, [], -1),
    },
      h("img", { src: `https://i.ytimg.com/vi/${t.vid}/mqdefault.jpg`, alt: "", loading: "lazy", width: 320, height: 180 }),
      t.duration > 0 ? h("span", { class: "dur" }, fmtTime(t.duration)) : null),
    h("div", { class: "body" },
      h("h2", {}, h("a", { href, html: highlight(t.title, q), ...(t.page ? {} : { target: "_blank", rel: "noopener" }) })),
      h("p", { class: "meta" }, typeBadge(t.type), t.date || "",
        t.noCaptions ? h("span", { class: "no-captions" }, "· 자막 없음") : null)));
}

async function renderMore(seq = searchSeq) {
  if (resultKind === "titles") {
    const q = el.q.value.trim();
    const batch = results.slice(shown, shown + PAGE_SIZE);
    shown += batch.length;
    for (const t of batch) el.hits.append(titleCard(t, q));
    el.more.hidden = shown >= results.length;
    return;
  }
  const batch = results.slice(shown, shown + PAGE_SIZE);
  shown += batch.length; // claim the batch before awaiting so overlapping calls can't repeat it
  const texts = await Promise.all(batch.map((e) => (e.moments.length ? loadText(e.row.vid) : null)));
  if (seq !== searchSeq) return;
  const nq = normalize(el.q.value);
  batch.forEach((e, i) => el.hits.append(contentCard(e, texts[i], nq)));
  el.more.hidden = shown >= results.length;
}

function typeBadge(type) {
  if (!type) return null;
  const live = type.startsWith(LIVE);
  return h("span", { class: live ? "badge live" : "badge" }, live ? "LIVE " + type.slice(LIVE.length) : type);
}

function contentCard(e, texts, nq) {
  const t = e.row;
  const textAt = new Map(texts || []);
  const inOrder = e.moments.map((sec) => ({ t: sec })); // segments are already in time order
  const href = t.page ? `video/${t.vid}.html` : `https://www.youtube.com/watch?v=${t.vid}`;

  const moment = (m) => h("li", {},
    h("button", {
      type: "button", class: "moment", "data-vid": t.vid, "data-t": m.t,
      onclick: () => play(t.vid, t.title, inOrder, inOrder.indexOf(m)),
    }, h("span", { class: "ts" }, fmtTime(m.t)),
       h("span", { class: "ex", html: markMatches(textAt.get(m.t) || "", nq, escapeHtml) })));

  const list = h("ul", { class: "moments" }, ...inOrder.slice(0, MOMENTS_SHOWN).map(moment));
  const rest = inOrder.length - MOMENTS_SHOWN;
  const moreBtn = rest > 0
    ? h("button", {
        type: "button", class: "more-moments",
        onclick: (ev) => { list.replaceChildren(...inOrder.map(moment)); ev.currentTarget.remove(); markActive(); },
      }, `이 영상의 다른 장면 ${rest}곳 더 보기`)
    : null;

  return h("li", { class: "hit" },
    h("button", {
      type: "button", class: "thumb", "aria-label": `${t.title} 재생`,
      onclick: () => play(t.vid, t.title, inOrder, inOrder.length ? 0 : -1),
    },
      h("img", { src: `https://i.ytimg.com/vi/${t.vid}/mqdefault.jpg`, alt: "", loading: "lazy", width: 320, height: 180 }),
      t.duration > 0 ? h("span", { class: "dur" }, fmtTime(t.duration)) : null),
    h("div", { class: "body" },
      h("h2", {}, h("a", {
        href, html: e.titleHit ? markMatches(t.title, nq, escapeHtml) : escapeHtml(t.title),
        ...(t.page ? {} : { target: "_blank", rel: "noopener" }),
      })),
      h("p", { class: "meta" }, typeBadge(t.type), t.date || "",
        e.moments.length ? h("span", {}, `· ${e.moments.length}곳`) : null),
      inOrder.length ? list : null,
      moreBtn));
}

// ----------------------------------------------------------------- player

let ytReady;
function loadYouTubeApi() {
  ytReady ??= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = resolve;
    document.head.append(h("script", { src: "https://www.youtube.com/iframe_api" }));
  });
  return ytReady;
}

let player, playerReady;
async function seek(vid, t) {
  await loadYouTubeApi();
  if (!player) {
    playerReady = new Promise((resolve) => {
      player = new YT.Player("player", {
        videoId: vid,
        playerVars: { start: t, autoplay: 1, rel: 0, playsinline: 1, hl: "ko", cc_lang_pref: "ko" },
        events: { onReady: (e) => { e.target.playVideo(); resolve(); } },
      });
    });
    return;
  }
  await playerReady;
  if (player.getVideoData?.().video_id === vid) {
    player.seekTo(t, true);
    player.playVideo();
  } else {
    player.loadVideoById({ videoId: vid, startSeconds: t });
  }
}

function play(vid, title, moments, idx) {
  Object.assign(now, { vid, title, moments, idx: Math.max(idx, 0) });
  el.panel.hidden = false;
  syncUrl();
  goTo(now.idx, idx < 0);
  if (matchMedia("(max-width: 959px)").matches) el.panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function goTo(i, fromStart = false) {
  now.idx = i;
  const m = now.moments[i];
  const t = fromStart || !m ? 0 : Math.max(0, m.t - 1);
  seek(now.vid, t);
  el.nowTitle.textContent = now.title;
  el.nowPos.textContent = now.moments.length && !fromStart
    ? `${fmtTime(m.t)} · 장면 ${i + 1}/${now.moments.length}` : "";
  // No matched moments (title search): scene navigation has nothing to do.
  el.prev.hidden = el.next.hidden = !now.moments.length;
  el.prev.disabled = fromStart || i <= 0;
  el.next.disabled = fromStart || i >= now.moments.length - 1;
  el.openYt.href = `https://www.youtube.com/watch?v=${now.vid}&t=${t}s`;
  markActive(fromStart ? null : m?.t);
}

function markActive(t = now.moments[now.idx]?.t) {
  document.querySelectorAll(".moment.active").forEach((b) => b.classList.remove("active"));
  if (t == null) return;
  const b = document.querySelector(`.moment[data-vid="${now.vid}"][data-t="${t}"]`);
  b?.classList.add("active");
}

async function playDirect(vid, t) {
  // Deep link from a transcript page (?v=ID&t=SEC): look up the title from its page.
  let title = "";
  try {
    const doc = new DOMParser().parseFromString(await (await fetch(`video/${vid}.html`)).text(), "text/html");
    title = doc.querySelector("h1")?.textContent || "";
  } catch { /* title is cosmetic */ }
  play(vid, title, t ? [{ t: t + 1 }] : [], t ? 0 : -1);
}

// ----------------------------------------------------------------- events

el.q.addEventListener("input", search);
document.querySelectorAll(".scope button").forEach((b) =>
  b.addEventListener("click", () => { if (b.dataset.scope !== scope) setScope(b.dataset.scope); el.q.focus(); }));
for (const s of [el.type, el.year, el.sort]) s.addEventListener("change", search);
// Infinite scroll: load the next page as the end of the list approaches.
// The 더 보기 button stays as a fallback (and shows progress while loading).
let loadingMore = false;
async function loadMore() {
  if (loadingMore || el.more.hidden) return;
  loadingMore = true;
  el.more.textContent = "불러오는 중…";
  try {
    await renderMore();
  } finally {
    loadingMore = false;
    el.more.textContent = "더 보기";
  }
  // The observer only fires on changes; if the end is still in view
  // (short pages, tall screens), keep filling.
  if (!el.more.hidden && el.more.getBoundingClientRect().top < innerHeight + 600) loadMore();
}
el.more.addEventListener("click", loadMore);
if ("IntersectionObserver" in window) {
  new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); },
    { rootMargin: "0px 0px 600px 0px" }).observe(el.more);
}
el.prev.addEventListener("click", () => goTo(now.idx - 1));
el.next.addEventListener("click", () => goTo(now.idx + 1));
document.querySelectorAll(".chips button").forEach((b) =>
  b.addEventListener("click", () => { el.q.value = b.dataset.q; search(); el.q.focus(); }));
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== el.q) { e.preventDefault(); el.q.focus(); el.q.select(); }
});

init();
