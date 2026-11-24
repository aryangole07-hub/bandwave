// Button test: clicks every button / switch / chip / card control / browse row / tray item / key in a sandboxed run
// and checks each one did what it says. Run (bash):  BW_TEST="$TEMP/bw-test" BW_SET={\"mode\":\"window\"} npx electron .   (prints PASS/FAIL lines, exit code 1 on any failure)
const fs = require("fs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function run(t) {
  const results = [];
  const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`); };
  const js = (w, code) => w.webContents.executeJavaScript(code, true);
  const loaded = (w) => new Promise((r) => (w.webContents.isLoading() ? w.webContents.once("did-finish-load", r) : r()));
  const fresh = () => t.told.splice(0);

  try {
    await loaded(t.viz); await wait(800);

    // ---- now-playing card buttons
    for (const [id, cmd] of [["prev", "prev"], ["pp", "play_pause"], ["next", "next"]]) {
      fresh(); await js(t.viz, `document.getElementById("${id}").click()`); await wait(80);
      check(`card button #${id}`, t.told.includes(cmd), JSON.stringify(t.told));
    }
    // ---- keys on the visualizer
    for (const [key, cmd] of [[" ", "play_pause"], ["ArrowRight", "next"], ["ArrowLeft", "prev"]]) {
      fresh(); await js(t.viz, `dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)} }))`); await wait(80);
      check(`key "${key}"`, t.told.includes(cmd), JSON.stringify(t.told));
    }

    // ---- settings window
    t.openSettings(); await loaded(t.settingsWin); await wait(900);
    const segs = await js(t.settingsWin, `[...document.querySelectorAll(".seg")].map((s) => [s.id.slice(2), [...s.children].map((b) => b.dataset.v)])`);
    for (const [key, vals] of segs) {
      const before = t.S[key];
      for (const v of vals) {
        await js(t.settingsWin, `document.querySelector('#f_${key} [data-v="${v}"]').click()`); await wait(60);
        const on = await js(t.settingsWin, `document.querySelector('#f_${key} [data-v="${v}"]').classList.contains("on")`);
        check(`seg ${key} = ${v}`, String(t.S[key]) === v && on, `S=${t.S[key]} on=${on}`);
      }
      await js(t.settingsWin, `document.querySelector('#f_${key} [data-v="${before}"]').click()`); await wait(60);
    }
    const toggles = await js(t.settingsWin, `[...document.querySelectorAll(".switch input")].map((i) => i.id.slice(2))`);
    for (const key of toggles) {
      const before = !!t.S[key];
      await js(t.settingsWin, `(() => { const i = document.querySelector('#f_${key}'); i.click(); })()`); await wait(60);
      const box = await js(t.settingsWin, `document.querySelector('#f_${key}').checked`);
      check(`switch ${key}`, !!t.S[key] === !before && box === !before, `S=${t.S[key]} box=${box}`);
      await js(t.settingsWin, `document.querySelector('#f_${key}').click()`); await wait(60);
    }
    // profiles: save, chip load, delete (×), presets
    await js(t.settingsWin, `document.getElementById("pname").value = "zz button test"; document.getElementById("psave").click()`); await wait(300);
    check("Save profile", "zz button test" in t.readProfiles(), JSON.stringify(Object.keys(t.readProfiles())));
    await js(t.settingsWin, `document.querySelector('[data-v="star"]').click()`); await wait(60);
    await js(t.settingsWin, `[...document.querySelectorAll(".chip.mine")].find((c) => c.textContent.startsWith("zz button test")).click()`); await wait(120);
    check("profile chip loads", t.S.shape !== "star", `shape=${t.S.shape}`);
    await js(t.settingsWin, `[...document.querySelectorAll(".chip.mine")].find((c) => c.textContent.startsWith("zz button test")).querySelector(".x").click()`); await wait(300);
    const gone = await js(t.settingsWin, `![...document.querySelectorAll(".chip")].some((c) => c.textContent.startsWith("zz button test"))`);
    check("profile × deletes", !("zz button test" in t.readProfiles()) && gone, `left=${JSON.stringify(Object.keys(t.readProfiles()))}`);
    const presets = await js(t.settingsWin, `[...document.querySelectorAll(".chip:not(.mine)")].map((c) => c.firstChild.textContent)`);
    for (const p of presets) {
      t.S.style = "__x";
      await js(t.settingsWin, `[...document.querySelectorAll(".chip:not(.mine)")].find((c) => c.firstChild.textContent === ${JSON.stringify(p)}).click()`); await wait(80);
      check(`preset chip ${p}`, t.S.style !== "__x", `style=${t.S.style}`);
    }
    // header buttons
    await js(t.settingsWin, `document.getElementById("fs").click()`); await wait(150);
    check("Full screen button", t.fullscreen === true, `fullscreen=${t.fullscreen}`);
    await js(t.viz, `dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`); await wait(150);
    check(`key "Escape" leaves full screen`, t.fullscreen === false, `fullscreen=${t.fullscreen}`);
    await js(t.settingsWin, `document.querySelector('[data-v="spiral"]').click()`); await wait(60);
    await js(t.settingsWin, `document.getElementById("reset").click()`); await wait(150);
    check("Reset button", t.S.shape === t.DEFAULTS.shape && t.S.bands === t.DEFAULTS.bands, `shape=${t.S.shape}`);

    // ---- every button has the same press animation as others of its kind
    const anim = async (w, sel) => js(w, `[...document.querySelectorAll(${JSON.stringify(sel)})].map((b) => { const c = getComputedStyle(b); return c.transitionDuration + "|" + c.transitionTimingFunction + (/both|forwards/.test(c.animationFillMode) ? "|HOLDS TRANSFORM" : ""); })`);
    const kinds = [
      ["text buttons (settings)", t.settingsWin, "header button, #psave, .seg button, .chip"],
      ["icon buttons (settings ×)", t.settingsWin, ".chip .x"],
      ["icon buttons (card)", t.viz, "#card button"],
    ];
    await js(t.settingsWin, `document.getElementById("pname").value = "zz anim"; document.getElementById("psave").click()`); await wait(300);  // a × to measure
    const sig = {};
    for (const [name, w, sel] of kinds) { const s = [...new Set(await anim(w, sel))]; sig[name] = s; check(`one animation for ${name}`, s.length === 1, s.join("  /  ")); }
    await js(t.settingsWin, `[...document.querySelectorAll(".chip.mine")].find((c) => c.textContent.startsWith("zz anim")).querySelector(".x").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }))`); await wait(300);
    check("profile × works from the keyboard", !("zz anim" in t.readProfiles()), "still saved");
    check("card and × icon buttons animate alike", sig["icon buttons (card)"][0] === sig["icon buttons (settings ×)"][0], JSON.stringify(sig));

    // ---- browse panel: a row click plays it
    t.toggleBrowse(); await wait(200); await loaded(t.browseWin); await wait(600);
    fresh();
    t.browseWin.webContents.send("browse", { type: "browse", kind: "library", items: [{ label: "Song A", sub: "Artist", play: "Play Song A by Artist", section: "Your library" }, { label: "Song B", play: "Play Song B by X" }] });
    await wait(200);
    await js(t.browseWin, `document.querySelectorAll(".item")[1].click()`); await wait(100);
    check("browse row click plays", t.told.some((l) => l === "browse_play Play Song B by X"), JSON.stringify(t.told));
    const rows = [...new Set(await anim(t.browseWin, ".item"))];
    check("one animation for browse rows", rows.length === 1, rows.join(" / "));
    await js(t.browseWin, `dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`); await wait(150);
    check(`browse Esc closes`, !t.browseWin.isVisible(), "still visible");
    await js(t.viz, `dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }))`); await wait(300);
    check(`key "Tab" opens browse`, t.browseWin.isVisible(), "hidden"); t.browseWin.hide();

    // ---- tray menu
    const item = (label) => t.tray.menu().items.find((i) => i.label.startsWith(label));
    t.settingsWin.close(); await wait(200);
    item("Settings").click(); await wait(300);
    check("tray Settings", t.settingsWin && !t.settingsWin.isDestroyed() && t.settingsWin.isVisible(), "not open");
    item("Full screen").click(); await wait(150); const fsOn = t.fullscreen;
    item("Full screen").click(); await wait(150);
    check("tray Full screen (on, off)", fsOn === true && t.fullscreen === false, `${fsOn} ${t.fullscreen}`);
    const th = t.S.theme; item("Album mode").click(); await wait(80); const th1 = t.S.theme; item("Album mode").click(); await wait(80);
    check("tray Album mode (on, off)", th1 === "album" && t.S.theme === th, `${th} -> ${th1} -> ${t.S.theme}`);
    for (const [label, mode] of [["In a window", "window"], ["Always on top", "ontop"], ["On the wallpaper", "wallpaper"], ["In a window", "window"]]) {
      item(label).click(); await wait(150); check(`tray ${label}`, t.S.mode === mode, `mode=${t.S.mode}`);
    }
    await js(t.viz, "dispatchEvent(new KeyboardEvent('keydown', { key: '`' }))"); await wait(300);
    check("key ` shows settings", t.settingsWin.isVisible() && t.settingsWin.isAlwaysOnTop(), "not on top");
  } catch (e) { check("test run", false, e.stack); }

  const bad = results.filter((r) => !r).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  fs.writeFileSync(require("path").join(t.app.getPath("userData"), "result.txt"), `${results.length - bad}/${results.length}`);
  t.app.isQuitting = true; t.app.exit(bad ? 1 : 0);
};
