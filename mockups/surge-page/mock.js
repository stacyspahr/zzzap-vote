// Shared sample data and behavior for the Surge page mockups (11/9).
// Each option page builds the same content its own way.
const D = {
  name: "Stacy Spahr",
  handle: "stacyfromzzzap",
  category: "Tech",
  bio: "Co-founder of Zzzap. Not a coder. Fell for tech on an Apple II in 8th grade. This is my first app. Follow along, mistakes and all.",
  photo: "header.jpg",
  links: ["instagram", "tiktok", "facebook"],
  website: "zzzap-app.com",
  live: {
    question: "New phone day is coming. What actually matters most to you?",
    options: ["Battery life", "Camera", "Price", "The AI features"],
    counts: [61, 38, 44, 17],
    ends: "Ends in 1d 6h",
  },
  past: [
    { q: "Smart home: where should a beginner start?", winner: "Smart lights", pct: 46, votes: 212, ended: "Oct 11" },
    { q: "Which AI assistant do you actually use every day?", winner: "The one built into my phone", pct: 52, votes: 187, ended: "Oct 4" },
    { q: "Would you buy smart glasses this year?", winner: "Not yet", pct: 63, votes: 240, ended: "Sep 27" },
  ],
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fill(id, text) {
  document.querySelectorAll(`[data-fill="${id}"]`).forEach((n) => (n.textContent = text));
}

function renderSocials(target) {
  for (const l of D.links) {
    const a = el("a");
    a.href = "#";
    a.setAttribute("aria-label", l);
    const img = el("img");
    img.src = `/surge/icons/${l}.svg`;
    img.alt = "";
    a.append(img);
    target.append(a);
  }
}

// The ballot: tap an answer, then every answer shows its share. The leader
// is green, your pick has a yellow edge (the design rules).
function renderBallot(target, meta) {
  const counts = D.live.counts.slice();
  let mine = -1;
  const rows = D.live.options.map((text, i) => {
    const b = el("button", "option");
    const f = el("span", "fill");
    const row = el("span", "row");
    row.append(el("span", "otext", text), el("span", "pct", ""));
    b.append(f, row);
    b.onclick = () => {
      if (mine >= 0) return;
      mine = i;
      counts[i] += 1;
      show();
    };
    target.append(b);
    return b;
  });
  function show() {
    const total = counts.reduce((a, b) => a + b, 0);
    const top = Math.max(...counts);
    target.classList.add("results");
    rows.forEach((b, i) => {
      const pct = Math.round((counts[i] / total) * 100);
      b.disabled = true;
      b.classList.toggle("lead", counts[i] === top);
      b.classList.toggle("mine", i === mine);
      b.querySelector(".pct").textContent = pct + "%";
      requestAnimationFrame(() => (b.querySelector(".fill").style.width = pct + "%"));
    });
    if (meta) {
      meta.innerHTML = "";
      meta.append(el("span", "you", "You voted " + D.live.options[mine]), el("span", null, total + " votes"));
    }
    document.querySelectorAll(".get").forEach((g) => g.classList.remove("hidden"));
  }
}

function renderPast(target, numbered) {
  D.past.forEach((p, i) => {
    const item = el("div", "past");
    if (numbered) item.append(el("div", "num", String(i + 1).padStart(2, "0")));
    const body = el("div", "pbody");
    body.append(el("div", "q", p.q));
    const w = el("div", "winner");
    w.append(el("span", "wname", p.winner), el("span", "wpct", p.pct + "%"));
    body.append(w);
    const bar = el("div", "bar");
    const bi = el("i");
    bi.style.width = p.pct + "%";
    bar.append(bi);
    body.append(bar);
    body.append(el("div", "sub", `${p.votes} votes   ${p.ended}`));
    item.append(body);
    target.append(item);
  });
}

// --p goes 0 → 1 over the first half screen of scrolling. Each page uses it
// to dim, blur or zoom the photo that stays put behind the information.
function scrollFx() {
  const p = Math.min(window.scrollY / (window.innerHeight * 0.5), 1);
  document.documentElement.style.setProperty("--p", p.toFixed(3));
}

document.addEventListener("DOMContentLoaded", () => {
  fill("name", D.name);
  fill("handle", "@" + D.handle);
  fill("category", D.category);
  fill("bio", D.bio);
  fill("question", D.live.question);
  fill("ends", D.live.ends);
  fill("website", D.website);
  document.querySelectorAll("[data-photo]").forEach((i) => (i.src = D.photo));
  document.querySelectorAll("[data-socials]").forEach(renderSocials);
  document.querySelectorAll("[data-ballot]").forEach((b) =>
    renderBallot(b, document.querySelector(`[data-meta="${b.dataset.ballot}"]`))
  );
  document.querySelectorAll("[data-past]").forEach((t) => renderPast(t, t.dataset.past === "numbered"));
  document.querySelectorAll("[data-scrollto]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById(a.dataset.scrollto).scrollIntoView({ behavior: "smooth", block: "center" });
    })
  );
  window.addEventListener("scroll", scrollFx, { passive: true });
  window.addEventListener("resize", scrollFx);
  // ?y=500 opens scrolled down, for side-by-side screenshots.
  const y = new URLSearchParams(location.search).get("y");
  if (y) window.scrollTo(0, Number(y));
  scrollFx();
});
