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
// Results stay hidden until you vote (submit first, then see), or until you
// give up your vote to watch ("See results without voting").
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
  // "See results without voting" needs Zak's castVote to accept a pass
  // (BACKLOG, Thu 10/29 agenda). Until then a tap says "Coming soon."
  // Flip to true once it's live. ?sample pages already do the whole thing.
  const PASS_READY = false;

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
      return { counts, mine: optionIndex, already: false };
    },

    async checkVoted() { return null; },

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

    canPass: true,

    async pass(page) {
      // Sample: remember the pass and show the totals without your vote.
      localStorage.setItem(passKey(page), "1");
      return { counts: page.live.sampleCounts.slice(), mine: null, closed: false };
    },

    passed(page) {
      return localStorage.getItem(passKey(page)) === "1";
    },
  };

  // Firebase loads only on real pages. The anonymous sign-in starts when a
  // zzzap is open to vote on (so the tap only waits for the vote) or when
  // results are needed; reading the page itself is one read.
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
        // Keep the sign-in in localStorage, not the default IndexedDB:
        // Instagram's built-in browser lost the IndexedDB copy seconds after
        // signing in, which signed the page out and the vote was refused
        // (11/3). Listing IndexedDB second carries over a browser's existing
        // sign-in, so people who already voted stay the same voter.
        let auth;
        try {
          auth = authMod.initializeAuth(app, {
            persistence: [
              authMod.browserLocalPersistence,
              authMod.indexedDBLocalPersistence,
              authMod.inMemoryPersistence,
            ],
          });
        } catch {
          auth = authMod.getAuth(app); // already set up by an earlier try
        }
        // The same anonymous account every visit is what makes it one vote
        // per browser.
        await auth.authStateReady();
        if (!auth.currentUser) await authMod.signInAnonymously(auth);
        const castVote = fnMod.httpsCallable(fnMod.getFunctions(app), "castVote");
        // Sign in again if the browser dropped the sign-in since the last call.
        return async (data) => {
          if (!auth.currentUser) await authMod.signInAnonymously(auth);
          try {
            return await castVote(data);
          } catch (err) {
            if (!err || err.code !== "functions/unauthenticated") throw err;
            await authMod.signInAnonymously(auth);
            return castVote(data);
          }
        };
      });
      signedIn.catch(() => { signedIn = null; });
    }
    return signedIn;
  }

  function callCastVote(pollId, optionIndex) {
    return prepareToVote().then(castVote => castVote({ pollId, optionIndex })).then(r => r.data);
  }

  // Give up this browser's vote on a zzzap and get the totals. The server
  // keeps passes apart from votes and refuses a vote after one.
  function callPass(pollId) {
    return prepareToVote().then(castVote => castVote({ pollId, pass: true })).then(r => r.data);
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
      return { counts: result.counts, mine, closed: result.closed, already: !!result.already };
    },

    // This browser may have voted without remembering it (saved data
    // cleared, or the page closed before the vote came back). Ask the
    // server: -1 is never a valid answer, so it can't cast a vote. Until
    // castVote checks "already" before the answer, this just fails quietly
    // and the buttons stay. Returns the results if this browser voted.
    async checkVoted(page) {
      try {
        const result = await callCastVote(page.live.pollId, -1);
        if (typeof result.mine !== "number") return null;
        localStorage.setItem(voteKey(page), String(result.mine));
        return { counts: result.counts, mine: result.mine, closed: result.closed };
      } catch {
        return null;
      }
    },

    myVote(page) {
      return sampleApi.myVote(page);
    },

    async resultsFor(page) {
      if (this.passed(page)) {
        const result = await callPass(page.live.pollId);
        return { counts: result.counts, mine: null };
      }
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

    canPass: PASS_READY,

    async pass(page) {
      const result = await callPass(page.live.pollId);
      // Voted from this browser before: the vote stands, show it as yours.
      const mine = typeof result.mine === "number" ? result.mine : null;
      if (mine !== null) localStorage.setItem(voteKey(page), String(mine));
      else localStorage.setItem(passKey(page), "1");
      return { counts: result.counts, mine, closed: result.closed };
    },

    passed(page) {
      return sampleApi.passed(page);
    },
  };

  // Demo pages (vote.zzzap-app.com/demofitness and so on) hand their sample
  // page in as window.SURGE_DEMO, so they look exactly like a real page.
  if (window.SURGE_DEMO) {
    sampleApi.loadPage = async () => {
      const page = JSON.parse(JSON.stringify(window.SURGE_DEMO));
      if (page.live && /^[+-]\d+h$/.test(page.live.endsAt || "")) {
        page.live.endsAt = new Date(Date.now() + parseInt(page.live.endsAt, 10) * 3600e3).toISOString();
      }
      return page;
    };
  }
  const api = window.SURGE_DEMO || new URLSearchParams(location.search).has("sample") ? sampleApi : liveApi;

  function voteKey(page) { return `zzzap.vote.${page.live.pollId}`; }
  function passKey(page) { return `zzzap.pass.${page.live.pollId}`; }

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
    const headerPhoto = header === "minimal" ? null : (page.headerPhotoURL || page.photoURL);
    // The top fade under the clock follows the header, and it sits outside #page.
    document.body.dataset.header = headerPhoto ? header : "minimal";
    root.className = `phone header-${headerPhoto ? header : "minimal"} name-${nameStyle} color-${nameColor}${page.live ? " has-live" : ""}`;

    // The Glass Sheet (Stacy picked it 2026-11-09, mockup A): the header
    // photo fills the screen and stays put; everything else is on a tinted
    // sheet that starts partway down and scrolls up over it while the photo
    // dims. No blur anywhere: blurring while scrolling was choppy on iPhone.
    const parts = [];
    if (headerPhoto) {
      const photo = el("div", "photo");
      const img = el("img");
      img.src = headerPhoto;
      img.alt = name;
      photo.append(img, el("div", "shade"));
      parts.push(photo, el("div", "clear"));
    }

    const sheet = el("div", "sheet");
    if (headerPhoto) sheet.append(el("div", "grab"));
    if (!headerPhoto && page.photoURL) {
      const avatar = el("img", "avatar");
      avatar.src = page.photoURL;
      avatar.alt = name;
      sheet.append(avatar);
    }
    const who = el("div", "who");
    const names = el("div", "names");
    names.append(el("h1", "name", name), el("div", "handle", `@${page.handle}`));
    who.append(names);
    if (page.category) who.append(el("span", "tag", page.category));
    sheet.append(who);
    if (page.bio) sheet.append(el("p", "bio", page.bio));
    sheet.append(links(page));
    if (isIPhone() && !window.SURGE_DEMO) sheet.append(openInApp(page));
    if (api.mode === "sample" && !window.SURGE_DEMO) {
      sheet.append(el("p", "sample-note", "Sample page. Votes here stay in this browser."));
    }
    if (page.live) sheet.append(liveSection(page));
    if (page.past && page.past.length) sheet.append(pastSection(page));
    // Demo pages can add their own sections (the sign at the gym, and so on).
    const extra = document.getElementById("surge-extra");
    if (extra) sheet.append(extra.content.cloneNode(true));
    sheet.append(footer());
    root.replaceChildren(...parts, sheet);
    watchScroll();
  }

  // Safari 26+ ties the dimming straight to the scroll in surge.css. Older
  // browsers get the same effect from here, once per screen refresh.
  let scrollWatched = false;
  function watchScroll() {
    if (scrollWatched || (window.CSS && CSS.supports("animation-timeline: scroll()"))) return;
    scrollWatched = true;
    let queued = false;
    const update = () => {
      queued = false;
      const clear = document.querySelector(".clear");
      const span = clear ? clear.offsetHeight * 1.2 : 1;
      const p = Math.min(Math.max(window.scrollY / span, 0), 1).toFixed(3);
      const top = clear ? Math.min(Math.max((window.scrollY - clear.offsetHeight * .85) / (clear.offsetHeight * .25), 0), 1).toFixed(3) : 1;
      document.querySelectorAll(".photo").forEach(n => n.style.setProperty("--p", p));
      document.querySelectorAll(".status-scrim").forEach(n => n.style.setProperty("--top", top));
    };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue);
    update();
  }

  // "Have Zzzap? Open in the app." The page can't tell whether the app is
  // installed (Apple keeps that private), so this is offered to every iPhone.
  // It points at zzzap-app.com, not this site: iOS only hands a link to the
  // app when it goes to a different site than the page you're on. Without
  // the app, zzzap-app.com shows its "get the app" page.
  function openInApp(page) {
    const wrap = el("div", "open-app");
    wrap.append(document.createTextNode("Have Zzzap? "));
    const a = el("a", null, "Open in the app");
    a.href = `https://zzzap-app.com/@${page.handle}`;
    wrap.append(a);
    return wrap;
  }

  // Pinned to the bottom while the live zzzap is off screen, so a visitor
  // knows there's something to vote on without scrolling. Tapping it
  // scrolls to the zzzap. Gone once they've voted or watched.
  function liveBar(page, card) {
    const bar = el("button", "live-bar hidden");
    bar.type = "button";
    const pill = el("span", "live-pill");
    pill.append(el("span", "dot"), document.createTextNode("LIVE"));
    bar.append(pill, el("span", "live-bar-q", page.live.question), el("span", "live-bar-go", "Vote"));
    bar.addEventListener("click", () => card.scrollIntoView({ behavior: "smooth", block: "center" }));
    if ("IntersectionObserver" in window) {
      const watcher = new IntersectionObserver(([entry]) => {
        if (card.classList.contains("results") || card.classList.contains("closed")) {
          bar.remove();
          watcher.disconnect();
          return;
        }
        // Only while no part of the card is on screen, so the two never
        // stack up (Safari draws the page under its own toolbar too).
        bar.classList.toggle("hidden", entry.isIntersecting);
      });
      watcher.observe(card);
    }
    return bar;
  }

  function links(page) {
    const wrap = el("div", "links");
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
    const section = el("div", "section live-section");

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
    const watching = api.myVote(page) === null && api.passed(page);
    if (!ended && api.myVote(page) === null && !watching) card.append(hint);

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
    // Shown when this browser had already voted: the first vote stands.
    const alreadyNote = el("p", "hint already hidden", "You already voted on this one from this browser, so your first answer counts.");
    card.append(alreadyNote);

    // Give up your vote to watch the live results (Stacy, 2026-10-24).
    // One choice per browser, same as voting: vote or watch, not both.
    const watch = el("div", "watch");
    const watchLink = el("button", "watch-link", "See results without voting");
    watchLink.type = "button";
    watch.append(watchLink);

    const get = getZzzap(page, ended);
    get.classList.add("hidden");
    card.append(get);
    section.append(card);

    function showResults(counts, mine, closedNow) {
      const pcts = percentages(counts.map(c => c || 0));
      // The app's colors (BACKLOG Design rules, Yellow): the leader is
      // green, a tie at the top is white with the word "Tied", the rest gray.
      const top = Math.max(0, ...counts.map(c => c || 0));
      const leaders = top > 0 ? counts.filter(c => (c || 0) === top).length : 0;
      card.classList.add("results");
      hint.remove();
      watch.remove();
      buttons.forEach((btn, i) => {
        const pct = pcts[i];
        btn.disabled = true;
        btn.querySelector(".pct").textContent = `${pct}%`;
        requestAnimationFrame(() => { btn.querySelector(".fill").style.width = `${pct}%`; });
        const leads = top > 0 && (counts[i] || 0) === top;
        btn.classList.toggle("lead", leads && leaders === 1);
        btn.classList.toggle("tied", leads && leaders > 1);
        // Yellow means one thing only: your answer.
        btn.classList.toggle("mine", i === mine);
      });
      // Name the answer: the yellow outline alone is easy to miss, and
      // reads like the green leader when they're the same row.
      const myAnswer = mine !== null ? live.options[mine] : undefined;
      you.textContent = mine !== null
        ? (myAnswer ? `✓ You voted ${myAnswer}` : "✓ You voted")
        : (api.passed(page) ? "Watching" : "");
      // Yellow is for your answer only; watching has none.
      you.classList.toggle("watching", mine === null);
      // Visitors see percentages, never counts; the creator sees counts in
      // the app (Stacy, 2026-10-18), so a new account never reads as empty.
      if (closedNow && !ended) {
        card.classList.add("closed");
        pill.lastChild.textContent = "ENDED";
        ends.textContent = "Voting closed";
      }
      const label = ended || closedNow ? "Final results" : "Live results";
      count.textContent = leaders > 1 ? `Tied · ${label}` : label;
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
    if (ended || already !== null || watching) {
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
      section.append(liveBar(page, card));
      // Get signed in as soon as there's something to vote on, so the tap
      // only waits for the vote itself.
      if (api === liveApi) prepareToVote().catch(() => {});
      // Voted before but this browser forgot: show the results, not buttons.
      api.checkVoted(page).then(r => {
        if (!r || stale() || card.classList.contains("results") || options.classList.contains("sending")) return;
        showResults(r.counts, r.mine, r.closed);
        alreadyNote.classList.remove("hidden");
      });
      card.insertBefore(watch, get);
      watchLink.addEventListener("click", () => {
        if (!api.canPass) {
          if (!watch.querySelector(".watch-note")) watch.append(el("p", "watch-note", "Coming soon."));
          return;
        }
        confirmWatch();
      });

      function confirmWatch() {
        watch.replaceChildren();
        const box = el("div", "watch-confirm");
        box.append(el("p", null, "You won't be able to vote on this one."));
        const actions = el("div", "watch-actions");
        const cancel = el("button", "watch-cancel", "Cancel");
        cancel.type = "button";
        const go = el("button", "watch-go", "See Results");
        go.type = "button";
        actions.append(cancel, go);
        box.append(actions);
        watch.append(box);

        cancel.addEventListener("click", () => watch.replaceChildren(watchLink));
        go.addEventListener("click", async () => {
          cancel.disabled = go.disabled = true;
          buttons.forEach(b => (b.disabled = true));
          error.classList.add("hidden");
          count.textContent = "Loading results";
          try {
            const r = await api.pass(page);
            showResults(r.counts, r.mine, r.closed);
          } catch {
            count.textContent = "";
            buttons.forEach(b => (b.disabled = false));
            watch.replaceChildren(watchLink);
            error.textContent = "Couldn't load the results. Try again.";
            error.classList.remove("hidden");
          }
        });
      }

      buttons.forEach((btn, i) => btn.addEventListener("click", async () => {
        buttons.forEach(b => (b.disabled = true));
        watch.classList.add("hidden");
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
          if (result.already) alreadyNote.classList.remove("hidden");
        } catch (err) {
          options.classList.remove("sending");
          btn.classList.remove("picked");
          btn.querySelector(".pct").textContent = "";
          watch.classList.remove("hidden");
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
    txt.append(el("div", "t1", ended ? "You missed this one" : "Don't miss the next one"));
    box.append(txt);
    if (isIPhone() || !/Android/.test(navigator.userAgent)) {
      txt.append(el("div", "t2", "With the free Zzzap app you can:"));
      // Only what the app really does for someone following a Surge account.
      // On Surge, comments go to the account owner only (voice.json).
      const perks = el("ul", "perks");
      // A short bold lead and a dim detail, so it scans instead of reading
      // like a paragraph (Stacy, 11/5).
      for (const [lead, detail] of [
        ["Know first", `Get notified the moment ${who} asks something new`],
        ["Vote in one tap", "Right from the notification"],
        ["Say more", `Send ${who} a comment with your vote`],
      ]) {
        const li = el("li");
        li.append(el("div", "lead", lead), el("div", "detail", detail));
        perks.append(li);
      }
      txt.append(perks);
      const btn = el("a", "get-btn", "Get Zzzap");
      btn.href = APP_STORE;
      box.append(btn);
    } else {
      // No Android app yet (deferred until web voting shows the demand).
      txt.append(el("div", "t2", "Zzzap is on iPhone for now."));
    }
    return box;
  }

  function pastSection(page) {
    const section = el("div", "section");
    section.append(el("div", "section-head", "Past zzzaps"));
    const list = el("div", "archive");
    // Final totals only. Never who voted (2026-09-10).
    for (const item of page.past) list.append(pastCard(page, item));
    section.append(list);
    return section;
  }

  function pastCard(page, item) {
    const card = el("div", "past");
    card.append(el("div", "q", item.question));
    // The winner line (or "Tied"), shown while the card is closed.
    const summary = el("div", "summary");
    const w = el("div", "winner");
    if (item.tie) {
      // The server sends tie: true with no winner when answers share the
      // top count. White "Tied", the app's rule; no percent or bar, since
      // there's no single answer to measure.
      w.append(el("span", "wname tied", "Tied"));
      summary.append(w);
    } else {
      w.append(el("span", item.winner ? "wname" : "wname none", item.winner || "No votes"), el("span", "wpct", `${item.winnerPct || 0}%`));
      const bar = el("div", "bar");
      const fill = el("i");
      fill.style.width = `${Math.max(0, Math.min(100, item.winnerPct))}%`;
      bar.append(fill);
      summary.append(w, bar);
    }
    card.append(summary);

    // Every answer, once the server sends them (zzzaps that end after
    // Zak adds `options` + `counts`; older ones only have the winner).
    // Tap the card to open it. Percentages only, like the live card.
    const options = Array.isArray(item.options) ? item.options : null;
    const counts = Array.isArray(item.counts) ? item.counts.map(c => Number(c) || 0) : null;
    const canOpen = options && counts && options.length > 1 && options.length === counts.length;
    let all = null;
    if (canOpen) {
      all = el("div", "answers hidden");
      const pcts = percentages(counts);
      const top = Math.max(0, ...counts);
      const leaders = top > 0 ? counts.filter(c => c === top).length : 0;
      options.forEach((text, i) => {
        const row = el("div", "answer");
        if (top > 0 && counts[i] === top) row.classList.add(leaders > 1 ? "tied" : "lead");
        const line = el("div", "aline");
        line.append(el("span", "aname", String(text)), el("span", "apct", `${pcts[i]}%`));
        const bar = el("div", "bar");
        const fill = el("i");
        fill.style.width = `${pcts[i]}%`;
        bar.append(fill);
        row.append(line, bar);
        all.append(row);
      });
      card.append(all);
    }

    // The creator's comment after it ended. Public on Surge: the app
    // says so under the comment box.
    const comment = typeof item.creatorComment === "string" ? item.creatorComment.trim() : "";
    if (comment) {
      const said = el("p", "said");
      said.append(el("span", "who", firstName(page) || "Creator"), document.createTextNode(` ${comment}`));
      card.append(said);
    }

    const sub = el("div", "sub");
    const left = el("span", null, "Final results");
    sub.append(left, el("span", null, `Ended ${formatDate(item.endedAt)}`));
    card.append(sub);

    if (canOpen) {
      const toggle = el("button", "all-link", "See all answers");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", "false");
      left.replaceWith(toggle);
      card.classList.add("opens");
      // One handler on the card: a tap anywhere opens it, and the
      // button's own click bubbles here, so it never toggles twice.
      card.addEventListener("click", () => {
        const open = all.classList.contains("hidden");
        all.classList.toggle("hidden", !open);
        summary.classList.toggle("hidden", open);
        toggle.textContent = open ? "Hide answers" : "See all answers";
        toggle.setAttribute("aria-expanded", String(open));
      });
    }
    return card;
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

  const handle = window.SURGE_DEMO ? window.SURGE_DEMO.handle : handleFromAddress();
  if (!handle) { renderNotFound(); return; }
  // A page left open picks up a new zzzap, or one that just ended, by
  // re-reading the page every 30 seconds while it's in front. It only
  // redraws when the live zzzap or the past list changed, so a vote in
  // progress is never wiped.
  // A comment added after it ended changes a past entry, not the count.
  const pageKey = page => JSON.stringify([page.live && page.live.pollId, (page.past || []).map(p => p.creatorComment || "")]);
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
