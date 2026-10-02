// 말씀 검색: Pagefind over per-video transcript pages + YouTube IFrame player.
const $ = (s) => document.querySelector(s);
const el = {
  q: $("#q"), type: $("#f-type"), year: $("#f-year"), sort: $("#f-sort"),
  count: $("#count"), hits: $("#hits"), more: $("#more"), empty: $("#empty"),
  panel: $("#panel"), nowTitle: $("#now-title"), nowPos: $("#now-pos"),
  prev: $("#prev"), next: $("#next"), openYt: $("#open-yt"),
};
const PAGE_SIZE = 10;
const MOMENTS_SHOWN = 3;

let pagefind;
let results = [];
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
const secondsFromUrl = (url) => {
  const m = /#t-(\d+)/.exec(url || "");
  return m ? Number(m[1]) : null;
};
const LIVE = "라이브 · ";
const h = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "html") n.innerHTML = v; // only used for Pagefind excerpts (already escaped, <mark> added)
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
};

// ----------------------------------------------------------------- search

async function init() {
  try {
    pagefind = await import("./pagefind/pagefind.js");
  } catch {
    el.count.textContent = "검색 색인이 아직 없습니다 (pagefind 빌드 필요).";
    return;
  }
  await pagefind.options({ excerptLength: 26 });
  pagefind.init();

  loadStats();
  const filters = await pagefind.filters();
  fillTypes(filters.type || {});
  fillSelect(el.year, filters.year, (y) => (y === "unknown" ? "미상" : y + "년"), (a, b) => b.localeCompare(a));

  const p = new URLSearchParams(location.search);
  el.q.value = p.get("q") || "";
  el.type.value = p.get("type") || "";
  el.year.value = p.get("year") || "";
  el.sort.value = p.get("sort") || "";
  if (p.get("v")) playDirect(p.get("v"), Number(p.get("t") || 0));
  if (el.q.value) search();
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
      `영상 ${s.videos.toLocaleString("ko-KR")}편, 약 ${s.hours.toLocaleString("ko-KR")}시간 분량의 말씀을 검색할 수 있습니다.`;
    $("#updated").textContent = `마지막 업데이트: ${s.updated}`;
  } catch { /* stats are optional */ }
}

function syncUrl() {
  const p = new URLSearchParams();
  if (el.q.value.trim()) p.set("q", el.q.value.trim());
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
  if (!q) {
    results = [];
    el.hits.replaceChildren();
    el.more.hidden = true;
    el.count.textContent = "";
    el.empty.hidden = false;
    return;
  }
  const filters = {};
  if (el.type.value) filters.type = el.type.value;
  if (el.year.value) filters.year = el.year.value;
  const sort = el.sort.value === "new" ? { date: "desc" } : el.sort.value === "old" ? { date: "asc" } : undefined;

  const res = await pagefind.debouncedSearch(q, { filters, sort }, 200);
  if (res === null || seq !== searchSeq) return; // superseded by newer typing
  results = res.results;
  shown = 0;
  el.empty.hidden = true;
  el.hits.replaceChildren();
  el.count.textContent = results.length
    ? `${results.length.toLocaleString("ko-KR")}개 영상에서 찾았습니다`
    : "";
  if (!results.length) {
    el.hits.append(h("li", { class: "none" },
      h("p", {}, `‘${q}’에 대한 말씀을 찾지 못했습니다.`),
      h("p", { class: "sub" }, "다른 표현이나 더 짧은 단어로 검색해 보세요. 필터가 켜져 있다면 해제해 보세요.")));
  }
  await renderMore(seq);
}

async function renderMore(seq = searchSeq) {
  const batch = results.slice(shown, shown + PAGE_SIZE);
  const data = await Promise.all(batch.map((r) => r.data()));
  if (seq !== searchSeq) return;
  shown += batch.length;
  for (const d of data) el.hits.append(card(d));
  el.more.hidden = shown >= results.length;
}

function momentsOf(d) {
  // One sub-result per ~25 s transcript segment (<h2 id="t-SECONDS">).
  const subs = (d.sub_results || [])
    .map((s) => ({
      t: secondsFromUrl(s.url),
      excerpt: s.excerpt.replace(/^(\d+:)?\d+:\d+\.\s*/, ""), // drop the heading's "1:23." prefix
      weight: s.locations?.length || 0,
    }))
    .filter((s) => s.t !== null);
  // Best matches first for the preview, but play them in time order.
  const best = [...subs].sort((a, b) => b.weight - a.weight);
  return { best, inOrder: [...subs].sort((a, b) => a.t - b.t) };
}

function typeBadge(type) {
  if (!type) return null;
  const live = type.startsWith(LIVE);
  return h("span", { class: live ? "badge live" : "badge" }, live ? "LIVE " + type.slice(LIVE.length) : type);
}

function card(d) {
  const { vid, title, date, image, duration } = d.meta;
  const { best, inOrder } = momentsOf(d);
  const preview = best.slice(0, MOMENTS_SHOWN).sort((a, b) => a.t - b.t);

  const moment = (m) => h("li", {},
    h("button", {
      type: "button", class: "moment", "data-vid": vid, "data-t": m.t,
      onclick: () => play(vid, title, inOrder, inOrder.findIndex((x) => x.t === m.t)),
    }, h("span", { class: "ts" }, fmtTime(m.t)), h("span", { class: "ex", html: m.excerpt })));

  const list = h("ul", { class: "moments" }, ...preview.map(moment));
  const rest = inOrder.filter((m) => !preview.includes(m));
  const moreBtn = rest.length
    ? h("button", {
        type: "button", class: "more-moments",
        onclick: (e) => { list.replaceChildren(...inOrder.map(moment)); e.currentTarget.remove(); markActive(); },
      }, `이 영상의 다른 장면 ${rest.length}곳 더 보기`)
    : null;

  return h("li", { class: "hit" },
    h("button", {
      type: "button", class: "thumb", "aria-label": `${title} 재생`,
      onclick: () => play(vid, title, inOrder, inOrder.length ? 0 : -1),
    },
      h("img", { src: image, alt: "", loading: "lazy", width: 320, height: 180 }),
      duration > 0 ? h("span", { class: "dur" }, fmtTime(duration)) : null),
    h("div", { class: "body" },
      h("h2", {}, h("a", { href: d.url }, title)),
      h("p", { class: "meta" }, typeBadge(d.filters?.type?.[0]), date || ""),
      preview.length ? list : h("p", { class: "ex" , html: d.excerpt }),
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
for (const s of [el.type, el.year, el.sort]) s.addEventListener("change", search);
el.more.addEventListener("click", () => renderMore());
el.prev.addEventListener("click", () => goTo(now.idx - 1));
el.next.addEventListener("click", () => goTo(now.idx + 1));
document.querySelectorAll(".chips button").forEach((b) =>
  b.addEventListener("click", () => { el.q.value = b.dataset.q; search(); el.q.focus(); }));
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== el.q) { e.preventDefault(); el.q.focus(); el.q.select(); }
});

init();
