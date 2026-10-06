// Transcript page: export the transcript as a .txt file or copy it,
// with or without [m:ss] timestamps.
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

  function filename() {
    const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return `${safe || vid}${withTimes.checked ? " (타임스탬프)" : ""}.txt`;
  }

  box.querySelector("#ex-download").addEventListener("click", () => {
    // BOM so older Windows editors open the Korean text as UTF-8.
    const url = URL.createObjectURL(new Blob(["﻿" + text()], { type: "text/plain;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: filename() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const copyBtn = box.querySelector("#ex-copy");
  copyBtn.addEventListener("click", async () => {
    const label = copyBtn.textContent;
    try {
      await navigator.clipboard.writeText(text());
      copyBtn.textContent = "복사됨 ✓";
    } catch {
      copyBtn.textContent = "복사 실패";
    }
    setTimeout(() => { copyBtn.textContent = label; }, 1600);
  });
})();
