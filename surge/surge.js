// Surge web page: vote.zzzap-app.com/@handle (v1.2).
//
// GitHub Pages has no server, so every /@handle address falls through to
// /404.html, which loads this file. It reads the handle from the address,
// loads that Surge account's public page, and renders it the same way the
// app's Surge profile looks.
//
// All data goes through `api` below:
//   loadPage(handle)  -> surgePages/{handle}, the account's public page that
//                        Zak's server keeps up to date (one read per visitor,
//                        no live queries; BACKLOG 2026-09-10 cost rule)
//   castVote(page, i) -> Zak's castVote function: one vote per browser
//                        (Firebase anonymous sign-in); returns the totals
// Results stay hidden until you vote (submit first, then see).
// Add ?sample to the address to see the old sample pages
// (surge/sample/<handle>.json), where votes stay in this browser.

(function () {
  "use strict";

  const APP_STORE = "https://apps.apple.com/app/id6761918562";
  const SDK = "https://www.gstatic.com/firebasejs/10.13.2";
  // Same web app as the admin site (zzzap-website/admin/index.html).
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBaTfoiq1UN0GtRgf1k6BO3tY7vcm1g0Eg",
    authDomain: "spahrzap.firebaseapp.com",
    projectId: "spahrzap",
    storageBucket: "spahrzap.firebasestorage.app",
    messagingSenderId: "838021448718",
    appId: "1:838021448718:web:fcb8b87db61d8b7786685f",
  };
  const ICONS = {
    instagram: { name: "Instagram", url: u => `https://www.instagram.com/${u}` },
    tiktok: { name: "TikTok", url: u => `https://www.tiktok.com/@${u}` },
    youtube: { name: "YouTube", url: u => `https://www.youtube.com/@${u}` },
    x: { name: "X", url: u => `https://x.com/${u}` },
    facebook: { name: "Facebook", url: u => `https://www.facebook.com/${u}` },
  };
  const ORDER = ["instagram", "tiktok", "youtube", "x", "facebook"];

  // ---------- Data ----------

  const sampleApi = {
    mode: "sample",

    async loadPage(handle) {
      const res = await fetch(`/surge/sample/${encodeURIComponent(handle)}.json`, { cache: "no-store" });
      if (!res.ok) return null;
      const page = await res.json();
      // Sample files give relative times ("+30h", "-2h") so the demo never goes stale.
      if (page.live && typeof page.live.endsAt === "string" && /^[+-]\d+h$/.test(page.live.endsAt)) {
        page.live.endsAt = new Date(Date.now() + parseInt(page.live.endsAt, 10) * 3600e3).toISOString();
      }
      return page;
    },

    async castVote(page, optionIndex) {
      // Sample: count the vote locally and remember it for this browser.
      const counts = page.live.sampleCounts.slice();
      counts[optionIndex] += 1;
      localStorage.setItem(voteKey(page), String(optionIndex));
      return { counts, mine: optionIndex };
    },

    myVote(page) {
      const saved = localStorage.getItem(voteKey(page));
      return saved === null ? null : parseInt(saved, 10);
    },

    async resultsFor(page) {
      // Same totals as right after voting: the sample counts plus your vote.
      const counts = page.live.sampleCounts.slice();
      const mine = this.myVote(page);
      if (mine !== null && mine >= 0 && mine < counts.length) counts[mine] += 1;
      return { counts, mine };
    },
  };

  // Firebase loads only on real pages, and the anonymous sign-in only happens
  // when someone votes or needs results, so a visitor who just looks costs
  // one read.
  let firebase = null;
  function loadFirebase() {
    if (!firebase) {
      firebase = Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-firestore-lite.js`),
      ]).then(([appMod, store]) => {
        const app = appMod.initializeApp(FIREBASE_CONFIG);
        return { app, store, db: store.getFirestore(app) };
      });
    }
    return firebase;
  }

  let signedIn = null;
  // Loads the sign-in code and signs this browser in. Started as soon as a
  // finger touches an answer, so the vote itself goes out without the wait.
  function prepareToVote() {
    if (!signedIn) {
      signedIn = loadFirebase().then(async ({ app }) => {
        const [authMod, fnMod] = await Promise.all([
          import(`${SDK}/firebase-auth.js`),
          import(`${SDK}/firebase-functions.js`),
        ]);
        const auth = authMod.getAuth(app);
        // The same anonymous account every visit is what makes it one vote
        // per browser.
        await auth.authStateReady();
        if (!auth.currentUser) await authMod.signInAnonymously(auth);
        return fnMod.httpsCallable(fnMod.getFunctions(app), "castVote");
      });
      signedIn.catch(() => { signedIn = null; });
    }
    return signedIn;
  }

  function callCastVote(pollId, optionIndex) {
    return prepareToVote().then(castVote => castVote({ pollId, optionIndex })).then(r => r.data);
  }

  const liveApi = {
    mode: "live",

    async loadPage(handle) {
      const { store, db } = await loadFirebase();
      const snap = await store.getDoc(store.doc(db, "surgePages", handle));
      if (!snap.exists()) return null;
      const page = snap.data();
      // The server sets `live` to null when a zzzap ends.
      if (page.live && (!page.live.pollId || !Array.isArray(page.live.options) || !page.live.endsAt)) {
        page.live = null;
      }
      page.past = (page.past || []).filter(item => item && item.question && item.endedAt);
      return page;
    },

    async castVote(page, optionIndex) {
      const result = await callCastVote(page.live.pollId, optionIndex);
      // Already voted from this browser: the server keeps the first vote.
      const mine = typeof result.mine === "number" ? result.mine : null;
      if (mine !== null) localStorage.setItem(voteKey(page), String(mine));
      return { counts: result.counts, mine, closed: result.closed };
    },

    myVote(page) {
      return sampleApi.myVote(page);
    },

    async resultsFor(page) {
      // The server only hands out totals in answer to a vote. Re-sending this
      // browser's own vote returns them without counting it twice. -1 is
      // never a valid answer, so for an ended zzzap it can only return the
      // final totals, never cast a vote.
      const mine = this.myVote(page);
      const result = await callCastVote(page.live.pollId, mine === null ? -1 : mine);
      return {
        counts: result.counts,
        mine: typeof result.mine === "number" ? result.mine : null,
      };
    },
  };

  const api = new URLSearchParams(location.search).has("sample") ? sampleApi : liveApi;

  function voteKey(page) { return `zzzap.vote.${page.live.pollId}`; }

  // ---------- Small helpers (text only, never HTML from data) ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function handleFromAddress() {
    const path = decodeURIComponent(location.pathname);
    const match = path.match(/^\/@([a-z0-9_.]{3,20})\/?$/i);
    if (match) return match[1].toLowerCase();
    const query = new URLSearchParams(location.search).get("u");
    return query ? query.toLowerCase() : null;
  }

  function cleanUsername(name) {
    return /^[A-Za-z0-9._-]{1,50}$/.test(name || "") ? name : null;
  }

  function cleanWebsite(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch { return null; }
  }

  function displayWebsite(url) {
    return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  }

  function firstName(page) {
    return (page.displayName || "").split(" ")[0] || page.displayName;
  }

  function timeLeft(endsAt) {
    const ms = new Date(endsAt) - Date.now();
    if (ms <= 0) return null;
    const mins = Math.floor(ms / 60000);
    const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
    if (d > 0) return `Ends in ${d}d ${h}h`;
    if (h > 0) return `Ends in ${h}h ${m}m`;
    return `Ends in ${Math.max(m, 1)}m`;
  }

  function formatDate(iso) {
    const date = new Date(iso + (iso.length === 10 ? "T12:00:00" : ""));
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // Whole percentages that always add up to 100 (largest remainder).
  function percentages(counts) {
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) return counts.map(() => 0);
    const exact = counts.map(c => (c / total) * 100);
    const pcts = exact.map(Math.floor);
    let left = 100 - pcts.reduce((a, b) => a + b, 0);
    exact.map((v, i) => [v - Math.floor(v), i])
      .sort((a, b) => b[0] - a[0])
      .forEach(([, i]) => { if (left > 0) { pcts[i] += 1; left -= 1; } });
    return pcts;
  }

  function isIPhone() { return /iPhone|iPod/.test(navigator.userAgent); }

  // ---------- Render ----------

  function renderNotFound() {
    document.title = "Not found · Zzzap";
    const box = el("div", "notfound");
    box.append(el("h1", null, "Nothing here yet"));
    box.append(el("p", null, "This page doesn't exist, or it isn't on Surge."));
    const more = el("p");
    const link = el("a", null, "Learn about Zzzap");
    link.href = "https://www.zzzap-app.com";
    more.append(link);
    box.append(more);
    document.getElementById("page").replaceChildren(box, footer());
  }

  // Bumped on every redraw so timers from an older drawing stop themselves.
  let renderGen = 0;

  function renderPage(page) {
    renderGen += 1;
    const root = document.getElementById("page");
    const name = page.displayName || page.handle;
    document.title = `${name} · ${page.category ? page.category + " · " : ""}Zzzap`;

    // Page style, same choices as the app's Page Style screen:
    // header poster | banner | minimal, name classic | rounded | serif.
    const style = page.style || {};
    const header = ["poster", "banner", "minimal"].includes(style.header) ? style.header : "poster";
    const rawName = style.name === "serif" ? "elegant" : style.name;
    const nameStyle = ["classic", "bold", "tall", "elegant", "mono", "rounded"].includes(rawName) ? rawName : "classic";
    const nameColor = ["white", "yellow", "orange", "pink", "mint", "lavender"].includes(style.nameColor) ? style.nameColor : "white";
    root.className = `phone header-${header} name-${nameStyle} color-${nameColor}`;

    // Header photo + identity, like the app's SurgeHeroPhoto.
    const hero = el("div", "hero");
    const headerPhoto = page.headerPhotoURL || page.photoURL;
    if (headerPhoto && header !== "minimal") {
      const img = el("img");
      img.src = headerPhoto;
      img.alt = name;
      hero.append(img);
    }
    const identity = el("div", "identity");
    if (header === "minimal" && page.photoURL) {
      const avatar = el("img", "avatar");
      avatar.src = page.photoURL;
      avatar.alt = name;
      identity.append(avatar);
    }
    identity.append(el("h1", "name", name));
    identity.append(el("div", "handle", `@${page.handle}`));
    identity.append(el("div", "badge", page.category ? `${page.category} · Surge` : "Surge"));
    if (page.bio) identity.append(el("p", "bio", page.bio));

    root.replaceChildren(hero, identity, links(page));
    if (api.mode === "sample") {
      root.append(el("p", "sample-note", "Sample page. Votes here stay in this browser."));
    }
    if (page.live) root.append(liveSection(page));
    if (page.past && page.past.length) root.append(pastSection(page));
    root.append(footer());
  }

  function links(page) {
    const wrap = el("div");
    const socials = el("div", "socials");
    const data = page.links || {};
    for (const key of ORDER) {
      const user = cleanUsername(data[key]);
      if (!user) continue;
      const a = el("a");
      a.href = ICONS[key].url(user);
      a.target = "_blank";
      a.rel = "noopener";
      a.setAttribute("aria-label", `${ICONS[key].name}, ${user}`);
      const img = el("img");
      img.src = `/surge/icons/${key}.svg`;
      img.alt = "";
      a.append(img);
      socials.append(a);
    }
    if (socials.children.length) wrap.append(socials);
    // The public page only ever carries a website the server has checked.
    const site = cleanWebsite(data.website);
    if (site) {
      const a = el("a", "website", displayWebsite(site));
      a.href = site;
      a.target = "_blank";
      a.rel = "noopener nofollow";
      wrap.append(a);
    }
    return wrap;
  }

  function liveSection(page) {
    const live = page.live;
    const ended = !timeLeft(live.endsAt);
    const gen = renderGen;
    const stale = () => gen !== renderGen;
    const section = el("div", "section");
    section.append(el("div", "section-head", ended ? "Just ended" : "Live now"));

    const card = el("div", "card live-card" + (ended ? " closed" : ""));
    const row = el("div", "live-row");
    const pill = el("span", "live-pill");
    pill.append(el("span", "dot"), document.createTextNode(ended ? "ENDED" : "LIVE"));
    const ends = el("span", "ends", ended ? "Voting closed" : timeLeft(live.endsAt));
    row.append(pill, ends);
    card.append(row, el("div", "question", live.question));
    // Results are hidden until you vote. Say so, so the plain answer list
    // doesn't read as "no votes yet" or a page that hasn't updated.
    const hint = el("p", "hint", "Vote to see how everyone answered.");
    if (!ended && api.myVote(page) === null) card.append(hint);

    const options = el("div", "options");
    const buttons = live.options.map((text, i) => {
      const btn = el("button", "option");
      btn.type = "button";
      const fill = el("span", "fill");
      const r = el("span", "row");
      r.append(el("span", "label", text), el("span", "pct", ""));
      btn.append(fill, r);
      options.append(btn);
      return btn;
    });
    card.append(options);

    const meta = el("div", "meta");
    const you = el("span", "you", "");
    const count = el("span", null, "");
    meta.append(you, count);
    card.append(meta);
    const error = el("p", "error hidden", "");
    card.append(error);

    const get = getZzzap(page, ended);
    get.classList.add("hidden");
    card.append(get);
    section.append(card);

    function showResults(counts, mine, closedNow) {
      const pcts = percentages(counts.map(c => c || 0));
      card.classList.add("results");
      hint.remove();
      buttons.forEach((btn, i) => {
        const pct = pcts[i];
        btn.disabled = true;
        btn.querySelector(".pct").textContent = `${pct}%`;
        requestAnimationFrame(() => { btn.querySelector(".fill").style.width = `${pct}%`; });
        // Yellow means one thing only: your answer.
        btn.classList.toggle("mine", i === mine);
      });
      you.textContent = mine === null ? "" : "✓ You voted";
      // Visitors see percentages, never counts; the creator sees counts in
      // the app (Stacy, 2026-10-18), so a new account never reads as empty.
      if (closedNow && !ended) {
        card.classList.add("closed");
        pill.lastChild.textContent = "ENDED";
        ends.textContent = "Voting closed";
      }
      count.textContent = ended || closedNow ? "Final results" : "Live results";
      get.classList.remove("hidden");
      if (!ended && !closedNow) keepResultsLive();
    }

    // After voting, keep the totals moving while the page is open and in
    // front. Each refresh is one castVote call that re-sends this browser's
    // own vote, so nothing is counted twice.
    let refreshing = false;
    function keepResultsLive() {
      if (refreshing) return;
      refreshing = true;
      const refresh = setInterval(async () => {
        if (stale()) { clearInterval(refresh); return; }
        if (document.hidden) return;
        try {
          const r = await api.resultsFor(page);
          const closed = !timeLeft(live.endsAt);
          showResults(r.counts, r.mine, closed);
          if (closed) clearInterval(refresh);
        } catch {
          // Missed one; try again on the next tick.
        }
      }, 10000);
    }

    const already = api.myVote(page);
    if (ended || already !== null) {
      // A missed zzzap is a conversion screen, not an error (2026-09-11).
      buttons.forEach(b => (b.disabled = true));
      count.textContent = "Loading results";
      api.resultsFor(page)
        .then(r => showResults(r.counts, r.mine, false))
        .catch(() => {
          // Ended a moment ago: the server hasn't closed it yet.
          count.textContent = ended ? "Final results are on the way" : "";
          get.classList.remove("hidden");
        });
    } else {
      count.textContent = "";
      // Get signed in as soon as there's something to vote on, so the tap
      // only waits for the vote itself.
      if (api === liveApi) prepareToVote().catch(() => {});
      buttons.forEach((btn, i) => btn.addEventListener("click", async () => {
        buttons.forEach(b => (b.disabled = true));
        error.classList.add("hidden");
        // Show the tap landed right away; results replace this when they arrive.
        options.classList.add("sending");
        btn.classList.add("picked");
        btn.querySelector(".pct").textContent = "Sending…";
        try {
          const result = await api.castVote(page, i);
          options.classList.remove("sending");
          btn.classList.remove("picked");
          showResults(result.counts, result.mine, result.closed);
        } catch (err) {
          options.classList.remove("sending");
          btn.classList.remove("picked");
          btn.querySelector(".pct").textContent = "";
          buttons.forEach(b => (b.disabled = false));
          error.textContent = err && err.code === "functions/resource-exhausted"
            ? "Slow down a moment, then try again."
            : "Your vote didn't go through. Try again.";
          error.classList.remove("hidden");
        }
      }));
      // Keep the countdown honest while the page is open.
      const timer = setInterval(() => {
        if (stale()) { clearInterval(timer); return; }
        const left = timeLeft(live.endsAt);
        if (left) { ends.textContent = left; return; }
        clearInterval(timer);
        renderPage(page);
      }, 30000);
    }
    return section;
  }

  function getZzzap(page, ended) {
    const box = el("div", "get");
    const txt = el("div", "txt");
    const who = firstName(page);
    if (ended) {
      txt.append(el("div", "t1", "You missed this one"));
      txt.append(el("div", "t2", `Get Zzzap and ${who}'s next question lands on your lock screen.`));
    } else {
      txt.append(el("div", "t1", "Don't miss the next one"));
      txt.append(el("div", "t2", `Get Zzzap and ${who}'s next question lands on your lock screen.`));
    }
    box.append(txt);
    if (isIPhone() || !/Android/.test(navigator.userAgent)) {
      const btn = el("a", "get-btn", "Get Zzzap");
      btn.href = APP_STORE;
      box.append(btn);
    } else {
      // No Android app yet (deferred until web voting shows the demand).
      box.querySelector(".t2").textContent = "Zzzap is on iPhone for now.";
    }
    return box;
  }

  function pastSection(page) {
    const section = el("div", "section");
    section.append(el("div", "section-head", "Past zzzaps"));
    const list = el("div", "archive");
    // Final totals only. Never who voted (2026-09-10).
    for (const item of page.past) {
      const card = el("div", "past");
      card.append(el("div", "q", item.question));
      const w = el("div", "winner");
      w.append(el("span", "wname", item.winner || "No votes"), el("span", "wpct", `${item.winnerPct || 0}%`));
      const bar = el("div", "bar");
      const fill = el("i");
      fill.style.width = `${Math.max(0, Math.min(100, item.winnerPct))}%`;
      bar.append(fill);
      const sub = el("div", "sub");
      sub.append(el("span", null, "Final results"), el("span", null, `Ended ${formatDate(item.endedAt)}`));
      card.append(w, bar, sub);
      list.append(card);
    }
    section.append(list);
    return section;
  }

  function footer() {
    const f = el("footer");
    const bolts = el("div", "bolts");
    const logo = el("img");
    logo.src = "/zzzap-bolts.svg";
    logo.alt = "Zzzap";
    logo.width = 34;
    logo.height = 30;
    bolts.append(logo);
    f.append(bolts, el("div", "tagline", "Trusted Sources. Real Decisions."));
    const legal = el("div", "legal", "Zzzap by Rhapsy LLC · ");
    const privacy = el("a", null, "Privacy");
    privacy.href = "https://www.zzzap-app.com/privacy.html";
    const terms = el("a", null, "Terms");
    terms.href = "https://www.zzzap-app.com/terms.html";
    legal.append(privacy, document.createTextNode(" · "), terms);
    f.append(legal);
    return f;
  }

  // ---------- Start ----------

  const handle = handleFromAddress();
  if (!handle) { renderNotFound(); return; }
  // A page left open picks up a new zzzap, or one that just ended, by
  // re-reading the page every 30 seconds while it's in front. It only
  // redraws when the live zzzap or the past list changed, so a vote in
  // progress is never wiped.
  const pageKey = page => JSON.stringify([page.live && page.live.pollId, (page.past || []).length]);
  api.loadPage(handle)
    .then(page => {
      if (!page) { renderNotFound(); return; }
      renderPage(page);
      let shown = pageKey(page);
      setInterval(async () => {
        if (document.hidden) return;
        try {
          const fresh = await api.loadPage(handle);
          if (fresh && pageKey(fresh) !== shown) {
            shown = pageKey(fresh);
            renderPage(fresh);
          }
        } catch {
          // Try again on the next tick.
        }
      }, 30000);
    })
    .catch(renderNotFound);
})();
