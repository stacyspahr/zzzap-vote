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
// Add ?sample (or ?sample=group, open, voted, closed, pulled, notfound,
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

  function timeLeft(endsAtMs) {
    if (!endsAtMs) return "";
    const ms = endsAtMs - Date.now();
    if (ms <= 0) return null;
    const mins = Math.floor(ms / 60000);
    const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
    if (d > 0) return `Ends in ${d}d ${h}h`;
    if (h > 0) return `Ends in ${h}h ${m}m`;
    return `Ends in ${Math.max(m, 1)}m`;
  }

  // Whole percentages that always add up to 100 (largest remainder), same as surge.js.
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
  function saved(token) {
    try { return JSON.parse(localStorage.getItem(`zzzap.z.${token}`)) || {}; } catch { return {}; }
  }
  function save(token, data) {
    try { localStorage.setItem(`zzzap.z.${token}`, JSON.stringify({ ...saved(token), ...data })); } catch { /* private mode */ }
  }
  function forget(token) {
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

  const liveApi = {
    async peek(token) {
      const call = await loadFunctions();
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
    const counts = [2, 1];
    let mine = kind === "voted" ? 0 : null;
    const usedSpot = "s2";
    const poll = () => ({
      question: "Blue one or green one for the party?",
      options: ["Blue", "Green"],
      endsAt: new Date(Date.now() + 5 * 3600e3).toISOString(),
      openBallot: kind === "open",
      senderFirstName: "Stacy",
      senderPhotoURL: null,
      closed: kind === "closed",
    });
    return {
      async peek() {
        await new Promise(r => setTimeout(r, 300));
        if (kind === "error") throw new Error("sample");
        if (kind === "pulled") return { status: "pulled", poll: { senderFirstName: "Stacy" } };
        if (kind === "notfound") return { status: "notFound" };
        const shown = mine !== null || kind === "closed";
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
  function getZzzap(token, { copy, caption }) {
    const wrap = el("div", "z-get");
    if (!isIPhone() && /Android/.test(navigator.userAgent)) {
      wrap.append(el("p", "z-caption", "Zzzap is on iPhone for now."));
      return wrap;
    }
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
      open.append(document.createTextNode("On Zzzap? "));
      const a = el("a", null, "Open it in the app");
      a.href = `https://zzzap-app.com/z/${token}`;
      open.append(a);
      wrap.append(open);
    }
    return wrap;
  }

  // After voting (or once it ended): why get the app, then Get Zzzap
  // (Stacy, 11/20). Short lines, no icons; every line is live in the app.
  function pitch(token, first, closed) {
    if (!isIPhone() && /Android/.test(navigator.userAgent)) return getZzzap(token, { copy: true });
    const box = el("div", "z-pitch");
    box.append(el("h2", "z-pitch-title", closed ? `${first} is on Zzzap` : "See how it ends"));
    const list = el("ul", "z-pitch-list");
    // Ended: they may not have voted, so no "your vote" line.
    [
      ...(closed ? [] : ["Your vote comes with you"]),
      "Vote right from your Lock Screen",
      "Watch the votes fill in live",
      "Ask your own people anything",
    ].forEach(line => list.append(el("li", null, line)));
    box.append(list, getZzzap(token, { copy: true, caption: "Free on iPhone" }));
    return box;
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
    sheet.append(...parts, footer());
    root.replaceChildren(sheet);
    window.scrollTo(0, 0);
  }

  function renderLoading() {
    updateCounts = null;
    show(el("div", "z-loading", "Loading"));
  }

  function renderMessage(title, token, withGet) {
    updateCounts = null;
    document.title = "Zzzap";
    const box = el("div", "notfound z-message");
    box.append(el("h1", null, title));
    if (withGet) box.append(getZzzap(token, { copy: false }));
    show(box);
  }

  function renderError(token) {
    updateCounts = null;
    document.title = "Zzzap";
    const box = el("div", "notfound z-message");
    box.append(el("h1", null, "Couldn't load this zzzap. Try again in a minute."));
    const retry = el("button", "share-btn z-retry", "Try Again");
    retry.type = "button";
    retry.addEventListener("click", () => load(token));
    box.append(retry);
    show(box);
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
    const card = el("div", "card live-card z-card" + (closed ? " closed" : ""));
    const row = el("div", "live-row");
    const pill = el("span", "live-pill");
    pill.append(el("span", "dot"), document.createTextNode(closed ? "ENDED" : "LIVE"));
    const ends = el("span", "ends", closed ? "" : (timeLeft(endsAt) || ""));
    row.append(pill, ends);
    card.append(row, el("div", "question", poll.question || ""));

    const error = el("p", "error hidden", "");
    const parts = [sender(poll), card];

    if (voted || closed) {
      card.append(results(options, counts, mine, closed));
      parts.push(pitch(token, first, closed));
      show(...parts);
      if (!closed) keepLive(token);
      return;
    }

    if (group && !spot) {
      card.append(whichOne(token, data, spots, first, note));
      show(...parts);
      watchEnd(token, endsAt);
      return;
    }

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
      card.append(as);
    }
    if (poll.openBallot) card.append(el("p", "hint z-open", `${first} will see what you pick`));

    const list = el("div", "options");
    const buttons = options.map((opt, i) => {
      const btn = optionButton(opt);
      list.append(btn);
      btn.addEventListener("click", () => vote(i));
      return btn;
    });
    card.append(list, error);
    show(...parts);
    watchEnd(token, endsAt);
    // Sign in now, so the tap only waits for the vote.
    if (api === liveApi) loadFunctions().catch(() => {});

    async function vote(i) {
      buttons.forEach(b => (b.disabled = true));
      error.classList.add("hidden");
      list.classList.add("sending");
      buttons[i].classList.add("picked");
      buttons[i].querySelector(".pct").textContent = "Sending…";
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
        list.classList.remove("sending");
        buttons[i].classList.remove("picked");
        buttons[i].querySelector(".pct").textContent = "";
        buttons.forEach(b => (b.disabled = false));
        error.textContent = code === "functions/resource-exhausted"
          ? "Slow down a moment, then try again."
          : "Your vote didn't go through. Try again.";
        error.classList.remove("hidden");
      }
    }
  }

  function optionButton(opt) {
    const btn = el("button", "option");
    btn.type = "button";
    const fill = el("span", "fill");
    const r = el("span", "row");
    const label = el("span", "z-label");
    if (opt.photo) {
      const img = el("img", "z-thumb");
      img.src = opt.photo;
      img.alt = "";
      label.append(img);
    }
    label.append(el("span", "label", opt.text));
    r.append(label, el("span", "pct", ""));
    btn.append(fill, r);
    return btn;
  }

  // "Which one are you?": the names texted. Never marked Voted (ballot
  // rule, 11/14); a name that already voted says so after the tap.
  function whichOne(token, data, spots, first, note) {
    const box = el("div", "z-which");
    box.append(el("div", "z-which-title", "Which one are you?"));
    if (note) box.append(el("p", "error", note));
    const list = el("div", "options");
    spots.forEach(s => {
      const btn = el("button", "option z-name");
      btn.type = "button";
      const r = el("span", "row");
      r.append(el("span", "label", s.name));
      btn.append(r);
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

  function results(options, counts, mine, closed) {
    const wrap = el("div", "results");
    const list = el("div", "options");
    const buttons = options.map(opt => {
      const btn = optionButton(opt);
      btn.disabled = true;
      list.append(btn);
      return btn;
    });
    const meta = el("div", "meta");
    const you = el("span", "you", "");
    const label = el("span", null, "");
    meta.append(you, label);
    wrap.append(list, meta);

    function update(fresh, myPick, isClosed) {
      const c = fresh || options.map(() => 0);
      const pcts = percentages(c);
      // The app's colors: the leader green, a tie at the top white, the
      // rest gray; yellow is only your answer.
      const top = Math.max(0, ...c);
      const leaders = top > 0 ? c.filter(n => n === top).length : 0;
      buttons.forEach((btn, i) => {
        btn.querySelector(".pct").textContent = fresh ? `${pcts[i]}%` : "";
        requestAnimationFrame(() => { btn.querySelector(".fill").style.width = `${fresh ? pcts[i] : 0}%`; });
        const leads = top > 0 && c[i] === top;
        btn.classList.toggle("lead", leads && leaders === 1);
        btn.classList.toggle("tied", leads && leaders > 1);
        btn.classList.toggle("mine", i === myPick);
      });
      const picked = myPick !== null && options[myPick] ? options[myPick].text : null;
      you.textContent = picked ? `You picked ${picked}` : "";
      if (!fresh) { label.textContent = isClosed ? "Final results are on the way" : ""; return; }
      const total = c.reduce((a, b) => a + b, 0);
      const word = isClosed ? "Final results" : "Live results";
      label.textContent = `${leaders > 1 ? "Tied · " : ""}${total} ${total === 1 ? "vote" : "votes"} · ${word}`;
    }
    update(counts, mine, closed);
    updateCounts = update;
    return wrap;
  }

  // After voting, keep the totals moving while the page is in front.
  function keepLive(token) {
    const mine = gen;
    const timer = setInterval(() => {
      if (mine !== gen) { clearInterval(timer); return; }
      if (!document.hidden) load(token, true);
    }, 10000);
  }

  // Before voting, reload once it ends, so nobody taps a closed zzzap.
  function watchEnd(token, endsAt) {
    if (!endsAt) return;
    const mine = gen;
    const timer = setInterval(() => {
      if (mine !== gen) { clearInterval(timer); return; }
      const left = timeLeft(endsAt);
      const ends = root.querySelector(".ends");
      if (left && ends) { ends.textContent = left; return; }
      clearInterval(timer);
      load(token, true);
    }, 30000);
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
