// Transcript page: export the transcript as .txt (with or without [m:ss]
// timestamps), copy it, or save the original captions as an .srt file.
(() => {
  const box = document.querySelector(".export");
  if (!box) return;
  const title = document.querySelector("main h1").textContent.trim();
  const meta = (name) => document.querySelector(`meta[data-pagefind-meta="${name}[content]"]`)?.content || "";
  const vid = meta("vid");
  const date = meta("date");
  const rows = [...document.querySelectorAll("main section")].map((s) => [
    s.querySelector("h2").textContent.trim(),
    s.querySelector("p").textContent.trim(),
  ]);
  const withTimes = box.querySelector("#ex-ts");

  function text() {
    const head = [title, `https://www.youtube.com/watch?v=${vid}`, date].filter(Boolean);
    const body = rows.map(([t, line]) => (withTimes.checked ? `[${t}] ${line}` : line));
    return [...head, "", ...body].join("\n") + "\n";
  }

  const baseName = () =>
    title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || vid;

  function save(name, content) {
    // BOM so older Windows editors and players read the Korean text as UTF-8.
    const url = URL.createObjectURL(new Blob(["﻿" + content], { type: "text/plain;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------------------- .srt
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  function srtTime(sec) {
    const ms = Math.max(0, Math.round(sec * 1000));
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  }
  async function srt() {
    // Original YouTube caption cues, published by ingest/build_search.py.
    const cues = (await (await fetch(`../search/c/${vid}.json`)).json())
      .filter((c) => c[2].trim())
      .sort((a, b) => a[0] - b[0]);
    return cues.map(([start, dur, line], i) => {
      let end = start + dur;
      const next = cues[i + 1]?.[0];
      // Auto-captions overlap (each line stays up until the next one ends);
      // end each cue where the next begins so subtitles don't stack.
      if (next !== undefined && next > start && next < end) end = next;
      if (end <= start) end = start + 0.5;
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${line.trim()}\n`;
    }).join("\n");
  }

  // ------------------------------------------------------------ buttons
  box.querySelector("#ex-download").addEventListener("click", () =>
    save(`${baseName()}${withTimes.checked ? " (타임스탬프)" : ""}.txt`, text()));

  const flash = (btn, label) => {
    const original = btn.dataset.label ||= btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = original; }, 1600);
  };

  const copyBtn = box.querySelector("#ex-copy");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text());
      flash(copyBtn, "복사됨 ✓");
    } catch {
      flash(copyBtn, "복사 실패");
    }
  });

  const srtBtn = box.querySelector("#ex-srt");
  srtBtn.addEventListener("click", async () => {
    srtBtn.disabled = true;
    try {
      save(`${baseName()}.srt`, await srt());
    } catch {
      flash(srtBtn, "불러오기 실패");
    } finally {
      srtBtn.disabled = false;
    }
  });
})();
