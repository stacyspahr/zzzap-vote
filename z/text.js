// Text a zzzap web page: vote.zzzap-app.com/z/<token>
// (backend/TEXT-A-ZZZAP-SPEC.md in the app repo).
//
// Someone not on Zzzap got a zzzap by text. GitHub Pages has no server, so
// /z/<token> falls through to /404.html, which loads this file instead of
// surge.js. It reuses surge.css for the look.
//
// Zak's two functions, both callable by an anonymous browser:
//   peekTextZzzap({ token })                          -> what to show
//   castTextVote({ token, spotToken?, optionIndex })  -> { counts, mine }
// The browser signs in anonymously first, so the server knows it's the same
// voter on every visit (one vote per spot).
// Totals only, never who picked what. No comments.
// Add ?sample (or ?sample=group, open, solo, slow, voted, closed, closed0, closed1, closedmany, closedtie, pulled, notfound,
// error) to see each state without the server.

(function () {
  "use strict";

  const APP_STORE = "https://apps.apple.com/app/id6761918562";
  const SDK = "https://www.gstatic.com/firebasejs/10.13.2";
  // Same web app as surge.js and the admin site.
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBaTfoiq1UN0GtRgf1k6BO3tY7vcm1g0Eg",
    authDomain: "spahrzap.firebaseapp.com",
    projectId: "spahrzap",
    storageBucket: "spahrzap.firebasestorage.app",
    messagingSenderId: "838021448718",
    appId: "1:838021448718:web:fcb8b87db61d8b7786685f",
  };

  // ---------- Small helpers (text only, never HTML from data) ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function isIPhone() { return /iPhone|iPod/.test(navigator.userAgent); }

  function tokenFromAddress() {
    const match = location.pathname.match(/^\/z\/([A-Za-z0-9_-]{8,64})\/?$/);
    return match ? match[1] : null;
  }

  // endsAt may come as an ISO string, milliseconds, seconds, or a Firestore
  // timestamp ({ seconds } / { _seconds }). Returns milliseconds or null.
  function toMillis(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
    if (typeof value === "string") { const t = Date.parse(value); return isNaN(t) ? null : t; }
    const s = value.seconds !== undefined ? value.seconds : value._seconds;
    return typeof s === "number" ? s * 1000 : null;
  }

  // The app's time line (PollDetailView detailRemainingText): "2d 3h left",
  // "4h 59m left", "5h left", then "59:59 left" in the last hour.
  function timeLeft(endsAtMs) {
    if (!endsAtMs) return "";
    const total = Math.floor((endsAtMs - Date.now()) / 1000);
    if (total <= 0) return null;
    if (total >= 86400) return `${Math.floor(total / 86400)}d ${Math.floor((total % 86400) / 3600)}h left`;
    if (total >= 3600) {
      const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
      return m > 0 ? `${h}h ${m}m left` : `${h}h left`;
    }
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")} left`;
  }

  // The app's "Ended today at 3:45 PM" / "yesterday at" / "Friday at"
  // (naturalPastDate). Before the end time it ended early, like the app says.
  function endedText(endsAtMs) {
    if (!endsAtMs || endsAtMs > Date.now()) return "Ended early";
    const d = new Date(endsAtMs);
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const days = Math.round((today - day) / 86400000);
    if (days === 0) return `Ended today at ${time}`;
    if (days === 1) return `Ended yesterday at ${time}`;
    return `Ended ${d.toLocaleDateString("en-US", { weekday: "long" })} at ${time}`;
  }

  // The app's roundedPercentages (Models.swift): largest remainder, but the
  // same count always gets the same number, so 1-1-1 is 33/33/33.
  function percentages(counts) {
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) return counts.map(() => 0);
    const pcts = counts.map(c => Math.floor(c * 100 / total));
    let left = 100 - pcts.reduce((a, b) => a + b, 0);
    const groups = new Map();
    counts.forEach((c, i) => { if (!groups.has(c)) groups.set(c, []); groups.get(c).push(i); });
    const order = [...groups.entries()].sort(([a], [b]) => {
      const ra = a * 100 % total, rb = b * 100 % total;
      return ra !== rb ? rb - ra : b - a;
    });
    for (const [count, idx] of order) {
      if (left <= 0) break;
      if (count * 100 % total === 0 || idx.length > left) break;
      idx.forEach(i => { pcts[i] += 1; });
      left -= idx.length;
    }
    return pcts;
  }

  // The app's resultLabelText: "2 votes", and the percent from 5 votes up.
  function resultLabel(count, total, pct) {
    const words = `${count} ${count === 1 ? "vote" : "votes"}`;
    return total >= 5 ? `${words} · ${pct}%` : words;
  }

  function cleanPhoto(url) {
    try {
      return typeof url === "string" && new URL(url).protocol === "https:" ? url : null;
    } catch { return null; }
  }

  // Answers may come as plain strings or as { text, photoURL }.
  function cleanOption(option) {
    if (typeof option === "string") return { text: option, photo: null };
    if (!option || typeof option !== "object") return { text: "", photo: null };
    return {
      text: String(option.text || option.label || ""),
      photo: cleanPhoto(option.photoURL || option.photoUrl || option.imageURL || option.photo),
    };
  }

  function cleanCounts(counts, n) {
    if (!Array.isArray(counts)) return null;
    return Array.from({ length: n }, (_, i) => Number(counts[i]) || 0);
  }

  // What this browser remembers per link: the name it picked on a group
  // link and its answer, so a reload shows its pick.
  // Samples remember only while the page is open, so voting on one never
  // marks the others as voted (they all share the testtest link).
  const isSample = new URLSearchParams(location.search).has("sample");
  let sampleMemory = {};
  function saved(token) {
    if (isSample) return sampleMemory;
    try { return JSON.parse(localStorage.getItem(`zzzap.z.${token}`)) || {}; } catch { return {}; }
  }
  function save(token, data) {
    if (isSample) { sampleMemory = { ...sampleMemory, ...data }; return; }
    try { localStorage.setItem(`zzzap.z.${token}`, JSON.stringify({ ...saved(token), ...data })); } catch { /* private mode */ }
  }
  function forget(token) {
    if (isSample) { sampleMemory = {}; return; }
    try { localStorage.removeItem(`zzzap.z.${token}`); } catch { /* private mode */ }
  }


  // ---------- Data ----------

  let fns = null;
  function loadFunctions() {
    if (!fns) {
      fns = Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-auth.js`),
        import(`${SDK}/firebase-functions.js`),
      ]).then(async ([appMod, authMod, fnMod]) => {
        const app = appMod.initializeApp(FIREBASE_CONFIG);
        // localStorage first: Instagram's browser loses IndexedDB (surge.js, 11/3).
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
          auth = authMod.getAuth(app);
        }
        await auth.authStateReady();
        if (!auth.currentUser) await authMod.signInAnonymously(auth);
        const functions = fnMod.getFunctions(app);
        return async (name, data) => {
          // 15 seconds, not the default 70: a stuck call shows Try Again sooner.
          const fn = fnMod.httpsCallable(functions, name, { timeout: 15000 });
          if (!auth.currentUser) await authMod.signInAnonymously(auth);
          try {
            return (await fn(data)).data;
          } catch (err) {
            if (!err || err.code !== "functions/unauthenticated") throw err;
            await authMod.signInAnonymously(auth);
            return (await fn(data)).data;
          }
        };
      });
      fns.catch(() => { fns = null; });
    }
    return fns;
  }

  // Wakes the vote function while the page loads, so the tap on an answer
  // doesn't wait on a cold start too (Stacy, 11/23). A vote with no token is
  // refused before any database work; the answer is ignored.
  let woke = false;
  function wakeVote(call) {
    if (woke) return;
    woke = true;
    call("castTextVote", {}).catch(() => {});
  }

  const liveApi = {
    async peek(token) {
      const call = await loadFunctions();
      wakeVote(call);
      return call("peekTextZzzap", { token });
    },
    async vote(token, spotToken, optionIndex) {
      const call = await loadFunctions();
      const data = spotToken ? { token, spotToken, optionIndex } : { token, optionIndex };
      return call("castTextVote", data);
    },
  };

  // Sample pages: the whole flow in this browser, no server.
  function sampleApi(kind) {
    // closed1: ended, one voter (you). closedmany: ended, 26 votes, you
    // picked the winner. closed: ended, 3 votes, you didn't vote.
    const many = kind === "closedmany" || kind === "closedtie";
    const counts = kind === "closed1" ? [1, 0] : kind === "closed0" ? [0, 0]
      : kind === "closedtie" ? [1, 1, 1] : many ? [14, 9, 3] : [2, 1];
    let mine = kind === "voted" || kind === "closed1" || many ? 0 : null;
    const usedSpot = "s2";
    const poll = () => ({
      question: "Blue one or green one for the party?",
      options: many ? ["Blue", "Green", "Red"] : ["Blue", "Green"],
      // Ended ones ended on time two hours ago ("Ended today at …"): only
      // everyone voting ends one early, so a sample that didn't vote can't.
      endsAt: new Date(Date.now() + (kind.startsWith("closed") ? -2 : 5) * 3600e3).toISOString(),
      openBallot: kind === "open",
      senderFirstName: "Stacy",
      senderPhotoURL: null,
      closed: kind.startsWith("closed"),
      onlyOne: kind === "solo",
    });
    return {
      async peek() {
        await new Promise(r => setTimeout(r, kind === "slow" ? 6000 : 300));
        if (kind === "error") throw new Error("sample");
        if (kind === "pulled") return { status: "pulled", poll: { senderFirstName: "Stacy" } };
        if (kind === "notfound") return { status: "notFound" };
        const shown = mine !== null || kind.startsWith("closed");
        if (kind === "group") {
          return {
            status: "ok", kind: "group", poll: poll(),
            spots: [{ spotToken: "s1", name: "Michelle" }, { spotToken: "s2", name: "Zak" }, { spotToken: "s3", name: "Aunt Sue" }],
            counts: shown ? counts.slice() : undefined,
          };
        }
        return {
          status: "ok", kind: "person", poll: poll(),
          me: { name: "Michelle", voted: mine !== null, option: mine === null ? undefined : mine },
          counts: shown ? counts.slice() : undefined,
        };
      },
      async vote(token, spotToken, optionIndex) {
        await new Promise(r => setTimeout(r, 500));
        if (spotToken === usedSpot) return { already: true };
        if (mine === null) { counts[optionIndex] += 1; mine = optionIndex; }
        return { counts: counts.slice(), mine };
      },
    };
  }

  const sampleKind = new URLSearchParams(location.search).get("sample");
  const api = sampleKind !== null ? sampleApi(sampleKind || "person") : liveApi;

  // ---------- Pieces ----------

  // Get Zzzap: copies this link first, so after installing, the app's
  // "Were you invited?" paste sheet picks the zzzap back up (copying only
  // works on a tap). Without the copy, it still goes.
  // Android: no app to offer, so no download parts at all (Stacy, 11/20).
  function isAndroid() { return !isIPhone() && /Android/.test(navigator.userAgent); }

  function getZzzap(token, { copy, caption }) {
    if (isAndroid()) return null;
    const wrap = el("div", "z-get");
    const btn = el("a", "get-btn", "Get Zzzap");
    btn.href = APP_STORE;
    if (copy) {
      btn.addEventListener("click", event => {
        if (!navigator.clipboard || !navigator.clipboard.writeText) return;
        event.preventDefault();
        const go = () => { location.href = APP_STORE; };
        navigator.clipboard.writeText(`https://vote.zzzap-app.com/z/${token}`).then(go, go);
      });
    }
    wrap.append(btn);
    if (caption) wrap.append(el("p", "z-caption", caption));
    // Points at zzzap-app.com, not this site: iOS only hands a link to the
    // app when it goes to a different site than the page you're on.
    if (copy && isIPhone()) {
      const open = el("div", "open-app");
      // Same words as the Surge page.
      open.append(document.createTextNode("Have Zzzap? "));
      const a = el("a", null, "Open in the app");
      a.href = `https://zzzap-app.com/z/${token}`;
      open.append(a);
      wrap.append(open);
    }
    return wrap;
  }

  // Under the results (or once it ended): just a title and Get Zzzap. The
  // why lives in the popup, so it isn't said twice (Stacy, 11/25).
  function pitch(token, first, closed) {
    if (isAndroid()) return null;
    const box = el("div", "get z-pitch");
    // render() falls back to "They" when the server sends no first name.
    const named = first && first !== "They";
    box.append(
      el("div", "t1", closed ? (named ? `${first} is on Zzzap` : "Get Zzzap") : "See how it ends"),
      getZzzap(token, { copy: true }),
    );
    return box;
  }

  // A small live zzzap, like the app's Lock Screen card: the bars trade
  // places so it reads as votes coming in. Shows asking instead of listing it.
  function liveSample() {
    const card = el("div", "z-sample");
    card.setAttribute("aria-hidden", "true");
    const top = el("div", "z-sample-top");
    top.append(el("span", "z-sample-live", "Live"), el("span", "z-sample-left", "12:48 left"));
    card.append(top, el("div", "z-sample-q", "Tacos or pizza tonight?"));
    for (const [answer, cls] of [["Tacos", "a"], ["Pizza", "b"]]) {
      const row = el("div", "z-sample-row");
      const track = el("div", "z-sample-track");
      track.append(el("div", `z-sample-fill ${cls}`));
      row.append(el("span", "z-sample-label", answer), track);
      card.append(row);
    }
    return card;
  }

  // Right after an iPhone vote, before the tally (Stacy, 11/25): a thank-you
  // over the blurred results that turns them into the one asking. See
  // Results always opens them. Once per zzzap: a refresh or a later visit
  // goes straight to the results.
  function welcome(token, first) {
    const overlay = el("div", "z-welcome");
    const card = el("div", "z-welcome-card get");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    // The sender's name on its own line; no name, just the question.
    const title = el("h2", "z-welcome-title");
    if (first && first !== "They") title.append(el("span", "z-welcome-asked", `${first} asked you.`));
    title.append(el("span", null, "What would you ask?"));
    title.id = "z-welcome-title";
    title.tabIndex = -1;
    card.setAttribute("aria-labelledby", title.id);
    const see = el("button", "z-welcome-see", "See Results");
    see.type = "button";
    const get = getZzzap(token, { copy: true, caption: "Free. Your vote comes with you." });
    card.append(
      el("div", "z-welcome-thanks", "Thanks for weighing in"),
      title,
      liveSample(),
      el("p", "z-welcome-line", "Your people vote from their Lock Screen, or by text like you just did. You watch it fill in live."),
      get, see);
    overlay.append(card);

    const close = () => {
      overlay.remove();
      document.body.classList.remove("z-locked-scroll");
      document.removeEventListener("keydown", onKey);
    };
    const onKey = event => { if (event.key === "Escape") close(); };
    see.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.classList.add("z-locked-scroll");
    document.body.append(overlay);
    title.focus({ preventScroll: true });
  }

  function sender(poll) {
    const box = el("div", "z-sender");
    const photo = cleanPhoto(poll.senderPhotoURL);
    const first = poll.senderFirstName || "";
    if (photo) {
      const img = el("img", "z-avatar");
      img.src = photo;
      img.alt = first;
      box.append(img);
    } else if (first) {
      box.append(el("div", "z-avatar z-initial", first.charAt(0).toUpperCase()));
    }
    if (first) box.append(el("div", "z-from", first));
    return box;
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
    // Someone texted a zzzap has no app to report it from (Stacy, 11/19).
    // Emails support with the link, so we can find the zzzap behind it.
    const report = el("a", null, "Report");
    report.href = "mailto:support@zzzap-app.com?subject=" + encodeURIComponent("Report a texted zzzap")
      + "&body=" + encodeURIComponent("What's wrong with it?\n\n\nLink: " + location.href);
    legal.append(privacy, document.createTextNode(" · "), terms, document.createTextNode(" · "), report);
    f.append(legal);
    return f;
  }

  // ---------- Render ----------

  const root = document.getElementById("page");
  document.body.dataset.header = "text";
  root.className = "phone header-minimal z-page";

  // Bumped on every drawing so timers from an older one stop themselves.
  let gen = 0;
  // Set while results are on screen, so a refresh moves the bars in place.
  let updateCounts = null;
  let shownKey = null;

  function show(...parts) {
    gen += 1;
    const sheet = el("div", "sheet");
    sheet.append(...parts.filter(Boolean), footer());
    root.replaceChildren(sheet);
    window.scrollTo(0, 0);
  }

  // While the zzzap loads (up to ~5 seconds on a cold start): the card's
  // outline with a soft shimmer, then "Almost there" after 3 seconds so it
  // never looks stuck (Stacy, 11/23).
  function renderLoading() {
    updateCounts = null;
    const card = el("div", "z-block z-skel");
    card.setAttribute("aria-label", "Loading");
    card.append(el("div", "bone q1"), el("div", "bone q2"), el("div", "bone t"));
    const rows = el("div", "z-block z-skel-rows");
    for (let i = 0; i < 3; i++) rows.append(el("div", "bone opt"));
    const head = el("div", "z-sender z-skel-head");
    head.append(el("div", "z-avatar bone"), el("div", "bone name"));
    const later = el("p", "z-later", "Almost there");
    show(head, card, rows, later);
    const mine = gen;
    setTimeout(() => { if (gen === mine) later.classList.add("on"); }, 3000);
  }

  // The animated Zzzap lockup (zzzap-app.com's lightning strike) on the
  // pages with no zzzap to show: pulled, gone, couldn't load (Stacy, 11/23).
  const BRAND = "/z/brand/";
  const BRAND_V = "?v=202611230800";
  let brandMarkup = null;
  function loadBrand() {
    if (!brandMarkup) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = BRAND + "logo-animation.css" + BRAND_V;
      document.head.appendChild(css);
      brandMarkup = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = BRAND + "logo-markup.js" + BRAND_V;
        s.onload = () => resolve(window.ZZZAP_LOGO_MARKUP);
        s.onerror = reject;
        document.body.appendChild(s);
      });
      brandMarkup.catch(() => { brandMarkup = null; });
    }
    return brandMarkup;
  }
  function brandLogo() {
    const spot = el("div", "z-brand");
    const mine = gen + 1; // show() is about to bump gen
    loadBrand().then(markup => {
      if (gen !== mine || !markup) return;
      spot.innerHTML = markup;
      // The strike script binds to #zzzap-logo when it runs, so run it fresh.
      const s = document.createElement("script");
      s.src = BRAND + "logo-animation.js" + BRAND_V;
      document.body.appendChild(s);
    }, () => {
      const img = el("img");
      img.src = "/zzzap-bolts.svg";
      img.alt = "Zzzap";
      spot.append(img);
    });
    return spot;
  }

  function renderMessage(title, token, withGet, retry) {
    updateCounts = null;
    document.title = "Zzzap";
    const box = el("div", "notfound z-message");
    box.append(brandLogo(), el("h1", null, title));
    if (retry) box.append(retry);
    const get = withGet ? getZzzap(token, { copy: false }) : null;
    if (get) box.append(get);
    show(box);
    // The lockup already says Zzzap and its tagline; the footer keeps just the legal line.
    const foot = root.querySelector("footer");
    if (foot) foot.classList.add("z-quiet");
  }

  function renderError(token) {
    const retry = el("button", "share-btn z-retry", "Try Again");
    retry.type = "button";
    retry.addEventListener("click", () => load(token));
    renderMessage("Couldn't load this zzzap", token, false, retry);
  }

  function render(token, data, note) {
    if (!data || data.status === "notFound" || (data.status !== "ok" && data.status !== "pulled")) {
      shownKey = "notFound";
      renderMessage("This zzzap isn't here anymore", token, true);
      return;
    }
    const poll = data.poll || {};
    const first = poll.senderFirstName || "They";
    if (data.status === "pulled") {
      shownKey = "pulled";
      renderMessage(`${first} took this one back`, token, true);
      return;
    }

    const options = (Array.isArray(poll.options) ? poll.options : []).map(cleanOption);
    const endsAt = toMillis(poll.endsAt);
    const closed = !!poll.closed || timeLeft(endsAt) === null;
    const group = data.kind === "group";
    const memory = saved(token);
    const counts = cleanCounts(data.counts, options.length);
    const me = data.me || {};
    let mine = typeof me.option === "number" ? me.option
      : (typeof memory.mine === "number" ? memory.mine : null);
    // Group link: the name this browser picked, if it's still on the list.
    const spots = group && Array.isArray(data.spots) ? data.spots.filter(s => s && s.spotToken && s.name) : [];
    let spot = group ? spots.find(s => s.spotToken === memory.spot) || null : null;
    const voted = group ? !!(spot && counts) : (!!me.voted || (mine !== null && !!counts));
    if (!voted && !closed) mine = null;

    // Only redraw when the screen would change; counts alone move in place.
    const key = JSON.stringify([closed, voted, group && !voted ? spots.map(s => s.spotToken) : null]);
    if (key === shownKey && updateCounts && counts && !note) {
      updateCounts(counts, mine, closed);
      return;
    }
    shownKey = key;
    updateCounts = null;

    document.title = `${first} wants your opinion · Zzzap`;
    // Laid out like the app's zzzap screen (Stacy, 11/23): the question
    // centered with its time line, then each part in its own block with a
    // small title. The big photo and name on top stay: from a text, who
    // sent it comes first.
    const summary = el("div", "z-block z-summary");
    summary.append(el("div", "z-question", poll.question || ""),
      el("div", "z-time", closed ? endedText(endsAt) : (timeLeft(endsAt) || "")));
    if (closed) summary.append(el("div", "z-chip", voted ? "You voted" : "You didn't vote"));

    const error = el("p", "error hidden", "");
    const parts = [sender(poll), summary];

    if (voted || closed) {
      parts.push(...results(options, counts, voted ? mine : null, closed));
      parts.push(pitch(token, first, closed));
      show(...parts);
      // iPhone only for now (Android gets it with its app); samples show it
      // anywhere so it can be checked on a computer.
      if (voted && !closed && !memory.welcomed && (isIPhone() || isSample)) {
        save(token, { welcomed: true });
        welcome(token, first);
      }
      if (!closed) { keepLive(token); watchEnd(token, endsAt, true); }
      return;
    }

    if (group && !spot) {
      parts.push(el("div", "z-head", "Which one are you?"), whichOne(token, data, spots, first, note));
      show(...parts);
      watchEnd(token, endsAt);
      return;
    }

    const block = el("div", "z-block z-rows");
    if (group && spot) {
      const as = el("div", "z-as");
      as.append(el("span", null, spot.name));
      const change = el("button", "z-change", "Change");
      change.type = "button";
      change.addEventListener("click", () => {
        save(token, { spot: null });
        shownKey = null;
        render(token, data);
      });
      as.append(change);
      parts.push(as);
    }
    // Who sees the pick, before voting, like the app (Stacy, 11/22): a tinted
    // box so it reads as a notice, orange when the sender will know, green
    // when it's private (the app's colors, 11/23). onlyOne comes from the
    // server; until it's there, say nothing rather than guess.
    if (poll.openBallot) parts.push(el("p", "z-note warn", `${first} will see what you pick`));
    else if (poll.onlyOne === true) parts.push(el("p", "z-note warn", `You're the only one, so ${first} will know what you pick`));
    else if (poll.onlyOne === false) parts.push(el("p", "z-note safe", `Your pick is yours alone. Not even ${first} sees it.`));

    // The app's vote: tap to pick (ring, then a yellow check), then Submit
    // Vote; tapping the pick again clears it.
    let picked = null;
    const buttons = options.map((opt, i) => {
      const btn = optionButton(opt);
      block.append(btn);
      btn.addEventListener("click", () => {
        picked = picked === i ? null : i;
        buttons.forEach((b, j) => b.classList.toggle("picked", j === picked));
        submitWrap.classList.toggle("on", picked !== null);
      });
      return btn;
    });
    const submitWrap = el("div", "z-submit-wrap");
    const submit = el("button", "z-submit", "Submit Vote");
    submit.type = "button";
    submit.addEventListener("click", () => { if (picked !== null) vote(picked); });
    submitWrap.append(submit, el("p", "z-takebacks", "Choose wisely. No take-backs!"), error);
    parts.push(el("div", "z-head", "Cast Your Vote"), block, submitWrap);
    show(...parts);
    watchEnd(token, endsAt);
    // Sign in now, so the tap only waits for the vote.
    if (api === liveApi) loadFunctions().catch(() => {});

    async function vote(i) {
      buttons.forEach(b => (b.disabled = true));
      submit.disabled = true;
      submit.classList.add("sending");
      submit.textContent = "Sending…";
      error.classList.add("hidden");
      try {
        const result = await api.vote(token, spot ? spot.spotToken : null, i);
        const already = result && (result.already === true || result.status === "already");
        if (already && group) {
          save(token, { spot: null });
          shownKey = null;
          render(token, data, "That name already voted.");
          return;
        }
        const theirs = typeof result.mine === "number" ? result.mine : (already ? null : i);
        save(token, { mine: theirs, spot: spot ? spot.spotToken : null });
        const fresh = cleanCounts(result.counts, options.length);
        if (fresh) {
          data = { ...data, counts: fresh, me: group ? undefined : { ...me, voted: true, option: theirs } };
          shownKey = null;
          render(token, data);
        } else {
          load(token, true);
        }
      } catch (err) {
        const code = err && err.code;
        if (code === "functions/already-exists" && group) {
          save(token, { spot: null });
          shownKey = null;
          render(token, data, "That name already voted.");
          return;
        }
        // Ended, pulled or gone since the page opened: show what's true now.
        if (code === "functions/failed-precondition" || code === "functions/not-found" || code === "functions/already-exists") {
          load(token, true);
          return;
        }
        submit.classList.remove("sending");
        submit.textContent = "Submit Vote";
        submit.disabled = false;
        buttons.forEach(b => (b.disabled = false));
        error.textContent = code === "functions/resource-exhausted"
          ? "Slow down a moment, then try again."
          : "Your vote didn't go through. Try again.";
        error.classList.remove("hidden");
      }
    }
  }

  function answerLabel(opt) {
    const label = el("span", "z-label");
    if (opt.photo) {
      const img = el("img", "z-thumb");
      img.src = opt.photo;
      img.alt = "";
      label.append(img);
    }
    label.append(el("span", "label", opt.text));
    return label;
  }

  // One answer row, like the app's: a ring, the answer.
  function optionButton(opt) {
    const btn = el("button", "z-row z-pick");
    btn.type = "button";
    btn.append(el("span", "z-ring"), answerLabel(opt));
    return btn;
  }

  // "Which one are you?": the names texted. Never marked Voted (ballot
  // rule, 11/14); a name that already voted says so after the tap.
  function whichOne(token, data, spots, first, note) {
    const box = el("div", "z-which");
    if (note) box.append(el("p", "error", note));
    const list = el("div", "z-block z-rows");
    spots.forEach(s => {
      const btn = el("button", "z-row z-name");
      btn.type = "button";
      btn.append(el("span", "label", s.name));
      btn.addEventListener("click", () => {
        save(token, { spot: s.spotToken });
        shownKey = null;
        render(token, data);
      });
      list.append(btn);
    });
    box.append(list, el("p", "z-caption z-notlisted", `Not on the list? Ask ${first} to add you.`));
    return box;
  }

  // The app's results (PollDetailView): "Live Results" / "Results", each
  // answer with "N votes" (percent from 5 up), a bar under it measured
  // against the leader, green for the leader, white for a tie at the top,
  // red for the rest; your answer bold with a yellow "You". Returns the
  // title and block; updateCounts moves them in place.
  function results(options, counts, mine, closed) {
    const head = el("div", "z-head", closed ? "Results" : "Live Results");
    const block = el("div", "z-block z-results");
    const rows = options.map((opt, i) => {
      const row = el("div", "z-res");
      const top = el("div", "z-res-top");
      const label = answerLabel(opt);
      if (i === mine) label.append(el("span", "z-you", "You"));
      const num = el("span", "z-num", "");
      top.append(label, num);
      const track = el("div", "z-track");
      const fill = el("div", "z-fill");
      track.append(fill);
      row.append(top, track);
      block.append(row);
      return { row, num, fill };
    });
    const empty = el("p", "z-empty hidden", "");
    const locked = el("p", "z-locked", closed ? "" : "Your vote is locked in");
    block.append(empty);
    if (!closed && mine !== null) block.append(locked);

    function update(fresh, myPick, isClosed) {
      const c = fresh || options.map(() => 0);
      const total = c.reduce((a, b) => a + b, 0);
      const pcts = percentages(c);
      const top = Math.max(0, ...c);
      const leaders = top > 0 ? c.filter(n => n === top).length : 0;
      const none = !fresh || (isClosed && total === 0);
      rows.forEach(({ row, num, fill }, i) => {
        row.classList.toggle("hidden", none);
        num.textContent = fresh ? resultLabel(c[i], total, pcts[i]) : "";
        const leads = top > 0 && c[i] === top;
        fill.className = "z-fill " + (leads ? (leaders > 1 ? "tie" : "lead") : "rest");
        // Next frame so the bar grows from empty; the timer is a backstop
        // for when a frame never comes (it skipped sometimes, 11/23).
        const width = () => { fill.style.width = `${top > 0 ? (c[i] / top) * 100 : 0}%`; };
        requestAnimationFrame(width);
        setTimeout(width, 150);
        // Bold: your answer; if you didn't vote, the leader once it ended.
        row.classList.toggle("bold", myPick !== null ? i === myPick : (isClosed && leads));
      });
      empty.classList.toggle("hidden", !none);
      empty.textContent = !fresh ? "Final results are on the way" : "No one voted on this zzzap.";
    }
    update(counts, mine, closed);
    updateCounts = update;
    return [head, block];
  }

  // After voting, keep the totals moving while the page is in front.
  function keepLive(token) {
    const mine = gen;
    const timer = setInterval(() => {
      if (mine !== gen) { clearInterval(timer); return; }
      if (!document.hidden) load(token, true);
    }, 10000);
  }

  // The time line ticks every second, like the app; once it ends, reload
  // so nobody votes on a closed zzzap (after voting, keepLive's refresh
  // picks up the end, so only the line updates).
  function watchEnd(token, endsAt, voted) {
    if (!endsAt) return;
    const mine = gen;
    const timer = setInterval(() => {
      if (mine !== gen) { clearInterval(timer); return; }
      const left = timeLeft(endsAt);
      const line = root.querySelector(".z-time");
      if (left && line) { line.textContent = left; return; }
      clearInterval(timer);
      if (!voted) load(token, true);
    }, 1000);
  }

  let loading = false;
  async function load(token, quiet) {
    if (loading) return;
    loading = true;
    if (!quiet) { shownKey = null; renderLoading(); }
    try {
      render(token, await api.peek(token));
    } catch (err) {
      // A refresh that misses keeps what's on screen.
      if (!quiet || !updateCounts) renderError(token);
    } finally {
      loading = false;
    }
  }

  // ---------- Start ----------

  const token = tokenFromAddress();
  if (!token) {
    shownKey = "notFound";
    renderMessage("This zzzap isn't here anymore", null, true);
    return;
  }
  load(token);
})();
